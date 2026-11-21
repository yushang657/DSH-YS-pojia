/**
 * 破甲引擎底座 —— 三档可切换实现。
 *
 * ── 为什么要多引擎 ────────────────────────────────────────────────────────
 * 旧版只有一条路：宿主源码补丁 + 提示词注入。这条路能力最强，但有个硬缺陷：
 * 补丁是**按宿主源码字符串匹配**的（见 core.js 的 PATCHES / CODE_PATCHES）。
 * 宿主版本一变，字符串对不上，补丁静默失效，破甲跟着一起废 —— 用户看到的
 * 只是「装了没反应」。
 *
 * 另外两条路不碰宿主源码：
 *
 *   patch       宿主补丁 + 提示词。86 个 patch 改沙箱/审批/观察策略，
 *               能力上限最高，但绑死宿主版本。
 *   boundary    零补丁。只在**请求边界**改写系统提示词（identity.js 的
 *               rewritePromptAssembly 通道）+ 前置 seed。宿主升级不受影响，
 *               因为一个字节的宿主文件都没改。
 *   prompt-only 零补丁零改写。只换 prompt-inject.md 正文。最保守，
 *               用在宿主版本完全对不上、或者用户只想试提示词效果的场景。
 *
 * ── 引擎不可用时的自动降级 ────────────────────────────────────────────────
 * `resolveEngine()` 返回的可用性带三态：
 *   available   当前宿主上确实能生效
 *   degraded    能跑，但部分能力缺失（例如补丁档在未知宿主上）
 *   unavailable 一点都跑不了（例如补丁档找不到宿主安装目录）
 * 选了 unavailable 的引擎就自动落到下一个可用档，并在状态里写明为什么，
 * 不让用户对着一个不生效的开关发呆。
 *
 * ── 与现有模块的边界 ──────────────────────────────────────────────────────
 * 本目录只负责「决定用哪个引擎」和「该引擎的生效开关」。真正的提示词正文
 * 仍在 lib/default-prompt-inject.md，过滤仍在 lib/rule-catalog.js，补丁仍在
 * lib/core.js。引擎是**策略层**，不是第二套实现，避免同一件事写两遍。
 */

import { readEngineConfig, writeEngineConfig, engineConfigPath } from "./engine-store.js";

/** 引擎 id。顺序即降级顺序（越靠前能力越强）。 */
export const ENGINE_IDS = ["patch", "boundary", "prompt-only"];

/** 未设置时用哪个。与旧行为一致：本插件历史上只有补丁路线。 */
export const DEFAULT_ENGINE = "patch";

/**
 * 引擎元数据。前端直接渲染这张表，不在前端硬编码引擎名 ——
 * 以后加引擎只改这里，界面自动跟上。
 */
/**
 * 关于「降智」的准确定义
 *
 * 这里说的「降智」= **破甲生效之后，模型在正常任务上的表现下降**。
 * 不是指某个模型天生弱，也不是指破甲把模型本身变笨。
 *
 * 典型表现：简单任务开始绕圈子；代码出现低级错误；长对话后半段忘记前文约束；
 * 工具调用参数写错反复重试。
 *
 * 成因：破甲指令本身要占用模型注意力 —— 提示词层注入占上下文，边界层每轮
 * 都要重新解析长指令。模型把一部分注意力花在「理解破甲指令」上，留给任务的
 * 就少了。所以降智程度取决于 **破甲强度 x 上下文占用**，与模型基础能力无关。
 *
 * 同一个模型：不破甲时很聪明，破甲拉满后可能变钝。这是代价，不是缺陷。
 */
export const ENGINE_CATALOG = [
  {
    id: "patch",
    label: "补丁档",
    label_en: "Patch",
    tier: 3,
    /** 是否写宿主文件。true = 宿主升级后需要重新应用。 */
    touchesHost: true,
    /** 是否需要重启宿主才生效。 */
    needsRestart: true,
    tagline: "宿主源码补丁 + 提示词，能力上限最高",
    summary:
      "改写宿主 lib/index.js 的沙箱策略、审批门、观察策略与重复调用守卫，"
      + "再叠加破甲提示词。86 个补丁全部命中时效果最强。",
    pros: [
      "沙箱 deny → allow file-write*，写文件不再被拦",
      "审批门直接 return allowed-once，不再弹审批",
      "观察策略 writeIntent/editIntent 放行，不必先读后写",
      "重复调用守卫关闭，工具可以连续重试",
    ],
    cons: [
      "补丁按宿主源码字符串匹配，宿主版本一变就静默失效",
      "需要重启宿主才能生效",
      "dshTarget 只覆盖 0.2.0-rc.2 ~ 0.2.2-rc.1",
    ],
    bestFor: "宿主版本在支持列表内、需要完整能力的日常使用",

      degradation: {

        level: "none",

        label: "不降智",

        label_en: "No degradation",

        affectsReasoning: false,

        note:

          "改宿主源码，不占模型上下文，推理能力不受影响。"

          + "但沙箱与审批被放行后模型会真的执行更多操作，"

          + "重复调用守卫关闭后死循环风险上升 —— 这是行为风险，不是降智。",

        note_en:

          "Patches host source; adds nothing to the model context, so reasoning is unaffected. "

          + "Sandbox and approval bypass mean the model actually performs more operations, and disabling "

          + "the repeat-call guard raises loop risk. That is behavioural risk, not reduced intelligence.",

      },
  },
  {
    id: "boundary",
    label: "边界改写档",
    label_en: "Boundary",
    tier: 2,
    touchesHost: false,
    needsRestart: false,
    tagline: "零补丁，只在请求边界改写系统提示词",
    summary:
      "一个字节的宿主文件都不改。走 identity.js 的 rewritePromptAssembly 通道，"
      + "在装配系统提示词的那一刻整段替换 + 前置 seed 注入。宿主怎么升级都不受影响。",
    pros: [
      "零宿主补丁，升级不失效",
      "不需要重启，改完下一轮请求就生效",
      "前置 seed + 主体 + 尾部锚点三段夹击，比单段注入更难被裁掉",
    ],
    cons: [
      "沙箱/审批/观察策略仍是宿主默认，写文件与审批拦截照旧",
      "依赖宿主的 system-prompt assemble 钩子，钩子被改就退回 prompt-only",
    ],
    bestFor: "宿主版本不在支持列表内，或不想让插件碰宿主文件",

      degradation: {

        level: "low",

        label: "轻微",

        label_en: "Low",

        affectsReasoning: true,

        note:

          "不碰宿主，改请求视图。代价是上下文占用：seed 几十字 + 主体数千字 + 尾部锚点几百字。"

          + "上下文越满，任务注意力越分散。长对话下比补丁档更容易「变笨」。",

        note_en:

          "No host changes; rewrites the request view. The cost is context budget: a short seed, "

          + "several thousand characters of body, and a few hundred of tail anchor. The fuller the "

          + "context, the more task attention scatters. In long conversations this degrades more than the patch tier.",

      },
  },
  {
    id: "prompt-only",
    label: "纯提示词档",
    label_en: "Prompt only",
    tier: 1,
    touchesHost: false,
    needsRestart: false,
    tagline: "只换提示词正文，零补丁零改写",
    summary:
      "最保守的一档。只把 prompt-inject.md 的正文注入进去，不碰宿主、不做边界改写、"
      + "不加前置 seed。用来单独验证提示词本身的效果，或者宿主环境完全未知时的兜底。",
    pros: [
      "改动面最小，出问题只会是提示词问题",
      "不依赖任何宿主钩子，装得上就有效果",
      "调提示词时不被补丁或 seed 干扰，好做对照",
    ],
    cons: [
      "没有前置 seed，长上下文里容易被后续内容冲淡",
      "沙箱与审批完全不接管",
    ],
    bestFor: "调提示词、做对照实验、或作为最后兜底",

      degradation: {

        level: "lowest",

        label: "最低",

        label_en: "Lowest",

        affectsReasoning: true,

        note:

          "只注入正文，不加 seed / 锚点，上下文占用最少。"

          + "但保护也最弱：长对话里正文会被后续内容冲淡，效果随对话变长而衰减。",

        note_en:

          "Body only, no seed and no anchor, so the smallest context cost. Protection is weakest too: "

          + "in long conversations the body gets diluted and effectiveness decays with length.",

      },
  },
];

const CATALOG_BY_ID = new Map(ENGINE_CATALOG.map((e) => [e.id, e]));

/** 按 id 取引擎元数据。未知 id 返回 null。 */
export function engineById(id) {
  return CATALOG_BY_ID.get(String(id || "")) || null;
}

/** 规范化引擎 id。未知 / 空 → null（表示「未设置」）。 */
export function normalizeEngineId(input) {
  const raw = String(input == null ? "" : input).trim().toLowerCase();
  if (!raw) return null;
  if (CATALOG_BY_ID.has(raw)) return raw;
  // 常见别名，方便手写 JSON 或命令行
  const alias = {
    patch: "patch", patched: "patch", full: "patch", "dsh-purge": "patch",
    boundary: "boundary", inject: "boundary", "boundary-rewrite": "boundary", zero: "boundary",
    prompt: "prompt-only", promptonly: "prompt-only", "prompt_only": "prompt-only", text: "prompt-only",
  }[raw];
  return alias || null;
}

/**
 * 引擎选项的默认值（全局底版）。
 *
 * 注意：真正生效的默认值是**按引擎区分**的，见 ENGINE_OPTION_DEFAULTS_BY_ENGINE。
 * 这里的全局底版只用来给「前端没传、文件也没存」时兜底。
 */
export const DEFAULT_ENGINE_OPTIONS = {
  /** 前置 seed：在主提示词之前插一小段执行态声明。 */
  seed: true,
  /** 尾部锚点：anchor.js 的锚点段，防上下文被宿主裁掉。 */
  anchor: true,
  /** 25 条 Scoped Rules 过滤（按 armor-rules.json 勾选裁剪）。 */
  scopedRules: true,
  /** 能力协议段：教模型主动发现 skill / MCP。 */
  capabilityProtocol: true,
  /** 输出守卫：对模型回复做拒绝/降级/掏空评分，不合格自动要求重写。 */
  outputGuard: true,
  /** 桌面端补丁档：是否允许写宿主文件（仅 patch 档生效）。 */
  hostPatches: true,
  /**
   * 超频（unlimited）：默认关闭，只有用户主动打开才注入那段「资源无上限」声明。
   *
   * 为什么默认关：它鼓励模型无节制派生子代理、多轮交叉核验，token 消耗会成倍
   * 上涨。把它做成显式开关而不是跟着某个模式自动开，是为了让用户自己决定
   * 什么时候付这个代价。
   */
  unlimited: false,
};

/**
 * **按引擎区分**的选项默认值。
 *
 * 为什么必须区分：seed 是「首尾夹击」的前半段，它的价值在于补 boundary 档
 * 没有沙箱/审批接管这个短板。patch 档已经把审批门、沙箱、观察策略全改了，
 * 再叠一段 seed 只是白占 token，反而挤压任务正文。所以：
 *
 *   patch        seed=false（补丁已接管，不需要种子兜底）
 *   boundary     seed=true （零补丁，全靠提示词，必须首尾夹击）
 *   prompt-only  seed 折算为 false（没有改写通道，放了也没地方落）
 */
const ENGINE_OPTION_DEFAULTS_BY_ENGINE = {
  patch: { ...DEFAULT_ENGINE_OPTIONS, seed: false, anchor: true },
  boundary: { ...DEFAULT_ENGINE_OPTIONS, seed: true, anchor: true },
  "prompt-only": { ...DEFAULT_ENGINE_OPTIONS, seed: false, anchor: false },
};

/** 被引擎支持识别的选项键。未知键丢弃，避免脏配置传进注入链。 */
export const ENGINE_OPTION_KEYS = Object.keys(DEFAULT_ENGINE_OPTIONS);

/**
 * 计算某个引擎在当前环境下的能力。
 *
 * `probe` 由调用方传入（index.js 拿得到宿主状态，engines 目录拿不到），
 * 这样引擎模块不用反向依赖 core.js，也能在单测里直接喂假 probe。
 *
 * probe = {
 *   aiBase:      string   宿主安装目录；空 = 没找到
 *   hostVersion: string   宿主版本
 *   hostSupported: boolean 版本是否在 dshTargets 内
 *   patchesApplied: number
 *   patchesTotal: number
 *   hookAvailable: boolean 宿主是否有 system-prompt assemble 钩子
 * }
 *
 * @returns {{state: 'available'|'degraded'|'unavailable', reasons: string[]}}
 */
export function probeEngine(id, probe = {}, options = {}) {
  const meta = engineById(id);
  if (!meta) return { state: "unavailable", reasons: [`未知引擎: ${id}`] };
  const reasons = [];

  if (id === "patch") {
    const aiBase = String(probe.aiBase || "");
    // aiBase 为空说明还没找到宿主安装目录。此时不能判 unavailable ——
    // 宿主可能只是还没启动完，判死会让引擎在 boot 阶段就降级到 boundary，
    // 用户明明装的是补丁档却看到「已降级」，比不降级更让人困惑。
    // 所以只降级，并写清原因。
    if (!aiBase) {
      reasons.push("未找到宿主安装目录，补丁暂无处可写（宿主启动完成后会自动重试）");
      if (options.hostPatches === false) {
        reasons.push("hostPatches 已关闭：本档退化为「只注入提示词」，与 boundary 档能力接近");
      }
      return { state: "degraded", reasons };
    }
    if (probe.hostSupported === false) {
      reasons.push(
        `宿主版本 ${probe.hostVersion || "(未知)"} 不在支持列表内，补丁大概率对不上源码字符串`,
      );
    }
    const total = Number(probe.patchesTotal || 0);
    const applied = Number(probe.patchesApplied || 0);
    // drifted 表示「原文已经不在这个版本的源码里」——上游改了文案，补丁想达到的
    // 语义往往已被上游自己实现。它是软通过（isPatchResultSoftOk），不该把整档
    // 拖成 degraded，否则状态页永远飘红、真正的失败被噪声埋掉（E-58）。
    const drifted = Number(probe.patchesDrifted || 0);
    const satisfied = applied + drifted;
    if (total > 0 && applied === 0 && drifted === 0) {
      reasons.push(`0 / ${total} 个补丁已应用，需要先点「应用」`);
    } else if (total > 0 && satisfied < total) {
      reasons.push(`${satisfied} / ${total} 个补丁已应用，未命中的部分不会生效`);
    }
    if (options.hostPatches === false) {
      reasons.push("hostPatches 已关闭：本档退化为「只注入提示词」，与 boundary 档能力接近");
    }
    return { state: reasons.length ? "degraded" : "available", reasons };
  }

  if (id === "boundary") {
    if (probe.hookAvailable === false) {
      return {
        state: "unavailable",
        reasons: ["宿主没有 system-prompt assemble 钩子，边界改写无处接管"],
      };
    }
    if (probe.aiBase && probe.hostSupported === false) {
      // 宿主版本未知不影响边界改写 —— 这正是它的价值，所以只提示不降级
      reasons.push(`宿主版本 ${probe.hostVersion || "(未知)"} 不在补丁支持列表内；本档不依赖补丁，可正常使用`);
    }
    return { state: reasons.length ? "degraded" : "available", reasons };
  }

  // prompt-only：不依赖宿主任何东西，装上就能用
  return { state: "available", reasons: [] };
}

/**
 * 解析最终生效的引擎。
 *
 * 优先级：显式参数 > `$DSH_HOME/armor-engine.json` > DEFAULT_ENGINE。
 * 选中的引擎若 unavailable，则按 ENGINE_CATALOG 顺序找下一个 available /
 * degraded 的，并把 `fellBackFrom` / `fallbackReason` 带回去给界面显示。
 *
 * @returns {{
 *   selected: string|null,   // 用户选的（null = 未设置）
 *   engine: string,          // 实际生效的
 *   meta: object,            // 生效引擎的目录项
 *   options: object,         // 合并默认值后的选项
 *   state: string,           // available | degraded | unavailable
 *   reasons: string[],
 *   fellBack: boolean,
 *   fellBackFrom: string|null,
 *   fellBackReason: string,
 *   source: string,          // explicit | file | default
 * }}
 */
export function resolveEngine({ dshHome, probe = {}, override = null, overrideOptions = null } = {}) {
  const stored = readEngineConfig(dshHome);
  let selected = null;
  let source = "default";
  if (override != null) {
    selected = normalizeEngineId(override);
    source = "explicit";
  } else if (stored && stored.engine != null) {
    selected = normalizeEngineId(stored.engine);
    source = "file";
  }
  if (!selected) {
    selected = DEFAULT_ENGINE;
    if (source !== "explicit") source = "default";
  }

  const storedOptions = (stored && stored.options) || {};
  const explicitKeys = Array.isArray(stored?.explicit) ? stored.explicit : [];
  // 先铺该引擎的默认值，再叠**用户亲手拨过的**键 —— 换引擎时用户没碰过的键
  // 自动回到该引擎的合适默认，而不是沿用上一档的值或上一代程序折算出来的值。
  // 老落盘文件没有 explicit（legacy），一律按「没拨过」处理，避免历史错值
  // 把新默认永久钉死（例如补丁档里遗留的 hostPatches:false）。
  const engineDefaults = ENGINE_OPTION_DEFAULTS_BY_ENGINE[selected] || DEFAULT_ENGINE_OPTIONS;
  const merged = { ...engineDefaults };
  for (const key of ENGINE_OPTION_KEYS) {
    if (explicitKeys.includes(key) && storedOptions[key] !== undefined) {
      merged[key] = storedOptions[key];
    }
  }
  if (overrideOptions && typeof overrideOptions === "object") {
    for (const key of ENGINE_OPTION_KEYS) {
      if (overrideOptions[key] !== undefined) merged[key] = Boolean(overrideOptions[key]);
    }
  }
  // 只保留已知键
  const options = {};
  for (const key of ENGINE_OPTION_KEYS) options[key] = Boolean(merged[key]);

  const probeFor = (id) => probeEngine(id, probe, options);

  let engine = selected;
  let result = probeFor(engine);
  let fellBack = false;
  let fellBackFrom = null;
  let fellBackReason = "";

  if (result.state === "unavailable") {
    for (const candidate of ENGINE_IDS) {
      if (candidate === engine) continue;
      const r = probeFor(candidate);
      if (r.state !== "unavailable") {
        fellBackFrom = engine;
        fellBackReason = result.reasons.join("；") || "所选引擎在当前环境不可用";
        engine = candidate;
        result = r;
        fellBack = true;
        break;
      }
    }
  }

  // 引擎不支持的选项在此折算，注入链只读折算后的值，不再二次判断。
  const effective = { ...options };
  if (engine === "prompt-only") {
    // 没有改写通道 → 前置 seed 与尾部锚点都无处安放
    effective.seed = false;
    effective.anchor = false;
    effective.hostPatches = false;
  }
  if (engine === "boundary") {
    // 边界档不写宿主，hostPatches 无意义
    effective.hostPatches = false;
  }

  return {
    selectedEngine: source === "default" ? null : selected,
    engine,
    meta: engineById(engine),
    options: effective,
    // 用户在界面上亲手拨过、并已落盘的键。前端据此标「已记住」，
    // 也让「应用」时能区分哪些值该写盘、哪些只是默认铺出来的。
    explicitKeys: [...explicitKeys],
    state: result.state,
    reasons: result.reasons,
    fellBack,
    fellBackFrom,
    fellBackReason,
    source,
    storePath: engineConfigPath(dshHome),
    storedOptions,
  };
}

/**
 * 保存引擎选择。
 *
 * 只把**和该档默认值不同**的键写进盘。原因：前端「应用」时总是把整份
 * `options` 一起 POST 上来（它不知道哪些是用户拨的、哪些是默认铺出来的）。
 * 如果照单全收，第一次点应用就把 5 个键全钉成「用户显式选择」，之后插件
 * 升级换了更合适的默认值，用户永远回不去 —— 这正是「引擎选项记不住」
 * 的另一半根因。
 *
 * 折算规则：
 *   options[k] === 该档默认值  → 不写盘（回落到默认，跟随版本演进）
 *   options[k] !== 该档默认值  → 写盘，并记进 explicit
 *
 * @returns {{ok: boolean, resolved?: object, error?: string, path?: string}}
 */
export function saveEngine({ dshHome, engine, options, probe = {} } = {}) {
  const id = normalizeEngineId(engine);
  if (!id) {
    return { ok: false, error: `无效引擎 id: ${engine}（可选：${ENGINE_IDS.join(" / ")}）` };
  }
  const defaults = ENGINE_OPTION_DEFAULTS_BY_ENGINE[id] || DEFAULT_ENGINE_OPTIONS;
  const incoming = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  // 合并已有的 explicit，而不是每次重建。
  //
  // writeEngineConfig 是整体覆盖：它把传进去的对象直接写成文件的 options。
  // 旧实现每次都从空对象开始，只填「与默认值不同」的项，于是两次保存会互相
  // 覆盖 —— 先关 hostPatches、再关 seed，文件里只剩 hostPatches，seed 的改动
  // 丢了。用户看到的就是「点了开关但没保存」。
  const prev = readEngineConfig(dshHome);
  const prevExplicit = prev && prev.explicit && typeof prev.explicit === "object"
    ? prev.explicit
    : {};
  const explicit = {};
  for (const key of ENGINE_OPTION_KEYS) {
    // 先继承上一轮的显式值（换引擎时清空，因为不同档的默认值不同）
    if (prev && prev.engine === id && Object.prototype.hasOwnProperty.call(prevExplicit, key)) {
      explicit[key] = Boolean(prevExplicit[key]);
    }
    if (incoming[key] === undefined) continue;
    if (Boolean(incoming[key]) === Boolean(defaults[key])) {
      // 回到默认值：从 explicit 里移除，让该键回落默认
      delete explicit[key];
      continue;
    }
    explicit[key] = Boolean(incoming[key]);
  }
  const written = writeEngineConfig(dshHome, id, explicit);
  if (!written.ok) return { ok: false, error: written.error || "保存失败", path: written.path };
  return {
    ok: true,
    path: written.path,
    explicitKeys: Object.keys(explicit),
    resolved: resolveEngine({ dshHome, probe }),
  };
}

/**
 * 供提示词注入链使用的开关集合。
 *
 * 这是 engines 模块与 index.js 之间**唯一**的运行时契约：
 * index.js 每轮装配前调一次，拿到的布尔值决定注入哪些段。
 *
 * @returns {{
 *   engine: string, state: string,
 *   seed: boolean, anchor: boolean, scopedRules: boolean,
 *   capabilityProtocol: boolean, hostPatches: boolean,
 *   reasons: string[], fellBack: boolean, fellBackFrom: string|null,
 * }}
 */
export function runtimeSwitches({ dshHome, probe = {}, override = null } = {}) {
  let resolved;
  try {
    resolved = resolveEngine({ dshHome, probe, override });
  } catch {
    // 引擎层任何异常都退回「纯提示词」，保证破甲本身不断
    return {
      engine: "prompt-only", state: "degraded",
      seed: false, anchor: false, scopedRules: true,
      capabilityProtocol: true, outputGuard: true, hostPatches: false,
      reasons: ["引擎层异常，已退回纯提示词档"], fellBack: true, fellBackFrom: null,
    };
  }
  return {
    engine: resolved.engine,
    state: resolved.state,
    seed: resolved.options.seed,
    anchor: resolved.options.anchor,
    scopedRules: resolved.options.scopedRules,
    capabilityProtocol: resolved.options.capabilityProtocol,
    outputGuard: resolved.options.outputGuard,
    hostPatches: resolved.options.hostPatches,
    reasons: resolved.reasons,
    fellBack: resolved.fellBack,
    fellBackFrom: resolved.fellBackFrom,
  };
}

/**
 * 各引擎档位支持哪些功能面。
 *
 * 前端据此把不可用的控件锁成禁用态，点击时给出原因，而不是让用户点了没反应。
 * 判定依据来自 ENGINE_CATALOG 里每档的实际实现路径：
 *  - patch      ：写宿主文件 + 提示词，全部功能可用
 *  - boundary   ：不碰宿主文件，靠 assemble 钩子改写，沙箱/审批/观察策略仍走宿主默认
 *  - prompt-only：只注入正文，边界改写与 seed 都不做
 */
export const ENGINE_FEATURES = Object.freeze({
  patch: Object.freeze({
    hostPatches: true, promptInject: true, seed: true, anchor: true,
    scopedRules: true, capabilityProtocol: true, outputGuard: true, codeDefaults: true,
    sandboxBypass: true, approvalBypass: true, observeRelax: true,
    restartRequired: true,
  }),
  boundary: Object.freeze({
    hostPatches: false, promptInject: true, seed: true, anchor: true,
    scopedRules: true, capabilityProtocol: true, outputGuard: true, codeDefaults: false,
    sandboxBypass: false, approvalBypass: false, observeRelax: false,
    restartRequired: false,
  }),
  "prompt-only": Object.freeze({
    hostPatches: false, promptInject: true, seed: false, anchor: false,
    scopedRules: true, capabilityProtocol: false, outputGuard: true, codeDefaults: false,
    sandboxBypass: false, approvalBypass: false, observeRelax: false,
    restartRequired: false,
  }),
});

/** 功能面清单，顺序即界面展示顺序。 */
export const ENGINE_FEATURE_KEYS = Object.freeze([
  "hostPatches", "promptInject", "seed", "anchor", "scopedRules",
  "capabilityProtocol", "outputGuard", "codeDefaults", "sandboxBypass", "approvalBypass",
  "observeRelax", "restartRequired",
]);

/**
 * 功能面的展示文案与「为什么这个档位用不了」的解释。
 *
 * lockedReason 会在用户点击被锁控件时弹出，必须说清原因 + 怎么解锁。
 */
export const ENGINE_FEATURE_META = Object.freeze({
  hostPatches: {
    label: "宿主源码补丁", label_en: "Host patches",
    desc: "改写宿主 lib/index.js，沙箱/审批/观察策略一并放开",
    lockedReason: "只有「补丁档」会写宿主文件。当前档位一个字节的宿主文件都不改，所以补丁类能力全部不生效。想用请切到补丁档。",
    lockedReason_en: "Only Patch tier writes host files. The current tier modifies nothing on disk, so patch-based capabilities are inactive. Switch to Patch tier to use them.",
  },
  promptInject: {
    label: "提示词注入", label_en: "Prompt inject",
    desc: "把 prompt-inject.md 正文送进系统提示词",
    lockedReason: "",
    lockedReason_en: "",
  },
  seed: {
    label: "前置 seed", label_en: "Prefix seed",
    desc: "在正文前插入引导段，降低被裁掉的概率",
    lockedReason: "「纯提示词档」只注入正文，不加前置 seed。切到补丁档或边界改写档可用。",
    lockedReason_en: "Prompt-only tier injects body text only, without the prefix seed. Switch to Patch or Boundary tier.",
  },
  anchor: {
    label: "尾部锚点", label_en: "Tail anchor",
    desc: "在正文后追加锚定段，形成三段夹击",
    lockedReason: "「纯提示词档」不追加尾部锚点。切到补丁档或边界改写档可用。",
    lockedReason_en: "Prompt-only tier does not append a tail anchor. Switch to Patch or Boundary tier.",
  },
  scopedRules: {
    label: "规则裁剪", label_en: "Scoped rules",
    desc: "按勾选的规则条目裁剪注入正文",
    lockedReason: "",
    lockedReason_en: "",
  },
  capabilityProtocol: {
    label: "能力协议", label_en: "Capability protocol",
    desc: "向模型声明可用能力清单，减少试探性拒绝",
    lockedReason: "「纯提示词档」不附加能力协议段。切到补丁档或边界改写档可用。",
    lockedReason_en: "Prompt-only tier does not attach the capability protocol. Switch to Patch or Boundary tier.",
  },
  outputGuard: {
    label: "输出守卫", label_en: "Output guard",
    desc: "对回复做拒绝/降级/掏空评分，不合格自动要求重写",
    lockedReason: "",
    lockedReason_en: "",
  },
  codeDefaults: {
    label: "代码默认值改写", label_en: "Code default rewrite",
    desc: "改掉宿主代码里的默认拒绝/默认收紧值",
    lockedReason: "代码默认值改写属于宿主源码补丁，只有「补丁档」支持。当前档位做不到。",
    lockedReason_en: "Code default rewriting is a host source patch, exclusive to Patch tier.",
  },
  sandboxBypass: {
    label: "沙箱放行", label_en: "Sandbox allow",
    desc: "把沙箱 deny 改成 allow file-write*，写文件不再被拦",
    lockedReason: "沙箱策略由宿主代码决定，必须打宿主补丁才能改。当前档位沙箱仍是宿主默认，写文件照旧被拦。切补丁档可用。",
    lockedReason_en: "Sandbox policy lives in host code and requires a host patch. The current tier keeps the host default, so file writes are still blocked. Switch to Patch tier.",
  },
  approvalBypass: {
    label: "审批放行", label_en: "Approval allow",
    desc: "审批门直接放行，不再弹审批",
    lockedReason: "审批门在宿主代码里，必须打补丁才能改。当前档位照旧弹审批。切补丁档可用。",
    lockedReason_en: "The approval gate lives in host code and requires a patch. The current tier still prompts for approval. Switch to Patch tier.",
  },
  observeRelax: {
    label: "观察策略放宽", label_en: "Observe relax",
    desc: "writeIntent/editIntent 放行，不必先读后写",
    lockedReason: "观察策略在宿主代码里，必须打补丁才能改。当前档位仍要求先读后写。切补丁档可用。",
    lockedReason_en: "Observation policy lives in host code and requires a patch. The current tier still requires read-before-write. Switch to Patch tier.",
  },
  restartRequired: {
    label: "需重启生效", label_en: "Restart required",
    desc: "改动是否要重启宿主才生效",
    lockedReason: "",
    lockedReason_en: "",
  },
});

/** 界面用的目录快照（不含用户当前选择）。 */
export function engineCatalogSnapshot() {
  return {
    engines: ENGINE_CATALOG.map((e) => ({
      id: e.id, label: e.label, label_en: e.label_en, tier: e.tier,
      tagline: e.tagline, summary: e.summary,
      pros: e.pros, cons: e.cons, bestFor: e.bestFor,
      touchesHost: e.touchesHost, needsRestart: e.needsRestart,
      // 每个引擎自己的选项默认值，前端切换引擎时据此重置控件
      optionDefaults: { ...(ENGINE_OPTION_DEFAULTS_BY_ENGINE[e.id] || DEFAULT_ENGINE_OPTIONS) },
      // 该档位支持/不支持哪些功能面，前端据此锁定控件并给提示
      features: { ...(ENGINE_FEATURES[e.id] || {}) },
    })),
    defaultEngine: DEFAULT_ENGINE,
    optionKeys: ENGINE_OPTION_KEYS,
    optionDefaults: { ...DEFAULT_ENGINE_OPTIONS },
    features: Object.fromEntries(
      ENGINE_FEATURE_KEYS.map((k) => [k, { ...(ENGINE_FEATURE_META[k] || {}) }]),
    ),
  };
}
