/**
 * MCP 接入：把「已订阅 MCP 清单」映射为一组 @deepseek-ai/dsh-mcp-client 动态 fiber。
 *
 * 复用官方 mcp-client（不重造客户端）：经 ctx.plugin(plugin, config) 动态实例化，
 * 每次 sync 做「期望清单 vs 现存 fiber」的 diff——新增/变更 dispose 旧 fiber 再建，
 * 移除则 dispose。mcp-client 的 inject 是 ['tools']，工具注册到 host tools 全局层，
 * 对所有会话可见（与 dsh-matrix 注册工具同一机制）。
 *
 * 官方包在运行时经 createRequire(ctx.baseUrl) 解析（web profile 的 @deepseek-ai 是空目录）。
 *
 * @module dsh-himarket/mcp
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubscribedMcp } from './himarket-client.js'
import { importOfficial } from './resolver.js'

/** 一个已连接的 MCP fiber 句柄。 */
interface McpFiberHandle {
  serverName: string
  key: string
  fiber: { dispose(): void }
}

/** mcp-client 的 apply 签名（运行期事实）。 */
type McpApply = (ctx: Context, config: Record<string, unknown>) => Promise<void> | void

/** 清洗 HiMarket 的 name 为合法 serverName（去非法字符，压缩下划线）。 */
export function sanitizeServerName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_-]/gu, '_')
    .replace(/^_+|_+$/gu, '')
  if (cleaned === '') return 'mcp'
  return cleaned.slice(0, 32)
}

/** 组装 mcp-client 的 config（streamable-http）。 */
function buildMcpConfig(mcp: SubscribedMcp, authHeaders: Record<string, string>): Record<string, unknown> {
  const transport = mcp.transportType === 'stdio' ? 'stdio' : 'streamable-http'
  if (transport === 'stdio') {
    throw new Error(`暂不支持 stdio 型 MCP（${mcp.name}）`)
  }
  return {
    transport: 'streamable-http',
    serverName: sanitizeServerName(mcp.name),
    url: mcp.url,
    headers: { ...authHeaders },
    failOnStartupError: false,
  }
}

/**
 * 订阅态 → 动态 mcp-client fiber 集合管理器。惰性加载官方 mcp-client，
 * 只在第一次 reconcile 时 import，避免启动期拖慢。
 */
export class McpManager {
  private readonly ctx: Context
  private readonly baseUrl: string
  private readonly handles = new Map<string, McpFiberHandle>()
  private mcpApply: McpApply | undefined

  constructor(ctx: Context, baseUrl: string) {
    this.ctx = ctx
    this.baseUrl = baseUrl
  }

  /** 当前已连接的 serverName 列表。 */
  activeServerNames(): string[] {
    return [...this.handles.keys()]
  }

  /** 与期望清单做 diff，重建 fiber 集合；返回 { added, removed, errors }。 */
  async reconcile(desired: SubscribedMcp[], authHeaders: Record<string, string>): Promise<{
    added: string[]
    removed: string[]
    errors: string[]
  }> {
    const apply = await this.ensureLoaded()
    const next = new Map<string, SubscribedMcp>()
    const errors: string[] = []

    for (const mcp of desired) {
      const serverName = sanitizeServerName(mcp.name)
      if (!next.has(serverName)) next.set(serverName, mcp)
    }

    const added: string[] = []
    const removed: string[] = []

    for (const [serverName, handle] of [...this.handles]) {
      if (!next.has(serverName)) {
        try {
          handle.fiber.dispose()
        } catch {}
        this.handles.delete(serverName)
        removed.push(serverName)
      }
    }

    for (const [serverName, mcp] of next) {
      const existing = this.handles.get(serverName)
      const existingKey = existing?.key
      const newKey = JSON.stringify([mcp.url, mcp.transportType, authHeaders])
      if (existingKey === newKey) continue

      if (existing !== undefined) {
        try {
          existing.fiber.dispose()
        } catch {}
        this.handles.delete(serverName)
      }

      try {
        const config = buildMcpConfig(mcp, authHeaders)
        const fiber = this.ctx.plugin({ inject: ['tools'], apply }, config)
        this.handles.set(serverName, { serverName, key: newKey, fiber: { dispose: () => fiber.dispose() } })
        added.push(serverName)
      } catch (error) {
        errors.push(`${serverName}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return { added, removed, errors }
  }

  /** 卸载全部 fiber（插件销毁时）。 */
  dispose(): void {
    for (const handle of this.handles.values()) {
      try {
        handle.fiber.dispose()
      } catch {}
    }
    this.handles.clear()
  }

  /** 惰性加载官方 mcp-client 并缓存 apply。 */
  private async ensureLoaded(): Promise<McpApply> {
    if (this.mcpApply !== undefined) return this.mcpApply
    const mod = await importOfficial('@deepseek-ai/dsh-mcp-client', this.baseUrl)
    const apply = mod.apply as McpApply | undefined
    if (typeof apply !== 'function') {
      throw new Error('官方 mcp-client 未导出 apply')
    }
    this.mcpApply = apply
    return apply
  }
}
