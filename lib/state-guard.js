/**
 * 状态锁接入层 —— 把 `lib/state-lock.js` 的四道硬约束接到 `lib/hacker/` 的实际写入点。
 *
 * 背景：`state-lock.js` 本身是纯函数集合，57 条断言全过，但没人调用它，
 * 等于零防护。这个模块是唯一的接入面，负责三件事：
 *
 * 1. **符号链接/非普通文件拒绝** —— 面板"保存设置"时目标可能是攻击者换过的链接。
 * 2. **原子写** —— 半截 JSON 会让读侧静默回退默认值，用户的设置无声消失。
 * 3. **跨进程互斥** —— 两个窗口同时改设置，后写的赢但读的是旧快照，前一次修改丢失。
 *
 * 设计取舍：
 * - **不校验内容摘要（expectedDigest）**。这些设置文件本来就要被手改，用户改完再存是
 *   正常路径；用 `EDRIFTED` 拒绝会让"改完设置面板就存不进去"。摘要校验留给真正
 *   需要防篡改的受管产物，不套在用户可编辑的配置上。
 * - **符号链接拒绝不降级**。这是安全属性，绕过去就等于没有。
 * - **互斥失败要降级**。锁文件残留（上次进程被 kill）不该让面板永久写不进设置；
 *   `ELOCKED` 时退化为无锁写，但把事件记进 `lastWarnings` 让上层能提示。
 *
 * 与 `lib/hacker/atomic-write.js` 的关系：那个只保证"写一半不崩"，不拒绝链接。
 * 这里能力是它的超集，`hacker/` 侧的写入点统一切到本模块，避免两套并存。
 */

import path from 'node:path'

import {
  StateLockError,
  atomicWriteGuarded,
  ensureDirectory,
  readRegularText,
  sha256,
  withLock,
} from './state-lock.js'

/**
 * 最近一次降级/拒绝事件。面板与工具侧读取它，把"为什么没保存成功"如实告诉用户。
 * 只保留最近 20 条，避免长期运行后无限增长。
 */
const MAX_WARNINGS = 20
const lastWarnings = []

/** 记录一条接入层事件。不抛错 —— 记录本身不该成为新的失败点。 */
function note(code, message, file) {
  lastWarnings.push({
    at: new Date().toISOString(),
    code: String(code || 'EUNKNOWN'),
    message: String(message || ''),
    file: file ? String(file) : '',
  })
  if (lastWarnings.length > MAX_WARNINGS) lastWarnings.splice(0, lastWarnings.length - MAX_WARNINGS)
}

/** 读最近事件（副本，外部改不到内部状态）。 */
export function recentStateLockEvents() {
  return lastWarnings.map((x) => ({ ...x }))
}

/** 清空事件缓冲（测试与面板"已读"用）。 */
export function clearStateLockEvents() {
  lastWarnings.length = 0
}

/** 把任意异常收敛成 { ok:false, code, error }，绝不抛。 */
function failure(error, file) {
  const code = error && error.code ? String(error.code) : 'EUNKNOWN'
  const message = error && error.message ? String(error.message) : String(error)
  note(code, message, file)
  return { ok: false, code, error: message, file: String(file || '') }
}

/**
 * 原子写一个受管状态文件。
 *
 * @param {string} file - 目标文件的绝对路径。
 * @param {string|Buffer} data - 要写入的内容。
 * @param {object} [options]
 * @param {boolean} [options.lock=true] - 是否取同目录互斥锁。
 * @param {string} [options.lockName] - 自定义锁文件名。
 * @returns {{ok:true,digest:string,bytes:number,file:string}|{ok:false,code:string,error:string,file:string}}
 */
export function writeStateFile(file, data, options = {}) {
  const target = String(file || '')
  if (!target) return failure(new StateLockError('文件路径为空', 'EEMPTY'), '')
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8')
  const dir = path.dirname(target)

  const write = () => {
    ensureDirectory(dir, { absentOk: true })
    atomicWriteGuarded(target, buf)
  }

  const useLock = options.lock !== false
  if (!useLock) {
    try {
      write()
      return { ok: true, digest: sha256(buf), bytes: buf.length, file: target }
    } catch (error) {
      return failure(error, target)
    }
  }

  try {
    withLock(dir, write, options.lockName ? { name: options.lockName } : {})
    return { ok: true, digest: sha256(buf), bytes: buf.length, file: target }
  } catch (error) {
    /* 锁被占（多半是上次进程被 kill 留下的残留锁）：降级为无锁写。
       写本身仍走 atomicWriteGuarded，所以"半截文件"这个故障模式依然被挡住。 */
    if (error && error.code === 'ELOCKED') {
      note('ELOCKED_FALLBACK', error.message, target)
      try {
        write()
        return {
          ok: true,
          digest: sha256(buf),
          bytes: buf.length,
          file: target,
          degraded: 'unlocked',
        }
      } catch (inner) {
        return failure(inner, target)
      }
    }
    return failure(error, target)
  }
}

/**
 * 读一个状态文件。拒绝符号链接与非普通文件；不存在返回 null（不是错误）。
 *
 * @returns {{ok:true,text:string|null}|{ok:false,code:string,error:string,file:string}}
 */
export function readStateFile(file) {
  const target = String(file || '')
  if (!target) return failure(new StateLockError('文件路径为空', 'EEMPTY'), '')
  try {
    return { ok: true, text: readRegularText(target) }
  } catch (error) {
    return failure(error, target)
  }
}

/**
 * 读 JSON 状态文件。任何失败都回退到 `fallback`，并记一条事件 —— 调用方拿到的
 * 永远是可用值，不需要自己 try/catch。这是 `hacker/settings.js` 原本的语义，
 * 这里保持不破坏它。
 */
export function readStateJson(file, fallback = {}) {
  const r = readStateFile(file)
  if (r.ok === false) return fallback
  if (r.text === null) return fallback
  try {
    const parsed = JSON.parse(r.text)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    note('EBADJSON', '状态文件不是合法 JSON，已回退默认值', file)
    return fallback
  }
}

/** 写 JSON 状态文件（自动补尾换行，与既有格式一致）。 */
export function writeStateJson(file, value, options = {}) {
  const text = JSON.stringify(value, null, 2) + '\n'
  return writeStateFile(file, text, options)
}

export { StateLockError }
