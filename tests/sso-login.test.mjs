/**
 * 一键登录单测（sso-login.ts + settings.ts 的 loginStateOf + domain.ts 的开关）。
 *
 * 覆盖设计文档 §8「测试要求」：
 *   · PKCE challenge 计算（RFC 7636 标准向量）
 *   · state 校验（CSRF：不匹配必须拒绝）
 *   · 端口顺延（45813 被占 → 45814）
 *   · 状态机迁移（NOT_LOGGED / LOGGED_IN / EXPIRED）
 *   · 调试开关优先级（env 与 settings 取或）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import tls from 'node:tls'

import { pkceChallenge, buildAuthUrl, idTokenClaim, SsoLoginManager, describeFetchError, ensureInternalCaTrusted } from '../lib/sso-login.js'
import { loginStateOf } from '../lib/settings.js'
import { allowPasswordLogin, resolveSsoIssuer, resolveSsoClientId, DEFAULT_SSO_ISSUER, DEFAULT_SSO_CLIENT_ID } from '../lib/domain.js'

// ---------- PKCE ----------

test('pkceChallenge：RFC 7636 附录 B 标准测试向量', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  assert.equal(pkceChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('pkceChallenge：base64url 无 padding、无 +/ 字符', () => {
  const c = pkceChallenge('a'.repeat(48))
  assert.ok(!c.includes('='), '不应含 padding')
  assert.ok(!c.includes('+') && !c.includes('/'), '不应含 + 或 /')
})

// ---------- 授权 URL ----------

test('buildAuthUrl：含 PKCE S256 且 redirect_uri 被正确编码', () => {
  const url = buildAuthUrl(
    { issuer: 'https://auth.ict.cmcc/realms/employees', clientId: 'matrix-twin-activation', baseUrl: 'http://market.ai.ict.cmcc' },
    'http://127.0.0.1:45813/callback',
    'STATE123',
    'CHALLENGE456',
  )
  assert.ok(url.startsWith('https://auth.ict.cmcc/realms/employees/protocol/openid-connect/auth?'), url)
  const q = new URL(url).searchParams
  assert.equal(q.get('client_id'), 'matrix-twin-activation')
  assert.equal(q.get('redirect_uri'), 'http://127.0.0.1:45813/callback')
  assert.equal(q.get('response_type'), 'code')
  assert.equal(q.get('code_challenge_method'), 'S256')
  assert.equal(q.get('code_challenge'), 'CHALLENGE456')
  assert.equal(q.get('state'), 'STATE123')
})

test('buildAuthUrl：issuer 尾斜杠不会产生双斜杠', () => {
  const url = buildAuthUrl(
    { issuer: 'https://auth.ict.cmcc/realms/employees/', clientId: 'c', baseUrl: 'http://x' },
    'http://127.0.0.1:45813/callback', 's', 'ch',
  )
  assert.ok(url.includes('/realms/employees/protocol/'), url)
  assert.ok(!url.includes('employees//'), url)
})

// ---------- id_token 解析 ----------

test('idTokenClaim：取出 preferred_username（不验签）', () => {
  const payload = Buffer.from(JSON.stringify({ preferred_username: 'niukunliang', sub: 'abc' })).toString('base64url')
  const jwt = `header.${payload}.signature`
  assert.equal(idTokenClaim(jwt, 'preferred_username'), 'niukunliang')
})

test('idTokenClaim：畸形 JWT 返回空串而非抛错', () => {
  assert.equal(idTokenClaim('not-a-jwt', 'preferred_username'), '')
  assert.equal(idTokenClaim('a.!!!.c', 'preferred_username'), '')
})

// ---------- 状态机 ----------

test('loginStateOf：有 token → LOGGED_IN（无论账密）', () => {
  assert.equal(loginStateOf({ token: 't', username: '', password: '' }, false), 'LOGGED_IN')
})

test('loginStateOf：无 token 有账密 → 兜底开关决定 LOGGED_IN / EXPIRED', () => {
  const s = { token: '', username: 'u', password: 'p' }
  assert.equal(loginStateOf(s, true), 'LOGGED_IN')
  assert.equal(loginStateOf(s, false), 'EXPIRED')
})

test('loginStateOf：全空 → NOT_LOGGED', () => {
  assert.equal(loginStateOf({ token: '', username: '', password: '' }, false), 'NOT_LOGGED')
  assert.equal(loginStateOf({ token: '   ', username: 'u', password: '' }, false), 'NOT_LOGGED')
})

// ---------- 调试开关与 SSO 参数解析 ----------

test('allowPasswordLogin：env 与 settings 取或', () => {
  const saved = process.env.DSH_HIMARKET_ALLOW_PASSWORD
  try {
    delete process.env.DSH_HIMARKET_ALLOW_PASSWORD
    assert.equal(allowPasswordLogin(false), false, '默认关闭')
    assert.equal(allowPasswordLogin(true), true, 'settings 打开即打开')
    process.env.DSH_HIMARKET_ALLOW_PASSWORD = '1'
    assert.equal(allowPasswordLogin(false), true, 'env=1 覆盖 settings 关闭')
    process.env.DSH_HIMARKET_ALLOW_PASSWORD = 'true'
    assert.equal(allowPasswordLogin(false), true, 'env=true 也认')
    process.env.DSH_HIMARKET_ALLOW_PASSWORD = '0'
    assert.equal(allowPasswordLogin(false), false, 'env=0 不打开')
  } finally {
    if (saved === undefined) delete process.env.DSH_HIMARKET_ALLOW_PASSWORD
    else process.env.DSH_HIMARKET_ALLOW_PASSWORD = saved
  }
})

test('resolveSsoIssuer/ClientId：settings 显式值优先，否则内置默认', () => {
  assert.equal(resolveSsoIssuer(''), DEFAULT_SSO_ISSUER)
  assert.equal(resolveSsoIssuer('https://x/realms/y/'), 'https://x/realms/y')
  assert.equal(resolveSsoClientId(''), DEFAULT_SSO_CLIENT_ID)
  assert.equal(resolveSsoClientId('my-client'), 'my-client')
})

// ---------- 会话管理：state 校验与端口顺延 ----------

/** 起一个占位 server 抢占端口，验证顺延逻辑。 */
function occupyPort(port) {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(port, '127.0.0.1', () => resolve(s))
  })
}

test('SsoLoginManager：45813 被占用时顺延到 45814', async () => {
  const squatter = await occupyPort(45813)
  const mgr = new SsoLoginManager()
  try {
    const started = await mgr.start({ issuer: 'https://auth.ict.cmcc/realms/employees', clientId: 'c', baseUrl: 'http://x' })
    assert.ok(started.authUrl.includes('127.0.0.1%3A45814') || started.authUrl.includes('45814'), started.authUrl)
    mgr.dispose()
  } finally {
    squatter.close()
  }
})

test('SsoLoginManager：state 不匹配必须拒绝（CSRF 防护）', async () => {
  const mgr = new SsoLoginManager()
  try {
    const started = await mgr.start({ issuer: 'https://auth.ict.cmcc/realms/employees', clientId: 'c', baseUrl: 'http://x' })
    const port = new URL(started.authUrl).searchParams.get('redirect_uri').match(/:(\d+)\//)[1]
    // 用错误 state 回调
    await fetch(`http://127.0.0.1:${port}/callback?code=FAKE&state=WRONG_STATE`).then((r) => r.text())
    const st = mgr.status(started.loginId)
    assert.equal(st.status, 'failed')
    assert.ok(st.error.includes('state'), st.error)
  } finally {
    mgr.dispose()
  }
})

test('SsoLoginManager：未知 loginId 视为失败（会话已回收）', () => {
  const mgr = new SsoLoginManager()
  const st = mgr.status('no-such-id')
  assert.equal(st.status, 'failed')
  mgr.dispose()
})

test('SsoLoginManager：cancel 后状态为 failed，且 dispose 可重复调用', async () => {
  const mgr = new SsoLoginManager()
  const started = await mgr.start({ issuer: 'https://auth.ict.cmcc/realms/employees', clientId: 'c', baseUrl: 'http://x' })
  mgr.cancel(started.loginId)
  assert.equal(mgr.status(started.loginId).status, 'failed')
  mgr.dispose()
  mgr.dispose() // 幂等
})

test('SsoLoginManager：takeToken 对未成功会话返回空串（token 不外泄）', async () => {
  const mgr = new SsoLoginManager()
  try {
    const started = await mgr.start({ issuer: 'https://auth.ict.cmcc/realms/employees', clientId: 'c', baseUrl: 'http://x' })
    assert.equal(mgr.takeToken(started.loginId), '', 'pending 状态不应给出 token')
  } finally {
    mgr.dispose()
  }
})

// ── describeFetchError：把 undici 的笼统 `fetch failed` 展开成可排障原因 ──
// 实测踩过：baseUrl 指向已废弃域名（NXDOMAIN），界面只有一句「fetch failed」，
// 用户完全无法判断是地址写错还是服务没起。故此处必须展开 error.cause。

test('describeFetchError：展开 ENOTFOUND 并给出「域名解析失败」提示', () => {
  const err = new TypeError('fetch failed')
  err.cause = Object.assign(new Error('getaddrinfo ENOTFOUND ai-market.ict.cmcc'), { code: 'ENOTFOUND' })
  const msg = describeFetchError(err, 'http://ai-market.ict.cmcc/api/v1/x')
  assert.match(msg, /ENOTFOUND/u, '必须包含真实错误码')
  assert.match(msg, /ai-market\.ict\.cmcc/u, '必须包含目标地址')
  assert.match(msg, /域名解析失败/u, '必须给出可操作提示')
})

test('describeFetchError：区分 ECONNREFUSED / TLS / 超时', () => {
  const mk = (code, message) => {
    const e = new TypeError('fetch failed')
    e.cause = Object.assign(new Error(message), { code })
    return e
  }
  assert.match(describeFetchError(mk('ECONNREFUSED', 'connect ECONNREFUSED'), 'http://x'), /连接被拒绝/u)
  assert.match(describeFetchError(mk('CERT_HAS_EXPIRED', 'certificate has expired'), 'https://x'), /证书/u)
  assert.match(describeFetchError(mk('UND_ERR_CONNECT_TIMEOUT', 'connect timeout'), 'http://x'), /超时/u)
})

test('describeFetchError：无 cause 时也不崩，回退原始信息', () => {
  const msg = describeFetchError(new Error('boom'), 'http://x')
  assert.match(msg, /boom/u)
  assert.match(msg, /http:\/\/x/u)
})

// ---------- 内网自签 CA 信任（防复发：2026-09-21 线上故障） ----------

/**
 * 事故：`auth.ict.cmcc` 证书链根为企业自签（issuer = ICT Internal AI Root CA），
 * 不在 Node 内置 CA 库 → TLS 失败 → undici 只报 `fetch failed`，界面无从排障。
 *
 * 依赖环境变量 `NODE_USE_SYSTEM_CA=1` 不可靠（pm2 / 计划任务 / 父进程环境各异），
 * 故改为插件代码级注入系统 CA。这组测试锁住该行为，防止被误删。
 */
test('ensureInternalCaTrusted：返回布尔且可重复调用（幂等，不抛错）', () => {
  const first = ensureInternalCaTrusted()
  assert.equal(typeof first, 'boolean', '必须返回布尔值')
  // 幂等：再次调用结果一致，且不得抛错
  assert.equal(ensureInternalCaTrusted(), first, '重复调用结果应一致')
})

test('ensureInternalCaTrusted：注入后全局信任链包含系统 CA（含企业自签根）', () => {
  const applied = ensureInternalCaTrusted()
  if (!applied) {
    // Node 版本不支持 tls.getCACertificates/setDefaultCACertificates —— 降级不算失败，
    // 但必须确认当前 Node 支持（本项目要求 Node 24+）。
    assert.fail('当前 Node 不支持系统 CA API，插件将无法在内网环境完成登录')
  }
  const trusted = tls.getCACertificates('default')
  assert.ok(Array.isArray(trusted) && trusted.length > 0, '默认信任链不应为空')
  const system = tls.getCACertificates('system')
  assert.ok(system.length > 0, '系统 CA 库应可读取（否则内网自签根无法被信任）')
})
