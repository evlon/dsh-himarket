/**
 * 单元测试：核心纯逻辑（serverName 清洗、client 字段映射、skill 解压/落盘）。
 * 跑法：node --test tests/core.test.mjs（依赖已编译的 lib/）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { sanitizeServerName } from '../lib/mcp.js'
import { installSkill, defaultSkillRoot } from '../lib/skill.js'
import { HimarketClient } from '../lib/himarket-client.js'

test('sanitizeServerName 清洗非法字符并压缩下划线', () => {
  assert.equal(sanitizeServerName('My MCP Server!!'), 'My_MCP_Server')
  assert.equal(sanitizeServerName('  hello-world  '), 'hello-world')
  assert.equal(sanitizeServerName('!!!'), 'mcp')
  assert.equal(sanitizeServerName('a'.repeat(100)).length, 32)
})

test('HimarketClient 解析统一包装与 market-mcps 字段', async () => {
  const responses = {
    '/api/v1/developers/login': {
      status: 200,
      body: { code: 'SUCCESS', data: { access_token: 'tok-1', token_type: 'Bearer', expires_in: 604800 } },
    },
    '/api/v1/cli-providers/market-mcps': {
      status: 200,
      body: {
        code: 'SUCCESS',
        data: {
          mcpServers: [
            { productId: 'p1', name: 'github', url: 'http://x/mcp', transportType: 'streamable-http', description: 'd' },
            { productId: 'p2', name: '', url: 'http://x', transportType: 'sse' }, // 无 name 应被过滤
          ],
          authHeaders: { Authorization: 'Bearer abc' },
        },
      },
    },
    '/api/v1/cli-providers/market-skills': {
      status: 200,
      body: {
        code: 'SUCCESS',
        data: { items: [{ productId: 's1', name: 'my-skill', description: 'd', skillTags: ['a', 1] }] },
      },
    },
  }

  const fetchFn = async (url) => {
    const path = url.replace('http://x', '')
    const r = responses[path]
    if (!r) return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
    return {
      ok: r.status < 400,
      status: r.status,
      text: async () => JSON.stringify(r.body),
      json: async () => r.body,
      arrayBuffer: async () => new Uint8Array(0).buffer,
    }
  }

  const c = new HimarketClient({ baseUrl: 'http://x', username: 'u', password: 'p', fetchFn })

  await c.login()
  assert.equal(c.currentToken, 'tok-1')

  const { mcpServers, authHeaders } = await c.listSubscribedMcps()
  assert.equal(mcpServers.length, 1)
  assert.equal(mcpServers[0].name, 'github')
  assert.equal(authHeaders.Authorization, 'Bearer abc')

  const skills = await c.listPublishedSkills()
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'my-skill')
  assert.deepEqual(skills[0].skillTags, ['a']) // 非字符串 tag 被过滤
})

test('installSkill 解压 ZIP 并落盘（含 SKILL.md frontmatter name）', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-himarket-test-'))
  const pkgDir = join(tmp, 'pkg')
  await mkdir(pkgDir, { recursive: true })
  await writeFile(join(pkgDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: a demo\n---\n\n# body\n')
  await writeFile(join(pkgDir, 'helper.txt'), 'asset\n')

  const zipPath = join(tmp, 'pkg.zip')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  await promisify(execFile)('tar', ['-cf', zipPath, '-C', tmp, 'pkg'], { windowsHide: true })

  const installRoot = join(tmp, 'skills')
  const fetchFn = async () => {
    const bytes = await readFile(zipPath)
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({}),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  }

  const c = new HimarketClient({ baseUrl: 'http://x', username: 'u', password: 'p', fetchFn })
  const result = await installSkill(c, 'prod-123', installRoot)

  assert.equal(result.ok, true)
  assert.equal(result.name, 'demo-skill') // frontmatter name 优先
  const installed = await readFile(join(result.dir, 'SKILL.md'), 'utf8')
  assert.match(installed, /name: demo-skill/)
  const files = await readdir(result.dir)
  assert.ok(files.includes('helper.txt'))
})

test('installSkill 拒绝无 SKILL.md 的包', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-himarket-bad-'))
  const pkgDir = join(tmp, 'pkg')
  await mkdir(pkgDir, { recursive: true })
  await writeFile(join(pkgDir, 'not-a-skill.txt'), 'x')

  const zipPath = join(tmp, 'bad.zip')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  await promisify(execFile)('tar', ['-cf', zipPath, '-C', tmp, 'pkg'], { windowsHide: true })

  const fetchFn = async () => {
    const bytes = await readFile(zipPath)
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({}),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  }

  const c = new HimarketClient({ baseUrl: 'http://x', username: 'u', password: 'p', fetchFn })
  await assert.rejects(
    () => installSkill(c, 'prod-bad', join(tmp, 'skills')),
    /未找到 SKILL\.md/,
  )
})

test('defaultSkillRoot 尊重 DSH_HOME', () => {
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = 'C:/custom/dsh'
  assert.equal(defaultSkillRoot(), join('C:/custom/dsh', 'skills'))
  if (saved === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = saved
})
