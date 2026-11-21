/**
 * 破甲规则勾选的持久化。
 *
 * 落盘位置：`$DSH_HOME/armor-rules.json`。
 *
 * 为什么不放进 profile 的 `cordis.patch.yml`：
 *   那是 Host 启动时读的静态配置。写它需要重启才生效，而规则勾选应该是
 *   「勾了立刻生效」—— 用户在界面上试不同组合时不可能每次重启。
 *   提示词注入每轮都重新读正文（`readInjectFallback`），所以只要本文件
 *   变了，下一轮注入立刻反映新选择。
 *
 * 为什么不写进 `prompt-inject.md`：
 *   那是用户的提示词正文。把勾选状态混进去，用户改提示词时会互相覆盖，
 *   而且没法表达「全选」和「一条没勾」的区别。
 *
 * 文件格式故意扁平、可手改：
 *   { "enabledIds": [1,2,3,...], "updatedAt": "2026-..." }
 * `enabledIds: null` 表示「用户没设置过」，按 `DEFAULT_ENABLED_IDS` 展开
 * （`defaultOn:true` 的那些，政治规则默认关闭），**不是全部启用**。
 */

import fs from "node:fs";
import path from "node:path";
import { writeStateJson } from "./state-guard.js";
import {
  ALL_RULE_IDS,
  DEFAULT_ENABLED_IDS,
  normalizeEnabledIds,
} from "./rule-catalog.js";

const FILE_NAME = "armor-rules.json";

/** 缓存：避免每轮注入都 stat+读盘。key = home，value = { mtime, ids }。 */
let cache = { home: "", mtime: 0, ids: null, loaded: false };

/** 文件路径。home 为空时返回空串（调用方自己降级）。 */
export function armorRulesPath(dshHome) {
  const home = String(dshHome || "").trim();
  if (!home) return "";
  return path.join(home, FILE_NAME);
}

/**
 * 读取当前启用集合。
 *
 * 返回值语义：
 *  - `null`  → 用户没设置过（文件不存在 / 坏文件），由 `effectiveEnabledIds`
 *              展开成默认集（政治规则关闭）
 *  - `[]`    → 一条都不启用（用户显式全取消）
 *  - `[1,3]` → 显式集合
 *
 * 文件损坏时返回 `null`，**不抛异常** —— 破甲不能因为一个坏 JSON 就整段失效。
 */
export function readEnabledIds(dshHome) {
  const home = String(dshHome || "").trim();
  const file = armorRulesPath(home);
  if (!file) return null;

  let mtime = 0;
  try {
    const stat = fs.statSync(file);
    mtime = stat.mtimeMs;
  } catch {
    // 文件不存在：清缓存，返回 null
    if (cache.home === home) cache = { home, mtime: 0, ids: null, loaded: true };
    return null;
  }

  if (cache.home === home && cache.loaded && cache.mtime === mtime) {
    return cache.ids;
  }

  let ids = null;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    const value = parsed?.enabledIds;
    if (value === null || value === undefined) {
      ids = null;
    } else if (Array.isArray(value)) {
      ids = normalizeEnabledIds(value);
    } else {
      ids = normalizeEnabledIds(value);
    }
  } catch {
    // 坏文件：降级全启用，但不清缓存，避免每轮都重试读同一个坏文件
    ids = null;
  }

  cache = { home, mtime, ids, loaded: true };
  return ids;
}

/**
 * 写入启用集合。
 *
 * @param {string} dshHome
 * @param {number[]|null|string} input - 数组 / `"all"` / `"none"` / null
 * @returns {{ok: boolean, enabledIds: number[]|null, path: string}}
 */
export function writeEnabledIds(dshHome, input) {
  const home = String(dshHome || "").trim();
  const file = armorRulesPath(home);
  if (!file) {
    return { ok: false, enabledIds: null, path: "", error: "DSH_HOME 未解析，无法保存" };
  }

  let ids;
  if (input === "all" || input === "*" || input === null || input === undefined) {
    ids = null;
  } else if (input === "none" || input === "") {
    ids = [];
  } else {
    ids = normalizeEnabledIds(input);
  }

  const payload = {
    enabledIds: ids,
    updatedAt: new Date().toISOString(),
    note: ids === null
      ? "null = 未设置，按默认集（defaultOn:true，政治规则默认关闭）"
      : "显式启用集合；空数组 = 全部取消",
  };

  try {
    /* 走 state-guard：拒绝符号链接目标、原子写、同目录互斥。
       缓存只在真的落盘成功后更新，失败时保留旧快照（读侧语义不变）。 */
    const written = writeStateJson(file, payload);
    if (!written || written.ok !== true) {
      return {
        ok: false,
        enabledIds: ids,
        path: file,
        error: (written && written.error) || "写入破甲规则失败",
        code: (written && written.code) || "EWRITE",
      };
    }
    cache = { home, mtime: 0, ids, loaded: false };
    return { ok: true, enabledIds: ids, path: file };
  } catch (error) {
    return {
      ok: false,
      enabledIds: ids,
      path: file,
      error: String(error?.message || error),
    };
  }
}

/**
 * 有效启用集合（供界面显示与提示词过滤）。
 *
 * `null` 的语义是「用户没设置过」，此时展开成 **默认集**
 * （`DEFAULT_ENABLED_IDS`，即 `defaultOn:true` 的那些），不是全量。
 * 这样政治规则（`defaultOn:false`）在全新安装上就不会被注入，
 * 否则「默认关闭」这个字段等于没写。
 *
 * v2 迁移：旧版落盘的集合只覆盖当时存在的规则（例如 1..25）。插件升级后
 * 新增的 26..40 从来没进过用户的选择，表现为「新规则在界面上是灰的、
 * 提示词里也没有」。这里把「存储集合的最大 id < 目录最大 id」判定为旧代
 * 落盘，按 DEFAULT_ENABLED_IDS 求并集补齐新增条目；用户显式取消过的老
 * 规则（id ≤ 旧代最大值）保持取消，不会被重新打开。
 */
export function effectiveEnabledIds(dshHome) {
  const ids = readEnabledIds(dshHome);
  if (ids === null) return [...DEFAULT_ENABLED_IDS];
  return upgradeStaleEnabledIds(ids, dshHome);
}

/**
 * 把「旧代落盘」的启用集合补齐到当前目录。
 *
 * 判据：集合里所有 id 都小于目录最大 id（说明落盘时更新的规则还不存在）。
 * 此时把 DEFAULT_ENABLED_IDS 里那些**新 id** 并进来；老 id 一律不动，
 * 用户取消过的仍然是取消。
 *
 * @param {number[]} ids
 * @param {string} [dshHome] 传了就顺手把升级结果写回磁盘
 * @returns {number[]}
 */
export function upgradeStaleEnabledIds(ids, dshHome = "") {
  const list = Array.isArray(ids) ? ids.filter((n) => Number.isFinite(n)) : [];
  if (list.length === 0) return list;
  const maxKnown = Math.max(...ALL_RULE_IDS);
  const maxStored = Math.max(...list);
  if (maxStored >= maxKnown) return list;
  const have = new Set(list);
  const added = DEFAULT_ENABLED_IDS.filter((id) => id > maxStored && !have.has(id));
  if (added.length === 0) return list;
  const next = [...list, ...added].sort((a, b) => a - b);
  // 顺手把升级结果写回磁盘，避免每轮都重算，也让界面读到一致的值
  if (dshHome) {
    try {
      writeEnabledIds(dshHome, next);
    } catch {
      /* 只读 home 时保持内存结果即可 */
    }
  }
  return next;
}


/** 首次安装的默认集合，供界面「恢复默认」用。 */
export function defaultEnabledIds() {
  return [...DEFAULT_ENABLED_IDS];
}

/** 清缓存（测试或热重载用）。 */
export function resetArmorCache() {
  cache = { home: "", mtime: 0, ids: null, loaded: false };
}
