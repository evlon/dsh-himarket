/**
 * 真实数据验证：用 launcher 真实的 sync-state.json 与 settings.yaml，
 * 验证来源判定结果与实际相符（不是造数据，是读本机真实文件）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readServerEnvDefaults, classifyField } from '../lib/provenance.js'

const LAUNCHER_HOME = join(homedir(), '.dsh-launcher')
const server = readServerEnvDefaults(LAUNCHER_HOME)

console.log('=== 服务端实际下发（来自 ' + LAUNCHER_HOME + '\\sync-state.json）===')
console.log('available =', server.available)
console.log('lastSyncAt =', server.lastSyncAt || '(无)')
console.log('himarket.baseUrl    =', JSON.stringify(server.values['himarket.baseUrl'] ?? ''))
console.log('himarket.gatewayUrl =', JSON.stringify(server.values['himarket.gatewayUrl'] ?? ''))
if (server.note) console.log('note =', server.note)

// 读 launcher 的 settings.yaml（服务端下发会落到这里）
let yamlBase = '', yamlGw = ''
try {
  const txt = readFileSync(join(LAUNCHER_HOME, 'settings.yaml'), 'utf8')
  const m = txt.match(/^himarket:\n((?:[ \t]+.*\n?)*)/m)
  if (m) {
    const b = m[1].match(/^\s+baseUrl:\s*(.+)$/m)
    const g = m[1].match(/^\s+gatewayUrl:\s*(.+)$/m)
    if (b) yamlBase = b[1].trim().replace(/^["']|["']$/g, '')
    if (g) yamlGw = g[1].trim().replace(/^["']|["']$/g, '')
  }
} catch (e) { console.log('settings.yaml 读取失败:', e.message) }

console.log('\n=== 实际生效值（来自 ' + LAUNCHER_HOME + '\\settings.yaml）===')
console.log('baseUrl    =', JSON.stringify(yamlBase))
console.log('gatewayUrl =', JSON.stringify(yamlGw))

const BUILTIN_BASE = 'http://market.ai.ict.cmcc'
const BUILTIN_GW = 'http://job.ai.ict.cmcc'

console.log('\n=== 判定结果 ===')
const pb = classifyField(server, 'himarket', 'baseUrl', yamlBase, BUILTIN_BASE)
const pg = classifyField(server, 'himarket', 'gatewayUrl', yamlGw, BUILTIN_GW)
console.log('baseUrl    →', pb.origin, JSON.stringify(pb))
console.log('gatewayUrl →', pg.origin, JSON.stringify(pg))

console.log('\n=== 交叉核对（判定是否与实际相符）===')
let bad = 0
function chk(name, cond) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name)
  if (!cond) bad++
}
chk('服务端确实下发了 baseUrl → 判定不应是 BUILTIN_DEFAULT',
  server.values['himarket.baseUrl'] === '' || pb.origin !== 'BUILTIN_DEFAULT')
chk('服务端下发值与生效值一致 → 应为 SERVER',
  server.values['himarket.baseUrl'] === '' || pb.origin === 'SERVER')
chk('serverValue 与 sync-state 里的原始值逐字一致',
  pb.serverValue === (server.values['himarket.baseUrl'] ?? ''))
console.log(bad === 0 ? '\n全部一致 ✅' : `\n${bad} 项不一致 ❌`)
process.exit(bad === 0 ? 0 : 1)
