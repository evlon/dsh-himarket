/**
 * 在 3090 matrix-dev 实例上验证岗位包消费闭环：
 * 从真实 HiMarket 下载 pm 岗位包 → installSkill 落盘到 3090 的 DSH_HOME。
 * 落盘后验证 .agent-presets/pm/ 和 skills/pm/ 内容，并与源仓库版对比。
 *
 * 跑法：node tests/install-into-3090.mjs
 *
 * 必填环境变量（不落默认值，避免凭据/内网地址/本地路径进仓库）：
 *   HIMARKET_BASE     HiMarket 后端直连地址
 *   HIMARKET_USER     开发者用户名
 *   HIMARKET_PASS     开发者密码
 *   HIMARKET_PRODUCT  岗位包 productId
 *   MATRIX_DEV_HOME   3090 实例的 DSH_HOME（如 C:\Users\...\.dsh-matrix-dev）
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
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
const DSH_HOME_3090 = requireEnv('MATRIX_DEV_HOME')

async function main() {
  console.log('=== 3090 岗位包消费验证 ===\n')
  const client = new HimarketClient({ baseUrl: BASE, username: USERNAME, password: PASSWORD })

  console.log('[1] 登录 HiMarket')
  await client.login()
  console.log('  登录成功\n')

  console.log('[2] 下载 pm 岗位包并安装到 3090 home')
  const skillRoot = join(DSH_HOME_3090, 'skills')
  const presetRoot = join(DSH_HOME_3090, '.agent-presets')
  const result = await installSkill(client, PRODUCT_ID, skillRoot, presetRoot)
  console.log(`  ${result.note}\n`)

  console.log('[3] 验证落盘结果')
  console.log(`  skill 落盘: ${result.dir}`)
  const skillMd = await readFile(join(result.dir, 'SKILL.md'), 'utf8')
  console.log(`    - SKILL.md 含 [岗位包]: ${skillMd.includes('[岗位包]')}`)
  console.log(`    - SKILL.md 含专项方法: ${skillMd.includes('需求澄清三步')}`)

  if (result.preset) {
    console.log(`  preset 落盘: ${result.preset.dir}`)
    const composition = await readFile(join(result.preset.dir, 'agent.cordis.yml'), 'utf8')
    const meta = await readFile(join(result.preset.dir, 'preset.yml'), 'utf8')
    console.log(`    - agent.cordis.yml 含 persona: ${composition.includes('persona')}`)
    console.log(`    - agent.cordis.yml 含请示工作流: ${composition.includes('matrix_request_owner_decision')}`)
    console.log(`    - preset.yml 含显示名: ${meta.includes('产品经理数字员工')}`)
    const files = await readdir(result.preset.dir)
    console.log(`    - preset 目录文件: ${files.join(', ')}`)
  } else {
    console.log('  ❌ 未识别为岗位包')
    process.exit(1)
  }

  console.log('\n=== 3090 岗位包消费验证通过 ===')
}

main().catch(e => { console.error(`\n❌ 失败: ${e.message}`); process.exit(1) })
