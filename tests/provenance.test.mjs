/**
 * 单元测试：配置来源判定（2026-09-21 UE 改造）。
 *
 * 背景：只读框原先笼统写「环境地址由服务端统一下发」，但该断言**可能为假**
 * —— 服务端未下发时，值其实来自插件内置默认（且两者可能不同：内置
 * `http://market.ai.ict.cmcc` vs 服务端 `https://market.ai.ict.cmcc`）。
 *
 * 用户反馈原话：「如果写着"有服务器下发"，有些地方不让填了，那就应该是空的。
 * 如果服务器下发成功了，应该就显示下发成功的值，也就是实际值是什么。」
 *
 * 故本模块的职责是**如实区分来源**，让 UI 能说明白，而不是笼统断言。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyField, readServerEnvDefaults, harnessHome } from '../lib/provenance.js'

/** 造一个「服务端下发了某值」的记录。 */
function serverWith(pairs, lastSyncAt = '2026-09-21T03:43:00Z') {
  return { available: true, values: { ...pairs }, lastSyncAt, note: '' }
}

/** 造一个「读不到同步记录」的记录。 */
function serverUnavailable() {
  return { available: false, values: {}, lastSyncAt: '', note: 'not found' }
}

test('服务端下发了且生效值相同 → SERVER（名副其实）', () => {
  const p = classifyField(
    serverWith({ 'himarket.baseUrl': 'https://market.ai.ict.cmcc' }),
    'himarket', 'baseUrl', 'https://market.ai.ict.cmcc', 'http://market.ai.ict.cmcc',
  )
  assert.equal(p.origin, 'SERVER')
  assert.equal(p.serverValue, 'https://market.ai.ict.cmcc')
  assert.equal(p.effectiveValue, 'https://market.ai.ict.cmcc')
})

test('服务端下发了但本地值不同 → SERVER_DRIFT（尚未被覆盖）', () => {
  const p = classifyField(
    serverWith({ 'himarket.baseUrl': 'https://market.ai.ict.cmcc' }),
    'himarket', 'baseUrl', 'http://127.0.0.1:8083', 'http://market.ai.ict.cmcc',
  )
  assert.equal(p.origin, 'SERVER_DRIFT')
  assert.equal(p.serverValue, 'https://market.ai.ict.cmcc')
})

test('⭐ 服务端未下发、值等于内置默认 → BUILTIN_DEFAULT（不得谎称服务端下发）', () => {
  // 这是本次 UE 反馈的核心场景：界面上写着「服务端下发」，其实是插件自己兜的
  const p = classifyField(
    serverWith({}), 'himarket', 'baseUrl', 'http://market.ai.ict.cmcc', 'http://market.ai.ict.cmcc',
  )
  assert.equal(p.origin, 'BUILTIN_DEFAULT')
  assert.equal(p.serverValue, '', '服务端没下发 → serverValue 必须为空')
})

test('服务端未下发、值为本地自定义 → LOCAL', () => {
  const p = classifyField(
    serverWith({}), 'himarket', 'baseUrl', 'http://my-own.example', 'http://market.ai.ict.cmcc',
  )
  assert.equal(p.origin, 'LOCAL')
})

test('服务端未下发、值为空 → UNSET', () => {
  const p = classifyField(serverWith({}), 'himarket', 'baseUrl', '', 'http://market.ai.ict.cmcc')
  assert.equal(p.origin, 'UNSET')
})

test('⭐ 读不到同步记录（非 launcher 启动）→ UNKNOWN，绝不猜成 SERVER', () => {
  const p = classifyField(serverUnavailable(), 'himarket', 'baseUrl', 'http://x.example', 'http://market.ai.ict.cmcc')
  assert.equal(p.origin, 'UNKNOWN')
})

test('读不到同步记录且值为空 → 仍判 UNSET（空是确定的）', () => {
  const p = classifyField(serverUnavailable(), 'himarket', 'baseUrl', '', 'http://market.ai.ict.cmcc')
  assert.equal(p.origin, 'UNSET')
})

test('无内置默认（空串）时，非空本地值判 LOCAL 而非 BUILTIN_DEFAULT', () => {
  const p = classifyField(serverWith({}), 'himarket', 'gatewayUrl', 'http://job.example', '')
  assert.equal(p.origin, 'LOCAL')
})

test('服务端下发值带首尾空格 → 归一化后仍判 SERVER（不因空格误报漂移）', () => {
  const p = classifyField(
    serverWith({ 'himarket.baseUrl': 'https://market.ai.ict.cmcc' }),
    'himarket', 'baseUrl', '  https://market.ai.ict.cmcc  ', '',
  )
  assert.equal(p.origin, 'SERVER')
})

test('classifyField 带回 lastSyncAt（UI 要显示"最近同步"）', () => {
  const p = classifyField(
    serverWith({ 'himarket.baseUrl': 'https://a' }, '2026-09-21T03:43:00Z'),
    'himarket', 'baseUrl', 'https://a', '',
  )
  assert.equal(p.lastSyncAt, '2026-09-21T03:43:00Z')
})

test('readServerEnvDefaults：文件不存在 → available=false 且不抛异常', () => {
  const r = readServerEnvDefaults('Z:\\definitely\\not\\a\\real\\dir\\nope')
  assert.equal(r.available, false)
  assert.deepEqual(r.values, {})
  assert.ok(r.note.length > 0, '应给出诊断说明')
})

test('readServerEnvDefaults：真实 launcher home 可读（若存在）→ 键形状为 ns.key', () => {
  const r = readServerEnvDefaults(harnessHome())
  if (!r.available) {
    // 非 launcher 环境（如开发实例）允许读不到，但必须给出说明
    assert.ok(r.note.length > 0)
    return
  }
  for (const k of Object.keys(r.values)) {
    assert.ok(k.includes('.'), `键应为 namespace.key 形状，实际 ${k}`)
  }
  assert.equal(typeof r.lastSyncAt, 'string')
})

test('harnessHome：DSH_HOME 优先，缺省回退 ~/.dsh', () => {
  assert.equal(harnessHome({ DSH_HOME: 'D:\\custom-home' }), 'D:\\custom-home')
  assert.ok(harnessHome({}).endsWith('.dsh'))
  // 空白串视为未设置（与 preset.ts/skill.ts 的既有约定一致）
  assert.ok(harnessHome({ DSH_HOME: '   ' }).endsWith('.dsh'))
})
