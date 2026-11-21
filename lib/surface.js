import path from "node:path";
import fs from "node:fs";

/** 当前已接线的宿主面。gui / tui 先能识别，适配仍回退 web。 */
export const SURFACES = Object.freeze(["web", "desktop", "gui", "tui"]);

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

function slash(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function exeName(execPath) {
  return path.basename(String(execPath || "")).toLowerCase();
}

/* ---------------------------------------------------------------- 桌面端 exe 名判定
 * 历史坑：这里只认 "DeepSeek Harness.exe" / "DSH Desktop.exe" / "DSH NEXT.exe"。
 * 但真实装机里有：
 *   D:\deepseek\DS-YS\DS-YS.exe                          ← DS-YS 桌面端（无 app.asar）
 *   D:\deepseek\DeepSeek Harness Desktop\DeepSeek Harness Desktop.exe
 *                                                        ← 官方 Harness 的 Desktop 变体
 * 两个都不匹配，于是 isDesktopExecutable=false → 重启走 requestRestart() 空返回，
 * 进程不动，用户看到的就是"重启失败"。所有判定统一走下面三个导出，禁止再各写一份。
 */

/** DS-YS / DeepSeek-YS 系桌面端（名字里的点、横线、下划线、空格都当分隔符）。 */
export const DS_YS_EXE_RE = /^ds[\s._-]*ys(\.exe)?$/i;

/** 官方 DeepSeek Harness，允许带 Desktop / Next / App 后缀词。 */
export const HARNESS_EXE_RE = /^deepseek[\s._-]*harness(?:[\s._-]*(?:desktop|next|app))?(\.exe)?$/i;

/** 路径里出现 DS-YS 安装目录（`/ds-ys/`、`/ds ys/`、`/deepseek-ys/`）。 */
export function pathLooksDsYs(p) {
  const n = slash(p);
  if (!n) return false;
  if (/\/ds[\s._-]*ys\.exe$/i.test(n)) return true;
  if (/\/deepseek[\s._-]*ys\.exe$/i.test(n)) return true;
  return /\/ds[\s._-]*ys\//.test(n) || /\/deepseek[\s._-]*ys\//.test(n);
}

export function pathLooksDesktop(p) {
  const n = slash(p);
  if (!n) return false;
  // 安装目录可能叫 "DeepSeek Harness" / "deepseek-harness" / "DeepseekHarnessDesktop"。
  // 源码仓库也常带 deepseek-harness 名字，所以还要带 resources/、exe、.app/ 才算桌面安装。
  const harnessDir =
    n.includes("/deepseek harness/") ||
    n.includes("/deepseek-harness/") ||
    n.includes("/deepseekharness") ||
    /\/deepseek[\s._-]*harness/.test(n);
  const dsYsDir = /\/ds[\s._-]*ys\//.test(n) || /\/deepseek[\s._-]*ys\//.test(n);
  return (
    n.includes("/dsh desktop/") ||
    n.includes("/dsh desktop.app/") ||
    n.includes("dsh-desktop") ||
    n.includes("dsh-plugin-desktop") ||
    n.includes("dsh-desktop-next") ||
    n.includes("/dsh next/") ||
    n.includes("/dsh next.app/") ||
    n.includes("dsh-next") ||
    n.includes("/deepseek bot/") ||
    n.includes("/deepseek-bot/") ||
    n.includes("/ds-bot/") ||
    n.includes("/deepseek harness.app/") ||
    (harnessDir && (n.includes("/resources/") || n.includes("/contents/resources/") || n.endsWith("/resources"))) ||
    (dsYsDir && (n.includes("/resources/") || n.endsWith("/resources"))) ||
    /\/dsh desktop\.exe$/i.test(n) ||
    /\/dsh next\.exe$/i.test(n) ||
    /\/deepseek[\s._-]*harness[\s._-]*(?:desktop|next|app)?\.exe$/i.test(n) ||
    pathLooksDsYs(n) ||
    n.endsWith("/host-process-entry.js") ||
    n.endsWith("/desktop-cli.js")
  );
}

function resourcesLookLikeDesktopInstall(resourcesPath) {
  if (!resourcesPath) return false;
  if (pathLooksDesktop(resourcesPath)) return true;
  const n = slash(resourcesPath);
  if (!(n.endsWith("/resources") || n.includes("/contents/resources"))) return false;
  try {
    const asar = path.join(resourcesPath, "app.asar");
    if (fs.existsSync(asar) && fs.statSync(asar).isFile()) return true;
    if (fs.existsSync(path.join(resourcesPath, "app", "dsh"))) return true;
    if (fs.existsSync(path.join(resourcesPath, "app.asar.unpacked", "dsh"))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** 社区 Electron（DS Bot / DeepSeek Bot）：profile 常是 ds-bot，DSH_SURFACE 还可能被写成 web。 */
export function isCommunityElectronHost(input = {}) {
  const env = input.env ?? process.env;
  const profile = norm(env.DSH_PROFILE);
  if (profile === "ds-bot" || profile === "dsbot" || profile === "deepseek-bot") return true;
  if (profile === "dsh-next" || profile === "dshnext" || profile === "dsh next") return true;
  const execPath = input.execPath ?? process.execPath;
  const name = exeName(execPath);
  if (/^deepseek[\s._-]*bot(\.exe)?$/.test(name) || /^ds[\s._-]*bot(\.exe)?$/.test(name)) return true;
  if (/^dsh[\s._-]*next(\.exe)?$/.test(name)) return true;
  const p = slash(execPath);
  if (p.includes("/deepseek bot") || p.includes("/deepseek-bot") || p.includes("/ds-bot/") || p.endsWith("/ds-bot")) return true;
  if (p.includes("/dsh next") || p.includes("/dsh-next")) return true;
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  const electron = (input.versions ?? process.versions)?.electron;
  if (electron && resourcesLookLikeDesktopInstall(resourcesPath)) return true;
  return false;
}

export function isDesktopSurface(input = {}) {
  const env = input.env ?? process.env;
  if (isCommunityElectronHost(input)) return true;
  const forced = norm(env.DSH_SURFACE);
  if (forced === "desktop") return true;
  if (forced && SURFACES.includes(forced)) return false;

  const execPath = input.execPath ?? process.execPath;
  const name = exeName(execPath);
  if (
    name === "dsh desktop.exe" ||
    name === "dsh desktop" ||
    name === "dsh next.exe" ||
    name === "dsh next" ||
    name === "deepseek harness.exe" ||
    name === "deepseek-harness.exe" ||
    name === "deepseek harness" ||
    name === "deepseek-harness" ||
    HARNESS_EXE_RE.test(name) ||
    DS_YS_EXE_RE.test(name) ||
    /^dsh[\s._-]*next(\.exe)?$/.test(name)
  ) return true;
  if (pathLooksDesktop(execPath)) return true;

  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  if (resourcesLookLikeDesktopInstall(resourcesPath)) return true;

  const argv = input.argv ?? process.argv;
  if ((Array.isArray(argv) ? argv : []).some((arg) => pathLooksDesktop(arg))) return true;

  const parentPort = input.parentPort !== undefined ? input.parentPort : process.parentPort;
  if (parentPort && (pathLooksDesktop(execPath) || resourcesLookLikeDesktopInstall(resourcesPath))) return true;

  if (env.ELECTRON_RUN_AS_NODE && (pathLooksDesktop(execPath) || resourcesLookLikeDesktopInstall(resourcesPath))) return true;
  return false;
}

function forcedSurface(env) {
  const forced = norm(env.DSH_SURFACE);
  return SURFACES.includes(forced) ? forced : "";
}

export function detectSurface(input = {}) {
  const env = input.env ?? process.env;
  if (isCommunityElectronHost(input)) return "desktop";
  const forced = forcedSurface(env);
  if (forced) return forced;
  if (isDesktopSurface(input)) return "desktop";
  return "web";
}

/* ---------------------------------------------------------------- 按宿主树判定面
 * detectSurface() 只看「本进程自己是谁」。插件跑在 host 子进程里时
 * process.execPath 是 node.exe，于是永远返回 web —— 7 条 surfaces:["desktop"]
 * 的补丁（#45 #46 #82 #83 #84 #92 #93）在真正的桌面宿主上被判 na，
 * 桌面专属修复（boot profile 回退、崩溃对话框抑制、更新交接、动作卡 UI）全部不生效。
 *
 * 判据换成「要打补丁的这棵树长什么样」：
 *   <install>/resources/app/...               → 桌面（DS-YS 这种无 asar 的解包布局）
 *   <install>/resources/app.asar.unpacked/... → 桌面
 *   <install>/Contents/Resources/...          → 桌面（macOS .app）
 *   <home>/profiles/desktop/node_modules/...  → 桌面 profile（社区 Electron 把 dsh 装进 profile）
 * 其余（npm 全局、源码仓库）仍是 web。
 */

const DESKTOP_TREE_RE =
  /\/resources\/app(?:\.asar\.unpacked)?\/|\/contents\/resources\/|\/profiles\/desktop(?:-builtins)?\//;

export function surfaceForTree(p) {
  const n = slash(p);
  if (!n) return "";
  return DESKTOP_TREE_RE.test(n) ? "desktop" : "";
}

/**
 * 解析「这个宿主属于哪个面」。宿主树形态优先，进程自身形态兜底。
 * @param {string} aiBase 宿主的 @deepseek-ai 目录（可为空）
 * @param {object} [input] 透传给 detectSurface 的探测输入
 * @returns {"web"|"desktop"|"gui"|"tui"}
 */
export function hostSurface(aiBase, input = {}) {
  const fromTree = surfaceForTree(aiBase);
  if (fromTree) return fromTree;
  return detectSurface(input);
}

/** gui / tui 尚未单独适配，先走 web 重启与探测。 */
export function adapterFor(kind) {
  return kind === "desktop" ? "desktop" : "web";
}
