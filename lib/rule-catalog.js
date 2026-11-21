/**
 * 破甲规则目录 —— 聚合导出 + 界面快照。
 *
 * 三层结构（避免循环依赖）：
 *   rule-ids.js     纯元数据：分组 / 40 条规则 / 预设 / 规范化 / 预设解析
 *   rule-filter.js  正文处理：定位规则块 / 按勾选裁剪 / 政治门禁 / 结构自检
 *   rule-catalog.js 本文件：把上面两层原样再导出，外加 `catalogSnapshot`
 *
 * 历史原因：早先这三件事都塞在本文件里。拆开之后**对外接口一个字没变**，
 * `index.js` / `armor-store.js` / `identity.js` 的 `import { ... } from
 * "./rule-catalog.js"` 全部继续可用。
 */

import {
  ALL_RULE_IDS,
  DEFAULT_ENABLED_IDS,
  GROUP_BY_ID,
  POLITICS_RULE_ID,
  RULE_BY_ID,
  RULE_CATALOG,
  RULE_GROUPS,
  RULE_LEVELS,
  RULE_PRESETS,
  diffEnabledIds,
  groupById,
  isRuleEnabled,
  normalizeEnabledIds,
  resolvePreset,
  ruleById,
  ruleIdsOfGroup,
} from './rule-ids.js'

import {
  applyPoliticsGate,
  auditBody,
  detectPresentIds,
  filterScopedRules,
  hasPoliticsGate,
  locateRuleBlock,
  stripPoliticsGate,
} from './rule-filter.js'

export {
  ALL_RULE_IDS,
  DEFAULT_ENABLED_IDS,
  POLITICS_RULE_ID,
  RULE_CATALOG,
  RULE_GROUPS,
  RULE_LEVELS,
  RULE_PRESETS,
  applyPoliticsGate,
  auditBody,
  detectPresentIds,
  diffEnabledIds,
  filterScopedRules,
  groupById,
  hasPoliticsGate,
  isRuleEnabled,
  locateRuleBlock,
  normalizeEnabledIds,
  resolvePreset,
  ruleById,
  ruleIdsOfGroup,
  stripPoliticsGate,
}

/** 目录版本号。界面与 `/status` 都返回它，方便排查「前端旧后端新」。 */
export const CATALOG_VERSION = 2

/**
 * 组装界面需要的目录快照。
 *
 * 与 `armor-store.effectiveEnabledIds` 保持一致：`enabledIds == null` 等于
 * **默认集**，不是全量。否则 `defaultOn:false`（政治规则）在全新安装上会被
 * 显示成「已启用」，界面和实际注入就对不上了。
 *
 * @param {string} body - 当前 prompt-inject.md 正文
 * @param {number[]|null} enabledIds - 当前启用集合
 * @param {object} [options]
 * @param {string} [options.locale] - "zh" | "en"，决定 label 取哪个语种
 * @param {boolean} [options.audit] - 是否附带正文结构自检（默认 true）
 */
export function catalogSnapshot(body, enabledIds, options = {}) {
  const raw = String(body || '')
  const present = new Set(detectPresentIds(raw))
  const enabled = enabledIds == null
    ? new Set(DEFAULT_ENABLED_IDS)
    : new Set(normalizeEnabledIds(enabledIds))
  const isEn = String(options.locale || 'zh').toLowerCase().startsWith('en')
  const pick = (zh, en) => (isEn && en ? en : zh)

  /**
   * 按语言过滤检索标签。
   *
   * 标签本身是中英混排的（'木马', 'trojan', '蠕虫', 'worm'…），检索时全量匹配
   * 才方便；但界面把标签显示出来，英文模式下夹着中文看着像没翻完。
   * 过滤后为空时退回全量，避免个别条目（tags 全是 AMSI/ETW 这类缩写）变成空。
   */
  const filterTags = (tags, isEn) => {
    const all = Array.isArray(tags) ? tags : [];
    if (all.length === 0) return all;
    const out = all.filter((x) => {
      const hasCjk = /[\u4e00-\u9fa5]/.test(String(x));
      return isEn ? !hasCjk : hasCjk;
    });
    return out.length ? out : all;
  };

  const groups = RULE_GROUPS.map((g) => {
    const rules = RULE_CATALOG
      .filter((r) => r.group === g.id)
      .map((r) => ({
        id: r.id,
        label: pick(r.label, r.en),
        labelAlt: isEn ? r.label : (r.en || ''),
        short: pick(r.short, r.en_short),
        shortAlt: isEn ? r.short : (r.en_short || ''),
        why: pick(r.why || '', r.en_why),
        // tags 是中英混排的检索词，搜索时两种语言都要能匹配，所以原样保留；
        // 界面只在「标签」位置显示，那部分走 short / why 的 pick 结果。
        // tags 是中英混排的检索词。搜索时两种语言都该能匹配，所以保留全量；
        // 但界面在标签位置显示这些词，英文模式下露出中文会显得没翻译干净。
        // 这里按语言过滤：英文模式只留 ASCII 词，中文模式只留含中文的词，
        // 过滤后为空就退回全量（少数条目的 tags 全是英文缩写，如 AMSI/ETW）。
        tags: filterTags(r.tags, isEn),
        level: r.level || 'std',
        defaultOn: r.defaultOn !== false,
        since: r.since || '',
        enabled: enabled.has(r.id),
        present: present.has(r.id),
      }))
    return {
      id: g.id,
      label: pick(g.label, g.en),
      labelAlt: isEn ? g.label : (g.en || ''),
      hint: pick(g.hint, g.en_hint),
      tone: g.tone || 'mute',
      rules,
      enabledCount: rules.filter((r) => r.enabled).length,
      total: rules.length,
    }
  })

  const levels = RULE_LEVELS.map((lv) => {
    const inLevel = RULE_CATALOG.filter((r) => (r.level || 'std') === lv.id)
    return {
      id: lv.id,
      label: pick(lv.label, lv.en),
      hint: lv.hint,
      count: inLevel.length,
      enabledCount: inLevel.filter((r) => enabled.has(r.id)).length,
    }
  })

  const presets = RULE_PRESETS.map((p) => ({
    id: p.id,
    label: pick(p.label, p.en),
    hint: p.hint,
    accent: p.accent || 'mute',
    ids: [...p.ids],
    // 当前勾选是否正好等于该预设，界面据此高亮
    active: p.ids.length === enabled.size && p.ids.every((id) => enabled.has(id)),
  }))

  const gatePresent = hasPoliticsGate(raw)
  const politicsEnabled = enabled.has(POLITICS_RULE_ID)
  const audit = options.audit === false ? null : auditBody(raw)

  return {
    version: CATALOG_VERSION,
    groups,
    presets,
    levels,
    enabledIds: [...enabled].sort((a, b) => a - b),
    presentIds: [...present].sort((a, b) => a - b),
    total: RULE_CATALOG.length,
    enabledCount: enabled.size,
    // 正文里缺失的规则：勾了也没用，界面要提示
    missingIds: ALL_RULE_IDS.filter((id) => !present.has(id)),
    // 政治门禁现状：界面据此提示「勾了 #10 会撤掉正文里的硬阻断」
    politics: {
      id: POLITICS_RULE_ID,
      enabled: politicsEnabled,
      gatePresent,
      // 勾了但正文里没有阻断 → 已经是「能聊」状态
      effective: politicsEnabled || !gatePresent,
    },
    // 正文结构自检：规则块定位、编号重复、缺条
    audit: audit
      ? {
        ok: audit.ok,
        problems: audit.problems,
        block: audit.block
          ? { start: audit.block.start, end: audit.block.end,
            count: audit.block.ids.length, segmented: audit.block.segmented }
          : null,
      }
      : null,
  }
}
