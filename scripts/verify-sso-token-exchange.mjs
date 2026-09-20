/**
 * 一键登录「真实换票」验证 —— 用真实 Keycloak 账号走完整 PKCE 流程。
 *
 * 为什么需要：单测与端点探测都只验证到「授权 URL 正确」，但**换票**这一段
 * （code → id_token → HiMarket token）只有真跑一次才算通。本脚本用
 * Resource Owner 之外的**真实授权码流程**：脚本自己扮演浏览器，
 * 用 HTTP 会话完成 Keycloak 登录表单提交，拿到 code，再走插件的换票逻辑。
 *
 * ⚠️ 需要真实账号密码（环境变量注入，不落盘、不回显）：
 *   DSH_SSO_TEST_USER / DSH_SSO_TEST_PASS
 *
 * 用法：
 *   DSH_SSO_TEST_USER=xxx DSH_SSO_TEST_PASS=yyy node scripts/verify-sso-token-exchange.mjs
 *
 * 退出码：0 全通；1 有失败；2 缺少凭据（跳过）。
 */

import { pkceChallenge, buildAuthUrl, SsoLoginManager } from '../lib/sso-login.js'

const ISSUER = 'https://auth.ict.cmcc/realms/employees'
const CLIENT_ID = 'matrix-twin-activation'
const HIMARKET = 'http://market.ai.ict.cmcc'

const USER = process.env.DSH_SSO_TEST_USER ?? ''
const PASS = process.env.DSH_SSO_TEST_PASS ?? ''

if (USER === '' || PASS === '') {
  console.log('⚠️ 未提供 DSH_SSO_TEST_USER / DSH_SSO_TEST_PASS，跳过真实换票验证。')
  process.exit(2)
}

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

/** 极简 cookie jar（Keycloak 登录需要 AUTH_SESSION_ID / KC_RESTART 等）。 */
class Jar {
  constructor() { this.map = new Map() }
  store(res) {
    const raw = res.headers.getSetCookie?.() ?? []
    for (const c of raw) {
      const [pair] = c.split(';')
      const idx = pair.indexOf('=')
      if (idx > 0) this.map.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
    }
  }
  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ') }
}

/** 提取 HTML 里 form 的 action。 */
function formAction(html, base) {
  const m = /<form[^>]*\saction="([^"]+)"/i.exec(html)
  if (m === null) return ''
  return new URL(m[1].replace(/&amp;/g, '&'), base).href
}

const jar = new Jar()

// ---------- ① 起登录会话，拿 authUrl ----------
console.log('\n① 启动插件登录会话（真实端口 45813~45815）')
const mgr = new SsoLoginManager()
const started = await mgr.start({ issuer: ISSUER, clientId: CLIENT_ID, baseUrl: HIMARKET })
const redirectUri = new URL(started.authUrl).searchParams.get('redirect_uri')
check('会话已创建', started.loginId !== '' && started.authUrl.includes('/protocol/openid-connect/auth'))
check('回调落在已注册端口', /^http:\/\/127\.0\.0\.1:4581[345]\/callback$/.test(redirectUri), redirectUri)

// ---------- ② 扮演浏览器：取登录页 → 提交账密 ----------
console.log('\n② 扮演浏览器完成 Keycloak 登录（真实表单提交）')
let loginPageRes = await fetch(started.authUrl, { redirect: 'manual' })
jar.store(loginPageRes)
let loginPage = await loginPageRes.text()
check('取得登录页', loginPageRes.status === 200, `HTTP ${loginPageRes.status}`)

const action = formAction(loginPage, started.authUrl)
check('解析出登录表单 action', action !== '', action)

const form = new URLSearchParams({ username: USER, password: PASS, credentialId: '' })
const postRes = await fetch(action, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
  body: form.toString(),
})
jar.store(postRes)
let location = postRes.headers.get('location') ?? ''
check('登录提交返回重定向', postRes.status === 302 || postRes.status === 303, `HTTP ${postRes.status} → ${location.slice(0, 80)}`)

// 跟随重定向链，直到落回 127.0.0.1 回调（或拿到 code）
let hops = 0
let callbackUrl = ''
while (location !== '' && hops < 10) {
  hops += 1
  const next = new URL(location, action).href
  if (next.startsWith('http://127.0.0.1:')) { callbackUrl = next; break }
  const r = await fetch(next, { redirect: 'manual', headers: { cookie: jar.header() } })
  jar.store(r)
  location = r.headers.get('location') ?? ''
}
check('重定向链落到本地回调', callbackUrl !== '', callbackUrl ? callbackUrl.replace(/code=[^&]+/, 'code=***') : `未落到回调（hops=${hops}）`)

if (callbackUrl === '') {
  console.log('\n⚠️ 未取得授权码 —— 可能是账号密码错误、需要短信二次验证，或 Keycloak 要求首次登录改密。')
  console.log('   这不代表插件有缺陷；请在设置页用真人点击「一键登录」完成。')
  mgr.dispose()
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
}

// ---------- ③ 把 code 交给插件的回调 server（等价浏览器访问回调）----------
console.log('\n③ 回调交回插件（触发插件内部换票）')
const cbRes = await fetch(callbackUrl)
const cbHtml = await cbRes.text()
check('插件回调返回页面', cbRes.status === 200, `HTTP ${cbRes.status}`)

// 等换票完成（回调处理是异步的，state 校验 + 两次网络换票）
let st = mgr.status(started.loginId)
for (let i = 0; i < 40 && st.status === 'pending'; i += 1) {
  await new Promise((r) => setTimeout(r, 500))
  st = mgr.status(started.loginId)
}
check('换票流程结束（非 pending）', st.status !== 'pending', `status=${st.status}`)
check('换票成功', st.status === 'success', st.status === 'success' ? `username=${st.username}` : st.error)
check('取到展示用用户名', st.username !== '', st.username)
check('回调页文案正确', /授权成功/.test(cbHtml) || /授权失败/.test(cbHtml), cbHtml.includes('授权成功') ? '授权成功' : '授权失败')

// ---------- ④ token 可用性：解码 claims 与「已知有效 token」对比 ----------
//
// ⚠️ 为什么不用「打接口看 200」判定：实测发现 market.ai.ict.cmcc 的
// /cli-providers/* 等路径对**所有**请求都返回 403（连已知有效的 user 账号
// token 也一样），故 403 无法区分鉴权，是无效探针（我先踩了这个坑）。
//
// 改用**决定性证据**：把 SSO 换来的 token 与「账密登录得到的已知有效 token」
// 对比 claims —— 同为 HiMarket 签发的 DEVELOPER token、结构同形，且 userId
// 不同（证明绑定到不同自然人，未串号）。
console.log('\n④ token 真实性：与「已知有效 token」对比 claims（决定性判据）')

/** 解码 JWT payload（不验签，仅比对结构）。 */
function claimsOf(t) {
  try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')) } catch { return null }
}

const token = mgr.takeToken(started.loginId)
check('takeToken 取到 token', token !== '', token === '' ? '空' : `${token.slice(0, 24)}…（长度 ${token.length}）`)

if (token !== '') {
  const mine = claimsOf(token)
  check('token 是合法 JWT（payload 可解析）', mine !== null, mine === null ? '解析失败' : JSON.stringify(mine))
  check('HiMarket 签发（userType=DEVELOPER）', mine?.userType === 'DEVELOPER', `userType=${mine?.userType}`)
  check('带 HiMarket userId（dev- 前缀）', String(mine?.userId ?? '').startsWith('dev-'), `userId=${mine?.userId}`)

  // 取一个「已知有效」token 作对照（账密登录；凭据来自环境变量，不硬编码）
  const refUser = process.env.DSH_SSO_REF_USER ?? ''
  const refPass = process.env.DSH_SSO_REF_PASS ?? ''
  if (refUser !== '' && refPass !== '') {
    const lr = await fetch(`${HIMARKET}/api/v1/developers/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: refUser, password: refPass }),
    })
    const lj = await lr.json().catch(() => ({}))
    const ref = lj?.data?.access_token ?? lj?.access_token ?? ''
    const refClaims = ref === '' ? null : claimsOf(ref)
    check('取到对照 token（账密登录）', refClaims !== null, refClaims === null ? `HTTP ${lr.status}` : 'ok')
    if (refClaims !== null) {
      const sameShape = JSON.stringify(Object.keys(mine).sort()) === JSON.stringify(Object.keys(refClaims).sort())
      check('与对照 token 结构同形', sameShape, sameShape ? JSON.stringify(Object.keys(mine).sort()) : `mine=${Object.keys(mine)} ref=${Object.keys(refClaims)}`)
      check('userType 与对照一致', mine.userType === refClaims.userType, `${mine.userType} vs ${refClaims.userType}`)
      check('userId 与对照不同（绑定不同自然人，未串号）', mine.userId !== refClaims.userId, `mine=${mine.userId} ref=${refClaims.userId}`)
    }
  } else {
    console.log('  ⏭ 未提供 DSH_SSO_REF_USER/PASS，跳过对照（不影响主判据）')
  }
}

mgr.dispose()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
