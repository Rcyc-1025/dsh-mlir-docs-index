// 查询：加载 JSONL、评分排序、片段、歧义与过期标记。

import fs from 'node:fs'
import path from 'node:path'
import { describeStale } from './build-index.mjs'
import { fail } from './errors.mjs'

const VALID_KINDS = new Set(['op', 'dialect', 'any'])
const VALID_FIELDS = new Set(['summary', 'description', 'traits', 'interfaces', 'opName', 'any'])
const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 }

export function readJsonl(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    fail('INDEX_INCOMPLETE', `索引文件缺失或不可读：${path.basename(file)}`, {
      file,
      error: err.code || String(err),
    })
  }
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      out.push(JSON.parse(line))
    } catch (err) {
      fail('INDEX_INCOMPLETE', `索引文件第 ${i + 1} 行不是合法 JSON：${path.basename(file)}`, {
        file,
        line: i + 1,
        error: String(err.message || err).slice(0, 200),
      })
    }
  }
  return out
}

export function loadIndex(outDir) {
  const manifestPath = path.join(outDir, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      fail('INDEX_MISSING', '索引不存在（缺 manifest.json）。', { indexPath: outDir })
    }
    fail('INDEX_INCOMPLETE', 'manifest.json 损坏。', { indexPath: outDir, error: String(err.message || err).slice(0, 200) })
  }
  const ops = readJsonl(path.join(outDir, 'ops.jsonl'))
  const dialects = readJsonl(path.join(outDir, 'dialects.jsonl'))
  return { manifest, ops, dialects }
}

export function loadFileRecords(outDir) {
  return readJsonl(path.join(outDir, 'files.jsonl'))
}

function normField(field) {
  if (!field) return 'all'
  const parts = String(field)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const p of parts) {
    if (!VALID_FIELDS.has(p)) {
      fail('INVALID_ARGUMENT', `--field 含非法值：${p}`, { allowed: [...VALID_FIELDS] })
    }
  }
  if (parts.includes('any')) return 'all'
  return parts
}

function fieldEnabled(fields, name) {
  return fields === 'all' || fields.includes(name)
}

function textSnippet(linesCache, file, centerLine, before = 1, after = 1, maxChars = 400) {
  if (!file || !centerLine) return null
  let lines = linesCache.get(file)
  if (!lines) {
    try {
      lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      linesCache.set(file, lines)
    } catch {
      return null
    }
  }
  const start = Math.max(1, centerLine - before)
  const end = Math.min(lines.length, centerLine + after)
  let text = ''
  for (let i = start; i <= end; i++) text += `${lines[i - 1]}\n`
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`
  return { file, startLine: start, endLine: end, text }
}

function matchOp(op, q, fields, exact) {
  const lower = q.toLowerCase()
  const full = op.id.toLowerCase()
  const short = (op.shortName || '').toLowerCase()
  const matchedFields = []

  if (full === lower) return { score: 100, matchedFields: ['opName'] }
  if (short === lower) return { score: 95, matchedFields: ['shortName'] }
  if (exact) return null

  if (full.startsWith(lower)) return { score: 80, matchedFields: ['opName'] }
  if (short.startsWith(lower)) return { score: 75, matchedFields: ['shortName'] }

  let best = 0
  if (fieldEnabled(fields, 'summary') && op.summary && op.summary.toLowerCase().includes(lower)) {
    best = 60
    matchedFields.push('summary')
  }
  if (fieldEnabled(fields, 'traits')) {
    const hit = (op.traits || []).some((t) => t.toLowerCase().includes(lower))
    if (hit) { best = Math.max(best, 50); matchedFields.push('traits') }
  }
  if (fieldEnabled(fields, 'interfaces')) {
    const hit = (op.interfaces || []).some((t) => t.toLowerCase().includes(lower))
    if (hit) { best = Math.max(best, 50); matchedFields.push('interfaces') }
  }
  if (fieldEnabled(fields, 'description') && op.description && op.description.toLowerCase().includes(lower)) {
    best = Math.max(best, 40)
    matchedFields.push('description')
  }
  if (op.tablegenDef && op.tablegenDef.toLowerCase().includes(lower)) {
    best = Math.max(best, 20)
    matchedFields.push('tablegenDef')
  }
  return best > 0 ? { score: best, matchedFields } : null
}

function matchDialect(entry, q, exact = false) {
  const lower = q.toLowerCase()
  const name = entry.name.toLowerCase()
  if (name === lower) return { score: 100, matchedFields: ['name'] }
  if (exact) return null
  if (name.startsWith(lower)) return { score: 80, matchedFields: ['name'] }
  if (entry.summary && entry.summary.toLowerCase().includes(lower)) return { score: 60, matchedFields: ['summary'] }
  if (entry.description && entry.description.toLowerCase().includes(lower)) return { score: 40, matchedFields: ['description'] }
  return null
}

function descriptionMatchLine(op) {
  if (!op.description || !op.descFirstLine) return null
  return op.descFirstLine
}

function snippetFor(op, matchedFields, q, linesCache) {
  if (matchedFields.includes('description')) {
    const lower = q.toLowerCase()
    const text = op.description || ''
    const idx = text.toLowerCase().indexOf(lower)
    const base = op.descFirstLine || op.source?.line || 1
    const lineOffset = idx < 0 ? 0 : (text.slice(0, idx).match(/\n/g) || []).length
    return textSnippet(linesCache, op.source && op.source.file, base + lineOffset, 1, 1)
  }
  if (matchedFields.includes('summary') && op.source) {
    return textSnippet(linesCache, op.source.file, op.source.line, 1, 1)
  }
  return null
}

function presentOp(op, { allVariants = false, stale = false } = {}) {
  const out = {
    id: op.id,
    kind: 'op',
    opName: op.opName,
    shortName: op.shortName,
    dialect: op.dialect,
    tablegenDef: op.tablegenDef || null,
    cppClass: op.cppClass || null,
    summary: op.summary,
    descriptionSnippet: op.description ? op.description.replace(/\s+/g, ' ').trim().slice(0, 300) : null,
    operands: op.operands,
    results: op.results,
    attributes: op.attributes || [],
    traits: op.traits || [],
    interfaces: op.interfaces || [],
    regions: op.regions,
    variadic: op.variadic,
    source: op.source,
    generated: op.generated,
    confidence: op.confidence,
    variantCount: op.variantCount || 1,
    unresolved: op.unresolved || [],
  }
  if (allVariants) out.variants = op.variants || []
  if (stale) {
    out.stale = true
    out.staleReason = 'INDEX_STALE'
  }
  return out
}

function presentDialect(d, { stale = false } = {}) {
  const out = {
    id: d.id,
    kind: 'dialect',
    name: d.name,
    cppNamespace: d.cppNamespace,
    summary: d.summary,
    descriptionSnippet: d.description ? d.description.replace(/\s+/g, ' ').trim().slice(0, 300) : null,
    source: d.source,
    opCount: d.opCount || 0,
    opNames: (d.opNames || []).slice(0, 50),
  }
  if (d.opNamesTruncated) out.opNamesTruncated = true
  if (stale) {
    out.stale = true
    out.staleReason = 'INDEX_STALE'
  }
  return out
}

export function runQuery({ outDir, opts }) {
  const q = opts.q == null ? null : String(opts.q)
  if (q !== null) {
    if (q.trim().length === 0 || q.length > 200) {
      fail('INVALID_QUERY', '查询词为空或超过 200 字符。', { length: q.length })
    }
  }
  const dialect = opts.dialect ? String(opts.dialect) : null
  if ((q === null || q.trim() === '') && !dialect) {
    fail('INVALID_QUERY', '至少需要 --q 或 --dialect。', {})
  }

  const kind = opts.kind || 'any'
  if (!VALID_KINDS.has(kind)) {
    fail('INVALID_ARGUMENT', `--kind 非法：${kind}`, { allowed: [...VALID_KINDS] })
  }
  const limit = opts.limit == null ? 10 : Number(opts.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    fail('INVALID_ARGUMENT', `--limit 必须是 1–50 的整数（收到 ${opts.limit}）。`, { limit: opts.limit })
  }
  const fields = normField(opts.field)
  const exact = Boolean(opts.exact)
  const allVariants = Boolean(opts.allVariants)

  const { manifest, ops, dialects } = loadIndex(outDir)
  const warnings = []
  let stale = false
  try {
    const records = loadFileRecords(outDir)
    const status = describeStale(records, { deep: false })
    stale = status.stale
    if (stale) {
      warnings.push({
        code: 'INDEX_STALE',
        message: `索引已过期（${status.staleCount} 个文件 size/mtime 变化，列出前 ${status.staleFiles.length} 个）。`,
        details: { staleFiles: status.staleFiles },
      })
    }
  } catch {
    warnings.push({ code: 'INDEX_STALE', message: '无法校验索引新鲜度（files.jsonl 不可读）。', details: {} })
  }

  const scored = []
  if (kind === 'op' || kind === 'any') {
    for (const op of ops) {
      if (dialect && op.dialect !== dialect) continue
      if (q === null) {
        scored.push({ entry: op, kind: 'op', score: 0, matchedFields: ['dialect'] })
        continue
      }
      const m = matchOp(op, q, fields, exact)
      if (!m) continue
      scored.push({ entry: op, kind: 'op', score: m.score + (dialect ? 5 : 0), matchedFields: m.matchedFields })
    }
  }
  if (kind === 'dialect' || kind === 'any') {
    for (const d of dialects) {
      if (dialect && d.name !== dialect) continue
      if (q === null) {
        scored.push({ entry: d, kind: 'dialect', score: 0, matchedFields: ['dialect'] })
        continue
      }
      const m = matchDialect(d, q, exact)
      if (!m) continue
      scored.push({ entry: d, kind: 'dialect', score: m.score, matchedFields: m.matchedFields })
    }
  }

  const linesCache = new Map()
  for (const s of scored) {
    s.entry.__matchedFields = s.matchedFields
    s.entry.__score = s.score
    s.entry.__snippet = s.kind === 'op' ? snippetFor(s.entry, s.matchedFields, q || '', linesCache) : null
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const ca = CONFIDENCE_RANK[a.entry.confidence || 'medium'] || 2
    const cb = CONFIDENCE_RANK[b.entry.confidence || 'medium'] || 2
    if (ca !== cb) return cb - ca
    const ra = a.entry.source ? (a.entry.source.file.toLowerCase().includes('llvm-build') ? 1 : 0) : 1
    const rb = b.entry.source ? (b.entry.source.file.toLowerCase().includes('llvm-build') ? 1 : 0) : 1
    if (ra !== rb) return ra - rb
    const fa = (a.entry.source && a.entry.source.file) || ''
    const fb = (b.entry.source && b.entry.source.file) || ''
    if (fa !== fb) return fa.localeCompare(fb)
    const la = (a.entry.source && a.entry.source.line) || 0
    const lb = (b.entry.source && b.entry.source.line) || 0
    return la - lb
  })

  const total = scored.length
  const topScore = total ? scored[0].score : 0
  let status = total === 0 ? 'no-match' : 'ok'
  if (status === 'ok' && q && !q.includes('.')) {
    const shortExact = scored.filter((s) => s.score - (dialect ? 5 : 0) === 95)
    if (shortExact.length > 1) status = 'ambiguous'
  }

  const sliced = scored.slice(0, limit)
  const results = sliced.map((s) => {
    const base = s.kind === 'op'
      ? presentOp(s.entry, { allVariants, stale })
      : presentDialect(s.entry, { stale })
    base.score = s.score
    base.matchedFields = s.matchedFields
    if (s.entry.__snippet) base.snippet = s.entry.__snippet
    return base
  })

  let hint = null
  if (status === 'no-match') {
    hint = '未命中。建议：① 换短名（--q addi）；② 加 --dialect arith；③ 放宽字段（--field summary,description）。'
  } else if (status === 'ambiguous') {
    hint = `短名在多个 dialect 命中（最高分 ${topScore}）；请用全名（--q <dialect>.<name>）或加 --dialect。`
  } else if (total > results.length) {
    hint = `结果 ${total} 条，已截断为 ${results.length} 条；缩小范围或提高 --limit（≤50）。`
  } else if (stale) {
    hint = '索引已过期：先运行 refresh 再采信行号。'
  }

  const response = {
    ok: true,
    status,
    query: {
      q: q === null ? null : q,
      kind,
      exact,
      dialect,
      limit,
      field: fields === 'all' ? 'all' : fields.join(','),
      allVariants,
    },
    index: {
      versionLabel: manifest.versionLabel,
      builtAt: manifest.builtAt,
      fingerprint: manifest.fingerprint,
      stale,
    },
    total,
    returned: results.length,
    truncated: total > results.length,
    results,
    warnings,
    hint,
  }
  return response
}

export function formatText(response) {
  const lines = []
  lines.push(`status: ${response.status}  total: ${response.total}  returned: ${response.returned}${response.truncated ? ' (truncated)' : ''}`)
  if (response.index) lines.push(`index: ${response.index.versionLabel} built ${response.index.builtAt}${response.index.stale ? ' (STALE)' : ''}`)
  for (const r of response.results) {
    if (r.kind === 'op') {
      lines.push('')
      lines.push(`[op] ${r.id}  (confidence: ${r.confidence}${r.variantCount > 1 ? `, variants: ${r.variantCount}` : ''})`)
      if (r.source) lines.push(`  source: ${r.source.file}:${r.source.line}`)
      if (r.generated) lines.push(`  generated: ${r.generated.file}:${r.generated.classLine} (getOperationName: ${r.generated.operationNameLine})`)
      if (r.cppClass) lines.push(`  cppClass: ${r.cppClass}`)
      if (r.tablegenDef) lines.push(`  tablegenDef: ${r.tablegenDef}`)
      if (r.summary) lines.push(`  summary: ${r.summary}`)
      if (Array.isArray(r.operands)) {
        lines.push(`  operands: ${r.operands.length ? r.operands.map((o) => `${o.name}: ${o.type}${o.variadic ? ' (variadic)' : ''}`).join(', ') : '(none)'}`)
      } else {
        lines.push('  operands: (unresolved)')
      }
      if (Array.isArray(r.results)) {
        lines.push(`  results: ${r.results.length ? r.results.map((o) => `${o.name}: ${o.type}`).join(', ') : '(none)'}`)
      }
      if (r.traits && r.traits.length) lines.push(`  traits: ${r.traits.join(', ')}`)
      if (r.unresolved && r.unresolved.length) lines.push(`  unresolved: ${r.unresolved.join(', ')}`)
    } else {
      lines.push('')
      lines.push(`[dialect] ${r.name}${r.cppNamespace ? `  (${r.cppNamespace})` : ''}`)
      if (r.source) lines.push(`  source: ${r.source.file}:${r.source.line}`)
      if (r.summary) lines.push(`  summary: ${r.summary}`)
      lines.push(`  ops: ${r.opCount}`)
    }
  }
  if (response.hint) lines.push('', `hint: ${response.hint}`)
  if (response.warnings && response.warnings.length) {
    lines.push('', 'warnings:')
    for (const w of response.warnings) lines.push(`  - ${w.code}: ${w.message}`)
  }
  return lines.join('\n')
}
