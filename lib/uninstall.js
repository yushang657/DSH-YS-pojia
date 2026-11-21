import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import * as core from "./core.js";
import * as hostctl from "./host.js";
import * as rules from "./rules.js";
import * as updater from "./update.js";
import { clearDrillGrant } from "./drill-grant.js";
import { clearOwnedSelectedDefault, removeStaleAgentPresetDir } from "./preset-default.js";
import { removeSeededSkills } from "./skill-seed.js";

/* 包名 / 安装目录名。改名后 profile 里装的是 node_modules/ys-pojia，
   但历史安装仍是 dsh-purge —— 两者都要认，否则卸载与自更新找不到自己。
   单一来源在 update.js，避免两处漂移。 */
export const PKG_NAMES = updater.PKG_NAMES;
const ALL_BUNDLE_IDS = ["ys-pojia", "dsh-purge", "ys-pojia-main", "dsh-purge-main"];

/** 某目录名是否是本插件的安装目录名（大小写不敏感）。 */
export function isPluginDirName(name) {
  const n = String(name || "").toLowerCase();
  return n === "ys-pojia" || n === "dsh-purge";
}

/** 在 profileDir 下定位真实的安装目录（新旧名都试）。返回第一个存在的绝对路径。 */
export function findPluginInstallDir(profileDir) {
  for (const nm of PKG_NAMES) {
    const p = path.join(profileDir, "node_modules", nm);
    if (fs.existsSync(p)) return p;
  }
  return "";
}

export function wasApplied(state) {
  if (!state) return false;
  if (state.has_backup) return true;
  if (Number(state.patches_applied) > 0) return true;
  return [state.shim_cmd, state.shim_ps1, state.shim_bin].includes("patched");
}

export function shouldDeletePluginTree(dir) {
  if (!dir) return false;
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    real = path.resolve(dir);
  }
  const n = real.replace(/[/\\]+/g, "/").toLowerCase();
  // npm link / file: 安装的 realpath 会指到用户源码目录；只认安装树路径，
  // 不按末段名字猜，避免卸载时把源码仓库整棵删掉。
  return n.includes("/node_modules/ys-pojia") || n.includes("/node_modules/dsh-purge");
}

function isPurgeBundleItem(item) {
  if (typeof item === "string") {
    const n = item.split("@")[0].toLowerCase();
    return ALL_BUNDLE_IDS.includes(n);
  }
  const id = item && (item.id || item.name);
  return typeof id === "string" && ALL_BUNDLE_IDS.includes(id.toLowerCase());
}

function stripBundleList(list) {
  if (!Array.isArray(list)) return { list, changed: false };
  const next = list.filter((item) => !isPurgeBundleItem(item));
  return { list: next, changed: next.length !== list.length };
}

export function stripPluginFromPackage(pkg) {
  if (!pkg || typeof pkg !== "object") return false;
  let changed = false;
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (!pkg[key]) continue;
    for (const nm of PKG_NAMES) {
      if (Object.prototype.hasOwnProperty.call(pkg[key], nm)) {
        delete pkg[key][nm];
        changed = true;
      }
    }
  }
  for (const key of ["bundles", "plugins"]) {
    const top = stripBundleList(pkg[key]);
    if (top.changed) {
      pkg[key] = top.list;
      changed = true;
    }
    const nested = pkg.dsh && pkg.dsh.profile ? pkg.dsh.profile[key] : null;
    const nest = stripBundleList(nested);
    if (nest.changed) {
      pkg.dsh.profile[key] = nest.list;
      changed = true;
    }
  }
  return changed;
}

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(fp, value) {
  core.atomicWriteSync(fp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function pkgMentionsPurge(pkg) {
  if (!pkg) return false;
  for (const nm of PKG_NAMES) {
    if (pkg.dependencies?.[nm] || pkg.devDependencies?.[nm]) return true;
  }
  for (const key of ["bundles", "plugins"]) {
    if (Array.isArray(pkg[key]) && pkg[key].some(isPurgeBundleItem)) return true;
    const nested = pkg.dsh && pkg.dsh.profile ? pkg.dsh.profile[key] : null;
    if (Array.isArray(nested) && nested.some(isPurgeBundleItem)) return true;
  }
  return false;
}

export function listInstalledProfiles(dshHome = core.findDshHome()) {
  const root = path.join(dshHome, "profiles");
  if (!fs.existsSync(root)) return [];
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const dir = path.join(root, name);
    const pkgPath = path.join(dir, "package.json");
    const pkg = readJson(pkgPath);
    const nm = findPluginInstallDir(dir);
    if (!pkgMentionsPurge(pkg) && !nm) continue;
    let spec = "";
    for (const key of ["dependencies", "devDependencies"]) {
      for (const pn of PKG_NAMES) {
        if (pkg?.[key]?.[pn]) { spec = String(pkg[key][pn]); break; }
      }
      if (spec) break;
    }
    out.push({ name, dir, spec, pkgPath, hasModule: Boolean(nm), moduleDir: nm });
  }
  return out;
}

async function unlinkIfExists(fp) {
  try {
    await fsp.unlink(fp);
    return true;
  } catch (e) {
    if (e && e.code === "ENOENT") return false;
    throw e;
  }
}

async function rmIfExists(fp) {
  try {
    await fsp.rm(fp, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function removeOverride(dshHome) {
  const fp = core.findOverrideFile(dshHome);
  const ok = await unlinkIfExists(fp);
  return { path: fp, removed: ok };
}

async function resetRules(dshHome) {
  const reset = await rules.resetToOriginal(dshHome);
  const dir = rules.rulesDir(dshHome);
  const removedDir = await rmIfExists(dir);
  return { ...reset, rules_dir: dir, rules_dir_removed: removedDir };
}

function collectCleanupDirs(profiles, dshHome) {
  const seen = new Set();
  const cleanup = [];
  const remember = (dir) => {
    if (!dir) return;
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      real = path.resolve(dir);
    }
    const key = real.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    cleanup.push(real);
  };

  for (const p of profiles) {
    const nm = p.moduleDir || findPluginInstallDir(p.dir);
    if (!nm || !fs.existsSync(nm)) continue;
    let real;
    try {
      real = fs.realpathSync(nm);
    } catch {
      real = path.resolve(nm);
    }
    if (shouldDeletePluginTree(real)) remember(real);
    if (path.resolve(nm).toLowerCase() !== real.toLowerCase()) remember(nm);
  }

  // 状态目录：新旧名都可能是真实存在的那一个
  for (const nm of PKG_NAMES) {
    const dataDir = path.join(dshHome, nm);
    if (fs.existsSync(dataDir)) remember(dataDir);
  }

  const root = updater.pluginRoot();
  if (shouldDeletePluginTree(root)) remember(root);

  return cleanup;
}

function unregisterProfiles(profiles) {
  const stripped = [];
  const errors = [];
  for (const p of profiles) {
    try {
      const pkg = readJson(p.pkgPath) || {};
      if (stripPluginFromPackage(pkg)) {
        writeJson(p.pkgPath, pkg);
        stripped.push(p.name);
      }
    } catch (e) {
      errors.push({ profile: p.name, error: String(e && e.message ? e.message : e) });
    }
  }
  return { stripped, errors };
}

export async function uninstallPurge(options = {}) {
  const onStage = typeof options.onStage === "function" ? options.onStage : () => {};
  onStage("locate");
  const state = await core.gatherState();
  const applied = wasApplied(state);
  const dshHome = state.dsh_home || core.findDshHome();
  const report = {
    ok: true,
    applied,
    reverted: false,
    needRestart: true,
    patches: null,
    shim: null,
    flash: null,
    override: null,
    rules: null,
    skills: null,
    skillsKept: [],
    profiles: [],
    cleanup: [],
    errors: [],
  };

  try {
    onStage("revert");
    if (state.ai_base) {
      report.patches = await core.revertAll(state.ai_base);
      if (applied) report.reverted = true;
    }
  } catch (e) {
    report.errors.push(`revert patches: ${e.message || e}`);
  }
  if (applied && (report.patches?.errors?.length || report.errors.some((e) => /^revert patches:/.test(e)))) {
    report.ok = false;
    report.needRestart = false;
    report.cleanup = [];
    return report;
  }

  try {
    onStage("shim");
    report.shim = await core.revertAllShims();
    if (state.shim_cmd === "patched" || state.shim_ps1 === "patched" || state.shim_bin === "patched") {
      report.reverted = true;
    }
  } catch (e) {
    report.errors.push(`revert shims: ${e.message || e}`);
  }

  onStage("flash");
  try {
    report.flash = core.revertCmdFlash(state.ai_base, dshHome);
  } catch (e) {
    report.errors.push(`revert flash: ${e.message || e}`);
  }

  try {
    report.override = await removeOverride(dshHome);
  } catch (e) {
    report.errors.push(`remove override: ${e.message || e}`);
  }

  try {
    report.rules = await resetRules(dshHome);
  } catch (e) {
    report.errors.push(`reset rules: ${e.message || e}`);
  }

  // 自带 skill：只删"与 manifest 完全一致"的目录。用户改过、加过文件、删过文件
  // 的一律保留 —— 那是用户资产，不是插件残留。
  try {
    report.skills = removeSeededSkills(dshHome);
    if ((report.skills.kept || []).length) {
      report.skillsKept = report.skills.kept.slice();
    }
  } catch (e) {
    report.errors.push(`remove seeded skills: ${e.message || e}`);
  }

  try {
    const preset = clearOwnedSelectedDefault({ dshHome });
    report.presetDefault = { live: preset.live, files: preset.files };
    report.stalePresetDir = removeStaleAgentPresetDir(dshHome, "hacker");
  } catch (e) {
    report.errors.push(`clear selectedDefault: ${e.message || e}`);
  }

  const profiles = listInstalledProfiles(dshHome);
  report.profiles = profiles.map((p) => p.name);
  const unreg = unregisterProfiles(profiles);
  report.stripped = unreg.stripped;
  report.errors.push(...unreg.errors.map((x) => `${x.profile}: ${x.error}`));
  if (unreg.errors.length) {
    report.ok = false;
    report.needRestart = false;
    report.cleanup = [];
    report.drillGrantCleared = false;
    return report;
  }

  try {
    report.drillGrantCleared = clearDrillGrant(dshHome);
  } catch (e) {
    report.ok = false;
    report.needRestart = false;
    report.cleanup = [];
    report.errors.push(`clear drill grant: ${e.message || e}`);
    return report;
  }

  onStage("cleanup");
  report.cleanup = collectCleanupDirs(profiles, dshHome);
  onStage("done");
  return report;
}

export function scheduleCleanupRestart(opts = {}) {
  hostctl.scheduleCleanupRestart(opts);
}
