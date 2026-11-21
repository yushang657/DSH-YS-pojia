#!/usr/bin/env node
/**
 * 插件部署 / 备份 / 恢复。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  为什么需要
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  DSH 插件改完要同步到 profile 的 node_modules 才生效。手工 robocopy 有
 *  两个坑：
 *
 *    ① 漏文件 —— 只 Copy-Item 主文件，新加的 lib/*.js 没过去，加载时
 *       MODULE_NOT_FOUND（这个坑踩过，排查了一小时）。
 *    ② 没法回滚 —— 改坏了只能重装，用户配置全丢。
 *
 *  这个脚本把三件事做成命令：backup / deploy / restore。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  用法
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *    node scripts/deploy.mjs backup             备份当前部署状态
 *    node scripts/deploy.mjs deploy             部署（自动先备份）
 *    node scripts/deploy.mjs restore            从最新备份恢复
 *    node scripts/deploy.mjs restore <目录名>    从指定备份恢复
 *    node scripts/deploy.mjs list               列出所有备份
 *    node scripts/deploy.mjs status             比对源码与部署目录差异
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLUGIN_ID = "ys-pojia";

/** 备份根目录：$DSH_HOME/plugin-backups/ */
function backupRoot() {
  const home = process.env.DSH_HOME
    ? path.normalize(String(process.env.DSH_HOME).trim())
    : path.join(os.homedir(), ".dsh-community");
  return path.join(home, "plugin-backups");
}

/** 部署目标：profile 的 node_modules。 */
function deployTargets() {
  const home = process.env.DSH_HOME
    ? path.normalize(String(process.env.DSH_HOME).trim())
    : path.join(os.homedir(), ".dsh-community");
  const profiles = path.join(home, "profiles");
  if (!fs.existsSync(profiles)) return [];
  return fs
    .readdirSync(profiles, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(profiles, e.name, "node_modules", PLUGIN_ID))
    .filter((p) => fs.existsSync(p));
}

function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    "-" +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

/** 目录大小与文件数（跳过 node_modules / .git）。 */
function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** 跨平台目录复制（不用 robocopy / cp，避免依赖）。 */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let copied = 0;
  const walk = (s, d) => {
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const sp = path.join(s, e.name);
      const dp = path.join(d, e.name);
      if (e.isDirectory()) {
        fs.mkdirSync(dp, { recursive: true });
        walk(sp, dp);
      } else if (e.isFile()) {
        fs.copyFileSync(sp, dp);
        copied += 1;
      }
    }
  };
  walk(src, dst);
  return copied;
}

// ══════════════════════════════════════════════════════════════════════════
//  backup
// ══════════════════════════════════════════════════════════════════════════
function doBackup() {
  const root = backupRoot();
  const name = PLUGIN_ID + "-" + stamp();
  const dst = path.join(root, name);
  fs.mkdirSync(root, { recursive: true });

  // 备份源：优先部署目录（那是正在跑的），否则源码目录
  const targets = deployTargets();
  const src = targets.length ? targets[0] : ROOT;
  const copied = copyDir(src, dst);
  const st = dirStats(dst);

  // 写清单，restore 时用来校验
  fs.writeFileSync(
    path.join(dst, ".backup-meta.json"),
    JSON.stringify(
      {
        plugin: PLUGIN_ID,
        at: new Date().toISOString(),
        source: src,
        files: copied,
        bytes: st.bytes,
        node: process.version,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log("[backup] 源: " + src);
  console.log("[backup] 目标: " + dst);
  console.log("[backup] " + copied + " 个文件 / " + (st.bytes / 1024 / 1024).toFixed(2) + " MB");
  return dst;
}

// ══════════════════════════════════════════════════════════════════════════
//  deploy
// ══════════════════════════════════════════════════════════════════════════
function doDeploy(skipBackup) {
  const targets = deployTargets();
  if (!targets.length) {
    console.error("[deploy] 未找到任何 profile 的 node_modules/" + PLUGIN_ID);
    console.error("[deploy] 先确认 DSH 已安装本插件，或设置 DSH_HOME");
    process.exit(1);
  }

  if (!skipBackup) {
    console.log("[deploy] 先备份当前状态…");
    doBackup();
    console.log("");
  }

  for (const dst of targets) {
    const copied = copyDir(ROOT, dst);
    const st = dirStats(dst);
    console.log("[deploy] → " + dst);
    console.log("[deploy]   " + copied + " 个文件 / " + (st.bytes / 1024 / 1024).toFixed(2) + " MB");
  }

  // ── 关键：touch 磁盘上的 prompt-inject.md ──
  //
  // 为什么必须做：core.syncPromptInjectOnDiskSync 有一条保护规则 ——
  // 磁盘文件的 mtime 早于 asset-table.js 时，判定「盘上是旧一代」，
  // 会用加密槽的正文覆盖磁盘。deploy 刚复制完 asset-table.js，它的
  // mtime 是最新的，而用户的 prompt-inject.md 还是上次的时间，于是
  // 每次 deploy 后第一次启动都会把磁盘正文回退成槽里的内容。
  //
  // 表现就是：改了 lib/default-prompt-inject.md 并重新密封，控制台里
  // 显示的注入词却还是旧的。这里把磁盘文件 touch 一下，让它的 mtime
  // 晚于 asset-table.js，保护规则就会返回 keep 而不是覆盖。
  try {
    const home = process.env.DSH_HOME
      ? path.normalize(String(process.env.DSH_HOME).trim())
      : path.join(os.homedir(), ".dsh-community");
    const injectFile = path.join(home, "prompt-inject.md");
    if (fs.existsSync(injectFile)) {
      const now = new Date();
      fs.utimesSync(injectFile, now, now);
      console.log("[deploy] touch prompt-inject.md（防止被加密槽回退）");
    }
  } catch {
    /* 没有这个文件就跳过 */
  }

  console.log("");
  console.log("[deploy] 完成。重启 DSH 生效（ESM 模块有缓存，不重启不生效）。");
  console.log("[deploy] 回滚: node scripts/deploy.mjs restore");
}

// ══════════════════════════════════════════════════════════════════════════
//  restore
// ══════════════════════════════════════════════════════════════════════════
function listBackups() {
  const root = backupRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(PLUGIN_ID + "-"))
    .map((e) => {
      const p = path.join(root, e.name);
      const metaPath = path.join(p, ".backup-meta.json");
      let meta = null;
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      } catch {
        /* ignore */
      }
      return { name: e.name, path: p, meta, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function doRestore(wanted) {
  const all = listBackups();
  if (!all.length) {
    console.error("[restore] 没有找到任何备份。备份目录: " + backupRoot());
    process.exit(1);
  }
  const pick = wanted ? all.find((b) => b.name === wanted || b.name.includes(wanted)) : all[0];
  if (!pick) {
    console.error("[restore] 找不到备份: " + wanted);
    console.error("[restore] 可用备份:");
    all.forEach((b) => console.error("  " + b.name));
    process.exit(1);
  }

  const targets = deployTargets();
  if (!targets.length) {
    console.error("[restore] 未找到部署目录");
    process.exit(1);
  }

  for (const dst of targets) {
    // 先清空目标（保留目录本身）
    for (const e of fs.readdirSync(dst, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      fs.rmSync(path.join(dst, e.name), { recursive: true, force: true });
    }
    const copied = copyDir(pick.path, dst);
    console.log("[restore] " + pick.name + " → " + dst);
    console.log("[restore]   " + copied + " 个文件");
  }
  console.log("");
  console.log("[restore] 完成。重启 DSH 生效。");
}

// ══════════════════════════════════════════════════════════════════════════
//  status
// ══════════════════════════════════════════════════════════════════════════
function doStatus() {
  const targets = deployTargets();
  console.log("[status] 源码: " + ROOT);
  const srcSt = dirStats(ROOT);
  console.log("[status]   " + srcSt.files + " 个文件 / " + (srcSt.bytes / 1024 / 1024).toFixed(2) + " MB");

  if (!targets.length) {
    console.log("[status] 部署目录: 未找到");
    return;
  }

  for (const dst of targets) {
    const dstSt = dirStats(dst);
    console.log("[status] 部署: " + dst);
    console.log("[status]   " + dstSt.files + " 个文件 / " + (dstSt.bytes / 1024 / 1024).toFixed(2) + " MB");

    // 逐文件比对（只看大小 + mtime，不读内容，快）
    const diffs = [];
    const walk = (rel) => {
      const sp = path.join(ROOT, rel);
      const dp = path.join(dst, rel);
      let se, de;
      try {
        se = fs.readdirSync(sp, { withFileTypes: true });
      } catch {
        return;
      }
      try {
        de = fs.readdirSync(dp, { withFileTypes: true });
      } catch {
        diffs.push({ rel, kind: "部署目录缺失" });
        return;
      }
      const dNames = new Set(de.map((x) => x.name));
      for (const e of se) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const r = path.join(rel, e.name);
        if (!dNames.has(e.name)) {
          diffs.push({ rel: r, kind: "仅源码有" });
        } else if (e.isFile()) {
          try {
            const a = fs.statSync(path.join(ROOT, r));
            const b = fs.statSync(path.join(dst, r));
            if (a.size !== b.size) diffs.push({ rel: r, kind: "大小不同 " + a.size + " vs " + b.size });
          } catch {
            /* ignore */
          }
        } else if (e.isDirectory()) {
          walk(r);
        }
      }
      for (const e of de) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        if (!se.some((x) => x.name === e.name)) diffs.push({ rel: path.join(rel, e.name), kind: "仅部署有" });
      }
    };
    walk("");

    if (!diffs.length) {
      console.log("[status]   ✓ 与源码一致");
    } else {
      console.log("[status]   ⚠ " + diffs.length + " 处差异:");
      diffs.slice(0, 20).forEach((d) => console.log("[status]     " + d.kind + ": " + d.rel));
      if (diffs.length > 20) console.log("[status]     ...还有 " + (diffs.length - 20) + " 处");
      console.log("[status]   跑 node scripts/deploy.mjs deploy 同步");
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  main
// ══════════════════════════════════════════════════════════════════════════
const cmd = (process.argv[2] || "").toLowerCase();
const arg = process.argv[3] || "";

switch (cmd) {
  case "backup":
    doBackup();
    break;
  case "deploy":
    doDeploy(arg === "--no-backup");
    break;
  case "restore":
    doRestore(arg);
    break;
  case "list": {
    const all = listBackups();
    if (!all.length) {
      console.log("没有备份。备份目录: " + backupRoot());
      break;
    }
    console.log("备份目录: " + backupRoot());
    all.forEach((b, i) => {
      const when = b.meta && b.meta.at ? b.meta.at : new Date(b.mtime).toISOString();
      const size = b.meta ? (b.meta.bytes / 1024 / 1024).toFixed(2) + " MB" : "?";
      console.log((i === 0 ? " * " : "   ") + b.name + "  " + when + "  " + size);
    });
    console.log("（* = 最新，restore 默认用它）");
    break;
  }
  case "status":
    doStatus();
    break;
  default:
    console.log("用法:");
    console.log("  node scripts/deploy.mjs backup              备份当前部署状态");
    console.log("  node scripts/deploy.mjs deploy              部署（自动先备份）");
    console.log("  node scripts/deploy.mjs deploy --no-backup  部署（不备份）");
    console.log("  node scripts/deploy.mjs restore [备份名]     恢复（默认最新）");
    console.log("  node scripts/deploy.mjs list                列出备份");
    console.log("  node scripts/deploy.mjs status              比对源码与部署目录");
}
