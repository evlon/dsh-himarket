/**
 * HiMarket bridge config & credential persistence, mounted on the DSH settings
 * service (settings.yaml, hot-reloaded). The bridge publishes no service; it
 * only consumes settings, and credentials are a runtime choice that users change
 * after deployment — so they ride the same namespace mechanism as the Web Models
 * page and survive restart.
 *
 * The schemastery schema is loaded SYNCHRONOUSLY via requireOfficial (CJS),
 * because settings.register() needs the schema object at attach time. This keeps
 * the bridge free of any static @deepseek-ai/* import (see resolver.ts).
 *
 * @module dsh-himarket/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import { requireOfficial } from './resolver.js'

/** Bridge config & credential shape (resolved settings namespace value). */
export interface HimarketSettings {
  /** HiMarket backend base URL, e.g. http://ai-market.ict.cmcc (no trailing slash). */
  baseUrl: string
  /** Developer account username. */
  username: string
  /** Developer account password (plaintext, local settings.yaml only). */
  password: string
  /** Cached JWT; re-login happens on 401. */
  token: string
  /** Skill install root; empty falls back to ~/.dsh/skills. */
  skillInstallDir: string
}

/** Settings namespace name. */
export const NAMESPACE = 'himarket'

/** Narrow settings service interface (only the members this bridge uses). */
interface SettingsLike {
  register<T>(ns: string, schema: unknown, options?: { base?: unknown }): {
    get(): T
    watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
    update(patch: object): Promise<void>
    replace(section: object): Promise<void>
  }
}

/** schemastery narrow interface (runtime facts only). */
interface SchemasteryLike {
  object(fields: Record<string, unknown>): unknown
  string(): { default(value: string): unknown }
}

/**
 * Register the settings namespace and return a read/write handle; falls back to
 * read-only row config when the settings service is unavailable.
 */
export function attachSettings(
  ctx: Context,
  fallback: HimarketSettings,
  baseUrl: string,
): {
  current(): HimarketSettings
  save(patch: Partial<HimarketSettings>): Promise<void>
  onChange(cb: () => void): () => void
} {
  let resolved: () => HimarketSettings = () => fallback
  let save: (patch: Partial<HimarketSettings>) => Promise<void> = async () => {}
  let onChange: (cb: () => void) => () => void = () => () => {}

  // settings 服务是异步 init 的，apply 时可能尚未就绪；用 ctx.inject 等它就绪。
  ctx.inject(['settings'], (scope) => {
    const settings = scope.get('settings') as SettingsLike | undefined
    if (settings === undefined) {
      ctx.logger.warn('[dsh-himarket] settings service unavailable, using cordis.patch.yml row config')
      return
    }
    try {
      const Schema = requireOfficial('@deepseek-ai/schemastery', baseUrl) as SchemasteryLike
      const schema = Schema.object({
        baseUrl: Schema.string().default(''),
        username: Schema.string().default(''),
        password: Schema.string().default(''),
        token: Schema.string().default(''),
        skillInstallDir: Schema.string().default(''),
      })
      const scopeHandle = settings.register<HimarketSettings>(NAMESPACE, schema, { base: fallback })
      resolved = () => scopeHandle.get()
      save = async (patch) => {
        await scopeHandle.update(patch)
      }
      onChange = (cb) => scopeHandle.watch(() => { cb() })
    } catch (error) {
      ctx.logger.warn('[dsh-himarket] settings registration failed, falling back to row config: %s', messageOf(error))
    }
  })

  return {
    current: () => resolved(),
    save: (patch) => save(patch),
    onChange: (cb) => onChange(cb),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
