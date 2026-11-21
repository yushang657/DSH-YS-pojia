/**
 * 重启 / 拉起子进程时的环境变量清洗。
 *
 * 为什么需要这个模块
 * ------------------
 * dsh-purge 的「重启」是从**当前宿主进程内部** spawn 一个新的 Electron。
 * 子进程默认继承 process.env，而宿主进程自己的 env 往往带着一批只在
 * 「当前这一次会话」里成立的变量。这些变量一旦被继承，新拉起的
 * DS-YS / DSHD 会：
 *
 *   1. ELECTRON_RUN_AS_NODE=1
 *      → Electron 退化成纯 node，解析 argv 时报 `bad option: --enable-logging`
 *        然后 exit(0)。外部看到的现象是「点了重启没反应」或「进程 400ms 就没了」，
 *        零窗口、零日志、零 Crashpad dump —— 看起来像装坏了，实际只是这个变量。
 *
 *   2. DSH_HOME=<别的 home>
 *      → 新宿主去加载**另一个** DSH home 的 profile。典型后果是
 *        `[plugin sources] file:///C:/Users/.../.dsh-community/profiles/desktop/`
 *        而真正的 home 是 `.ds-ys`。两边 bundle 集合、bundle 版本、cordis.yml
 *        全不一样，合成出来的树里没有任何 provider，全部插件 pending，
 *        最后 `N required plugins did not activate` → 启动失败弹窗。
 *
 *   3. DSH_PROFILE_DIR=<别的 profile 目录>
 *      → 即使 DSH_HOME 对了，profile 目录也会被这个更具体的变量覆盖，同样跑错树。
 *
 *   4. DSH_SESSION_ID / DSH_SHELL
 *      → 新宿主以为自己还是一个已有会话的子 shell，跳过正常初始化。
 *
 *   5. DSH_PERMISSION_MODE
 *      → 会把当前会话的临时权限模式固化进新进程，绕过用户设置。
 *
 * 处理策略
 * --------
 * 全部**删除**，让新进程按自己的默认逻辑重新推导。唯一需要补的是
 * DSH_PROFILE —— explorer 长期存活时不会刷新环境，从 explorer 拉起的
 * Electron 常常缺这个变量，缺了会报 `cannot determine the boot profile`。
 *
 * 同时提供 `describeSpawnEnv()`，在重启失败时把「清掉了哪些变量、
 * 补了哪些变量」原样写进诊断，用户能直接看到是 env 污染还是补丁没打上。
 */

/** 必须从子进程 env 里彻底删除的变量（大小写不敏感）。 */
export const SCRUB_KEYS = Object.freeze([
  // Electron 运行时开关：留着就让 Electron 变成 node
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ELECTRON_ENABLE_LOGGING",
  "ELECTRON_ENABLE_STACK_DUMPING",
  // DSH 定位变量：留着就让新宿主跑错 home / profile
  "DSH_HOME",
  "DSH_PROFILE_DIR",
  "DSH_SESSION_ID",
  "DSH_SHELL",
  "DSH_AGENT",
  "DSH_WORKSPACE",
  "DSH_BASE",
  // 权限与会话态
  "DSH_PERMISSION_MODE",
  // 本插件自己的重启载荷（一次性，不能继承）
  "DSH_PURGE_RESTART",
]);

/** 删除后需要兜底的变量。 */
export const DEFAULTS = Object.freeze({
  DSH_PROFILE: "desktop",
});

const SCRUB_UPPER = new Set(SCRUB_KEYS.map((k) => k.toUpperCase()));

/**
 * 清洗一份 env，返回新对象（不改入参）。
 *
 * @param {Record<string,string|undefined>} [base] 基准 env，默认 process.env
 * @param {{profile?: string, extra?: Record<string,string>}} [options]
 * @returns {Record<string,string>}
 */
export function scrubSpawnEnv(base, options = {}) {
  const src = base && typeof base === "object" ? base : process.env;
  const out = {};

  for (const key of Object.keys(src)) {
    if (SCRUB_UPPER.has(key.toUpperCase())) continue;
    const value = src[key];
    if (value === undefined) continue;
    out[key] = value;
  }

  // 兜底：explorer 长期存活时 DSH_PROFILE 常常缺失
  const profile = String(options.profile || DEFAULTS.DSH_PROFILE).trim() || DEFAULTS.DSH_PROFILE;
  if (!out.DSH_PROFILE) out.DSH_PROFILE = profile;

  if (options.extra && typeof options.extra === "object") {
    for (const [k, v] of Object.entries(options.extra)) {
      if (v === undefined || v === null) continue;
      out[k] = String(v);
    }
  }

  return out;
}

/**
 * 生成可读的清洗报告，供重启失败诊断使用。
 *
 * @param {Record<string,string|undefined>} [base]
 * @param {{profile?: string}} [options]
 * @returns {{removed: string[], added: string[], profile: string, total: number}}
 */
export function describeSpawnEnv(base, options = {}) {
  const src = base && typeof base === "object" ? base : process.env;
  const removed = [];
  for (const key of Object.keys(src)) {
    if (SCRUB_UPPER.has(key.toUpperCase())) removed.push(key);
  }
  const profile = String(options.profile || DEFAULTS.DSH_PROFILE).trim() || DEFAULTS.DSH_PROFILE;
  const added = src.DSH_PROFILE ? [] : ["DSH_PROFILE=" + profile];
  return { removed, added, profile, total: Object.keys(src).length };
}

/**
 * 给诊断文本用的一行摘要。
 *
 * @param {Record<string,string|undefined>} [base]
 * @param {{profile?: string}} [options]
 * @returns {string}
 */
export function spawnEnvSummary(base, options = {}) {
  const r = describeSpawnEnv(base, options);
  const parts = [];
  if (r.removed.length) parts.push("已清理 " + r.removed.join(","));
  else parts.push("无需清理的污染变量");
  if (r.added.length) parts.push("已补 " + r.added.join(","));
  parts.push("profile=" + r.profile);
  return parts.join("；");
}

export default { SCRUB_KEYS, DEFAULTS, scrubSpawnEnv, describeSpawnEnv, spawnEnvSummary };
