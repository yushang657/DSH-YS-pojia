/**
 * 创世神模式的推理钉档插件。
 *
 * ## 先说能力边界（这一节决定了本文件能写什么）
 *
 * 宿主里推理档位的**唯一入口**是模型路由本身：
 *
 *   · `@deepseek-ai/dsh-llm-deepseek` 的 `deepSeekConfigFields` 定义了
 *     `reasoningEffort: z.union(["off","low","high","max"])` 与
 *     `thinking: z.union(["enabled","disabled"])`。
 *   · 这两个字段挂在 **provider 连接配置** 上，由
 *     `@deepseek-ai/dsh-agent-default-model` 的
 *     `Config = z.object({provider, model, reasoningEffort})` 暴露给 preset。
 *
 * 关键限制：`provider` 和 `model` 都是 `required()`。
 * 也就是说 —— **preset 里想改 reasoningEffort，就必须同时写死 provider/model**。
 * 写死 provider/model 的后果是：用户没配那个模型时，preset 在挂载期直接失败，
 * 整个模式不可用。
 *
 * 所以本插件**不通过 cordis 服务去改推理档位**（没有那样的服务，改了也是假的），
 * 而是做两件真的有用的事：
 *
 *   1. 把「这个模式要什么档位」写成一份机器可读的声明落到 `$DSH_HOME`，
 *      让前端与后续的宿主改造有单一事实来源；
 *   2. 探测当前宿主的推理能力（读 provider 配置里的 reasoningEffort 枚举），
 *      把探测结果一并写进声明 —— 用户能一眼看到「我这个宿主到底支持几档」。
 *
 * 真正提升推理质量的部分在 persona 里（抗幻觉规程 + 取证顺序），
 * 那是纯提示词层，任何宿主都生效，不依赖模型是否支持 reasoning 参数。
 *
 * ## 想真正钉死 max 档怎么办
 *
 * 两条路，都写在这里免得下次重新调研：
 *
 *   A. 让用户在宿主「设置 → 模型」里把 reasoningEffort 手动选成 max，
 *      本模式负责其余全部（上下文、委派、抗幻觉规程）。
 *      —— 立刻可用，不改任何宿主代码。
 *
 *   B. 在 provider 连接配置（`$DSH_HOME` 下的模型配置文件）里写入
 *      `reasoningEffort: "max"` + `thinking: "enabled"`。
 *      —— 全局生效，会影响所有模式，适合确定只用高配模型的用户。
 *      本插件提供 `applyToProviderConfig` 工具函数做这件事，但**默认不调用**，
 *      必须用户在配置里显式打开 `writeProviderConfig: true`。
 */

import fs from "node:fs";
import path from "node:path";

export const name = "dsh-purge-genesis-anchor";
export const MODE = "genesis";

/** 宿主真实支持的推理档位（来自 dsh-llm-deepseek 的 z.union）。 */
export const REASONING_EFFORTS = ["off", "low", "high", "max"];
export const THINKING_MODES = ["enabled", "disabled"];

/** 声明文件名。前端与诊断脚本读它。 */
export const DECL_FILE = "genesis-declaration.json";

function resolveHomeCandidates() {
  const out = [];
  const env = String(process.env.DSH_HOME || "").trim();
  if (env) out.push(env);
  const home = String(process.env.USERPROFILE || process.env.HOME || "").trim();
  if (home) out.push(path.join(home, ".dsh"));
  return [...new Set(out.filter(Boolean))];
}

function pickLiveHome() {
  const candidates = resolveHomeCandidates();
  for (const home of candidates) {
    try {
      if (fs.statSync(path.join(home, "armor-engine.json")).isFile()) return home;
    } catch { /* 试下一个 */ }
  }
  return candidates[0] || "";
}

/**
 * 探测宿主是否真的支持 max 档。
 *
 * 做法：在 aiBase 里找 `dsh-llm-deepseek` 的编译产物，读它的
 * `reasoningEffort` 联合类型字面量。找不到就当「未知」，不当「不支持」——
 * 定制版宿主可能换了包名，未知不等于没有。
 */
export function probeReasoningSupport() {
  const bases = [];
  const envBase = String(process.env.DSH_AI_BASE || "").trim();
  if (envBase) bases.push(envBase);
  // 定制版 DS-YS 的真实 aiBase（只有这个路径能通过 isAiBase 检查）
  bases.push(path.join(path.dirname(String(process.env.DSH_HOME || "")), "..", "resources", "app", "dsh", "node_modules", "@deepseek-ai"));

  for (const base of bases) {
    if (!base) continue;
    const target = path.join(base, "dsh-llm-deepseek", "lib", "index.js");
    let text = "";
    try {
      text = fs.readFileSync(target, "utf8");
    } catch {
      continue;
    }
    const found = REASONING_EFFORTS.filter((id) => text.includes(`"${id}"`));
    if (found.length) {
      return { known: true, efforts: found, supportsMax: found.includes("max"), source: target };
    }
  }
  return { known: false, efforts: [], supportsMax: null, source: "" };
}

/**
 * 可选路径 B：把 reasoningEffort 写进 provider 配置。
 *
 * 默认**不调用**。它会让所有模式都吃这个档位，属于全局副作用，
 * 必须用户在 preset config 里显式写 `writeProviderConfig: true` 才动手。
 *
 * 目标文件是 `$DSH_HOME/models.json`（定制版宿主读这个）。
 * 结构未知时不动手 —— 宁可返回 skipped，也不要猜结构把用户配置写坏。
 */
export function applyToProviderConfig(dshHome, effort) {
  const file = path.join(dshHome, "models.json");
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { written: false, reason: "models.json 不存在或不是合法 JSON，未改动" };
  }
  if (!raw || typeof raw !== "object") {
    return { written: false, reason: "models.json 顶层不是对象，未改动" };
  }
  // 只在能认出 provider 列表结构时改。认不出就不猜。
  const providers = Array.isArray(raw.providers) ? raw.providers : null;
  if (!providers) {
    return { written: false, reason: "没有 providers 数组，结构不认识，未改动" };
  }
  let touched = 0;
  for (const p of providers) {
    if (!p || typeof p !== "object") continue;
    if (p.reasoningEffort !== effort) {
      p.reasoningEffort = effort;
      touched += 1;
    }
    if (p.thinking !== "enabled") {
      p.thinking = "enabled";
      touched += 1;
    }
  }
  if (!touched) return { written: false, reason: "已经是目标档位，无需改动" };
  // 先备份再写：这是全局配置，写坏了用户所有模式都起不来。
  try {
    fs.copyFileSync(file, `${file}.bak`);
  } catch { /* 备份失败也继续，但下面写会失败就是失败 */ }
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return { written: true, touched, backup: `${file}.bak` };
}

export function apply(_ctx, config = {}) {
  const wantEffort = REASONING_EFFORTS.includes(config.reasoningEffort)
    ? config.reasoningEffort
    : "max";
  const wantThinking = THINKING_MODES.includes(config.thinking) ? config.thinking : "enabled";
  const writeProviderConfig = config.writeProviderConfig === true;

  const home = pickLiveHome();
  const support = probeReasoningSupport();
  const decl = {
    mode: MODE,
    requested: { reasoningEffort: wantEffort, thinking: wantThinking },
    hostSupport: support,
    // 这句是给人的提示，不是给机器的字段。
    note: support.known
      ? (support.supportsMax
        ? "宿主支持 max 档。到「设置 → 模型」把推理档位选成 max，本模式其余项已生效。"
        : "宿主不支持 max 档，最高可用档位见 hostSupport.efforts。已按最高可用档运行。")
      : "探测不到宿主推理能力（可能换了包名）。推理档位请手动在「设置 → 模型」里调。",
    appliedAt: new Date().toISOString(),
  };

  if (writeProviderConfig && home) {
    try {
      decl.providerWrite = applyToProviderConfig(home, wantEffort);
    } catch (err) {
      decl.providerWrite = { written: false, reason: String(err?.message || err) };
    }
  } else {
    decl.providerWrite = { written: false, reason: "未开启 writeProviderConfig（默认）" };
  }

  if (home) {
    try {
      fs.writeFileSync(
        path.join(home, DECL_FILE),
        `${JSON.stringify(decl, null, 2)}\n`,
        "utf8",
      );
    } catch { /* 写不了声明不影响会话，静态部分已生效 */ }
  }
  return decl;
}
