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
  subtitle: '填一次地址和账号，点「同步」，就能在对话里用上公司上架的 MCP 工具和技能。',
  configTitle: '① 连接配置',
  baseUrlLabel: 'HiMarket 地址',
  baseUrlPlaceholder: '例如 http://ai-market.ict.cmcc',
  usernameLabel: '用户名',
  usernamePlaceholder: '开发者账号用户名',
  passwordLabel: '密码',
  passwordPlaceholder: '开发者账号密码',
  save: '保存配置',
  saved: '已保存',
  sync: '同步能力',
  syncing: '同步中…',
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
  gatewayPlaceholder: '如 http://ai-job.ict.cmcc，发布与来源标签都走它',
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
  subtitle: 'Configure once, sync, and use subscribed MCP tools and skills in chat.',
  configTitle: '1. Connection',
  baseUrlLabel: 'HiMarket URL',
  usernameLabel: 'Username',
  passwordLabel: 'Password',
  save: 'Save',
  saved: 'Saved',
  sync: 'Sync',
  syncing: 'Syncing…',
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
  gatewayPlaceholder: 'e.g. http://ai-job.ict.cmcc; publishing and source tags go through it',
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

  function saveConfig() {
    setBusy(true)
    var patch = { baseUrl, username, password, gatewayUrl }
    call('/himarket/save-config', patch)
      .then(function () { setMessage(t('saved')); setBusy(false); refresh() },
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
      el('label', null, t('baseUrlLabel')),
      el('input', { className: 'hm_input', type: 'text', placeholder: t('baseUrlPlaceholder'), value: baseUrl, onChange: (e) => setBaseUrl(e.target.value) }),
    ),
    el('div', { className: 'hm_field' },
      el('label', null, t('usernameLabel')),
      el('input', { className: 'hm_input', type: 'text', placeholder: t('usernamePlaceholder'), value: username, onChange: (e) => setUsername(e.target.value) }),
    ),
    el('div', { className: 'hm_field' },
      el('label', null, t('passwordLabel')),
      el('input', { className: 'hm_input', type: 'password', placeholder: t('passwordPlaceholder'), value: password, onChange: (e) => setPassword(e.target.value) }),
    ),
    el('div', { className: 'hm_field' },
      el('label', null, t('gatewayLabel')),
      el('input', { className: 'hm_input', type: 'text', placeholder: t('gatewayPlaceholder'), value: gatewayUrl, onChange: (e) => setGatewayUrl(e.target.value) }),
    ),
    el('div', { className: 'hm_row' },
      el('button', { className: 'hm_btn', type: 'button', disabled: busy, onClick: saveConfig }, t('save')),
      el('button', { className: 'hm_btn', type: 'button', 'data-primary': 'true', disabled: busy, onClick: doSync }, busy ? t('syncing') : t('sync')),
    ),
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
