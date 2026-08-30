/**
 * 回归测试：attachSettings 的 save/current 闭包捕获 bug。
 *
 * 根因：attachSettings 内部用 ctx.inject（异步）等 settings 服务就绪后才给
 * save 赋真实实现；若 return 时直接 `save`（按值捕获），则返回对象里的 save
 * 永远是空函数，save-config 变成 no-op。
 * 修复：return 用箭头函数包裹（save: (p) => save(p)），运行时读最新闭包值。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// 直接加载编译产物里的 attachSettings，验证闭包行为。
import { attachSettings, NAMESPACE } from '../lib/settings.js'

test('attachSettings 的 save 在 inject 回调后仍可用（闭包捕获回归）', async () => {
  const calls = []
  // 模拟 settings 服务：register 立即返回 scope，update 记录调用。
  const fakeSettingsService = {
    register(ns, schema, options) {
      calls.push(['register', ns, options])
      let stored = { ...(options?.base ?? {}) }
      return {
        get: () => stored,
        watch: () => () => {},
        update: async (patch) => {
          calls.push(['update', patch])
          stored = { ...stored, ...patch }
        },
        replace: async () => {},
      }
    },
  }

  // 模拟 ctx.inject：把 callback 存起来，稍后手动触发（模拟 settings 就绪）。
  let injectCallback = null
  const fakeCtx = {
    get: () => undefined,
    logger: { warn: () => {} },
    inject(deps, callback) {
      assert.deepEqual(deps, ['settings'])
      injectCallback = callback
    },
  }

  const fallback = { baseUrl: '', username: '', password: '', token: '', skillInstallDir: '' }

  // 关键：attachSettings 需要一个可解析 schemastery 的 baseUrl。
  // 但这里我们 fake 掉 settings 服务的 register 就不需要真正 schemastery——
  // 不过 attachSettings 内部会 requireOfficial('@deepseek-ai/schemastery', baseUrl)。
  // 用真实全局 dsh 里的 schemastery（createRequire 从 profile 目录解析）。
  const baseUrl = 'file:///C:/Users/niukl/.dsh/profiles/web/'

  const handle = attachSettings(fakeCtx, fallback, baseUrl)

  // 此时 inject 回调还没触发，save 应是 no-op（但不等同于 bug 的"永久 no-op"）。
  await handle.save({ baseUrl: 'http://before' })
  assert.equal(calls.filter((c) => c[0] === 'update').length, 0, 'inject 前 save 应 no-op')

  // 模拟 settings 服务就绪：触发 inject 回调，但 scope.get('settings') 需要返回 fake 服务。
  // 用 fakeCtx.get 返回 fakeSettingsService。
  fakeCtx.get = (name) => (name === 'settings' ? fakeSettingsService : undefined)
  const scope = { get: fakeCtx.get }
  injectCallback(scope)

  // 现在 save 应该真正写入。
  await handle.save({ baseUrl: 'http://ai-market.ict.cmcc', username: 'user', password: 'pwd' })

  const updates = calls.filter((c) => c[0] === 'update')
  assert.equal(updates.length, 1, 'inject 后 save 应调用 update 一次')
  assert.equal(updates[0][1].baseUrl, 'http://ai-market.ict.cmcc')

  // current 也应读到新值。
  const cur = handle.current()
  assert.equal(cur.baseUrl, 'http://ai-market.ict.cmcc')
  assert.equal(cur.username, 'user')
})

test('attachSettings 在 settings 服务缺失时回退 fallback 且 save no-op', async () => {
  let injectCallback = null
  const fakeCtx = {
    get: () => undefined,
    logger: { warn: () => {} },
    inject(deps, callback) { injectCallback = callback },
  }
  const fallback = { baseUrl: 'http://fb', username: '', password: '', token: '', skillInstallDir: '' }
  const handle = attachSettings(fakeCtx, fallback, 'file:///x/')

  // 触发 inject，但 scope.get('settings') 返回 undefined（服务缺失）。
  injectCallback({ get: () => undefined })

  assert.equal(handle.current().baseUrl, 'http://fb')
  await handle.save({ baseUrl: 'http://x' }) // no-op，不抛
  assert.equal(handle.current().baseUrl, 'http://fb')
})

void NAMESPACE
