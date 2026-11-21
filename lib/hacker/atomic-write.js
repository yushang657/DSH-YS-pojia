/**
 * 兼容转发层 —— **新代码不要用这个**，直接用 `lib/state-guard.js`。
 *
 * 这个模块原本是本地的"写临时文件 → fsync → rename"实现，只保证"写一半不崩"，
 * 不拒绝符号链接目标、不拒绝非普通文件、不做同目录互斥。现在插件的所有状态写入
 * 都统一走 `lib/state-guard.js`（→ `lib/state-lock.js`），本文件已无调用方。
 *
 * 保留它而不是删掉，是为了让任何遗漏的旧引用继续工作 —— 但转发到安全实现，
 * 所以即使有人又 import 回来，行为也是安全的那一套，而不是退回无防护版本。
 */
import { writeStateFile } from '../state-guard.js'

/**
 * 原子写一个文件。
 *
 * @param file - 目标路径。
 * @param text - 要写入的文本。
 * @returns 写入的字节数。
 * @throws {StateLockError} 目标为符号链接（ESYMLINK）或非普通文件（ENOTREG）时。
 */
export function atomicWriteFileSync(file, text) {
  const written = writeStateFile(file, String(text ?? ''))
  if (written.ok !== true) {
    const error = new Error(written.error || `写入失败：${file}`)
    error.code = written.code || 'EWRITE'
    error.path = file
    throw error
  }
  return written.bytes
}
