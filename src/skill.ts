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
import { isPresetPackage, installPreset, defaultPresetRoot, PRESET_ID, PRESET_COMPOSITION } from './preset.js'
import type { PresetInstallResult } from './preset.js'

const execFileAsync = promisify(execFile)

/** skill 名称合法性（dsh-skill-filesystem 要求 kebab-case）。 */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u

/** 排除名单：不属于 skill 组成、不该落进 skills/ 目录的文件。
 *  岗位包 zip 根同时含 SKILL.md（→ skills/）与 agent.cordis.yml + preset.yml +
 *  伴随文件（→ .agent-presets/，由 installPreset 处理）。skill 落盘只拷技能侧文件
 *  （SKILL.md 保留），排除岗位 preset 侧文件——否则 skills/<name> 会被
 *  agent.cordis.yml/preset.yml/tool-restrict.mjs 污染成岗位包而非纯技能目录。 */
const SKIP_SKILL_FILES = new Set(['agent.cordis.yml', 'preset.yml', 'tool-restrict.mjs', 'package.json', 'README.md'])

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

/**
 * 解压 ZIP 到目标目录。
 *
 * ⚠️ Windows 必须用系统自带 bsdtar（C:\Windows\System32\tar.exe），不能用 PATH 上的 tar：
 * 若用户装了 Git for Windows / MSYS，PATH 里的 GNU tar 会把 `C:\...` 当成「远程主机 C」，
 * 报 `tar: Cannot connect to C: resolve failed`。bsdtar 原生支持 zip 与 Windows 路径。
 */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  let tarBin = 'tar'
  if (process.platform === 'win32') {
    const winTar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    if (existsSync(winTar)) tarBin = winTar
  }
  try {
    await execFileAsync(tarBin, ['-xf', zipPath, '-C', destDir], { timeout: 120000, windowsHide: true })
  } catch (e) {
    // GNU tar 会把 Windows 盘符当远程主机 → 明确报错，便于定位（而非抛出难懂的 tar 报错）
    const msg = String((e as { stderr?: string })?.stderr ?? (e as Error).message)
    if (msg.includes('Cannot connect to')) {
      throw new Error(
        `解压失败：PATH 上的 tar 是 GNU tar（不认 Windows 路径）。` +
          `请确认系统自带 ${join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')} 存在。原始错误：${msg.trim()}`,
      )
    }
    throw e
  }
}

/** 防 zip-slip：确保展开后的路径仍在 root 内。 */
function isWithin(root: string, target: string): boolean {
  const r = resolve(root)
  const t = resolve(target)
  return t === r || t.startsWith(r + sep)
}

/** 安全拷贝 skill 目录内容到目标目录（逐文件，忽略符号链接）。
 *  排除岗位 preset 侧文件（agent.cordis.yml/preset.yml/tool-restrict.mjs 等），
 *  保证 skills/<name> 是纯技能目录。 */
async function copyTreeSafe(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  const entries = await readdir(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    if (SKIP_SKILL_FILES.has(entry.name)) continue
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
 * 包结构（2026-09-13 起支持分层结构，对齐 dsh 官方 cordis preset）：
 *
 *   A. 岗位包（含 agent.cordis.yml + skills/）
 *      SKILL.md                 根层清单（跳过）
 *      agent.cordis.yml         → .agent-presets/<id>/
 *      preset.yml               → .agent-presets/<id>/
 *      skills/<name>/SKILL.md   → .agent-presets/<id>/skills/   ← 随 preset 走（preset 层）
 *      伴随文件（tool-restrict.mjs）→ .agent-presets/<id>/
 *
 *      skills/ 随 preset 走的原因：agent.cordis.yml 用 customSkillDirs 指向
 *      preset 内的 skills/，注册进 preset 自己的层 → 岗位间隔离，且员工可在
 *      project 层（<项目>/.dsh/skills/）同名覆盖而不被岗位更新冲掉。
 *
 *   B. 独立技能包（仅 SKILL.md 或 <name>/SKILL.md）
 *      → ~/.dsh/skills/<name>/（global 层，所有岗位可见）
 *
 * 兼容旧岗位包（根层 SKILL.md 且无 skills/）：仍落全局 skills/，行为不变。
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

    // 定位包根：根层有 agent.cordis.yml（岗位包）或 SKILL.md（技能包）；
    // 否则退到第一层含 SKILL.md 的子目录（兼容打成 <name>/... 的包）。
    let pkgRoot = unpackDir
    if (!existsSync(join(unpackDir, 'SKILL.md')) && !existsSync(join(unpackDir, PRESET_COMPOSITION))) {
      const subs = await readdir(unpackDir, { withFileTypes: true })
      const found = subs.find(
        (d) => d.isDirectory() && (existsSync(join(unpackDir, d.name, 'SKILL.md'))
          || existsSync(join(unpackDir, d.name, PRESET_COMPOSITION))),
      )
      if (found === undefined) {
        throw new Error('技能包内未找到 SKILL.md 或 agent.cordis.yml（根或第一层子目录）')
      }
      pkgRoot = join(unpackDir, found.name)
    }

    const isPreset = existsSync(join(pkgRoot, PRESET_COMPOSITION))
    const pkgSkillsDir = join(pkgRoot, 'skills')
    const hasLayeredSkills = existsSync(pkgSkillsDir)

    // ── 岗位包：技能随 preset 走（含安装侧重组）──
    if (isPreset && hasLayeredSkills) {
      // 岗位 id 取根层 SKILL.md 的 frontmatter name，退回产品名
      let presetId = await skillNameFromFrontmatter(join(pkgRoot, 'SKILL.md'))
      if (presetId === undefined) {
        const raw = basename(productId).toLowerCase().replace(/[^a-z0-9-]/gu, '-').replace(/^-+|-+$/gu, '')
        presetId = SKILL_NAME_PATTERN.test(raw) ? raw : `job-${raw}`.slice(0, 64)
      }
      if (!PRESET_ID.test(presetId)) throw new Error(`岗位 id「${presetId}」不合法`)

      // ⚠️ 安装侧重组（Nacos 布局 → dsh 布局）
      //
      // Nacos 侧（上传/存储/下载）：
      //   SKILL.md                        岗位技能入口（根层，Nacos 规范化的目标位置）
      //   skills/<job>-references/*.md    岗位资源（按岗位命名的目录）
      //   skills/<shared>.md              共享技能（平铺）
      //
      // dsh 侧（discoverRoot 要求）：
      //   skills/<job>/SKILL.md           目录包入口（discoverRoot 只认 <dir>/SKILL.md）
      //   skills/<job>/references/*.md    资源（resourceBase = skills/<job>/ 隔离）
      //   skills/<shared>.md              不变
      //
      // 重组的必要性：
      //   ① Nacos 会把技能入口规范化到**包根层**，目录包布局在 Nacos 侧不成立
      //   ② dsh 的 discoverRoot 只扫 skills/ 的**直接子项**，根层 SKILL.md 扫不到
      //   → 两边要求冲突，只能在安装时把根层 SKILL.md 搬进 skills/<job>/
      //
      // ⚠️ 顺序：installPreset 会 rm -rf 目标目录，所以**必须先调它**，
      //    再做重组（否则重组结果会被删掉）。
      const presetRootDir = presetRoot ?? defaultPresetRoot()

      // 1. preset 组成 + 共享技能（installPreset 整拷 skills/）
      const preset = await installPreset(pkgRoot, presetId, presetRootDir)

      // 2. 岗位技能入口：根层 SKILL.md → skills/<job>/SKILL.md
      const rootSkill = join(pkgRoot, 'SKILL.md')
      if (!existsSync(rootSkill)) {
        throw new Error('岗位包缺根层 SKILL.md（Nacos 侧技能入口）')
      }
      const destSkills = join(preset.dir, 'skills')
      const jobSkillDir = join(destSkills, presetId)
      await mkdir(jobSkillDir, { recursive: true })
      await copyFile(rootSkill, join(jobSkillDir, 'SKILL.md'))

      // 3. 岗位资源：skills/<job>-references/*.md → skills/<job>/references/*.md
      let refCount = 0
      const refSrcDir = join(pkgSkillsDir, `${presetId}-references`)
      if (existsSync(refSrcDir)) {
        const refDestDir = join(jobSkillDir, 'references')
        await mkdir(refDestDir, { recursive: true })
        for (const f of await readdir(refSrcDir, { withFileTypes: true })) {
          if (!f.isFile()) continue
          await copyFile(join(refSrcDir, f.name), join(refDestDir, f.name))
          refCount++
        }
      }
      // 清掉落盘目录里按岗位命名的临时资源目录（内容已重组进 skills/<job>/references/）
      // ⚠️ 要清的是 **落盘后** 的 skills/<job>-references/（installPreset 整拷过来的），
      //    不是源包里的 —— 源在临时目录，会被 finally 清掉。
      const stagedRefDir = join(destSkills, `${presetId}-references`)
      if (existsSync(stagedRefDir)) {
        await rm(stagedRefDir, { recursive: true, force: true })
      }

      return {
        ok: true,
        name: presetId,
        dir: preset.dir,
        note:
          `已安装岗位「${presetId}」：preset + 岗位技能（含 ${refCount} 个 references）` +
          ` → ${preset.dir}（技能随 preset 层，其他岗位不可见）`,
        preset,
      }
    }

    // ── 独立技能包（或旧结构岗位包）：落全局 skills/ ──
    let skillSrc = pkgRoot
    if (!(await hasSkillMd(pkgRoot))) {
      const subs = await readdir(pkgRoot, { withFileTypes: true })
      const found = subs.find((d) => d.isDirectory() && existsSync(join(pkgRoot, d.name, 'SKILL.md')))
      if (found === undefined) throw new Error('技能包内未找到 SKILL.md（根或第一层子目录）')
      skillSrc = join(pkgRoot, found.name)
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

    // 旧结构岗位包（根层 SKILL.md + agent.cordis.yml，无 skills/）：额外落盘 preset
    let preset: PresetInstallResult | undefined
    if (isPreset) {
      preset = await installPreset(pkgRoot, skillName, presetRoot ?? defaultPresetRoot())
    }

    return {
      ok: true,
      name: skillName,
      dir: dest,
      note: preset !== undefined
        ? `已安装岗位「${skillName}」（旧结构）：技能 → ${dest}；岗位 preset → ${preset.dir}`
        : `已安装技能「${skillName}」到 ${dest}`,
      preset,
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}
