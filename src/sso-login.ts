/**
 * HiMarket 一键登录（Keycloak SSO 授权码 + PKCE）—— host 半自包含实现。
 *
 * 为什么由插件自己实现（而不是调 launcher）：
 *   Keycloak client `matrix-twin-activation` 是 **public client**（publicClient=true）
 *   且启用 PKCE(S256)，换 authorization_code **不需要 client_secret**。因此任何能
 *   在 127.0.0.1 起本地回调的进程都能独立完成登录 —— 插件 host 半（Node）即可，
 *   无需 launcher 发版（设计文档 G5 / D1）。
 *
 * 流程（与 launcher `activation.rs` 的 `run_himarket_login` 同构；两边写同一个
 * settings.yaml 的 `himarket.token`，故天然一致）：
 *   ① 起本地回调 http://127.0.0.1:45813/callback（占用则顺延 45814/45815）
 *   ② 生成 state(32B) + verifier(48B)，challenge = base64url(sha256(verifier))
 *   ③ 返回 authUrl → Client 半 window.open（**必须由点击同步触发**，防弹窗拦截）
 *   ④ 等回调（120s 超时）→ 校验 state → code 换 id_token
 *   ⑤ id_token 换 HiMarket developer token（jwt-bearer）
 *   ⑥ username 取自 id_token 的 preferred_username（**不验签**，仅展示用）
 *
 * 安全边界：绑定 127.0.0.1（外部不可达）；state 必须比对（CSRF）；verifier 用后
 * 即弃；一键登录路径**不落盘任何密码**；token 只写 settings.yaml，不回传浏览器。
 *
 * @module dsh-himarket/sso-login
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

/**
 * 回调端口基数。Keycloak 的 `matrix-twin-activation` 已注册
 * `http://127.0.0.1:45813|45814|45815/callback`（精确匹配），故只能在这三个端口内顺延。
 */
export const CALLBACK_BASE_PORT = 45813

/** 可用回调端口个数（45813~45815）。 */
export const CALLBACK_PORT_RANGE = 3

/** 等待浏览器授权的超时（毫秒）。 */
export const LOGIN_TIMEOUT_MS = 120_000

/** 已完成会话在内存中的保留时长（供前端轮询取结果后自然淘汰）。 */
const SESSION_TTL_MS = 5 * 60_000

/** SSO 登录所需参数（由调用方从 settings + 内置默认组装）。 */
export interface SsoConfig {
  /** Keycloak issuer，如 https://auth.ict.cmcc/realms/employees（无尾斜杠）。 */
  issuer: string
  /** Keycloak client id，如 matrix-twin-activation。 */
  clientId: string
  /** HiMarket 门户地址，如 http://market.ai.ict.cmcc（无尾斜杠）。 */
  baseUrl: string
}

/** 登录会话状态。 */
export type LoginStatus = 'pending' | 'success' | 'failed'

/** 启动一次登录的返回值。 */
export interface LoginStartResult {
  loginId: string
  /** 交给浏览器打开的授权 URL。 */
  authUrl: string
}

/** 查询登录结果的返回值（**不含 token** —— token 只落 settings.yaml）。 */
export interface LoginStatusResult {
  status: LoginStatus
  username: string
  error: string
}

/** 一次登录会话的内部状态。 */
interface Session {
  loginId: string
  state: string
  verifier: string
  redirectUri: string
  server: Server | undefined
  timer: NodeJS.Timeout | undefined
  status: LoginStatus
  username: string
  /** 换到的 HiMarket developer token；**只在此处与 settings.yaml**，不回传浏览器。 */
  token: string
  error: string
  finishedAt: number
}

/** base64url 编码（PKCE 与 state 用；去 padding）。 */
export function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

/**
 * PKCE challenge = base64url(sha256(verifier))，即 S256。
 * RFC 7636 附录 B 测试向量：verifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk`
 * → challenge `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`（单测覆盖）。
 */
export function pkceChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest())
}

/**
 * 构造 Keycloak 授权 URL。
 * 参数用 URLSearchParams 编码（`redirect_uri` 的 `://` 会正确转义）。
 */
export function buildAuthUrl(cfg: SsoConfig, redirectUri: string, state: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return `${cfg.issuer.trim().replace(/\/+$/u, '')}/protocol/openid-connect/auth?${params.toString()}`
}

/**
 * 从 JWT（id_token）中取一个字符串 claim —— **不验签**。
 *
 * 安全说明：这里只用于取 `preferred_username` 做界面展示；授权判定由服务端完成
 * （HiMarket 用 JWKS 验签 + sub 绑定身份），故不验签是安全的。
 */
export function idTokenClaim(jwt: string, name: string): string {
  const payload = jwt.split('.')[1]
  if (payload === undefined || payload === '') return ''
  try {
    const json = asRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
    return str(json[name])
  } catch {
    return ''
  }
}

/** 收窄为普通对象（外部输入一律先过这里，避免 any 扩散）。 */
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}

/** 取字符串字段（非字符串一律空串）。 */
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** HTML 转义（错误信息可能含服务端返回内容，防注入）。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

/** 回调页（浏览器可见）——授权完成后用户关闭此页回到 DSH 设置页。 */
function renderPage(title: string, body: string): string {
  const css = [
    'body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;min-height:100vh;',
    'align-items:center;justify-content:center;margin:0;background:#f5f6f8;color:#1f2329}',
    '.card{background:#fff;border-radius:12px;padding:32px 40px;box-shadow:0 4px 20px rgba(0,0,0,.08);',
    'text-align:center;max-width:440px}h3{margin:0 0 8px;font-size:18px}',
    'p{margin:0;color:#646a73;font-size:14px;line-height:22px;word-break:break-all}',
  ].join('')
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + `<title>${escapeHtml(title)}</title><style>${css}</style></head>`
    + `<body><div class="card"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p></div></body></html>`
}

/**
 * 一键登录会话管理器：每个 loginId 一个独立的回调 server + 定时器，
 * 支持并发点击互不覆盖，且可精确取消与回收。
 */
export class SsoLoginManager {
  private readonly sessions = new Map<string, Session>()

  /**
   * 启动一次登录：起回调服务 + 生成 PKCE + 返回 authUrl。
   * 调用方拿到 authUrl 后必须**由用户点击同步触发** window.open（防弹窗拦截）。
   */
  async start(cfg: SsoConfig): Promise<LoginStartResult> {
    this.prune()
    const loginId = randomUUID()
    const state = base64Url(randomBytes(32))
    const verifier = base64Url(randomBytes(48))
    const challenge = pkceChallenge(verifier)

    const { server, port } = await listenOnFreePort()
    const redirectUri = `http://127.0.0.1:${port}/callback`
    const session: Session = {
      loginId,
      state,
      verifier,
      redirectUri,
      server,
      timer: undefined,
      status: 'pending',
      username: '',
      token: '',
      error: '',
      finishedAt: 0,
    }
    this.sessions.set(loginId, session)

    server.on('request', (req, res) => {
      void this.handleCallback(session, cfg, req, res)
    })
    session.timer = setTimeout(() => {
      this.fail(session, `等待授权超时（${Math.round(LOGIN_TIMEOUT_MS / 1000)}s），请重试`)
    }, LOGIN_TIMEOUT_MS)

    return { loginId, authUrl: buildAuthUrl(cfg, redirectUri, state, challenge) }
  }

  /** 查询登录结果（前端轮询用）。未知 loginId 视为失败（会话已回收）。 */
  status(loginId: string): LoginStatusResult {
    const session = this.sessions.get(loginId)
    if (session === undefined) {
      return { status: 'failed', username: '', error: '登录会话不存在或已结束，请重新发起' }
    }
    return { status: session.status, username: session.username, error: session.error }
  }

  /**
   * 取走成功会话的 token（取后即清空，避免同一 token 被重复消费）。
   * **只给 host 半的 settings 写入用**；绝不放进 status 响应回传浏览器。
   */
  takeToken(loginId: string): string {
    const session = this.sessions.get(loginId)
    if (session === undefined || session.status !== 'success') return ''
    const token = session.token
    session.token = ''
    return token
  }

  /** 取消登录（用户点「取消」或关闭面板）。 */
  cancel(loginId: string): void {
    const session = this.sessions.get(loginId)
    if (session === undefined) return
    if (session.status === 'pending') this.fail(session, '已取消登录')
  }

  /** 释放全部会话（插件卸载时调用，防止回调 server 与定时器泄漏）。 */
  dispose(): void {
    for (const session of this.sessions.values()) {
      if (session.timer !== undefined) clearTimeout(session.timer)
      session.server?.close()
    }
    this.sessions.clear()
  }

  /** 处理浏览器回调：校验 state → 换 id_token → 换 HiMarket token → 渲染结果页。 */
  private async handleCallback(
    session: Session,
    cfg: SsoConfig,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    // 已结束的会话（超时/取消）不再处理，避免覆盖终态
    if (session.status !== 'pending') {
      respond(res, 200, renderPage('登录已结束', '请关闭此页，回到 DSH 设置页查看状态。'))
      return
    }

    const code = url.searchParams.get('code') ?? ''
    const gotState = url.searchParams.get('state') ?? ''
    if (code === '') {
      this.fail(session, '授权失败：浏览器未返回授权码（可能被拒绝授权）')
      respond(res, 200, renderPage('授权失败', '未收到授权码，请关闭此页回到 DSH 重试。'))
      return
    }
    if (gotState !== session.state) {
      this.fail(session, '安全校验失败：state 不匹配（可能存在 CSRF 攻击）')
      respond(res, 200, renderPage('安全校验失败', 'state 不匹配，登录已中止。请关闭此页重试。'))
      return
    }

    try {
      const idToken = await exchangeCode(cfg, session.redirectUri, code, session.verifier)
      const { accessToken, username } = await exchangeHimarketToken(cfg, idToken)
      session.status = 'success'
      session.token = accessToken
      session.username = username
      session.finishedAt = Date.now()
      this.release(session)
      respond(res, 200, renderPage('授权成功', '已可关闭此页，回到 DSH 设置页即可使用。'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.fail(session, message)
      respond(res, 200, renderPage('登录失败', `${message}。请关闭此页回到 DSH 重试。`))
    }
  }

  /** 置为失败终态并释放资源。 */
  private fail(session: Session, message: string): void {
    if (session.status !== 'pending') return
    session.status = 'failed'
    session.error = message
    session.finishedAt = Date.now()
    this.release(session)
  }

  /** 释放会话占用的 server 与定时器（保留记录供前端轮询读取终态）。 */
  private release(session: Session): void {
    if (session.timer !== undefined) {
      clearTimeout(session.timer)
      session.timer = undefined
    }
    session.server?.close()
    session.server = undefined
  }

  /** 淘汰超过 TTL 的已完成会话（避免长驻进程内存缓慢增长）。 */
  private prune(): void {
    const now = Date.now()
    for (const [id, session] of this.sessions) {
      if (session.status !== 'pending' && now - session.finishedAt > SESSION_TTL_MS) {
        this.sessions.delete(id)
      }
    }
  }
}

// token 由 index.ts 经 takeToken 取走后写 settings.yaml（不随 status 回传浏览器）。

/** 统一响应（回调页）。 */
function respond(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}

/**
 * 在 127.0.0.1 的 45813~45815 中取一个空闲端口起服务（占用则顺延）。
 * 三个都被占用时报明确错误（不新增端口 —— 新增需改 Keycloak 注册）。
 */
function listenOnFreePort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    let port = CALLBACK_BASE_PORT
    const last = CALLBACK_BASE_PORT + CALLBACK_PORT_RANGE - 1
    const attempt = (): void => {
      const server = createServer()
      server.once('error', (err: NodeJS.ErrnoException) => {
        server.close()
        if (err.code === 'EADDRINUSE' && port < last) {
          port += 1
          attempt()
          return
        }
        reject(new Error(`本地回调端口 ${CALLBACK_BASE_PORT}~${last} 均被占用，无法完成一键登录`))
      })
      server.listen(port, '127.0.0.1', () => resolve({ server, port }))
    }
    attempt()
  })
}

/** 用授权码换 id_token（public client + PKCE，**不带 client_secret**）。 */
async function exchangeCode(
  cfg: SsoConfig,
  redirectUri: string,
  code: string,
  verifier: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    code_verifier: verifier,
  })
  const url = `${cfg.issuer.trim().replace(/\/+$/u, '')}/protocol/openid-connect/token`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new Error(`Keycloak 换票失败（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('Keycloak 换票响应不是合法 JSON')
  }
  const idToken = str(asRecord(json)['id_token'])
  if (idToken === '') throw new Error('Keycloak 换票响应缺少 id_token')
  return idToken
}

/**
 * 用 Keycloak id_token 换 HiMarket developer token。
 *
 * 契约（已实测，2026-09-20）：
 *   POST {base}/api/v1/developers/oauth2/token
 *   form: grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<id_token>
 *   → { code:"SUCCESS", data:{ access_token, token_type, expires_in:604800 } }
 */
async function exchangeHimarketToken(
  cfg: SsoConfig,
  idToken: string,
): Promise<{ accessToken: string; username: string }> {
  const base = cfg.baseUrl.trim().replace(/\/+$/u, '')
  if (base === '') throw new Error('未配置 HiMarket 地址')
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: idToken,
  })
  const res = await fetch(`${base}/api/v1/developers/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const text = await res.text().catch(() => '')
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  const root = asRecord(json)
  if (!res.ok) {
    const msg = str(root['message']) || text
    throw new Error(`HiMarket 换票失败（HTTP ${res.status}）：${msg.slice(0, 200)}`)
  }
  const code = str(root['code'])
  if (code !== '' && code !== 'SUCCESS') {
    throw new Error(str(root['message']) || code)
  }
  const data = asRecord(root['data'] !== undefined ? root['data'] : json)
  const accessToken = str(data['access_token'])
  if (accessToken === '') throw new Error('HiMarket 换票成功但响应没有 access_token')
  return { accessToken, username: idTokenClaim(idToken, 'preferred_username') }
}
