/**
 * 插件级设置（零依赖）：目前只有一项 —— **并发执行智能体上限**。
 *
 * 为什么不用环境变量：`HACKER_MAX_AGENTS` 只能启动前设，改完得重启 dsh web；
 * 而"同时派几个执行智能体"是使用中最常调的一项，面板上应该能直接改。
 * 所以落一份 JSON 到事实库根目录：`$DSH_HOME/hacker/settings.json`。
 *
 * 生效顺序：settings.json → 环境变量 `HACKER_MAX_AGENTS` → 默认 3。
 * 工具侧（hacker_agent_slot 闸门）与面板侧（「智能体」页）读的是同一份，避免两处口径漂移。
 */
import { join } from 'node:path'
import { readStateJson, writeStateJson } from '../state-guard.js'

/** 默认并发上限（用户口径：整个项目默认 3 个执行智能体）。 */
export const DEFAULT_MAX_AGENTS = 3

/** 硬上限：再多也不会更快 —— 同一个 API Key 的并发/速率限制会先到，反而扰动测试。 */
export const MAX_AGENTS_LIMIT = 10

/** 设置文件路径（跟事实库同一个根，随事实库一起备份/迁移）。 */
export function settingsPathOf(root) {
  return join(String(root || '.'), 'settings.json')
}

/** 读全部设置（读不到/坏了都当空对象，绝不抛）。 */
export function readSettings(root) {
  return readStateJson(settingsPathOf(root), {})
}

/**
 * 合并写入若干项设置，返回写入后的完整设置。
 *
 * 走 `lib/state-guard.js`：拒绝符号链接目标、原子写、同目录互斥。
 * 写入失败时仍然返回合并后的对象（读侧语义不变），但错误会进
 * `recentStateLockEvents()`。需要如实上报成败的调用方请用
 * `writeSettingsChecked`。
 */
export function writeSettings(root, patch) {
  const next = Object.assign({}, readSettings(root), patch)
  writeStateJson(settingsPathOf(root), next)
  return next
}

/**
 * 同 `writeSettings`，但把落盘结果一并返回，供面板如实提示。
 * @returns `{ ok, settings, code?, error?, digest?, bytes? }`
 */
export function writeSettingsChecked(root, patch) {
  const next = Object.assign({}, readSettings(root), patch)
  const written = writeStateJson(settingsPathOf(root), next)
  if (written && written.ok === true) {
    return { ok: true, settings: next, digest: written.digest, bytes: written.bytes }
  }
  return {
    ok: false,
    settings: next,
    code: (written && written.code) || 'EWRITE',
    error: (written && written.error) || '写入设置文件失败',
  }
}

/** 把任意输入收敛到 [1, MAX_AGENTS_LIMIT] 的整数。 */
export function clampMaxAgents(value) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_MAX_AGENTS
  return Math.min(Math.max(n, 1), MAX_AGENTS_LIMIT)
}

/**
 * 当前生效的并发上限。
 * @param root - 事实库根目录（`ctx.hacker.root`）。
 * @param env - 环境变量表（便于测试注入）。
 * @returns 生效的整数上限。
 */
export function maxAgentsOf(root, env = process.env) {
  const fromFile = Number(readSettings(root).maxAgents)
  if (Number.isFinite(fromFile) && fromFile > 0) return clampMaxAgents(fromFile)
  const fromEnv = Number(env && env.HACKER_MAX_AGENTS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return clampMaxAgents(fromEnv)
  return DEFAULT_MAX_AGENTS
}

/** 保存并发上限，返回实际生效值。 */
export function saveMaxAgents(root, value) {
  const applied = clampMaxAgents(value)
  writeSettings(root, { maxAgents: applied })
  return applied
}

/**
 * 保存并发上限并返回落盘结果（面板用）。
 * @returns `{ ok, max, code?, error? }`
 */
export function saveMaxAgentsChecked(root, value) {
  const applied = clampMaxAgents(value)
  const written = writeSettingsChecked(root, { maxAgents: applied })
  if (written.ok) return { ok: true, max: applied, digest: written.digest }
  return { ok: false, max: applied, code: written.code, error: written.error }
}

/** 当前设置是从哪来的（面板上要如实说明，避免"我改了没生效"的错觉）。 */
export function maxAgentsSourceOf(root, env = process.env) {
  const fromFile = Number(readSettings(root).maxAgents)
  if (Number.isFinite(fromFile) && fromFile > 0) return 'settings'
  const fromEnv = Number(env && env.HACKER_MAX_AGENTS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return 'env'
  return 'default'
}
