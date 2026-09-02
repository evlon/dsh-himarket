/**
 * 端到端验证：从真实 HiMarket 下载 pm 岗位包 → installSkill → 验证落盘。
 * 跑法：node tests/e2e-job-preset.mjs
 * 前置：HiMarket 已运行，pm 岗位包已上架（PRODUCT_ID）。
 *
 * 必填环境变量（不落默认值，避免凭据/内网地址进仓库）：
 *   HIMARKET_BASE     HiMarket 后端直连地址
 *   HIMARKET_USER     开发者用户名
 *   HIMARKET_PASS     开发者密码
 *   HIMARKET_PRODUCT  岗位包 productId
 */

import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HimarketClient } from '../lib/himarket-client.js'
import { installSkill } from '../lib/skill.js'

function requireEnv(name) {
  const v = process.env[name]
  if (v === undefined || v.trim() === '') { console.error(`缺少必填环境变量 ${name}`); process.exit(1) }
  return v.trim()
}

const BASE = requireEnv('HIMARKET_BASE')
const USERNAME = requireEnv('HIMARKET_USER')
const PASSWORD = requireEnv('HIMARKET_PASS')
const PRODUCT_ID = requireEnv('HIMARKET_PRODUCT')

const tmp = await mkdtemp(join(tmpdir(), 'dsh-e2e-job-'))
const client = new HimarketClient({ baseUrl: BASE, username: USERNAME, password: PASSWORD })

console.log('=== 1. 登录 HiMarket（开发者账号）===')
const token = await client.login()
console.log(`登录成功，token 前 20 字符: ${token.slice(0, 20)}...`)

console.log('=== 2. 下载 pm 岗位包并安装 ===')
const installRoot = join(tmp, 'skills')
const presetRoot = join(tmp, 'presets')
const result = await installSkill(client, PRODUCT_ID, installRoot, presetRoot)
console.log(`安装结果: ${result.note}`)

console.log('=== 3. 验证落盘 ===')
const skillMd = await readFile(join(result.dir, 'SKILL.md'), 'utf8')
console.log(`skill 落盘: ${result.dir}`)
console.log(`  SKILL.md 含 [岗位包] 标识: ${skillMd.includes('[岗位包]')}`)
console.log(`  SKILL.md 含专项方法(需求澄清三步): ${skillMd.includes('需求澄清三步')}`)

if (result.preset) {
  console.log(`preset 落盘: ${result.preset.dir}`)
  const composition = await readFile(join(result.preset.dir, 'agent.cordis.yml'), 'utf8')
  console.log(`  agent.cordis.yml 含 persona: ${composition.includes('persona')}`)
  console.log(`  agent.cordis.yml 含请示工作流: ${composition.includes('matrix_request_owner_decision')}`)
  const meta = await readFile(join(result.preset.dir, 'preset.yml'), 'utf8')
  console.log(`  preset.yml 含显示名: ${meta.includes('产品经理数字员工')}`)
  const files = await readdir(result.preset.dir)
  console.log(`  preset 目录文件: ${files.join(', ')}`)
} else {
  console.log('❌ 未识别为岗位包（preset 为空）')
  process.exit(1)
}

console.log('\n=== 端到端验证通过 ===')
console.log(`临时目录: ${tmp}`)
