/**
 * 单元测试：环境地址守卫（设计文档 §13）。
 *
 * 背景：HiMarket 地址 / 包装层地址是**服务端统一下发**的系统级配置 ——
 * launcher `env_defaults.rs` 的 FORCE_OVERRIDE_KEYS 明确含这两个键，语义是
 * 「服务端有值就强制覆盖本地」。所以用户本地改了也无效（下次同步即被覆盖）。
 *
 * 因此默认态必须**拒绝**对这两个键的写入。为什么不能只改 UI：save-config 是
 * 本机 HTTP 端点，同机任意进程可直接 POST 绕过浏览器端只读。故 host 侧用
 * splitAddressPatch 纯函数设防，本测试即覆盖它的语义。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { splitAddressPatch, ADDRESS_KEYS } from '../lib/domain.js'

test('ADDRESS_KEYS 精确覆盖两个服务端下发键', () => {
  assert.deepEqual([...ADDRESS_KEYS], ['baseUrl', 'gatewayUrl'])
})

test('调试关闭：地址键被拒，其余字段放行', () => {
  const patch = {
    baseUrl: 'http://evil.example',
    gatewayUrl: 'http://evil.example',
    username: 'user',
    password: 'pw',
  }
  const { allowed, rejected } = splitAddressPatch(patch, false)

  // 两个地址键都被拒 —— 这是守卫的核心
  assert.deepEqual(rejected.sort(), ['baseUrl', 'gatewayUrl'])
  // 关键：被拒的键**绝不能**出现在 allowed 里（否则守卫形同虚设）
  assert.equal('baseUrl' in allowed, false, 'baseUrl 不得写入')
  assert.equal('gatewayUrl' in allowed, false, 'gatewayUrl 不得写入')
  // 非地址字段正常放行
  assert.equal(allowed.username, 'user')
  assert.equal(allowed.password, 'pw')
})

test('调试关闭：只提交地址 → allowed 为空（全拒）', () => {
  const { allowed, rejected } = splitAddressPatch({ baseUrl: 'http://x' }, false)
  assert.deepEqual(Object.keys(allowed), [])
  assert.deepEqual(rejected, ['baseUrl'])
})

test('调试关闭：不含地址字段 → 无拒绝，全部放行', () => {
  const patch = { username: 'user', password: 'pw', portalId: 'p1' }
  const { allowed, rejected } = splitAddressPatch(patch, false)
  assert.deepEqual(rejected, [])
  assert.deepEqual(allowed, patch)
})

test('调试开启：地址键放行（研发/运维调试场景）', () => {
  const patch = { baseUrl: 'http://127.0.0.1:8083', gatewayUrl: 'http://127.0.0.1:3091' }
  const { allowed, rejected } = splitAddressPatch(patch, true)
  assert.deepEqual(rejected, [])
  assert.deepEqual(allowed, patch)
})

test('调试开启：空 patch 也不出错（边界）', () => {
  const { allowed, rejected } = splitAddressPatch({}, true)
  assert.deepEqual(rejected, [])
  assert.deepEqual(allowed, {})
})

test('调试关闭：空 patch 也不出错（边界）', () => {
  const { allowed, rejected } = splitAddressPatch({}, false)
  assert.deepEqual(rejected, [])
  assert.deepEqual(allowed, {})
})

test('大小写敏感：BaseUrl 不是合法地址键（不会被误拒/误放）', () => {
  // 守卫按精确键名匹配；大小写变体不属地址键，走正常放行路径
  // （host 侧只从 body 读取小写键名，故此处仅锁定语义不漂移）
  const { allowed, rejected } = splitAddressPatch({ BaseUrl: 'http://x' }, false)
  assert.deepEqual(rejected, [])
  assert.equal(allowed.BaseUrl, 'http://x')
})
