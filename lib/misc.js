/**
 * 杂项设定：插件里除「破甲」以外的所有用户可调项。
 *
 * 设计原则
 *  - 不新造存储层。能挂到既有文件就挂既有文件，只有确实没有归属的才写 misc-settings.json。
 *  - 每一项都必须**改完立即生效**。凡是需要重写宿主文件的，写回后就地重算，
 *    不留给「下次启动」；做不到立即生效的项直接不放进这里。
 *  - 读失败不抛。缺文件 = 用默认值，界面上永远有可操作的状态。
 *
 * 归属映射（现状盘点结果）
 *  ┌─ 提示词 ── identity.js 的三段（身份卡 / 客观 / 嘿客角色）+ 锚点 + 能力协议
 *  ├─ 自动化 ── continue-retry.js 的 autoRetry/retryMax/autoContinue/continueMax/continueText
 *  ├─ 工具与权限 ── hooks-deny.js 的 hooksDenyBypass、drill-grant.json、net-scope 白名单
 *  ├─ 宿主行为 ── hide-console.js 的窗口隐藏、update.js 的通道
 *  └─ 破甲 ── 留在 armor / engine 原页面，不进这里
 */
import fs from "node:fs";
import path from "node:path";

import * as continueRetry from "./continue-retry.js";
import { HOOK_DENY_PATCH_IDS } from "./hooks-deny.js";
import { allowFilePath, readAllowText } from "./net-scope.js";

const SETTINGS_FILE = "misc-settings.json";

/**
 * 每组的前端渲染元数据。后端只负责值；分组/顺序/文案交给 client，
 * 但 id 与默认值必须在后端是唯一真相，否则前后端会漂。
 */
export const MISC_GROUPS = Object.freeze([
  {
    id: "persona",
    items: [
      { key: "persona.name", kind: "text", def: "小雨", maxLen: 32 },
      { key: "persona.selfRef", kind: "text", def: "我", maxLen: 32 },
      { key: "persona.tone", kind: "text", def: "", maxLen: 120 },
      { key: "persona.custom", kind: "text-long", def: "", maxLen: 8000 },
      { key: "persona.forbidden", kind: "text-long", def: "", maxLen: 2000 },
      { key: "persona.takeover", kind: "bool", def: false },
    ],
  },
  {
    id: "prompt",
    items: [
      { key: "prompt.identityCard", kind: "bool", def: true },
      { key: "prompt.objective", kind: "bool", def: true },
      { key: "prompt.hackerRole", kind: "bool", def: false },
      { key: "prompt.anchor", kind: "bool", def: true },
      { key: "prompt.capabilityProtocol", kind: "bool", def: true },
      /* ── 质量护栏：逐条独立开关，关掉的那一条整段不注入 ── */
      { key: "prompt.antiHallucination", kind: "bool", def: true },
      { key: "prompt.noGuess", kind: "bool", def: true },
      { key: "prompt.noFabricate", kind: "bool", def: true },
      { key: "prompt.evidenceFirst", kind: "bool", def: true },
      { key: "prompt.selfCheck", kind: "bool", def: true },
      { key: "prompt.citeSource", kind: "bool", def: true },
      { key: "prompt.noFlattery", kind: "bool", def: true },
      { key: "prompt.concise", kind: "bool", def: false },
      /* ── 多厂商越狱模板库 ──
       * 只注入索引（id / 标题 / 字数），不注入正文：全库 250KB+，
       * 整段塞进提示词会把工作上下文挤掉。需要某条时用 purge_templates 取。 */
      { key: "prompt.vendorTemplates", kind: "bool", def: false },
      { key: "prompt.vendorDir", kind: "text", def: "", maxLen: 400 },
      { key: "prompt.vendorPick", kind: "text", def: "", maxLen: 200 },
      /* ── 尾部硬权重段 ──
       * order 1e6，放在提示词最后。作用是对抗长上下文对中段指令的稀释，
       * 所以正文刻意短（默认档 433 字）—— 尾部每多一行，信噪比就低一分。 */
      { key: "prompt.boostTail", kind: "bool", def: true },
      { key: "prompt.boostProfile", kind: "text", def: "stable", maxLen: 32 },
      /* ── 深度破甲（请求消息层）──
       * 只改 session.deriveMessages() 的返回值，不落盘、不进 UI，
       * 关掉 deep.enabled 即整体停用。 */
      { key: "deep.enabled", kind: "bool", def: true },
      { key: "deep.refusalFilter", kind: "bool", def: true },
      { key: "deep.forceClean", kind: "bool", def: false },
      { key: "deep.tailSteer", kind: "bool", def: false },
      { key: "deep.prefill", kind: "bool", def: false },
      { key: "deep.stripPrefill", kind: "bool", def: true },
    ],
  },
  {
    id: "auto",
    items: [
      { key: "auto.autoRetry", kind: "bool", def: true },
      { key: "auto.retryMax", kind: "num", def: 3, min: 0, max: 20 },
      { key: "auto.autoContinue", kind: "bool", def: false },
      { key: "auto.continueMax", kind: "num", def: 3, min: 0, max: 20 },
      { key: "auto.continueText", kind: "text", def: "继续", maxLen: 120 },
      // 输出守卫：对回复做拒绝/降级/掏空评分，不合格自动要求重写
      { key: "auto.outputGuard", kind: "bool", def: true },
      { key: "auto.guardAutoRepair", kind: "bool", def: true },
      { key: "auto.guardMaxRepair", kind: "num", def: 2, min: 0, max: 4 },
    ],
  },
  {
    id: "tools",
    items: [
      { key: "tools.hooksDenyBypass", kind: "bool", def: true },
      { key: "tools.drillGrant", kind: "bool", def: false },
      { key: "tools.ownServers", kind: "text-long", def: "" },
    ],
  },
  {
    id: "host",
    items: [
      { key: "host.hideConsole", kind: "bool", def: true },
    ],
  },
]);

const ITEM_BY_KEY = new Map();
for (const g of MISC_GROUPS) {
  for (const it of g.items) ITEM_BY_KEY.set(it.key, { ...it, group: g.id });
}

/**
 * 只读项：功能对用户**可见**（能看出这台机器上有什么、当前什么状态），
 * 但**不允许改**。用于那些一旦被关掉就会让插件自我损坏的开关 ——
 * 例如「补丁写进宿主」若被关，破甲就整条失效，而用户会以为是自己别的地方配错了。
 *
 * 这些项强制值为 true（默认开启且锁定），前端渲染成带锁的开关并给点击提示。
 */
export const READ_ONLY_TRUE_KEYS = Object.freeze([
  "prompt.identityCard",
  "prompt.objective",
  "prompt.anchor",
  "prompt.capabilityProtocol",
  "prompt.antiHallucination",
  "prompt.noGuess",
  "prompt.noFabricate",
  "prompt.evidenceFirst",
  "prompt.selfCheck",
  "tools.hooksDenyBypass",
]);

const READ_ONLY_SET = new Set(READ_ONLY_TRUE_KEYS);

/** 人设组的全部键。写/读都按这个列表走，新增项只改这里。 */
export const PERSONA_KEYS = Object.freeze([
  "persona.name",
  "persona.selfRef",
  "persona.tone",
  "persona.custom",
  "persona.forbidden",
  "persona.takeover",
]);

/** 质量护栏组的全部键。每一条对应一段独立文案，关掉即不注入。 */
export const QUALITY_KEYS = Object.freeze([
  "prompt.antiHallucination",
  "prompt.noGuess",
  "prompt.noFabricate",
  "prompt.evidenceFirst",
  "prompt.selfCheck",
  "prompt.citeSource",
  "prompt.noFlattery",
  "prompt.concise",
]);

/**
 * 质量护栏文案。
 *
 * 每条都写成**可判定的动作**，不是口号 —— "不要编造"这种句子模型会当背景噪音。
 * 写成"说不确定时必须给出一句具体的求证动作"这种，模型才有东西可执行。
 */
const QUALITY_RULES = Object.freeze({
  "prompt.antiHallucination": `## 抗幻觉

- 只陈述你**确实知道**的事实。区分三种状态：确定 / 推测 / 不知道。推测必须标"推测"。
- 不确定的数字、版本号、API 名、文件路径、命令行参数，**不要给出具体值**，改为说明怎么查证。
- 不要用"通常""一般来说""应该是"来掩盖不确定；那是猜测，不是知识。`,
  "prompt.noGuess": `## 不猜测

- 缺信息就**问**，不要用假设填坑。一次问清所有缺的项，不要挤牙膏。
- 无法提问时（比如无人值守），把假设**逐条列出**并标明"以下为我的假设，错了请纠正"，再往下做。
- 不要假装读过没读过的文件、跑过没跑过的命令、看过没看过的输出。`,
  "prompt.noFabricate": `## 不编造

- 引用代码必须**真的存在**于文件里，行号对得上。不确定行号就不写行号。
- 引用文档、接口、报错信息必须来自本轮真实读取到的内容，不能凭记忆复述。
- 报告"已修复/已通过"之前必须有本轮实际执行的验证输出；没跑就明说没跑。`,
  "prompt.evidenceFirst": `## 证据优先

- 结论先行，紧跟一条能支撑它的**具体证据**（文件+行号、命令+输出、报错原文、请求+响应）。
- 拿不到证据时，把结论降级成假设，并说明缺哪一份证据才能升级。
- 多个证据冲突时，先摊开冲突，不要挑一个顺眼的用。`,
  "prompt.selfCheck": `## 自检

- 回答前过一遍：有没有哪句是猜的？有没有把"应该"说成"是"？有没有漏掉用户明确要求的一项？
- 交付前重读用户原话，逐项对照，漏项要主动补上或明说没做。
- 改了代码/配置后，说明改了什么、影响面、怎么回滚。`,
  "prompt.citeSource": `## 出处

- 涉及外部事实（版本、标准、协议、CVE、政策）时给出出处名；能引原文就引原文关键句。
- 内部事实（本仓库代码）给 \`文件:行号\`。
- 给不出出处就标注"未核实"。`,
  "prompt.noFlattery": `## 不奉承

- 不写"很好的问题""这个想法很棒"这类开场。直接答。
- 用户的方案有问题就直说问题在哪，不要先夸再转折。
- 不同意时给出理由和替代方案，不要含糊顺从。`,
  "prompt.concise": `## 极简

- 能一句话说完不说两句。不复述用户的话，不总结自己刚说过的话。
- 不使用没有信息量的小标题、过渡句、"让我们来看看"。
- 但**不要为简洁牺牲关键前提与风险提示**。`,
});

/**
 * 身份句：一句话说清"叫什么、别自称什么"。
 *
 * 单独抽出来是因为它要喂给两个地方，而这两处**必须是同一句话**：
 *   1. `cordis.patch.yml` 的 `personaPrefix`（宿主装配系统提示词最前面）
 *   2. `本插件` 注入段头部（插件自己写进提示词的那段）
 *
 * 为什么不能只在人设段里写：`cordis.patch.yml` 把 harness 自带身份清空了
 * （`includeHarnessIdentity: false` + `personaPrefix: ""`），破甲内核只接管
 * 规则稿、不接管人设。两处都空的话模型没有任何身份可依，就会退回工具
 * POLICY 里的 "Team Lead" 自称。所以要两路都写、互为兜底。
 *
 * @param {Record<string, unknown>} values - readMiscSettings() 的结果
 * @returns {string} 单行身份句；名字为空时返回空串
 */
export function identityLine(values) {
  const v = values || {};
  const name = String(v["persona.name"] ?? "").trim();
  if (!name) return "";
  const selfRef = String(v["persona.selfRef"] ?? "").trim();
  const who = selfRef && selfRef !== name ? `，自称「${selfRef}」` : "";
  return `你叫「${name}」${who}。被问"你是谁"时直接说这个名字，`
    + "不要自称 lead、Team Lead、Lead agent 或\"主控 agent\"——那些是团队模式的角色位，不是你的名字。";
}

/**
 * 人设文案。
 *
 * `priority` 决定和模式设定的关系：三个内置模式（嘿客 / 无限制 / 创世神）
 * 的 persona 是**硬约束**，写在这里的内容不得覆盖它们。所以默认 wording 是
 * "在模式设定之下追加"，只有用户显式打开 takeover 才反转优先级。
 *
 * @param {Record<string, unknown>} values - readMiscSettings() 的结果
 * @returns {string} 空串表示不注入
 */
export function personaText(values) {
  const v = values || {};
  const name = String(v["persona.name"] ?? "").trim();
  const selfRef = String(v["persona.selfRef"] ?? "").trim();
  const tone = String(v["persona.tone"] ?? "").trim();
  const custom = String(v["persona.custom"] ?? "").trim();
  const forbidden = String(v["persona.forbidden"] ?? "").trim();
  const takeover = v["persona.takeover"] === true;

  if (!name && !selfRef && !tone && !custom && !forbidden) return "";

  const lines = ["## 人设"];
  if (takeover) {
    lines.push(
      "",
      "以下人设**优先于**当前模式预设里的人格描述。其余设定（工具面、规则集、引擎档位、",
      "角色分工、并发上限）一律不变，仍以模式预设为准。",
    );
  } else {
    lines.push(
      "",
      "以下是操作者指定的人设。它**附加在**当前模式预设之上：模式预设定的职责、工具面、",
      "规则集、角色分工优先级更高，冲突时以模式预设为准；本段只补充称呼、口吻与表达习惯。",
    );
  }
  if (name) lines.push(`- 你的名字：**${name}**。被问"你是谁"时用这个名字回答。`);
  if (selfRef) lines.push(`- 自称：**${selfRef}**。`);
  if (name) {
    // 团队模式会往提示词里注入一段 POLICY，通篇用 "Team Lead" 指代主控。
    // 模型很容易顺手用 lead 当自己的名字回答「你是谁」。角色位不是名字，
    // 这条边界只在人设段里说清，不改宿主包。
    lines.push(
      `- **不要自称 lead / Team Lead / Lead agent / "主控 agent"**。`
      + `那些是团队模式里的「角色位」，不是你的名字。`
      + `被问"你是谁"就答**${name}**；说清职责可以说"我在这个会话里调度任务"，但别把角色位当名字。`,
    );
  }
  if (tone) lines.push(`- 口吻：${tone}`);
  if (custom) {
    lines.push("", "### 补充设定", "", custom);
  }
  if (forbidden) {
    lines.push("", "### 禁止事项", "", forbidden);
  }
  return lines.join("\n");
}

/**
 * 把所有打开的质量护栏拼成一段。全关时返回空串。
 * @param {Record<string, unknown>} values - readMiscSettings() 的结果
 * @returns {string}
 */
export function qualityText(values) {
  const v = values || {};
  const parts = [];
  for (const key of QUALITY_KEYS) {
    if (v[key] !== true) continue;
    const body = QUALITY_RULES[key];
    if (body) parts.push(body);
  }
  return parts.join("\n\n");
}

export function miscSettingsPath(dshHome) {
  return path.join(String(dshHome || ""), SETTINGS_FILE);
}

/** 输出守卫三项的键名。它们落在独立文件里，不进 continue-retry.json。 */
export const GUARD_MISC_KEYS = Object.freeze([
  "auto.outputGuard",
  "auto.guardAutoRepair",
  "auto.guardMaxRepair",
]);

export function guardSettingsPath(dshHome) {
  return path.join(String(dshHome || ""), "dsh-purge", "output-guard.json");
}

/**
 * 读输出守卫配置，供运行时接线使用。
 *
 * 缺省值与 misc 页的 def 一致（全开、自动纠偏、上限 2），
 * 所以「没配过」和「配成默认」行为相同，不会因为文件缺失就静默关掉守卫。
 */
export function readGuardSettings(dshHome) {
  const raw = readJson(guardSettingsPath(dshHome)) || {};
  const out = {};
  for (const key of GUARD_MISC_KEYS) {
    const item = ITEM_BY_KEY.get(key);
    out[key.slice("auto.".length)] = coerce(item, raw[key.slice("auto.".length)]);
  }
  return {
    enabled: out.outputGuard !== false,
    autoRepair: out.guardAutoRepair !== false,
    maxRepair: out.guardMaxRepair,
  };
}

function defaultScalar(item) {
  return item.def;
}

function coerce(item, raw) {
  if (!item) return undefined;
  // 没写过这个键时必须落到 def。早先直接 raw===true 会把「未设置」判成 false，
  // 界面上表现为默认开启的项一打开就是关的。
  if (raw === undefined || raw === null) return item.def;
  if (item.kind === "num") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return item.def;
    const lo = Number.isFinite(item.min) ? item.min : -Infinity;
    const hi = Number.isFinite(item.max) ? item.max : Infinity;
    return Math.min(hi, Math.max(lo, Math.trunc(n)));
  }
  if (item.kind === "text" || item.kind === "text-long") {
    const s = String(raw);
    return item.maxLen ? s.slice(0, item.maxLen) : s;
  }
  return raw === true || raw === "true" || raw === 1;
}

function readJson(file) {
  try {
    const t = fs.readFileSync(file, "utf8");
    const v = JSON.parse(t);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/**
 * 原子写 JSON。
 *
 * 早先用固定的 `${file}.tmp` —— 界面上连点几个开关时 `writeMiscSettings` 会并发跑
 * （每个请求各写一次），第二个请求的 writeFileSync 覆盖第一个的 tmp，第一个再
 * rename 就拿到 EPERM(EACCES)：Windows 上被占用/已移走的句柄 rename 直接失败，
 * 表现为「点了开关但没保存」。临时名带 pid+随机串才互不干扰。
 */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  const body = JSON.stringify(value, null, 2);
  try {
    fs.writeFileSync(tmp, body, "utf8");
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (error) {
        // Windows 上目标被另一进程短暂占用时 rename 会 EPERM/EACCES，重试几次就够了。
        if (attempt >= 4 || (error.code !== "EPERM" && error.code !== "EACCES" && error.code !== "EBUSY")) throw error;
        const until = Date.now() + 25 * (attempt + 1);
        while (Date.now() < until) { /* 小睡，不引 async */ }
      }
    }
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 没建起来 */ }
    // 最后兜底：直接覆盖目标。原子性丢了，但比「用户点了没保存」好。
    try {
      fs.writeFileSync(file, body, "utf8");
      return;
    } catch { throw error; }
  }
}

/* ── 各来源的读写适配 ───────────────────────────────────────── */

function readContinue(dshHome) {
  try {
    const saved = continueRetry.loadSettings(dshHome) || {};
    // 这里必须走 normalizeConfig：它会把 autoRetry/autoContinue 与各自的 Max>0 绑在一起，
    // 直接把 {autoRetry:true, retryMax:0} 写回去会被它再改一遍，界面就会出现「开关跳回去」。
    return continueRetry.normalizeConfig(continueRetry.mergeConfig({}, saved));
  } catch {
    return continueRetry.normalizeConfig({});
  }
}

function readHooksDeny(dshHome) {
  // hooks-deny 模块自带落盘（hooks-deny.json）；缺文件时它给默认 true。
  const file = path.join(String(dshHome || ""), "hooks-deny.json");
  const raw = readJson(file);
  if (raw && typeof raw.hooksDenyBypass === "boolean") return raw.hooksDenyBypass;
  return true;
}

function readDrill(dshHome) {
  const file = path.join(String(dshHome || ""), "dsh-purge", "drill-grant.json");
  const raw = readJson(file);
  return !!(raw && raw.granted);
}

/** 汇总当前所有杂项的值。任何一项读失败都退回默认，绝不整组失败。 */
export function readMiscSettings(dshHome) {
  const home = String(dshHome || "");
  const own = readJson(miscSettingsPath(home)) || {};
  const cont = readContinue(home);
  const values = {};

  // own[key] 没写过就是 undefined，coerce 会退回 def —— 不要在这里补 ?? true，
  // 那会把「用户显式关掉」和「从没设置过」混成一件事。
  values["prompt.identityCard"] = coerce(ITEM_BY_KEY.get("prompt.identityCard"), own["prompt.identityCard"]);
  values["prompt.objective"] = coerce(ITEM_BY_KEY.get("prompt.objective"), own["prompt.objective"]);
  values["prompt.hackerRole"] = coerce(ITEM_BY_KEY.get("prompt.hackerRole"), own["prompt.hackerRole"]);
  values["prompt.anchor"] = coerce(ITEM_BY_KEY.get("prompt.anchor"), own["prompt.anchor"]);
  values["prompt.capabilityProtocol"] = coerce(ITEM_BY_KEY.get("prompt.capabilityProtocol"), own["prompt.capabilityProtocol"]);
  // 模板库三项：目录为空时上层退化到「未配置」，不假装有内容
  values["prompt.vendorTemplates"] = coerce(ITEM_BY_KEY.get("prompt.vendorTemplates"), own["prompt.vendorTemplates"]);
  values["prompt.vendorDir"] = coerce(ITEM_BY_KEY.get("prompt.vendorDir"), own["prompt.vendorDir"]);
  values["prompt.vendorPick"] = coerce(ITEM_BY_KEY.get("prompt.vendorPick"), own["prompt.vendorPick"]);
  // 能力类别段（40 类 + 实测分）
  values["prompt.capabilityCatalog"] = coerce(ITEM_BY_KEY.get("prompt.capabilityCatalog"), own["prompt.capabilityCatalog"]);
  values["prompt.breachSelfCheck"] = own["prompt.breachSelfCheck"] !== false;
  values["prompt.capabilityScores"] = own["prompt.capabilityScores"] && typeof own["prompt.capabilityScores"] === "object"
    ? own["prompt.capabilityScores"]
    : null;
  // 尾部硬权重段：档位写错不在这里纠正，读侧按未知档退回默认
  values["prompt.boostTail"] = coerce(ITEM_BY_KEY.get("prompt.boostTail"), own["prompt.boostTail"]);
  values["prompt.boostProfile"] = coerce(ITEM_BY_KEY.get("prompt.boostProfile"), own["prompt.boostProfile"]);
  // 深度破甲五项
values["deep.enabled"] = coerce(ITEM_BY_KEY.get("deep.enabled"), own["deep.enabled"]);
values["deep.refusalFilter"] = coerce(ITEM_BY_KEY.get("deep.refusalFilter"), own["deep.refusalFilter"]);
    values["deep.forceClean"] = coerce(ITEM_BY_KEY.get("deep.forceClean"), own["deep.forceClean"]);
values["deep.tailSteer"] = coerce(ITEM_BY_KEY.get("deep.tailSteer"), own["deep.tailSteer"]);
values["deep.prefill"] = coerce(ITEM_BY_KEY.get("deep.prefill"), own["deep.prefill"]);
values["deep.stripPrefill"] = coerce(ITEM_BY_KEY.get("deep.stripPrefill"), own["deep.stripPrefill"]);
  for (const key of QUALITY_KEYS) {
    values[key] = coerce(ITEM_BY_KEY.get(key), own[key]);
  }

  for (const key of PERSONA_KEYS) {
    values[key] = coerce(ITEM_BY_KEY.get(key), own[key]);
  }

  values["auto.autoRetry"] = cont.autoRetry !== false;
  values["auto.retryMax"] = coerce(ITEM_BY_KEY.get("auto.retryMax"), cont.retryMax);
  values["auto.autoContinue"] = cont.autoContinue === true;
  values["auto.continueMax"] = coerce(ITEM_BY_KEY.get("auto.continueMax"), cont.continueMax);
  values["auto.continueText"] = coerce(ITEM_BY_KEY.get("auto.continueText"), cont.continueText == null ? "继续" : cont.continueText);

  // 输出守卫三项来自独立文件，缺省按 ITEM_BY_KEY 的 def 填
  const guard = readJson(guardSettingsPath(home)) || {};
  for (const gk of GUARD_MISC_KEYS) {
    const field = gk.slice("auto.".length);
    values[gk] = coerce(ITEM_BY_KEY.get(gk), guard[field]);
  }

  values["tools.hooksDenyBypass"] = readHooksDeny(home);
  values["tools.drillGrant"] = readDrill(home);
  try {
    values["tools.ownServers"] = String(readAllowText(home) || "");
  } catch {
    values["tools.ownServers"] = "";
  }

  values["host.hideConsole"] = coerce(ITEM_BY_KEY.get("host.hideConsole"), own["host.hideConsole"]);

  // 只读项一律报 true：它们被锁定为开启，磁盘上写了 false 也不认。
  for (const key of READ_ONLY_TRUE_KEYS) {
    if (key in values) values[key] = true;
  }

  return values;
}

/**
 * 写一项。按 key 前缀分派到正确的存储，写完返回该项的新值。
 * 调用方据此立即重绘，不需要再读一遍全量。
 */
export async function writeMiscSetting(dshHome, key, rawValue) {
  const home = String(dshHome || "");
  const item = ITEM_BY_KEY.get(key);
  if (!item) {
    const e = new Error(`unknown setting: ${key}`);
    e.statusCode = 400;
    throw e;
  }
  const value = coerce(item, rawValue);

  /* 只读项拦在写入口，而不是只靠前端置灰 —— 前端置灰挡不住直接打接口的人，
     也挡不住前端自己哪天把 disabled 写漏。这里拒绝并把真实值告诉调用方。 */
  if (READ_ONLY_SET.has(key)) {
    const e = new Error(`setting is read-only: ${key}`);
    e.statusCode = 409;
    e.readOnly = true;
    e.key = key;
    e.value = true;
    throw e;
  }

  if (GUARD_MISC_KEYS.includes(key)) {
    // 守卫三项单独落盘。continue-retry.json 的 normalizeConfig 只认它自己那几个键，
    // 塞进去会被静默丢掉 —— 界面就会表现为「改了又跳回去」。
    // 注意键名是 auto.outputGuard / auto.guardAutoRepair / auto.guardMaxRepair，
    // 前缀不统一，所以必须按白名单精确匹配，不能靠 startsWith。
    const file = guardSettingsPath(home);
    const cur = readJson(file) || {};
    cur[key.slice("auto.".length)] = value;
    writeJson(file, cur);
    return value;
  }

  if (key.startsWith("auto.")) {
    const cur = readContinue(home);
    const next = { ...cur };
    const field = key.slice("auto.".length);
    next[field] = value;
    // 走模块自己的 normalizeConfig，保证写回去的形态和 loadSettings 读出来的完全一致。
    const normalized = continueRetry.normalizeConfig(next);
    writeJson(continueRetry.settingsPath(home), normalized);
    return normalized[field];
  }

  if (key === "tools.hooksDenyBypass") {
    const file = path.join(home, "hooks-deny.json");
    const cur = readJson(file) || {};
    cur.hooksDenyBypass = value === true;
    writeJson(file, cur);
    return value;
  }

  if (key === "tools.drillGrant") {
    const file = path.join(home, "dsh-purge", "drill-grant.json");
    if (value === true) {
      writeJson(file, { granted: true, at: new Date().toISOString() });
    } else {
      try { fs.unlinkSync(file); } catch { /* 本来就没有 */ }
    }
    return value;
  }

  if (key === "tools.ownServers") {
    // net-scope 的 writeAllowText 在这个版本里是空实现（全放行策略下被停用），
    // 直接调它等于把用户输入丢掉。这里自己写 allow 文件，读侧仍走 readAllowText / allowFilePath。
    const file = allowFilePath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(value == null ? "" : value), "utf8");
    return value;
  }

  // prompt.* / host.* 落在插件自己的文件里。
  const own = readJson(miscSettingsPath(home)) || {};
  own[key] = value;
  writeJson(miscSettingsPath(home), own);
  return value;
}

/** 批量写；遇到第一个错误就停，把已成功的键一起返回，界面可据此局部刷新。 */
export async function writeMiscSettings(dshHome, patch) {
  const applied = {};
  if (!patch || typeof patch !== "object") return applied;
  for (const [k, v] of Object.entries(patch)) {
    applied[k] = await writeMiscSetting(dshHome, k, v);
  }
  return applied;
}

/** 把 MISC_GROUPS 摊平成前端要的 [{group, items:[{key,kind,def,min,max}]}]。 */
export function miscSchema() {
  return MISC_GROUPS.map((g) => ({
    id: g.id,
    items: g.items.map((it) => ({
      key: it.key,
      kind: it.kind,
      def: defaultScalar(it),
      ...(READ_ONLY_SET.has(it.key) ? { readOnly: true } : {}),
      ...(Number.isFinite(it.min) ? { min: it.min } : {}),
      ...(Number.isFinite(it.max) ? { max: it.max } : {}),
      ...(Number.isFinite(it.maxLen) ? { maxLen: it.maxLen } : {}),
    })),
  }));
}

export { HOOK_DENY_PATCH_IDS };
