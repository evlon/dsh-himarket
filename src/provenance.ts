/**
 * 配置来源判定：某个地址值到底是「服务端下发」还是「本地/内置兜底」。
 *
 * ## 为什么需要（2026-09-21 UE 反馈）
 *
 * 设计文档 §13 把 HiMarket 地址 / 包装层地址设为只读，UI 上写了一句
 * 「环境地址由服务端统一下发」。但这句话**可能是不准确的**：
 *
 * - launcher 的 `env_defaults.rs` 只是**兜底**（服务端未配时才用代码内置值）；
 * - 服务端 `envDefaults` 里若没有这两个键，settings.yaml 里的值其实来自
 *   **插件自己的内置默认**（`domain.ts` 的 `defaultBaseUrl()`），
 *   与「服务端下发」无关；
 * - 两者甚至**不一样**：内置默认是 `http://market.ai.ict.cmcc`，
 *   而服务端下发的是 `https://market.ai.ict.cmcc`（实测 3090）。
 *
 * 用户看到只读框里有个值，被告知「服务端下发的」，但**无从验证**，
 * 于是产生「为什么不让填」的困惑（用户原话）。本模块就是为了让 UI 能
 * **如实说明每个值的来源**，而不是笼统断言。
 *
 * ## 判定依据（可验证的事实，非推测）
 *
 * launcher 每次同步会把服务端**实际下发的** `envDefaults` 缓存到
 * `<DSH_HOME>/sync-state.json` 的 `cached_config.envDefaults`（实测字段）：
 *
 * ```json
 * { "last_sync_at": "2026-09-21T03:43:00Z",
 *   "cached_config": { "envDefaults": { "himarket": { "baseUrl": "https://..." } } } }
 * ```
 *
 * 而 launcher 启动 dsh 时传的 `DSH_HOME` 与它自己的 home 是同一个目录
 * （`config.rs:473-497`，默认 `~/.dsh-launcher`），且 `settings.yaml` 也在该目录下
 * —— 故插件**无需 launcher 配合**即可读到「服务端到底下发了什么」。
 *
 * ⚠️ 该文件可能不存在（如开发实例 `~/.dsh-matrix-dev` 不由 launcher 启动）。
 * 此时判定为 `UNKNOWN`（来源无法判定），**不猜测**。
 *
 * @module dsh-himarket/provenance
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 某个配置值的来源。 */
export type ConfigOrigin =
  /** 服务端下发了该值，且当前生效值与之相同 —— 名副其实的「服务端下发」。 */
  | 'SERVER'
  /** 服务端下发了值，但本地生效值与之不同（尚未被同步覆盖）。 */
  | 'SERVER_DRIFT'
  /** 服务端未下发；当前用的是插件内置默认值。 */
  | 'BUILTIN_DEFAULT'
  /** 服务端未下发；本地自行配置了非默认值。 */
  | 'LOCAL'
  /** 当前值为空（未配置）。 */
  | 'UNSET'
  /** 读不到启动器的同步记录（非 launcher 启动的实例），来源无法判定。 */
  | 'UNKNOWN'

/** 单个字段的来源信息（给 UI 展示）。 */
export interface FieldProvenance {
  /** 来源分类。 */
  origin: ConfigOrigin
  /** 服务端下发的原始值；服务端未下发则为空串。 */
  serverValue: string
  /** 当前生效值。 */
  effectiveValue: string
  /** 最近一次同步时间（ISO 字符串）；未知则为空串。 */
  lastSyncAt: string
}

/** 从 launcher 同步状态里读到的服务端下发记录。 */
export interface ServerEnvDefaults {
  /** 是否成功读到并解析了 sync-state.json。 */
  available: boolean
  /** 下发值表：`"<namespace>.<key>"` → 值（空串不下发，故不会出现）。 */
  values: Record<string, string>
  /** 最近同步时间（ISO）。 */
  lastSyncAt: string
  /** 诊断说明（读失败原因），供设置页排障展示。 */
  note: string
}

/** 取错误信息文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 解析 dsh 的 harness home：`DSH_HOME` 优先，否则 `~/.dsh`。
 *
 * 与 `preset.ts` / `publish.ts` / `skill.ts` 的既有约定一致。
 */
export function harnessHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/**
 * 读取 launcher 缓存的服务端下发值（`<home>/sync-state.json`）。
 *
 * 永不抛异常 —— 读不到就返回 `available: false`，UI 据此显示「来源未知」。
 * 这样即便在非 launcher 环境（开发实例）也不会影响设置页渲染。
 *
 * @param home harness home 目录（见 {@link harnessHome}）
 */
export function readServerEnvDefaults(home: string): ServerEnvDefaults {
  const file = join(home, 'sync-state.json')
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return {
      available: false,
      values: {},
      lastSyncAt: '',
      note: `未读到启动器同步记录（${file}）：${messageOf(error)}`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      available: false,
      values: {},
      lastSyncAt: '',
      note: `同步记录不是合法 JSON：${messageOf(error)}`,
    }
  }

  const root = (parsed ?? {}) as Record<string, unknown>
  const cached = (root.cached_config ?? {}) as Record<string, unknown>
  const envDefaults = (cached.envDefaults ?? {}) as Record<string, unknown>

  const values: Record<string, string> = {}
  if (envDefaults !== null && typeof envDefaults === 'object') {
    for (const [ns, kv] of Object.entries(envDefaults)) {
      if (kv === null || typeof kv !== 'object') continue
      for (const [key, value] of Object.entries(kv as Record<string, unknown>)) {
        // 与 launcher 的写入语义对齐：空串视为「不下发」（env_defaults.rs:261）
        if (typeof value === 'string') {
          if (value.trim() !== '') values[`${ns}.${key}`] = value.trim()
          continue
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
          values[`${ns}.${key}`] = String(value)
        }
      }
    }
  }

  const lastSyncAt = typeof root.last_sync_at === 'string' ? root.last_sync_at : ''
  return { available: true, values, lastSyncAt, note: '' }
}

/**
 * 判定单个字段的来源。
 *
 * 判定顺序（先看服务端有没有下发，再看本地值长什么样）：
 *   1. 服务端下发了值 → 生效值相同 = `SERVER`；不同 = `SERVER_DRIFT`
 *   2. 服务端没下发：
 *      - 生效值为空 → `UNSET`
 *      - 生效值等于插件内置默认 → `BUILTIN_DEFAULT`
 *      - 有同步记录但值既非默认也非空 → `LOCAL`（本地自行配置）
 *      - 无同步记录 → `UNKNOWN`（无法判定，不猜）
 *
 * @param server          服务端下发记录（见 {@link readServerEnvDefaults}）
 * @param namespace       settings namespace，如 `himarket`
 * @param key             settings 键名，如 `baseUrl`
 * @param effective       当前生效值
 * @param builtinDefault  插件内置默认值（空串表示无内置默认）
 */
export function classifyField(
  server: ServerEnvDefaults,
  namespace: string,
  key: string,
  effective: string,
  builtinDefault: string,
): FieldProvenance {
  const serverValue = server.values[`${namespace}.${key}`] ?? ''
  const eff = effective.trim()
  const base = { serverValue, effectiveValue: eff, lastSyncAt: server.lastSyncAt }

  if (serverValue !== '') {
    return { ...base, origin: eff === serverValue ? 'SERVER' : 'SERVER_DRIFT' }
  }
  if (eff === '') return { ...base, origin: 'UNSET' }
  if (builtinDefault.trim() !== '' && eff === builtinDefault.trim()) {
    return { ...base, origin: 'BUILTIN_DEFAULT' }
  }
  return { ...base, origin: server.available ? 'LOCAL' : 'UNKNOWN' }
}
