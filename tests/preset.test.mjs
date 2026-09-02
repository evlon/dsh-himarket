/**
 * 岗位包安装测试：installSkill 识别夹带 agent.cordis.yml 的岗位包，
 * 同时落盘 SKILL.md → skills/ 和 preset → .agent-presets/。
 * 跑法：node --test tests/preset.test.mjs（依赖已编译的 lib/）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { installSkill } from '../lib/skill.js'
import { defaultPresetRoot } from '../lib/preset.js'
import { HimarketClient } from '../lib/himarket-client.js'

const execFileAsync = promisify(execFile)

/** 构造一个「假 HiMarket 客户端」：downloadSkill 返回本地 zip 字节。 */
function fakeClient(zipPath) {
  const fetchFn = async () => {
    const bytes = await readFile(zipPath)
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({}),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  }
  return new HimarketClient({ baseUrl: 'http://x', username: 'u', password: 'p', fetchFn })
}

/** 打一个 zip（在 pkgDir 内打相对路径）。 */
async function zipDir(pkgDir, zipPath) {
  await execFileAsync('tar', ['-a', '-cf', zipPath, '-C', pkgDir, '.'], { windowsHide: true })
}

test('installSkill 识别岗位包并分别落盘 preset 与 skill', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-job-preset-'))
  const pkgDir = join(tmp, 'pkg')
  await mkdir(pkgDir, { recursive: true })
  await writeFile(join(pkgDir, 'SKILL.md'), '---\nname: pm\ndescription: [岗位包] 产品经理数字员工\n---\n\n# body\n')
  await writeFile(join(pkgDir, 'agent.cordis.yml'), '- id: persona\n  name: persona\n')
  await writeFile(join(pkgDir, 'preset.yml'), 'name: 产品经理数字员工\norder: 10\n')

  const zipPath = join(tmp, 'pm.zip')
  await zipDir(pkgDir, zipPath)

  const installRoot = join(tmp, 'skills')
  const presetRoot = join(tmp, 'presets')
  const c = fakeClient(zipPath)
  const result = await installSkill(c, 'prod-pm', installRoot, presetRoot)

  assert.equal(result.ok, true)
  assert.equal(result.name, 'pm')
  assert.ok(result.preset, '岗位包应有 preset 结果')
  assert.equal(result.preset.id, 'pm')

  // skill 落盘
  const skillMd = await readFile(join(result.dir, 'SKILL.md'), 'utf8')
  assert.match(skillMd, /name: pm/)

  // preset 落盘
  const presetDir = join(presetRoot, 'pm')
  const composition = await readFile(join(presetDir, 'agent.cordis.yml'), 'utf8')
  assert.match(composition, /persona/)
  const meta = await readFile(join(presetDir, 'preset.yml'), 'utf8')
  assert.match(meta, /产品经理数字员工/)
})

test('installSkill 对普通 skill 不落 preset', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-job-plain-'))
  const pkgDir = join(tmp, 'pkg')
  await mkdir(pkgDir, { recursive: true })
  await writeFile(join(pkgDir, 'SKILL.md'), '---\nname: plain-skill\n---\n\n# body\n')

  const zipPath = join(tmp, 'plain.zip')
  await zipDir(pkgDir, zipPath)

  const installRoot = join(tmp, 'skills')
  const presetRoot = join(tmp, 'presets')
  const c = fakeClient(zipPath)
  const result = await installSkill(c, 'prod-plain', installRoot, presetRoot)

  assert.equal(result.ok, true)
  assert.equal(result.preset, undefined, '普通 skill 不应有 preset')
})

test('defaultPresetRoot 尊重 DSH_HOME', () => {
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = 'C:/custom/dsh'
  assert.equal(defaultPresetRoot(), join('C:/custom/dsh', '.agent-presets'))
  if (saved === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = saved
})
