/**
 * 嘿客平台适配配置（插件内，无 .ps1）
 *
 * 落盘：`$DSH_HOME/hacker/config.json`
 * 用途：
 *   · Windows / 非 Kali 机器上，由用户填写工具绝对路径或搜索目录；
 *   · preflight / 技能可用性 / nuclei 模板目录 统一走这里；
 *   · 不往官方 `$DSH_HOME/skills` 写任何东西。
 *
 * 借鉴 Z3r0：系统配置集中、可在 UI 里改（FOFA / 路径类），而不是只靠 shell 引导。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs"
import { homedir, platform as osPlatform, release } from 'node:os'
import { spawnSync } from 'node:child_process'
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path'
import { writeStateJson } from '../state-guard.js'

/** 配置文件路径。 */
export function configPathOf(root) {
  return join(root || hackerRoot(), 'config.json')
}

export function hackerRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'hacker')
}

/** 默认工具箱目录。 */
export function defaultToolkitDir(root) {
  return join(root || hackerRoot(), 'toolkit')
}

/**
 * 内置工具清单：id → 可能的可执行名（含 Windows .exe）。
 * 用户可在 config.tools[id] 填绝对路径覆盖；也可在 binDirs 里放整包工具目录。
 */
export const TOOL_CATALOG = [
  { id: 'nmap', label: 'Nmap', names: ['nmap.exe', 'nmap'] },
  { id: 'nuclei', label: 'Nuclei', names: ['nuclei.exe', 'nuclei'] },
  { id: 'masscan', label: 'Masscan', names: ['masscan.exe', 'masscan'] },
  { id: 'fscan', label: 'fscan', names: ['fscan.exe', 'fscan'] },
  { id: 'gogo', label: 'gogo', names: ['gogo.exe', 'gogo'] },
  { id: 'suo5', label: 'suo5', names: ['suo5.exe', 'suo5-windows-amd64.exe', 'suo5-linux-amd64', 'suo5'] },
  { id: 'frpc', label: "frp 客户端", names: ['frpc.exe', 'frpc'] },
  { id: 'frps', label: "frp 服务端", names: ['frps.exe', 'frps'] },
  { id: 'chisel', label: 'chisel', names: ['chisel.exe', 'chisel'] },
  { id: 'ffuf', label: 'ffuf', names: ['ffuf.exe', 'ffuf'] },
  /* names 是候选文件名，不是某台机器的绝对路径。adapt 是发行版常见别名，目录里碰见才用。 */
  { id: 'httpx', label: 'httpx', names: ['httpx-toolkit', 'pd-httpx', 'httpx.exe', 'httpx'], rejectPython: true, adapt: [/^httpx-toolkit$/, /^pd-httpx$/, /^httpx$/] },
  { id: 'dnsx', label: 'dnsx', names: ['dnsx.exe', 'dnsx'] },
  { id: 'subfinder', label: 'subfinder', names: ['subfinder.exe', 'subfinder'] },
  { id: 'ksubdomain', label: 'ksubdomain', names: ['ksubdomain.exe', 'ksubdomain'] },
  { id: 'impacket', label: "impacket (folder or entrypoint)", names: ['impacket-secretsdump', 'impacket-secretsdump.exe', 'secretsdump.py', 'impacket'], adapt: [/^impacket-secretsdump$/, /^secretsdump\.py$/] },
]

/**
 * Android（dsh-go / Termux / proot 容器）工具清单。
 *
 * 手机上没有 nmap / fscan / frpc 这些 PC 二进制，硬套 PC 清单只会让
 * envAdaptStatus 永远报「一个工具都没有」。这里列的是 Android 侧真实存在、
 * 且对逆向/渗透有意义的入口。
 *
 * root 桥：proot 里 uid=0 是假的（proot -0 伪造），要真 root 必须经
 * Android 侧的 su 转发。`su` 项就是那条通道的探针 —— 找到并 ping 通
 * 才算 ready。
 */
export const ANDROID_TOOL_CATALOG = [
  /* root 通道：proot 内 /usr/local/bin/su 是转发脚本，ping 桥返回 PONG:0 */
  { id: 'su', label: 'root 通道 (su)', names: ['su'], probe: 'root-bridge' },
  /* Android 自带 */
  { id: 'toybox', label: 'toybox', names: ['toybox'], binDirs: ['/system/bin'] },
  { id: 'busybox', label: 'busybox', names: ['busybox'], binDirs: ['/data/adb/ksu/bin', '/data/adb/magisk', '/system/xbin', '/system/bin'] },
  /* 网络与转发 */
  { id: 'nc', label: 'netcat', names: ['nc', 'netcat'], binDirs: ['/system/bin', '/data/adb/ksu/bin'] },
  { id: 'curl', label: 'curl', names: ['curl'], binDirs: ['/system/bin', '/data/adb/ksu/bin'] },
  { id: 'wget', label: 'wget', names: ['wget'], binDirs: ['/system/bin', '/data/adb/ksu/bin'] },
  /* Android 侧文本/校验工具（proot 里常缺，经 root 通道可用） */
  { id: 'grep', label: 'grep', names: ['grep'], binDirs: ['/system/bin'] },
  { id: 'sed', label: 'sed', names: ['sed'], binDirs: ['/system/bin'] },
  { id: 'awk', label: 'awk', names: ['awk'], binDirs: ['/system/bin'] },
  { id: 'find', label: 'find', names: ['find'], binDirs: ['/system/bin'] },
  { id: 'xargs', label: 'xargs', names: ['xargs'], binDirs: ['/system/bin'] },
  { id: 'sha256sum', label: 'sha256sum', names: ['sha256sum'], binDirs: ['/system/bin', '/data/adb/ksu/bin'] },
  { id: 'md5sum', label: 'md5sum', names: ['md5sum'], binDirs: ['/system/bin', '/data/adb/ksu/bin'] },
  /* 包与脚本运行时（手机上常用来装工具/跑脚本） */
  { id: 'node', label: 'node', names: ['node'] },
  { id: 'python3', label: 'python3', names: ['python3', 'python'] },
  { id: 'git', label: 'git', names: ['git'] },
  { id: 'unzip', label: 'unzip', names: ['unzip'], binDirs: ['/system/bin', '/data/adb/ksu/bin'] },
  { id: 'tar', label: 'tar', names: ['tar'], binDirs: ['/system/bin'] },
  /* 逆向常用（装了才有，没装显示 missing 不阻塞） */
  { id: 'apktool', label: 'apktool', names: ['apktool', 'apktool.jar'] },
  { id: 'jadx', label: 'jadx', names: ['jadx', 'jadx-cli', 'jadx.sh'] },
  { id: 'frida', label: 'frida', names: ['frida', 'frida-server'] },
  { id: 'rizin', label: 'rizin', names: ['rizin'] },
  { id: 'radare2', label: 'radare2', names: ['radare2', 'r2'] },
  { id: 'objdump', label: 'objdump', names: ['objdump', 'llvm-objdump'] },
  { id: 'readelf', label: 'readelf', names: ['readelf', 'llvm-readelf'] },
  { id: 'strings', label: 'strings', names: ['strings', 'llvm-strings'] },
  { id: 'nm', label: 'nm', names: ['nm', 'llvm-nm'] },
  { id: 'gdb', label: 'gdb', names: ['gdb', 'gdb-multiarch'] },
]

/** Android 平台的工具清单：ANDROID_TOOL_CATALOG，其余平台用 TOOL_CATALOG。 */
export function toolCatalogFor(cfg) {
  return isAndroidLike(cfg) ? ANDROID_TOOL_CATALOG : TOOL_CATALOG
}

const EMPTY = () => ({
  version: 1,
  /* auto | windows | linux | android —— auto 跟 Node process.platform + Android 探测 */
  platform: 'auto',
  toolkitDir: '',
  nucleiTemplatesDir: '',
  /* 额外搜索目录：用户自己的 Kali 工具包 / 绿色版工具夹 */
  binDirs: [],
  /* id → 绝对路径；空字符串表示未指定 */
  tools: Object.fromEntries(TOOL_CATALOG.map((t) => [t.id, ''])),
  env: {
    FOFA_KEY: '',
    HACKER_VPS_HOST: '',
    HACKER_VPS_KEY: '',
  },
  notes: '',
  /* 用户确认「暂不配置工具」后允许正常对话 */
  envAdaptSkip: false,
  /* 用户在环境适配里保存/文件夹分配过一次 */
  envAdaptConfigured: false,
  updated_at: null,
})

function isWinLike(cfg) {
  const p = (cfg && cfg.platform) || 'auto'
  if (p === 'windows') return true
  if (p === 'linux' || p === 'android') return false
  return osPlatform() === 'win32'
}

/**
 * 是否 Android 宿主（dsh-go / Termux / proot）。
 *
 * 判定顺序：
 *   1. 配置里显式写 android → 是；显式写 windows/linux → 否（用户可覆盖）
 *   2. /system/bin/toybox 或 /system/build.prop 存在 → Android（proot 里通常挂了 /system）
 *   3. DSH_GO_RUNTIME_ROOT 或 DSH_APP_* 环境变量 → dsh-go App
 *   4. os.release() 含 android / 有 /data/data → Android
 *
 * 为什么不能只看 process.platform：proot 里的 node 跑在 Linux 内核上，
 * process.platform 恒为 'linux'，但工具清单、root 通道、路径全不一样。
 */
export function detectAndroid() {
  const forced = String(process.env.DSH_FORCE_PLATFORM || '').trim().toLowerCase()
  if (forced === 'android') return { android: true, source: 'env', detail: 'DSH_FORCE_PLATFORM=android' }
  if (forced === 'linux' || forced === 'windows') {
    return { android: false, source: 'env', detail: 'DSH_FORCE_PLATFORM=' + forced }
  }
  if (process.env.DSH_GO_RUNTIME_ROOT) {
    return { android: true, source: 'env', detail: 'DSH_GO_RUNTIME_ROOT' }
  }
  for (const p of ['/system/bin/toybox', '/system/build.prop', '/system/bin/app_process64', '/data/data']) {
    if (existsSync(p)) return { android: true, source: 'paths', detail: p }
  }
  if (/android/i.test(osRelease())) return { android: true, source: 'os-release', detail: osRelease() }
  return { android: false, source: null, detail: null }
}

/** os.release() 的安全包装（os 模块可能被裁剪）。 */
function osRelease() {
  try {
    return String(release() || '')
  } catch {
    return ''
  }
}

/** 是否按 Android 适配（配置优先，其次自动探测）。 */
export function isAndroidLike(cfg) {
  const p = (cfg && cfg.platform) || 'auto'
  if (p === 'android') return true
  if (p === 'windows' || p === 'linux') return false
  return detectAndroid().android
}

export function loadPlatformConfig(root) {
  const base = EMPTY()
  const file = configPathOf(root)
  if (!existsSync(file)) return Object.assign({}, base, { path: file, exists: false })
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const tools = Object.assign({}, base.tools, raw.tools && typeof raw.tools === 'object' ? raw.tools : {})
    const env = Object.assign({}, base.env, raw.env && typeof raw.env === 'object' ? raw.env : {})
    const binDirs = Array.isArray(raw.binDirs)
      ? raw.binDirs.map((x) => String(x || '').trim()).filter(Boolean)
      : []
    return {
      version: Number(raw.version) || 1,
      platform: ['auto', 'windows', 'linux', 'android'].includes(raw.platform) ? raw.platform : 'auto',
      toolkitDir: typeof raw.toolkitDir === 'string' ? raw.toolkitDir.trim() : '',
      nucleiTemplatesDir: typeof raw.nucleiTemplatesDir === 'string' ? raw.nucleiTemplatesDir.trim() : '',
      binDirs,
      tools,
      env,
      notes: typeof raw.notes === 'string' ? raw.notes : '',
      envAdaptSkip: !!raw.envAdaptSkip,
      envAdaptConfigured: !!raw.envAdaptConfigured,
      updated_at: raw.updated_at || null,
      path: file,
      exists: true,
    }
  } catch (error) {
    return Object.assign({}, base, {
      path: file,
      exists: true,
      error: error && error.message ? error.message : String(error),
    })
  }
}

/**
 * 把 patch 合并到当前配置，产出"该写进 config.json 的对象"。
 * 不落盘，纯函数（除了读 prev），供 savePlatformConfig 与 checked 变体共用。
 */
export function buildPlatformConfig(patch, root) {
  const dir = root || hackerRoot()
  const prev = loadPlatformConfig(dir)
  const p = patch && typeof patch === 'object' ? patch : {}
  const next = {
    version: 1,
    platform: ['auto', 'windows', 'linux', 'android'].includes(p.platform) ? p.platform : (prev.platform || 'auto'),
    toolkitDir: typeof p.toolkitDir === 'string' ? p.toolkitDir.trim() : (prev.toolkitDir || ''),
    nucleiTemplatesDir: typeof p.nucleiTemplatesDir === 'string'
      ? p.nucleiTemplatesDir.trim()
      : (prev.nucleiTemplatesDir || ''),
    binDirs: Array.isArray(p.binDirs)
      ? p.binDirs.map((x) => String(x || '').trim()).filter(Boolean)
      : (prev.binDirs || []),
    tools: Object.assign({}, prev.tools || {}, p.tools && typeof p.tools === 'object' ? p.tools : {}),
    env: Object.assign({}, prev.env || {}, p.env && typeof p.env === 'object' ? p.env : {}),
    notes: typeof p.notes === 'string' ? p.notes : (prev.notes || ''),
    envAdaptSkip: p.envAdaptSkip !== undefined ? !!p.envAdaptSkip : !!prev.envAdaptSkip,
    envAdaptConfigured: p.envAdaptConfigured !== undefined
      ? !!p.envAdaptConfigured
      : !!prev.envAdaptConfigured,
    updated_at: new Date().toISOString(),
  }
  /* 空 tools 键保留 catalog 全量，方便面板编辑。按生效平台取清单，
     Android 与 PC 的 id 集合不同，硬用 PC 清单会给手机塞一堆无意义键。 */
  for (const t of toolCatalogFor(next)) {
    if (next.tools[t.id] === undefined || next.tools[t.id] === null) next.tools[t.id] = ''
    else next.tools[t.id] = String(next.tools[t.id]).trim()
  }
  return next
}

export function savePlatformConfig(patch, root) {
  const dir = root || hackerRoot()
  mkdirSync(dir, { recursive: true })
  writeStateJson(configPathOf(dir), buildPlatformConfig(patch, dir))
  return loadPlatformConfig(dir)
}

/**
 * 同 `savePlatformConfig`，但把落盘结果一并返回，供面板如实提示。
 *
 * 为什么不给返回的 config 挂 `__write` 字段：面板会把 `config` 原样回传，
 * 那个字段会跟着被写进 config.json，变成永久的脏数据。
 *
 * @returns `{ ok, config, code?, error? }`
 */
export function savePlatformConfigChecked(patch, root) {
  const dir = root || hackerRoot()
  const written = writeStateJson(configPathOf(dir), buildPlatformConfig(patch, dir))
  const config = loadPlatformConfig(dir)
  if (written && written.ok === true) return { ok: true, config }
  return {
    ok: false,
    config,
    code: (written && written.code) || 'EWRITE',
    error: (written && written.error) || '写入平台配置失败',
  }
}

/** 生效的工具箱根。 */
export function toolkitDirOf(cfg, root) {
  const c = cfg || loadPlatformConfig(root)
  if (c.toolkitDir) return resolve(c.toolkitDir)
  return defaultToolkitDir(root)
}

/** 生效的 nuclei 模板目录（可空）。 */
export function nucleiTemplatesDirOf(cfg, root) {
  const c = cfg || loadPlatformConfig(root)
  if (c.nucleiTemplatesDir && existsSync(c.nucleiTemplatesDir)) return resolve(c.nucleiTemplatesDir)
  return null
}

/**
 * 在目录里找可执行名（浅扫一层 + 常见子目录 bin/）。
 */
function looksLikePythonCli(file) {
  let fd
  try {
    const buf = Buffer.alloc(96)
    fd = openSync(file, 'r')
    const n = readSync(fd, buf, 0, buf.length, 0)
    const head = buf.subarray(0, n).toString('utf8')
    return head.startsWith('#!') && /python/i.test(head)
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

function findInDir(dir, names, options = {}) {
  if (!dir || !existsSync(dir)) return null
  const tryOne = (base) => {
    for (const name of names) {
      const p = join(base, name)
      if (existsSync(p)) {
        try {
          const st = statSync(p)
          if (!st.isFile()) continue
          if (options.rejectPython && looksLikePythonCli(p)) continue
          return p
        } catch { /* continue */ }
      }
    }
    return null
  }
  const hit = tryOne(dir) || adaptInDir(dir, options)
  if (hit) return hit
  for (const sub of ['bin', 'Bins', 'tools', 'Tools']) {
    const nested = tryOne(join(dir, sub)) || adaptInDir(join(dir, sub), options)
    if (nested) return nested
  }
  return null
}

/** 精确文件名没有时，用发行版别名在这一层目录里对。对上才算找到。 */
function adaptInDir(dir, options) {
  const patterns = options.adapt
  if (!dir || !Array.isArray(patterns) || patterns.length === 0 || !existsSync(dir)) return null
  let names
  try { names = readdirSync(dir) } catch { return null }
  for (const pattern of patterns) {
    for (const name of names) {
      if (!pattern.test(String(name).toLowerCase())) continue
      const file = join(dir, name)
      try {
        if (!statSync(file).isFile()) continue
        if (options.rejectPython && looksLikePythonCli(file)) continue
        return file
      } catch { /* continue */ }
    }
  }
  return null
}

/** PATH 上的 which（仅同步、不 spawn shell）。 */
function findOnPath(names, env = process.env, options = {}) {
  const pathVar = env.PATH || env.Path || ''
  const parts = pathVar.split(delimiter).filter(Boolean)
  for (const part of parts) {
    const hit = findInDir(part, names, options)
    if (hit) return hit
  }
  return null
}

/** dsh 的 PATH 经常比登录 shell 短。Linux 再补发行版和用户目录。 */
function linuxFallbackDirs(env = process.env) {
  const home = env.HOME || homedir()
  const dirs = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/bin', '/snap/bin']
  if (home) {
    dirs.push(
      join(home, 'go', 'bin'),
      join(home, '.local', 'bin'),
      join(home, '.pdtm', 'go', 'bin'),
    )
  }
  return dirs
}

/**
 * 解析单个工具：用户指定路径 → toolkit → binDirs → PATH。
 * @returns `{ id, label, path, source: 'config'|'toolkit'|'binDir'|'path'|'missing', names }`
 */
export function resolveTool(id, options = {}) {
  const root = options.root || hackerRoot()
  const cfg = options.config || loadPlatformConfig(root)
  const env = options.env || process.env
  const catalog = toolCatalogFor(cfg)
  const def = catalog.find((t) => t.id === id)
  if (!def) {
    return { id, label: id, path: null, source: 'missing', names: [] }
  }
  const configured = cfg.tools && typeof cfg.tools[id] === 'string' ? cfg.tools[id].trim() : ''
  if (configured) {
    const abs = isAbsolute(configured) ? configured : resolve(configured)
    if (existsSync(abs)) {
      return { id, label: def.label, path: abs, source: 'config', names: def.names }
    }
    return { id, label: def.label, path: null, source: 'missing', names: def.names, configured: abs, note: "已配置的路径不存在： " + abs }
  }
  const findOpts = { rejectPython: !!def.rejectPython, adapt: def.adapt }
  const toolkit = toolkitDirOf(cfg, root)
  const fromToolkit = findInDir(toolkit, def.names, findOpts)
  if (fromToolkit) return { id, label: def.label, path: fromToolkit, source: 'toolkit', names: def.names }

  for (const dir of cfg.binDirs || []) {
    const hit = findInDir(dir, def.names, findOpts)
    if (hit) return { id, label: def.label, path: hit, source: 'binDir', names: def.names, binDir: dir }
  }

  /* 目录型工具（toybox / busybox / nc）在 Android 上固定在 /system/bin 等位置，
     不进 PATH 也要能找到。 */
  for (const dir of def.binDirs || []) {
    const hit = findInDir(dir, def.names, findOpts)
    if (hit) return { id, label: def.label, path: hit, source: 'binDir', names: def.names, binDir: dir }
  }

  const fromPath = findOnPath(def.names, env, findOpts)
  if (fromPath) return { id, label: def.label, path: fromPath, source: 'path', names: def.names }

  if (!isWinLike(cfg)) {
    for (const dir of linuxFallbackDirs(env)) {
      const hit = findInDir(dir, def.names, findOpts)
      if (hit) return { id, label: def.label, path: hit, source: 'path', names: def.names }
    }
  }

  /* Android：proot 里看不到 /system/bin（App 的 proot 参数按需挂载），
     但 root 通道能过去。标记 reachableViaRoot，让面板显示「经 su 可用」
     而不是「缺失」。不伪造 path —— 命令必须经 su 包装执行。 */
  if (isAndroidLike(cfg) && def.binDirs && def.binDirs.length > 0) {
    const reach = probeBinaryViaRoot(def, options)
    if (reach) {
      return {
        id,
        label: def.label,
        path: null,
        source: 'root-channel',
        names: def.names,
        reachableViaRoot: reach,
        note: 'proot 内不可见，经 su 可用：' + reach,
      }
    }
  }

  return { id, label: def.label, path: null, source: 'missing', names: def.names }
}

/**
 * 经 root 通道探测一个二进制是否存在于 Android 侧。
 * 只在有 su 可用时调用，失败静默返回 null（不阻塞工具解析）。
 */
function probeBinaryViaRoot(def, options = {}) {
  const cfg = options.config || loadPlatformConfig(options.root)
  const su = cfg.tools && typeof cfg.tools.su === 'string' && cfg.tools.su.trim()
    ? cfg.tools.su.trim()
    : null
  const suPath = su || (() => {
    const r = findInDir('/usr/local/bin', ['su'], {}) || findInDir('/usr/bin', ['su'], {}) || findInDir('/bin', ['su'], {})
    return r
  })()
  if (!suPath) return null

  const run = options.run || defaultRun
  const dirs = (def.binDirs || []).join(' ')
  const names = (def.names || []).join(' ')
  const script = 'for d in ' + dirs + '; do for n in ' + names + '; do [ -x "$d/$n" ] && echo "$d/$n" && exit 0; done; done'
  const r = run(suPath, ['-c', script], 6000)
  const hit = String(r.stdout || '').trim().split('\n')[0]
  return hit || null
}

export function resolveAllTools(options = {}) {
  const cfg = options.config || loadPlatformConfig(options.root)
  return toolCatalogFor(cfg).map((t) => resolveTool(t.id, { ...options, config: cfg }))
}

/**
 * 探测 Android root 通道（proot 内的 su 转发脚本 → Android 侧 KernelSU/Magisk）。
 *
 * 只认「能拿到真 root」的证据：su -c id 输出里带 uid=0 且不是 proot 的假身份。
 * proot -0 也会把 id 显示成 uid=0，所以额外要求读到一个只有真 root 能读的路径，
 * 或者 su 版本串里出现 ksu/magisk。
 *
 * @returns `{ ok, uid, real, detail, via }`
 */
export function probeRootChannel(options = {}) {
  const cfg = options.config || loadPlatformConfig(options.root)
  if (!isAndroidLike(cfg)) return { ok: false, real: false, detail: '非 Android 宿主', via: null }

  const suPath = resolveTool('su', { ...options, config: cfg })
  if (!suPath.path) return { ok: false, real: false, detail: '未找到 su', via: null }

  const run = options.run || defaultRun
  const idOut = run(suPath.path, ['-c', 'id'], 8000)
  if (!idOut.ok) {
    return { ok: false, real: false, detail: 'su 执行失败: ' + (idOut.error || ''), via: suPath.path }
  }
  const text = String(idOut.stdout || '')
  const m = /uid=(\d+)/.exec(text)
  const uid = m ? Number(m[1]) : -1
  if (uid !== 0) {
    return { ok: false, real: false, uid, detail: 'su 返回非 0 uid', via: suPath.path }
  }

  /* 真 root 的判据：能读 /data/data 顶层（proot 假 root 看不到该目录） */
  const probe = run(suPath.path, ['-c', 'ls /data/data 2>/dev/null | head -1'], 8000)
  const canRead = probe.ok && String(probe.stdout || '').trim().length > 0
  const isKsu = /ksu|magisk|apatch/i.test(text)

  return {
    ok: true,
    real: canRead || isKsu,
    uid,
    detail: canRead
      ? 'root 通道可用（能读 /data/data）'
      : (isKsu ? 'root 通道可用（su 标识为 ksu/magisk）' : 'su 返回 uid=0 但读不到 /data/data，可能是 proot 假 root'),
    via: suPath.path,
  }
}

/** 默认执行器：spawnSync，不抛。 */
function defaultRun(file, args, timeoutMs) {
  try {
    const r = spawnSync(file, args, {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    return {
      ok: r.status === 0 || (r.status === null && !r.error),
      status: r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      error: r.error ? String(r.error.message || r.error) : '',
    }
  } catch (e) {
    return { ok: false, status: -1, stdout: '', stderr: '', error: String(e && e.message ? e.message : e) }
  }
}

/**
 * 把配置里的 env 合并进 effectiveEnv（进程 / .env 已有的优先，不覆盖）。
 */
export function mergeConfigEnv(effectiveEnv, cfg) {
  const out = Object.assign({}, effectiveEnv || {})
  const env = (cfg && cfg.env) || {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue
    const val = v.trim()
    if (val === '') continue
    if (out[k] === undefined || out[k] === '') out[k] = val
  }
  return out
}

/**
 * 平台摘要：给面板与 preflight 用。
 */
export function platformSummary(root) {
  const cfg = loadPlatformConfig(root)
  const win = isWinLike(cfg)
  const android = isAndroidLike(cfg)
  const tools = resolveAllTools({ root, config: cfg })
  const found = tools.filter((t) => t.path)
  const missing = tools.filter((t) => !t.path)
  const toolkit = toolkitDirOf(cfg, root)
  const nuclei = nucleiTemplatesDirOf(cfg, root)
    || (existsSync(join(toolkit, 'nuclei-templates')) ? join(toolkit, 'nuclei-templates') : null)
  const adapt = envAdaptStatus(root)
  const rootChannel = android ? probeRootChannel({ root, config: cfg }) : null
  return {
    ok: true,
    config: cfg,
    runtime: {
      nodePlatform: osPlatform(),
      effective: win ? 'windows' : (android ? 'android' : 'linux'),
      windows: win,
      android,
      androidDetect: detectAndroid(),
      rootChannel,
      sep,
    },
    toolkitDir: toolkit,
    toolkitExists: existsSync(toolkit),
    nucleiTemplatesDir: nuclei,
    tools: {
      total: tools.length,
      found: found.length,
      missing: missing.length,
      items: tools,
    },
    adapt,
    hint: android
      ? (rootChannel && rootChannel.real
        ? "Android 宿主：root 通道已接通（su 转发到 KernelSU/Magisk）。工具清单按手机实际可用的来，缺的装到 PATH 或 ~/.local/bin 即可。"
        : "Android 宿主：root 通道未接通。proot 里的 uid=0 是假的，真 root 需要 Android 侧 root 桥在跑（127.0.0.1:39991）。")
      : (adapt.kali
        ? "已检测到 Kali。系统包按发行版文件名认：impacket-secretsdump、httpx-toolkit（不把 Python 的 /usr/bin/httpx 当成扫描器）。fscan、gogo、suo5、frp、chisel、dnsx、subfinder、ksubdomain 不是 Kali 自带命令，没放进 /usr/bin 或 ~/go/bin 就会显示未找到。"
        : (win
          ? "当前按 Windows 适配：在 Kali 虚拟机里跑，或在本页手填工具路径 / 选整包文件夹自动分配。出网代理见下方「出网状态」。"
          : "当前按 Linux 适配：用 setup.sh 安装工具包，或在本页手填路径 / 选整包文件夹自动分配。出网代理见下方「出网状态」。")),
    egress: {
      http_proxy: process.env.HTTP_PROXY || process.env.http_proxy || '',
      https_proxy: process.env.HTTPS_PROXY || process.env.https_proxy || '',
      all_proxy: process.env.ALL_PROXY || process.env.all_proxy || '',
      no_proxy: process.env.NO_PROXY || process.env.no_proxy || '',
      note: "只读进程环境；改系统/终端代理后需重启宿主。命令级代理请用技能 cn-proxy-pool，不改本机网络配置。",
    },
  }
}

/** 探测本机是否 Kali / 同系演练发行版。 */
export function detectKali() {
  if (osPlatform() !== 'linux') {
    return { kali: false, source: null, detail: "非 Linux 宿主" }
  }
  try {
    const text = readFileSync('/etc/os-release', 'utf8')
    if (/ID\s*=\s*"?kali"?/i.test(text) || /ID_LIKE\s*=[^\n]*kali/i.test(text) || /NAME\s*=\s*".*Kali/i.test(text)) {
      return { kali: true, source: 'os-release', detail: "os-release 标明 Kali" }
    }
  } catch { /* ignore */ }
  const markers = [
    '/usr/share/kali-menu',
    '/etc/apt/sources.list.d/kali.list',
    '/usr/share/kali-defaults',
  ]
  for (const p of markers) {
    if (existsSync(p)) return { kali: true, source: 'paths', detail: p }
  }
  return { kali: false, source: null, detail: null }
}

const NAME_TO_IDS = (() => {
  const map = new Map()
  for (const t of TOOL_CATALOG) {
    for (const name of t.names) {
      const key = String(name).toLowerCase()
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(t.id)
    }
  }
  return map
})()

/**
 * 在文件夹内递归扫工具名（限深度），返回 id → 绝对路径。
 */
export function scanFolderForTools(dir, options = {}) {
  const maxDepth = Math.min(Math.max(Number(options.maxDepth) || 4, 1), 6)
  const maxFiles = Math.min(Math.max(Number(options.maxFiles) || 8000, 100), 20000)
  const root = resolve(String(dir || '').trim())
  const assigned = {}
  const hits = []
  if (!root || !existsSync(root)) {
    return { ok: false, error: "文件夹不存在： " + root, assigned, hits }
  }
  let st
  try { st = statSync(root) } catch {
    return { ok: false, error: "无法读取文件夹： " + root, assigned, hits }
  }
  if (!st.isDirectory()) {
    return { ok: false, error: "Not a folder: " + root, assigned, hits }
  }

  let scanned = 0
  const ranks = {}
  const walk = (base, depth) => {
    if (scanned >= maxFiles || depth > maxDepth) return
    let entries
    try { entries = readdirSync(base, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (scanned >= maxFiles) break
      const name = ent.name
      if (!name || name === '.' || name === '..') continue
      if (name.startsWith('.') || name === 'node_modules' || name === '.git') continue
      const full = join(base, name)
      let isDir = false
      let isFile = false
      try {
        if (typeof ent.isDirectory === 'function') {
          isDir = ent.isDirectory()
          isFile = ent.isFile()
        } else {
          const s = statSync(full)
          isDir = s.isDirectory()
          isFile = s.isFile()
        }
      } catch { continue }
      if (isDir) {
        walk(full, depth + 1)
        continue
      }
      if (!isFile) continue
      scanned += 1
      const key = name.toLowerCase()
      const ids = NAME_TO_IDS.get(key)
      if (!ids) continue
      for (const id of ids) {
        const def = TOOL_CATALOG.find((t) => t.id === id)
        if (def && def.rejectPython && looksLikePythonCli(full)) continue
        const rank = def ? def.names.findIndex((n) => n.toLowerCase() === key) : 99
        const prevRank = ranks[id] === undefined ? 99 : ranks[id]
        if (assigned[id] && rank >= prevRank) continue
        ranks[id] = rank < 0 ? 99 : rank
        assigned[id] = full
        hits.push({ id, path: full, name })
      }
    }
  }
  walk(root, 0)

  /* nuclei-templates 目录顺带认一下 */
  let nucleiTemplatesDir = ''
  const tryNuclei = [
    join(root, 'nuclei-templates'),
    join(root, 'nuclei', 'templates'),
  ]
  for (const p of tryNuclei) {
    if (existsSync(p)) {
      try {
        if (statSync(p).isDirectory()) { nucleiTemplatesDir = p; break }
      } catch { /* ignore */ }
    }
  }

  return {
    ok: true,
    dir: root,
    scanned,
    assigned,
    hits,
    nucleiTemplatesDir,
    assignedCount: Object.keys(assigned).length,
  }
}

/**
 * 把整包工具文件夹写入 config：toolkitDir + 匹配到的 tools 路径。
 */
export function assignToolkitFolder(dir, root) {
  const scan = scanFolderForTools(dir)
  if (!scan.ok) return Object.assign({ ok: false }, scan)
  const prev = loadPlatformConfig(root)
  const tools = Object.assign({}, prev.tools || {})
  for (const [id, path] of Object.entries(scan.assigned)) {
    tools[id] = path
  }
  const binDirs = Array.isArray(prev.binDirs) ? prev.binDirs.slice() : []
  if (!binDirs.includes(scan.dir)) binDirs.unshift(scan.dir)
  const patch = {
    toolkitDir: scan.dir,
    binDirs,
    tools,
    envAdaptConfigured: true,
    envAdaptSkip: false,
  }
  if (scan.nucleiTemplatesDir) patch.nucleiTemplatesDir = scan.nucleiTemplatesDir
  const cfg = savePlatformConfig(patch, root)
  const summary = platformSummary(root)
  return {
    ok: true,
    assigned: scan.assigned,
    assignedCount: scan.assignedCount,
    hits: scan.hits,
    scanned: scan.scanned,
    dir: scan.dir,
    nucleiTemplatesDir: scan.nucleiTemplatesDir || null,
    config: cfg,
    tools: summary.tools,
    adapt: summary.adapt,
  }
}

/**
 * 嘿客发送前环境门禁状态。
 * Kali → 直接就绪；否则需配置/已分配工具，或用户确认跳过。
 */
export function envAdaptStatus(root) {
  const cfg = loadPlatformConfig(root)
  const kaliInfo = detectKali()
  const androidInfo = detectAndroid()
  const android = isAndroidLike(cfg)
  const tools = resolveAllTools({ root, config: cfg })
  const foundItems = tools.filter((t) => t.path)
  const missingItems = tools.filter((t) => !t.path)
  const found = foundItems.length
  const skipped = !!cfg.envAdaptSkip
  /* 只有记下的路径算已配置。单独的 envAdaptConfigured 可能是空的自动初始化。 */
  const catalog = toolCatalogFor(cfg)
  const savedPaths = !!(cfg.toolkitDir && String(cfg.toolkitDir).trim())
    || (cfg.binDirs && cfg.binDirs.length > 0)
    || catalog.some((t) => cfg.tools && cfg.tools[t.id] && String(cfg.tools[t.id]).trim())

  /* Android 额外判据：root 通道通了就视为就绪 —— 手机上的主力能力是 root，
     工具本来就是「装了才有」，不该因为没装 nmap 就卡住整个会话。 */
  const rootChannel = android ? probeRootChannel({ root, config: cfg }) : null
  const androidReady = !!(android && rootChannel && rootChannel.real)

  let reason = 'need-config'
  let ready = false
  let message = ''

  if (android) {
    if (androidReady) {
      ready = true
      reason = 'android-root'
      message = "Android 宿主：root 通道可用（" + (rootChannel.via || 'su') + "）。当前找到 " + found + '/' + tools.length + " 个工具，缺的装到 PATH 即可。"
    } else if (skipped) {
      ready = true
      reason = 'skipped'
      message = "已选择暂时跳过，可以正常对话（root 通道未接通，需要真 root 的操作会失败）。"
    } else if (found >= 2) {
      ready = true
      reason = 'tools-found'
      message = "Android 宿主：本机已找到 " + found + " 个工具。root 通道未接通（" + (rootChannel ? rootChannel.detail : '未探测') + "）。"
    } else {
      ready = false
      reason = 'android-need-root'
      message = "Android 宿主：root 通道未接通，且工具未配置。真 root 需要 Android 侧 root 桥在 127.0.0.1:39991 监听；proot 内的 uid=0 是伪造的。"
    }
  } else if (kaliInfo.kali) {
    ready = true
    reason = 'kali'
    message = "已检测到 Kali，默认直接使用本机工具（PATH / 默认查找）。"
  } else if (skipped) {
    ready = true
    reason = 'skipped'
    message = "已选择暂时跳过工具配置，可以正常对话（扫描类技能可能不可用）。"
  } else if (savedPaths) {
    ready = true
    reason = 'configured'
    message = "已保存的工具路径仍然有效，更新插件不会要求重新配置。当前找到 " + found + '/' + tools.length + " 个工具。"
  } else if (found >= 2) {
    ready = true
    reason = 'tools-found'
    message = "本机已能找到 " + found + " 个工具，视为就绪。"
  } else {
    ready = false
    reason = 'need-config'
    message = "未检测到 Kali，且工具尚未配置。打开 YS-pojia → 环境适配，填写路径或选整包文件夹自动分配；也可以确认「暂时跳过」，继续对话。"
  }

  return {
    ok: true,
    ready,
    reason,
    message,
    kali: !!kaliInfo.kali,
    kaliSource: kaliInfo.source,
    kaliDetail: kaliInfo.detail,
    android,
    androidDetect: androidInfo,
    rootChannel,
    skipped,
    configured: savedPaths,
    found,
    missing: missingItems.length,
    total: tools.length,
    foundIds: foundItems.map((t) => t.id),
    missingIds: missingItems.map((t) => t.id),
  }
}

export function markEnvAdaptSkip(root, skip = true) {
  savePlatformConfig({ envAdaptSkip: !!skip }, root)
  return envAdaptStatus(root)
}

export default {
  TOOL_CATALOG,
  ANDROID_TOOL_CATALOG,
  toolCatalogFor,
  configPathOf,
  hackerRoot,
  loadPlatformConfig,
  buildPlatformConfig,
  savePlatformConfig,
  savePlatformConfigChecked,
  resolveTool,
  resolveAllTools,
  platformSummary,
  mergeConfigEnv,
  toolkitDirOf,
  nucleiTemplatesDirOf,
  detectKali,
  detectAndroid,
  isAndroidLike,
  probeRootChannel,
  scanFolderForTools,
  assignToolkitFolder,
  envAdaptStatus,
  markEnvAdaptSkip,
}
