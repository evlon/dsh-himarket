/**
 * A8 验收：dsh-himarket 在「只有 token、没有用户名/密码」时可用。
 *
 * 用**真实** HiMarket token（由 himarket-sso-verify.sh 的换票链路产出）驱动
 * 编译产物 lib/himarket-client.js，证明：
 *   ① 只给 token（username/password 为空）能成功拉取订阅 MCP 与已发布技能；
 *   ② 该 token 被 401 时，客户端会尝试 login() —— 但 SSO 模式无账密，必须给出
 *      可读错误而非崩溃（验证我们的 ensureReady 分支语义）。
 *
 * 跑法（token 由外部注入，不落仓库）：
 *   HIMARKET_BASE=http://market.ai.ict.cmcc HIMARKET_TOKEN=<jwt> node tests/sso-token-only.mjs
 */

import assert from 'node:assert/strict'
import { HimarketClient } from '../lib/himarket-client.js'
import { hasCredentials, credentialsFingerprint } from '../lib/settings.js'

const BASE = process.env.HIMARKET_BASE ?? ''
const TOKEN = process.env.HIMARKET_TOKEN ?? ''

if (BASE === '' || TOKEN === '') {
  console.error('需要 HIMARKET_BASE 与 HIMARKET_TOKEN 环境变量')
  process.exit(2)
}

// ---------- ① 纯函数层：token-only 判定 ----------
const ssoOnly = { baseUrl: BASE, username: '', password: '', token: TOKEN }
assert.equal(hasCredentials(ssoOnly), true, 'token-only 必须判定为已配置')
console.log('✅ ① hasCredentials：仅 token（无账密）→ 已配置')

// ---------- ② 真实调用：token-only 拉订阅 MCP ----------
const client = new HimarketClient({ baseUrl: BASE, username: '', password: '', token: TOKEN })
assert.equal(client.hasToken, true, 'client 应持有 token')

const { mcpServers, authHeaders } = await client.listSubscribedMcps()
assert.ok(Array.isArray(mcpServers), 'mcpServers 应为数组')
console.log(`✅ ② token-only 拉取订阅 MCP 成功（${mcpServers.length} 个）`)
if (authHeaders.Authorization) {
  const masked = authHeaders.Authorization.replace(/(apikey-|Bearer ).{6}/, '$1******')
  console.log(`   认证头: ${masked}`)
}

// ---------- ③ 真实调用：token-only 拉已发布技能 ----------
const skills = await client.listPublishedSkills()
assert.ok(Array.isArray(skills), 'skills 应为数组')
console.log(`✅ ③ token-only 拉取已发布技能成功（${skills.length} 个）`)

// ---------- ④ 指纹变化 → 缓存必须失效（启动器换 token 场景）----------
const fp1 = credentialsFingerprint(ssoOnly)
const fp2 = credentialsFingerprint({ ...ssoOnly, token: TOKEN + 'x' })
assert.notEqual(fp1, fp2, 'token 变化必须改变指纹')
console.log('✅ ④ 指纹：token 变化 → 触发 client 缓存失效')

// ---------- ⑤ 坏 token：必须给出可读错误，不能静默成功 ----------
const bad = new HimarketClient({ baseUrl: BASE, username: '', password: '', token: 'invalid-token' })
let threw = false
try {
  await bad.listSubscribedMcps()
} catch (err) {
  threw = true
  console.log(`✅ ⑤ 坏 token 抛出可读错误: ${String(err.message).slice(0, 90)}`)
}
assert.equal(threw, true, '坏 token 必须抛错（不能静默成功）')

console.log('\n✅ A8 通过：dsh-himarket 支持 token-only')
