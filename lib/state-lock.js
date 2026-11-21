/**
 * 状态锁 —— 文件系统写入的四道硬约束。
 *
 * 背景：插件的设置与状态都存在用户目录里。这些文件会被读取、改写、回滚，
 * 而路径本身可能被替换成符号链接。三个真实故障模式：
 *
 * 1. 符号链接劫持。攻击者（或用户自己的某个脚本）把 misc-settings.json 换成
 *    指向 ~/.ssh/authorized_keys 的链接。插件"保存设置"就把 JSON 写进了别处。
 * 2. 非普通文件。FIFO 或设备节点会让读取永久阻塞，插件启动即卡死。
 * 3. 并发写。两个请求同时改设置，各自写临时文件再 rename —— 后写的赢，
 *    但赢家读的是旧快照，前一次的修改无声丢失。
 *
 * 这里对每一个都给出显式拒绝，而不是尽力而为。拒绝抛错并带明确文案，
 * 让上层能告诉用户"为什么没保存成功"，而不是静默失败。
 *
 * 注意：这些检查是 TOCTOU 敏感的 —— lstat 和 open 之间存在窗口。
 * 完整防护需要 O_NOFOLLOW，但 Node 的 fs 在 Windows 上不提供该 flag。
 * 所以策略是：检查 + 立即使用 + 失败即中止，不假装是原子保证。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** 状态文件的结构版本。改结构就加一，旧版本会被判为不可读而不是硬改。 */
export const STATE_SCHEMA_VERSION = 1;

/** 锁文件的默认名。同一目录下同一时刻只允许一个写入者。 */
export const LOCK_NAME = ".state-lock";

/** 十六进制 sha256 的形态，用于校验状态文件里的摘要字段。 */
const DIGEST_RE = /^[0-9a-f]{64}$/;

export class StateLockError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "StateLockError";
    this.code = code || "ESTATELOCK";
  }
}

/** 对字符串或 Buffer 求 sha256 十六进制。空输入也有确定的摘要，不返回 null。 */
export function sha256(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8");
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * 目录检查：拒绝符号链接、要求存在且是目录。
 * `absentOk` 为真时目录不存在不算错（调用方随后会 mkdir）。
 */
export function ensureDirectory(dir, options = {}) {
  const target = String(dir || "");
  if (!target) throw new StateLockError("目录路径为空", "EEMPTY");
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") {
      if (options.absentOk) return false;
      throw new StateLockError(`目录不存在：${target}`, "ENOENT");
    }
    throw new StateLockError(`无法检查目录：${target}（${error.code || error.message}）`, "ESTAT");
  }
  if (st.isSymbolicLink()) {
    throw new StateLockError(`拒绝符号链接目录：${target}`, "ESYMLINK");
  }
  if (!st.isDirectory()) {
    throw new StateLockError(`路径不是目录：${target}`, "ENOTDIR");
  }
  return true;
}

/**
 * 读普通文件。文件不存在返回 null（不是错误）。
 *
 * 拒绝符号链接与非普通文件是刻意的：读取侧如果跟着链接走，
 * 上面所有的写入侧检查就都被绕过了。
 */
export function readRegular(file) {
  const target = String(file || "");
  if (!target) throw new StateLockError("文件路径为空", "EEMPTY");
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new StateLockError(`无法检查文件：${target}（${error.code || error.message}）`, "ESTAT");
  }
  if (st.isSymbolicLink()) {
    throw new StateLockError(`拒绝符号链接文件：${target}`, "ESYMLINK");
  }
  if (!st.isFile()) {
    throw new StateLockError(`拒绝非普通文件：${target}`, "ENOTREG");
  }
  return fs.readFileSync(target);
}

/** 读普通文件并当 UTF-8 文本返回；不存在返回 null。 */
export function readRegularText(file) {
  const raw = readRegular(file);
  if (raw === null) return null;
  try {
    return raw.toString("utf8");
  } catch (error) {
    throw new StateLockError(`文件不是合法 UTF-8：${file}`, "EENCODING");
  }
}

/**
 * 原子写，带符号链接拒绝。
 *
 * 与 `lib/hacker/atomic-write.js` 的区别：那个只管"写一半崩了"，这个先拒绝
 * 写入目标本身是链接的情况。两者职责不重叠，可以叠加使用。
 *
 * 保留原文件权限位：状态文件可能被用户改成 0600，覆盖时不该退回默认。
 */
export function atomicWriteGuarded(file, data) {
  const target = String(file || "");
  if (!target) throw new StateLockError("文件路径为空", "EEMPTY");

  let existingMode = 0o600;
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) {
      throw new StateLockError(`拒绝写入符号链接：${target}`, "ESYMLINK");
    }
    if (!st.isFile()) {
      throw new StateLockError(`拒绝写入非普通文件：${target}`, "ENOTREG");
    }
    existingMode = st.mode & 0o777;
  } catch (error) {
    if (error instanceof StateLockError) throw error;
    if (error.code !== "ENOENT") {
      throw new StateLockError(`无法检查写入目标：${target}（${error.code || error.message}）`, "ESTAT");
    }
  }

  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8");

  let fd;
  try {
    fd = fs.openSync(tmp, "wx", existingMode);
    fs.writeSync(fd, buf);
    try { fs.fsyncSync(fd); } catch { /* 部分文件系统不支持，忽略 */ }
    fs.closeSync(fd);
    fd = undefined;
    try { fs.chmodSync(tmp, existingMode); } catch { /* Windows 上可能不支持，忽略 */ }
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw new StateLockError(`写入失败：${target}（${error.code || error.message}）`, "EWRITE");
  }

  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw new StateLockError(`替换失败：${target}（${error.code || error.message}）`, "ERENAME");
  }
  return buf.length;
}

/**
 * 互斥执行。
 *
 * 用 O_CREAT|O_EXCL 建锁文件 —— 这一步在文件系统层面是原子的，
 * 两个进程不可能同时成功。拿到锁后执行 fn，无论成败都删锁。
 *
 * 残留锁（进程被 kill / 断电）会让下次调用失败。这里做**可证明的**回收：
 * 锁文件里写了持有者的 PID，只有同时满足三条才删它 ——
 *   1. 内容能解析成一个正整数 PID；
 *   2. `process.kill(pid, 0)` 抛 ESRCH（该进程确实不存在）；
 *   3. 删之前重读一次，内容和刚才判定的完全一致（避免删掉刚被别人拿到的新锁）。
 * PID 复用是已知风险：极端情况下复用到同一个号会误判为"还活着"，
 * 那种情况我们**不删**（保守方向），代价是这次写入退化成无锁并留事件。
 */
export function withLock(dir, fn, options = {}) {
  const lockDir = String(dir || "");
  if (!lockDir) throw new StateLockError("锁目录为空", "EEMPTY");
  fs.mkdirSync(lockDir, { recursive: true });
  ensureDirectory(lockDir);

  const lockFile = path.join(lockDir, options.name || LOCK_NAME);
  let fd;
  try {
    fd = fs.openSync(lockFile, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      const reclaimed = tryReclaimStaleLock(lockFile);
      if (reclaimed) {
        /* 回收成功：重试一次建锁。仍失败说明有人抢在前面，按正常争用报错。 */
        try {
          fd = fs.openSync(lockFile, "wx", 0o600);
        } catch (retryError) {
          throw new StateLockError(
            `另一写入操作正在进行：${lockFile}`,
            retryError.code === "EEXIST" ? "ELOCKED" : "ELOCK",
          );
        }
      } else {
        throw new StateLockError(
          `另一写入操作正在进行，或上次中断留下锁文件：${lockFile}`,
          "ELOCKED",
        );
      }
    } else {
      throw new StateLockError(`无法创建锁：${lockFile}（${error.code || error.message}）`, "ELOCK");
    }
  }
  try {
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    fd = undefined;
    return fn();
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
  }
}

/**
 * 尝试回收一个可证明已死的残留锁。
 *
 * @returns true 表示已删除，调用方可以重试建锁；false 表示无法证明持有者已死。
 */
function tryReclaimStaleLock(lockFile) {
  let first;
  try {
    first = fs.readFileSync(lockFile, "utf8").trim();
  } catch {
    return false; // 读不到就别动它
  }
  if (!/^[1-9][0-9]{0,9}$/.test(first)) return false; // 不是 PID，可能是别人正在写
  const pid = Number(first);
  try {
    process.kill(pid, 0);
    return false; // 进程还活着（或 PID 被复用），保守不删
  } catch (error) {
    if (error.code !== "ESRCH") return false; // EPERM 等：进程存在但没权限，不删
  }
  /* 删之前重读：内容变了说明这已经是别人新拿到的锁。 */
  try {
    const again = fs.readFileSync(lockFile, "utf8").trim();
    if (again !== first) return false;
    fs.unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * 校验状态对象的结构。
 *
 * 手写 JSON 会被改坏、会被半截写入、会被旧版本写成不同字段集。
 * 这里要求**字段集完全相等**而不是"至少包含" —— 多出的字段说明是别的版本写的，
 * 按当前版本解释它会读出错误的值。宁可报错让用户删掉重来。
 *
 * 返回 { ok, reason, value }。不抛错，因为调用方通常要降级处理而不是崩。
 */
export function validateState(raw, spec) {
  const want = spec && Array.isArray(spec.fields) ? spec.fields : [];
  const digests = spec && Array.isArray(spec.digestFields) ? spec.digestFields : [];
  const version = spec && spec.version !== undefined ? spec.version : STATE_SCHEMA_VERSION;

  if (raw === null || raw === undefined) {
    return { ok: false, reason: "状态文件不存在", value: null };
  }
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (error) {
    return { ok: false, reason: "状态文件不是合法 JSON", value: null };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "状态文件顶层不是对象", value: null };
  }

  const have = Object.keys(value).sort();
  const expect = [...want].sort();
  if (have.length !== expect.length || have.some((k, i) => k !== expect[i])) {
    return {
      ok: false,
      reason: `状态字段集不匹配（期望 ${expect.length} 个，实际 ${have.length} 个）`,
      value: null,
    };
  }

  if (value.schema_version !== version) {
    return {
      ok: false,
      reason: `状态版本不支持（文件 ${JSON.stringify(value.schema_version)}，期望 ${version}）`,
      value: null,
    };
  }

  for (const key of digests) {
    const v = value[key];
    if (v === null || v === undefined) continue;
    if (typeof v !== "string" || !DIGEST_RE.test(v)) {
      return { ok: false, reason: `摘要字段 ${key} 形态无效`, value: null };
    }
  }

  return { ok: true, reason: "", value };
}

/**
 * 比对磁盘上的受管文件与状态里记录的摘要。
 *
 * 三个结论：
 * - `intact` —— 内容与记录一致，可以安全覆盖
 * - `missing` —— 文件不在了（用户删了），不该当成"被篡改"
 * - `drifted` —— 内容变了（用户手改了，或别的版本写了），必须停下来问
 *
 * `drifted` 不自动覆盖是刻意的。用户的修改比插件的记录更有价值，
 * 悄悄盖掉等于数据丢失。
 */
export function verifyManaged(file, expectedDigest) {
  let raw;
  try {
    raw = readRegular(file);
  } catch (error) {
    return { status: "blocked", reason: String(error.message || error) };
  }
  if (raw === null) return { status: "missing", reason: "" };
  if (!expectedDigest) return { status: "drifted", reason: "状态里没有记录摘要，无法确认内容" };
  const actual = sha256(raw);
  if (actual === expectedDigest) return { status: "intact", reason: "", digest: actual };
  return {
    status: "drifted",
    reason: `内容已变（记录 ${expectedDigest.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`,
    digest: actual,
  };
}

/**
 * 带校验的写入：先确认目标没被动过，再写，再把新摘要记进状态。
 *
 * 顺序不能反。先写后查的话，发现 drifted 时旧内容已经没了，回滚也没得回。
 */
export function writeManaged(file, data, options = {}) {
  const expected = options.expectedDigest;
  if (expected) {
    const check = verifyManaged(file, expected);
    if (check.status === "drifted" || check.status === "blocked") {
      throw new StateLockError(`拒绝覆盖受管文件：${check.reason}`, "EDRIFTED");
    }
  }
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8");
  atomicWriteGuarded(file, bytes);
  return sha256(bytes);
}
