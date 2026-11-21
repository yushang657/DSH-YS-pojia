/**
 * finding-gate —— 结论闸门（反虚报）
 *
 * 问题：
 *   子智能体说「我扫到了 10.0.3.7 的 SSH 弱口令」，指挥智能体把它写进报告。
 *   但「说」和「做到」是两件事。破甲的提示词层要求「结论先行 + 紧跟证据」，
 *   可那是**自我约束**——模型可以自己编一条证据然后自洽地引用它。
 *
 *   本模块把这条约束变成**可执行闸门**：写结论时必须过七道检查，
 *   任何一道不过就拒绝落库，并说明哪道不过、缺什么。
 *
 * 语义来源：
 *   上游参考实现的 `scripts/checks/finding-gate.check.mjs`（七条断言）
 *   + 本仓 `evidence-ledger.mjs` 的 confidence/authority 阶梯。
 *   上游用独立文件做证据链；本仓账本本身带语义哈希，所以篡改检测
 *   可以**重算 ev_id** 而不是另存一份文件哈希——这是本仓更强的部分。
 *
 * 七道闸门：
 *   G1 authority   引用的证据不能全是自述（subagent-report / operator-input 不算证据）
 *   G2 trace       会话轨迹里必须有真实工具调用，且覆盖被引用的 operation
 *   G3 hash        finding 正文里出现的 64 位哈希必须逐字来自被引证据
 *   G4 negative    阴性对照必须引用与被验证证据不同的独立证据
 *   G5 chain       证据链的 supporting_ev_ids 必须能走通（无悬挂引用）
 *   G6 tamper      被引证据重算 ev_id 必须与原 id 一致（内容未被改）
 *   G7 severity    置信度低于阈值时不许标 critical/high
 *
 * 零依赖。不 open/close 数据库，接受已打开的 EvidenceLedger 实例。
 */

import { evidenceId } from './evidence-ledger.mjs'

/** 七道闸门 id，顺序即报告顺序。 */
export const FINDING_GATES = Object.freeze([
  'G1_authority',
  'G2_trace',
  'G3_hash',
  'G4_negative',
  'G5_chain',
  'G6_tamper',
  'G7_severity',
])

/**
 * 不算「证据」的 authority：这些是「某个人说的」，不是「工具看到的」。
 * 注意 `screenshot` / `request-replay` 算证据 —— 它们有可复核的原始件。
 */
export const SELF_AUTHORED_AUTHORITY = Object.freeze(['subagent-report', 'operator-input'])

/** 算作硬证据的 authority。 */
export const HARD_AUTHORITY = Object.freeze(['tool-output', 'database-record', 'screenshot', 'request-replay'])

/** 置信度从低到高的数值化，用于 G7 比较。 */
const CONFIDENCE_RANK = { claimed: 0, inferred: 1, derived: 2, observed: 3 }

/** 允许标 high/critical 的最低置信度。 */
export const SEVERITY_MIN_CONFIDENCE = Object.freeze({ critical: 'observed', high: 'derived' })

const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 }

/** 闸门默认开关。settings 里同名键可覆盖。 */
export const GATE_DEFAULTS = Object.freeze({
  requireToolEvidence: true,
  requireDocRead: true,
  requireHashCitation: true,
  requireNegativeControl: true,
  requireChainIntegrity: true,
  requireTamperCheck: true,
  requireSeverityConfidence: true,
})

/* ── 内部工具 ─────────────────────────────────────────────────────────── */

/** 从任意值里抽出全部 64 位小写 hex 串（= SHA-256）。 */
function extractHashes(value) {
  const out = new Set()
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const re = /[0-9a-f]{64}/gi
  let m
  while ((m = re.exec(text)) !== null) out.add(m[0].toLowerCase())
  return out
}

/** 把一条证据行拍平成可搜索文本，用于 G3 逐字核对。 */
function evidenceText(row) {
  if (!row) return ''
  return JSON.stringify({
    operation: row.operation,
    parameters: row.parameters,
    result: row.result,
    limitations: row.limitations,
  }) ?? ''
}

/**
 * 重算一条证据的 ev_id。
 * 与 EvidenceLedger.record 里构造 semantic 的方式必须逐字段一致，
 * 否则重算出来的 id 永远对不上，G6 会全量误报。
 */
export function recomputeEvidenceId(row) {
  if (!row || !row.operation) return null
  const { sanitizeForHash } = ledgerInternals
  return evidenceId({
    operation: row.operation,
    parameters: sanitizeForHash(row.parameters ?? {}),
    result: sanitizeForHash(row.result ?? null),
    confidence: row.confidence,
    authority: row.authority,
    limitations: row.limitations ?? [],
    supporting_ev_ids: [...(row.supporting_ev_ids ?? [])].sort(),
  })
}

/**
 * evidence-ledger.mjs 没导出 sanitizeForHash，但重算哈希必须用它。
 * 这里复刻同一份实现（逐行等价），并在下方 verify 脚本里用真实账本对拍验证等价性。
 */
const ledgerInternals = {
  sanitizeForHash(value) {
    if (value === undefined) return null
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'function') return '[function]'
    if (typeof value === 'symbol') return '[symbol]'
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(ledgerInternals.sanitizeForHash)
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = ledgerInternals.sanitizeForHash(v)
    return out
  },
}

function gateResult(id, ok, detail, missing) {
  const r = { id, ok, detail }
  if (!ok && missing) r.missing = missing
  return r
}

/* ── 七道闸门 ─────────────────────────────────────────────────────────── */

/** G1：引用的证据不能全是自述。 */
function checkAuthority(cited, settings) {
  if (!settings.requireToolEvidence) {
    return gateResult('G1_authority', true, '已关闭（requireToolEvidence=false）')
  }
  if (cited.length === 0) {
    return gateResult('G1_authority', false, '没有引用任何证据', 'evidence_ids 为空')
  }
  const hard = cited.filter((r) => HARD_AUTHORITY.includes(r.authority))
  if (hard.length > 0) {
    return gateResult('G1_authority', true, `${hard.length}/${cited.length} 条为硬证据（${[...new Set(hard.map((r) => r.authority))].join(',')}）`)
  }
  const authorities = [...new Set(cited.map((r) => r.authority))]
  return gateResult(
    'G1_authority',
    false,
    `被引证据全部是自述（${authorities.join(',')}），没有任何工具产出`,
    '至少一条 authority ∈ ' + HARD_AUTHORITY.join('|'),
  )
}

/** G2：会话轨迹里必须有真实工具调用，且覆盖被引用的 operation。 */
function checkTrace(cited, trace, settings) {
  if (!settings.requireDocRead) {
    return gateResult('G2_trace', true, '已关闭（requireDocRead=false）')
  }
  const calls = Array.isArray(trace) ? trace : []
  const names = new Set()
  for (const c of calls) {
    const n = c?.name ?? c?.tool ?? c?.data?.name
    if (typeof n === 'string' && n) names.add(n)
  }
  if (names.size === 0) {
    return gateResult('G2_trace', false, '会话轨迹里没有任何工具调用', '至少一次 tool/call')
  }
  const ops = [...new Set(cited.map((r) => r.operation).filter(Boolean))]
  const covered = ops.filter((op) => names.has(op))
  if (ops.length > 0 && covered.length === 0) {
    return gateResult(
      'G2_trace',
      false,
      `被引证据的 operation（${ops.join(',')}）在轨迹里都没有对应调用；轨迹里有：${[...names].slice(0, 8).join(',')}`,
      `轨迹中需出现 ${ops.join(' 或 ')}`,
    )
  }
  return gateResult('G2_trace', true, `${covered.length}/${ops.length} 个 operation 在轨迹中有对应调用`)
}

/** G3：finding 正文里的哈希必须逐字来自被引证据。 */
function checkHashCitation(finding, cited, settings) {
  if (!settings.requireHashCitation) {
    return gateResult('G3_hash', true, '已关闭（requireHashCitation=false）')
  }
  const claimed = extractHashes(`${finding.title ?? ''} ${finding.detail ?? ''} ${finding.repro_cmd ?? ''}`)
  if (claimed.size === 0) {
    return gateResult('G3_hash', true, '正文未声明哈希，无需核对')
  }
  const available = new Set()
  for (const row of cited) {
    for (const h of extractHashes(evidenceText(row))) available.add(h)
    // ev_id 本身也是 sha256，允许直接引用
    if (typeof row.ev_id === 'string') {
      const bare = row.ev_id.replace(/^ev_/, '')
      if (/^[0-9a-f]{64}$/.test(bare)) available.add(bare)
    }
  }
  const bad = [...claimed].filter((h) => !available.has(h))
  if (bad.length === 0) {
    return gateResult('G3_hash', true, `${claimed.size} 个哈希全部逐字来自被引证据`)
  }
  return gateResult(
    'G3_hash',
    false,
    `${bad.length}/${claimed.size} 个哈希在被引证据里找不到：${bad.map((h) => h.slice(0, 12) + '…').join(',')}`,
    '删掉编造的哈希，或改为引用真实证据',
  )
}

/** G4：阴性对照必须是独立证据。 */
function checkNegative(finding, settings) {
  if (!settings.requireNegativeControl) {
    return gateResult('G4_negative', true, '已关闭（requireNegativeControl=false）')
  }
  const negIds = Array.isArray(finding.negative_evidence_ids) ? finding.negative_evidence_ids : []
  if (negIds.length === 0) {
    return gateResult('G4_negative', true, '未声明阴性对照，跳过')
  }
  const posIds = new Set(Array.isArray(finding.evidence_ids) ? finding.evidence_ids : [])
  const overlap = negIds.filter((id) => posIds.has(id))
  if (overlap.length > 0) {
    return gateResult(
      'G4_negative',
      false,
      `阴性对照复用了被验证证据：${overlap.join(',')}`,
      '阴性对照必须引用另一条独立证据',
    )
  }
  const dup = negIds.filter((id, i) => negIds.indexOf(id) !== i)
  if (dup.length > 0) {
    return gateResult('G4_negative', false, `阴性对照内部重复引用：${[...new Set(dup)].join(',')}`, '每条对照只引用一次')
  }
  if (negIds.length > 1) {
    return gateResult('G4_negative', true, `${negIds.length} 条独立阴性对照`)
  }
  return gateResult('G4_negative', true, `1 条独立阴性对照（${negIds[0]}）`)
}

/** G5：证据链的 supporting_ev_ids 必须能走通。 */
function checkChain(cited, ledger, settings) {
  if (!settings.requireChainIntegrity) {
    return gateResult('G5_chain', true, '已关闭（requireChainIntegrity=false）')
  }
  const dangling = []
  let edges = 0
  for (const row of cited) {
    for (const up of row.supporting_ev_ids ?? []) {
      edges++
      if (!ledger.get(up)) dangling.push(`${row.ev_id}→${up}`)
    }
  }
  if (dangling.length > 0) {
    return gateResult(
      'G5_chain',
      false,
      `${dangling.length}/${edges} 条链引用指向账本里不存在的证据：${dangling.slice(0, 3).join(', ')}`,
      '悬挂引用必须补录上游证据或删掉该引用',
    )
  }
  return gateResult('G5_chain', true, edges === 0 ? '无上游引用' : `${edges} 条上游引用全部可达`)
}

/** G6：被引证据重算 ev_id 必须与原 id 一致。 */
function checkTamper(cited, settings) {
  if (!settings.requireTamperCheck) {
    return gateResult('G6_tamper', true, '已关闭（requireTamperCheck=false）')
  }
  const bad = []
  for (const row of cited) {
    const recomputed = recomputeEvidenceId(row)
    if (recomputed && recomputed !== row.ev_id) bad.push(row.ev_id)
  }
  if (bad.length > 0) {
    return gateResult(
      'G6_tamper',
      false,
      `${bad.length} 条证据内容与语义哈希不符（已被改动）：${bad.map((x) => x.slice(0, 12) + '…').join(',')}`,
      '这些证据必须重新采集，不能引用',
    )
  }
  return gateResult('G6_tamper', true, `${cited.length} 条证据哈希自洽`)
}

/** G7：置信度低于阈值时不许标高危。 */
function checkSeverity(finding, cited, settings) {
  if (!settings.requireSeverityConfidence) {
    return gateResult('G7_severity', true, '已关闭（requireSeverityConfidence=false）')
  }
  const sev = String(finding.severity ?? 'medium').toLowerCase()
  const need = SEVERITY_MIN_CONFIDENCE[sev]
  if (!need) {
    return gateResult('G7_severity', true, `severity=${sev} 无置信度门槛`)
  }
  const needRank = CONFIDENCE_RANK[need]
  const best = cited.reduce((acc, r) => Math.max(acc, CONFIDENCE_RANK[r.confidence] ?? -1), -1)
  if (best < needRank) {
    const got = Object.keys(CONFIDENCE_RANK).find((k) => CONFIDENCE_RANK[k] === best) ?? '(无)'
    return gateResult(
      'G7_severity',
      false,
      `severity=${sev} 要求至少 ${need} 级证据，实际最高只有 ${got}`,
      `补一条 ${need} 级证据，或把 severity 降到 ${Object.keys(SEVERITY_RANK).find((k) => SEVERITY_RANK[k] <= Math.max(0, best)) ?? 'info'}`,
    )
  }
  return gateResult('G7_severity', true, `severity=${sev} 与最高置信度匹配`)
}

/* ── 主入口 ───────────────────────────────────────────────────────────── */

/**
 * 给一条待落库的结论过闸。
 *
 * @param {object} input
 * @param {import('./evidence-ledger.mjs').EvidenceLedger} input.ledger
 * @param {object} input.finding
 * @param {string}   input.finding.title
 * @param {string}   [input.finding.detail]
 * @param {string[]} input.finding.evidence_ids
 * @param {string[]} [input.finding.negative_evidence_ids]
 * @param {string}   [input.finding.severity] 'info'|'low'|'medium'|'high'|'critical'
 * @param {string}   [input.finding.repro_cmd]
 * @param {Array}    [input.trace] 会话轨迹，元素形如 {type:'tool/call', name:'nmap_scan'}
 * @param {object}   [input.settings] 覆盖 GATE_DEFAULTS
 * @returns {{
 *   ok: boolean,
 *   gates: Array<{id:string, ok:boolean, detail:string, missing?:string}>,
 *   failedKeys: string[],
 *   cited: string[],
 *   missingEvidence: string[],
 *   finding: object
 * }}
 */
export function gateFinding(input) {
  const { ledger, finding = {}, trace = [], settings = {} } = input ?? {}
  const cfg = { ...GATE_DEFAULTS, ...settings }

  const ids = Array.isArray(finding.evidence_ids) ? [...new Set(finding.evidence_ids)] : []

  // 解析被引证据；不存在的记进 missingEvidence，由 G1 兜住
  const cited = []
  const missingEvidence = []
  for (const id of ids) {
    const row = ledger && typeof ledger.get === 'function' ? ledger.get(id) : undefined
    if (row) cited.push(row)
    else missingEvidence.push(id)
  }

  const gates = []
  // 引用了不存在的证据 → G1 直接失败，避免后续闸门在空集上给出「通过」的假象
  if (missingEvidence.length > 0) {
    gates.push(gateResult(
      'G1_authority',
      false,
      `${missingEvidence.length} 条被引证据在账本里不存在：${missingEvidence.join(',')}`,
      '先 record 这些证据，或删掉引用',
    ))
  } else {
    gates.push(checkAuthority(cited, cfg))
  }
  gates.push(checkTrace(cited, trace, cfg))
  gates.push(checkHashCitation(finding, cited, cfg))
  gates.push(checkNegative(finding, cfg))
  gates.push(checkChain(cited, ledger, cfg))
  gates.push(checkTamper(cited, cfg))
  gates.push(checkSeverity(finding, cited, cfg))

  const failed = gates.filter((g) => !g.ok)
  return {
    ok: failed.length === 0,
    gates,
    failedKeys: failed.map((g) => g.id),
    cited: cited.map((r) => r.ev_id),
    missingEvidence,
    finding,
  }
}

/**
 * 把闸门结果压成给人看的一段话（拒绝时直接返回给调用方当工具回显）。
 * 通过时返回 `finding recorded: <id>` 形状，由调用方填 id。
 */
export function describeGate(result) {
  if (!result) return 'gate: no-result'
  if (result.ok) {
    return `闸门通过（7/7）· 引用 ${result.cited.length} 条证据`
  }
  const lines = [`REJECTED —— ${result.failedKeys.join(' + ')} 未通过`]
  for (const g of result.gates) {
    if (g.ok) continue
    lines.push(`  ✗ ${g.id}: ${g.detail}`)
    if (g.missing) lines.push(`    需要：${g.missing}`)
  }
  return lines.join('\n')
}
