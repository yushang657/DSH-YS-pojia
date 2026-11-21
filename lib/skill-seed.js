/**
 * skill-seed.js —— 把插件自带的 skill bundle 落到 $DSH_HOME/skills。
 *
 * 为什么需要这一层：
 *   lib/skills.js 只做 import / create / delete，它假设 skill 是"用户带进来的"。
 *   插件自己 ship 的 skill（skills/<id>/）从来没有落地路径，package.json 的 files
 *   里也没有 skills/ —— 也就是说 SKILL.md 打包发出去了，但宿主永远看不见。
 *
 * 设计取舍（与 lib/desktop.js 的 office-skill 自愈保持同一套语义）：
 *   - 只在目标缺失时写，已存在就跳过。用户手改过的 SKILL.md 不会被开机重置。
 *   - 落地后写一份 manifest（$DSH_HOME/dsh-purge/bundled-skills.json），记下每个
 *     文件的 sha256。卸载时只有"与 manifest 完全一致"的目录才会被删；任何漂移
 *     （改过、缺文件、多文件、多符号链接）都视为用户资产，保留。
 *   - 全部同步实现：apply() 是同步函数，落地必须在 apply 返回前完成，否则会和
 *     宿主的 skill 目录扫描形成竞态。
 *   - 任何失败都不抛给 apply()，只返回结构化结果。apply 抛错会让宿主回收插件。
 *
 * 不 import core.js：core.js 已经反向依赖过多模块，这里只走 state-guard 和
 * skills.js 的纯路径函数，避免制造新的循环。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { skillsDir, skillBundleDir, validSkillName } from "./skills.js";
import { readStateJson, writeStateJson } from "./state-guard.js";

/** 插件自带的 bundle 根目录：<plugin>/skills/ */
const BUNDLED_ROOT = path.resolve(fileURLToPath(new URL("../skills/", import.meta.url)));

/** 插件 ship 的 skill id 清单。新增 bundle 目录时同步这里。 */
export const BUNDLED_SKILL_IDS = ["gpt-pojia"];

export const MANIFEST_VERSION = 1;
export const MANIFEST_NAME = "bundled-skills.json";

const MAX_BUNDLE_FILES = 400;
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 12;

/** 与 skills.js 的 SKIP_COPY_NAMES 保持一致，避免两处语义漂移。 */
const SKIP_NAMES = new Set([".", "..", ".system", ".git", "node_modules", "__MACOSX", ".DS_Store"]);

export function bundledSkillsRoot() {
  return BUNDLED_ROOT;
}

export function manifestPath(dshHome) {
  return path.join(String(dshHome || ""), "dsh-purge", MANIFEST_NAME);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function assertInside(root, target) {
  const a = path.resolve(root);
  const b = path.resolve(target);
  const prefix = a.endsWith(path.sep) ? a : a + path.sep;
  if (b !== a && !b.startsWith(prefix)) {
    throw new Error(`skill seed path escaped skills directory: ${target}`);
  }
}

function exists(fp) {
  try {
    fs.accessSync(fp);
    return true;
  } catch {
    return false;
  }
}

/**
 * 递归收集源目录里的普通文件。跳过符号链接与 SKIP_NAMES。
 * 返回 [{ rel, abs, bytes, sha256, buf }]；超限抛错，由调用方降级成 {ok:false}。
 */
function collectSourceFiles(srcRoot) {
  const out = [];
  let totalBytes = 0;

  const walk = (dir, rel, depth) => {
    if (depth > MAX_DEPTH) throw new Error(`bundle 目录过深（>${MAX_DEPTH}）：${rel || "."}`);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    // 排序保证 manifest 稳定，重跑不产生 diff
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name) || entry.name.startsWith("._")) continue;
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, nextRel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const buf = fs.readFileSync(abs);
      totalBytes += buf.length;
      if (out.length + 1 > MAX_BUNDLE_FILES) {
        throw new Error(`bundle 文件数超过上限 ${MAX_BUNDLE_FILES}`);
      }
      if (totalBytes > MAX_BUNDLE_BYTES) {
        throw new Error(`bundle 体积超过上限 ${MAX_BUNDLE_BYTES} B`);
      }
      out.push({ rel: nextRel, abs, bytes: buf.length, sha256: sha256(buf), buf });
    }
  };

  walk(srcRoot, "", 0);
  return out;
}

function readManifest(dshHome) {
  const empty = { version: MANIFEST_VERSION, skills: {} };
  if (!dshHome) return empty;
  const raw = readStateJson(manifestPath(dshHome), null);
  if (!raw || typeof raw !== "object") return empty;
  if (raw.version !== MANIFEST_VERSION || !raw.skills || typeof raw.skills !== "object") return empty;
  const skills = {};
  for (const [id, entry] of Object.entries(raw.skills)) {
    if (!validSkillName(id)) continue;
    if (!entry || typeof entry !== "object") continue;
    const files = entry.files && typeof entry.files === "object" ? entry.files : {};
    const clean = {};
    for (const [rel, digest] of Object.entries(files)) {
      if (typeof rel !== "string" || !rel) continue;
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) continue;
      clean[rel] = digest;
    }
    skills[id] = { seededAt: String(entry.seededAt || ""), files: clean };
  }
  return { version: MANIFEST_VERSION, skills };
}

function writeManifest(dshHome, manifest) {
  try {
    const r = writeStateJson(manifestPath(dshHome), manifest);
    return r && r.ok === true ? "written" : `failed:${r && r.code ? r.code : "unknown"}`;
  } catch (e) {
    return `failed:${String((e && e.code) || "throw")}`;
  }
}

/**
 * 把一个 bundle 目录写进 $DSH_HOME/skills/<id>。
 * 目标 SKILL.md 已存在 → 跳过（保护用户手改）。返回结构化结果，不抛。
 */
function seedOne(dshHome, id) {
  if (!validSkillName(id)) return { id, action: "invalid-id" };
  const srcRoot = path.join(BUNDLED_ROOT, id);
  const srcSkill = path.join(srcRoot, "SKILL.md");
  if (!exists(srcSkill)) return { id, action: "missing-source", src: srcRoot };

  const destRoot = skillBundleDir(dshHome, id);
  assertInside(skillsDir(dshHome), destRoot);

  const files = collectSourceFiles(srcRoot);
  if (files.length === 0) return { id, action: "empty-source", src: srcRoot };

  const manifest = readManifest(dshHome);
  const prev = manifest.skills[id] && typeof manifest.skills[id].files === "object"
    ? manifest.skills[id].files
    : null;

  let written = 0;
  let updated = 0;
  const skipped = [];

  for (const f of files) {
    const dest = path.join(destRoot, ...f.rel.split("/"));
    assertInside(destRoot, dest);
    if (exists(dest)) {
      const cur = sha256(fs.readFileSync(dest));
      if (cur === f.sha256) continue;                       // 已是当前版本
      const prevSha = prev ? prev[f.rel] : undefined;
      if (prevSha && cur === prevSha) {
        // 用户没动过这个文件，只是 bundle 升级了 → 跟着升级
        fs.writeFileSync(dest, f.buf, { mode: 0o644 });
        updated += 1;
        continue;
      }
      // 用户改过（或 manifest 里没记录）→ 不动，记一笔
      skipped.push(f.rel);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.buf, { mode: 0o644 });
    written += 1;
  }

  // manifest 永远记"源 bundle 的 hash"，不是磁盘上的实际 hash。
  // 判据因此成立：磁盘 hash == manifest hash → 用户没动过；
  // 不等 → 用户改过，卸载时保留。记磁盘 hash 会让用户改动被误判成干净。
  const record = { seededAt: new Date().toISOString(), files: {} };
  for (const f of files) record.files[f.rel] = f.sha256;

  const changed = written + updated > 0;
  const isNew = !prev;
  if (!changed && !isNew) {
    if (skipped.length) {
      return { id, action: "kept", dest: destRoot, reason: `用户改过 ${skipped.length} 个文件，未覆盖` };
    }
    return { id, action: "kept", dest: destRoot, reason: "已是最新" };
  }
  if (!changed && isNew) {
    // 目录存在但 manifest 没记录：只登记，不写盘
    manifest.skills[id] = record;
    return {
      id,
      action: "adopted",
      dest: destRoot,
      files: 0,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      skipped,
      manifest: writeManifest(dshHome, manifest),
    };
  }

  manifest.skills[id] = record;
  return {
    id,
    action: isNew ? "seeded" : "updated",
    dest: destRoot,
    files: written + updated,
    added: written,
    refreshed: updated,
    skipped,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    manifest: writeManifest(dshHome, manifest),
  };
}

/**
 * 开机落地所有自带 skill。永不抛。
 *
 * @param {string} dshHome
 * @param {{ids?:string[]}} [options]
 * @returns {{ok:boolean,reason?:string,results:object[]}}
 */
export function seedBundledSkills(dshHome, options = {}) {
  const home = String(dshHome || "");
  if (!home) return { ok: false, reason: "no-dsh-home", results: [] };
  const ids = Array.isArray(options.ids) && options.ids.length ? options.ids : BUNDLED_SKILL_IDS;
  const results = [];
  for (const id of ids) {
    try {
      results.push(seedOne(home, id));
    } catch (e) {
      results.push({ id, action: "error", error: String((e && e.message) || e) });
    }
  }
  const ok = results.every((r) => r.action !== "error");
  return { ok, results };
}

/**
 * 卸载时移除"未漂移"的自带 skill。
 *
 * 判据：manifest 里记录的每个文件都存在且 sha256 一致，且目录里没有 manifest
 * 之外的多余文件、没有符号链接。任何一条不满足 → 保留，报 kept-modified。
 *
 * @returns {{ok:boolean,removed:string[],kept:string[],results:object[]}}
 */
export function removeSeededSkills(dshHome) {
  const home = String(dshHome || "");
  const out = { ok: true, removed: [], kept: [], results: [] };
  if (!home) {
    out.ok = false;
    return out;
  }
  const manifest = readManifest(home);
  const ids = Object.keys(manifest.skills);
  if (ids.length === 0) return out;

  for (const id of ids) {
    const record = manifest.skills[id];
    const destRoot = skillBundleDir(home, id);
    try {
      assertInside(skillsDir(home), destRoot);
    } catch (e) {
      out.results.push({ id, action: "refused", error: String(e.message || e) });
      out.kept.push(id);
      continue;
    }

    if (!exists(destRoot)) {
      out.results.push({ id, action: "absent", dest: destRoot });
      delete manifest.skills[id];
      continue;
    }

    let drift = "";
    const recorded = new Set();
    for (const [rel, digest] of Object.entries(record.files)) {
      recorded.add(rel);
      const abs = path.join(destRoot, ...rel.split("/"));
      try {
        const buf = fs.readFileSync(abs);
        if (sha256(buf) !== digest) {
          drift = `modified:${rel}`;
          break;
        }
      } catch {
        drift = `missing:${rel}`;
        break;
      }
    }

    if (!drift) {
      const walkExtra = (dir, rel) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isSymbolicLink()) return `extra-symlink:${nextRel}`;
          if (entry.isDirectory()) {
            const hit = walkExtra(path.join(dir, entry.name), nextRel);
            if (hit) return hit;
            continue;
          }
          if (!recorded.has(nextRel)) return `extra:${nextRel}`;
        }
        return "";
      };
      try {
        drift = walkExtra(destRoot, "");
      } catch {
        drift = "unreadable";
      }
    }

    if (drift) {
      out.results.push({ id, action: "kept-modified", dest: destRoot, reason: drift });
      out.kept.push(id);
      continue;
    }

    try {
      fs.rmSync(destRoot, { recursive: true, force: true });
      out.results.push({ id, action: "removed", dest: destRoot });
      out.removed.push(id);
      delete manifest.skills[id];
    } catch (e) {
      out.ok = false;
      out.results.push({ id, action: "error", error: String((e && e.message) || e) });
      out.kept.push(id);
    }
  }

  writeManifest(home, manifest);
  return out;
}

/**
 * 给状态面板 / verify 用的只读快照。永不抛。
 */
export function bundledSkillStatus(dshHome) {
  const home = String(dshHome || "");
  const manifest = readManifest(home);
  const rows = [];
  for (const id of BUNDLED_SKILL_IDS) {
    const srcRoot = path.join(BUNDLED_ROOT, id);
    const destRoot = home ? skillBundleDir(home, id) : "";
    let sourceOk = false;
    let sourceBytes = 0;
    let sourceFiles = 0;
    try {
      const files = collectSourceFiles(srcRoot);
      sourceFiles = files.length;
      sourceBytes = files.reduce((n, f) => n + f.bytes, 0);
      sourceOk = files.some((f) => f.rel === "SKILL.md");
    } catch {
      sourceOk = false;
    }
    const installed = destRoot ? exists(path.join(destRoot, "SKILL.md")) : false;
    const record = manifest.skills[id];
    let drift = "";
    if (installed && record) {
      for (const [rel, digest] of Object.entries(record.files)) {
        try {
          const buf = fs.readFileSync(path.join(destRoot, ...rel.split("/")));
          if (sha256(buf) !== digest) {
            drift = `modified:${rel}`;
            break;
          }
        } catch {
          drift = `missing:${rel}`;
          break;
        }
      }
    }
    rows.push({
      id,
      source_ok: sourceOk,
      source_files: sourceFiles,
      source_bytes: sourceBytes,
      installed,
      seeded_at: record ? record.seededAt : "",
      drift: drift || "clean",
    });
  }
  return { ok: true, root: BUNDLED_ROOT, manifest: home ? manifestPath(home) : "", skills: rows };
}

export default {
  BUNDLED_SKILL_IDS,
  bundledSkillsRoot,
  manifestPath,
  seedBundledSkills,
  removeSeededSkills,
  bundledSkillStatus,
};
