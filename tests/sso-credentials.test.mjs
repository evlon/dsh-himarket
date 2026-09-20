/**
 * 单元测试：SSO（token-only）凭据判定与缓存失效指纹。
 *
 * 背景：启动器「一键登录」把 developer token 写进 settings.yaml（外部进程写入），
 * 插件必须满足两件事：
 *   ① 只有 token、没有用户名/密码时，也判定为「已配置」；
 *   ② token 变化时丢弃缓存的 client（HimarketClient 构造时快照 token）。
 * 这两个纯函数是上述行为的地基，故单独覆盖。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { hasCredentials, credentialsFingerprint, NAMESPACE } from '../lib/settings.js'

const base = { baseUrl: 'http://market.ai.ict.cmcc', username: '', password: '', token: '' }

test('hasCredentials：SSO 模式（仅 token）视为已配置', () => {
  assert.equal(hasCredentials({ ...base, token: 'tok-abc' }), true)
})

test('hasCredentials：账密模式（无 token）视为已配置', () => {
  assert.equal(hasCredentials({ ...base, username: 'user', password: 'pw' }), true)
})

test('hasCredentials：两种模式都没有 → 未配置', () => {
  assert.equal(hasCredentials(base), false)
  // 只有用户名、缺密码 → 未配置
  assert.equal(hasCredentials({ ...base, username: 'user' }), false)
  // 只有密码、缺用户名 → 未配置
  assert.equal(hasCredentials({ ...base, password: 'pw' }), false)
})

test('hasCredentials：baseUrl 为空时一律未配置', () => {
  assert.equal(hasCredentials({ ...base, baseUrl: '', token: 'tok' }), false)
  assert.equal(hasCredentials({ ...base, baseUrl: '   ', token: 'tok' }), false)
})

test('hasCredentials：空白 token 不算登录（避免写入空串被误判）', () => {
  assert.equal(hasCredentials({ ...base, token: '   ' }), false)
})

test('credentialsFingerprint：token 变化必然改变指纹（触发缓存失效）', () => {
  const a = credentialsFingerprint({ ...base, token: 'tok-1' })
  const b = credentialsFingerprint({ ...base, token: 'tok-2' })
  assert.notEqual(a, b, 'token 变化必须改变指纹，否则插件会一直用旧 token')
})

test('credentialsFingerprint：相同凭据指纹稳定', () => {
  const s = { ...base, token: 'tok-1', username: 'u' }
  assert.equal(credentialsFingerprint(s), credentialsFingerprint({ ...s }))
})

test('credentialsFingerprint：分隔符避免字段拼接歧义', () => {
  // ("ab","c") 与 ("a","bc") 不能撞指纹
  const x = credentialsFingerprint({ baseUrl: 'ab', token: 'c', username: '', password: '' })
  const y = credentialsFingerprint({ baseUrl: 'a', token: 'bc', username: '', password: '' })
  assert.notEqual(x, y)
})

void NAMESPACE
