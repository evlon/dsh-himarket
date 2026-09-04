/**
 * 对话式入口工具：himarket_sync / himarket_install_skill。
 *
 * 工具注册到 host tools 全局层（与 dsh-matrix 一致），所有会话可见、模型可调用。
 * 文案面向小白：用大白话描述，让用户直接对 DSH 说「同步 HiMarket」「安装 xx 技能」即可。
 *
 * @module dsh-himarket/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { importOfficial } from './resolver.js'

/** 模型可见内容块（运行期事实，本地窄类型，避免依赖 dsh-llm 包）。 */
interface ContentBlock {
  type: string
  text?: string
}

/** 工具定义与注册所需的官方窄接口。 */
interface ToolsLike {
  register(definition: unknown): () => void
}

/** defineTool 的窄接口（运行期事实，参数宽松）。 */
interface DefineToolFn {
  (options: Record<string, unknown>): unknown
}

/** 桥接暴露给工具的同步/安装/发布回调（由 index.ts 注入）。 */
export interface HimarketToolDeps {
  sync(): Promise<string>
  installSkill(nameOrId: string): Promise<string>
  publishJob(job: string): Promise<string>
}

/** 把字符串渲染成模型可见文本块。 */
function renderResult(_args: Record<string, unknown>, value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/** 注册 himarket_sync 与 himarket_install_skill。 */
export async function registerHimarketTools(ctx: Context, baseUrl: string, deps: HimarketToolDeps): Promise<void> {
  const tools = ctx.get('tools') as ToolsLike | undefined
  if (tools === undefined) {
    ctx.logger.warn('[dsh-himarket] tools 服务不可用，对话式入口未注册')
    return
  }
  const mod = await importOfficial('@deepseek-ai/dsh-tools', baseUrl)
  const defineTool = mod.defineTool as DefineToolFn | undefined
  if (typeof defineTool !== 'function') {
    ctx.logger.warn('[dsh-himarket] 官方 dsh-tools 未导出 defineTool，对话式入口未注册')
    return
  }

  const syncTool = defineTool({
    name: 'himarket_sync',
    description: '从 HiMarket 同步能力：把已订阅的 MCP 工具接入当前会话、刷新可安装的技能清单。当用户说「同步 HiMarket」「刷新市场能力」时调用。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: renderResult,
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute() {
      return await deps.sync()
    },
  })

  const installTool = defineTool({
    name: 'himarket_install_skill',
    description: '从 HiMarket 安装一个技能（Agent Skill）到本机，装完即可在会话里使用。参数传技能名或产品 ID。当用户说「安装 xx 技能」「装一下 xx」时调用。',
    parameters: {
      nameOrId: {
        type: 'string',
        required: true,
        description: '要安装的技能名或产品 ID（可在同步后的技能清单里找到）',
      },
    },
    output: {
      schema: { type: 'string' },
      render: renderResult,
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>) {
      const nameOrId = typeof args.nameOrId === 'string' ? args.nameOrId.trim() : ''
      if (nameOrId === '') throw new Error('请提供要安装的技能名或产品 ID')
      return await deps.installSkill(nameOrId)
    },
  })

  const publishTool = defineTool({
    name: 'himarket_publish_job',
    description: '把本机已迭代优化的数字员工岗位（preset 人设 + 岗位技能）打包并发布到 HiMarket，供同事同步安装。参数传岗位 id（如 pm/dev/qa/leader/newbie/secretary）。当用户说「发布 pm 岗位」「把我的岗位分享到市场」时调用。需要先在设置里填好管理员账号。',
    parameters: {
      job: {
        type: 'string',
        required: true,
        description: '要发布的岗位 id（本地已安装/迭代的岗位目录名，如 pm）',
      },
    },
    output: {
      schema: { type: 'string' },
      render: renderResult,
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>) {
      const job = typeof args.job === 'string' ? args.job.trim() : ''
      if (job === '') throw new Error('请提供要发布的岗位 id')
      return await deps.publishJob(job)
    },
  })

  tools.register(syncTool)
  tools.register(installTool)
  tools.register(publishTool)
  ctx.logger.info('[dsh-himarket] 已注册对话式工具 himarket_sync / himarket_install_skill / himarket_publish_job')
}
