/**
 * dsh-himarket 浏览器端（Client 半）源码 —— 由 esbuild 打包为
 * `window.__ModuleLoader__.load({ id, factory })` 自包含 bundle（见
 * scripts/build-client.mjs）。运行时依赖（react）外部化，由 dsh 模块系统
 * 以 factory(require) 注入，避免与 shell 的 React 实例冲突。
 *
 * 单入口：设置侧栏注册一个「HiMarket」入口（settings.plugins.tab slot）。
 * 纯 React.createElement，无 JSX；样式用 --dsw-alias-* 主题 token。
 */

import React from 'react'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

const el = React.createElement

/**
 * 插件版本号：由 scripts/build-client.mjs 构建时注入（esbuild define，
 * __PLUGIN_VERSION__ → package.json version）。浏览器端无法读 package.json，
 * 故在构建期固化为常量；未注入时回退 'dev'。用于设置页 UI 展示当前加载版本。
 */
const PLUGIN_VERSION = typeof __PLUGIN_VERSION__ !== 'undefined' ? __PLUGIN_VERSION__ : 'dev'

const NS = 'settings.himarket'

const zh = {
  tab: 'HiMarket',
  title: 'HiMarket 能力市场',
  subtitle: '点「一键登录」用公司账号登录，就能在对话里用上公司上架的 MCP 工具和技能。',
  configTitle: '① 连接配置',
  baseUrlLabel: 'HiMarket 地址',
  baseUrlPlaceholder: '例如 http://market.ai.ict.cmcc',
  usernameLabel: '账号',
  usernamePlaceholder: '开发者账号用户名',
  passwordLabel: '密码',
  passwordPlaceholder: '开发者账号密码',
  save: '保存配置',
  saved: '已保存',
  sync: '同步能力',
  syncing: '同步中…',
  login: '一键登录',
  relogin: '重新登录',
  loggingIn: '等待浏览器授权…',
  loginCancel: '取消',
  loginDone: '已登录',
  loginPending: '请在浏览器中完成登录，完成后本页会自动刷新。',
  logout: '退出登录',
  loggedOut: '已退出登录',
  stateNotLogged: '未登录',
  stateLoggedIn: '已登录',
  stateExpired: '登录已过期',
  stateChecking: '检查中…',
  debugBadge: '⚠️ 调试模式已开启（可手工填账号密码）',
  debugHint: '研发/运维调试用。正式使用请关闭：不要设置环境变量 DSH_HIMARKET_ALLOW_PASSWORD，并把设置里的 allowPasswordLogin 置为 false。',
  readonlyHint: '账号密码默认只读，请用上方「一键登录」。需要手工登录请开启调试开关（见下方说明）。',
  // ── 环境地址来源说明（2026-09-21 UE 改造）──
  // 用户反馈：只读框不给填，却不说清「谁给的、为什么不能填」。故按来源分别说明。
  addrSourceLabel: '来源：',
  srcServer: '服务端下发',
  srcServerDrift: '服务端已下发，本地值待同步覆盖',
  srcBuiltin: '插件内置默认（服务端未下发）',
  srcLocal: '本地配置（服务端未下发）',
  srcUnset: '未配置',
  srcUnknown: '来源未知',
  srcServerTip: '该值由公司服务器统一下发，每次同步自动覆盖，因此本地不可修改。',
  srcBuiltinTip: '服务端未下发此项，当前用的是插件内置默认值。它会随插件升级更新，本地同样不可改。',
  srcLocalTip: '服务端未下发此项，当前值来自本地配置。如需统一管理，请让管理员在配置中心下发。',
  srcUnknownTip: '未找到启动器的同步记录（本实例可能不是由启动器启动的），无法判定该值来源。',
  syncAtLabel: '最近同步：',
  addrDebugHint: '如需手工改这两个地址，请开启调试开关：设环境变量 DSH_HIMARKET_ALLOW_PASSWORD=1（研发临时用），或让运维在配置中心下发 himarket.allowPasswordLogin=true。',
  showHowTo: '如何修改？',
  hideHowTo: '收起',
  howToTitle: '这些值为什么不给填、以及确实要改时怎么做',
  howToServer: '① 正常情况（推荐）：不用改。地址由公司服务器统一下发，每次同步自动覆盖本地 —— 这正是「不让填」的原因，避免有人改了地址后连不上还不知道为什么。',
  howToDebug: '② 研发/运维调试：开启调试开关后，这些框会变为可编辑，且会出现「保存配置」按钮。开启方式（二选一）：',
  howToDebugEnv: '临时用：设环境变量 DSH_HIMARKET_ALLOW_PASSWORD=1 后重启 DSH',
  howToDebugCfg: '统一用：让管理员在配置中心下发 himarket.allowPasswordLogin=true',
  howToWarn: '⚠️ 调试开关只影响本机能否编辑。服务端下次同步仍会覆盖这两个地址 —— 要长期生效，请改服务端配置。',
  mcpTitle: '② 已订阅 MCP（同步后自动接入会话）',
  skillTitle: '③ 可安装技能',
  install: '安装',
  installed: '已装',
  empty: '暂无数据，请先「同步」或检查账号是否已订阅/上架。',
  error: '出错了',
  ok: '完成',
  publishTitle: '④ 发布我的岗位到市场',
  publishHint: '把本机已迭代优化的数字员工岗位（preset 人设 + 岗位技能）打包上架，供同事同步安装。发布走包装层（企业统一通道，自动登记归属/来源），请先填好上方包装层地址。',
  publish: '发布',
  publishing: '发布中',
  gatewayLabel: '包装层地址',
  gatewayPlaceholder: '如 http://job.ai.ict.cmcc，发布与来源标签都走它',
  sourceOfficial: '企业发布',
  sourceCommunity: '员工共建',
  filterAll: '全部',
  filterOfficial: '企业发布',
  filterCommunity: '员工共建',
  overrideTag: '员工改进版',
  overrideOf: '覆盖',
  overriddenHint: '有员工改进版（官方默认，可选用改进版）',
}

const en = {
  tab: 'HiMarket',
  title: 'HiMarket Capability Market',
  subtitle: 'Sign in with your company account, then use subscribed MCP tools and skills in chat.',
  configTitle: '1. Connection',
  baseUrlLabel: 'HiMarket URL',
  usernameLabel: 'Account',
  passwordLabel: 'Password',
  save: 'Save',
  saved: 'Saved',
  sync: 'Sync',
  syncing: 'Syncing…',
  login: 'Sign in',
  relogin: 'Sign in again',
  loggingIn: 'Waiting for browser…',
  loginCancel: 'Cancel',
  loginDone: 'Signed in',
  loginPending: 'Finish signing in from the browser window; this page refreshes automatically.',
  logout: 'Sign out',
  loggedOut: 'Signed out',
  stateNotLogged: 'Not signed in',
  stateLoggedIn: 'Signed in',
  stateExpired: 'Session expired',
  stateChecking: 'Checking…',
  debugBadge: '⚠️ Debug mode on (manual account/password enabled)',
  debugHint: 'For developers/ops debugging only. To disable: unset DSH_HIMARKET_ALLOW_PASSWORD and set allowPasswordLogin=false.',
  readonlyHint: 'Account and password are read-only by default; use "Sign in" above. Enable the debug switch to sign in manually.',
  addrSourceLabel: 'Source: ',
  srcServer: 'Issued by server',
  srcServerDrift: 'Issued by server (local value pending overwrite)',
  srcBuiltin: 'Plugin built-in default (server did not issue)',
  srcLocal: 'Local configuration (server did not issue)',
  srcUnset: 'Not configured',
  srcUnknown: 'Source unknown',
  srcServerTip: 'This value is issued centrally by the company server and overwritten on every sync, so it cannot be edited locally.',
  srcBuiltinTip: 'The server does not issue this key; the current value is the plugin built-in default. It follows plugin upgrades and is likewise not editable locally.',
  srcLocalTip: 'The server does not issue this key; the current value comes from local configuration. Ask an admin to issue it centrally if it should be managed.',
  srcUnknownTip: 'No launcher sync record was found (this instance may not have been started by the launcher), so the origin cannot be determined.',
  syncAtLabel: 'Last sync: ',
  addrDebugHint: 'To edit these two URLs manually, enable the debug switch: set DSH_HIMARKET_ALLOW_PASSWORD=1 (temporary, for developers), or have ops issue himarket.allowPasswordLogin=true from the config center.',
  showHowTo: 'How do I change these?',
  hideHowTo: 'Hide',
  howToTitle: 'Why these values are not editable, and how to change them if you really must',
  howToServer: '(1) Normal case (recommended): nothing to change. URLs are issued centrally and overwritten on every sync — that is exactly why they are read-only, so nobody breaks connectivity by editing them without knowing.',
  howToDebug: '(2) Developer/ops debugging: with the debug switch on, these fields become editable and a "Save" button appears. Enable it either way:',
  howToDebugEnv: 'Temporary: set DSH_HIMARKET_ALLOW_PASSWORD=1 and restart DSH',
  howToDebugCfg: 'Central: have an admin issue himarket.allowPasswordLogin=true from the config center',
  howToWarn: '⚠️ The debug switch only affects local editing. The next server sync still overwrites these URLs — change the server config for a lasting effect.',
  mcpTitle: '2. Subscribed MCP (auto-attached)',
  skillTitle: '3. Installable Skills',
  install: 'Install',
  installed: 'Installed',
  empty: 'Nothing yet. Sync first, or check subscriptions/published items.',
  error: 'Error',
  ok: 'Done',
  publishTitle: '4. Publish My Job to Market',
  publishHint: 'Package your locally iterated digital-employee job (preset persona + job skill) and publish it for colleagues to install. Publishing goes through the gateway (enterprise channel, records ownership/source automatically). Fill in the gateway URL above first.',
  publish: 'Publish',
  publishing: 'Publishing',
  gatewayLabel: 'Gateway URL',
  gatewayPlaceholder: 'e.g. http://job.ai.ict.cmcc; publishing and source tags go through it',
  sourceOfficial: 'Official',
  sourceCommunity: 'Community',
  filterAll: 'All',
  filterOfficial: 'Official',
  filterCommunity: 'Community',
  overrideTag: 'Community Fork',
  overrideOf: 'of',
  overriddenHint: 'has community forks (official default; fork optional)',
}

const CSS = [
  ".hm_section{width:100%;max-width:760px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary)}",
  ".hm_section h3{margin:0;font-size:13px;font-weight:600;line-height:20px}",
  ".hm_message{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:0}",
  ".hm_message[data-error=true]{color:var(--dsw-alias-state-error-primary)}",
  ".hm_field{display:flex;flex-direction:column;gap:6px}",
  ".hm_field label{font-size:12px;color:var(--dsw-alias-label-secondary)}",
  ".hm_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:8px 10px;font-size:13px;color:var(--dsw-alias-label-primary)}",
  ".hm_row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
  ".hm_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer}",
  ".hm_btn:hover{background:var(--dsw-alias-bg-layer-2)}",
  ".hm_btn[data-primary=true]{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:#fff}",
  ".hm_list{margin:0;padding:0;list-style:none;display:grid;gap:8px}",
  ".hm_item{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}",
  ".hm_itemTop{display:flex;align-items:center;gap:8px}",
  ".hm_name{font-size:13px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".hm_desc{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0}",
  ".hm_tag{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px;flex:none}",
  ".hm_tag[data-ok=true]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}",
  ".hm_tag[data-source=official]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}",
  ".hm_tag[data-source=community]{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
  ".hm_btn[data-active=true]{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:#fff}",
  ".hm_overrides{margin-top:4px;padding:6px 8px;background:var(--dsw-alias-bg-layer-2);border-radius:8px;display:grid;gap:6px}",
  ".hm_overrides .hm_desc{margin:0 0 2px 0}",
  ".hm_overrides .hm_list{gap:4px}",
  ".hm_overrides .hm_item{padding:6px 8px}",
  ".hm_input[readonly]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:default}",
  ".hm_state{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-primary)}",
  ".hm_dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}",
  ".hm_dot[data-state=LOGGED_IN]{background:var(--dsw-alias-state-success-primary)}",
  ".hm_dot[data-state=EXPIRED]{background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-error-primary))}",
  ".hm_dot[data-state=NOT_LOGGED]{background:var(--dsw-alias-label-tertiary)}",
  ".hm_warn{border:1px solid var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:8px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
  ".hm_hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0}",
  // ── 配置来源徽标（2026-09-21 UE）──
  ".hm_origin{font-size:11px;line-height:16px;font-weight:400;border-radius:999px;padding:1px 8px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);cursor:help}",
  ".hm_origin[data-tone=server]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}",
  ".hm_origin[data-tone=warn]{border-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}",
  ".hm_origin[data-tone=muted]{opacity:.85}",
  // ── 「如何修改」折叠区 ──
  ".hm_howto{display:flex;flex-direction:column;gap:8px}",
  ".hm_link{align-self:flex-start;background:none;border:none;padding:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-business-primary);cursor:pointer;text-align:left}",
  ".hm_link:hover{text-decoration:underline}",
  ".hm_howtoBody{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}",
  ".hm_howtoList{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
  ".hm_howtoBody code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}",
].join('\n')

function injectCss() {
  const tagId = 'dsh-himarket/client.css'
  if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-himarket'
    tag.dataset.pluginCss = tagId
    tag.textContent = CSS
    document.head.appendChild(tag)
  }
}

function call(path, body) {
  return fetch(path, body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then((res) => res.json())
    .then((data) => {
      if (data && data.ok === false) throw new Error(data.error || 'request failed')
      return data
    })
}

function HimarketTab(props) {
  const t = props.t
  const [state, setState] = React.useState({ status: 'loading' })
  const [message, setMessage] = React.useState(null)
  const [busy, setBusy] = React.useState(false)

  const [baseUrl, setBaseUrl] = React.useState('')
  const [username, setUsername] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [gatewayUrl, setGatewayUrl] = React.useState('')
  const [sourceFilter, setSourceFilter] = React.useState('ALL')
  // 一键登录：当前 loginId（非 null 表示等待浏览器授权中）
  const [loginId, setLoginId] = React.useState(null)
  const pollRef = React.useRef(null)

  const refresh = React.useCallback(function () {
    call('/himarket/state').then(function (data) {
      setState({ status: 'ready', data })
      if (data && data.baseUrl) setBaseUrl(data.baseUrl)
      if (data && data.username) setUsername(data.username)
      if (data && data.gatewayUrl) setGatewayUrl(data.gatewayUrl)
    }, function (err) {
      setState({ status: 'error', error: err.message })
    })
  }, [])

  React.useEffect(function () { refresh() }, [refresh])

  // 组件卸载：停止轮询，避免泄漏
  React.useEffect(function () {
    return function () { if (pollRef.current !== null) clearInterval(pollRef.current) }
  }, [])

  function stopPolling() {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  /**
   * 轮询登录结果。成功后 host 已写入 token 并自动同步，这里只刷新界面。
   * 用 setInterval 而非递归 setTimeout：与 host 的 120s 超时解耦，实现简单。
   */
  function startPolling(id) {
    stopPolling()
    pollRef.current = setInterval(function () {
      call('/himarket/login-status?loginId=' + encodeURIComponent(id)).then(function (data) {
        if (data.status === 'success') {
          stopPolling()
          setLoginId(null)
          setMessage(data.summary ? t('loginDone') + '：' + data.summary : t('loginDone'))
          refresh()
        } else if (data.status === 'failed') {
          stopPolling()
          setLoginId(null)
          setMessage(t('error') + '：' + (data.error || ''))
          refresh()
        }
      }, function () { /* 轮询失败静默重试，不打扰用户 */ })
    }, 1500)
  }

  function doLogin() {
    // ⚠️ 关键：必须在**点击的同步执行栈内**先开一个占位窗口。
    // 若等 login-start 的 Promise 回调里再 window.open，已脱离用户手势，
    // 会被浏览器当弹窗拦截（设计文档 R3）。拿到 authUrl 后再给占位窗改地址。
    var win = null
    try { win = window.open('about:blank', '_blank') } catch (e) { win = null }
    setMessage(t('loginPending'))
    setBusy(true)
    call('/himarket/login-start', {}).then(function (data) {
      setBusy(false)
      setLoginId(data.loginId)
      if (win !== null && !win.closed) {
        win.location.href = data.authUrl
      } else {
        // 占位窗被拦截或已关闭：给出可手动打开的地址，不让用户卡死
        setMessage(t('error') + '：浏览器拦截了新窗口，请手动访问 ' + data.authUrl)
      }
      startPolling(data.loginId)
    }, function (err) {
      setBusy(false)
      if (win !== null && !win.closed) win.close()
      setMessage(t('error') + '：' + err.message)
    })
  }

  function cancelLogin() {
    var id = loginId
    stopPolling()
    setLoginId(null)
    if (id !== null) call('/himarket/login-cancel', { loginId: id }).catch(function () {})
  }

  function doLogout() {
    setBusy(true)
    call('/himarket/logout', {}).then(function () {
      setBusy(false); setMessage(t('loggedOut')); refresh()
    }, function (err) { setBusy(false); setMessage(t('error') + '：' + err.message) })
  }

  function saveConfig() {
    setBusy(true)
    // 「保存配置」按钮仅在调试态出现，故此分支必然 allowPassword=true：
    // 地址与账密一并提交。默认态下该按钮不渲染，saveConfig 不会被调用
    // （host 侧另有守卫，见设计文档 §13.3）。
    var patch = { baseUrl: baseUrl, username: username, password: password, gatewayUrl: gatewayUrl }
    call('/himarket/save-config', patch)
      .then(function () {
        setMessage(t('saved')); setBusy(false); refresh()
      },
      function (err) { setMessage(t('error') + '：' + err.message); setBusy(false) })
  }

  function doSync() {
    setBusy(true)
    setMessage(t('syncing'))
    call('/himarket/sync', {}).then(function (data) {
      setMessage(data.summary || t('ok')); setBusy(false); refresh()
    }, function (err) { setMessage(t('error') + '：' + err.message); setBusy(false) })
  }

  function installSkill(nameOrId) {
    setBusy(true)
    call('/himarket/install-skill', { nameOrId }).then(function (data) {
      setMessage(data.summary || t('ok')); setBusy(false); refresh()
    }, function (err) { setMessage(t('error') + '：' + err.message); setBusy(false) })
  }

  function publishMyJob(job) {
    setBusy(true)
    setMessage(t('publishing') + '：' + job)
    call('/himarket/publish-job', { job }).then(function (data) {
      setMessage(data.summary || t('ok')); setBusy(false); refresh()
    }, function (err) { setMessage(t('error') + '：' + err.message); setBusy(false) })
  }

  const data = state.status === 'ready' ? state.data : null
  const mcpServers = (data && data.mcpServers) || []
  const activeNames = (data && data.activeMcpNames) || []
  const publishedSkills = (data && data.publishedSkills) || []
  const installedSkills = (data && data.installedSkills) || []
  // 登录态：host 计算（loginStateOf），默认未登录（避免首帧误显示「已登录」）
  const loginState = (data && data.loginState) || 'NOT_LOGGED'
  const loginUsername = (data && data.loginUsername) || ''
  const allowPassword = !!(data && data.allowPasswordLogin)
  /**
   * 环境地址来源（2026-09-21 UE 改造）。host 侧 provenance.ts 依据
   * `<DSH_HOME>/sync-state.json` 里服务端**实际下发**的值判定，而非笼统断言
   * 「服务端下发」。缺字段（旧版 host）时回退 UNKNOWN，不猜测。
   */
  const prov = (data && data.addressProvenance) || {}
  const baseProv = prov.baseUrl || { origin: 'UNKNOWN', serverValue: '', effectiveValue: '', lastSyncAt: '' }
  const gwProv = prov.gatewayUrl || { origin: 'UNKNOWN', serverValue: '', effectiveValue: '', lastSyncAt: '' }
  // 「如何修改」说明默认收起：不干扰主流程，但保证用户随时能找到（用户要求"以后再记得"）
  const [showHowTo, setShowHowTo] = React.useState(false)
  const pending = loginId !== null

  /** 来源 → 本地化标签 / 说明 / 徽标色。 */
  function originInfo(p) {
    switch (p.origin) {
      case 'SERVER': return { label: t('srcServer'), tip: t('srcServerTip'), tone: 'server' }
      case 'SERVER_DRIFT': return { label: t('srcServerDrift'), tip: t('srcServerTip'), tone: 'warn' }
      case 'BUILTIN_DEFAULT': return { label: t('srcBuiltin'), tip: t('srcBuiltinTip'), tone: 'muted' }
      case 'LOCAL': return { label: t('srcLocal'), tip: t('srcLocalTip'), tone: 'muted' }
      case 'UNSET': return { label: t('srcUnset'), tip: t('srcLocalTip'), tone: 'warn' }
      default: return { label: t('srcUnknown'), tip: t('srcUnknownTip'), tone: 'muted' }
    }
  }

  /** 单行来源徽标 + 悬停说明 + 同步时间。 */
  function originBadge(p) {
    const info = originInfo(p)
    const syncAt = p.lastSyncAt ? '　' + t('syncAtLabel') + p.lastSyncAt.replace('T', ' ').slice(0, 19) : ''
    return el('span', { className: 'hm_origin', 'data-tone': info.tone, title: info.tip + syncAt }, info.label)
  }

  /**
   * 「如何修改」折叠区：把「为什么不让填」和「确实要改怎么办」讲清楚。
   * 默认收起，点击展开 —— 满足用户「给个说明，以后再记得」的要求，
   * 又不至于让主界面被长文淹没。
   */
  function howToBlock() {
    return el('div', { className: 'hm_howto' },
      el('button', {
        className: 'hm_link', type: 'button',
        onClick: function () { setShowHowTo(!showHowTo) },
      }, (showHowTo ? '▾ ' + t('hideHowTo') : '▸ ' + t('showHowTo'))),
      showHowTo
        ? el('div', { className: 'hm_howtoBody' },
          el('p', { className: 'hm_desc' }, el('strong', null, t('howToTitle'))),
          el('p', { className: 'hm_desc' }, t('howToServer')),
          el('p', { className: 'hm_desc' }, t('howToDebug')),
          el('ul', { className: 'hm_howtoList' },
            el('li', null, el('code', null, 'DSH_HIMARKET_ALLOW_PASSWORD=1'), '　—　', t('howToDebugEnv')),
            el('li', null, el('code', null, 'himarket.allowPasswordLogin=true'), '　—　', t('howToDebugCfg')),
          ),
          el('p', { className: 'hm_desc' }, t('howToWarn')),
        )
        : null,
    )
  }

  function stateLabel() {
    if (state.status === 'loading') return t('stateChecking')
    if (loginState === 'LOGGED_IN') {
      return loginUsername !== '' ? t('stateLoggedIn') + '（' + loginUsername + '）' : t('stateLoggedIn')
    }
    if (loginState === 'EXPIRED') return t('stateExpired')
    return t('stateNotLogged')
  }

  function isInstalled(skill) {
    const name = skill && skill.name
    return installedSkills.indexOf(name) >= 0
  }

  // 来源徽标：企业发布 / 员工共建；覆盖版加「员工改进版·覆盖 X」提示
  function sourceTag(item) {
    if (!item) return null
    const src = item.source
    if (src === 'OFFICIAL') {
      return el('span', { className: 'hm_tag', 'data-source': 'official', title: item.overriddenBy && item.overriddenBy.length > 0 ? t('overriddenHint') : undefined },
        t('sourceOfficial'))
    }
    if (src === 'COMMUNITY') {
      const txt = item.overrides ? t('overrideTag') + '·' + t('overrideOf') + ' ' + item.overrides : t('sourceCommunity')
      return el('span', { className: 'hm_tag', 'data-source': 'community' }, txt)
    }
    return null
  }

  // 基线项下方的「员工改进版」折叠区（官方默认、改进可选）
  function overrideBlock(item) {
    if (!item || !item.overriddenBy || item.overriddenBy.length === 0) return null
    const hint = item.source === 'OFFICIAL' ? t('overriddenHint') : (t('overrideTag') + '：' + item.overriddenBy.length)
    return el('div', { className: 'hm_overrides' },
      el('p', { className: 'hm_desc' }, hint),
      el('ul', { className: 'hm_list' },
        item.overriddenBy.map(function (o) {
          const done = installedSkills.indexOf(o.name) >= 0
          return el('li', { className: 'hm_item', key: o.productId || o.name },
            el('div', { className: 'hm_itemTop' },
              el('span', { className: 'hm_name' }, o.name + '（' + o.publisher + '）'),
              el('span', { className: 'hm_tag', 'data-source': 'community' }, t('overrideTag')),
              el('button', { className: 'hm_btn', type: 'button', disabled: busy || done, onClick: function () { installSkill(o.productId) } },
                done ? t('installed') : t('install')),
            ),
          )
        }),
      ),
    )
  }

  return el('div', { className: 'hm_section' },
    el('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
      el('h3', null, t('title')),
      el('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, `dsh-himarket v${PLUGIN_VERSION}`)),
    el('p', { className: 'hm_message' }, t('subtitle')),

    el('h3', null, t('configTitle')),
    el('div', { className: 'hm_field' },
      el('label', null, t('baseUrlLabel'), ' ', originBadge(baseProv)),
      el('input', {
        className: 'hm_input', type: 'text', placeholder: t('baseUrlPlaceholder'),
        value: baseUrl, readOnly: !allowPassword,
        onChange: allowPassword ? (e) => setBaseUrl(e.target.value) : undefined,
      }),
      baseUrl.trim() === '' && !allowPassword
        ? el('p', { className: 'hm_desc' }, t('srcUnset'))
        : null,
    ),
    el('div', { className: 'hm_field' },
      el('label', null, t('usernameLabel')),
      el('input', {
        className: 'hm_input', type: 'text', placeholder: t('usernamePlaceholder'),
        value: username, readOnly: !allowPassword,
        onChange: allowPassword ? (e) => setUsername(e.target.value) : undefined,
      }),
    ),
    el('div', { className: 'hm_field' },
      el('label', null, t('passwordLabel')),
      el('input', {
        className: 'hm_input', type: 'password', placeholder: t('passwordPlaceholder'),
        value: password, readOnly: !allowPassword,
        onChange: allowPassword ? (e) => setPassword(e.target.value) : undefined,
      }),
    ),
    el('div', { className: 'hm_row' },
      el('span', { className: 'hm_state' },
        el('span', { className: 'hm_dot', 'data-state': state.status === 'loading' ? 'NOT_LOGGED' : loginState }),
        stateLabel(),
      ),
    ),
    allowPassword
      ? el('div', { className: 'hm_warn' }, t('debugBadge'), el('br', null), t('debugHint'))
      : el('p', { className: 'hm_hint' }, t('readonlyHint')),
    el('div', { className: 'hm_field' },
      el('label', null, t('gatewayLabel'), ' ', originBadge(gwProv)),
      el('input', {
        className: 'hm_input', type: 'text', placeholder: t('gatewayPlaceholder'),
        value: gatewayUrl, readOnly: !allowPassword,
        onChange: allowPassword ? (e) => setGatewayUrl(e.target.value) : undefined,
      }),
      gatewayUrl.trim() === '' && !allowPassword
        ? el('p', { className: 'hm_desc' }, t('srcUnset'))
        : null,
    ),
    // 「如何修改」说明（默认收起）：解释「为什么不让填」+ 确实要改时开什么开关。
    !allowPassword ? howToBlock() : null,
    el('div', { className: 'hm_row' },
      // 主按钮：未登录→一键登录；已登录→重新登录（G6 过期可自助恢复）
      pending
        ? el('button', { className: 'hm_btn', type: 'button', onClick: cancelLogin }, t('loginCancel'))
        : el('button', { className: 'hm_btn', type: 'button', 'data-primary': 'true', disabled: busy, onClick: doLogin },
          loginState === 'LOGGED_IN' ? t('relogin') : t('login')),
      loginState === 'LOGGED_IN' && !pending
        ? el('button', { className: 'hm_btn', type: 'button', disabled: busy, onClick: doLogout }, t('logout'))
        : null,
      // 「保存配置」出现条件：**仅调试态**。
      // 默认态地址框与账密框均已只读，无任何可保存项 —— 保持「默认只能一键登录」
      // 的 UI 收敛（设计文档 §5.2 / §13.2）。addrDirty 在默认态恒 false，不再作为条件。
      allowPassword
        ? el('button', { className: 'hm_btn', type: 'button', disabled: busy, onClick: saveConfig }, t('save'))
        : null,
      el('button', { className: 'hm_btn', type: 'button', disabled: busy, onClick: doSync }, busy ? t('syncing') : t('sync')),
    ),
    pending ? el('p', { className: 'hm_message' }, t('loggingIn')) : null,
    message !== null ? el('p', { className: 'hm_message', 'data-error': message.indexOf(t('error')) === 0 ? 'true' : undefined }, message) : null,

    el('h3', null, t('mcpTitle')),
    mcpServers.length === 0 && activeNames.length === 0
      ? el('p', { className: 'hm_message' }, t('empty'))
      : el('ul', { className: 'hm_list' },
        mcpServers.map((mm) => {
          if (sourceFilter !== 'ALL' && (mm.source || 'COMMUNITY') !== sourceFilter) return null
          const active = activeNames.indexOf(mm.name) >= 0
          return el('li', { className: 'hm_item', key: mm.name },
            el('div', { className: 'hm_itemTop' },
              el('span', { className: 'hm_name' }, mm.name),
              sourceTag(mm),
              el('span', { className: 'hm_tag', 'data-ok': active ? 'true' : undefined }, active ? '已接入' : '未连接'),
            ),
            mm.description ? el('p', { className: 'hm_desc' }, mm.description) : null,
          )
        }),
      ),

    el('h3', null, t('skillTitle')),
    el('div', { className: 'hm_row' },
      el('button', { className: 'hm_btn', type: 'button', 'data-active': sourceFilter === 'ALL' ? 'true' : undefined, onClick: () => setSourceFilter('ALL') }, t('filterAll')),
      el('button', { className: 'hm_btn', type: 'button', 'data-active': sourceFilter === 'OFFICIAL' ? 'true' : undefined, onClick: () => setSourceFilter('OFFICIAL') }, t('filterOfficial')),
      el('button', { className: 'hm_btn', type: 'button', 'data-active': sourceFilter === 'COMMUNITY' ? 'true' : undefined, onClick: () => setSourceFilter('COMMUNITY') }, t('filterCommunity')),
    ),
    publishedSkills.length === 0
      ? el('p', { className: 'hm_message' }, t('empty'))
      : el('ul', { className: 'hm_list' },
        publishedSkills.map((sk) => {
          if (sourceFilter !== 'ALL' && (sk.source || 'COMMUNITY') !== sourceFilter) return null
          const done = isInstalled(sk)
          return el('li', { className: 'hm_item', key: sk.productId },
            el('div', { className: 'hm_itemTop' },
              el('span', { className: 'hm_name' }, sk.name),
              sourceTag(sk),
              el('button', { className: 'hm_btn', type: 'button', disabled: busy || done, onClick: () => installSkill(sk.productId) }, done ? t('installed') : t('install')),
            ),
            sk.description ? el('p', { className: 'hm_desc' }, sk.description) : null,
            overrideBlock(sk),
          )
        }),
      ),

    el('h3', null, t('publishTitle')),
    el('p', { className: 'hm_message' }, t('publishHint')),
    el('div', { className: 'hm_row' },
      ['pm', 'dev', 'qa', 'leader', 'newbie', 'secretary', 'general'].map(function (j) {
        return el('button', { className: 'hm_btn', type: 'button', disabled: busy, key: j, onClick: () => publishMyJob(j) }, t('publish') + '：' + j)
      }),
    ),

    state.status === 'error' ? el('p', { className: 'hm_message', 'data-error': 'true' }, t('error') + '：' + state.error) : null,
  )
}

export function apply(ctx) {
  ctx.effect(function () { return ctx.locale.register(NS, { zh, en }) }, 'himarket: dictionaries')
  const t = ctx.locale.bind(NS)
  injectCss()
  // 设置页侧栏一级入口（与 dsh-matrix-agent「数字分身」同 slot：settings.section）。
  ctx.slots.inject('settings.section', function () {
    return ctx.slots.register({
      name: 'settings.section',
      id: 'himarket',
      order: 40,
      label: () => t('tab'),
      locale: NS,
      inject: () => ({ t }),
    }, HimarketTab)
  })
}
