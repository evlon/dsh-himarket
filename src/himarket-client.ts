/**
 * HiMarket REST 客户端：登录 + 拉取已订阅 MCP + 拉取已发布 Skill + 下载 Skill ZIP。
 *
 * 契约（由同事部署的 HiMarket 后端提供，本模块只做字段容错）：
 *  - 统一响应包装 Response<T> = { code: 'SUCCESS', message?, data }
 *  - POST /developers/login          data = { access_token, token_type, expires_in }
 *  - GET  /cli-providers/market-mcps data = { mcpServers: [{name,url,transportType,description}], authHeaders }
 *  - GET  /cli-providers/market-skills data = [{ productId, name, description, skillTags }]
 *  - GET  /skills/{productId}/download  二进制 ZIP（@PublicAccess）
 *
 * @module dsh-himarket/himarket-client
 */

/** 单个已订阅 MCP Server（market-mcps 条目）。 */
export interface SubscribedMcp {
  productId: string
  name: string
  url: string
  transportType: string
  description: string
}

/** 单个已发布 Skill（market-skills 条目）。 */
export interface PublishedSkill {
  productId: string
  name: string
  description: string
  skillTags: string[]
}

/** market-mcps 的响应 data。 */
interface MarketMcpsData {
  mcpServers?: Array<Partial<SubscribedMcp>>
  authHeaders?: Record<string, string>
}

/** market-skills 的响应 data。 */
interface MarketSkillsData {
  items?: Array<Partial<PublishedSkill>>
}

/** login 的响应 data。 */
interface AuthData {
  access_token?: string
  token_type?: string
  expires_in?: number
}

/** 统一响应包装（部分读取）。 */
interface Wrapped<T> {
  code?: string
  message?: string
  data?: T
}

export class HimarketError extends Error {}

/** 真实 HiMarket 后端的 API 前缀（前端同域反向代理到 /api/v1）。 */
const API_PREFIX = '/api/v1'

/** 规范 baseUrl（去尾斜杠；空则抛）。 */
function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, '')
  if (trimmed === '') throw new HimarketError('未配置 HiMarket 地址（baseUrl 为空）')
  return trimmed
}

/**
 * HiMarket REST 客户端。持有 baseUrl + 用户名/密码 + 缓存 token，
 * 401 自动重登一次。所有方法抛 HimarketError（含可读中文原因）。
 */
export class HimarketClient {
  private readonly baseUrl: string
  private readonly username: string
  private readonly password: string
  private token: string
  private fetchFn: typeof fetch

  constructor(opts: {
    baseUrl: string
    username: string
    password: string
    token?: string
    fetchFn?: typeof fetch
  }) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl)
    this.username = opts.username
    this.password = opts.password
    this.token = opts.token ?? ''
    this.fetchFn = opts.fetchFn ?? globalThis.fetch
  }

  get hasToken(): boolean {
    return this.token !== ''
  }

  get currentToken(): string {
    return this.token
  }

  /** 登录并缓存 token；返回 access_token。 */
  async login(): Promise<string> {
    const wrapped = await this.request<AuthData>('/developers/login', {
      method: 'POST',
      body: JSON.stringify({ username: this.username, password: this.password }),
      auth: false,
    })
    const token = wrapped.access_token
    if (token === undefined || token === '') {
      throw new HimarketError('登录成功但未返回 access_token')
    }
    this.token = token
    return token
  }

  /** 拉取已订阅（且已批准）的 MCP 列表 + 认证头。 */
  async listSubscribedMcps(): Promise<{ mcpServers: SubscribedMcp[]; authHeaders: Record<string, string> }> {
    const data = await this.request<MarketMcpsData>('/cli-providers/market-mcps', { auth: true })
    const mcpServers = (data.mcpServers ?? [])
      .filter((m) => typeof m.name === 'string' && m.name !== '' && typeof m.url === 'string' && m.url !== '')
      .map((m) => ({
        productId: String(m.productId ?? ''),
        name: String(m.name),
        url: String(m.url),
        transportType: String(m.transportType ?? 'streamable-http'),
        description: String(m.description ?? ''),
      }))
    return { mcpServers, authHeaders: data.authHeaders ?? {} }
  }

  /** 拉取已发布 Skill 清单。 */
  async listPublishedSkills(): Promise<PublishedSkill[]> {
    const data = await this.request<MarketSkillsData>('/cli-providers/market-skills', { auth: true })
    const list = Array.isArray(data) ? (data as Array<Partial<PublishedSkill>>) : (data.items ?? [])
    return list
      .filter((s) => typeof s.productId === 'string' && s.productId !== '' && typeof s.name === 'string' && s.name !== '')
      .map((s) => ({
        productId: String(s.productId),
        name: String(s.name),
        description: String(s.description ?? ''),
        skillTags: Array.isArray(s.skillTags) ? s.skillTags.filter((t): t is string => typeof t === 'string') : [],
      }))
  }

  /** 下载 Skill ZIP，返回字节。 */
  async downloadSkill(productId: string): Promise<Uint8Array> {
    const url = `${this.baseUrl}${API_PREFIX}/skills/${encodeURIComponent(productId)}/download`
    const res = await this.fetchFn(url, { method: 'GET' })
    if (!res.ok) {
      throw new HimarketError(`下载技能失败（HTTP ${res.status}）`)
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.length === 0) throw new HimarketError('下载到的技能包为空')
    return buf
  }

  /** 通用请求：带 401 自动重登一次；解析 {code,data} 包装。 */
  private async request<T>(path: string, opts: { method?: string; body?: string; auth: boolean }): Promise<T> {
    const doFetch = async (): Promise<Response> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (opts.auth && this.token !== '') headers.Authorization = `Bearer ${this.token}`
      const res = await this.fetchFn(this.baseUrl + API_PREFIX + path, {
        method: opts.method ?? 'GET',
        headers,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      })
      return res
    }

    let res = await doFetch()
    if (res.status === 401 && opts.auth) {
      await this.login()
      res = await doFetch()
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new HimarketError(`HiMarket 请求失败（HTTP ${res.status}）${body.slice(0, 200)}`)
    }
    const wrapped = (await res.json().catch(() => ({ code: 'PARSE_ERROR' }))) as Wrapped<T>
    if (wrapped.code !== undefined && wrapped.code !== 'SUCCESS') {
      throw new HimarketError(wrapped.message ?? `HiMarket 返回错误码 ${wrapped.code}`)
    }
    return (wrapped.data ?? (wrapped as unknown as T)) as T
  }
}
