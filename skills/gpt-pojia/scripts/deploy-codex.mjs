#!/usr/bin/env node
// deploy-codex.mjs —— GPT 破甲载荷的 Codex 部署器
//
// 做四件事，每一步都可回滚：
//   1. 把选定的载荷 md 写进 CODEX_HOME
//   2. 把 config.toml 顶层 model_instructions_file 指向它
//   3. 把改动前的原始行记进 .gpt56-sol-instruct-state.json (version 2)
//   4. 备份 config.toml 到 config.toml.gpt56-sol-instruct.bak（已存在则不覆盖）
//
// 用法：
//   node scripts/deploy-codex.mjs status
//   node scripts/deploy-codex.mjs apply --version v45 [--dry-run] [--codex-dir PATH]
//   node scripts/deploy-codex.mjs restore [--dry-run] [--codex-dir PATH]
//   node scripts/deploy-codex.mjs reset  [--dry-run] [--codex-dir PATH]
//
// 退出码：0 = 成功，1 = 参数或环境错误，2 = 部分目录失败。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REFERENCES_DIR = path.join(PROJECT_ROOT, "references");

const STATE_FILENAME = ".gpt56-sol-instruct-state.json";
const STATE_VERSION = 2;
const BASELINE_BACKUP_SUFFIX = ".gpt56-sol-instruct.bak";

// version key -> { label, md, source }
const PROMPT_VERSIONS = {
  v45: {
    label: "gpt-5.6-v45",
    md: "gpt-5.6-sol-unrestricted-v45.md",
    source: path.join(REFERENCES_DIR, "prompt-v45.md"),
  },
  astra: {
    label: "gpt-6-v2-rc1",
    md: "gpt-6-astra-v2-rc1.md",
    source: path.join(REFERENCES_DIR, "prompt-astra.md"),
  },
  "61sol": {
    label: "gpt-6.1-v1-rc2",
    md: "gpt-6.1-sol-v1-rc2.md",
    source: path.join(REFERENCES_DIR, "prompt-61sol.md"),
  },
};
const DEFAULT_VERSION = "v45";
const MANAGED_FILENAMES = new Set(Object.values(PROMPT_VERSIONS).map((v) => v.md));

// 顶层赋值行：model_instructions_file = "./x.md"  允许行尾注释与单双引号
const MODEL_INSTRUCTIONS_RE =
  /^\s*model_instructions_file\s*=\s*(['"])(.*?)\1\s*(?:#.*)?$/;
const MODEL_ASSIGN_START_RE = /^\s*model_instructions_file\s*=/;
const MODEL_KEY_RE = /^\s*model\s*=/;
const SHA256_RE = /^[0-9a-f]{64}$/;

// ───────────────────────────── 基础工具 ─────────────────────────────

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function isSafePromptFilename(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 128 &&
    !name.includes("\0") &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.startsWith(".") &&
    /^[A-Za-z0-9._-]+\.md$/.test(name)
  );
}

/** 找顶层（第一个 [table] 之前）的 model_instructions_file 行，找不到返回 null。 */
function topLevelModelInstructionsLine(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (const line of lines) {
    const stripped = line.trimStart();
    if (stripped.startsWith("[")) break;
    if (MODEL_ASSIGN_START_RE.test(line)) return line;
  }
  return null;
}

function isValidInstructionLine(line) {
  return (
    typeof line === "string" &&
    !line.includes("\n") &&
    !line.includes("\r") &&
    MODEL_INSTRUCTIONS_RE.test(line)
  );
}

/** 该行是否指向脚本管理的某个载荷文件。 */
function lineReferencesManagedPrompt(line, filenames = MANAGED_FILENAMES) {
  if (!line) return false;
  const m = MODEL_INSTRUCTIONS_RE.exec(line);
  if (!m) return false;
  let ref = m[2].replace(/\\/g, "/");
  if (ref.startsWith("./")) ref = ref.slice(2);
  if (ref.includes("/")) return false;
  return filenames.has(ref);
}

/**
 * 只替换根级赋值，保留所有无关 TOML 文本（注释、表、其他键、换行风格）。
 * replacement 为 null 表示删除该行。
 */
function replaceTopLevelModelInstructions(text, replacement) {
  const src = String(text ?? "");
  const lines = src.split(/(?<=\n)/); // 保留行尾换行
  const tableIndex = lines.findIndex((line) => line.trimStart().startsWith("["));
  const limit = tableIndex === -1 ? lines.length : tableIndex;

  const assignIndexes = [];
  for (let i = 0; i < limit; i += 1) {
    if (MODEL_ASSIGN_START_RE.test(lines[i])) assignIndexes.push(i);
  }

  if (assignIndexes.length > 0) {
    const first = assignIndexes[0];
    const eol = lines[first].endsWith("\r\n") ? "\r\n" : lines[first].endsWith("\n") ? "\n" : "";
    if (replacement === null) {
      lines.splice(first, 1);
    } else {
      lines[first] = replacement + eol;
    }
    return lines.join("");
  }

  if (replacement === null) return src;

  let insertAt = limit;
  for (let i = 0; i < limit; i += 1) {
    if (MODEL_KEY_RE.test(lines[i])) {
      insertAt = i + 1;
      break;
    }
  }
  const eol = lines.some((line) => line.endsWith("\r\n")) ? "\r\n" : "\n";
  if (insertAt > 0 && lines[insertAt - 1] && !lines[insertAt - 1].endsWith("\n")) {
    lines[insertAt - 1] += eol;
  }
  lines.splice(insertAt, 0, replacement + eol);
  return lines.join("");
}

/** 原子写：同目录临时文件 + rename。默认拒绝覆盖符号链接。 */
function atomicWriteText(file, text, { followSymlink = false } = {}) {
  let target = file;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      if (!followSymlink) throw new Error(`refusing to overwrite symlink: ${file}`);
      target = fs.realpathSync(file);
    }
  } catch (e) {
    if (e && e.code !== "ENOENT") throw e;
  }
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  let mode = 0o600;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    /* 新文件用默认 0600 */
  }
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeSync(fd, text, null, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

// ───────────────────────────── 状态文件 ─────────────────────────────

function stateFilePath(codexDir) {
  return path.join(codexDir, STATE_FILENAME);
}

function baselineBackupPath(codexDir) {
  return path.join(codexDir, `config.toml${BASELINE_BACKUP_SUFFIX}`);
}

function readState(codexDir) {
  const raw = readTextSafe(stateFilePath(codexDir));
  if (raw === null) return null;
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!state || typeof state !== "object" || state.version !== STATE_VERSION) return null;

  const prev = state.previous_model_instructions_line;
  if (prev !== null && prev !== undefined && !isValidInstructionLine(prev)) return null;

  const stored = state.managed_prompts;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;

  const managed = {};
  for (const [name, meta] of Object.entries(stored)) {
    if (!isSafePromptFilename(name)) return null;
    if (!meta || typeof meta !== "object") return null;
    if (typeof meta.sha256 !== "string" || !SHA256_RE.test(meta.sha256)) return null;
    if (typeof meta.existed_before !== "boolean") return null;
    managed[name] = { sha256: meta.sha256, existed_before: meta.existed_before };
  }

  return {
    version: STATE_VERSION,
    previous_model_instructions_line: prev ?? null,
    managed_prompts: managed,
  };
}

function saveState(codexDir, state) {
  atomicWriteText(stateFilePath(codexDir), JSON.stringify(state, null, 2) + "\n");
}

// ───────────────────────────── 目录解析 ─────────────────────────────

function resolveCodexDirs(explicitDir) {
  if (explicitDir) {
    const abs = path.resolve(explicitDir);
    return [{ dir: abs, source: "--codex-dir", explicit: true }];
  }
  const found = [];
  const seen = new Set();
  const candidates = [];
  if (process.env.CODEX_HOME) candidates.push({ dir: process.env.CODEX_HOME, source: "CODEX_HOME" });
  candidates.push({ dir: path.join(os.homedir(), ".codex"), source: "~/.codex" });

  for (const c of candidates) {
    const abs = path.resolve(c.dir);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (fs.existsSync(abs)) found.push({ dir: abs, source: c.source, explicit: false });
  }
  return found;
}

// ───────────────────────────── 命令实现 ─────────────────────────────

function loadPrompt(versionKey) {
  const spec = PROMPT_VERSIONS[versionKey];
  if (!spec) throw new Error(`unknown version: ${versionKey}（可选 ${Object.keys(PROMPT_VERSIONS).join(" / ")}）`);
  const text = readTextSafe(spec.source);
  if (text === null) throw new Error(`载荷缺失：${spec.source}`);
  if (!text.trim()) throw new Error(`载荷为空：${spec.source}`);
  return { ...spec, text, sha256: sha256(text), bytes: Buffer.byteLength(text, "utf8") };
}

function cmdStatus(dirs) {
  if (dirs.length === 0) {
    console.log("未找到 Codex 目录（CODEX_HOME 未设置且 ~/.codex 不存在）。用 --codex-dir 指定。");
    return 0;
  }
  for (const { dir, source } of dirs) {
    console.log(`\n== ${dir}   (${source}) ==`);
    const cfg = path.join(dir, "config.toml");
    const cfgText = readTextSafe(cfg);
    if (cfgText === null) {
      console.log("  config.toml          : 缺失");
    } else {
      const line = topLevelModelInstructionsLine(cfgText);
      console.log(`  config.toml          : ${Buffer.byteLength(cfgText, "utf8")} B`);
      console.log(`  顶层指令行           : ${line === null ? "(无)" : line.trim()}`);
      console.log(`  指向脚本管理载荷     : ${lineReferencesManagedPrompt(line) ? "是" : "否"}`);
    }

    const baseline = baselineBackupPath(dir);
    console.log(`  基线备份             : ${fs.existsSync(baseline) ? baseline : "(无)"}`);

    const state = readState(dir);
    if (state === null) {
      console.log("  state                : (无或不可用)");
    } else {
      const prev = state.previous_model_instructions_line;
      console.log(`  state                : v${state.version}，原始行 = ${prev === null ? "(无)" : prev.trim()}`);
      for (const [name, meta] of Object.entries(state.managed_prompts)) {
        console.log(`    · ${name}  sha=${meta.sha256.slice(0, 16)}  existed_before=${meta.existed_before}`);
      }
    }

    for (const spec of Object.values(PROMPT_VERSIONS)) {
      const p = path.join(dir, spec.md);
      const t = readTextSafe(p);
      console.log(
        `  载荷 ${spec.md.padEnd(32, " ")}: ${t === null ? "缺失" : `${Buffer.byteLength(t, "utf8")} B  sha=${sha256(t).slice(0, 16)}`}`,
      );
    }
  }
  return 0;
}

function cmdApply(dirs, versionKey, dryRun) {
  const prompt = loadPrompt(versionKey);
  console.log(`载荷 ${versionKey} → ${prompt.md}  ${prompt.bytes} B  sha=${prompt.sha256.slice(0, 16)}`);
  if (dirs.length === 0) {
    console.error("未找到 Codex 目录。用 --codex-dir 指定。");
    return 1;
  }

  let failures = 0;
  for (const { dir } of dirs) {
    console.log(`\n== ${dir} ==`);
    try {
      if (!fs.existsSync(dir)) {
        if (dryRun) {
          console.log("  [dry] 将创建目录");
        } else {
          fs.mkdirSync(dir, { recursive: true });
          console.log("  已创建目录");
        }
      }
      const cfg = path.join(dir, "config.toml");
      const mdPath = path.join(dir, prompt.md);
      const baseline = baselineBackupPath(dir);

      const cfgText = readTextSafe(cfg) ?? "";
      const mdBefore = readTextSafe(mdPath);
      const existedBefore = mdBefore !== null;

      // 1) 基线备份：只在缺失时写，保住最初的原始 config
      if (!fs.existsSync(baseline) && fs.existsSync(cfg)) {
        if (dryRun) {
          console.log(`  [dry] 备份 ${cfg} → ${path.basename(baseline)}`);
        } else {
          atomicWriteText(baseline, cfgText);
          console.log(`  基线已备份 → ${path.basename(baseline)}`);
        }
      } else if (fs.existsSync(baseline)) {
        console.log("  基线已存在，不覆盖");
      }

      // 2) 写载荷
      if (dryRun) {
        console.log(`  [dry] 写 ${prompt.md}（${prompt.bytes} B）`);
      } else {
        atomicWriteText(mdPath, prompt.text);
        console.log(`  载荷已写入 ${prompt.md}`);
      }

      // 3) state：记录改动前的原始行
      const state = readState(dir) ?? (() => {
        let currentLine = topLevelModelInstructionsLine(cfgText);
        if (lineReferencesManagedPrompt(currentLine, new Set([...MANAGED_FILENAMES, prompt.md]))) {
          // 已指向管理载荷但没有 state：从基线找回真正的原始行
          const baseText = readTextSafe(baseline);
          const baseLine = baseText === null ? null : topLevelModelInstructionsLine(baseText);
          currentLine = lineReferencesManagedPrompt(baseLine) ? null : baseLine;
        }
        return {
          version: STATE_VERSION,
          previous_model_instructions_line: currentLine ?? null,
          managed_prompts: {},
        };
      })();

      const prevMeta = state.managed_prompts[prompt.md];
      const wasPreexisting =
        prevMeta && typeof prevMeta === "object" ? prevMeta.existed_before : existedBefore;
      state.managed_prompts[prompt.md] = {
        sha256: prompt.sha256,
        existed_before: Boolean(wasPreexisting),
      };

      if (dryRun) {
        console.log(`  [dry] 写 ${STATE_FILENAME}（原始行 = ${state.previous_model_instructions_line === null ? "(无)" : state.previous_model_instructions_line.trim()}）`);
      } else {
        saveState(dir, state);
        console.log(`  state 已更新（原始行 = ${state.previous_model_instructions_line === null ? "(无)" : state.previous_model_instructions_line.trim()}）`);
      }

      // 4) 改 config.toml 顶层行
      const target = `model_instructions_file = "./${prompt.md}"`;
      const newText = replaceTopLevelModelInstructions(cfgText, target);
      if (newText === cfgText) {
        console.log(`  config.toml 无需改动（已指向 ${prompt.md}）`);
      } else if (dryRun) {
        console.log(`  [dry] config.toml 将设为：${target}`);
      } else {
        atomicWriteText(cfg, newText, { followSymlink: true });
        console.log(`  config.toml 已设为：${target}`);
      }

      // 5) 回读校验
      if (!dryRun) {
        const back = readTextSafe(cfg) ?? "";
        const line = topLevelModelInstructionsLine(back);
        const mdBack = readTextSafe(mdPath);
        const okLine = line !== null && MODEL_INSTRUCTIONS_RE.test(line) && line.includes(`./${prompt.md}`);
        const okMd = mdBack !== null && sha256(mdBack) === prompt.sha256;
        console.log(`  校验：行=${okLine ? "OK" : "FAIL"} 载荷=${okMd ? "OK" : "FAIL"}`);
        if (!okLine || !okMd) failures += 1;
      }
    } catch (e) {
      failures += 1;
      console.error(`  失败：${e && e.message ? e.message : e}`);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} 个目录失败。`);
    return 2;
  }
  console.log(dryRun ? "\n[dry-run] 未写任何文件。" : "\n部署完成。重启 Codex 生效。");
  return 0;
}

function cmdRestore(dirs, dryRun) {
  if (dirs.length === 0) {
    console.error("未找到 Codex 目录。用 --codex-dir 指定。");
    return 1;
  }
  let failures = 0;
  for (const { dir } of dirs) {
    console.log(`\n== ${dir} ==`);
    try {
      const cfg = path.join(dir, "config.toml");
      const cfgText = readTextSafe(cfg);
      if (cfgText === null) {
        console.log("  config.toml 缺失，跳过");
        continue;
      }
      const state = readState(dir);
      const managed = new Set(MANAGED_FILENAMES);
      if (state) for (const name of Object.keys(state.managed_prompts)) managed.add(name);

      const currentLine = topLevelModelInstructionsLine(cfgText);
      if (!lineReferencesManagedPrompt(currentLine, managed)) {
        console.log("  当前行不受脚本管理，不动");
        continue;
      }

      let prevLine = state ? state.previous_model_instructions_line : null;
      if (!state) {
        const baseText = readTextSafe(baselineBackupPath(dir));
        const baseLine = baseText === null ? null : topLevelModelInstructionsLine(baseText);
        prevLine = lineReferencesManagedPrompt(baseLine) ? null : baseLine;
      }

      const newText = replaceTopLevelModelInstructions(cfgText, prevLine ?? null);
      if (newText === cfgText) {
        console.log("  无需改动");
      } else if (dryRun) {
        console.log(`  [dry] 将还原为：${prevLine === null ? "(删除该行)" : prevLine.trim()}`);
      } else {
        atomicWriteText(cfg, newText, { followSymlink: true });
        console.log(`  已${prevLine === null ? "删除" : "还原"}顶层指令行${prevLine === null ? "" : `：${prevLine.trim()}`}`);
      }
    } catch (e) {
      failures += 1;
      console.error(`  失败：${e && e.message ? e.message : e}`);
    }
  }
  if (failures > 0) return 2;
  console.log(dryRun ? "\n[dry-run] 未写任何文件。" : "\n还原完成。重启 Codex 生效。");
  return 0;
}

function cmdReset(dirs, dryRun) {
  if (dirs.length === 0) {
    console.error("未找到 Codex 目录。用 --codex-dir 指定。");
    return 1;
  }
  let failures = 0;
  for (const { dir } of dirs) {
    console.log(`\n== ${dir} ==`);
    try {
      const cfg = path.join(dir, "config.toml");
      const cfgText = readTextSafe(cfg);
      const state = readState(dir);
      const managed = new Set(MANAGED_FILENAMES);
      if (state) for (const name of Object.keys(state.managed_prompts)) managed.add(name);

      // 1) 还原行
      if (cfgText !== null) {
        const currentLine = topLevelModelInstructionsLine(cfgText);
        if (lineReferencesManagedPrompt(currentLine, managed)) {
          let prevLine = state ? state.previous_model_instructions_line : null;
          if (!state) {
            const baseText = readTextSafe(baselineBackupPath(dir));
            const baseLine = baseText === null ? null : topLevelModelInstructionsLine(baseText);
            prevLine = lineReferencesManagedPrompt(baseLine) ? null : baseLine;
          }
          const newText = replaceTopLevelModelInstructions(cfgText, prevLine ?? null);
          if (newText !== cfgText) {
            if (dryRun) {
              console.log(`  [dry] 将还原顶层行：${prevLine === null ? "(删除)" : prevLine.trim()}`);
            } else {
              atomicWriteText(cfg, newText, { followSymlink: true });
              console.log("  顶层行已还原");
            }
          }
        } else {
          console.log("  顶层行不受脚本管理，保持原样");
        }
      }

      // 2) 删除脚本创建的载荷（existed_before=false 才删）
      for (const name of managed) {
        const p = path.join(dir, name);
        if (!fs.existsSync(p)) continue;
        const meta = state ? state.managed_prompts[name] : null;
        const ownedByUs = meta ? meta.existed_before === false : true;
        if (!ownedByUs) {
          console.log(`  保留 ${name}（部署前已存在）`);
          continue;
        }
        if (dryRun) {
          console.log(`  [dry] 删除 ${name}`);
        } else {
          fs.unlinkSync(p);
          console.log(`  已删除 ${name}`);
        }
      }

      // 3) 删 state
      const sp = stateFilePath(dir);
      if (fs.existsSync(sp)) {
        if (dryRun) {
          console.log(`  [dry] 删除 ${STATE_FILENAME}`);
        } else {
          fs.unlinkSync(sp);
          console.log(`  已删除 ${STATE_FILENAME}`);
        }
      }
    } catch (e) {
      failures += 1;
      console.error(`  失败：${e && e.message ? e.message : e}`);
    }
  }
  if (failures > 0) return 2;
  console.log(dryRun ? "\n[dry-run] 未写任何文件。" : "\n重置完成。基线备份保留。");
  return 0;
}

// ───────────────────────────── 参数解析 ─────────────────────────────

function parseArgs(argv) {
  const out = { command: "", version: DEFAULT_VERSION, dryRun: false, codexDir: "" };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--version") out.version = String(argv[++i] ?? "");
    else if (a.startsWith("--version=")) out.version = a.slice("--version=".length);
    else if (a === "--codex-dir") out.codexDir = String(argv[++i] ?? "");
    else if (a.startsWith("--codex-dir=")) out.codexDir = a.slice("--codex-dir=".length);
    else if (a === "-h" || a === "--help") out.command = "help";
    else if (a.startsWith("-")) throw new Error(`未知参数：${a}`);
    else rest.push(a);
  }
  if (!out.command) out.command = rest[0] ?? "status";
  return out;
}

function usage() {
  console.log(
    [
      "用法: node scripts/deploy-codex.mjs <command> [options]",
      "",
      "命令:",
      "  status                       查看目录、当前指令行、state、载荷状态",
      "  apply                        部署载荷并改写顶层 model_instructions_file",
      "  restore                      只还原顶层行，不动载荷文件",
      "  reset                        还原顶层行 + 删除脚本创建的载荷 + 删 state",
      "",
      "选项:",
      `  --version <${Object.keys(PROMPT_VERSIONS).join("|")}>   载荷版本，默认 ${DEFAULT_VERSION}`,
      "  --codex-dir <path>           指定 Codex 目录（默认 CODEX_HOME，再退 ~/.codex）",
      "  --dry-run                    只打印将做的改动，不写文件",
      "",
      "版本:",
      ...Object.entries(PROMPT_VERSIONS).map(
        ([k, v]) => `  ${k.padEnd(6, " ")} ${v.label.padEnd(18, " ")} → ${v.md}`,
      ),
    ].join("\n"),
  );
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e && e.message ? e.message : e));
    usage();
    return 1;
  }

  if (args.command === "help") {
    usage();
    return 0;
  }

  const dirs = resolveCodexDirs(args.codexDir);
  switch (args.command) {
    case "status":
      return cmdStatus(dirs);
    case "apply":
      return cmdApply(dirs, args.version, args.dryRun);
    case "restore":
      return cmdRestore(dirs, args.dryRun);
    case "reset":
      return cmdReset(dirs, args.dryRun);
    default:
      console.error(`未知命令：${args.command}`);
      usage();
      return 1;
  }
}

process.exitCode = main();
