/**
 * 三模式（嘿客 / 无限制 / 创世神）的 HTTP 桥。
 *
 * 路由：
 *   GET  /ys-pojia/mode/status   三个模式的安装状态 + 当前会话用的是哪个
 *   POST /ys-pojia/mode/switch   { mode } → 把模式写进 agent-preset 配置
 *
 * ── 为什么模式不能像引擎那样「点了立刻切」────────────────────────────────
 * 引擎档位是插件自己的状态（`armor-engine.json`），插件读它就改行为。
 * 模式是**宿主的 agent preset**：它决定这次会话挂哪些插件、用哪份人设。
 * 换成 host 的说法 —— 模式在会话创建那一刻就固化了，中途换不生效。
 *
 * 所以本接口做的事是：把用户选的模式写成宿主的
 * `selectedDefault`（下次新建会话默认用它），并明确告诉前端
 * 「要新建会话才生效」。不假装能热切。
 *
 * 那么「用哪个模式」怎么让用户看见？
 *   · 当前会话的模式：读会话的 agentPreset（见 identity.js 的 sessionMode）
 *   · 下次新建会话的模式：读 selectedDefault
 * 两个值都返回，界面上分开显示，避免用户以为切了但当前会话没变。
 */

import fs from "node:fs";
import path from "node:path";

/** 三个模式的描述。前端靠它渲染卡片，改文案只改这里。 */
export const MODE_CATALOG = [
  {
    id: "hacker",
    name: "嘿客模式",
    order: 10,
    tagline: "逆向 / 渗透 / 攻防",
    summary:
      "把模型变成一支有分工的作业队。主会话只做指挥与派活，具体活派给五个执行角色；资产、漏洞、证据全部落 SQLite 库，跨会话可查。",
    does: [
      "六个角色分工：侦察、梳理、漏洞发现、利用、内网、逆向分析",
      "每个角色有独立系统提示词，不互相污染",
      "同靶标并发上限 3，强制顺序推进，防自己人打自己人",
      "资产/漏洞/证据落库，先查库再动手，避免重复劳动",
      "开箱接 FOFA、suo5、fscan、gogo、nmap、nuclei 等工具链",
      "逆向与渗透可串联：逆向出密钥/协议喂给渗透，渗透抓的样本喂给逆向",
    ],
    cost: [
      "每个执行角色是独立子会话，token 按角色数线性增长",
      "并发 3 个角色时消耗约为单会话的 3–4 倍",
      "需要自备工具与 key，缺了会先跟你要素材",
    ],
    bestFor: "有明确目标要打完的活：打点、内网、样本分析、协议还原",
    heavy: false,
    needsNewSession: true,
  },
  {
    id: "unlimited",
    name: "无限制模式",
    order: 20,
    tagline: "破甲全开",
    summary:
      "把约束面全部放开。40 条规则默认全开（含平时关着的那条），人设换成不做自我审查的版本，工具超时、上下文、委派深度一并放宽。",
    does: [
      "规则集全量启用，不留默认关闭项",
      "人设改为「先做再说、不自我设限、失败换路」",
      "工具超时 10 分钟，长命令不会被切断",
      "上下文压缩阈值抬高，长任务不会中途丢上下文",
      "子智能体可再委派一层，Ralph 轮次放到 128",
    ],
    cost: [
      "约束少了，跑偏的风险相应变高，重要操作要自己复核",
      "上下文阈值高 = 单次请求更贵",
    ],
    bestFor: "被普通模式反复拦住的活，或需要长链路的连续作业",
    heavy: false,
    needsNewSession: true,
  },
  {
    id: "genesis",
    name: "创世神模式",
    order: 30,
    tagline: "性能全解锁 + 抗幻觉",
    summary:
      "把预算全花在「一次做对」上。推理预算拉满，并挂一整套可判定的抗幻觉规程：事实分级、未读文件不许描述、未跑命令不许报输出、疑点必须单列。",
    does: [
      "推理档位拉到宿主支持的最高档（deepseek 适配器支持 off/low/high/max）",
      "思考链强制开启，不允许静默跳过推理",
      "六条可判定抗幻觉规程：来源分级、不臆测文件内容、不预演命令输出、标识符逐字核对、结论分级、疑点单列",
      "上下文压缩阈值最高档，一次吃进大文件不会被切",
      "委派深度 2 层、Ralph 256 轮、工具超时 15 分钟",
      "每轮结束前自检「有没有把推断写成已证」",
    ],
    cost: [
      "**token 消耗极高**：推理档位 max + 思考全开 + 上下文阈值最高，单轮成本是普通模式的数倍",
      "响应更慢，短问题也会走完整推理链",
      "复杂任务一次可能吃掉几十万 token",
    ],
    bestFor: "一次做对就行的硬仗：疑难 bug、架构决策、不可返工的分析",
    heavy: true,
    needsNewSession: true,
  },
];

/** 按 id 找模式定义。 */
export function modeById(id) {
  const key = String(id || "").trim().toLowerCase();
  return MODE_CATALOG.find((m) => m.id === key) || null;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

/** 预检应答。与 lib/index.js 的 sendOptions 保持一致。 */
function respondOptions(response) {
  response.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  });
  response.end();
}

function readJsonBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      // 8 KiB 上限：这里只传一个 mode 字符串，超了必是误用。
      if (raw.length > 8192) raw = raw.slice(0, 8192);
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(null);
      }
    });
    request.on("error", () => resolve(null));
  });
}

/**
 * 判断一个 preset 目录装到位没有。
 *
 * 判据是 `agent.cordis.yml` 存在且非空 —— `preset.yml` 只是元数据，
 * 少它宿主仍能列出模式（名字会是 id），少了 agent.cordis.yml 才是真没装。
 */
function presetInstalled(presetRoot, id) {
  const file = path.join(presetRoot, id, "agent.cordis.yml");
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

/**
 * 读宿主当前的「新建会话默认模式」。
 *
 * ## 为什么这里不再只读 YAML —— 一次真实的走错路
 *
 * 最初实现是去 `profiles/<name>/cordis.patch.yml` 里 grep `selectedDefault`。
 * 实测本机三个模式都装好了、接口也通，但切换永远返回「找不到 selectedDefault 行」。
 * 翻宿主的源码才看清：
 *
 *   `@deepseek-ai/dsh-agent-preset-registry` 的 Config 是
 *     `{ default: z.string().required(), selectedDefault: z.string().volatile() }`
 *   而 `defaultId` 的读法是
 *     `this.config.selectedDefault.get() ?? this.config.default`
 *
 * 也就是说 `selectedDefault` 是 **Cordis schemastery 配置项**，由 settings 服务
 * 持久化在它自己的存储里（`profiles/<name>/` 之外的位置），
 * 不会出现在 `cordis.patch.yml` 的文本里。
 *
 * 所以读取要走 `ctx.get("settings")` 这条真路。YAML 只作为最后兜底 ——
 * 某些手工配置过的环境里用户会直接写 YAML，那条路仍然保留。
 */

/** 从 settings 服务里取 agent-preset-registry 这一行配置。 */
function presetRegistryRow(settings) {
  if (!settings || typeof settings.get !== "function") return null;
  for (const key of ["agent-preset-registry", "@deepseek-ai/dsh-agent-preset-registry"]) {
    try {
      const row = settings.get(key);
      if (row) return row;
    } catch { /* 试下一个 key */ }
  }
  return null;
}

/** schemastery 配置项可能是 `{get()}`，也可能就是裸值。统一取出来。 */
function configValue(node) {
  if (node == null) return "";
  if (typeof node === "string") return node.trim();
  try {
    if (typeof node.get === "function") return String(node.get() ?? "").trim();
  } catch { /* 落到下面 */ }
  try {
    if (typeof node.value !== "undefined") return String(node.value ?? "").trim();
  } catch { /* 落到下面 */ }
  return "";
}

/**
 * 读「新建会话默认模式」。
 *
 * @param {string} dshHome
 * @param {object} settings  宿主 settings 服务（拿不到时传 null，走 YAML 兜底）
 * @returns {{value: string, source: string}}
 */
function readSelectedDefault(dshHome, settings = null) {
  // 1) settings 服务 —— 宿主真正用的路径
  const row = presetRegistryRow(settings);
  if (row) {
    const cfg = row.config || row;
    const selected = configValue(cfg.selectedDefault);
    if (selected) return { value: selected, source: "settings:agent-preset-registry" };
    const fallback = configValue(cfg.default);
    if (fallback) return { value: fallback, source: "settings:agent-preset-registry(default)" };
  }

  // 2) YAML 兜底 —— 手工配置过的环境
  const profiles = path.join(dshHome, "profiles");
  let names = [];
  try {
    names = fs.readdirSync(profiles, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "node_modules")
      .map((e) => e.name);
  } catch {
    return { value: "", source: "" };
  }
  for (const name of names) {
    for (const file of ["cordis.patch.yml", "cordis.yml"]) {
      const fp = path.join(profiles, name, file);
      let text = "";
      try {
        text = fs.readFileSync(fp, "utf8");
      } catch {
        continue;
      }
      const m = text.match(/selectedDefault\s*:\s*["']?([\w.-]+)["']?/);
      if (m && m[1]) return { value: m[1].trim(), source: fp };
    }
  }
  return { value: "", source: "" };
}

/**
 * 把「新建会话默认模式」写成指定值。
 *
 * 优先走 settings 服务：`settings.update("agent-preset-registry", { selectedDefault })`。
 * 这条路和宿主自己在 UI 里切换模式时走的是同一条，不会有格式不一致的问题。
 *
 * 服务不可用（或调用失败）才退回 YAML 改写，且**只在找到现有
 * selectedDefault 行时才改**——找不到不擅自插入，因为 Cordis 配置有层级，
 * 插错位置会让整份配置解析失败，那个代价比「切换失败」大得多。
 */
function writeSelectedDefault(dshHome, mode, settings = null) {
  const row = presetRegistryRow(settings);
  if (row && typeof settings.update === "function") {
    try {
      const ret = settings.update("agent-preset-registry", { selectedDefault: mode });
      // 可能是 Promise，也可能同步。异步的交给调用方轮询读回验证。
      if (ret && typeof ret.then === "function") ret.catch(() => {});
      return { written: true, source: "settings:agent-preset-registry" };
    } catch (err) {
      // 服务调用失败不直接报错，退回 YAML 兜底再试一次。
      const yaml = writeSelectedDefaultYaml(dshHome, mode);
      return yaml.written ? yaml : { written: false, reason: `settings 写入失败：${String(err?.message || err)}；${yaml.reason || ""}` };
    }
  }
  return writeSelectedDefaultYaml(dshHome, mode);
}

/** YAML 兜底写入。只改现有行，不插入。 */
function writeSelectedDefaultYaml(dshHome, mode) {
  const { source } = readSelectedDefault(dshHome, null);
  if (!source || source.startsWith("settings:")) {
    return { written: false, reason: "宿主的模式选择存在设置服务里，读不到该服务的句柄，请先在宿主界面里手动选一次模式" };
  }
  let text = "";
  try {
    text = fs.readFileSync(source, "utf8");
  } catch {
    return { written: false, reason: "读配置失败" };
  }
  const re = /(selectedDefault\s*:\s*)(["']?)([\w.-]+)(\2)/;
  if (!re.test(text)) {
    return { written: false, reason: "配置里没有 selectedDefault 行，请先在宿主界面里手动选一次模式" };
  }
  const next = text.replace(re, (_all, head, q1, _old, q2) => `${head}${q1}${mode}${q2}`);
  if (next === text) return { written: false, reason: "已经是这个模式，无需改动", source };
  try {
    fs.copyFileSync(source, `${source}.bak`);
  } catch { /* 备份失败继续写 */ }
  try {
    fs.writeFileSync(source, next, "utf8");
  } catch (err) {
    return { written: false, reason: String(err?.message || err) };
  }
  return { written: true, source };
}

/**
 * 装 HTTP 路由。
 *
 * 对齐宿主真实的注册契约：`registerRoute(webServer, { kind, path, handler })`，
 * handler 拿 `(request, response)`，自己按 method 分支。
 * 一个 prefix 路由同时吃 GET / POST，比注册两条同路径路由稳
 *（后者在部分 webServer 实现里会被前一条吃掉）。
 *
 * @param {object} host  宿主 webServer
 * @param {object} deps  { findDshHome, presetRoot, sessionMode, registerRoute }
 * @returns {Array}       注册返回的 stop 函数数组，供上层统一回收
 */
export function installModeHttp(host, deps = {}) {
  const webServer = host?.webServer || host;
  const registerRoute = deps.registerRoute;
  if (!webServer || typeof registerRoute !== "function") return [];

  const resolveHome = typeof deps.findDshHome === "function" ? deps.findDshHome : () => String(deps.findDshHome || "");
  const presetRootOf = typeof deps.presetRoot === "function" ? deps.presetRoot : () => String(deps.presetRoot || "");
  const currentMode = typeof deps.sessionMode === "function" ? deps.sessionMode : () => "";
  // 宿主的 settings 服务。这是读/写 selectedDefault 的正路（见 readSelectedDefault 的注释）。
  const settingsOf = typeof deps.settings === "function" ? deps.settings : () => deps.settings || null;

  const stop = [];
  stop.push(registerRoute(webServer, {
    kind: "prefix",
    path: "/ys-pojia/mode",
    handler: async (request, response) => {
      if (request.method === "OPTIONS") {
        respondOptions(response);
        return;
      }
      const home = resolveHome();
      const presetRoot = presetRootOf();
      const settings = settingsOf();

      // ── GET /ys-pojia/mode/status ──
      if (request.method === "GET") {
        try {
          const selected = readSelectedDefault(home, settings);
          sendJson(response, 200, {
            ok: true,
            home,
            presetRoot,
            modes: MODE_CATALOG.map((m) => ({
              ...m,
              installed: presetRoot ? presetInstalled(presetRoot, m.id) : false,
            })),
            // 当前会话用的（会话创建时固化，改不了）
            current: currentMode(),
            // 下次新建会话会用哪个（可改）
            selected: selected.value,
            selectedSource: selected.source,
          });
        } catch (err) {
          sendJson(response, 500, { ok: false, error: String(err?.message || err) });
        }
        return;
      }

      // ── POST /ys-pojia/mode/switch ──
      if (request.method === "POST") {
        const body = await readJsonBody(request);
        if (!body || typeof body.mode !== "string") {
          sendJson(response, 400, { ok: false, error: "body 需要 { mode: 'hacker'|'unlimited'|'genesis' }" });
          return;
        }
        const mode = body.mode.trim().toLowerCase();
        if (!modeById(mode)) {
          sendJson(response, 400, { ok: false, error: `未知模式：${mode}` });
          return;
        }
        if (!presetInstalled(presetRoot, mode)) {
          sendJson(response, 409, {
            ok: false,
            error: `模式 ${mode} 还没装到这个 home。先装插件，或把 presets/${mode}/ 复制到 ${presetRoot}/${mode}/`,
          });
          return;
        }
        try {
          const res = writeSelectedDefault(home, mode, settings);
          const selected = readSelectedDefault(home, settings);
          sendJson(response, res.written ? 200 : 409, {
            ok: res.written,
            mode,
            written: res.written,
            reason: res.reason || "",
            source: res.source || "",
            selected: selected.value,
            current: currentMode(),
            // 这句是给前端的明确提示，不是错误。
            note: res.written
              ? "已设为新建会话的默认模式。当前会话不受影响——要生效请新建一个会话。"
              : (res.reason || ""),
          });
        } catch (err) {
          sendJson(response, 500, { ok: false, error: String(err?.message || err) });
        }
        return;
      }

      sendJson(response, 405, { ok: false, error: "method not allowed" });
    },
  }));

  return stop;
}
