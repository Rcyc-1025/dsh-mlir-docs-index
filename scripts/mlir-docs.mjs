#!/usr/bin/env node
// CLI 入口：build / status / refresh / query。所有命令输出一个 JSON 对象（--format text 时输出人读文本）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MlirDocsError, toErrorResponse, fail } from './lib/errors.mjs'
import { defaultGeneratedRoot, defaultSourceRoot, detectVersionLabel, resolveRoots, scanCorpus, toPosix } from './lib/scan.mjs'
import { buildIndex, describeStale, resolveOutDir } from './lib/build-index.mjs'
import { formatText, loadFileRecords, runQuery } from './lib/query.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = path.resolve(HERE, '..')

const USAGE = `mlir-docs-index — 离线检索本地 LLVM/MLIR 23.1.4 的 op/dialect 定义

用法：
  node scripts/mlir-docs.mjs build   [--source-root DIR] [--examples-root DIR] [--generated-root DIR] [--out index] [--force] [--hash content|meta] [--format json|text]
  node scripts/mlir-docs.mjs status  [--out index] [--deep] [--format json|text]
  node scripts/mlir-docs.mjs refresh [--out index] [--format json|text]
  node scripts/mlir-docs.mjs query   --q NAME [--kind op|dialect|any] [--dialect NAME] [--field all|summary,description,...] [--exact] [--all-variants] [--limit 1-50] [--format json|text]

示例：
  node scripts/mlir-docs.mjs build --source-root "D:/Code/llvm-src/llvm-project-23.1.4.src/mlir/include/mlir" \\
    --examples-root "D:/Code/llvm-src/llvm-project-23.1.4.src/mlir/examples" \\
    --generated-root "D:/Code/llvm-build/tools/mlir/include/mlir"
  node scripts/mlir-docs.mjs query --q arith.addi --kind op --exact
  node scripts/mlir-docs.mjs query --q arith --kind dialect

约定：索引默认写到 <skill>/index/；--out 必须在 skill 目录内。退出码：成功/无结果 0，致命/参数错误 2。
`

const BOOL_FLAGS = new Set(['force', 'exact', 'all-variants', 'deep', 'debug', 'help'])
const ALLOWED = {
  build: new Set(['source-root', 'examples-root', 'generated-root', 'out', 'force', 'hash', 'format', 'debug', 'help']),
  status: new Set(['out', 'deep', 'format', 'debug', 'help']),
  refresh: new Set(['out', 'format', 'debug', 'help']),
  query: new Set(['q', 'kind', 'dialect', 'field', 'exact', 'all-variants', 'limit', 'out', 'format', 'debug', 'help']),
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help'
  const rest = command === 'help' ? argv : argv.slice(1)
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (!token.startsWith('--')) {
      fail('INVALID_ARGUMENT', `无法识别的参数：${token}`, { token }, '参数要以 -- 开头；用 --help 查看用法。')
    }
    let name = token.slice(2)
    let value = true
    const eq = name.indexOf('=')
    if (eq >= 0) {
      value = name.slice(eq + 1)
      name = name.slice(0, eq)
    } else if (!BOOL_FLAGS.has(name) && rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) {
      value = rest[i + 1]
      i++
    }
    if (name in flags) {
      fail('INVALID_ARGUMENT', `参数重复：--${name}`, { flag: name }, '每个参数只给一次。')
    }
    flags[name] = value
  }
  return { command, flags }
}

function checkFlags(command, flags) {
  const allowed = ALLOWED[command]
  if (!allowed) {
    fail('INVALID_ARGUMENT', `未知命令：${command}`, { command, allowed: Object.keys(ALLOWED) }, '可用命令：build / status / refresh / query。')
  }
  for (const name of Object.keys(flags)) {
    if (!allowed.has(name)) {
      fail('INVALID_ARGUMENT', `命令 ${command} 不支持参数 --${name}`, { flag: name, allowed: [...allowed] }, '用 --help 查看每个命令的参数。')
    }
  }
}

function asBool(v) {
  if (v === true) return true
  if (v === 'false' || v === '0') return false
  return Boolean(v)
}

function formatOf(flags) {
  const f = flags.format || 'json'
  if (f !== 'json' && f !== 'text') fail('INVALID_ARGUMENT', `--format 只能是 json 或 text（收到 ${f}）。`, { format: f })
  return f
}

function indexVerdict(outDir, { deep = false } = {}) {
  const manifestPath = path.join(outDir, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    if (err && err.code === 'ENOENT') fail('INDEX_MISSING', '索引不存在（缺 manifest.json）。', { indexPath: outDir })
    fail('INDEX_INCOMPLETE', 'manifest.json 损坏。', { indexPath: outDir, error: String(err.message || err).slice(0, 200) })
  }
  const records = loadFileRecords(outDir)
  const status = describeStale(records, { deep })
  const warnings = []
  if (status.stale) {
    warnings.push({
      code: 'INDEX_STALE',
      message: `索引已过期（${status.staleCount} 个文件 size/mtime 变化）。`,
      details: { staleFiles: status.staleFiles },
    })
  }
  return { manifest, records, status, warnings }
}

function statusCommand({ outDir, deep }) {
  const { manifest, status, warnings } = indexVerdict(outDir, { deep })
  let indexBytes = 0
  for (const name of ['manifest.json', 'ops.jsonl', 'dialects.jsonl', 'files.jsonl', 'stats.json']) {
    try { indexBytes += fs.statSync(path.join(outDir, name)).size } catch { /* ignore */ }
  }
  return {
    ok: true,
    ready: true,
    indexPath: outDir,
    versionLabel: manifest.versionLabel,
    versionSource: manifest.versionSource || 'unknown',
    builtAt: manifest.builtAt,
    counts: manifest.counts || {},
    fileCounts: manifest.fileCounts,
    fingerprint: manifest.fingerprint,
    indexBytes,
    stale: status.stale,
    staleFiles: status.staleFiles,
    warnings,
    hint: status.stale ? '运行 refresh 刷新索引；过期结果仅作参考。' : null,
  }
}

function refreshCommand({ outDir, warnings }) {
  const { manifest, records, status } = indexVerdict(outDir)
  const roots = {
    source: manifest.sourceRoot,
    examples: manifest.examplesRoot || undefined,
    generated: manifest.generatedRoot || undefined,
  }
  if (!roots.source) fail('INDEX_INCOMPLETE', 'manifest 缺少 sourceRoot，无法 refresh。', { indexPath: outDir }, '用 build --force 重建。')
  const scanWarnings = []
  const scanned = scanCorpus({ roots, hashMode: 'meta', warnings: scanWarnings })
  const oldByRel = new Map(records.map((r) => [r.relPath, r]))
  const newByRel = new Map(scanned.files.map((f) => [f.relPath, f]))
  let changed = 0
  let added = 0
  let removed = 0
  for (const [rel, f] of newByRel) {
    const old = oldByRel.get(rel)
    if (!old) { added++; continue }
    if (old.size !== f.size || old.mtimeMs !== f.mtimeMs) changed++
  }
  for (const rel of oldByRel.keys()) if (!newByRel.has(rel)) removed++
  const upToDate = !status.stale && changed === 0 && added === 0 && removed === 0
  if (upToDate) {
    return {
      ok: true,
      upToDate: true,
      indexPath: outDir,
      changedFiles: 0,
      addedFiles: 0,
      removedFiles: 0,
      builtAt: manifest.builtAt,
      warnings: [],
      hint: null,
    }
  }
  const mergedWarnings = [...warnings, ...scanWarnings]
  const resolved = resolveRoots({ sourceRoot: roots.source, examplesRoot: roots.examples, generatedRoot: roots.generated, warnings: mergedWarnings })
  const { summary } = buildIndex({ skillDir: SKILL_DIR, outDir, roots: resolved, hashMode: 'content', warnings: mergedWarnings })
  return {
    ok: true,
    upToDate: false,
    indexPath: outDir,
    changedFiles: changed,
    addedFiles: added,
    removedFiles: removed,
    counts: summary.counts,
    durationMs: summary.durationMs,
    builtAt: new Date().toISOString(),
    warnings: summary.warnings,
    hint: null,
  }
}

function buildCommand({ flags }) {
  const warnings = []
  const hashMode = flags.hash || 'content'
  if (hashMode !== 'content' && hashMode !== 'meta') {
    fail('INVALID_ARGUMENT', `--hash 只能是 content 或 meta（收到 ${hashMode}）。`, { hash: hashMode })
  }
  const sourceRoot = flags['source-root'] || defaultSourceRoot()
  const generatedRoot = flags['generated-root'] === undefined ? defaultGeneratedRoot() : flags['generated-root'] || null
  const examplesRoot = flags['examples-root'] || null
  const outDir = resolveOutDir(SKILL_DIR, flags.out === undefined ? 'index' : flags.out)
  const roots = resolveRoots({ sourceRoot, examplesRoot, generatedRoot: generatedRoot || null, warnings })
  if (flags.force === undefined || flags.force === true || flags.force === 'false') { /* 全量构建，--force 仅为兼容 */ }
  const { summary } = buildIndex({ skillDir: SKILL_DIR, outDir, roots, hashMode, warnings })
  return summary
}

function fmtStatusText(res) {
  const lines = [
    `ready: ${res.ready}  stale: ${res.stale}  version: ${res.versionLabel}`,
    `index: ${res.indexPath}  (${(res.indexBytes / 1024).toFixed(1)} KB)`,
    `built: ${res.builtAt}`,
    `counts: ${JSON.stringify(res.counts)}`,
  ]
  if (res.staleFiles && res.staleFiles.length) lines.push(`staleFiles: ${res.staleFiles.map((f) => f.path).join(', ')}`)
  if (res.hint) lines.push(`hint: ${res.hint}`)
  return lines.join('\n')
}

export function run(argv = process.argv.slice(2)) {
  let command = 'help'
  let json = null
  try {
    const parsed = parseArgs(argv)
    command = parsed.command
    if (command === 'help' || parsed.flags.help) {
      return { code: 0, text: USAGE, format: 'text' }
    }
    checkFlags(command, parsed.flags)
    const flags = parsed.flags
    const format = formatOf(flags)
    const outDir = resolveOutDir(SKILL_DIR, flags.out === undefined ? 'index' : flags.out)

    if (command === 'build') {
      json = buildCommand({ flags })
      return { code: 0, json, format }
    }
    if (command === 'status') {
      json = statusCommand({ outDir, deep: asBool(flags.deep) })
      return { code: 0, json, format, text: fmtStatusText(json) }
    }
    if (command === 'refresh') {
      json = refreshCommand({ outDir, warnings: [] })
      return { code: 0, json, format }
    }
    if (command === 'query') {
      json = runQuery({
        outDir,
        opts: {
          q: flags.q,
          kind: flags.kind,
          dialect: flags.dialect,
          field: flags.field,
          exact: asBool(flags.exact),
          allVariants: asBool(flags['all-variants']),
          limit: flags.limit,
        },
      })
      return { code: 0, json, format, text: formatText(json) }
    }
    fail('INVALID_ARGUMENT', `未知命令：${command}`, { command })
  } catch (err) {
    const debug = argv.includes('--debug')
    const body = toErrorResponse(err, debug)
    // 错误一律输出 JSON，避免 agent 解析文本
    return { code: 2, json: body, format: 'json', error: err }
  }
}

function isMain() {
  if (!process.argv[1]) return false
  const self = toPosix(fileURLToPath(import.meta.url)).toLowerCase()
  const entry = toPosix(path.resolve(process.argv[1])).toLowerCase()
  return self === entry
}

if (isMain()) {
  const result = run(process.argv.slice(2))
  if (result.json && result.format === 'json') {
    process.stdout.write(`${JSON.stringify(result.json, null, 2)}\n`)
  } else if (result.format === 'text' && result.text) {
    process.stdout.write(`${result.text}\n`)
  } else if (result.text) {
    process.stdout.write(`${result.text}\n`)
  }
  if (result.code !== 0) process.exitCode = result.code
}
