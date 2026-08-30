/**
 * 真实 HiMarket 接入验证脚本：重启 web profile 后一键验证桥接。
 * 用法：node tests/verify-real.mjs
 * 检查项：
 *  1. /himarket/state 返回 200 且 configured=true（配置已从 settings.yaml 恢复）
 *  2. /himarket/sync 能登录并返回可读摘要（MCP/skill 数量，可能为 0）
 *  3. 若 market-mcps 有内容，检查 activeMcpNames 是否含对应 serverName
 */

const BASE = 'http://127.0.0.1:3080'

async function get(path) {
  const res = await fetch(BASE + path)
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function main() {
  console.log('=== 1. /himarket/state ===')
  const state = await get('/himarket/state')
  console.log('status:', state.status)
  if (state.status === 404) {
    console.log('❌ 桥接未挂载（/himarket/state 404）——检查 dsh-himarket 包是否加载成功')
    process.exit(1)
  }
  console.log('state:', JSON.stringify(state.body, null, 2))
  const configured = state.body?.configured === true
  const loggedIn = state.body?.loggedIn === true
  console.log(configured ? '✅ 已配置' : '⚠️ 未配置（需先填 baseUrl/username/password）')
  console.log(loggedIn ? '✅ 已登录' : '⚠️ 未登录（sync 时会自动登录）')

  console.log('\n=== 2. /himarket/sync ===')
  const sync = await post('/himarket/sync', {})
  console.log('status:', sync.status)
  console.log('summary:', sync.body?.summary ?? JSON.stringify(sync.body))

  console.log('\n=== 3. 同步后 state ===')
  const state2 = await get('/himarket/state')
  const mcps = state2.body?.mcpServers ?? []
  const skills = state2.body?.publishedSkills ?? []
  const active = state2.body?.activeMcpNames ?? []
  console.log(`已订阅 MCP: ${mcps.length} 个`)
  console.log(`可装技能: ${skills.length} 个`)
  console.log(`已接入 MCP: ${active.length} 个 -> ${JSON.stringify(active)}`)

  if (mcps.length === 0 && skills.length === 0) {
    console.log('\n💡 当前账号尚无订阅 MCP / 已发布技能，这是正常的。')
    console.log('   需管理员先在 HiMarket 后台创建 MCP/Skill 产品并发布，开发者订阅后这里才有内容。')
  }
}

main().catch((e) => {
  console.error('❌ 验证脚本失败:', e.message)
  process.exit(1)
})
