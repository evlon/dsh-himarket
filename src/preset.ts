/**
 * 岗位包（agent-preset package）落盘：识别 HiMarket skill ZIP 里夹带的
 * `agent.cordis.yml` + `preset.yml`（+ preset 伴随文件如 tool-restrict.mjs），
 * 把它们落到 harness home 的 `~/.dsh/.agent-presets/<id>/`，
 * 由 @deepseek-ai/dsh-agent-presets 扫描发现。
 *
 * 岗位包结构（打包侧见 dsh-job-market/scripts/build-job-package.mjs）：
 *   SKILL.md          根 skill（name=岗位 id，description 带 [岗位包] 前缀）→ 归 skill 侧
 *   agent.cordis.yml  常驻人设 + 请示工作流
 *   preset.yml        显示名 / 描述 / 排序
 *   tool-restrict.mjs 等伴随文件（agent.cordis.yml 用 name: './xxx' 相对引用）
 *
 * 本模块只落 preset 组成（排除 SKILL.md 等 skill 侧文件），随 agent.cordis.yml
 * 相对引用的伴随文件一并拷入，保证 preset 插件可加载。
 *
 * 落盘后无需重启：agent-presets 的 discovery 每次调用重读 roots，落盘即被发现。
 *
 * @module dsh-himarket/preset
 */

import { mkdir, rm, copyFile, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 岗位 preset 目录相对 harness home 的名字（与 dsh-agent-presets 的 USER_PRESET_DIR 一致）。 */
const USER_PRESET_DIR = '.agent-presets'

/** preset id 合法性（与 dsh-agent-presets 的 PRESET_ID 一致）。 */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/** 岗位包 marker 文件：存在即视为岗位包。 */
const PRESET_COMPOSITION = 'agent.cordis.yml'

/** 默认 harness home（DSH_HOME 优先）。 */
function dshHome(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/** 岗位 preset 落盘根（~/.dsh/.agent-presets）。 */
export function defaultPresetRoot(): string {
  return join(dshHome(), USER_PRESET_DIR)
}

/** 岗位包安装结果。 */
export interface PresetInstallResult {
  ok: boolean
  id: string
  dir: string
  note: string
}

/** 判断一个解压目录是否为岗位包（含 agent.cordis.yml）。 */
export async function isPresetPackage(unpackDir: string): Promise<boolean> {
  try {
    await readFile(join(unpackDir, PRESET_COMPOSITION), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 排除名单：不属于 preset 组成、不该落进 preset 目录的文件。 */
const SKIP_PRESET_FILES = new Set(['SKILL.md', 'package.json', 'README.md'])

/** 安全拷贝目录内容到目标（逐文件递归，忽略符号链接与 node_modules/点文件）。 */
async function copyTreeSafe(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  const entries = await readdir(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const src = join(srcDir, entry.name)
    const dest = join(destDir, entry.name)
    if (entry.isDirectory()) {
      await copyTreeSafe(src, dest)
    } else if (entry.isFile()) {
      await copyFile(src, dest)
    }
  }
}

/**
 * 把岗位包落盘为 preset：agent.cordis.yml + preset.yml + 伴随文件 → ~/.dsh/.agent-presets/<id>/。
 * @param unpackDir - 解压后的岗位包根（含 agent.cordis.yml）
 * @param id - preset id（目录名），取 SKILL.md frontmatter 的 name 或产品名
 * @param presetRoot - preset 落盘根，默认 ~/.dsh/.agent-presets
 */
export async function installPreset(
  unpackDir: string,
  id: string,
  presetRoot: string,
): Promise<PresetInstallResult> {
  if (!PRESET_ID.test(id)) {
    throw new Error(`岗位 id「${id}」不合法（需小写字母/数字/连字符）`)
  }

  const root = presetRoot.trim() === '' ? defaultPresetRoot() : presetRoot
  const dest = join(root, id)

  // 幂等重装：先删旧目录，再整拷 preset 组成（agent.cordis.yml + preset.yml + 伴随文件如
  // tool-restrict.mjs），排除 SKILL.md 等 skill 侧文件（由 installSkill 落到 skills/）。
  await mkdir(root, { recursive: true })
  await rm(dest, { recursive: true, force: true })
  const entries = await readdir(unpackDir, { withFileTypes: true })
  for (const entry of entries) {
    if (SKIP_PRESET_FILES.has(entry.name)) continue
    const src = join(unpackDir, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyTreeSafe(src, destPath)
    } else if (entry.isFile()) {
      await mkdir(dest, { recursive: true })
      await copyFile(src, destPath)
    }
  }

  return {
    ok: true,
    id,
    dir: dest,
    note: `已安装岗位「${id}」到 ${dest}`,
  }
}
