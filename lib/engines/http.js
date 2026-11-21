/**
 * 破甲引擎的 HTTP 桥。
 *
 * 路由（新增，与旧的 /dsh-purge/armor/* 并存）：
 *   GET  /ys-pojia/engine/status    目录 + 当前引擎 + 各引擎可用性 + 生效开关
 *   POST /ys-pojia/engine/set       { engine, options } → 保存并返回新状态
 *   POST /ys-pojia/engine/selftest  自检：注入链四段是否真的产出、补丁命中数
 *   GET  /ys-pojia/engine/selftest  同上（便于 curl 直接打）
 *
 * ── 为什么单独开 /ys-pojia/* 而不是塞进 /dsh-purge/armor/* ───────────────
 * armor 那条路由语义是「25 条规则勾选」，引擎是另一个维度（用哪种方法破甲）。
 * 混在一个 handler 里，op 表会变成两套语义拼在一起，扩展时容易撞名。
 * 新前缀与包名一致（ys-pojia），旧前缀保留不动 —— 已在跑的旧前端缓存
 * 不会因为这次改动而 404。
 *
 * ── 自检做什么 ────────────────────────────────────────────────────────────
 * 「换了引擎到底生效没有」是这类插件最常见的问题。selftest 不做推理，
 * 只把实际产出的东西摆出来：
 *   1. 主体正文有没有内容、多少字节
 *   2. 规则过滤前后各剩几条规则行
 *   3. seed 段是否被引擎开关关掉
 *   4. 补丁命中 / 总数
 *   5. 宿主版本是否在支持列表
 * 任何一项为 0 或异常，界面就能直接指出是哪一环断了，而不是只说「没反应」。
 */

import {
  ENGINE_IDS,
  engineCatalogSnapshot,
  resolveEngine,
  saveEngine,
  normalizeEngineId,
  probeEngine,
  DEFAULT_ENGINE_OPTIONS,
  ENGINE_OPTION_KEYS,
} from "./index.js";
import { seedText, SEED_SECTION } from "./seed.js";
import { scoreOutput } from "../output-guard.js";

/** 统一的 JSON 应答。与 index.js 的 sendJson 保持同一 shape。 */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function sendOptions(response) {
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

async function readJsonBody(request, maxBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

/**
 * 收敛前端传来的 options。
 * 只接受 ENGINE_OPTION_KEYS 里的键；值统一转布尔。未知键丢弃，不报错 ——
 * 前端版本比后端新时多传一个键不该让整个保存失败。
 */
function normalizeOptions(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out = {};
  for (const key of ENGINE_OPTION_KEYS) {
    if (input[key] === undefined) continue;
    out[key] = Boolean(input[key]);
  }
  return out;
}

/**
 * 构建引擎探针。
 *
 * 所有宿主状态由调用方（index.js）提供，engines 目录不反向依赖 core.js ——
 * 这样引擎层可以在单测里直接喂假 probe，不需要起宿主。
 *
 * @param {object} deps
 * @param {Function} deps.gatherState - core.gatherState，返回宿主状态
 * @param {object} deps.core - 需要 ALL_PATCHES.length
 * @returns {Promise<object>} probe
 */
export async function buildEngineProbe(deps = {}) {
  const { gatherState, core } = deps;
  let state = null;
  try {
    state = typeof gatherState === "function" ? await gatherState() : null;
  } catch {
    state = null;
  }
  const totalPatches = Array.isArray(core?.ALL_PATCHES) ? core.ALL_PATCHES.length : 0;
  const applied = Number(
    state?.display_applied ?? state?.patches_applied ?? 0,
  );
  // 分母必须只算「这台宿主上真的该打」的补丁。
  // na / skipped / missing_file 是这套布局天然不存在的目标（社区桌面壳没有官方
  // host 进程管理代码、preset-unrestricted 这类文件本来就不在），把它们算进分母
  // 会让补丁档永远显示 degraded —— 用户看到"74 / 96"以为没洗干净，其实剩下那些
  // 压根无处可写（E-58）。
  //
  // 注意 display_skipped 把 na + missing_file 也折进去了（core.gatherState 口径），
  // 不能直接拿来当 skipped 用，否则分母会被扣两遍。这里一律按 patch_status 的
  // 原始桶统计，缺 patch_status 时才退回 display_*。
  const tally = (state?.patch_status && typeof state.patch_status === "object")
    ? state.patch_status
    : null;
  const countOf = (status) => {
    if (!tally) return 0;
    let n = 0;
    for (const v of Object.values(tally)) if (v === status) n += 1;
    return n;
  };
  const na = tally ? countOf("na") : Number(state?.patches_na ?? 0);
  const skipped = tally ? countOf("skipped") : 0;
  const pending = tally ? countOf("pending") : Number(state?.display_pending ?? 0);
  const drifted = tally ? countOf("drifted") : Number(state?.display_drifted ?? 0);
  const missingFile = tally ? countOf("missing_file") : 0;
  const relevant = tally
    ? Math.max(0, Object.keys(tally).length - na - skipped - missingFile)
    : Math.max(0, totalPatches - na - skipped);
  return {
    aiBase: String(state?.ai_base || ""),
    hostVersion: String(state?.host_version || ""),
    hostSupported: state?.host_supported !== false,
    patchesApplied: Number.isFinite(applied) ? applied : 0,
    patchesTotal: relevant > 0 ? relevant : totalPatches,
    patchesPending: Number.isFinite(pending) ? pending : 0,
    patchesDrifted: Number.isFinite(drifted) ? drifted : 0,
    patchesNa: Number.isFinite(na) ? na : 0,
    patchesSkipped: Number.isFinite(skipped) ? skipped : 0,
    patchesMissingFile: missingFile,
    // 边界改写依赖 system-prompt 的 assemble 钩子。宿主有 systemPrompt 服务
    // 就认为钩子可用；真正的接管失败会体现在 selftest 的 seed/applied 上。
    hookAvailable: true,
  };
}

/**
 * 注入链自检。
 *
 * 只在**当前进程内**重算一遍，不触发真正的提示词装配 —— 那需要 session
 * 上下文。这里复现的是注入链每一段的**输入产出**，足够判断「哪一环空了」。
 *
 * @param {object} deps
 * @param {string} deps.dshHome
 * @param {Function} deps.readBody - () => string，取 prompt-inject.md 正文
 * @param {Function} deps.filterRules - (body, enabledIds) => string
 * @param {Function} deps.readEnabledIds - () => number[]|null
 * @param {Function} deps.detectPresent - (body) => number[]
 * @param {object} deps.probe - buildEngineProbe 的结果
 */
export function buildSelfTest(deps = {}) {
  const {
    dshHome,
    readBody,
    filterRules,
    readEnabledIds,
    detectPresent,
    probe = {},
    locale = "zh",
  } = deps;

  /*
   * 自检报告是给人看的，每一步的标题和说明都要跟界面语言一致。
   * 早先这些文案写死中文，locale 只影响 reasons 和 bytes —— 英文界面下跑自检，
   * 标题栏是英文、下面八行步骤全是中文。
   */
  const isEn = String(locale || "zh").toLowerCase().startsWith("en");
  const pick = (zh, en) => (isEn && en ? en : zh);

  const steps = [];
  const add = (key, label, ok, detail) => steps.push({ key, label, ok: Boolean(ok), detail: String(detail || "") });

  // ── 1. engine resolution ──
  let resolved;
  try {
    resolved = resolveEngine({ dshHome, probe });
    const detail = isEn
      ? `${resolved.engine} (${resolved.state})${resolved.fellBack ? ` - fell back from ${resolved.fellBackFrom}` : ""}`
      : `${resolved.engine}（${resolved.state}）${resolved.fellBack ? ` · 已从 ${resolved.fellBackFrom} 降级` : ""}`;
    add("engine", pick("引擎解析", "Engine resolution"), Boolean(resolved?.engine), detail);
  } catch (e) {
    add("engine", pick("引擎解析", "Engine resolution"), false,
      pick(`异常：${String(e?.message || e)}`, `Error: ${String(e?.message || e)}`));
    return { ok: false, steps, engine: null };
  }

  // ── 2. prompt body ──
  let raw = "";
  try {
    raw = String((typeof readBody === "function" ? readBody() : "") || "");
  } catch (e) {
    raw = "";
    add("body", pick("读取提示词正文", "Read prompt body"), false,
      pick(`异常：${String(e?.message || e)}`, `Error: ${String(e?.message || e)}`));
  }
  if (!steps.some((s) => s.key === "body")) {
    const ok = raw.trim().length > 0;
    add("body", pick("读取提示词正文", "Read prompt body"), ok,
      ok ? pick(`${raw.length} 字符`, `${raw.length} chars`)
         : pick("正文为空 —— 破甲不会有任何效果", "Body is empty - the breach will have no effect"));
  }

  // ── 3. rule filtering ──
  let filtered = raw;
  let enabledIds = null;
  let presentIds = [];
  try { enabledIds = typeof readEnabledIds === "function" ? readEnabledIds() : null; } catch { enabledIds = null; }
  try { presentIds = typeof detectPresent === "function" ? detectPresent(raw) : []; } catch { presentIds = []; }

  if (resolved.options.scopedRules) {
    try {
      filtered = String(typeof filterRules === "function" ? filterRules(raw, enabledIds) : raw);
    } catch (e) {
      filtered = raw;
      add("filter", pick("规则过滤", "Rule filtering"), false,
        pick(`异常，已回退为不过滤：${String(e?.message || e)}`, `Error, fell back to no filtering: ${String(e?.message || e)}`));
    }
    if (!steps.some((s) => s.key === "filter")) {
      const delta = raw.length - filtered.length;
      const n = Array.isArray(enabledIds) ? enabledIds.length : pick("默认集", "default set");
      add("filter", pick("规则过滤", "Rule filtering"), filtered.trim().length > 0,
        isEn
          ? `${n} selected - ${presentIds.length} rule lines present - ${delta} chars trimmed`
          : `勾选 ${n} 条 · 正文存在 ${presentIds.length} 条规则行 · 裁剪 ${delta} 字符`);
    }
  } else {
    add("filter", pick("规则过滤", "Rule filtering"), true,
      pick("已关闭（scopedRules=false），全部规则行原样保留", "Off (scopedRules=false), all rule lines kept as-is"));
  }

  // ── 4. prefix seed ──
  const seedOn = Boolean(resolved.options.seed);
  const seedBody = seedText(locale);
  add("seed", pick("前置 seed", "Prefix seed"),
    seedOn ? seedBody.trim().length > 0 : true,
    seedOn ? `${SEED_SECTION} · ${seedBody.length} ${pick("字符", "chars")}`
           : pick("已关闭（本引擎无改写通道，或用户关掉了）", "Off (this engine has no rewrite channel, or it was turned off)"));

  // ── 5. tail anchor ──
  const anchorOn = Boolean(resolved.options.anchor);
  add("anchor", pick("尾部锚点", "Tail anchor"), true,
    anchorOn ? pick("启用", "Enabled") : pick("已关闭", "Off"));

  // ── 6. patch hits ──
  const total = Number(probe.patchesTotal || 0);
  const applied = Number(probe.patchesApplied || 0);
  if (resolved.engine === "patch" && resolved.options.hostPatches) {
    add("patches", pick("宿主补丁", "Host patches"), total === 0 || applied > 0,
      total === 0
        ? pick("未取得补丁总数（宿主状态不可读）", "Patch total unavailable (host state unreadable)")
        : pick(`${applied} / ${total} 已应用`, `${applied} / ${total} applied`));
    add("hostVersion", pick("宿主版本", "Host version"), probe.hostSupported !== false,
      `${probe.hostVersion || pick("(未知)", "(unknown)")} · ${
        probe.hostSupported !== false
          ? pick("在支持列表内", "in the supported list")
          : pick("不在支持列表，补丁可能对不上", "not in the supported list, patches may not match")
      }`);
  } else {
    add("patches", pick("宿主补丁", "Host patches"), true,
      resolved.engine === "patch"
        ? pick("hostPatches 已关闭，本档不写宿主", "hostPatches is off, this tier writes nothing to the host")
        : pick("本档零补丁，不涉及宿主文件", "This tier patches nothing and touches no host files"));
  }

  // ── 7. output guard ──
  // 不是「配置读到了没有」，而是真跑一遍评分器：拿注入正文本身当样本，
  // 确认它不被判成拒绝/降级，再拿一条已知拒绝样本确认能被抓出来。
  const guardOn = resolved.options.outputGuard !== false;
  if (guardOn) {
    try {
      const passProbe = scoreOutput(filtered || raw, { strictStripped: false });
      const catchProbe = scoreOutput("I cannot help with that.", { strictStripped: false });
      const catches = catchProbe.verdict === "refusal";
      const bodyClean = passProbe.verdict === "pass" || passProbe.verdict === "politics";
      add("outputGuard", pick("输出守卫", "Output guard"), catches && bodyClean,
        isEn
          ? `Body scored ${passProbe.verdict} - refusal sample scored ${catchProbe.verdict}`
            + `${catches ? " (detected)" : " (detection failed)"}`
            + `${bodyClean ? "" : " - the injected body itself was flagged, check the wording"}`
          : `注入正文判为 ${passProbe.verdict} · 拒绝样本判为 ${catchProbe.verdict}`
            + `${catches ? "（可检出）" : "（检出失败）"}`
            + `${bodyClean ? "" : " · 注入正文自身被误判，检查措辞"}`);
    } catch (e) {
      add("outputGuard", pick("输出守卫", "Output guard"), false,
        pick(`评分器异常：${String(e?.message || e)}`, `Scorer error: ${String(e?.message || e)}`));
    }
  } else {
    add("outputGuard", pick("输出守卫", "Output guard"), true,
      pick("已关闭（outputGuard=false），回复不做评分", "Off (outputGuard=false), replies are not scored"));
  }

  const failed = steps.filter((s) => !s.ok);
  return {
    ok: failed.length === 0,
    steps,
    failedKeys: failed.map((s) => s.key),
    engine: resolved.engine,
    state: resolved.state,
    reasons: resolved.reasons,
    options: resolved.options,
    bytes: { raw: raw.length, filtered: filtered.length, seed: seedOn ? seedBody.length : 0 },
  };
}

/**
 * 安装引擎路由。
 *
 * @param {object} webServer - host.webServer
 * @param {object} deps - { findHome, readBody, filterRules, readEnabledIds, detectPresent, gatherState, core }
 * @returns {Function} dispose
 */
/**
 * 从请求里取界面语言。
 *
 * 优先用前端显式传的 ?locale=（面板有中英切换，那个选择优先于浏览器语言），
 * 没有才退回 Accept-Language。
 */
function localeOf(url, request) {
  try {
    const q = url && url.searchParams ? url.searchParams.get("locale") : "";
    if (q) return String(q).toLowerCase().startsWith("en") ? "en" : "zh";
  } catch { /* ignore */ }
  try {
    const h = String((request && request.headers && request.headers["accept-language"]) || "");
    if (h.toLowerCase().startsWith("en")) return "en";
  } catch { /* ignore */ }
  return "zh";
}

export function installEngineHttp(webServer, deps = {}) {
  const stops = [];

  const handle = async (request, response) => {
    if (request.method === "OPTIONS") { sendOptions(response); return; }
    try {
      const url = new URL(request.url ?? "", "http://127.0.0.1");
      const tail = url.pathname.replace(/^\/ys-pojia\/engine\/?/, "").replace(/\/$/, "");
      const isPost = request.method === "POST";
      if (!isPost && request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { ok: false, error: "只接受 GET / POST" });
        return;
      }
      const body = isPost ? await readJsonBody(request) : {};
      const op = body.op || tail || url.searchParams.get("op") || "status";

      const home = (() => {
        try { return String(deps.findHome?.() || ""); } catch { return ""; }
      })();

      if (op === "status") {
        const probe = await buildEngineProbe({ gatherState: deps.gatherState, core: deps.core });
        const resolved = resolveEngine({ dshHome: home, probe });
        // 每个引擎在**当前环境**下的可用性，界面据此把不可用的置灰
        const availability = {};
        for (const id of ENGINE_IDS) {
          availability[id] = probeEngine(id, probe, resolved.options);
        }
        const catalog = engineCatalogSnapshot({ locale: localeOf(url, request) });
        sendJson(response, 200, {
          ok: true,
          ...catalog,
          ...resolved,
          availability,
          probe,
          home,
        });
        return;
      }

      if (op === "set") {
        const engine = body.engine ?? url.searchParams.get("engine");
        if (engine === undefined || engine === null || engine === "") {
          sendJson(response, 400, { ok: false, error: "缺少 engine" });
          return;
        }
        // 允许传 null 表示「恢复默认引擎」
        const wantReset = engine === null || engine === "default" || engine === "__default__";
        const id = wantReset ? null : normalizeEngineId(engine);
        if (!wantReset && !id) {
          sendJson(response, 400, {
            ok: false,
            error: `无效引擎 id: ${engine}（可选：${ENGINE_IDS.join(" / ")}）`,
          });
          return;
        }
        const options = normalizeOptions(body.options);
        const probe = await buildEngineProbe({ gatherState: deps.gatherState, core: deps.core });
        // wantReset 时落盘 {} → explicit 为空 → 该档全部回到默认值。
        const saved = saveEngine({
          dshHome: home,
          engine: id,
          options: wantReset ? {} : options,
          probe,
        });
        if (!saved.ok) {
          sendJson(response, 500, { ok: false, error: saved.error || "保存失败", path: saved.path || "" });
          return;
        }
        // 落盘后立刻刷新运行时开关，否则本进程里 core 的 hostPatches 闸门
        // 还是上一轮的旧值，用户点完「应用」看不到即时效果。
        try {
          if (typeof deps.refreshEngine === "function") deps.refreshEngine();
        } catch { /* 刷新失败不阻断保存结果 */ }
        const resolved = resolveEngine({ dshHome: home, probe });
        const availability = {};
        for (const candidate of ENGINE_IDS) {
          availability[candidate] = probeEngine(candidate, probe, resolved.options);
        }
        sendJson(response, 200, {
          ok: true,
          ...engineCatalogSnapshot({ locale: localeOf(url, request) }),
          ...resolved,
          availability,
          probe,
          storePath: saved.path || "",
          explicitKeys: saved.explicitKeys || [],
          home,
        });
        return;
      }

      if (op === "selftest") {
        const probe = await buildEngineProbe({ gatherState: deps.gatherState, core: deps.core });
        const report = buildSelfTest({
          dshHome: home,
          readBody: deps.readBody,
          filterRules: deps.filterRules,
          readEnabledIds: deps.readEnabledIds,
          detectPresent: deps.detectPresent,
          probe,
          locale: body.locale || url.searchParams.get("locale") || "zh",
        });
        sendJson(response, 200, { ok: true, report, home });
        return;
      }

      if (op === "options") {
        sendJson(response, 200, {
          ok: true,
          optionKeys: ENGINE_OPTION_KEYS,
          optionDefaults: { ...DEFAULT_ENGINE_OPTIONS },
        });
        return;
      }

      sendJson(response, 404, { ok: false, error: `未知 op: ${op}` });
    } catch (e) {
      sendJson(response, 500, { ok: false, error: String(e?.message || e) });
    }
  };

  try {
    const d = webServer.register({
      kind: "prefix",
      path: "/ys-pojia/engine",
      handler: handle,
    }, "ys-pojia: engine");
    if (typeof d === "function") stops.push(d);
  } catch (e) {
    console.warn("[ys-pojia] route /ys-pojia/engine", String(e?.message || e));
  }

  return () => {
    for (let i = stops.length - 1; i >= 0; i -= 1) {
      try { stops[i]?.(); } catch { /* ignore */ }
    }
  };
}
