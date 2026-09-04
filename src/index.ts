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
import { attachSettings } from './settings.js'
import type { HimarketSettings } from './settings.js'
import { installSkill, defaultSkillRoot } from './skill.js'
import { packageLocalJob } from './publish.js'
import type { PublishPackageResult } from './publish.js'
import { registerHimarketTools } from './tools.js'

export const name = 'himarket'

/** cordis.patch.yml 行 config（默认值，settings 覆盖）。 */
export interface Config {
  skillInstallDir: string
}

/** 桥接运行时状态快照（给 HTTP /state 与同步摘要用）。 */
interface BridgeState {
  configured: boolean
  loggedIn: boolean
  baseUrl: string
  username: string
  portalId: string
  mcpServers: SubscribedMcp[]
  activeMcpNames: string[]
  publishedSkills: PublishedSkill[]
  installedSkills: string[]
  lastError: string
}

export function apply(ctx: Context, config: Config): void {
  const baseUrl = ctx.baseUrl ?? 'file:///'
  const fallback: HimarketSettings = {
    baseUrl: '',
    username: '',
    password: '',
    token: '',
    adminToken: '',
    adminUsername: 'admin',
    adminPassword: '',
    portalId: '',
    skillInstallDir: config.skillInstallDir ?? '',
  }

  const settings = attachSettings(ctx, fallback, baseUrl)

  let client: HimarketClient | undefined
  let mcpManager: McpManager | undefined
  let subscribedMcps: SubscribedMcp[] = []
  let publishedSkills: PublishedSkill[] = []
  let installedSkills = new Set<string>()
  let lastError = ''

  const skillRoot = (): string => {
    const dir = settings.current().skillInstallDir
    return dir.trim() === '' ? defaultSkillRoot() : dir
  }

  function buildClient(): HimarketClient | undefined {
    const s = settings.current()
    if (s.baseUrl.trim() === '' || s.username.trim() === '' || s.password.trim() === '') {
      return undefined
    }
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
    const s = settings.current()
    if (s.baseUrl.trim() === '') throw new Error('还没配置 HiMarket 地址，请先在设置里填「HiMarket 地址」')
    if (s.username.trim() === '' || s.password.trim() === '') {
      throw new Error('还没配置 HiMarket 账号，请先在设置里填「用户名」和「密码」')
    }
    if (client === undefined) client = buildClient()!
    if (mcpManager === undefined) mcpManager = new McpManager(ctx, baseUrl)
    if (!client!.hasToken) {
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
    if (client === undefined) client = buildClient()!
    // 管理员 token 缺失但有密码记录时，先登录管理员再发布。
    if (client.adminTokenMissing() && s.adminPassword.trim() !== '') {
      await client.loginAdmin()
      if (client.adminTokenMissing() === false) {
        await settings.save({ adminToken: client.cachedAdminToken() })
      }
    }
    let pkg: PublishPackageResult | undefined
    try {
      pkg = await packageLocalJob(job, { skillRoot: skillRoot() })
      const zipPath = pkg.zipPath
      const stageRoot = pkg.stageRoot
      const zipBytes = new Uint8Array(await import('node:fs/promises').then((m) => m.readFile(zipPath)))
      const result = await client.publishSkillPackage(job, zipBytes, {
        portalId: s.portalId,
        categoryName: '数字员工岗位',
      })
      return `已发布岗位「${job}」到 HiMarket：产品 ${result.productId}，版本 ${result.version}（online）。同事可在市场同步后安装。`
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
    return {
      configured: s.baseUrl.trim() !== '' && s.username.trim() !== '' && s.password.trim() !== '',
      loggedIn: (client?.hasToken ?? false) || s.token !== '',
      baseUrl: s.baseUrl,
      username: s.username,
      portalId: s.portalId,
      mcpServers: subscribedMcps,
      activeMcpNames: mcpManager?.activeServerNames() ?? [],
      publishedSkills,
      installedSkills: [...installedSkills],
      lastError,
    }
  }

  // 启动时：若已有凭证，异步尝试恢复（不阻塞启动）。
  const boot = settings.current()
  if (boot.baseUrl.trim() !== '' && boot.username.trim() !== '' && boot.password.trim() !== '') {
    void (async () => {
      try {
        client = buildClient()!
        mcpManager = new McpManager(ctx, baseUrl)
        const { mcpServers, authHeaders } = await client.listSubscribedMcps()
        subscribedMcps = mcpServers
        publishedSkills = await client.listPublishedSkills()
        await mcpManager.reconcile(mcpServers, authHeaders)
        installedSkills = await refreshInstalledSkills()
        ctx.logger.info('[dsh-himarket] 启动恢复完成：%d 个 MCP、%d 个技能', mcpServers.length, publishedSkills.length)
      } catch (error) {
        ctx.logger.warn('[dsh-himarket] 启动恢复失败（将静默降级）：%s', error instanceof Error ? error.message : String(error))
        lastError = error instanceof Error ? error.message : String(error)
      }
    })()
  }

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
            // 地址被清空时，一并清空 token（避免残留旧凭证）。
            if (patch.baseUrl !== undefined && patch.baseUrl.trim() === '') {
              patch.token = ''
              patch.adminToken = ''
            }
            // 管理员密码单独传入：登录管理员以缓存 adminToken（不持久化密码本身，仅缓存 token）。
            if (typeof body.adminPassword === 'string' && body.adminPassword.trim() !== '') {
              const cur = settings.current()
              try {
                const tmp = new HimarketClient({
                  baseUrl: patch.baseUrl ?? cur.baseUrl,
                  username: patch.username ?? cur.username,
                  password: patch.password ?? cur.password,
                  token: cur.token,
                  adminToken: cur.adminToken,
                  adminUsername: cur.adminUsername,
                  adminPassword: body.adminPassword,
                })
                const adminToken = await tmp.loginAdmin()
                patch.adminToken = adminToken
              } catch (e) {
                // 管理员登录失败不阻断保存，仅记录错误。
                lastError = e instanceof Error ? e.message : String(e)
              }
            }
            await settings.save(patch)
            // 凭证变化：丢弃旧 client（含旧 token）；若地址被清空，同时卸载 MCP fiber 并清空内存缓存。
            client = undefined
            if (patch.baseUrl !== undefined && patch.baseUrl.trim() === '') {
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
          sendError(res, 404, '未知的 /himarket 端点')
        } catch (error) {
          sendError(res, 500, error instanceof Error ? error.message : String(error))
        }
      },
    })
  })

  ctx.effect(() => {
    return () => {
      mcpManager?.dispose()
      mcpManager = undefined
      client = undefined
    }
  }, 'himarket.dispose')
}

export { defaultSkillRoot } from './skill.js'
export { sanitizeServerName } from './mcp.js'
