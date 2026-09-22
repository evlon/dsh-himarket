/**
 * dsh-himarket 宿主端：HiMarket 桥接的编排器。
 *
 * 职责：
 *  - 注册 settings 命名空间持久化凭证；
 *  - 注册环回 HTTP 路由 /himarket/* 供设置页卡片调用（state/save-config/sync/install-skill）；
 *  - 注册对话式工具 himarket_sync / himarket_install_skill；
 *  - 用 McpManager 把已订阅 MCP 映射为官方 dsh-mcp-client 动态 fiber；
 *  - 用 installSkill 把 Skill ZIP 落盘到 ~/.dsh/skills/。
 *
 * 归属：host 平面、不发布服务（只消费 webServer/tools/settings），行 loose、无 isolate realm。
 *
 * @module dsh-himarket
 */

import type { Context } from '@deepseek-ai/cordis'
import { HimarketClient } from './himarket-client.js'
import type { PublishedSkill, SubscribedMcp } from './himarket-client.js'
import { McpManager } from './mcp.js'
import { attachSettings, hasCredentials, credentialsFingerprint, loginStateOf } from './settings.js'
import type { HimarketSettings, LoginState } from './settings.js'
import { installSkill, defaultSkillRoot } from './skill.js'
import { packageLocalJob } from './publish.js'
import type { PublishPackageResult } from './publish.js'
import { registerHimarketTools } from './tools.js'
import {
  defaultBaseUrl,
  defaultJobUrl,
  allowPasswordLogin,
  splitAddressPatch,
  resolveSsoIssuer,
  resolveSsoClientId,
} from './domain.js'
import { SsoLoginManager, ensureInternalCaTrusted } from './sso-login.js'
import type { SsoConfig } from './sso-login.js'
import { harnessHome, readServerEnvDefaults, classifyField } from './provenance.js'
import type { FieldProvenance } from './provenance.js'

export const name = 'himarket'

/** cordis.patch.yml 行 config（默认值，settings 覆盖）。 */
export interface Config {
  skillInstallDir: string
  /** HiMarket 门户地址；缺省用 domain.ts 的环境档位默认值（新环境 market.ai.ict.cmcc）。 */
  baseUrl?: string
  /** 岗位网关地址；缺省用 domain.ts 的环境档位默认值（新环境 gateway.ai.ict.cmcc）。 */
  gatewayUrl?: string
}

/** 桥接运行时状态快照（给 HTTP /state 与同步摘要用）。 */
interface BridgeState {
  configured: boolean
  loggedIn: boolean
  baseUrl: string
  username: string
  portalId: string
  gatewayUrl: string
  mcpServers: SubscribedMcp[]
  activeMcpNames: string[]
  publishedSkills: PublishedSkill[]
  installedSkills: string[]
  lastError: string
  /**
   * 上次「启动/热加载恢复」的完成时刻（ISO 8601；空串=从未尝试）。
   *
   * 为什么需要：mcpServers=[] 与 activeMcpNames=[] 有两种截然不同的成因 ——
   * 「恢复根本没执行」（bug）与「恢复执行了但确实没订阅」（正常）。只看数组长度
   * 无法区分，会把 bug 误判为正常。此字段让二者可分辨（2026-09-22 修复的回归特征）。
   */
  lastRestoreAt: string
  /** 设置页登录态（设计文档 §5.1 状态机）。 */
  loginState: LoginState
  /** 展示用登录用户名（token 里的 preferred_username，或手工账密）。 */
  loginUsername: string
  /** 调试开关是否开启（决定设置页账密框可编辑性）。 */
  allowPasswordLogin: boolean
  /**
   * 环境地址的**来源**（服务端下发 / 内置默认 / 本地 / 未知）。
   *
   * 为什么需要（2026-09-21 UE 反馈）：只读框必须能如实说明「这个值是谁给的」，
   * 否则用户会疑惑「为什么不让填」。见 provenance.ts。
   */
  addressProvenance: {
    baseUrl: FieldProvenance
    gatewayUrl: FieldProvenance
  }
}

export function apply(ctx: Context, config: Config): void {
  // 内网自签 CA 加固：在插件入口注入一次，覆盖本插件**所有** fetch 调用点
  // （sso-login / himarket-client / 本文件的网关调用）。不依赖
  // NODE_USE_SYSTEM_CA 环境变量 —— 进程环境不可靠，详见 sso-login.ts。
  ensureInternalCaTrusted()

  const baseUrl = ctx.baseUrl ?? 'file:///'
  // 域名默认值集中走 domain.ts（默认新 K8S 环境 *.ai.ict.cmcc，可经环境变量/行 config
  // 切回旧环境 *.ict.cmcc）；行 config 显式给值则优先。
  const fallback: HimarketSettings = {
    baseUrl: config.baseUrl?.trim() || defaultBaseUrl(),
    username: '',
    password: '',
    token: '',
    adminToken: '',
    adminUsername: 'admin',
    adminPassword: '',
    portalId: '',
    gatewayUrl: config.gatewayUrl?.trim() || defaultJobUrl(),
    skillInstallDir: config.skillInstallDir ?? '',
    // 一键登录参数：空 → domain.ts 内置默认（见 resolveSsoIssuer/resolveSsoClientId）。
    ssoIssuer: '',
    ssoClientId: '',
    // 调试开关默认关闭：账密框只读，只能一键登录（设计文档 §5.2）。
    allowPasswordLogin: false,
  }

  const settings = attachSettings(ctx, fallback, baseUrl)

  /** 一键登录会话管理器（每 loginId 一个回调 server + 定时器）。 */
  const sso = new SsoLoginManager()

  /** 当前生效的调试开关：settings 键与环境变量取或（设计文档 D4）。 */
  const passwordLoginAllowed = (): boolean =>
    allowPasswordLogin(settings.current().allowPasswordLogin)

  /** 组装 SSO 登录参数：settings 显式值优先，否则回退内置默认（D3）。 */
  const ssoConfig = (): SsoConfig => ({
    issuer: resolveSsoIssuer(settings.current().ssoIssuer),
    clientId: resolveSsoClientId(settings.current().ssoClientId),
    baseUrl: settings.current().baseUrl,
  })

  let client: HimarketClient | undefined
  let mcpManager: McpManager | undefined
  let subscribedMcps: SubscribedMcp[] = []
  let publishedSkills: PublishedSkill[] = []
  let installedSkills = new Set<string>()
  let lastError = ''
  /** 上次恢复完成时刻（见 BridgeState.lastRestoreAt）。 */
  let lastRestoreAt = ''
  /** 上次构建 client 时的凭据指纹；变化则丢弃缓存的 client。 */
  let clientFingerprint = ''

  /**
   * 凭据指纹：baseUrl + token + username + password 的拼接。
   *
   * 为什么需要：`client` 是缓存单例，且 HimarketClient 在构造时**快照**了 token。
   * 启动器「一键登录」是**外部进程**写 settings.yaml（settings 服务热加载），
   * 若不比对指纹，插件会一直用旧 token（过期后表现为持续 401）。
   */
  function fingerprintOf(s: HimarketSettings): string {
    return credentialsFingerprint(s)
  }

  /** 若 settings 里的凭据变了，丢弃缓存的 client（下次 ensureReady 会重建）。 */
  function invalidateClientIfStale(): void {
    const fp = fingerprintOf(settings.current())
    if (fp !== clientFingerprint) {
      clientFingerprint = fp
      client = undefined
    }
  }

  // 外部写入（启动器「一键登录」写 settings.yaml）触发热加载 → 立即丢弃缓存 client，
  // 使下一次 sync/install 用上新 token，无需重启 DSH。
  //
  // 同时触发一次「恢复」：启动器一键登录是**外部进程**写 settings.yaml，若只丢缓存
  // 不恢复，MCP 工具要等用户手点同步或重启才挂载 —— 「登录即可用」这条主路径会断。
  // 1s 防抖合并同一次登录的多次字段写入（token 与 username 分两次 save）。
  let restoreTimer: ReturnType<typeof setTimeout> | undefined
  ctx.effect(
    () => settings.onChange(() => {
      client = undefined
      clientFingerprint = ''
      if (restoreTimer !== undefined) clearTimeout(restoreTimer)
      restoreTimer = setTimeout(() => {
        restoreTimer = undefined
        void restoreFromSettings()
      }, 1000)
    }),
    'himarket.settings-watch',
  )
  /** 网关返回的来源/覆盖详情：productId → { source, overrides, overriddenBy } */
  interface SourceDetail {
    source: 'OFFICIAL' | 'COMMUNITY'
    overrides?: string
    overriddenBy?: Array<{ productId: string; name: string; publisher: string }>
  }
  let sourceDetail: Record<string, SourceDetail> = {}

  /** 若配置了网关，批量拉取各产品的来源/覆盖标签。 */
  async function refreshSources(): Promise<void> {
    const gw = settings.current().gatewayUrl.trim()
    if (gw === '') return
    const ids = [...subscribedMcps, ...publishedSkills].map((p) => p.productId).filter((id) => id !== '')
    if (ids.length === 0) return
    try {
      const res = await fetch(`${gw.replace(/\/+$/u, '')}/products/sources?ids=${encodeURIComponent(ids.join(','))}`)
      if (!res.ok) return
      const json = (await res.json().catch(() => ({ ok: false }))) as {
        ok?: boolean
        sources?: Record<string, SourceDetail>
      }
      if (json.ok && json.sources) {
        const next: Record<string, SourceDetail> = {}
        for (const id of ids) {
          const s = json.sources[id]
          next[id] = s
            ? { source: s.source ?? 'COMMUNITY', overrides: s.overrides ?? '', overriddenBy: s.overriddenBy }
            : { source: 'COMMUNITY' }
        }
        sourceDetail = next
      }
    } catch {
      // 网关不可用不影响同步/安装
    }
  }

  const sourceOf = (productId: string): 'OFFICIAL' | 'COMMUNITY' => sourceDetail[productId]?.source ?? 'COMMUNITY'

  const skillRoot = (): string => {
    const dir = settings.current().skillInstallDir
    return dir.trim() === '' ? defaultSkillRoot() : dir
  }

  /**
   * 是否具备可用凭据：见 settings.ts 的 hasCredentials（纯函数，已单测覆盖）。
   * 保留薄封装以便与本文件其它 helper 命名一致。
   */
  const hasCreds = (s: HimarketSettings): boolean => hasCredentials(s)

  function buildClient(): HimarketClient | undefined {
    const s = settings.current()
    if (!hasCreds(s)) return undefined
    return new HimarketClient({
      baseUrl: s.baseUrl,
      username: s.username,
      password: s.password,
      token: s.token,
      adminToken: s.adminToken,
      adminUsername: s.adminUsername,
      adminPassword: s.adminPassword,
    })
  }

  async function ensureReady(): Promise<HimarketClient> {
    // 先按最新 settings 判断缓存是否过期（启动器可能刚写入新 token）
    invalidateClientIfStale()
    const s = settings.current()
    if (s.baseUrl.trim() === '') throw new Error('还没配置 HiMarket 地址，请先在设置里填「HiMarket 地址」')
    if (!hasCredentials(s)) {
      throw new Error('还没登录 HiMarket：请在启动器托盘点「🔑 HiMarket 一键登录」，或在设置里填「用户名」和「密码」')
    }
    if (client === undefined) client = buildClient()!
    if (mcpManager === undefined) mcpManager = new McpManager(ctx, baseUrl)
    // SSO 模式下已有 token，直接用；账密模式且无 token 才登录换 token。
    if (!client!.hasToken) {
      if (s.username.trim() === '' || s.password.trim() === '') {
        throw new Error('HiMarket 登录已失效，请在启动器托盘点「🔑 HiMarket 一键登录」重新登录')
      }
      const token = await client!.login()
      await settings.save({ token })
    }
    return client!
  }

  async function sync(): Promise<string> {
    try {
      const c = await ensureReady()
      const { mcpServers, authHeaders } = await c.listSubscribedMcps()
      const skills = await c.listPublishedSkills()
      subscribedMcps = mcpServers
      publishedSkills = skills

      // 来源标签（企业发布/员工共建）+ 覆盖关系（官方默认、员工覆盖可选）：若配了网关则批量补
      await refreshSources()
      subscribedMcps = mcpServers.map((m) => ({
        ...m,
        source: sourceOf(m.productId),
        overrides: sourceDetail[m.productId]?.overrides ?? '',
        overriddenBy: sourceDetail[m.productId]?.overriddenBy ?? [],
      }))
      publishedSkills = skills.map((s) => ({
        ...s,
        source: sourceOf(s.productId),
        overrides: sourceDetail[s.productId]?.overrides ?? '',
        overriddenBy: sourceDetail[s.productId]?.overriddenBy ?? [],
      }))

      const report = await (mcpManager ?? new McpManager(ctx, baseUrl)).reconcile(mcpServers, authHeaders)
      installedSkills = await refreshInstalledSkills()

      lastError = ''
      const parts: string[] = []
      parts.push(`已同步：${mcpServers.length} 个已订阅 MCP，${skills.length} 个可安装技能。`)
      if (report.added.length > 0) parts.push(`新接入 MCP 工具：${report.added.join('、')}`)
      if (report.removed.length > 0) parts.push(`已移除 MCP：${report.removed.join('、')}`)
      if (report.errors.length > 0) parts.push(`有 ${report.errors.length} 个 MCP 连接失败：${report.errors.join('；')}`)
      return parts.join('\n')
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      return `同步失败：${lastError}`
    }
  }

  async function installByNameOrId(nameOrId: string): Promise<string> {
    try {
      const c = await ensureReady()
      const target = publishedSkills.find((s) => s.productId === nameOrId || s.name === nameOrId)
      if (target === undefined) {
        throw new Error(`找不到技能「${nameOrId}」，请先同步（或核对技能名/ID）`)
      }
      const result = await installSkill(c, target.productId, skillRoot())
      installedSkills.add(result.name)
      return result.note
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      return `安装失败：${lastError}`
    }
  }

  /**
   * 把本机已迭代的岗位打包并发布到 HiMarket（管理员端点）。
   * 流程：packageLocalJob（preset+skill 合并成 zip）→ publishSkillPackage（建/复用产品→上传→发布 online）。
   */
  async function publishJob(job: string): Promise<string> {
    const s = settings.current()
    if (s.baseUrl.trim() === '') throw new Error('还没配置 HiMarket 地址')
    if (s.username.trim() === '' || s.password.trim() === '') {
      throw new Error('还没配置 HiMarket 开发者账号（用户名/密码）')
    }
    let pkg: PublishPackageResult | undefined
    try {
      pkg = await packageLocalJob(job, { skillRoot: skillRoot() })
      const zipPath = pkg.zipPath

      // 优先走包装层网关（推荐）：开发者账号登录 + /publish，无需管理员密码，
      // 网关统一代发并登记归属/审计、打「企业发布/员工共建」来源标签。
      const gw = s.gatewayUrl.trim()
      if (gw !== '') {
        const loginRes = await fetch(`${gw.replace(/\/+$/u, '')}/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: s.username, password: s.password }),
        })
        const loginJson = (await loginRes.json().catch(() => ({ ok: false }))) as {
          ok?: boolean
          sessionId?: string
          error?: string
        }
        if (!loginJson.ok || !loginJson.sessionId) {
          throw new Error(loginJson.error ?? '包装层登录失败')
        }
        const pubRes = await fetch(`${gw.replace(/\/+$/u, '')}/publish`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${loginJson.sessionId}` },
          // 同事发布不挂门户（门户发布是官方/网关侧能力），不传 portalId
          body: JSON.stringify({ name: job, zipPath }),
        })
        const pubJson = (await pubRes.json().catch(() => ({ ok: false }))) as {
          ok?: boolean
          productId?: string
          version?: string
          created?: boolean
          action?: string
          error?: string
        }
        if (!pubJson.ok) throw new Error(pubJson.error ?? '包装层发布失败')
        const verb = pubJson.action === 'update' ? '更新' : '发布'
        return `已${verb}岗位「${job}」到 HiMarket：产品 ${pubJson.productId}，版本 ${pubJson.version}。同事可在市场同步后安装。`
      }

      // 发布只走包装层（企业统一通道：登记归属/来源/审计，同事无需管理员密码）。
      // 未配置网关时直接给出指引，不做直连管理员端点的回退。
      throw new Error('发布岗位需先配置「包装层地址」（企业统一发布通道），请在设置里填写后保存再发布。')
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      return `发布失败：${lastError}`
    } finally {
      if (pkg !== undefined) {
        const stageRoot = pkg.stageRoot
        await import('node:fs/promises').then((m) => m.rm(stageRoot, { recursive: true, force: true })).catch(() => {})
      }
    }
  }

  async function refreshInstalledSkills(): Promise<Set<string>> {
    const root = skillRoot()
    const names = new Set<string>()
    try {
      const { readdir } = await import('node:fs/promises')
      const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.')) names.add(e.name)
      }
    } catch {}
    return names
  }

  async function snapshot(): Promise<BridgeState> {
    const s = settings.current()
    const allowPwd = passwordLoginAllowed()
    // 环境地址来源判定（2026-09-21 UE）：读启动器缓存的「服务端实际下发值」，
    // 与生效值比对，如实区分「服务端下发 / 内置默认 / 本地 / 未知」。
    // 读不到（非 launcher 启动的实例）→ UNKNOWN，不猜测。
    const server = readServerEnvDefaults(harnessHome())
    return {
      // SSO（有 token）或账密（username+password）任一成立即为已配置
      configured: hasCredentials(s),
      loggedIn: (client?.hasToken ?? false) || s.token !== '',
      baseUrl: s.baseUrl,
      username: s.username,
      portalId: s.portalId,
      gatewayUrl: s.gatewayUrl,
      mcpServers: subscribedMcps,
      activeMcpNames: mcpManager?.activeServerNames() ?? [],
      publishedSkills,
      installedSkills: [...installedSkills],
      lastError,
      lastRestoreAt,
      loginState: loginStateOf(s, allowPwd),
      loginUsername: s.username,
      allowPasswordLogin: allowPwd,
      addressProvenance: {
        baseUrl: classifyField(server, 'himarket', 'baseUrl', s.baseUrl, defaultBaseUrl()),
        gatewayUrl: classifyField(server, 'himarket', 'gatewayUrl', s.gatewayUrl, defaultJobUrl()),
      },
    }
  }

  /**
   * 从当前 settings 恢复：拉订阅清单 → 建 MCP fiber → 刷新已装技能。
   *
   * 触发时机（三处，共用本函数 + restoring 标志串行化）：
   *   ① settings 句柄就绪（onReady）—— 启动恢复；
   *   ② settings 热加载（onChange，1s 防抖）—— 启动器一键登录后免重启；
   *   ③ 用户在设置页点「同步」（走 sync()，与本函数幂等）。
   *
   * ⚠️ 为什么不能沿用旧的「apply() 同步读 settings 判门禁」写法：
   * attachSettings 用 ctx.inject 异步等 settings 就绪，apply() 返回时 current() 只
   * 读到 fallback（token/username/password 全空）→ 门禁恒假 → 恢复永不执行。
   * 且判定必须用 hasCredentials（兼容 v0.1.7 起的 token-only SSO，不写 password）。
   */
  let restoring = false
  async function restoreFromSettings(): Promise<void> {
    if (restoring) return
    const s = settings.current()
    if (!hasCredentials(s)) return
    restoring = true
    try {
      const c = buildClient()
      if (c === undefined) return
      client = c
      if (mcpManager === undefined) mcpManager = new McpManager(ctx, baseUrl)
      const { mcpServers, authHeaders } = await c.listSubscribedMcps()
      subscribedMcps = mcpServers
      publishedSkills = await c.listPublishedSkills()
      const report = await mcpManager.reconcile(mcpServers, authHeaders)
      installedSkills = await refreshInstalledSkills()
      // ⚠️ 必须如实上报连接失败：reconcile 把单个 MCP 的连接异常收进 errors 而不抛出，
      // 若这里无条件清空 lastError，则「连上了」与「连接失败」在 /state 里无法区分
      // （lastError 为空会被误读为健康）。与 sync() 的处理保持一致。
      if (report.errors.length > 0) {
        lastError = `MCP 连接失败：${report.errors.join('；')}`
        ctx.logger.warn('[dsh-himarket] 启动恢复部分失败：%s', lastError)
      } else {
        lastError = ''
      }
      lastRestoreAt = new Date().toISOString()
      ctx.logger.info(
        '[dsh-himarket] 启动恢复完成：%d 个 MCP（新增 %d、移除 %d）、%d 个技能',
        mcpServers.length,
        report.added.length,
        report.removed.length,
        publishedSkills.length,
      )
    } catch (error) {
      ctx.logger.warn('[dsh-himarket] 启动恢复失败（将静默降级）：%s', error instanceof Error ? error.message : String(error))
      lastError = error instanceof Error ? error.message : String(error)
      lastRestoreAt = new Date().toISOString()
    } finally {
      restoring = false
    }
  }

  // 启动恢复：等 settings 句柄就绪后异步尝试（不阻塞启动）。
  settings.onReady(() => {
    void restoreFromSettings()
  })

  void registerHimarketTools(ctx, baseUrl, {
    sync,
    installSkill: installByNameOrId,
    publishJob,
  })

  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.get('webServer') as
      { register(route: { kind: string; path: string; handler: (req: any, res: any) => Promise<void> | void }): () => void }
    if (webServer === undefined) {
      ctx.logger.warn('[dsh-himarket] webServer 服务不可用，设置页卡片路由未注册')
      return
    }

    const isLoopback = (addr: string): boolean =>
      addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

    const sendJson = (res: any, status: number, body: unknown): void => {
      const json = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.end(json)
    }

    const sendError = (res: any, status: number, message: string): void => {
      sendJson(res, status, { ok: false, error: message })
    }

    return webServer.register({
      kind: 'prefix',
      path: '/himarket',
      handler: async (req, res) => {
        if (!isLoopback(req.socket?.remoteAddress ?? '')) {
          sendError(res, 403, '仅允许本机访问')
          return
        }
        const url = new URL(req.url ?? '/', 'http://x')
        const pathname = url.pathname
        const method = req.method ?? 'GET'
        const readBody = async (): Promise<Record<string, unknown>> => {
          let raw = ''
          for await (const chunk of req) raw += chunk
          if (raw.trim() === '') return {}
          try {
            return JSON.parse(raw) as Record<string, unknown>
          } catch {
            throw new Error('请求体不是合法 JSON')
          }
        }

        try {
          if (method === 'GET' && pathname === '/himarket/state') {
            sendJson(res, 200, { ok: true, ...(await snapshot()) })
            return
          }
          if (method === 'POST' && pathname === '/himarket/save-config') {
            const body = await readBody()
            const patch: Partial<HimarketSettings> = {}
            if (typeof body.baseUrl === 'string') patch.baseUrl = body.baseUrl
            if (typeof body.username === 'string') patch.username = body.username
            if (typeof body.password === 'string') patch.password = body.password
            if (typeof body.portalId === 'string') patch.portalId = body.portalId
            if (typeof body.skillInstallDir === 'string') patch.skillInstallDir = body.skillInstallDir
            if (typeof body.gatewayUrl === 'string') patch.gatewayUrl = body.gatewayUrl
            // ⚠️ 环境地址守卫（设计文档 §13.3）：baseUrl / gatewayUrl 由服务端统一下发
            // （launcher env_defaults.rs 的 FORCE_OVERRIDE_KEYS 每次同步强制覆盖），
            // 本地改了也无效。故调试开关关闭时**拒绝**这两个键 —— 只把浏览器端输入框
            // 设成只读挡不住同机进程直接 POST 本端点，host 侧必须同样设防。
            const { allowed, rejected } = splitAddressPatch(patch, passwordLoginAllowed())
            if (rejected.length > 0) {
              sendError(res, 403, `环境地址（${rejected.join(' / ')}）由服务端统一下发，本地不可修改。如确需调试，请开启调试开关（DSH_HIMARKET_ALLOW_PASSWORD=1 或 himarket.allowPasswordLogin=true）。`)
              return
            }
            const safePatch = allowed as Partial<HimarketSettings>
            // 地址被清空时，一并清空 token（避免残留旧凭证）。
            if (safePatch.baseUrl !== undefined && safePatch.baseUrl.trim() === '') {
              safePatch.token = ''
              safePatch.adminToken = ''
            }
            await settings.save(safePatch)
            // 凭证变化：丢弃旧 client（含旧 token）；若地址被清空，同时卸载 MCP fiber 并清空内存缓存。
            client = undefined
            clientFingerprint = ''
            if (safePatch.baseUrl !== undefined && safePatch.baseUrl.trim() === '') {
              mcpManager?.dispose()
              mcpManager = undefined
              subscribedMcps = []
              publishedSkills = []
              installedSkills = new Set()
              lastError = ''
            }
            sendJson(res, 200, { ok: true, configured: true })
            return
          }
          if (method === 'POST' && pathname === '/himarket/sync') {
            const summary = await sync()
            sendJson(res, 200, { ok: true, summary })
            return
          }
          if (method === 'POST' && pathname === '/himarket/install-skill') {
            const body = await readBody()
            const nameOrId = typeof body.nameOrId === 'string' ? body.nameOrId : ''
            if (nameOrId === '') {
              sendError(res, 400, '缺少 nameOrId')
              return
            }
            const summary = await installByNameOrId(nameOrId)
            sendJson(res, 200, { ok: true, summary })
            return
          }
          if (method === 'POST' && pathname === '/himarket/publish-job') {
            const body = await readBody()
            const job = typeof body.job === 'string' ? body.job : ''
            if (job === '') {
              sendError(res, 400, '缺少 job')
              return
            }
            const summary = await publishJob(job)
            sendJson(res, 200, { ok: true, summary })
            return
          }
          // ---- 一键登录（Keycloak SSO + PKCE，见 sso-login.ts）----
          if (method === 'POST' && pathname === '/himarket/login-start') {
            const cfg = ssoConfig()
            if (cfg.baseUrl.trim() === '') {
              sendError(res, 400, '还没配置 HiMarket 地址，请先在设置里填「HiMarket 地址」')
              return
            }
            const started = await sso.start(cfg)
            sendJson(res, 200, { ok: true, ...started })
            return
          }
          if (method === 'GET' && pathname === '/himarket/login-status') {
            const loginId = url.searchParams.get('loginId') ?? ''
            const result = sso.status(loginId)
            // 成功后：取走 token 写 settings（token 不回传浏览器），丢弃缓存 client
            // 并自动同步一次 —— 登录即可用，无需用户再点「同步能力」。
            if (result.status === 'success' && result.username !== '') {
              const token = sso.takeToken(loginId)
              if (token !== '') {
                await settings.save({ token, username: result.username })
                client = undefined
                clientFingerprint = ''
                const summary = await sync()
                sendJson(res, 200, { ok: true, ...result, summary })
                return
              }
            }
            sendJson(res, 200, { ok: true, ...result })
            return
          }
          if (method === 'POST' && pathname === '/himarket/login-cancel') {
            const body = await readBody()
            const loginId = typeof body.loginId === 'string' ? body.loginId : ''
            sso.cancel(loginId)
            sendJson(res, 200, { ok: true })
            return
          }
          if (method === 'POST' && pathname === '/himarket/logout') {
            // 只清 token：保留 username/password，使账密兜底仍可用（设计文档 §7）。
            // 开关关闭时 loginState 会变为 EXPIRED，UI 显示「登录已过期」+ 重新登录。
            await settings.save({ token: '' })
            client = undefined
            clientFingerprint = ''
            mcpManager?.dispose()
            mcpManager = undefined
            subscribedMcps = []
            publishedSkills = []
            installedSkills = new Set()
            lastError = ''
            sendJson(res, 200, { ok: true })
            return
          }
          sendError(res, 404, '未知的 /himarket 端点')
        } catch (error) {
          sendError(res, 500, error instanceof Error ? error.message : String(error))
        }
      },
    })
  })

  ctx.effect(() => {
    return () => {
      if (restoreTimer !== undefined) clearTimeout(restoreTimer)
      restoreTimer = undefined
      mcpManager?.dispose()
      mcpManager = undefined
      client = undefined
      // 释放一键登录的回调 server 与定时器（否则插件卸载后端口不释放）
      sso.dispose()
    }
  }, 'himarket.dispose')
}

export { defaultSkillRoot } from './skill.js'
export { sanitizeServerName } from './mcp.js'
