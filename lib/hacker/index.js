/**
 * ys-pojia 演练台自举（host 半侧）
 *
 * 资产库、工具、预设、技能都在本插件目录内。本文件负责：
 *   1. 首次把 `presets/hacker` 落到 `$DSH_HOME/.agent-presets/hacker/`
 *   2. 随包技能落到 `$DSH_HOME/hacker/skills`，预设用 `dshHomePath` 指向它
 *   3. 已有用户预设时只修失效路径 / 旧包名，不整份覆盖
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPresetDefinition } from './preset-composition.js'
import { clearRoleCache } from './role-section.js'
import { scheduleClearOwnedSelectedDefault } from '../preset-default.js'
import { ensureAllProfileBodyInserts } from '../profile-insert.js'

/** Cordis 插件名。 */
export const name = 'ys-pojia-hacker'

/** 不硬依赖 agentPresets，就绪后软取并声明。 */
export const inject = []

/** 模式下拉里的预设 id（目录名 / registry id）。 */
const HACKER_PRESET_ID = 'hacker'

/**
 * 需要声明进宿主模式下拉的全部 preset id。
 *
 * 宿主（Web 0.1.7+）的模式下拉只认 `agentPresets.register()`，扫磁盘
 * `$DSH_HOME/.agent-presets` 不会被发现。所以每个 preset 都得在插件里
 * 主动注册一次，否则文件在盘上也看不见。
 */
const DECLARED_PRESET_IDS = ['hacker', 'unlimited', 'genesis']

/** 插件根目录（lib/hacker → 上两级）。 */
export function packagePaths() {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  return {
    root,
    presets: join(root, 'presets'),
    presetDir: join(root, 'presets', 'hacker'),
    skills: join(root, 'skills', 'hacker'),
    setupScript: join(root, 'scripts', 'hacker-setup.sh'),
  }
}

/** 环境数据目录（与 store/tools 用的同一份约定）。 */
export function hackerDataDir() {
  return join(userDshHome(), 'hacker')
}

/**
 * 把随包分发的环境安装脚本落到 `$DSH_HOME/hacker/setup.sh`。
 *
 * 市场包用户装完只有 node_modules，仓库不在盘上；预检若只说"从仓库取脚本"，
 * 用户拿不到脚本、首次引导就断了。所以脚本随包走，启动时落一份可执行的副本。
 * 语义：目标不存在 → 装；已存在但内容不同 → 覆盖（脚本无用户可改状态）；
 *       内容相同 → 不动（避免每次启动都写盘）。
 *
 * @returns `{ action: 'installed'|'updated'|'kept'|'missing', path }`
 */
export function installSetupScript() {
  const paths = packagePaths()
  const target = join(hackerDataDir(), 'setup.sh')
  if (!existsSync(paths.setupScript)) return { action: 'missing', path: target }
  let wanted
  try {
    wanted = readFileSync(paths.setupScript, 'utf8')
  } catch {
    return { action: 'missing', path: target }
  }
  try {
    mkdirSync(hackerDataDir(), { recursive: true })
    if (existsSync(target)) {
      let current
      try { current = readFileSync(target, 'utf8') } catch { current = '' }
      if (current === wanted) {
        /* 权限可能被外部改掉，这里顺手补回来（脚本要能直接 bash 执行） */
        try { chmodSync(target, 0o755) } catch { /* 忽略 */ }
        return { action: 'kept', path: target }
      }
      writeFileSync(target, wanted, { encoding: 'utf8', mode: 0o755 })
      return { action: 'updated', path: target }
    }
    writeFileSync(target, wanted, { encoding: 'utf8', mode: 0o755 })
    return { action: 'installed', path: target }
  } catch (error) {
    return { action: 'missing', path: target, error: error && error.message ? error.message : String(error) }
  }
}

/**
 * 用户 preset 根（与 dsh-agent-presets 的 USER_PRESET_DIR 保持一致）。
 *
 * 这里**不能**无脑信 `DSH_HOME`：本机实测该变量指向
 * `<DSH_HOME>`，而某些定制版 DS-YS 真正读写的
 * 是 `~/.dsh`。照着环境变量装，预设会落进一个
 * 宿主根本不看的地方，用户在模式下拉里永远看不到新加的三个模式。
 *
 * 判定顺序：
 *   1. `DSH_HOME` 且该目录下**已经有** `.agent-presets/` → 用它（宿主自己建过）
 *   2. `~/.dsh` 且该目录下已经有 `.agent-presets/` → 用它
 *   3. 两个都没有 → 信 `DSH_HOME`，没有就 `~/.dsh`（让首次安装自己建）
 *
 * 第 1、2 步的顺序是刻意的：环境变量能骗人，磁盘上的实际结构不会。
 */
export function userPresetRoot() {
  const envHome = String(process.env.DSH_HOME || '').trim()
  const unixHome = join(homedir(), '.dsh')
  const hasPresetDir = (home) => {
    if (!home) return false
    try {
      return existsSync(join(home, '.agent-presets'))
    } catch {
      return false
    }
  }
  if (envHome && hasPresetDir(envHome)) return join(envHome, '.agent-presets')
  if (hasPresetDir(unixHome)) return join(unixHome, '.agent-presets')
  return join(envHome || unixHome, '.agent-presets')
}

/**
 * 与 `userPresetRoot()` 同一套判定，但返回 home 本身。
 *
 * 供需要写 `$DSH_HOME/xxx.json` 的地方使用（引擎、规则集、模式声明）。
 * 和上面一样不信环境变量盲值，看磁盘实际结构。
 */
export function userDshHome() {
  const envHome = String(process.env.DSH_HOME || '').trim()
  const unixHome = join(homedir(), '.dsh')
  const looksLive = (home) => {
    if (!home) return false
    for (const marker of ['.agent-presets', 'plugins', 'profiles']) {
      try {
        if (existsSync(join(home, marker))) return true
      } catch {
        /* 试下一个 marker */
      }
    }
    return false
  }
  if (envHome && looksLive(envHome)) return envHome
  if (looksLive(unixHome)) return unixHome
  return envHome || unixHome
}

/**
 * 预设模板里技能目录的占位符（build.mjs 写进打包预设，落地时才替换）。
 * 扩展名等都不允许写成别的形式，否则替换会漏。
 */
const SKILLS_PLACEHOLDER = '{{HACKER_SKILLS_DIR}}'

/** customSkillDirs 里"像本包 skills/ 目录"的那一行（老的绝对路径 / 占位符都算）。 */
function isSkillsDirLine(line) {
  const text = line.trim().replace(/^-\s*/, '')
  if (text === SKILLS_PLACEHOLDER) return true
  return /[/\\](dsh-hacker-mode|hacker-bundle)[/\\]skills\/?$/.test(text)
    || /[/\\]vendor[/\\]hacker[/\\]skills\/?$/.test(text)
    || /[/\\]skills[/\\]hacker\/?$/.test(text)
}

/** 预设里随包技能那一行。加载时按当前 DSH_HOME 解析，不写本机绝对路径。 */
const BUNDLED_SKILLS_EXPR = "!!js dshHomePath('hacker/skills')"

/**
 * 把占位符或写死的本机路径改成 `dshHomePath('hacker/skills')`。
 *
 * 占位符留在 YAML 里会被解析成对象，整个预设挂不上。写死
 * `profiles/desktop/node_modules/...` 又只在这一台桌面安装上成立，
 * Web、另一台机器、换过安装位置都会指空。技能文件由 installBundledSkills
 * 放到 `$DSH_HOME/hacker/skills`。
 */
function renderSkillsDir(text) {
  if (text.includes(SKILLS_PLACEHOLDER)) {
    return { text: text.split(SKILLS_PLACEHOLDER).join(BUNDLED_SKILLS_EXPR), changed: true, reason: 'placeholder' }
  }
  let changed = false
  const out = text.split('\n').map((line) => {
    if (!isSkillsDirLine(line)) return line
    const indent = /^(\s*)/.exec(line)[1]
    const wanted = indent + '- ' + BUNDLED_SKILLS_EXPR
    if (line === wanted) return line
    changed = true
    return wanted
  }).join('\n')
  return { text: out, changed, reason: changed ? 'stale-path' : 'none' }
}

/**
 * 技能同步目标目录（第一个是主目标，其余是"顺手补一份"）。
 *
 * `$DSH_HOME` 有两个可能来源：插件进程的 `process.env.DSH_HOME || homedir()/.dsh`，
 * 与宿主 `dshHomePath()` 解析出的 home。换盘 / 换 profile / `HOME` 为空的机器上两者
 * 会分叉 —— 技能只落到一边，预设指向另一边时就是"装了却列不出来 / 显示不可用"。
 * 所以：主目标必写，另外那个候选 home 只要在本机真实存在就补一份（不凭空造 home）。
 */
function skillSyncTargets() {
  const homes = []
  const push = (p) => { if (p && !homes.includes(p)) homes.push(p) }
  push(process.env.DSH_HOME)
  push(join(homedir(), '.dsh'))
  const primary = join(hackerDataDir(), 'skills')
  const dirs = [primary]
  for (const home of homes) {
    if (!existsSync(home)) continue
    const dir = join(home, 'hacker', 'skills')
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  return dirs
}

/**
 * 把包内 `skills/hacker/*.md` 同步到 `$DSH_HOME/hacker/skills`（分叉时两个 home 都放一份）。
 * 同名文件按包内内容覆盖。用户自己的副本在 `$DSH_HOME/skills`，不在这里改。
 */
export function installBundledSkills() {
  const paths = packagePaths()
  const targets = skillSyncTargets()
  if (!existsSync(paths.skills)) return { action: 'missing', path: targets[0], copied: 0 }
  const files = readdirSync(paths.skills).filter((f) => f.endsWith('.md'))
  let copied = 0
  for (const target of targets) {
    mkdirSync(target, { recursive: true })
    for (const file of files) {
      const wanted = readFileSync(join(paths.skills, file))
      const dest = join(target, file)
      let same = false
      try { same = readFileSync(dest).equals(wanted) } catch { same = false }
      if (same) continue
      writeFileSync(dest, wanted)
      if (target === targets[0]) copied += 1
    }
  }
  return { action: copied > 0 ? 'updated' : 'kept', path: targets[0], copied, targets }
}

/** 旧组合会把整份预设标 broken（worker-thread 未装 / tools 硬依赖 hacker）。 */
function needsCompositionRepair(presetFile) {
  if (!existsSync(presetFile)) return true
  try {
    const text = readFileSync(presetFile, 'utf8')
    if (!text.includes('id: workflow-ptc')) return true
    if (/name:\s*'@deepseek-ai\/dsh-workflow-worker-thread'[\s\S]{0,80}?config:\s*\n\s*provider:\s*spawn/.test(text)
      && !/name:\s*'@deepseek-ai\/dsh-workflow-worker-thread'\s*\n\s*disabled:\s*true/.test(text)) {
      return true
    }
    return false
  } catch {
    return true
  }
}

/** 0.2.1 已废弃 toolFilter：旧用户预设里还留着就会让嘿客模式整份加载失败。 */
function stripToolFilter(text) {
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  let skipIndent = null
  let changed = false
  for (const line of lines) {
    if (skipIndent !== null) {
      const indent = (/^(\s*)/.exec(line) || ['', ''])[1].length
      if (line.trim() !== '' && indent > skipIndent) {
        changed = true
        continue
      }
      skipIndent = null
    }
    const block = /^(\s*)toolFilter:\s*(?:#.*)?$/.exec(line)
    if (block) {
      skipIndent = block[1].length
      changed = true
      continue
    }
    if (/^\s*toolFilter:\s+\S/.test(line)) {
      changed = true
      continue
    }
    out.push(line)
  }
  return { text: out.join('\n'), changed }
}

/** 从独立嘿客包迁进 ys-pojia 后，预设里的工具行包名要跟着改。 */
function renderToolsPackage(text) {
  if (!text.includes('dsh-hacker-mode/tools')) {
    return { text, changed: false }
  }
  return {
    text: text.split('dsh-hacker-mode/tools').join('ys-pojia/hacker/tools'),
    changed: true,
  }
}

/**
 * 自愈：指挥职责标题 + 在 Agent Teams profile 下强制重新启用 classic subagent。
 * 不整份覆盖用户预设，只改会让派活失败的几处。
 */
function repairDelegation(text) {
  let next = String(text || "")
  let changed = false
  if (next.includes("## 你是谁、你不做什么")) {
    next = next.split("## 你是谁、你不做什么").join("## 指挥职责（硬约束）")
    changed = true
  }
  const mark = "**必须用原生 `subagent` 工具派活**"
  if (next.includes("## 指挥职责") && !next.includes(mark)) {
    const needle = "`hacker_session_info`。"
    const at = next.indexOf(needle)
    if (at >= 0) {
      next =
        next.slice(0, at + needle.length) +
        "\n      " + mark +
        "；不要改用 Agent Teams 的 `spawn_teammate`（嘿客角色稿 / 并发闸门 / 叶子约束都挂在 `subagent` 路径上）。" +
        next.slice(at + needle.length)
      changed = true
    }
  }
  for (const id of [
    "tool-subagent-control",
    "tool-subagent-list-agents",
    "tool-subagent",
    "tool-subagent-fork",
  ]) {
    const idLine = `- id: ${id}`
    let from = 0
    while (from < next.length) {
      const at = next.indexOf(idLine, from)
      if (at < 0) break
      const endId = at + idLine.length
      const ch = next[endId] || "\n"
      // 避免 tool-subagent 误匹配 tool-subagent-control / fork / codex
      if (ch !== "\n" && ch !== "\r" && ch !== " " && ch !== "\t") {
        from = endId
        continue
      }
      const after = endId
      const rest = next.slice(after)
      const endRel = rest.search(/\n[ \t]*- id: /)
      const block = endRel < 0 ? rest : rest.slice(0, endRel)
      if (/disabled:\s*false/.test(block)) break
      if (/disabled:\s*true/.test(block)) {
        const patched = block.replace(/disabled:\s*true/, "disabled: false")
        next = next.slice(0, after) + patched + next.slice(after + block.length)
        changed = true
        break
      }
      const indentMatch = /\n([ \t]+)name:/.exec(block)
      const indent = indentMatch ? indentMatch[1] : "      "
      next = next.slice(0, after) + `\n${indent}disabled: false` + next.slice(after)
      changed = true
      break
    }
  }
  return { text: next, changed }
}

/** 包内锚点门相对预设模板的标记，用来给已有用户预设补一行，不整份覆盖。 */
const ANCHOR_ROW_MARK = '- id: anchor-gate'
const ANCHOR_BLOCK_START = '# 锚点门'
const HACKER_TOOLS_MARK = '- id: hacker-tools'

function anchorBlockBounds(ymlText) {
  const start = ymlText.indexOf(ANCHOR_BLOCK_START)
  const end = ymlText.indexOf(HACKER_TOOLS_MARK)
  if (start === -1 || end === -1 || start >= end) return null
  return { start, end }
}

function readAnchorBlockFromTemplate() {
  let template = ''
  try {
    template = readFileSync(join(packagePaths().presetDir, 'agent.cordis.yml'), 'utf8')
  } catch {
    return null
  }
  const bounds = anchorBlockBounds(template)
  if (!bounds) return null
  return template.slice(bounds.start, bounds.end).trim()
}

/**
 * 锚点门脚本每次用包内副本覆盖（没有用户可改状态）。
 * YAML 里锚点配置块与包内模板不一致时也会替换（bootstrapMaxTokens 等），其余 preset 正文保留。
 * @returns {'inserted'|'updated'|'config-updated'|'kept'|'missing'}
 */
function syncAnchorGate(targetDir) {
  const src = join(packagePaths().presetDir, 'anchor-gate.mjs')
  const dest = join(targetDir, 'anchor-gate.mjs')
  if (!existsSync(src)) return 'missing'
  mkdirSync(targetDir, { recursive: true })
  const wanted = readFileSync(src, 'utf8')
  let current = ''
  try { current = readFileSync(dest, 'utf8') } catch { current = '' }
  let script = 'kept'
  if (current !== wanted) {
    writeFileSync(dest, wanted, 'utf8')
    script = 'updated'
  }
  const presetFile = join(targetDir, 'agent.cordis.yml')
  if (!existsSync(presetFile)) return script
  let text
  try { text = readFileSync(presetFile, 'utf8') } catch { return script }
  const templateBlock = readAnchorBlockFromTemplate()
  if (!templateBlock) return script
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const rendered = templateBlock.replace(/\r\n/g, '\n').replace(/\n/g, nl)

  if (text.includes(ANCHOR_ROW_MARK)) {
    const bounds = anchorBlockBounds(text)
    if (!bounds) return script
    const currentBlock = text.slice(bounds.start, bounds.end).trim()
    if (currentBlock === rendered.trim()) return script
    const next = text.slice(0, bounds.start) + rendered + nl + nl + text.slice(bounds.end)
    writeFileSync(presetFile, next, 'utf8')
    return script === 'updated' ? 'updated' : 'config-updated'
  }

  const at = text.indexOf(HACKER_TOOLS_MARK)
  const next = at === -1
    ? text.replace(/\s*$/, '') + nl + nl + rendered + nl
    : text.slice(0, at) + rendered + nl + nl + text.slice(at)
  writeFileSync(presetFile, next, 'utf8')
  return 'inserted'
}

/**
 * 把包内预设落地到用户 preset 根。
 *
 * 语义（v0.9.0 起）：
 *   · 目标不存在 → 完整安装（占位符替换成真实路径）；
 *   · 目标已存在 → **默认不覆盖用户内容，但会自愈**：只要里面还留着
 *     `{{HACKER_SKILLS_DIR}}` 或写死的本机技能路径，就改成 `dshHomePath('hacker/skills')`。
 *     锚点门脚本会更新，缺了那一行会补上。其余内容保留。
 *   · `force: true` 才用包内模板整体覆盖。
 *
 * @param options - `{ force?: boolean, log?: (msg: string) => void }`
 * @returns `{ action: 'installed'|'kept'|'repaired', dir, skillsDir, skills, repaired? }`
 */
/**
 * 装无限制模式 / 创世神模式这两个「轻预设」。
 *
 * 为什么和 hacker 分开装：
 *  · hacker 有技能目录、工具包名、锚点门三处需要按本机路径改写，
 *    还有「已有用户改动就保留」的策略。这套逻辑对另外两个模式没有意义。
 *  · 另外两个模式的 agent.cordis.yml 里全是相对路径（`./anchor-gate.mjs`）
 *    和宿主的包名（`@deepseek-ai/xxx`），原样复制就能用，不需要渲染。
 *
 * 覆盖策略：这两个模式的 persona 是随版本演进的（抗幻觉规程会一直调），
 * 所以**每次启动都覆盖**。用户想改就改 `presets/<id>/` 的源文件，
 * 不要在 `.agent-presets/` 里改——那里是安装产物。
 */
export function installExtraPresets(options = {}) {
  const log = options.log ?? (() => {})
  const root = packagePaths().presets
  const presetRoot = userPresetRoot()
  const out = []

  for (const id of ['unlimited', 'genesis']) {
    const srcDir = join(root, id)
    if (!existsSync(srcDir)) {
      out.push({ id, action: 'missing' })
      continue
    }
    const target = join(presetRoot, id)
    try {
      mkdirSync(target, { recursive: true })
      let written = 0
      for (const file of readdirSync(srcDir)) {
        const srcFile = join(srcDir, file)
        // 只复制文件；目录（万一以后加技能子目录）交给下面的递归分支。
        let text
        try {
          text = readFileSync(srcFile, 'utf8')
        } catch {
          continue
        }
        const next = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        writeFileSync(join(target, file), next, 'utf8')
        written += 1
      }
      out.push({ id, action: 'installed', dir: target, files: written })
      log(`预设 ${id} 已安装到 ${target}（${written} 个文件）`)
    } catch (error) {
      const msg = error && error.message ? error.message : String(error)
      out.push({ id, action: 'failed', reason: msg })
      log(`预设 ${id} 安装失败：${msg}`)
    }
  }
  return out
}

export function installPreset(options = {}) {
  const paths = packagePaths()
  const bundled = installBundledSkills()
  const target = join(userPresetRoot(), 'hacker')
  const log = options.log ?? (() => {})
  const skillCount = existsSync(paths.skills)
    ? readdirSync(paths.skills).filter((f) => f.endsWith('.md')).length
    : 0
  const presetFile = join(target, 'agent.cordis.yml')

  // 无限制模式 / 创世神模式没有技能目录，也没有工具包改写需求，
  // 所以它们走独立的简装路径：直接把 presets/<id>/ 整个复制过去。
  // 放在 hacker 的自愈逻辑外面，避免 hacker 的「保留用户改动」策略
  // 把这两个模式也一起保留成旧版本。
  const extra = installExtraPresets({ force: options.force === true, log })

  if (existsSync(presetFile) && options.force !== true) {
    /* 自愈：占位符没替换 / 技能目录指向已失效的旧包路径 → 就地修好 */
    let text
    try {
      text = readFileSync(presetFile, 'utf8')
    } catch (error) {
      log(`读取 ${presetFile} 失败：${error && error.message ? error.message : String(error)}`)
      return { action: 'kept', dir: target, skillsDir: bundled.path, skills: skillCount }
    }
    const rendered = renderSkillsDir(text)
    const tools = renderToolsPackage(rendered.text)
    const filter = stripToolFilter(tools.text)
    const delegation = repairDelegation(filter.text)
    const next = delegation.text
    if (rendered.changed || tools.changed || filter.changed || delegation.changed) {
      writeFileSync(presetFile, next.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8')
      log(
        (rendered.changed
          ? (rendered.reason === 'placeholder'
            ? '预设里还留着 ' + SKILLS_PLACEHOLDER + '（会导致整个预设挂载失败）'
            : '预设里的技能目录写成了本机绝对路径')
            + '，已改为 dshHomePath(\'hacker/skills\')'
          : '')
        + (tools.changed ? (rendered.changed ? '；' : '') + '工具包名已改为 ys-pojia/hacker/tools' : '')
        + (filter.changed
          ? ((rendered.changed || tools.changed) ? '；' : '') + '已去掉 0.2.1 废弃的 toolFilter'
          : '')
        + (delegation.changed
          ? ((rendered.changed || tools.changed || filter.changed) ? '；' : '') + '已修复指挥派活约束 / 重新启用 subagent'
          : ''),
      )
    }
    const anchor = syncAnchorGate(target)
    if (anchor === 'inserted') log('已把锚点门补进现有预设（其余内容保留）')
    else if (anchor === 'updated') log('已更新锚点门脚本')
    else if (anchor === 'config-updated') log('已同步锚点门配置（bootstrapMaxTokens / maxBootstrapSteps 等）')
    const repaired = [
      rendered.changed ? rendered.reason : null,
      tools.changed ? 'tools-package' : null,
      filter.changed ? 'toolFilter' : null,
      delegation.changed ? 'delegation' : null,
      anchor === 'inserted' ? 'anchor-gate' : null,
      anchor === 'updated' ? 'anchor-script' : null,
      anchor === 'config-updated' ? 'anchor-config' : null,
    ].filter(Boolean)
    if (repaired.length > 0) {
      return {
        action: 'repaired', dir: target, skillsDir: bundled.path, skills: skillCount,
        repaired: repaired.join('+'),
      }
    }
    log(`已存在用户自己的预设 ${target}，保留不动（要覆盖：HACKER_PRESET_REFRESH=1 启动一次）`)
    return { action: 'kept', dir: target, skillsDir: bundled.path, skills: skillCount }
  }

  mkdirSync(target, { recursive: true })
  for (const file of readdirSync(paths.presetDir)) {
    const text = readFileSync(join(paths.presetDir, file), 'utf8')
    const rendered = renderToolsPackage(renderSkillsDir(text).text).text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
    writeFileSync(join(target, file), rendered, 'utf8')
  }
  syncAnchorGate(target)
  log(`预设已安装到 ${target}（随包技能 ${skillCount} 个，目录 ${bundled.path}）`)
  return { action: 'installed', dir: target, skillsDir: bundled.path, skills: skillCount }
}

/**
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  /* 幂等闸门：同一进程里 ys-pojia 可能被多处 `- insert:` 重复装载。
   * DS-YS 上实测有三处同时 insert 同一个 id：
   *   1) @deepseek-ai/dsh-web-app/cordis.patch.yml（bundle 层）
   *   2) ys-pojia/cordis.patch.yml（本包自己的 bundle 层）
   *   3) $DSH_HOME/profiles/desktop/cordis.patch.yml（profile 用户层，优先级最高）
   * 合成后三份 fiber 各跑一遍 apply。第二遍走到 L848 的 ctx.provide 时，
   * cordis 的服务唯一性检查会抛
   *   service "hackerMode" has been registered at <ys-pojia>
   * 而 apply 被 lib/index.js 的 try/catch 兜住只打一条 warn，
   * 结果是 preset 不落地、模式下拉里没有嘿客/无限制/创世神，
   * 宿主日志里 `hacker=false` —— 这就是「破甲在 DS-YS 上无效」的真实成因。
   * 已有实例就复用，不再重复 provide / 重复注册 preset。 */
  try {
    const existing = typeof ctx?.get === 'function' ? ctx.get('hackerMode') : undefined
    if (existing) {
      ctx.logger?.info?.('hacker-mode: 已由先前的装载提供（跳过重复装载，复用现有实例）')
      return
    }
  } catch { /* 查不到就照常往下走，不影响首次装载 */ }

  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const healed = ensureAllProfileBodyInserts(home)
    for (const item of healed) {
      if (item.wrote) {
        ctx.logger?.info?.('hacker-mode: 已补本体 insert %s（下次启动加载主插件）', item.path)
      }
    }
  } catch { /* 自愈失败不挡预设落地 */ }

  const paths = packagePaths()
  let result
  try {
    result = installPreset({
      force: process.env.HACKER_PRESET_REFRESH === '1'
        || needsCompositionRepair(join(userPresetRoot(), 'hacker', 'agent.cordis.yml')),
      log: (msg) => ctx.logger?.info?.('hacker-mode: ' + msg),
    })
  } catch (error) {
    ctx.logger?.error?.('hacker-mode: 预设安装失败：%s', error && error.message ? error.message : String(error))
    result = { action: 'failed', dir: join(userPresetRoot(), 'hacker'), skillsDir: join(hackerDataDir(), 'skills'), skills: 0 }
  }
  let setupResult
  try {
    setupResult = installSetupScript()
  } catch (error) {
    setupResult = { action: 'missing', error: error && error.message ? error.message : String(error) }
  }
  if (setupResult.action === 'installed' || setupResult.action === 'updated') {
    ctx.logger?.info?.('hacker-mode: 环境安装脚本已就位 %s（%s）', setupResult.path, setupResult.action)
  }

  /*
   * Web 0.1.7+ 模式下拉只认 agent-preset registry.register()，
   * 扫磁盘 .agent-presets 不会出现在下拉里（同款行为）。
   */
  const statusFile = join(hackerDataDir(), 'preset-declare.json')
  const writeStatus = (patch) => {
    try {
      mkdirSync(hackerDataDir(), { recursive: true })
      let prev = {}
      try { prev = JSON.parse(readFileSync(statusFile, 'utf8')) } catch { /* first */ }
      writeFileSync(statusFile, JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }, null, 2), 'utf8')
    } catch { /* ignore */ }
  }
  writeStatus({ ok: false, phase: 'apply-start', skillsDir: result.skillsDir, presetDir: result.dir })
  let releaseDeclared = new Map()
  let closed = false
  const softRegistry = () => {
    try {
      if (ctx.agentPresets && typeof ctx.agentPresets.register === 'function') return ctx.agentPresets
    } catch { /* without inject */ }
    try {
      const reg = ctx.get('agentPresets')
      if (reg && typeof reg.register === 'function') return reg
    } catch { /* missing */ }
    return null
  }
  const undeclare = async () => {
    const pending = [...releaseDeclared.entries()]
    releaseDeclared = new Map()
    for (const [presetId, dispose] of pending) {
      try { await dispose() } catch (error) {
        ctx.logger?.warn?.('hacker-mode: undeclare %s failed: %s', presetId, error?.message || String(error))
      }
    }
  }
  const buildDefinition = (presetId) => {
    const fromDisk = join(userPresetRoot(), presetId)
    if (!existsSync(join(fromDisk, 'agent.cordis.yml'))) {
      installPreset({ force: false, log: () => {} })
    }
    const readyDir = existsSync(join(userPresetRoot(), presetId, 'agent.cordis.yml'))
      ? join(userPresetRoot(), presetId)
      : join(paths.presets, presetId)
    return readPresetDefinition(presetId, readyDir)
  }
  const registerOnce = (registry) => {
    /* 每个 preset 各持一份 definition 与 dispose。以前只注册 hacker 一个，
       unlimited / genesis 的目录虽然在盘上，却没进 registry，模式下拉里根本
       不显示 —— 磁盘上有 ≠ 下拉里有。 */
    const decls = []
    for (const presetId of DECLARED_PRESET_IDS) {
      let definition
      try {
        definition = buildDefinition(presetId)
      } catch (error) {
        writeStatus({ ok: false, phase: 'read-failed', presetId, error: error?.message || String(error) })
        ctx.logger?.warn?.('hacker-mode: read preset %s failed: %s', presetId, error?.message || String(error))
        continue
      }
      decls.push({ presetId, definition })
    }
    if (decls.length === 0) return
    writeStatus({
      ok: false,
      phase: 'registering',
      presets: decls.map((d) => ({ id: d.definition.id, name: d.definition.name })),
    })
    /* ── 有界降级所需的三件小工具 ──────────────────────────────────────────
       宿主对 preset 的判定是「全有或全无」：只要声明里有一行插件 never started，
       整个 preset 就标 broken，模式下拉会把 broken 的预设直接过滤掉。
       典型例子：tool-subagent-list-agents 声明 inject ['tools','subagents','agents']，
       而整个 node_modules 里没有任何包 provide 'agents' —— 这行永远起不来。
       一行可选工具拖垮整个模式，用户看到的现象就是「只有创世神模式，少了两个」。
       所以这里从 broken 文本里解析出没起来的行，剔掉重注册一次。 */

    /** 把 broken 文本解析成「起不来的行名」集合。 */
    const parseBrokenIds = (text) => {
      const out = new Set()
      for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim()
        if (!line) continue
        /* 形如 `tool-subagent-list-agents (@deepseek-ai/x/list-agents): never started` */
        const m = line.match(/^([^\s(]+)\s*\(([^)]+)\)\s*:/) || line.match(/^([^\s:]+)\s*:/)
        if (!m) continue
        out.add(m[1])
        if (m[2]) out.add(m[2])
      }
      return out
    }

    /** 递归剔除声明里命中 broken 的叶子行（group 行本身不剔，只清它的子列表）。 */
    const stripRows = (definition, brokenText) => {
      const bad = parseBrokenIds(brokenText)
      const removed = []
      const walk = (rows) => rows
        .filter((row) => {
          if (row.group === true) return true
          const hit = bad.has(row.id) || bad.has(row.name)
          if (hit) { removed.push(String(row.id || row.name)); return false }
          return true
        })
        .map((row) => {
          if (row.group === true && Array.isArray(row.config)) {
            return { ...row, config: walk(row.config) }
          }
          return row
        })
      const next = walk(definition.plugins)
      return { definition: { ...definition, plugins: next }, removed }
    }

    const declare = async (target, presetId, definition) => {
      let release
      try {
        release = await target.register(definition)
      } catch (error) {
        writeStatus({ ok: false, phase: 'register-failed', presetId, error: error?.message || String(error) })
        ctx.logger?.warn?.('hacker-mode: register %s failed: %s', presetId, error?.message || String(error))
        return
      }
      /* 注册是异步的：cleanup 已经跑过（closed=true）时，这里再赋值就会把预设
         永远留在宿主里——没人再来释放它。当场撤掉。 */
      if (closed) {
        try { await release() } catch { /* 已随宿主卸载 */ }
        writeStatus({ ok: false, phase: 'closed-during-register', presetId })
        return
      }
      releaseDeclared.set(presetId, release)
    }

    const collectReport = async (target) => {
      let rows = []
      try { rows = await target.list() } catch { /* ignore */ }
      return DECLARED_PRESET_IDS.map((presetId) => {
        const row = rows.find((p) => p.id === presetId)
        return { id: presetId, name: row?.name, declared: releaseDeclared.has(presetId), broken: row?.broken || null }
      })
    }

    Promise.resolve()
      .then(async () => {
        await undeclare()
        for (const { presetId, definition } of decls) {
          await declare(registry, presetId, definition)
        }
        let report = await collectReport(registry)
        const degraded = new Set()
        for (let round = 0; round < 2; round += 1) {
          const still = report.filter((r) => r.broken && !degraded.has(r.id))
          if (still.length === 0) break
          for (const r of still) {
            const entry = decls.find((d) => d.presetId === r.id)
            if (!entry) continue
            const pruned = stripRows(entry.definition, r.broken)
            if (pruned.removed.length === 0) continue
            degraded.add(r.id)
            ctx.logger?.warn?.('hacker-mode: %s 有插件行起不来，剔掉后重注册: %s', r.id, pruned.removed.join(', '))
            try { await releaseDeclared.get(r.id)?.() } catch { /* 旧声明释放失败不挡重注册 */ }
            releaseDeclared.delete(r.id)
            entry.definition = pruned.definition
            await declare(registry, r.id, entry.definition)
          }
          report = await collectReport(registry)
        }
        const brokenOnes = report.filter((r) => r.broken)
        writeStatus({
          ok: brokenOnes.length === 0 && releaseDeclared.size > 0,
          phase: brokenOnes.length ? 'registered-broken' : 'registered',
          presets: report,
          degraded: [...degraded],
        })
        for (const r of brokenOnes) {
          ctx.logger?.warn?.('hacker-mode: %s declared but broken: %s', r.id, r.broken)
        }
        if (brokenOnes.length === 0) {
          ctx.logger?.info?.('hacker-mode: %d preset(s) declared for mode dropdown: %s',
            releaseDeclared.size, DECLARED_PRESET_IDS.join(', '))
        }
      })
      .catch((error) => {
        writeStatus({ ok: false, phase: 'register-failed', error: error?.message || String(error) })
        ctx.logger?.warn?.('hacker-mode: register failed: %s', error?.message || String(error))
      })
  }

  ctx.effect(() => {
    let tries = 0
    const tick = () => {
      if (closed) return true
      tries += 1
      const registry = softRegistry()
      if (!registry) {
        writeStatus({ ok: false, phase: 'waiting-registry', tries })
        return false
      }
      registerOnce(registry)
      return true
    }
    let timer
    let stop
    if (!tick()) {
      timer = setInterval(() => {
        if (tick()) {
          clearInterval(timer)
          timer = undefined
          if (stop) clearTimeout(stop)
        }
      }, 400)
      if (typeof timer.unref === 'function') timer.unref()
      stop = setTimeout(() => {
        if (timer) {
          clearInterval(timer)
          timer = undefined
          writeStatus({ ok: false, phase: 'timeout-waiting-registry', tries })
        }
      }, 45000)
      try { stop.unref?.() } catch { /* ignore */ }
    }
    return () => {
      closed = true
      if (timer) clearInterval(timer)
      if (stop) clearTimeout(stop)
      try { scheduleClearOwnedSelectedDefault({ ctx }) } catch { /* 清默认失败不挡停用 */ }
      // 角色缓存必须跟着预设一起清：它按 session id 记「这次派活要用哪份角色稿」，
      // 属于本预设的生命周期。留到下次装载，新队友撞上旧 session id 槽位就会被
      // 当成上一轮的角色，全程跑错稿子且没有任何报错提示。
      try {
        const n = clearRoleCache()
        if (n > 0) ctx.logger?.info?.('hacker-mode: 已清空 %d 条子会话角色缓存', n)
      } catch { /* 清缓存失败不挡停用 */ }
      void undeclare()
    }
  }, 'ys-pojia-hacker: declare agent preset')

  /* 并发兜底：入口那道 ctx.get 闸门只挡得住「已经 provide 完成」的情况。
   * 两个 fiber 同时在 await 之间穿插时，双方都会看到 undefined 然后各自往下走。
   * 这里再拦一次 —— 服务已被别人占住就不抛，让 preset 注册继续跑完。 */
  try {
    ctx.provide('hackerMode', Object.freeze({ paths, preset: result, setup: setupResult }))
  } catch (error) {
    const msg = String(error && error.message || error)
    // 只吞两类：服务已被别的装载占住，或当前 ctx 根本没有 provide（web 表面）。
    // 后者以前会重新抛出，冒到 lib/index.js 被记一条 warn —— 但 cordis 已经
    // 判定这个 fiber 失败，同批注册的 5 个 purge_* 工具被一并撤销，
    // 表现就是「插件加载后工具全没了」。provide 拿不到只是少一个服务，
    // 不该连累工具注册。
    if (!/has been registered at/.test(msg) && !/provide is not a function/.test(msg)) throw error
    ctx.logger?.warn?.('hacker-mode: 跳过 provide（%s）', msg)
  }
  ctx.logger?.info?.(
    'hacker-mode: 就绪（数据目录默认 $DSH_HOME/hacker；预设 %s；技能目录 %s）',
    result.dir, result.skillsDir,
  )
}

export default { name, inject, apply }
