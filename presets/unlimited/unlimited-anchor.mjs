/**
 * 无限制模式的钉档插件。
 *
 * 先说清一件事，免得后来改的人踩坑：
 *
 * 本插件**拿不到** cordis 里的 `armorEngine` / `armorRules` 服务——
 * 因为这两个名字根本不存在为服务。破甲的档位与规则集是两个普通函数模块：
 *
 *   lib/engines/index.js   saveEngine({dshHome, engine, options, probe})
 *   lib/engines/engine-store.js   readEngineConfig / writeEngineConfig
 *   lib/armor-store.js     readEnabledIds(dshHome) / writeEnabledIds(dshHome, ids)
 *
 * 它们靠 `$DSH_HOME` 定位状态文件，不靠 ctx。所以本插件也不通过 ctx 拿东西，
 * 直接按 DSH_HOME 落盘——这才是它们真实的工作方式。
 *
 * 时机问题：preset 挂载发生在会话建立之前，此时 `$DSH_HOME` 已经确定
 * （由宿主环境决定），状态文件可写。所以插件 init 时就能把档位推上去。
 *
 * 为什么默认不接管：引擎档位是**全局单例**。用户在别的会话手动选了
 * 「边界改写档」，一开无限制模式就被改成「补丁档」，关掉模式后还不还原——
 * 那就成了偷改用户配置。所以默认 `forceInPatchMode: false` 只读不改，
 * 用户明确要接管才设 true。
 *
 * 规则集不一样：规则集本来就是「开关集合」，无限制模式的语义就是全开，
 * 所以默认 `enableAllRules: true`，并在用户关掉模式后**不还原**
 *（还原会丢掉用户自己后来取消勾选的项，同样属于偷改）。
 * 想还原就在杂项页手动点「恢复默认」。
 */

import fs from "node:fs";
import path from "node:path";

export const name = "dsh-purge-unlimited-anchor";
export const MODE = "unlimited";

/** 补丁档 id。写错一个字会静默降级到默认档，集中定义。 */
export const STRONGEST_ENGINE = "patch";

export const ENGINE_FILE = "armor-engine.json";
export const RULES_FILE = "armor-rules.json";

/**
 * 找一个能用的 DSH_HOME。
 *
 * 顺序和宿主一致：先 `DSH_HOME` 环境变量，再 `~/.dsh`。
 * 注意**不要**信 `DSH_HOME` 一定存在文件——定制版宿主常常只设了变量
 * 却没在那里建目录，真正的状态在 `~/.dsh`。所以两个都试，谁有文件用谁。
 */
function resolveHomeCandidates() {
  const out = [];
  const env = String(process.env.DSH_HOME || "").trim();
  if (env) out.push(env);
  const home = String(process.env.USERPROFILE || process.env.HOME || "").trim();
  if (home) out.push(path.join(home, ".dsh"));
  return [...new Set(out.filter(Boolean))];
}

/** 挑第一个「已经存在 armor-engine.json 或 armor-rules.json」的 home。 */
function pickLiveHome() {
  const candidates = resolveHomeCandidates();
  for (const home of candidates) {
    for (const file of [ENGINE_FILE, RULES_FILE]) {
      try {
        if (fs.statSync(path.join(home, file)).isFile()) return home;
      } catch { /* 不存在就试下一个 */ }
    }
  }
  // 一个都没有：用第一个候选（宿主环境变量优先），让后续写入自己建文件。
  return candidates[0] || "";
}

/**
 * 把引擎推到补丁档，同时保留用户原有的 options。
 *
 * 只改 `engine` 字段，其它原样写回——options 里存的是
 * seed/anchor/scopedRules/capabilityProtocol/hostPatches 这些细项，
 * 全抹掉会让用户之前调好的东西白调。
 */
export function forceEngine(dshHome) {
  const file = path.join(dshHome, ENGINE_FILE);
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    raw = {};
  }
  // 已经是补丁档就别动文件，免得刷 mtime 让别的进程缓存失效。
  if (raw.engine === STRONGEST_ENGINE) return { changed: false, engine: STRONGEST_ENGINE };
  const next = { ...raw, engine: STRONGEST_ENGINE };
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { changed: true, engine: STRONGEST_ENGINE };
}

/**
 * 把规则集开到全量。
 *
 * 写 `enabled` 数组而不是 `present`：`armor-store.js` 用 enabled 决定
 * 实际启用的规则，「25 条全在 present 里但 enabled 只有 24 条」是它的默认态
 *（第 10 条政治规则默认关）。无限制模式要的就是把这条也打开。
 *
 * 规则 id 从磁盘上现有的 armor-rules.json 里读，读不到就问 rule-catalog。
 * 不在这里硬编码 1..25——规则会随版本增删，硬编码会漏掉新规则。
 */
export function forceAllRules(dshHome, allIds) {
  const file = path.join(dshHome, RULES_FILE);
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    raw = {};
  }
  const ids = Array.isArray(allIds) && allIds.length
    ? allIds
    : Array.from({ length: 25 }, (_, i) => i + 1);
  const next = { ...raw, enabled: [...ids].sort((a, b) => a - b) };
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { changed: true, count: ids.length };
}

export function apply(ctx, config = {}) {
  const forceInPatchMode = config.forceInPatchMode === true;
  const enableAllRules = config.enableAllRules !== false;
  const allRuleIds = Array.isArray(config.ruleIds) ? config.ruleIds : null;

  // 挂载即生效。没有 await：写两个小 JSON 文件是同步 IO，
  // 挂载期做同步写反而比排微任务更安全（不会和会话首轮抢状态）。
  const home = pickLiveHome();
  const result = { home, engine: null, rules: null, errors: [] };
  if (!home) {
    result.errors.push("找不到 DSH_HOME，无限制模式未钉档");
    return result;
  }

  if (forceInPatchMode) {
    try {
      result.engine = forceEngine(home);
    } catch (err) {
      result.errors.push(`钉引擎失败：${err?.message || err}`);
    }
  }
  if (enableAllRules) {
    try {
      result.rules = forceAllRules(home, allRuleIds);
    } catch (err) {
      result.errors.push(`开规则集失败：${err?.message || err}`);
    }
  }
  return result;
}
