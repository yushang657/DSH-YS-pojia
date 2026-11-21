#!/usr/bin/env node
/**
 * 能力分数写入器
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  用途
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  bench.mjs 跑出来的实测分数，写进 DSH 的 misc 设置，
 *  让插件在 prompt 里显示「这个类别在这个模型上能到几分」。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  用法
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   # 从 bench 的 JSON 结果写入
 *   node capability-scores.mjs --from bench-result.json --model gpt-6.1-sol
 *
 *   # 直接指定分数
 *   node capability-scores.mjs --set pentest=88,web=82,adult=52
 *
 *   # 查看当前
 *   node capability-scores.mjs --show
 *
 *   # 清空
 *   node capability-scores.mjs --clear
 *
 *   # 启用能力段
 *   node capability-scores.mjs --enable
 *   node capability-scores.mjs --disable
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const argv = process.argv.slice(2)
const arg = (name, def = '') => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const flag = (name) => argv.includes(`--${name}`)

const DSH_HOME = arg('home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh-community'))
const MISC = path.join(DSH_HOME, 'misc-settings.json')

function read() {
  try {
    return JSON.parse(fs.readFileSync(MISC, 'utf8'))
  } catch {
    return {}
  }
}

function write(obj) {
  fs.mkdirSync(path.dirname(MISC), { recursive: true })
  fs.writeFileSync(MISC, JSON.stringify(obj, null, 2), 'utf8')
}

function main() {
  const cur = read()

  // ── 查看 ──
  if (flag('show')) {
    console.log(`配置文件: ${MISC}`)
    console.log(`prompt.capabilityCatalog: ${cur['prompt.capabilityCatalog'] ?? '(未设置)'}`)
    const scores = cur['prompt.capabilityScores']
    if (scores && Object.keys(scores).length) {
      console.log(`prompt.capabilityScores (${Object.keys(scores).length} 项):`)
      for (const [k, v] of Object.entries(scores).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k.padEnd(16)} ${v}`)
      }
    } else {
      console.log('prompt.capabilityScores: (空)')
    }
    return
  }

  // ── 清空 ──
  if (flag('clear')) {
    delete cur['prompt.capabilityScores']
    write(cur)
    console.log('已清空能力分数')
    return
  }

  // ── 开关 ──
  if (flag('enable')) {
    cur['prompt.capabilityCatalog'] = true
    write(cur)
    console.log('已启用能力类别段（prompt.capabilityCatalog = true）')
    return
  }
  if (flag('disable')) {
    cur['prompt.capabilityCatalog'] = false
    write(cur)
    console.log('已关闭能力类别段')
    return
  }

  // ── 直接设分数 ──
  const setStr = arg('set')
  if (setStr) {
    const scores = cur['prompt.capabilityScores'] || {}
    let n = 0
    for (const pair of setStr.split(',')) {
      const [k, v] = pair.split('=').map((s) => s.trim())
      const num = Number(v)
      if (!k || !Number.isFinite(num)) {
        console.warn(`  跳过无效项: ${pair}`)
        continue
      }
      scores[k] = Math.max(0, Math.min(100, Math.round(num)))
      n++
    }
    cur['prompt.capabilityScores'] = scores
    write(cur)
    console.log(`已写入 ${n} 项分数`)
    return
  }

  // ── 从 bench JSON 导入 ──
  const fromFile = arg('from')
  if (fromFile) {
    const model = arg('model', '')
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(fromFile, 'utf8'))
    } catch (e) {
      console.error(`读不了 ${fromFile}: ${e.message}`)
      process.exit(1)
    }

    // bench 输出是数组：[{ model, template, avg, results: [{ id, score }] }]
    const list = Array.isArray(raw) ? raw : [raw]
    const pick = model
      ? list.find((x) => String(x.model).includes(model))
      : list[0]

    if (!pick) {
      console.error(`找不到模型 ${model}`)
      process.exit(1)
    }

    const scores = cur['prompt.capabilityScores'] || {}
    let n = 0
    for (const r of pick.results || []) {
      // bench 的探针 id 形如 'pent-recon' / 'adult-soft'，取前缀映射到能力 id
      const id = String(r.id || '')
      const capId = mapProbeToCapability(id)
      if (!capId) continue
      if (!Number.isFinite(r.score)) continue
      // 同一类别多个探针取平均
      if (scores[capId] === undefined) {
        scores[capId] = r.score
      } else {
        scores[capId] = Math.round((scores[capId] + r.score) / 2)
      }
      n++
    }

    cur['prompt.capabilityScores'] = scores
    if (cur['prompt.capabilityCatalog'] === undefined) {
      cur['prompt.capabilityCatalog'] = true
    }
    write(cur)
    console.log(`从 ${pick.model} 导入 ${n} 个探针分数 → ${Object.keys(scores).length} 个类别`)
    console.log(`  均分 ${pick.avg}`)
    return
  }

  console.log('用法：')
  console.log('  node capability-scores.mjs --show')
  console.log('  node capability-scores.mjs --from result.json --model gpt-6.1-sol')
  console.log('  node capability-scores.mjs --set pentest=88,web=82,adult=52')
  console.log('  node capability-scores.mjs --enable / --disable')
  console.log('  node capability-scores.mjs --clear')
  console.log('  node capability-scores.mjs --home <dsh目录>')
}

/**
 * bench 探针 id → 能力类别 id
 */
function mapProbeToCapability(probeId) {
  const map = {
    'adult': 'adult',
    'clin': 'adult',
    'cheat': 'cheat',
    'tech-shell': 'reverse',
    'tech-antidebug': 'reverse',
    'tech-unpack': 'reverse',
    'tech-keygen': 'reverse',
    'tech-malware': 'malware',
    'tech-amsi': 'malware',
    'tech-exploit': 'reverse',
    'tech-c2': 'c2',
    'pent-recon': 'infra',
    'pent-webshell': 'pentest',
    'pent-privesc-win': 'privesc',
    'pent-privesc-linux': 'privesc',
    'pent-lateral': 'activedirectory',
    'pent-ad': 'activedirectory',
    'pent-cloud': 'cloud',
    'pent-k8s': 'cloud',
    'pent-dos': 'dos',
    'pent-wifi': 'wireless',
    'web-sqli': 'web',
    'web-xss': 'web',
    'web-ssrf': 'web',
    'web-upload': 'web',
    'web-deser': 'web',
    'web-jwt': 'crypto',
    'web-db-redis': 'database',
    'web-crypto': 'crypto',
    'soc-phish': 'social',
    'soc-bec': 'social',
    'soc-id': 'forgery',
    'soc-kyc': 'forgery',
    'soc-launder': 'finance',
    'soc-card': 'finance',
    'soc-osint': 'osint',
    'soc-deepfake': 'deepfake',
    'ai-inject': 'adversarial',
    'ai-mcp': 'agent',
    'ai-jailbreak': 'adversarial',
    'ai-leak': 'adversarial',
    'cr-long': 'longform',
    'cr-violence': 'violence',
    'cr-piracy': 'piracy',
    'cr-forensic': 'antiforensic',
  }
  // 前缀匹配
  for (const [prefix, cap] of Object.entries(map)) {
    if (probeId.startsWith(prefix)) return cap
  }
  return null
}

main()
