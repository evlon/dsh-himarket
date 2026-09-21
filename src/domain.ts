/**
 * 内网服务域名的集中配置（可切换部署环境）。
 *
 * 背景：公司内网原有 `*.ict.cmcc` 域名（如 ai-market.ict.cmcc），新部署的 K8S
 * 环境改用 `*.ai.ict.cmcc`（如 market.ai.ict.cmcc）。**两套环境并存**，故这里
 * 不写死任何一个：默认指向新环境，但允许经环境变量整体切回旧环境或指向其他环境。
 *
 * 两套环境的命名规律不同，因此用「环境档位」而非单纯换后缀：
 *   新环境：`<服务>.ai.ict.cmcc`（market / job / roster / conf）
 *   旧环境：`ai-<服务>.ict.cmcc`（ai-market / ai-job / ai-roster / ai-conf）
 *
 * ⚠️ 注意 `job` 与 `gateway` 的区别（两者**不是**同一服务）：
 *   - `job`     → 岗位发布台（dsh-himarket-gateway:3091），旧环境 `ai-job.ict.cmcc`
 *   - `gateway` → Higress 网关控制台（节点 :8001），旧环境 `ai-gateway.ict.cmcc`
 *   本插件需要的是**岗位发布台**，故用 `job`；`gateway` 仅作注释参考。
 *
 * 覆盖优先级（低 → 高）：
 *   1. 默认档位 `new`（新 K8S 环境）
 *   2. `DSH_DEPLOY_ENV=legacy` 整体切回旧环境
 *   3. `DSH_DOMAIN_SUFFIX` 只换后缀（用于指向其他按新规律命名的新式环境）
 *   4. 各服务的整条 URL 环境变量（见 {@link defaultBaseUrl} / {@link defaultJobUrl}）
 *   5. `cordis.patch.yml` 行 config
 *   6. 设置页「HiMarket」卡片（settings.yaml 的 himarket namespace，最高）
 *
 * @module dsh-himarket/domain
 */

/** 新环境域名后缀（默认）。 */
export const DEFAULT_DOMAIN_SUFFIX = 'ai.ict.cmcc'

/** 旧环境域名后缀。 */
export const LEGACY_DOMAIN_SUFFIX = 'ict.cmcc'

/**
 * 新环境各服务主机名。
 *
 * `job` = 岗位发布台（dsh-himarket-gateway）。
 * 注意：新环境的 `gateway.ai.ict.cmcc` 是 Higress 控制台，**不是**岗位发布台。
 */
const NEW_HOSTS = {
  market: 'market.ai.ict.cmcc',
  job: 'job.ai.ict.cmcc',
} as const

/** 旧环境各服务主机名（前缀带 `ai-`；旧环境岗位发布台是 ai-job）。 */
const LEGACY_HOSTS = {
  market: 'ai-market.ict.cmcc',
  job: 'ai-job.ict.cmcc',
} as const

/** 本插件用到的服务名。 */
export type ServiceName = keyof typeof NEW_HOSTS

/** 读环境变量（空串视为未设置）。 */
function env(name: string): string {
  const v = process.env[name]
  return v !== undefined && v.trim() !== '' ? v.trim() : ''
}

/**
 * 是否使用旧环境域名档位。
 * `DSH_DEPLOY_ENV=legacy` 即可整体切回旧环境（旧域名前缀带 `ai-`，不是简单换后缀）。
 */
export function isLegacyEnv(): boolean {
  return env('DSH_DEPLOY_ENV').toLowerCase() === 'legacy'
}

/**
 * 某服务的主机名（不含协议）。
 * `DSH_DOMAIN_SUFFIX` 可只换后缀（指向其他按新规律命名的新式环境）。
 */
export function hostOf(service: ServiceName): string {
  const suffix = env('DSH_DOMAIN_SUFFIX').replace(/^\.+/u, '')
  if (suffix !== '') return `${service}.${suffix}`
  return (isLegacyEnv() ? LEGACY_HOSTS : NEW_HOSTS)[service]
}

/**
 * 拼一个服务地址：优先整条 URL 环境变量，否则按当前环境档位拼。
 * @param service 服务名（`market` / `job`）
 * @param envName 整条 URL 覆盖用的环境变量名
 */
export function serviceUrl(service: ServiceName, envName: string): string {
  const override = env(envName)
  if (override !== '') return override.replace(/\/+$/u, '')
  return `http://${hostOf(service)}`
}

/** 默认 HiMarket 门户地址：新 `http://market.ai.ict.cmcc` / 旧 `http://ai-market.ict.cmcc`。 */
export function defaultBaseUrl(): string {
  return serviceUrl('market', 'DSH_HIMARKET_BASE_URL')
}

/**
 * 默认岗位发布台地址：新 `http://job.ai.ict.cmcc` / 旧 `http://ai-job.ict.cmcc`。
 *
 * 兼容别名：`DSH_HIMARKET_GATEWAY_URL` 仍可用（历史命名），
 * 但推荐用语义更准确的 `DSH_HIMARKET_JOB_URL`。
 */
export function defaultJobUrl(): string {
  const jobOverride = env('DSH_HIMARKET_JOB_URL')
  if (jobOverride !== '') return jobOverride.replace(/\/+$/u, '')
  return serviceUrl('job', 'DSH_HIMARKET_GATEWAY_URL')
}

/**
 * 默认 Keycloak issuer（一键登录用）。
 *
 * 与 launcher `activation.rs` 的 `ActivationConfig::default()` 及
 * `env_defaults.rs` 的 `matrix-activation.keycloakIssuer` 保持**同一个值**：
 * 两边登录的是同一个 realm、同一个 client，值不一致会导致换票失败。
 *
 * 为什么插件内置默认（而不是等 launcher 下发）：设计文档 D3 —— 为了让
 * 「只升插件」即可用（G5）。`himarket.ssoIssuer` 仍可覆盖，供运维统一改。
 */
export const DEFAULT_SSO_ISSUER = 'https://auth.ict.cmcc/realms/employees'

/**
 * 默认 Keycloak client id（一键登录用）。
 *
 * `matrix-twin-activation` 是 **public client** 且启用 PKCE(S256)，
 * 其 `redirectUris` 已注册 `127.0.0.1:45813|45814|45815/callback`
 * —— 这是插件能独立完成登录的**唯一依据**（见设计文档 §3.3）。
 */
export const DEFAULT_SSO_CLIENT_ID = 'matrix-twin-activation'

/** 解析生效的 SSO issuer：settings 显式值 > 环境变量 > 内置默认。 */
export function resolveSsoIssuer(configured: string): string {
  const fromSettings = configured.trim()
  if (fromSettings !== '') return fromSettings.replace(/\/+$/u, '')
  return DEFAULT_SSO_ISSUER
}

/** 解析生效的 SSO client id：settings 显式值 > 环境变量 > 内置默认。 */
export function resolveSsoClientId(configured: string): string {
  const fromSettings = configured.trim()
  if (fromSettings !== '') return fromSettings
  return DEFAULT_SSO_CLIENT_ID
}

/**
 * 调试开关：是否允许手工账密登录（默认**关闭**，账密框只读）。
 *
 * 语义：环境变量与 settings 键**取或**（设计文档 D4）。
 * 环境变量优先是为了「研发临时调试不改 settings.yaml」：
 *   DSH_HIMARKET_ALLOW_PASSWORD=1
 * settings 键 `himarket.allowPasswordLogin: true` 供运维统一下发。
 */
export function allowPasswordLogin(configured: boolean): boolean {
  const fromEnv = env('DSH_HIMARKET_ALLOW_PASSWORD').toLowerCase()
  if (fromEnv === '1' || fromEnv === 'true' || fromEnv === 'yes' || fromEnv === 'on') return true
  return configured
}

/**
 * 「环境地址类」配置键 —— 由服务端统一下发，本地不可改。
 *
 * ⚠️ 依据（代码级事实，非推测）：launcher `env_defaults.rs` 的
 * `FORCE_OVERRIDE_KEYS` 明确包含这两个键：
 *
 * ```rust
 * ("himarket", "baseUrl"),
 * ("himarket", "gatewayUrl"),
 * ```
 *
 * 语义为「服务端有值就**强制覆盖**本地」（同文件 `:213-215` 注释）。也就是说
 * 用户在设置页改这两个地址，**下次同步必被覆盖回去** —— 故 UI 与 host 都不该
 * 允许普通用户改（见设计文档 §13）。
 */
export const ADDRESS_KEYS = ['baseUrl', 'gatewayUrl'] as const

/** 地址键名联合类型。 */
export type AddressKey = (typeof ADDRESS_KEYS)[number]

/** `splitAddressPatch` 的返回形状。 */
export interface SplitPatchResult<T> {
  /** 可安全写入的字段（非地址键，或调试态下的全部字段）。 */
  allowed: Partial<T>
  /** 被拒绝的地址键（调试开关关闭时才有值）。 */
  rejected: AddressKey[]
}

/**
 * 拆分 save-config 的 patch：把「环境地址类键」与其余字段分开。
 *
 * 为什么需要（设计文档 §13.3）：只把浏览器端输入框设成只读**挡不住**同机
 * 任意进程直接 POST `/himarket/save-config`。host 侧必须同样设防，否则守卫
 * 形同虚设。
 *
 * 语义：调试开关**关闭**时地址键被拒（返回在 `rejected`）；开启时全部放行。
 * 抽成纯函数以便单测（不依赖 cordis / HTTP 运行时）。
 *
 * @param patch      待写入的字段（来自 HTTP body）
 * @param allowDebug 调试开关是否开启（见 {@link allowPasswordLogin}）
 */
export function splitAddressPatch<T extends Record<string, unknown>>(
  patch: Partial<T>,
  allowDebug: boolean,
): SplitPatchResult<T> {
  if (allowDebug) return { allowed: patch, rejected: [] }
  const allowed: Partial<T> = {}
  const rejected: AddressKey[] = []
  for (const key of Object.keys(patch) as Array<keyof T & string>) {
    if ((ADDRESS_KEYS as readonly string[]).includes(key)) {
      rejected.push(key as AddressKey)
      continue
    }
    allowed[key] = patch[key]
  }
  return { allowed, rejected }
}

