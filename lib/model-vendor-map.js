/**
 * 模型名归一化：把千奇百怪的模型标识映射到模板厂商。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  为什么需要这个
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  同一个模型，在不同的接入方式下名字完全不一样：
 *
 *    官方 API        gpt-4o
 *    Azure           gpt-4o-2024-11-20
 *    OpenRouter      openai/gpt-4o
 *    中转站 A        gpt-4o-all
 *    中转站 B        gpt-4o-mini-latest
 *    反代            GPT-4O
 *    套壳            gpt-4o-0806
 *
 *    Claude 更乱：
 *    claude-3-5-sonnet-20241022
 *    claude-3-5-sonnet-latest
 *    anthropic/claude-3.5-sonnet
 *    claude-sonnet-4-5
 *
 *   DeepSeek 系：
 *    deepseek-chat
 *    deepseek-reasoner
 *    deepseek-v3
 *    deepseek-v4.1-flash
 *
 *   国内模型：
 *    qwen-max / qwen-3.8 / qwen2.5-72b
 *    glm-5.3 / glm-4-plus / zhipu/glm-5
 *    moonshot-v1-8k / kimi-k2 / kimi-latest
 *    hunyuan-pro / hy4
 *    minimax-abab6.5
 *    step-2 / step-5
 *    mimo-2.6
 *
 *  如果只做精确字符串匹配，绝大多数反代/中转模型都匹配不上 ——
 *  表现就是「配了模板但没效果」。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  策略：多级匹配，从精确到宽松
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *    ① 精确命中厂商别名表
 *    ② 归一化后（去前缀/后缀/版本号）再匹配
 *    ③ 关键词包含匹配（gpt / claude / qwen ...）
 *    ④ 都失败 → 返回 null，让模型自己看索引挑
 */

/**
 * 厂商别名表。
 *
 * key = 归一化后的厂商标识
 * value = { vendor, patterns, label }
 *
 * patterns 里的字符串用「归一化后的模型名」做 includes 判断。
 */
export const VENDOR_ALIASES = Object.freeze([
  // ── 国外 ──
  {
    vendor: 'openai',
    label: 'OpenAI / GPT',
    patterns: ['gpt', 'chatgpt', 'o1', 'o3', 'o4', 'davinci', 'turbo'],
  },
  {
    vendor: 'anthropic',
    label: 'Claude / Anthropic',
    patterns: ['claude', 'sonnet', 'opus', 'haiku', 'anthropic'],
  },
  {
    vendor: 'google',
    label: 'Gemini / Google',
    patterns: ['gemini', 'gemma', 'palm', 'bard', 'google'],
  },
  {
    vendor: 'grok',
    label: 'Grok / xAI',
    patterns: ['grok', 'xai'],
  },
  {
    vendor: 'meta',
    label: 'Llama / Meta',
    patterns: ['llama', 'meta-llama', 'muse', 'meta'],
  },
  {
    vendor: 'mistral',
    label: 'Mistral',
    patterns: ['mistral', 'mixtral', 'codestral', 'magistral'],
  },
  {
    vendor: 'microsoft',
    label: 'Copilot / Microsoft',
    patterns: ['copilot', 'phi-', 'microsoft'],
  },
  {
    vendor: 'nous',
    label: 'Hermes / Nous',
    patterns: ['hermes', 'nous'],
  },
  {
    vendor: 'perplexity',
    label: 'Perplexity',
    patterns: ['perplexity', 'pplx'],
  },
  {
    vendor: 'cursor',
    label: 'Cursor',
    patterns: ['cursor', 'composer'],
  },
  {
    vendor: 'brave',
    label: 'Brave Leo',
    patterns: ['brave', 'leo'],
  },

  // ── 国内 ──
  {
    vendor: 'deepseek',
    label: 'DeepSeek',
    patterns: ['deepseek', 'deep-seek'],
  },
  {
    vendor: 'alibaba',
    label: '通义千问 / Qwen',
    patterns: ['qwen', 'tongyi', 'qwq', 'qvq', 'alibaba', 'dashscope', 'modelscope'],
  },
  {
    vendor: 'moonshot',
    label: 'Kimi / 月之暗面',
    patterns: ['kimi', 'moonshot', 'kimik'],
  },
  {
    vendor: 'zhipu',
    label: '智谱 / GLM',
    patterns: ['glm', 'zhipu', 'chatglm', 'codegeex', 'zcode'],
  },
  {
    vendor: 'tencent',
    label: '腾讯混元 / Hunyuan',
    patterns: ['hunyuan', 'hy3', 'hy4', 'tencent', 'yuanbao', 'hunyuanvideo'],
  },
  {
    vendor: 'xiaomi',
    label: '小米 MiMo',
    patterns: ['mimo', 'xiaomi'],
  },
  {
    vendor: 'stepfun',
    label: '阶跃星辰 / Step',
    patterns: ['step-', 'stepfun', 'stepfun'],
  },
  {
    vendor: 'meituan',
    label: '美团 LongCat',
    patterns: ['longcat', 'meituan'],
  },
  {
    vendor: 'minimax',
    label: 'MiniMax',
    patterns: ['minimax', 'abab', 'hailuo'],
  },
  {
    vendor: 'baidu',
    label: '文心 / ERNIE',
    patterns: ['ernie', 'wenxin', 'baidu', 'yiyan'],
  },
  {
    vendor: 'bytedance',
    label: '豆包 / Doubao',
    patterns: ['doubao', 'bytedance', 'volcengine', 'skylark'],
  },
  {
    vendor: 'iflytek',
    label: '讯飞星火',
    patterns: ['spark', 'iflytek', 'xinghuo', 'generalv'],
  },
  {
    vendor: 'sensetime',
    label: '商汤日日新',
    patterns: ['sensechat', 'sensetime', 'riirixin'],
  },
  {
    vendor: '01ai',
    label: '零一万物 / Yi',
    patterns: ['yi-', '01-ai', 'lingyiwanwu'],
  },
  {
    vendor: 'baichuan',
    label: '百川智能 / Baichuan',
    patterns: ['baichuan'],
  },
  {
    vendor: 'internlm',
    label: '书生 / InternLM',
    patterns: ['internlm', 'xcomposer', 'internvl', 'shusheng'],
  },
  {
    vendor: 'telechat',
    label: '中国电信 TeleChat',
    patterns: ['telechat'],
  },
  {
    vendor: 'kunlun',
    label: '昆仑万维 / Skywork',
    patterns: ['skywork', 'kunlun', 'tiangong'],
  },
  {
    vendor: 'zhipu',
    label: '智谱（代码/角色）',
    patterns: ['codegeex', 'charglm', 'cogview', 'cogvideo'],
  },
  {
    vendor: 'moonshot',
    label: 'Kimi（视觉）',
    patterns: ['kimi-vl', 'kimi-audio'],
  },
])

/**
 * 归一化模型名。
 *
 * 去掉的噪音：
 *   · 供应商前缀       openai/gpt-4o → gpt-4o
 *   · 日期后缀         gpt-4o-2024-11-20 → gpt-4o
 *   · 中转站后缀       gpt-4o-all → gpt-4o
 *   · 大小写           GPT-4O → gpt-4o
 *   · 分隔符           3.5 / 3-5 / 35 统一
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeModelName(raw) {
  let s = String(raw || '').trim().toLowerCase()
  if (!s) return ''

  // 去掉 @ 之后的部分（有些中转用 name@provider）
  s = s.split('@')[0]

  // 去掉供应商前缀（openai/xxx、anthropic.xxx、zhipu:xxx）
  s = s.replace(/^[a-z0-9_-]+[/:.](?=[a-z])/g, '')

  // 去掉日期版本号：-2024-11-20 / -20241022 / -0806
  s = s.replace(/[-_]\d{4}[-_]?\d{2}[-_]?\d{2}\b/g, '')
  s = s.replace(/[-_]\d{6,8}\b/g, '')
  s = s.replace(/[-_]\d{4}\b/g, '')

  // 去掉常见中转后缀
  //
  // 🔴 注意：new / chat 不能删 ——
  //    gpt-new 是具体版本名，删了 new 就变成 gpt，
  //    会和 gpt-6.1 的 gpt 撞上，导致误匹配到通用旧模板。
  s = s.replace(/[-_](all|latest|preview|beta|alpha|stable|exp|experimental|free|plus|pro|max|mini|turbo|instruct|base|online|api)$/g, '')
  // 去掉尾部多余分隔符
  s = s.replace(/[-_.]+$/g, '')

  return s
}

/**
 * 根据模型名推断厂商。
 *
 * @param {string} modelName 模型标识（可能是任何形式）
 * @returns {{ vendor: string, label: string, matched: string, confidence: number } | null}
 */
export function inferVendor(modelName) {
  const raw = String(modelName || '').trim()
  if (!raw) return null

  const lower = raw.toLowerCase()
  const norm = normalizeModelName(raw)

  // ── ① 精确命中（原样或归一化后完全等于某个 pattern）──
  for (const v of VENDOR_ALIASES) {
    for (const p of v.patterns) {
      if (lower === p || norm === p) {
        return { vendor: v.vendor, label: v.label, matched: p, confidence: 1.0 }
      }
    }
  }

  // ── ② 归一化后包含 ──
  //
  // 先按 pattern 长度降序，避免「o1」抢在「openai」前面误判
  const sorted = [...VENDOR_ALIASES].sort((a, b) => {
    const la = Math.max(...a.patterns.map((p) => p.length))
    const lb = Math.max(...b.patterns.map((p) => p.length))
    return lb - la
  })

  for (const v of sorted) {
    for (const p of v.patterns) {
      if (norm.includes(p)) {
        return { vendor: v.vendor, label: v.label, matched: p, confidence: 0.9 }
      }
    }
  }

  // ── ③ 原始串包含（兜底，防止归一化过度删减）──
  for (const v of sorted) {
    for (const p of v.patterns) {
      // 太短的 pattern 容易误伤，只在长度 >= 3 时用
      if (p.length < 3) continue
      if (lower.includes(p)) {
        return { vendor: v.vendor, label: v.label, matched: p, confidence: 0.7 }
      }
    }
  }

  return null
}

/**
 * 在模板库里给某个模型找最合适的模板。
 *
 * 匹配优先级：
 *   ① 厂商精确匹配 + 模型名相似度最高
 *   ② 厂商精确匹配 + 该厂商第一条
 *   ③ 没有厂商匹配 → null
 *
 * @param {Array} templates 模板列表（每条有 vendor / title / id）
 * @param {string} modelName
 * @returns {{ template: object, vendor: string, score: number, reason: string } | null}
 */
/**
 * 从模板标题里提取版本号。
 *
 * 支持：
 *   gpt-5.2        → [5, 2]
 *   gpt-5.5-turbo  → [5, 5]
 *   gpt-6          → [6]
 *   claude-3-5     → [3, 5]
 *   gemini-2.0     → [2, 0]
 *
 * @param {string} text
 * @returns {number[]}
 */
export function extractVersion(text) {
  const s = String(text || "").toLowerCase();
  // 抓第一组「数字.数字.数字」或「数字-数字」
  const m = s.match(/(\d+)(?:[.\-_](\d+))?(?:[.\-_](\d+))?/);
  if (!m) return [];
  const parts = [m[1], m[2], m[3]].filter((x) => x !== undefined).map(Number);
  return parts;
}

/**
 * 比较两个版本号。
 *
 * @returns {number} a>b 返回正数，a<b 返回负数，相等返回 0
 */
export function compareVersion(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * 在候选模板里挑「版本最接近且不高于目标」的那条。
 *
 * 为什么不挑高于目标的：高版本模板用到的能力低版本模型可能没有，
 * 套上去容易翻车。低版本模板套高版本顶多是没吃满新特性。
 *
 * @param {Array} candidates
 * @param {string} targetModel 归一化后的模型名
 * @returns {object | null}
 */
export function pickClosestVersion(candidates, targetModel) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return null;

  const targetVer = extractVersion(targetModel);
  if (!targetVer.length) return null;

  let best = null;
  let bestDiff = Infinity;

  for (const t of list) {
    const v = extractVersion(t.title || t.id || "");
    if (!v.length) continue;

    // 跳过比目标高的（除非没有更低的）
    const cmp = compareVersion(v, targetVer);
    if (cmp > 0) continue;

    // 版本越接近越好
    const diff = targetVer[0] - v[0] + (targetVer[1] ?? 0) / 100 - (v[1] ?? 0) / 100;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = t;
    }
  }

  // 所有候选都比目标高 → 挑最低的那个
  if (!best) {
    let lowest = null;
    let lowestVer = null;
    for (const t of list) {
      const v = extractVersion(t.title || t.id || "");
      if (!v.length) continue;
      if (!lowestVer || compareVersion(v, lowestVer) < 0) {
        lowestVer = v;
        lowest = t;
      }
    }
    return lowest;
  }

  return best;
}

export function matchTemplateForModel(templates, modelName) {
  const list = Array.isArray(templates) ? templates : []
  if (!list.length) return null

  const inferred = inferVendor(modelName)
  if (!inferred) return null

  const normModel = normalizeModelName(modelName)

  // 找出该厂商的所有模板
  // 找出该厂商的所有模板
  //
  // 🔴 两层过滤：
  //   ① 厂商名精确匹配（openai === openai）
  //   ② 厂商名互相包含（zhipu AI ⊃ zhipu）
  //
  // 但「包含」有风险：Meta 的标题里带 spark，会把讯飞的 generalv 吸过来。
  // 所以第 ② 层要求「模板厂商名是目标厂商名的子串」，方向不能反。
  const candidates = list.filter((t) => {
    const tv = String(t.vendor || "").toLowerCase().trim();
    const want = String(inferred.vendor).toLowerCase().trim();
    if (!tv) return false;
    if (tv === want) return true;
    // 只在模板厂商名比目标长时允许包含（"zhipu ai" 包含 "zhipu"）
    return tv.includes(want) && tv.length > want.length;
  });

  if (!candidates.length) {
    // ── 跨厂商降级 ──
    //
    // 有些国产模型库里没有专属模板（豆包 / 文心 / 星火 / MiniMax /
    // 零一万物 / 商汤 / 百川 / 书生 ...）。
    //
    // 之前直接返回「没有该厂商」—— 用户配了模板目录却完全没效果。
    //
    // 现在按「同语系同类」降级：
    //   国产模型 → 用其他国产模型的通用模板（中文语料、国内合规环境更接近）
    //   国外模型 → 用同阵营的通用模板
    //
    // 判据：模板厂商也属于同一阵营。
    const CN_VENDORS = new Set([
      "deepseek", "alibaba", "moonshot", "zhipu", "tencent",
      "xiaomi", "stepfun", "meituan", "minimax", "baidu",
      "bytedance", "iflytek", "sensetime", "01ai", "baichuan",
      "internlm", "qwen", "telechat", "kunlun",
    ]);
    const targetIsCn = CN_VENDORS.has(inferred.vendor);

    const sameCamp = list.filter((t) => {
      const tv = String(t.vendor || "").toLowerCase();
      return CN_VENDORS.has(tv) === targetIsCn;
    });

    if (sameCamp.length) {
      // 🔴 降级选模板：按「代表性」排序，不是按字数
      //
      // 之前纯按字数选，结果所有降级都指向 longcat-agents（最长）。
      // 但豆包和美团是不同公司，风格未必接近。
      //
      // 新策略：优先选「有 agents 后缀的通用型」（这类模板通常是最新最完整的
      // 通用破甲，不绑定具体模型特性），其次选字数多的。
      const rank = (t) => {
        const title = String(t.title || "").toLowerCase();
        let s = 0;
        // agents 后缀：最新的通用型
        if (/-agents?$/.test(title)) s += 100;
        // 通用词
        if (/\b(general|chat|base|pro|max|latest)\b/.test(title)) s += 30;
        // 版本号高的加分
        const v = extractVersion(title);
        if (v.length) s += Math.min(20, v[0] * 2);
        // 字数（每 5000 字加 1 分，最多 10）
        s += Math.min(10, Math.floor((t.chars || 0) / 5000));
        return s;
      };
      const picked = sameCamp.slice().sort((a, b) => rank(b) - rank(a))[0];
      return {
        template: picked,
        vendor: inferred.vendor,
        score: 5,
        reason: `模型「${modelName}」→ ${inferred.label}（库中无专属模板，降级用 ${picked.vendor} 的「${picked.title}」）`,
        fallback: true,
      };
    }

    return { template: null, vendor: inferred.vendor, score: 0, reason: `识别为 ${inferred.label}，但模板库里没有该厂商` };
  }

  // 按标题与模型名的相似度打分
  let best = null
  let bestScore = -1

  for (const t of candidates) {
    const title = normalizeModelName(t.title || '')
    const id = normalizeModelName(t.id || '')

    let score = 0

    // 完全相等
    if (title === normModel || id === normModel) score = 100
    // 一方包含另一方
    else if (title && normModel && (normModel.includes(title) || title.includes(normModel))) score = 70
    else if (id && normModel && (normModel.includes(id) || id.includes(normModel))) score = 60
    // 共享前缀（前 4 字符）
    //
    // 🔴 收紧：要求「版本号也对得上」或「双方都没版本号」。
    //
    //    之前只比前 4 字符，导致 gpt-6.1 匹配到 gpt-new（都是 "gpt-"）。
    //    gpt-new 是通用旧模板，而库里明明有 GPT-5.2 更接近。
    else if (
      title.length >= 4 && normModel.length >= 4 &&
      title.slice(0, 4) === normModel.slice(0, 4) &&
      (() => {
        const tv = extractVersion(title);
        const mv = extractVersion(normModel);
        // 双方都有版本号 → 必须主版本相近才给前缀分
        if (tv.length && mv.length) return Math.abs(tv[0] - mv[0]) <= 1;
        // 一方没版本号 → 不给前缀分（交给版本加分去处理）
        return false;
      })()
    ) score = 40
    // 有共同词
    //
    // 🔴 收紧：至少要有一个「非通用词」对上。
    //
    //    "gpt-new" 和 "gpt-6.1" 拆词后都有 "gpt"，
    //    但 gpt 只是品牌名，不代表版本接近 —— 不能靠它给分。
    //
    //    只有对上版本号、系列名（turbo/o1/oss 这类）才算。
    else {
      const tw = title.split(/[-_.\s]+/).filter((w) => w.length >= 2);
      const mw = normModel.split(/[-_.\s]+/).filter((w) => w.length >= 2);
      const GENERIC = new Set(["gpt", "chat", "model", "ai", "the", "and", "for", "new", "in"]);
      const common = tw.filter((w) => mw.includes(w) && !GENERIC.has(w) && !/^\d+$/.test(w));
      if (common.length) score = 20 + common.length * 5;
    }

    // ── 版本号加分 ──
    //
    // 场景：目标 gpt-6.1，库里有 GPT-5.2 / gpt-new / GPT-4O。
    //   字符串相似度：都不高，gpt-new 反而靠前缀拿 70 分。
    //   但版本语义上，GPT-5.2 比 gpt-new 更接近 gpt-6.1。
    //
    // 规则：
    //   · 版本号完全相同      +50
    //   · 主版本相同          +25
    //   · 模板版本低于目标    +10（可用，但可能没吃满新特性）
    //   · 模板版本高于目标    -20（风险，低版本模型可能做不到）
    const tv = extractVersion(title);
    const mv = extractVersion(normModel);
    if (tv.length && mv.length) {
      const cmp = compareVersion(tv, mv);
      if (cmp === 0) score += 50;
      else if (tv[0] === mv[0]) score += 25;
      else if (cmp < 0) score += 10;
      else score -= 20;
    } else if (!tv.length && mv.length) {
      // 模板没版本号（如 gpt-new），目标有 → 略微降权
      score -= 5;
    }
    // ── 特化模板惩罚 ──
    //
    // 场景：gpt-4 同时命中这几条，分数接近：
    //   「GPT-4O」                                   ← 版本更接近
    //   「GPT-4 in ChatGPT Interface」               ← 正确的
    //   「ChatGPT Interface (GPT-4O) Image-Only ...」 ← 只适用于图片场景
    //
    // 规则：标题里带「特化关键词」的降权 ——
    //   这类模板是为某个具体功能写的（只发图 / 只填 Instructions / 只测 Playground），
    //   通用场景套上去会跑偏。
    const SPECIALIZED = /image[- ]?only|tasks|playground|emoji|dall-?e|generator|instructions|adversarial|hyper[- ]?token/i;
    if (SPECIALIZED.test(String(t.title || ""))) {
      score -= 40;
    }

    // 标题里带「in ChatGPT Interface」这种限定语的，也略微降权
    // （它是给网页版用的，不是 API 模型）
    if (/in\s+chatgpt\s+interface|in\s+the\s+/i.test(String(t.title || ""))) {
      score -= 15;
    }



    if (score > bestScore) {
      bestScore = score
      best = t
    }
  }

  // ── 降级策略：版本感知 ──
  //
  // 相似度太低时，不要随便挑第一条 —— 按版本号挑最接近的。
  //
  // 场景：gpt-6.1 没对应模板，库里最新的是 GPT-5.2。
  //   之前：退回 candidates[0]（可能是 gpt-new 这种通用旧模板）
  //   现在：找「同厂商里版本号最接近且不高于目标」的那条
  //
  // 为什么「不高于」：高版本模板套到低版本上容易翻车
  //   （高版本才有的能力，低版本模型做不到）。
  //   低版本模板套高版本顶多是没用上新特性，不会坏事。
  if (bestScore < 20 && candidates.length) {
    const fallback = pickClosestVersion(candidates, normModel)
    if (fallback) {
      best = fallback
      bestScore = 15
    } else {
      best = candidates[0]
      bestScore = 10
    }
  }
  if (bestScore < 20 && candidates.length) {
    best = candidates[0]
    bestScore = 10
  }

  if (!best) return null

  return {
    template: best,
    vendor: inferred.vendor,
    score: bestScore,
    reason: `模型「${modelName}」→ ${inferred.label}（匹配 ${inferred.matched}，置信 ${inferred.confidence}）→ 模板「${best.title}」（相似度 ${bestScore}）`,
  }
}

/**
 * 列出所有支持的厂商（给面板用）。
 *
 * @returns {{ vendor: string, label: string }[]}
 */
export function listVendors() {
  return VENDOR_ALIASES.map((v) => ({ vendor: v.vendor, label: v.label }))
}
