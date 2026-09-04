/**
 * 岗位包发布：把本机已迭代的岗位（preset 目录 + skill 目录）合成 HiMarket 岗位包 zip。
 *
 * 同事在本地迭代后，岗位散落两处：
 *   - ~/.dsh/.agent-presets/<job>/  → agent.cordis.yml + preset.yml + 伴随文件（tool-restrict.mjs 等）
 *   - ~/.dsh/skills/<job>/          → SKILL.md（岗位专项方法）
 *
 * 发布包的布局与 install 时落盘互逆：根目录同时含 SKILL.md + agent.cordis.yml +
 * preset.yml + 伴随文件。HiMarket 侧把 SKILL.md 当技能、其余当 preset 落盘（见 skill.ts/preset.ts）。
 *
 * 打包用系统 bsdtar（与 build-job-package.mjs 一致），保证 Windows 路径可用。
 *
 * @module dsh-himarket/publish
 */

import { mkdtemp, mkdir, rm, readdir, copyFile, writeFile, readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { defaultPresetRoot } from './preset.js'
import { defaultSkillRoot } from './skill.js'

const execFileAsync = promisify(execFile)

/** job 名合法性（与 dsh-agent-presets 的 PRESET_ID 一致）。 */
const JOB_ID = /^[a-z0-9][a-z0-9-]*$/

/** 岗位包 marker。 */
const PRESET_COMPOSITION = 'agent.cordis.yml'
const SKILL_MD = 'SKILL.md'

/** 默认 harness home（DSH_HOME 优先）。 */
function dshHome(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/** 防 zip-slip。 */
function isWithin(root: string, target: string): boolean {
  const r = resolve(root)
  const t = resolve(target)
  return t === r || t.startsWith(r + sep)
}

/** 安全递归拷贝（忽略 node_modules/点文件，逐文件）。 */
async function copyTreeSafe(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  const entries = await readdir(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const src = join(srcDir, entry.name)
    const dest = join(destDir, entry.name)
    if (!isWithin(destDir, dest)) continue
    if (entry.isDirectory()) {
      await copyTreeSafe(src, dest)
    } else if (entry.isFile()) {
      await copyFile(src, dest)
    }
  }
}

export interface PublishPackageResult {
  /** 产品名（= job id，HiMarket 产品名唯一）。 */
  name: string
  /** 生成的 zip 路径（临时目录，调用方 publish 后由调用方清理）。 */
  zipPath: string
  /** 临时 stage 根（调用方清理用）。 */
  stageRoot: string
  note: string
}

/**
 * 把本机「已迭代岗位」打包成 HiMarket 岗位包 zip。
 *
 * @param job 岗位 id（用于定位 .agent-presets/<job> 与 skills/<job>）
 * @param opts.presetRoot 岗位 preset 根，默认 ~/.dsh/.agent-presets
 * @param opts.skillRoot 技能根，默认 ~/.dsh/skills
 */
export async function packageLocalJob(
  job: string,
  opts: { presetRoot?: string; skillRoot?: string } = {},
): Promise<PublishPackageResult> {
  if (!JOB_ID.test(job)) throw new Error(`岗位 id「${job}」不合法（需小写字母/数字/连字符）`)

  const presetRoot = opts.presetRoot?.trim() !== '' && opts.presetRoot ? opts.presetRoot : defaultPresetRoot()
  const skillRoot = opts.skillRoot?.trim() !== '' && opts.skillRoot ? opts.skillRoot : defaultSkillRoot()
  const presetDir = join(presetRoot, job)
  const skillDir = join(skillRoot, job)

  // 校验：preset 侧至少要有 agent.cordis.yml；skill 侧至少要有 SKILL.md。
  let presetStat
  try {
    presetStat = await stat(join(presetDir, PRESET_COMPOSITION))
  } catch {
    presetStat = undefined
  }
  if (presetStat === undefined) {
    throw new Error(`本机未找到岗位「${job}」的 preset（缺 ${presetDir}/${PRESET_COMPOSITION}）。请先安装或迭代该岗位。`)
  }
  let skillStat
  try {
    skillStat = await stat(join(skillDir, SKILL_MD))
  } catch {
    skillStat = undefined
  }
  if (skillStat === undefined) {
    throw new Error(`本机未找到岗位「${job}」的技能（缺 ${skillDir}/${SKILL_MD}）。`)
  }

  // stage 根：preset 目录内容（除 SKILL.md 等 skill 侧文件外）整拷到 stageRoot 根，
  // 再补 skill 侧的 SKILL.md。注意：文件必须打平到 zip 根目录（无 <job>/ 子层），
  // 否则 HiMarket 会把顶层目录名当产品标识、SKILL.md 被单独抽取、其余文件落到
  // 「.」目录导致展示 404、下载包也缺文件（已实测：pm/secretary 包因此异常）。
  const home = dshHome()
  const stageRoot = await mkdtemp(join(tmpdir(), `dsh-himarket-pub-${job}-`))

  // 1) preset 侧：拷贝 agent.cordis.yml + preset.yml + 伴随文件（覆盖式）。
  await copyTreeSafe(presetDir, stageRoot)

  // 2) skill 侧：把 SKILL.md 落到 stage 根（若 preset 侧也有同名 SKILL.md，技能侧优先）。
  await copyFile(join(skillDir, SKILL_MD), join(stageRoot, SKILL_MD))

  // 3) 打包为 zip（bsdtar 处理 Windows 路径 + 保证 zip 内相对路径打平到根）。
  const zipPath = join(stageRoot, `${job}.zip`)
  let tarBin = 'tar'
  if (process.platform === 'win32') {
    const winTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    try {
      await stat(winTar)
      tarBin = winTar
    } catch {}
  }
  // 用「列出文件」而非「.」作为打包源，避免 zip 内出现 ./ 顶层目录项
  // （HiMarket 会把 ./ 项当成「.」目录，导致其他文件 404、下载包缺失）。
  const entries = (await readdir(stageRoot)).filter((n) => n !== `${job}.zip`)
  await execFileAsync(tarBin, ['-a', '-cf', zipPath, '-C', stageRoot, ...entries], { timeout: 120000, windowsHide: true })

  const zipBytes = await readFile(zipPath)
  return {
    name: job,
    zipPath,
    stageRoot,
    note: `已打包岗位「${job}」：${stageRoot}（preset + skill 合并打平到根）→ ${zipPath}（${zipBytes.length} 字节）`,
  }
}
