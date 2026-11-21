/**
 * 图像守卫 —— 判断当前模型能不能自己看图，决定视觉桥是否该介入。
 *
 * 背景：pojia 跑在 DSH 上，模型可能是纯文本的，也可能是多模态的。
 * 纯文本模型遇到图片路径时必须走外部视觉工具；多模态模型自己就能看，
 * 再走外部工具就是浪费一次调用、一次配额、一次延迟。
 *
 * 判断顺序（强到弱）：
 *   1. 环境变量显式指定（用户说了算）
 *   2. 会话头里的模型 id（宿主说了算）
 *   3. 调用方自报（模型说了算 —— 模型会认错自己，所以最弱）
 *
 * 未知模型默认放行（fail open）。理由：错误地拦掉一次读取会让纯文本模型
 * 完全失去看图能力，而错误地放行只是多花一次调用。两种错误的代价不对称。
 *
 * 与 modlens 的偏离：modlens 还从会话存储里嗅探模型（读 JSONL 转录、SQLite）。
 * pojia 跑在宿主进程内，`ctx` 直接拿得到会话头，不需要反推存储格式。
 * 那套嗅探是给外部 CLI 用的，移植过来只会增加会随宿主版本漂移的耦合面。
 */

/** 默认的"有原生视觉"模型名单。glob 语法，大小写不敏感，`*` 与 `?` 是唯一通配符。 */
export const DEFAULT_VISION_MODELS = Object.freeze([
  // Anthropic
  "claude-3*", "claude-4*", "claude-sonnet-4*", "claude-opus-4*", "claude-haiku-4*",
  // OpenAI
  "gpt-4o*", "gpt-4.1*", "gpt-4-turbo*", "gpt-5*", "o3*", "o4*",
  // Google
  "gemini-*",
  // 通义 / 千问
  "qwen-vl*", "qwen2-vl*", "qwen2.5-vl*", "qwen3-vl*",
  // 智谱
  "glm-4v*", "glm-4.5v*", "glm-5v*",
  // 月之暗面
  "moonshot-v1-*vision*", "kimi-*vision*",
  // 字节
  "doubao-*vision*",
  // 其他
  "llava*", "pixtral*", "internvl*", "minicpm-v*", "step-1v*",
]);

/** 环境变量名：显式指定当前模型。设为 `none` 表示"我不知道，按未知处理"。 */
export const MODEL_ENV = "POJIA_MODEL";

/** 环境变量名：设为 `off` 时整个守卫短路，永远放行。 */
export const GUARD_ENV = "POJIA_VISION_GUARD";

/**
 * glob 匹配。锚定、大小写不敏感，只有 `*` 和 `?` 是通配符。
 *
 * 模型 id 里全是正则元字符（`gpt-4.1`、`provider/model`），所以其它字符
 * 必须全部转义成字面量。用 `RegExp` 直接吃原始 pattern 会在 `.` 上出错。
 */
export function globMatch(pattern, value) {
  const src = String(pattern || "")
    .split(/([*?])/)
    .map((part) => {
      if (part === "*") return ".*";
      if (part === "?") return ".";
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  try {
    return new RegExp(`^${src}$`, "i").test(String(value || ""));
  } catch {
    // pattern 本身非法时不匹配，而不是让整个守卫抛错。
    return false;
  }
}

/** 配置归一化：手写 JSON 会被改坏，非数组/非字符串元素一律丢弃而不是迭代崩溃。 */
export function normalizeGuardConfig(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : []);
  const deny = strings(input.denyModels);
  const allow = strings(input.allowModels);
  /* 三种情况必须分开：
   *   未提供（undefined）      → 用默认名单，用户没配过
   *   写坏了（不是数组）        → 也用默认名单，当成"没配"
   *   显式数组（哪怕空数组）    → 听用户的。空数组 = 我确实不要 deny 名单，
   *                              此时 runGuard 会短路成"没有规则"，全放行。
   * 不区分的话，显式清空名单永远清不掉，runGuard 的短路分支也永远走不到。 */
  const denyGiven = Array.isArray(input.denyModels);
  return {
    denyModels: denyGiven ? deny : [...DEFAULT_VISION_MODELS],
    allowModels: allow,
    // 严格 === true：配置文件里写字符串 "false" 是真值，会把 fail-open 翻成拒绝。
    denyWhenUnknown: input.denyWhenUnknown === true,
    enabled: input.enabled !== false,
  };
}

/**
 * 从会话上下文里取模型 id。
 *
 * 宿主可能把它放在几个不同位置（会话头、agent 配置、模型对象），
 * 这里按可能性从高到低试。取不到就返回空串，交给下一级信号。
 */
export function modelFromContext(context, env = process.env) {
  const fromEnv = String(env?.[MODEL_ENV] || "").trim();
  if (fromEnv) {
    return fromEnv.toLowerCase() === "none"
      ? { model: "", source: "env", harness: "" }
      : { model: fromEnv, source: "env", harness: "" };
  }

  const header = context?.agent?.session?.header || context?.session?.header || {};
  const candidates = [
    header.model,
    header.modelId,
    header.model_id,
    context?.agent?.model?.id,
    context?.agent?.model?.name,
    context?.model?.id,
    context?.model,
  ];
  for (const cand of candidates) {
    if (typeof cand === "string" && cand.trim()) {
      return { model: cand.trim(), source: "session", harness: String(header.harness || "") };
    }
  }
  return { model: "", source: "none", harness: String(header.harness || "") };
}

/**
 * 判定。
 *
 * 返回 `{ guard: "allow" | "deny", model, source, matched, reason }`。
 *
 * 关键规则：**deny 优先于 allow**。这样才能用宽 allow 圈一批模型、
 * 再用 deny 把其中的视觉变体挖出去（`allow: glm-*` + `deny: glm-*v*`）。
 */
export function evaluateGuard(config, detection) {
  const cfg = config && config.denyModels ? config : normalizeGuardConfig(config);
  const model = String(detection?.model || "").trim();

  if (!model) {
    if (cfg.denyWhenUnknown) {
      return {
        guard: "deny",
        model: "",
        source: detection?.source || "none",
        reason: "模型未知且配置要求未知即拒绝",
      };
    }
    return {
      guard: "allow",
      model: "",
      source: detection?.source || "none",
      reason: "模型未知，按失败开放处理",
    };
  }

  const candidates = [model];
  if (detection?.provider) candidates.push(`${detection.provider}/${model}`);

  const firstMatch = (patterns) =>
    patterns.find((p) => candidates.some((c) => globMatch(p, c)));

  const denied = firstMatch(cfg.denyModels);
  if (denied) {
    return {
      guard: "deny",
      model,
      source: detection?.source || "none",
      matched: denied,
      reason: `模型自带视觉（命中 denyModels 的 ${denied}）`,
    };
  }

  if (cfg.allowModels.length > 0) {
    const allowed = firstMatch(cfg.allowModels);
    if (allowed) {
      return {
        guard: "allow",
        model,
        source: detection?.source || "none",
        matched: allowed,
        reason: `模型在 allowModels 白名单内（命中 ${allowed}）`,
      };
    }
    return {
      guard: "deny",
      model,
      source: detection?.source || "none",
      reason: "模型不在 allowModels 白名单内，只有名单内的模型走视觉桥",
    };
  }

  return {
    guard: "allow",
    model,
    source: detection?.source || "none",
    reason: "不在 denyModels 名单上",
  };
}

/**
 * 顶层入口：从上下文与配置算出最终裁决。
 *
 * 短路条件：守卫被关掉、或者一条能拒绝的规则都没有。后者省掉一次上下文读取 ——
 * 没有规则时结论必然是 allow，算不算都一样。
 */
export function runGuard(options = {}) {
  const env = options.env || process.env;
  if (String(env?.[GUARD_ENV] || "").trim().toLowerCase() === "off") {
    return { guard: "allow", model: "", source: "none", reason: "守卫已通过环境变量关闭" };
  }

  const cfg = normalizeGuardConfig(options.config);
  if (!cfg.enabled) {
    return { guard: "allow", model: "", source: "none", reason: "守卫已关闭" };
  }

  const hasDenyRules = cfg.denyModels.length > 0 || cfg.allowModels.length > 0 || cfg.denyWhenUnknown;
  if (!hasDenyRules) {
    return { guard: "allow", model: "", source: "none", reason: "没有配置任何拒绝规则" };
  }

  const detection = modelFromContext(options.context, env);
  return evaluateGuard(cfg, detection);
}

/**
 * 图像扩展名判定。路径或 URL 只要以这些结尾就算"手里有图"。
 *
 * 允许查询串与片段跟在后面（`a.png?x=1`、`a.jpg#frag`），
 * 因为 CDN 与签名 URL 极常见。
 */
export const IMAGE_EXTENSIONS = Object.freeze([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff",
  ".heic", ".heif", ".avif", ".svg",
]);

export function looksLikeImage(target) {
  const s = String(target || "").trim();
  if (!s) return false;
  const cut = s.split(/[?#]/)[0].toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => cut.endsWith(ext));
}

/** 粘贴占位符：`[Image #1]`、`[Unsupported Image]`、`[Image: source: <path>]`。 */
export const PASTE_PLACEHOLDER_RE =
  /\[(?:Image\s*#\d+|Unsupported Image|Image:\s*source:\s*[^\]]+)\]/i;

export function hasPastePlaceholder(text) {
  return PASTE_PLACEHOLDER_RE.test(String(text || ""));
}

/**
 * 从一段文本里抽出所有看起来是图片的路径/URL。
 *
 * 用于提示词段：把"你手里有这些图，但你看不见"这件事明确告诉模型，
 * 而不是让它自己从长上下文里翻。
 *
 * 两个坑：
 * 1. URL 里含 `//`，路径正则会把 `s://cdn/a.png` 当成一条独立路径重复收进来。
 *    解法是先摘 URL，把命中的位置替换成等长空白，再跑路径正则。
 * 2. 中文标点（`。`、`，`）紧跟路径时会被一起吃进去，因为它们在 Unicode 里
 *    不属于 ASCII 标点类。剥尾时必须显式列出。
 */
export function extractImageTargets(text) {
  const src = String(text || "");
  const out = new Set();

  const urlRe = /https?:\/\/[^\s"'<>()]+/gi;
  const urls = src.match(urlRe) || [];
  for (const m of urls) {
    const clean = m.replace(/[.,;:!?。，；：！？、）】》]+$/, "");
    if (looksLikeImage(clean)) out.add(clean);
  }

  // 把已处理的 URL 位置挖成空白，避免 `//` 被下面的路径正则二次捕获。
  let masked = src;
  for (const m of urls) {
    masked = masked.split(m).join(" ".repeat(m.length));
  }

  // 裸路径要求至少有一个目录分隔符，避免把 "a.png" 这种文件名当成附件 ——
  // 那种更可能是讨论而不是真的递过来一个文件。
  const pathRe = /(?:[A-Za-z]:[\\/]|\/|\.{1,2}\/)[^\s"'<>()|]+/g;
  for (const m of masked.match(pathRe) || []) {
    const clean = m.replace(/[.,;:!?。，；：！？、）】》]+$/, "");
    if (looksLikeImage(clean)) out.add(clean);
  }

  return [...out];
}
