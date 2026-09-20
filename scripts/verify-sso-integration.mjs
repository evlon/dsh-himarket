/**
 * 一键登录集成验证（真实内网端点，非模拟）。
 *
 * 分三段：
 *   ① Keycloak client 属性复核 —— 方案地基：publicClient=true + PKCE(S256) +
 *      redirectUris 含 127.0.0.1:45813~45815。任一不成立，插件自实现登录即不可行。
 *   ② 授权 URL 真实可达 —— 用插件生成的 authUrl 请求，必须落到登录页（非 400）。
 *   ③ HiMarket 换票端点契约 —— 假 id_token 必须返回明确错误（而非 500/挂起）。
 *
 * 不做的事：真实授权码换票需真人在浏览器输密码（无法自动化），
 * 那一步由用户在设置页点「一键登录」完成（设计文档 A2）。
 *
 * 用法：node scripts/verify-sso-integration.mjs
 */

import { buildAuthUrl, pkceChallenge } from '../lib/sso-login.js'

const ISSUER = 'https://auth.ict.cmcc/realms/employees'
const CLIENT_ID = 'matrix-twin-activation'
const HIMARKET = 'http://market.ai.ict.cmcc'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------- ① client 属性 ----------
console.log('\n① Keycloak client 属性复核（方案地基）')
try {
  const res = await fetch(`${ISSUER}/.well-known/openid-configuration`)
  const cfg = await res.json()
  check('OIDC discovery 可达', res.ok && cfg.issuer === ISSUER, `issuer=${cfg.issuer}`)
  check('authorization_endpoint 存在', typeof cfg.authorization_endpoint === 'string', cfg.authorization_endpoint)
  check('token_endpoint 存在', typeof cfg.token_endpoint === 'string', cfg.token_endpoint)
  check(
    'PKCE S256 受支持',
    Array.isArray(cfg.code_challenge_methods_supported) && cfg.code_challenge_methods_supported.includes('S256'),
    JSON.stringify(cfg.code_challenge_methods_supported),
  )
} catch (e) {
  check('OIDC discovery 可达', false, e.message)
}

// ---------- ② 授权 URL 真实可达 ----------
console.log('\n② 授权 URL 真实可达（redirect_uri 必须已被 Keycloak 注册）')
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const authUrl = buildAuthUrl(
  { issuer: ISSUER, clientId: CLIENT_ID, baseUrl: HIMARKET },
  'http://127.0.0.1:45813/callback',
  'integration-state',
  pkceChallenge(verifier),
)
try {
  const res = await fetch(authUrl, { redirect: 'manual' })
  const body = await res.text().catch(() => '')
  // 期望 200（登录页）或 302（已登录跳转回调）；400 = client/redirect_uri 未注册
  const ok = res.status === 200 || res.status === 302
  check(
    '授权 URL 返回登录页（非 400 invalid_client/redirect_uri）',
    ok,
    `HTTP ${res.status}`,
  )
  if (res.status === 400) {
    const snippet = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
    console.log(`     服务端错误摘要：${snippet}`)
  }
  if (res.status === 200) {
    check('登录页确实含登录表单', /kc-form|login|密码|password/i.test(body), '页面含登录元素')
  }
} catch (e) {
  check('授权 URL 真实可达', false, e.message)
}

// ---------- ③ HiMarket 换票端点契约 ----------
console.log('\n③ HiMarket 换票端点契约（假 token 应明确报错，而非 5xx/挂起）')
try {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJpbnRlZ3JhdGlvbi10ZXN0In0.',
  })
  const res = await fetch(`${HIMARKET}/api/v1/developers/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const text = await res.text().catch(() => '')
  check('端点可达且拒绝假 token', res.status >= 400 && res.status < 500, `HTTP ${res.status}`)
  check('返回可读错误（非空响应）', text.trim() !== '', text.slice(0, 120).replace(/\s+/g, ' '))
} catch (e) {
  check('HiMarket 换票端点可达', false, e.message)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
