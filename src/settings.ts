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
  /**
   * HiMarket backend base URL, no trailing slash.
   * 默认值由 domain.ts 按部署环境档位给出：新 K8S 环境 http://market.ai.ict.cmcc，
   * 旧环境 http://ai-market.ict.cmcc（DSH_DEPLOY_ENV=legacy 或显式配置切换）。
   */
  baseUrl: string
  /** Developer account username. */
  username: string
  /** Developer account password (plaintext, local settings.yaml only). */
  password: string
  /** Cached developer JWT; re-login happens on 401. */
  token: string
  /** Cached admin JWT（发布用，/admins/login）；发布才会用到。 */
  adminToken: string
  /** 管理员账号用户名（默认 admin）；与开发者账号区分，发布才用。 */
  adminUsername: string
  /** 管理员账号密码（仅运行时输入用，不持久化明文；发布时用于 /admins/login 缓存 token）。 */
  adminPassword: string
  /** 发布岗位包时发布到的门户 ID（可选，缺省不发布到门户）。 */
  portalId: string
  /** 包装层（dsh-himarket-gateway）地址；填了则发布走网关、同步带「企业发布/员工共建」来源标签。 */
  gatewayUrl: string
  /** Skill install root; empty falls back to ~/.dsh/skills. */
  skillInstallDir: string
  /**
   * Keycloak issuer（一键登录用）；空则回退 domain.ts 的 DEFAULT_SSO_ISSUER。
   * 供运维统一改 realm 用，普通用户无需关心。
   */
  ssoIssuer: string
  /**
   * Keycloak client id（一键登录用）；空则回退 domain.ts 的 DEFAULT_SSO_CLIENT_ID。
   */
  ssoClientId: string
  /**
   * 调试开关：是否允许手工账密登录（默认 false → 账密框只读，只能一键登录）。
   * 与环境变量 DSH_HIMARKET_ALLOW_PASSWORD 取或（见 domain.ts 的 allowPasswordLogin）。
   */
  allowPasswordLogin: boolean
}

/** Settings namespace name. */
export const NAMESPACE = 'himarket'

/**
 * 是否具备可用凭据：两种模式（可并存）
 *   ① SSO 模式：有 token（启动器「一键登录」写入，7 天有效）—— 无需用户名/密码；
 *   ② 账密模式：username + password 齐全（兜底，或 SSO 不可用时手工填）。
 * baseUrl 为空、或两种模式都没有 → false。
 *
 * 抽成纯函数：便于单测，且被 buildClient / ensureReady / snapshot 三处共用，
 * 避免「配置判定」逻辑分散导致行为不一致。
 */
export function hasCredentials(s: {
  baseUrl: string
  username: string
  password: string
  token: string
}): boolean {
  if (s.baseUrl.trim() === '') return false
  return s.token.trim() !== '' || (s.username.trim() !== '' && s.password.trim() !== '')
}

/**
 * 凭据指纹：baseUrl + token + username + password 拼接。
 *
 * 为什么需要：HimarketClient 在构造时**快照** token，且插件把它缓存为单例。
 * 启动器「一键登录」是**外部进程**写 settings.yaml（settings 服务热加载），
 * 若不比对指纹，插件会一直用旧 token（过期后表现为持续 401）。
 */
export function credentialsFingerprint(s: {
  baseUrl: string
  token: string
  username: string
  password: string
}): string {
  return [s.baseUrl, s.token, s.username, s.password].join('\u0000')
}

/** 设置页展示的登录态（设计文档 §5.1 状态机）。 */
export type LoginState =
  /** 无任何凭据，需一键登录。 */
  | 'NOT_LOGGED'
  /** 有 token（launcher 或插件写入）→ 已登录。 */
  | 'LOGGED_IN'
  /** 有账密但无 token，且账密兜底被禁用 → 需重新登录。 */
  | 'EXPIRED'

/**
 * 计算展示用登录态（纯函数，便于单测）。
 *
 * 判定顺序：
 *   ① 有 token               → LOGGED_IN（无论账密是否存在）
 *   ② 无 token 但有账密       → 账密兜底开启时视为可用；否则 EXPIRED（引导一键登录）
 *   ③ 都没有                 → NOT_LOGGED
 *
 * 为什么 ② 要区分开关：调试开关关闭时账密只是「过渡兜底」，UI 不该显示成已登录
 * （否则用户以为登录了却因 token 缺失而 401）。
 */
export function loginStateOf(
  s: { token: string; username: string; password: string },
  passwordFallbackEnabled: boolean,
): LoginState {
  if (s.token.trim() !== '') return 'LOGGED_IN'
  const hasPassword = s.username.trim() !== '' && s.password.trim() !== ''
  if (hasPassword) return passwordFallbackEnabled ? 'LOGGED_IN' : 'EXPIRED'
  return 'NOT_LOGGED'
}

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
  boolean(): { default(value: boolean): unknown }
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
        adminToken: Schema.string().default(''),
        adminUsername: Schema.string().default('admin'),
        adminPassword: Schema.string().default(''),
        portalId: Schema.string().default(''),
        gatewayUrl: Schema.string().default(''),
        skillInstallDir: Schema.string().default(''),
        // 一键登录（SSO）参数：空则回退 domain.ts 内置默认。
        ssoIssuer: Schema.string().default(''),
        ssoClientId: Schema.string().default(''),
        // 调试开关：默认 false（账密框只读，只能一键登录）。
        allowPasswordLogin: Schema.boolean().default(false),
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
