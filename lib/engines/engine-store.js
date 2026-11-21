/**
 * 破甲引擎选择的持久化。
 *
 * 落盘位置：`$DSH_HOME/armor-engine.json`。
 *
 * 与 armor-store.js 同一套设计理由：
 *  - 不写 `cordis.patch.yml`：那是 Host 启动时读的静态配置，改它要重启，
 *    而「换引擎」必须点了立刻生效。
 *  - 不写 `prompt-inject.md`：那是用户提示词正文，混进状态会被用户编辑互相覆盖。
 *  - 文件扁平可手改：`{ "engine": "patch", "options": {...} }`。
 *
 * 缓存按 (home, mtime) 失效。文件损坏 → 返回默认引擎，不抛异常：
 * 引擎配置坏掉不能让整段破甲失效。
 */

import fs from "node:fs";
import path from "node:path";
import { writeStateJson } from "../state-guard.js";

const FILE_NAME = "armor-engine.json";

/** 缓存：key = home。mtime 变了才重读。 */
let cache = { home: "", mtime: 0, value: null, loaded: false };

/** 文件路径。home 为空返回空串，调用方自己降级。 */
export function engineConfigPath(dshHome) {
  const home = String(dshHome || "").trim();
  if (!home) return "";
  return path.join(home, FILE_NAME);
}

/**
 * 读取原始引擎配置（不含默认值合并）。
 *
 * 返回语义：
 *  - `null`   → 文件不存在 / 损坏（调用方用默认引擎）
 *  - `{engine, options, explicit}` → 用户显式选择
 *
 * `explicit` 是**用户真的拨过的键**列表。老版本落盘没有这个字段，此时按
 * 「一个都没拨过」处理 —— 这样历史遗留的错值（例如补丁档里躺着
 * `hostPatches:false`，那是别的档位折算写进去的）不会在升级后被当真，
 * 而是回到该引擎自己的默认值。这就是「引擎选项记忆」的判据：只记用户
 * 亲手改过的，不记任何程序折算出来的。
 */
export function readEngineConfig(dshHome) {
  const home = String(dshHome || "").trim();
  const file = engineConfigPath(home);
  if (!file) return null;

  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    if (cache.home === home) cache = { home, mtime: 0, value: null, loaded: true };
    return null;
  }

  if (cache.home === home && cache.loaded && cache.mtime === mtime) {
    return cache.value;
  }

  let value = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const options = parsed.options && typeof parsed.options === "object" && !Array.isArray(parsed.options)
        ? parsed.options
        : {};
      const explicit = Array.isArray(parsed.explicit)
        ? parsed.explicit.filter((k) => typeof k === "string")
        // 老文件没有 explicit：一个键都不算用户拨过，全部回落到引擎默认
        : [];
      value = {
        engine: typeof parsed.engine === "string" ? parsed.engine : null,
        options,
        explicit,
        legacy: !Array.isArray(parsed.explicit),
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      };
    }
  } catch {
    // 坏文件：降级到默认引擎，但不清缓存，避免每轮重试读同一个坏文件
    value = null;
  }

  cache = { home, mtime, value, loaded: true };
  return value;
}

/**
 * 写入引擎配置。
 *
 * `engine` 合法性由调用方（engines/index.js）校验；这里只做 shape 收敛，
 * 保证磁盘上永远是 `{engine, options, explicit, updatedAt}`。
 *
 * `options` 里出现的键 = 用户拨过的键，一并记进 `explicit`。
 * 前端「恢复默认」传 `{}`，此时 `explicit` 为空，下次读到的就是纯默认。
 *
 * @returns {{ok: boolean, value: object|null, path: string, error?: string}}
 */
export function writeEngineConfig(dshHome, engine, options) {
  const home = String(dshHome || "").trim();
  const file = engineConfigPath(home);
  if (!file) {
    return { ok: false, value: null, path: "", error: "DSH_HOME 未解析，无法保存" };
  }

  const opts = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const value = {
    engine: engine == null ? null : String(engine),
    options: opts,
    explicit: Object.keys(opts),
    updatedAt: new Date().toISOString(),
  };

  try {
    /* 走 state-guard：拒绝符号链接目标、原子写、同目录互斥。
       原先的 tmp+rename 只保证"写一半不崩"，不拒绝链接。 */
    const written = writeStateJson(file, value);
    if (!written || written.ok !== true) {
      return {
        ok: false,
        value,
        path: file,
        error: (written && written.error) || "写入引擎配置失败",
        code: (written && written.code) || "EWRITE",
      };
    }
    cache = { home, mtime: 0, value, loaded: false };
    return { ok: true, value, path: file };
  } catch (error) {
    return {
      ok: false,
      value,
      path: file,
      error: String(error?.message || error),
    };
  }
}

/** 清缓存（测试 / 热重载用）。 */
export function resetEngineCache() {
  cache = { home: "", mtime: 0, value: null, loaded: false };
}
