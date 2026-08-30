/**
 * 本地 mock HiMarket 后端：用于端到端冒烟（不依赖真实 HiMarket 部署）。
 * 起一个最小 HTTP 服务，暴露 /developers/login、/cli-providers/market-mcps、
 * /cli-providers/market-skills、/skills/{id}/download。
 * 用法：node tests/mock-himarket.mjs <port> <skillZipPath>
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const port = Number(process.argv[2] ?? '18080')

// 准备一个可下载的 skill ZIP。
const tmp = await mkdtemp(join(tmpdir(), 'mock-himarket-'))
const skillDir = join(tmp, 'mock-skill')
await mkdir(skillDir, { recursive: true })
await writeFile(join(skillDir, 'SKILL.md'), '---\nname: mock-skill\ndescription: a mock skill\n---\n\n# Mock\n')
await writeFile(join(skillDir, 'asset.txt'), 'asset')
const zipPath = join(tmp, 'mock-skill.zip')
await promisify(execFile)('tar', ['-cf', zipPath, '-C', tmp, 'mock-skill'], { windowsHide: true })

const skillZip = await readFile(zipPath)

// 一个极简 MCP server（streamable-http 不可用的话就只做 listTools 应签——但真实桥接用官方 mcp-client，
// 这里 mock 阶段先只验证「清单拉取 + fiber 创建」，MCP 工具真连留待真实 HiMarket 验证）。
// 为让 mcp-client 能连上，这里起一个返回 MCP 响应的 HTTP 端点（简化：只响应 initialize/tools/list）。

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const path = url.pathname
  const method = req.method ?? 'GET'

  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  // 登录
  if (method === 'POST' && path === '/developers/login') {
    return json(200, { code: 'SUCCESS', data: { access_token: 'mock-token', token_type: 'Bearer', expires_in: 604800 } })
  }

  // 已订阅 MCP
  if (method === 'GET' && path === '/cli-providers/market-mcps') {
    return json(200, {
      code: 'SUCCESS',
      data: {
        mcpServers: [
          { productId: 'mcp-1', name: 'mock-filesystem', url: `http://127.0.0.1:${port}/mcp`, transportType: 'streamable-http', description: 'mock mcp' },
        ],
        authHeaders: { Authorization: 'Bearer mock-sub-key' },
      },
    })
  }

  // 已发布 skill
  if (method === 'GET' && path === '/cli-providers/market-skills') {
    return json(200, {
      code: 'SUCCESS',
      data: { items: [{ productId: 'skill-1', name: 'mock-skill', description: 'a mock skill', skillTags: ['demo'] }] },
    })
  }

  // skill 下载
  if (method === 'GET' && path === '/skills/skill-1/download') {
    res.writeHead(200, { 'content-type': 'application/zip' })
    return res.end(skillZip)
  }

  // MCP 端点（极简：响应 MCP initialize/tools/list，让官方 mcp-client 至少能完成握手）
  if (path === '/mcp') {
    // 读 body 判断是 initialize 还是 tools/list
    let body = ''
    for await (const chunk of req) body += chunk
    const msg = (() => { try { return JSON.parse(body) } catch { return {} } })()
    const methodName = msg.method ?? ''

    if (methodName === 'initialize') {
      return json(200, {
        jsonrpc: '2.0',
        id: msg.id ?? 0,
        result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1.0' } },
      })
    }
    if (methodName === 'notifications/initialized') {
      res.writeHead(202)
      return res.end()
    }
    if (methodName === 'tools/list') {
      return json(200, {
        jsonrpc: '2.0',
        id: msg.id ?? 0,
        result: {
          tools: [
            { name: 'mock_tool', description: 'a mock tool', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
          ],
        },
      })
    }
    if (methodName === 'tools/call') {
      return json(200, {
        jsonrpc: '2.0',
        id: msg.id ?? 0,
        result: { content: [{ type: 'text', text: 'mock result' }] },
      })
    }
    return json(200, { jsonrpc: '2.0', id: msg.id ?? 0, result: {} })
  }

  json(404, { code: 'NOT_FOUND', message: `no route ${method} ${path}` })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-himarket listening on http://127.0.0.1:${port}`)
  console.log(`skillZip=${zipPath}`)
})
