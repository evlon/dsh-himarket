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

/** 发布流程所需的类别/产品/版本字段（部分读取）。 */
interface CategoryItem {
  categoryId?: string
  name?: string
}
interface ProductItem {
  productId?: string
  name?: string
}
interface SkillVersion {
  version?: string
  status?: string
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
  /** 管理员账号（/admins/login 用，默认 admin）；与开发者账号区分。 */
  private readonly adminUsername: string
  private readonly adminPassword: string
  /** 开发者 token（/developers/login），sync/install 用。 */
  private token: string
  /** 管理员 token（/admins/login），publish 用。 */
  private adminToken: string
  private fetchFn: typeof fetch

  constructor(opts: {
    baseUrl: string
    username: string
    password: string
    adminUsername?: string
    adminPassword?: string
    token?: string
    adminToken?: string
    fetchFn?: typeof fetch
  }) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl)
    this.username = opts.username
    this.password = opts.password
    this.adminUsername = opts.adminUsername ?? 'admin'
    this.adminPassword = opts.adminPassword ?? ''
    this.token = opts.token ?? ''
    this.adminToken = opts.adminToken ?? ''
    this.fetchFn = opts.fetchFn ?? globalThis.fetch
  }

  get hasToken(): boolean {
    return this.token !== ''
  }

  get currentToken(): string {
    return this.token
  }

  /** 是否已缓存管理员 token（发布前判断）。 */
  adminTokenMissing(): boolean {
    return this.adminToken === ''
  }

  /** 返回缓存的管理员 token（供发布后回写 settings）。 */
  cachedAdminToken(): string {
    return this.adminToken
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

  /** 管理员登录并缓存 token；返回 access_token。publish 系列走管理员端点。 */
  async loginAdmin(): Promise<string> {
    const wrapped = await this.request<AuthData>('/admins/login', {
      method: 'POST',
      body: JSON.stringify({ username: this.adminUsername, password: this.adminPassword }),
      auth: false,
    })
    const token = wrapped.access_token
    if (token === undefined || token === '') {
      throw new HimarketError('管理员登录成功但未返回 access_token')
    }
    this.adminToken = token
    return token
  }

  /**
   * 发布一个岗位包 / 技能包 ZIP 到 HiMarket（管理员端点）：
   *   确保分类存在 → 建/复用产品 → 上传 zip → 发布最新 draft 版本 online → 发布到门户。
   * 契约与 dsh-job-market/scripts/publish-job.mjs 一致（已实测跑通）。
   *
   * @param name 产品名（岗位 id，如 pm/dev；HiMarket 产品名唯一）
   * @param zipBuffer 打包好的 zip 字节
   * @param opts.portalId 发布到的门户 ID（可选，缺省跳过门户发布）
   * @param opts.categoryName 分类名，默认「数字员工岗位」
   */
  async publishSkillPackage(
    name: string,
    zipBuffer: Uint8Array,
    opts: { portalId?: string; categoryName?: string } = {},
  ): Promise<{ productId: string; version: string }> {
    if (this.adminToken === '') await this.loginAdmin()

    // 1. 确保分类存在（幂等）
    const catName = opts.categoryName ?? '数字员工岗位'
    const cats = await this.adminRequest<{ content?: CategoryItem[] }>('/product-categories?size=100')
    const catList = cats.content ?? []
    let catId = catList.find((c) => c.name === catName)?.categoryId ?? ''
    if (catId === '') {
      const created = await this.adminRequest<CategoryItem>('/product-categories', {
        method: 'POST',
        body: JSON.stringify({ name: catName, description: '可安装的数字员工岗位包：含岗位 preset 与岗位专项技能' }),
      })
      catId = created.categoryId ?? ''
      if (catId === '') throw new HimarketError('创建分类失败')
    }

    // 2. 建/复用产品（按 name 幂等）
    const prods = await this.adminRequest<{ content?: ProductItem[] }>(`/products?type=AGENT_SKILL&size=200`)
    const prodList = prods.content ?? []
    let productId = prodList.find((p) => p.name === name)?.productId ?? ''
    if (productId === '') {
      const created = await this.adminRequest<ProductItem>('/products', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: `[岗位包] ${name} 数字员工岗位`,
          type: 'AGENT_SKILL',
          document: `# ${name} 数字员工岗位包`,
          autoApprove: true,
          categories: [catId],
        }),
      })
      productId = created.productId ?? ''
      if (productId === '') throw new HimarketError('创建产品失败')
    }

    // 3. 上传 zip（multipart/form-data: file=@zip）
    const uploadBody = new FormData()
    uploadBody.append('file', new Blob([zipBuffer], { type: 'application/zip' }), `${name}.zip`)
    const uploadUrl = `${this.baseUrl}${API_PREFIX}/skills/${encodeURIComponent(productId)}/package`
    const uploadRes = await this.fetchFn(uploadUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.adminToken}` },
      body: uploadBody,
    })
    if (!uploadRes.ok) {
      const body = await uploadRes.text().catch(() => '')
      throw new HimarketError(`上传技能包失败（HTTP ${uploadRes.status}）${body.slice(0, 200)}`)
    }
    const uploadJson = (await uploadRes.json().catch(() => ({ code: 'PARSE_ERROR' }))) as Wrapped<unknown>
    if (uploadJson.code !== undefined && uploadJson.code !== 'SUCCESS') {
      throw new HimarketError(uploadJson.message ?? '上传技能包失败')
    }

    // 4. 发布最新 draft 版本为 online（force）
    const versions = await this.adminRequest<SkillVersion[]>(`/skills/${encodeURIComponent(productId)}/versions`)
    const vlist = Array.isArray(versions) ? versions : (versions as unknown as SkillVersion[])
    const draft = vlist
      .filter((v) => v.status === 'draft')
      .sort((a, b) => String(b.version).localeCompare(String(a.version)))[0]
    const ver = draft?.version !== undefined ? String(draft.version) : undefined
    // 没有 draft：说明本次上传的内容与线上一致（服务端未建新版本）。
    // 若最新版本已在线，则视为「无需重发」，幂等成功；否则报错。
    if (ver === undefined) {
      const latest = [...vlist].sort((a, b) => String(b.version).localeCompare(String(a.version)))[0]
      if (latest?.status === 'online') {
        // 幂等：已是最新线上版本。
        return { productId, version: String(latest.version) }
      }
      throw new HimarketError('上传后未生成 draft 版本，且最新版本非 online，无法发布')
    }
    const pubResp = await this.adminRequest<unknown>(`/skills/${encodeURIComponent(productId)}/versions/${encodeURIComponent(ver)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'online', force: true, updateLatestLabel: true }),
    })
    if ((pubResp as Wrapped<unknown>).code !== undefined && (pubResp as Wrapped<unknown>).code !== 'SUCCESS') {
      throw new HimarketError(`发布版本失败：${(pubResp as Wrapped<unknown>).message ?? ver}`)
    }

    // 5. 发布到门户（可选）
    if (opts.portalId !== undefined && opts.portalId.trim() !== '') {
      await this.adminRequest<unknown>(`/products/${encodeURIComponent(productId)}/publications`, {
        method: 'POST',
        body: JSON.stringify({ portalId: opts.portalId }),
      }).catch((e) => {
        // 门户发布失败不阻断主流程（warn 级）。
        throw new HimarketError(`已发布版本，但发布到门户失败：${e instanceof Error ? e.message : String(e)}`)
      })
    }

    return { productId, version: ver }
  }

  /** 管理员端点通用请求：带 401 自动重登一次；解析 {code,data} 包装。 */
  private async adminRequest<T>(path: string, opts: { method?: string; body?: string } = {}): Promise<T> {
    const doFetch = async (): Promise<Response> => {
      const res = await this.fetchFn(this.baseUrl + API_PREFIX + path, {
        method: opts.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(this.adminToken !== '' ? { Authorization: `Bearer ${this.adminToken}` } : {}),
        },
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      })
      return res
    }
    let res = await doFetch()
    if (res.status === 401) {
      await this.loginAdmin()
      res = await doFetch()
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new HimarketError(`HiMarket 管理端请求失败（HTTP ${res.status}）${body.slice(0, 200)}`)
    }
    const wrapped = (await res.json().catch(() => ({ code: 'PARSE_ERROR' }))) as Wrapped<T>
    if (wrapped.code !== undefined && wrapped.code !== 'SUCCESS') {
      throw new HimarketError(wrapped.message ?? `HiMarket 返回错误码 ${wrapped.code}`)
    }
    return (wrapped.data ?? (wrapped as unknown as T)) as T
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
