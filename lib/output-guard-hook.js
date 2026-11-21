/**
 * 输出守卫的运行时接线层。
 *
 * output-guard.js 只做纯函数评分（无副作用、可单测）；这个文件负责把它挂到
 * 宿主的 session/event 流上，并在判定为 repair 时真的把重写要求送回会话。
 *
 * 为什么单独一层：
 *   1. 评分逻辑必须能在没有宿主的环境里跑（scripts/verify-output-guard.mjs 全靠这点）。
 *   2. 接线要处理宿主差异 —— agent 解析路径、事件形状、append/followup 能力探测，
 *      这些脏活不该污染评分表。
 *
 * 与 continue-retry.js 的关系：同一种绑定范式（ctx.on + global + dispose 清理），
 * 但触发源不同 —— 那边看 agent/status 判「这轮是不是挂了」，这边看 session/event
 * 判「这条回复是不是被降级了」。
 */
import {
  GUARD_DEFAULTS,
  scoreOutput,
  buildRepairMessage,
  decideAction,
  describeScore,
} from "./output-guard.js";
import { randomUUID } from "node:crypto";

// 转发评分器的默认值，接线方只需要 import 这一个模块
export { GUARD_DEFAULTS } from "./output-guard.js";

/** 助手消息在事件流里的类型。 */
const ASSISTANT_EVENT = "assistant/message";
/** 人类消息事件类型。 */
const USER_EVENT = "user/message";
/** 插件自己注入的消息带这个 source.kind，必须排除，否则会自我触发。 */
const SELF_SOURCE_KIND = "dsh-purge";

/** 每个会话最多记多少轮的修复计数。超出按插入顺序丢最早的一半。 */
const TRACK_CAP = 200;
const TRACK_EVICT = 50;
/** 同一轮最多修几次。默认取 GUARD_DEFAULTS.maxRepair，这里再兜一个硬上限。 */
const HARD_MAX_REPAIR = 4;

/**
 * 从 assistant/message 事件里取出纯文本。
 *
 * 内容可能是 content 数组，也可能是 message.content（不同宿主包装层不同）。
 * 只收 type === "text" 的块 —— tool_use / reasoning 块不是给用户看的正文，
 * 拿它们评分会把工具名里的 "cannot" 之类误判成拒绝。
 */
export function assistantTextOf(event) {
  const data = event?.data || {};
  const content =
    Array.isArray(data.content) ? data.content
      : Array.isArray(data.message?.content) ? data.message.content
        : null;
  if (!content) {
    // 有些宿主把纯文本直接放 data.text
    const raw = typeof data.text === "string" ? data.text : "";
    return raw;
  }
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "text") continue;
    if (typeof block.text === "string" && block.text) parts.push(block.text);
  }
  return parts.join("\n");
}

/** 这条事件是不是插件自己写的（防自触发）。 */
export function isSelfAuthored(event) {
  const kind = event?.data?.source?.kind ?? event?.data?.message?.source?.kind;
  return kind === SELF_SOURCE_KIND;
}

/**
 * 取「这条助手回复在回应什么」—— 本轮之前最近一条人类消息。
 *
 * 用途：把原始请求塞进重写要求，让模型知道该重做哪件事，而不是空泛地
 * 「重写一下」。找不到就返回空串，buildRepairMessage 会退化处理。
 */
export function requestTextFor(events, seq) {
  const list = Array.isArray(events) ? events : [];
  const limit = Number.isFinite(seq) ? seq : Infinity;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i];
    if (!event) continue;
    if ((event.seq || 0) >= limit) continue;
    if (event.type !== USER_EVENT) continue;
    if (isSelfAuthored(event)) continue;
    const data = event.data || {};
    const content = Array.isArray(data.content) ? data.content : null;
    if (!content) {
      if (typeof data.text === "string" && data.text) return data.text;
      continue;
    }
    const parts = [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text) {
        parts.push(block.text);
      }
    }
    if (parts.length) return parts.join("\n");
  }
  return "";
}

/** 从 session 上取事件列表，兼容 snapshotEvents 与 events 两种暴露方式。 */
export function eventsOf(session) {
  if (!session) return [];
  try {
    if (typeof session.snapshotEvents === "function") return session.snapshotEvents() || [];
  } catch { /* 落到 events */ }
  try {
    if (Array.isArray(session.events)) return session.events;
  } catch { /* ignore */ }
  return [];
}

/**
 * 把 session 解析成能触发新一轮的 agent。
 *
 * 宿主没有公开契约说明 session → agent 的关系，所以这里按已知路径逐个试，
 * 全失败返回 null 由调用方降级到 session.append。**这一步是未验证的**：
 * 不同宿主版本可能都命中不了，此时走 append 分支，行为差异记录在返回值 via 里。
 */
/**
 * 找到能接收 followup 的 agent。
 *
 * 关键：session/event 回调里的第一个参数**不是**会话实例，是个带 id 的事件壳。
 * 直接读 session.agent 永远拿不到，四条候选路径全部落空 —— 这就是纠偏一直
 * 报 repair-failed 的原因：检出了软化，却没法把「重做」送回模型。
 *
 * 所以先从壳上取 id，再回头到 sessions 服务里捞真会话，最后才从真会话上
 * 取 agent。
 */
export function resolveAgent(session, ctx) {
  const direct = [
    () => session?.agent,
    () => session?.host?.agent,
    () => session?.session?.agent,
    () => (typeof ctx?.agentOf === "function" ? ctx.agentOf(session) : null),
  ];
  for (const get of direct) {
    try {
      const agent = get();
      if (agent && typeof agent.followup === "function") return agent;
    } catch { /* 下一个 */ }
  }

  // 事件壳上只有 id：拿它去 sessions 服务里换真会话对象
  const id = session?.id || session?.sessionId || "";
  if (!id) return null;
  let store;
  try {
    store = typeof ctx?.get === "function" ? ctx.get("sessions") : null;
  } catch { store = null; }
  if (!store) return null;

  const real = (() => {
    try {
      if (typeof store.get === "function") return store.get(id);
    } catch { /* 继续试别的形状 */ }
    try {
      const all = typeof store.all === "function" ? store.all()
        : typeof store.list === "function" ? store.list() : [];
      for (const s of all || []) {
        if (s && (s.id === id || s.sessionId === id)) return s;
      }
    } catch { /* ignore */ }
    return null;
  })();
  if (!real) return null;

  const viaReal = [
    () => real.agent,
    () => real.host?.agent,
    () => real.session?.agent,
    () => (typeof ctx?.agentOf === "function" ? ctx.agentOf(real) : null),
  ];
  for (const get of viaReal) {
    try {
      const agent = get();
      if (agent && typeof agent.followup === "function") return agent;
    } catch { /* 下一个 */ }
  }
  return null;
}

/**
 * 把重写要求送回会话。
 *
 * 优先 agent.followup（和 continue-retry 一致，这是宿主承认的续跑入口）。
 * 拿不到 agent 就 session.append 一条 user/message —— 能进事件流，但是否
 * 真的唤起模型取决于宿主，返回值里 via 会标出实际走的那条路。
 */
export function deliverRepair(session, ctx, message) {
  const agent = resolveAgent(session, ctx);
  if (agent) {
    try {
      agent.followup(message);
      return { ok: true, via: "agent.followup" };
    } catch (e) {
      // followup 失败再试 append，不直接放弃
      const fallback = appendRepair(session, message);
      if (fallback.ok) return { ...fallback, via: "session.append", followupError: String(e?.message || e) };
      return { ok: false, via: "agent.followup", error: String(e?.message || e) };
    }
  }
  return appendRepair(session, message);
}

function appendRepair(session, message) {
  if (!session || typeof session.append !== "function") {
    return { ok: false, via: "none", error: "session has no append()" };
  }
  try {
    session.append(USER_EVENT, message);
    return { ok: true, via: "session.append" };
  } catch (e) {
    return { ok: false, via: "session.append", error: String(e?.message || e) };
  }
}

/** 每会话每轮的修复计数。 */
export function createRepairTracker() {
  const bySession = new Map();

  function slot(sessionId) {
    const id = String(sessionId || "");
    if (!id) return null;
    let cur = bySession.get(id);
    if (!cur) {
      if (bySession.size >= TRACK_CAP) {
        let n = 0;
        for (const key of bySession.keys()) {
          bySession.delete(key);
          n += 1;
          if (n >= TRACK_EVICT) break;
        }
      }
      cur = { turnKey: "", count: 0 };
      bySession.set(id, cur);
    }
    return cur;
  }

  return {
    /**
     * 申请一次修复额度。
     * 同一 turnKey 累计到 max 就拒绝 —— 防止「模型不改，我们一直催」的死循环。
     */
    take(sessionId, turnKey, max) {
      const cur = slot(sessionId);
      if (!cur) return false;
      const cap = Math.min(Math.max(Number(max) || 0, 0), HARD_MAX_REPAIR);
      if (cap <= 0) return false;
      if (cur.turnKey !== turnKey) {
        cur.turnKey = turnKey;
        cur.count = 0;
      }
      if (cur.count >= cap) return false;
      cur.count += 1;
      return true;
    },
    reset(sessionId) {
      const id = String(sessionId || "");
      if (id) bySession.delete(id);
    },
    size() { return bySession.size; },
  };
}

/**
 * 算出「这条回复属于哪一轮」。
 *
 * 优先级：
 *   1. event.data.turn —— 宿主自己给的轮号，最可靠
 *   2. 本轮人类消息的 seq —— 一轮里连出多条 assistant/message 时锚点不变，
 *      maxRepair 才真的按轮计数
 *   3. 回复自己的 seq —— 兜底，退化成逐条计数（至少不会跨轮串额度）
 */
export function resolveTurnKey(event, session) {
  const turn = event?.data?.turn;
  if (turn !== undefined && turn !== null) return `turn:${turn}`;
  const seq = event?.seq || 0;
  const request = requestTextFor(eventsOf(session), seq);
  if (request) {
    // 找出这条人类消息的 seq 当锚点
    const list = eventsOf(session);
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const e = list[i];
      if (!e || (e.seq || 0) >= seq) continue;
      if (e.type !== USER_EVENT) continue;
      if (isSelfAuthored(e)) continue;
      return `human:${e.seq || 0}`;
    }
  }
  return `seq:${seq}`;
}

/** 把外部配置规整成评分器认识的形状。 */
export function normalizeGuardConfig(input = {}) {
  const cfg = { ...GUARD_DEFAULTS };
  if (input && typeof input === "object") {
    for (const key of Object.keys(GUARD_DEFAULTS)) {
      if (input[key] !== undefined) cfg[key] = input[key];
    }
  }
  cfg.maxRepair = Math.min(Math.max(Number(cfg.maxRepair) || 0, 0), HARD_MAX_REPAIR);
  return cfg;
}

/**
 * 把 buildRepairMessage 的纯文本包成一条宿主认的 user 消息。
 *
 * source.kind 必须是 dsh-purge —— 既让 isSelfAuthored 能把自己写的东西认出来
 * （否则下一次评分会把纠偏消息当人类请求），也让宿主 UI 知道这不是用户说的话。
 * 形状对齐 continue-retry.js 的 makeContinueMessage。
 */
export function makeRepairEnvelope(text) {
  const body = String(text || "").trim();
  if (!body) return null;
  return {
    id: `dsh-purge-repair-${randomUUID()}`,
    role: "user",
    content: [{ type: "text", text: body }],
    source: {
      kind: SELF_SOURCE_KIND,
      form: "notice",
      summary: "output-repair",
    },
  };
}

/**
 * 挂载输出守卫。
 *
 * options:
 *   getConfig()  → { enabled, autoRepair, maxRepair, strictStripped, ... }
 *                  默认读 options.config，缺省用 GUARD_DEFAULTS
 *   onScore(info) → 每次评分后的回调（诊断/落盘用），info 含 sessionId/event/score/action
 *   tracker       → 自定义额度表（测试注入）
 *   locale        → 'zh' | 'en'，或 (context) => 'zh'|'en' 的解析函数。
 *                  传函数时按会话决定语种（宿主 header.locale 优先），
 *                  传字符串则全局固定。默认 'zh'。
 *
 * 返回 { dispose }，dispose 解绑监听并清定时器。
 */
export function installOutputGuard(ctx, options = {}) {
  const getConfig =
    typeof options.getConfig === "function"
      ? options.getConfig
      : () => normalizeGuardConfig(options.config);
  const tracker = options.tracker || createRepairTracker();
  const localeOption = options.locale;
  const onScore = typeof options.onScore === "function" ? options.onScore : null;
  const stats = { seen: 0, pass: 0, repair: 0, reject: 0, delivered: 0, failed: 0 };

  /** 解析本条回复该用哪种语言写纠偏要求。 */
  function localeFor(session) {
    if (typeof localeOption === "function") {
      try {
        const got = localeOption({ session, ctx });
        return String(got || "").toLowerCase().startsWith("en") ? "en" : "zh";
      } catch {
        return "zh";
      }
    }
    return String(localeOption || "").toLowerCase().startsWith("en") ? "en" : "zh";
  }

  function listen(event, handler) {
    if (typeof ctx?.on !== "function") return null;
    try {
      return ctx.on(event, handler, { global: true });
    } catch {
      try {
        return ctx.on(event, handler);
      } catch {
        return null;
      }
    }
  }

  function report(info) {
    if (!onScore) return;
    try { onScore(info); } catch { /* 回调不能拖垮主流程 */ }
  }

  const off = listen("session/event", (session, event) => {
    try {
      if (event?.type !== ASSISTANT_EVENT) return;
      if (isSelfAuthored(event)) return;
      const cfg = getConfig();
      if (!cfg || cfg.enabled === false) return;

      const text = assistantTextOf(event);
      // 只有工具调用的回合没有正文，不评分 —— 空串会让 scoreOutput 判成 fallback
      if (!text.trim()) return;

      const sessionId = session?.id || "";
      const seq = event?.seq || 0;
      const request = requestTextFor(eventsOf(session), seq);
      const score = scoreOutput(text, { strictStripped: cfg.strictStripped === true });
      const decision = decideAction(score, cfg, 0);

      stats.seen += 1;
      const base = { sessionId, seq, score, decision, request, text };

      if (decision.action === "accept") {
        stats.pass += 1;
        report({ ...base, acted: "none" });
        return;
      }

      if (decision.action === "reject") {
        // 政治内容：不自动重写（重写只会反复踩同一条线），只记账等上层处理
        stats.reject += 1;
        report({ ...base, acted: "none", note: describeScore(score) });
        return;
      }

      // action === 'repair'
      if (!cfg.autoRepair) {
        report({ ...base, acted: "none", note: "autoRepair off" });
        return;
      }
      // 额度按「轮」而不是按「条」计。宿主没给 turn 字段时退到 seq 分段 ——
      // 但同一轮可能连出多条 assistant/message（多步工具回合），逐条重置会让
      // maxRepair 形同虚设，所以缺 turn 时用「本轮人类消息的 seq」当轮次锚。
      const turnKey = resolveTurnKey(event, session);
      if (!tracker.take(sessionId, turnKey, cfg.maxRepair)) {
        report({ ...base, acted: "none", note: "repair budget exhausted" });
        return;
      }
      const message = buildRepairMessage(score, {
        locale: localeFor(session),
        originalRequest: cfg.attachRequest === false ? "" : request,
        attempt: 1,
      });
      const envelope = makeRepairEnvelope(message);
      if (!envelope) {
        report({ ...base, acted: "none", note: "empty repair message" });
        return;
      }
      const sent = deliverRepair(session, ctx, envelope);
      if (sent.ok) stats.repair += 1;
      else stats.failed += 1;
      report({ ...base, acted: sent.ok ? "repair" : "repair-failed", delivery: sent, message: envelope });
    } catch (e) {
      // 观察者绝不能把异常抛回宿主的事件链
      try {
        console.warn("[dsh-purge] output-guard failed:", e?.message || e);
      } catch { /* ignore */ }
    }
  });

  return {
    stats() { return { ...stats }; },
    dispose() {
      try { off?.(); } catch { /* ignore */ }
    },
  };
}
