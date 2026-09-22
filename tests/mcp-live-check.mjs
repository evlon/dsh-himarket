/**
 * 手动实测脚本：验证「HiMarket 订阅 → MCP 工具真实可用」这条链路。
 *
 * 与 tests/*.test.mjs 的区别：那些是纯逻辑单测（不联网）；本脚本要**真实访问**
 * market.ai.ict.cmcc 与 mcp.ai.ict.cmcc，属于联调验收工具，不纳入 CI。
 *
 * 跑法：
 *   node tests/mcp-live-check.mjs                      # 用 3090 的 settings（默认）
 *   node tests/mcp-live-check.mjs --home C:/path/.dsh  # 指定其它 DSH_HOME
 *   node tests/mcp-live-check.mjs --call               # 额外做只读 tools/call 冒烟
 *
 * 三层验证（缺一不可，见 docs）：
 *   ① 服务端：本脚本 —— 直连 MCP 端点做 initialize / tools/list / tools/call
 *   ② 客户端状态：GET http://127.0.0.1:<port>/himarket/state 看 activeMcpNames
 *   ③ 网关铁证：ssh ai-k8s 后
 *        docker exec higress-standalone grep mcp-servers /var/log/higress/gateway.log
 *      看 user_agent=node 的握手三连（initialize 200 + notification 202 + tools/list 200）
 *
 * ⚠️ 本脚本只调用**只读**工具，不做任何写操作。
 */

import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** 命令行参数（极简解析，避免引入依赖）。 */
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const HOME = arg('home', 'C:/Users/niukl/.dsh-matrix-dev')
const DO_CALL = process.argv.includes('--call')

/**
 * 解析 js-yaml：优先用 dsh 安装自带的（本仓 devDeps 不含）。
 * ⚠️ 必须用真 YAML 解析器，不能自己写正则 —— settings.yaml 里的长 token 是
 * 折行续行（`\` + 换行）写的，手写正则只会取到首行（72 字符）导致误判「token 失效」。
 */
function loadYaml() {
  const candidates = [
    'C:/Users/niukl/AppData/Local/nvm/v24.19.0/node_modules/@deepseek-ai/dsh/node_modules/',
    join(process.cwd(), 'node_modules'),
  ]
  for (const base of candidates) {
    try {
      return createRequire(base)('js-yaml')
    } catch {}
  }
  throw new Error('找不到 js-yaml：请用 dsh 安装目录下的 node 运行，或在本仓 pnpm add -D js-yaml')
}

/** 解析 settings.yaml 里的 himarket 段。 */
function readHimarket() {
  const file = join(HOME, 'settings.yaml')
  if (!existsSync(file)) throw new Error(`找不到 ${file}`)
  const doc = loadYaml().load(readFileSync(file, 'utf8')) ?? {}
  const hm = doc.himarket ?? {}
  const token = String(hm.token ?? '').trim()
  if (token === '') throw new Error('settings.yaml 里 himarket.token 为空：先在启动器点「HiMarket 一键登录」')
  return { baseUrl: String(hm.baseUrl ?? '').replace(/\/+$/u, ''), token, username: String(hm.username ?? '') }
}

/** 解析 SSE 响应体里的 data: 行（MCP streamable-http 返回 text/event-stream）。 */
function parseSse(text) {
  const out = []
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue
    try {
      out.push(JSON.parse(line.slice(5).trim()))
    } catch {}
  }
  return out
}

/** 一次 JSON-RPC 调用（自动带 session id）。 */
async function rpc(url, headers, body, sessionId) {
  const h = { ...headers }
  if (sessionId !== undefined && sessionId !== '') h['mcp-session-id'] = sessionId
  const res = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, sessionId: res.headers.get('mcp-session-id') ?? '', messages: parseSse(text), text }
}

/** 只读冒烟用例：绝不选有副作用的工具。 */
const READ_ONLY_CASES = {
  'cmoa-oa-full': { tool: 'oa_login_status', args: {} },
  'wiki-mcp': { tool: 'list_banks', args: {} },
}

async function main() {
  const { baseUrl, token, username } = readHimarket()
  console.log(`DSH_HOME = ${HOME}`)
  console.log(`baseUrl  = ${baseUrl} | username = ${username} | tokenLen = ${token.length}\n`)

  // ── 第 1 步：拉订阅清单 ────────────────────────────────────────────────
  const res = await fetch(`${baseUrl}/api/v1/cli-providers/market-mcps`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  console.log(`[1] market-mcps HTTP=${res.status}`)
  if (res.status !== 200) {
    console.log('    ❌ 拉订阅失败：token 可能过期，或 baseUrl 不对')
    process.exitCode = 1
    return
  }
  const data = (await res.json()).data ?? {}
  const mcps = data.mcpServers ?? []
  const authHeaders = data.authHeaders ?? {}
  console.log(`    已订阅 MCP = ${mcps.length} 个，authHeaders = ${Object.keys(authHeaders).join(',') || '(空)'}`)
  for (const m of mcps) console.log(`      - ${m.name} → ${m.url}`)
  if (mcps.length === 0) {
    console.log('    ⚠️ 订阅清单为空：去 HiMarket 门户订阅 MCP 产品（auto_approve=true 时订阅即生效）')
    return
  }
  // 下发地址必须是客户端可达的公网域名（不能是 *.svc.cluster.local，PC 上解析不了）
  for (const m of mcps) {
    if (String(m.url).includes('.svc.cluster.local')) {
      console.log(`    ❌ ${m.name} 下发的是集群内域名，客户端必然 ENOTFOUND`)
      process.exitCode = 1
    }
  }

  // ── 第 2 步：逐 MCP 握手 + tools/list ─────────────────────────────────
  console.log('\n[2] 逐 MCP 握手与工具清单')
  let total = 0
  for (const m of mcps) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...authHeaders,
    }
    try {
      const init = await rpc(
        m.url,
        headers,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'mcp-live-check', version: '1' },
          },
        },
      )
      const info = init.messages[0]?.result?.serverInfo
      if (init.status !== 200 || info === undefined) {
        console.log(`    ❌ ${m.name}: initialize HTTP=${init.status} ${init.text.slice(0, 120)}`)
        process.exitCode = 1
        continue
      }
      const sid = init.sessionId
      await rpc(m.url, headers, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid)
      const listed = await rpc(m.url, headers, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sid)
      const tools = listed.messages.find((x) => x.id === 2)?.result?.tools ?? []
      total += tools.length
      console.log(`    ✅ ${m.name}: serverInfo=${JSON.stringify(info)} | 工具 ${tools.length} 个`)
      console.log(`       模型可见名：mcp__${m.name}__<工具名>（例：mcp__${m.name}__${tools[0]?.name ?? '?'}）`)

      // ── 第 3 步（可选）：只读 tools/call 冒烟 ─────────────────────────
      if (DO_CALL) {
        const c = READ_ONLY_CASES[m.name]
        if (c === undefined) {
          console.log('       (跳过 tools/call：未登记只读用例)')
        } else {
          const called = await rpc(
            m.url,
            headers,
            { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: c.tool, arguments: c.args } },
            sid,
          )
          const r = called.messages.find((x) => x.id === 9)?.result
          const text = String(r?.content?.[0]?.text ?? called.text).replace(/\s+/gu, ' ').slice(0, 200)
          console.log(`       tools/call ${c.tool}: HTTP=${called.status}${r?.isError === true ? ' isError=true' : ''}`)
          console.log(`         → ${text}`)
        }
      }
    } catch (error) {
      console.log(`    ❌ ${m.name}: ${error.message} | cause=${error.cause?.code ?? error.cause?.message ?? '-'}`)
      process.exitCode = 1
    }
  }

  console.log(`\n[3] 合计 ${total} 个工具可经 mcp__<server>__<tool> 调用`)
  console.log('    下一步（客户端侧）：在 3090 的对话里让 Agent 调一次只读工具，')
  console.log('    再用 GET /himarket/state 的 activeMcpNames 与网关日志交叉确认。')
}

await main()
