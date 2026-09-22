/**
 * 回归测试：启动恢复门禁 bug（2026-09-22）。
 *
 * 根因（两重）：
 *   ① 触发时机：apply() 同步读 settings.current()，但 attachSettings 用 ctx.inject
 *      **异步**等 settings 就绪 → 此刻只读到 fallback（token/username/password 全空）
 *      → 门禁 `baseUrl && username && password` 恒假 → 恢复永不执行。
 *   ② 判定条件：即使用时序修好，`username && password` 会挡掉 v0.1.7 起的 token-only
 *      SSO（只写 token+username，不写 password）。
 *
 * 修复：新增 settings.onReady（句柄就绪事件）驱动恢复；判定改用 hasCredentials。
 *
 * 现象特征（3090 实测）：/himarket/state 里 mcpServers=[] 且 lastError="" 且日志零输出
 * —— 三者同时成立只有「代码根本没进入 if」能解释。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { attachSettings, hasCredentials } from '../lib/settings.js'

/**
 * 造临时 @deepseek-ai/schemastery 假模块，让 requireOfficial 可解析 ——
 * 不依赖本机 dsh profile 路径（CI/Linux 上无 C:/Users/.../.dsh），环境无关。
 */
function makeFakeSchemasteryDir() {
  const dir = mkdtempSync(join(tmpdir(), 'himarket-schema-'))
  const pkgDir = join(dir, 'node_modules', '@deepseek-ai', 'schemastery')
  mkdirSync(pkgDir, { recursive: true })
  const fake = `\
function str() {
  const s = (v) => (v === undefined ? '' : v)
  s.default = (d) => (s.dv = d, s)
  return s
}
function bool() {
  const b = (v) => (v === undefined ? false : v)
  b.default = (d) => (b.dv = d, b)
  return b
}
function obj(fields) {
  const o = (v) => (v === undefined ? {} : v)
  o.default = (d) => (o.dv = d, o)
  return o
}
module.exports = { string: str, boolean: bool, object: obj }
`
  writeFileSync(join(pkgDir, 'index.js'), fake)
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0-fake', main: 'index.js' }))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const FALLBACK = { baseUrl: '', username: '', password: '', token: '', skillInstallDir: '' }

/** 造 fake ctx + 可控的 settings 服务（inject 回调手动触发）。 */
function makeCtx() {
  let injectCallback = null
  let stored = {}
  const fakeSettingsService = {
    register(ns, schema, options) {
      stored = { ...(options?.base ?? {}) }
      return {
        get: () => stored,
        watch: () => () => {},
        update: async (patch) => { stored = { ...stored, ...patch } },
        replace: async () => {},
      }
    },
  }
  const ctx = {
    get: () => undefined,
    logger: { warn: () => {}, info: () => {} },
    inject(deps, callback) { injectCallback = callback },
  }
  return {
    ctx,
    fakeSettingsService,
    /** 模拟 settings 服务就绪：触发 inject 回调。 */
    settle(available = true) {
      ctx.get = (name) => (name === 'settings' && available ? fakeSettingsService : undefined)
      injectCallback({ get: ctx.get })
    },
    setStored(next) { stored = { ...stored, ...next } },
  }
}

function baseUrlFor(fake) {
  return pathToFileURL(join(fake.dir, 'node_modules', '@deepseek-ai', 'schemastery', 'index.js')).href
}

test('onReady 在 settings 就绪前不触发，就绪后恰好触发一次', () => {
  const fake = makeFakeSchemasteryDir()
  try {
    const { ctx, settle } = makeCtx()
    const handle = attachSettings(ctx, FALLBACK, baseUrlFor(fake))

    let fired = 0
    handle.onReady(() => { fired++ })
    assert.equal(fired, 0, 'inject 回调触发前 onReady 不应执行')

    settle()
    assert.equal(fired, 1, 'settings 就绪后应恰好触发一次')
  } finally {
    fake.cleanup()
  }
})

test('settings 就绪后新注册的 onReady 回调立即执行', () => {
  const fake = makeFakeSchemasteryDir()
  try {
    const { ctx, settle } = makeCtx()
    const handle = attachSettings(ctx, FALLBACK, baseUrlFor(fake))
    settle()

    let fired = 0
    handle.onReady(() => { fired++ })
    assert.equal(fired, 1, '已就绪时 onReady 应立即执行')
  } finally {
    fake.cleanup()
  }
})

test('settings 服务缺失（降级）时 onReady 仍触发一次 —— 单一路径无特例', () => {
  const fake = makeFakeSchemasteryDir()
  try {
    const { ctx, settle } = makeCtx()
    const handle = attachSettings(ctx, FALLBACK, baseUrlFor(fake))

    let fired = 0
    handle.onReady(() => { fired++ })
    settle(false) // scope.get('settings') 返回 undefined → 走降级分支

    assert.equal(fired, 1, '降级路径也必须触发（调用方自行用 hasCredentials 判定）')
    // 降级时读 fallback：无凭据 → 调用方不应恢复。这是正确行为，不是失败。
    assert.equal(hasCredentials(handle.current()), false)
  } finally {
    fake.cleanup()
  }
})

test('⭐ token-only（v0.1.7 SSO）必须被 hasCredentials 认可', () => {
  // 启动器一键登录只写 token + username，不写 password。
  const tokenOnly = { baseUrl: 'https://market.ai.ict.cmcc', token: 'jwt-abc', username: 'niukunliang', password: '' }
  assert.equal(hasCredentials(tokenOnly), true, 'token-only 是合法登录态，不能被门禁挡掉')

  // 旧门禁的写法（复现 bug 判定）：token-only 下恒假 → 这正是缺陷 ②。
  const oldGate = tokenOnly.baseUrl.trim() !== '' && tokenOnly.username.trim() !== '' && tokenOnly.password.trim() !== ''
  assert.equal(oldGate, false, '旧门禁在 token-only 下必然为假（证明缺陷 ② 真实存在）')
})

test('⭐ 复现缺陷 ①：apply() 时刻的 fallback 必然过不了门禁', () => {
  // attachSettings 的 fallback 由 index.ts 构造：baseUrl 有值（domain 默认），
  // 但 token/username/password 全空 —— 即 apply() 同步读到的值。
  const atApplyTime = { ...FALLBACK, baseUrl: 'https://market.ai.ict.cmcc' }

  assert.equal(hasCredentials(atApplyTime), false, 'apply() 时刻无凭据 → hasCredentials 为假')

  const oldGate = atApplyTime.baseUrl.trim() !== '' && atApplyTime.username.trim() !== '' && atApplyTime.password.trim() !== ''
  assert.equal(oldGate, false, '旧门禁在 apply() 时刻必然为假 → 恢复永不执行（缺陷 ① 的机制）')
})

test('账密模式与都缺失时的 hasCredentials 语义', () => {
  const pwdMode = { baseUrl: 'https://x', token: '', username: 'u', password: 'p' }
  assert.equal(hasCredentials(pwdMode), true, '账密齐全 → 可用')

  const nothing = { baseUrl: 'https://x', token: '', username: 'u', password: '' }
  assert.equal(hasCredentials(nothing), false, '只有 username 无 token 无 password → 不可用')

  const noBase = { baseUrl: '', token: 'jwt', username: 'u', password: '' }
  assert.equal(hasCredentials(noBase), false, 'baseUrl 为空 → 不可用（无论有无 token）')
})

test('onReady 与既有 save/current 闭包行为共存不回归', async () => {
  const fake = makeFakeSchemasteryDir()
  try {
    const { ctx, settle } = makeCtx()
    const handle = attachSettings(ctx, FALLBACK, baseUrlFor(fake))

    // inject 前 save 应为 no-op
    await handle.save({ baseUrl: 'http://before' })
    assert.equal(handle.current().baseUrl, '', 'inject 前 current 仍读 fallback')

    let readyFired = 0
    handle.onReady(() => { readyFired++ })
    settle()

    assert.equal(readyFired, 1)
    // 就绪后 save/current 必须照常工作（settings-closure 回归）
    await handle.save({ baseUrl: 'https://market.ai.ict.cmcc', token: 'jwt-1' })
    assert.equal(handle.current().baseUrl, 'https://market.ai.ict.cmcc')
    assert.equal(hasCredentials(handle.current()), true, '就绪后写入的 token 应立即可见')
  } finally {
    fake.cleanup()
  }
})

test('onReady 回调抛错不影响其它回调（隔离性）', () => {
  const fake = makeFakeSchemasteryDir()
  try {
    const { ctx, settle } = makeCtx()
    const handle = attachSettings(ctx, FALLBACK, baseUrlFor(fake))

    let second = 0
    handle.onReady(() => { throw new Error('boom') })
    handle.onReady(() => { second++ })

    settle()
    assert.equal(second, 1, '前一个回调抛错不应阻断后一个')
  } finally {
    fake.cleanup()
  }
})
