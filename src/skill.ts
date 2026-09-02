/**
 * Skill 安装：下载 HiMarket 的 Skill ZIP → 解压 → 定位 SKILL.md → 落盘到
 * ~/.dsh/skills/<name>/。技能由 @deepseek-ai/dsh-skill-filesystem 扫描发现，
 * 写入即生效（该插件有 watcher + fs 工具同步失效），无需重启。
 *
 * 解压用系统 bsdtar（Windows/macOS 自带，Linux 也默认有 tar），避免引入原生
 * 依赖；先落临时目录，校验通过后再搬到目标目录，失败不污染已装内容。
 *
 * @module dsh-himarket/skill
 */

import { mkdtemp, mkdir, rm, readdir, copyFile, readFile, writeFile } from 'node:fs/promises'
import { join, basename, resolve, sep } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { HimarketClient } from './himarket-client.js'
import { isPresetPackage, installPreset, defaultPresetRoot } from './preset.js'
import type { PresetInstallResult } from './preset.js'

const execFileAsync = promisify(execFile)

/** skill 名称合法性（dsh-skill-filesystem 要求 kebab-case）。 */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u

/** 默认安装根：~/.dsh/skills（DSH_HOME 优先）。 */
export function defaultSkillRoot(): string {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'skills')
}

/** 从 SKILL.md frontmatter 提取 name（kebab-case），失败返回 undefined。 */
async function skillNameFromFrontmatter(skillMdPath: string): Promise<string | undefined> {
  try {
    const text = await readFile(skillMdPath, 'utf8')
    const m = text.match(/^name:\s*([a-z0-9][a-z0-9-]{0,63})\s*$/mu)
    return m?.[1]
  } catch {
    return undefined
  }
}

/** 判断目录是否为 skill 根（含 SKILL.md）。 */
async function hasSkillMd(dir: string): Promise<boolean> {
  try {
    await readFile(join(dir, 'SKILL.md'), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 解压 ZIP 到目标目录（系统 bsdtar；多平台可用）。 */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await execFileAsync('tar', ['-xf', zipPath, '-C', destDir], { timeout: 120000, windowsHide: true })
}

/** 防 zip-slip：确保展开后的路径仍在 root 内。 */
function isWithin(root: string, target: string): boolean {
  const r = resolve(root)
  const t = resolve(target)
  return t === r || t.startsWith(r + sep)
}

/** 安全拷贝 skill 目录内容到目标目录（逐文件，忽略符号链接）。 */
async function copyTreeSafe(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  const entries = await readdir(srcDir, { withFileTypes: true })
  for (const entry of entries) {
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

export interface SkillInstallResult {
  ok: boolean
  name: string
  dir: string
  note: string
  /** 岗位包安装结果（仅当该 skill 是岗位包时非空）。 */
  preset?: PresetInstallResult
}

/**
 * 安装一个 Skill（按 productId 下载 ZIP → 定位 SKILL.md → 落盘）。
 * 已装同名 skill 会被覆盖（幂等重装）；失败时保留旧版。
 *
 * 若 ZIP 是岗位包（含 agent.cordis.yml），额外把 preset 落盘到
 * ~/.dsh/.agent-presets/<id>/，SKILL.md 仍落 ~/.dsh/skills/<id>/。
 */
export async function installSkill(
  client: HimarketClient,
  productId: string,
  installRoot: string,
  presetRoot?: string,
): Promise<SkillInstallResult> {
  const root = installRoot.trim() === '' ? defaultSkillRoot() : installRoot
  const bytes = await client.downloadSkill(productId)

  const tmp = await mkdtemp(join(tmpdir(), 'dsh-himarket-skill-'))
  try {
    const zipPath = join(tmp, 'pkg.zip')
    const unpackDir = join(tmp, 'unpack')
    await mkdir(unpackDir, { recursive: true })
    await writeFile(zipPath, bytes)
    await extractZip(zipPath, unpackDir)

    let skillSrc = unpackDir
    if (!(await hasSkillMd(unpackDir))) {
      const subs = await readdir(unpackDir, { withFileTypes: true })
      const found = subs.find((d) => d.isDirectory() && existsSync(join(unpackDir, d.name, 'SKILL.md')))
      if (found === undefined) {
        throw new Error('技能包内未找到 SKILL.md（根或第一层子目录）')
      }
      skillSrc = join(unpackDir, found.name)
    }

    let skillName = await skillNameFromFrontmatter(join(skillSrc, 'SKILL.md'))
    if (skillName === undefined) {
      const raw = basename(productId).toLowerCase().replace(/[^a-z0-9-]/gu, '-').replace(/^-+|-+$/gu, '')
      skillName = SKILL_NAME_PATTERN.test(raw) ? raw : `skill-${raw}`.slice(0, 64)
    }
    if (!SKILL_NAME_PATTERN.test(skillName)) {
      throw new Error(`技能名「${skillName}」不合法（需 kebab-case）`)
    }

    const dest = join(root, skillName)
    await mkdir(root, { recursive: true })
    await rm(dest, { recursive: true, force: true })
    await copyTreeSafe(skillSrc, dest)

    // 岗位包：额外落盘 preset
    let preset: PresetInstallResult | undefined
    if (await isPresetPackage(skillSrc)) {
      preset = await installPreset(
        skillSrc,
        skillName,
        presetRoot ?? defaultPresetRoot(),
      )
    }

    return {
      ok: true,
      name: skillName,
      dir: dest,
      note: preset !== undefined
        ? `已安装岗位「${skillName}」：技能 → ${dest}；岗位 preset → ${preset.dir}`
        : `已安装技能「${skillName}」到 ${dest}`,
      preset,
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}
