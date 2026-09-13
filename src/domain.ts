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
