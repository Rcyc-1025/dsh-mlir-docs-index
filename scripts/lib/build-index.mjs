// 合并、去重、变体、置信度，写 manifest 与 JSONL。所有写入先落临时目录再原子 rename。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { countKinds, detectVersionLabel, fingerprintOf, pathKey, scanCorpus, toPosix } from './scan.mjs'
import { parseTdFile } from './parse-td.mjs'
import { parseGeneratedFiles } from './parse-inc.mjs'
import { fail } from './errors.mjs'

export const SCHEMA_VERSION = 1
const MAX_WARNINGS = 50
const MAX_OP_NAMES = 500

export function resolveOutDir(skillDir, out) {
  const raw = out == null ? 'index' : String(out)
  if (raw.includes('..')) {
    fail('INVALID_ARGUMENT', '--out 不允许包含 ..。', { out: raw }, '--out 必须是 skill 目录下的相对路径，例如 index。')
  }
  if (path.isAbsolute(raw)) {
    fail('INVALID_ARGUMENT', '--out 不允许是绝对路径。', { out: raw }, '用相对 skill 目录的路径，例如 --out index。')
  }
  const resolved = path.resolve(skillDir, raw)
  const rel = path.relative(skillDir, resolved)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    fail('INVALID_ARGUMENT', '--out 必须位于 skill 目录内部。', { out: raw, resolved, skillDir }, '例如 --out index；不要把索引写到 skill 目录之外。')
  }
  return resolved
}

function rootRank(file) {
  return file.root === 'src' ? 0 : file.root === 'examples' ? 1 : 2
}

function variantLabel(file, roots) {
  const p = toPosix(file.path)
  const ex = /\/examples\/([^/]+)\/([^/]+)\//.exec(p)
  if (ex) return `${ex[1]}/${ex[2]}`
  const rootPath = file.root === 'src' ? roots.source : file.root === 'generated' ? roots.generated : roots.examples
  if (rootPath) return `${file.root}:${toPosix(path.relative(rootPath, file.path))}`
  return file.relPath
}

function namespaceOf(cppNamespace) {
  if (!cppNamespace) return ''
  return cppNamespace.replace(/^::/, '').replace(/^mlir::/, '')
}

function buildClassMap(classDecls) {
  const map = new Map()
  const sorted = [...classDecls].sort((a, b) => rootRank(a) - rootRank(b) || a.file.path.localeCompare(b.file.path) || a.line - b.line)
  for (const decl of sorted) {
    if (!map.has(decl.name)) map.set(decl.name, decl)
  }
  return map
}

function makeOpDerivation(classMap) {
  const cache = new Map()
  function derives(base, depth = 0, seen = new Set()) {
    if (base === 'Op') return true
    if (cache.has(base)) return cache.get(base)
    if (depth > 12 || seen.has(base)) return false
    seen.add(base)
    const decl = classMap.get(base)
    if (!decl) { cache.set(base, false); return false }
    const result = decl.bases.some((b) => derives(b, depth + 1, seen))
    cache.set(base, result)
    return result
  }
  return derives
}

function buildDialectAliases(dialectEntries) {
  const prefix = new Map()
  const prefixAmb = new Set()
  const dir = new Map()
  const dirAmb = new Set()
  for (const d of dialectEntries) {
    const defName = d.defName || ''
    const p = defName.split('_')[0]
    if (p) {
      const k = p.toLowerCase()
      if (prefix.has(k) && prefix.get(k) !== d.name) prefixAmb.add(k)
      else prefix.set(k, d.name)
    }
    const m = /[\\/]Dialect[\\/]([^\\/]+)[\\/]/.exec(d.source.file)
    if (m) {
      const k = m[1].toLowerCase()
      if (dir.has(k) && dir.get(k) !== d.name) dirAmb.add(k)
      else dir.set(k, d.name)
    }
  }
  for (const k of prefixAmb) prefix.delete(k)
  for (const k of dirAmb) dir.delete(k)
  return { prefix, dir }
}

function resolveDialect({ file, info, defName, tdInfoByKey, roots, aliases }) {
  if (info.dialects.length) return info.dialects[0].name

  for (const inc of info.includes) {
    const target = resolveIncludeLocal(inc, roots)
    if (!target) continue
    const targetInfo = tdInfoByKey.get(pathKey(target))
    if (targetInfo && targetInfo.dialects.length) return targetInfo.dialects[0].name
  }

  const p = toPosix(file.path)

  // def 名前缀（OpenACC_ComputeRegionOp → acc；ROCDL_FooOp → rocdl）
  const prefixKey = String(defName || '').split('_')[0].toLowerCase()
  if (prefixKey && aliases.prefix.has(prefixKey)) return aliases.prefix.get(prefixKey)

  // 目录名（仅在没有同名歧义时使用）
  const dialectPath = /\/Dialect\/([A-Za-z0-9_]+)\//.exec(p)
  if (dialectPath) {
    const dirKey = dialectPath[1].toLowerCase()
    if (aliases.dir.has(dirKey)) return aliases.dir.get(dirKey)
    return dirKey
  }
  const examplePath = /\/examples\/([A-Za-z0-9_]+)\//.exec(p)
  if (examplePath) return examplePath[1].toLowerCase()
  return null
}

function resolveIncludeLocal(inc, roots) {
  const candidates = []
  const rel = inc.startsWith('mlir/') ? inc.slice(5) : inc
  if (roots.generated) candidates.push(path.join(roots.generated, rel))
  if (roots.source) candidates.push(path.join(roots.source, rel))
  if (roots.examples) candidates.push(path.join(roots.examples, inc))
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c
    } catch {
      /* 尝试下一个 */
    }
  }
  return null
}

function dedupeTraits(items) {
  const out = []
  for (const t of items) if (t && !out.includes(t)) out.push(t)
  return out
}

function extractInterfacesOf(traits) {
  const out = []
  for (const trait of traits) {
    let m
    const re1 = /DeclareOpInterfaceMethods\s*<\s*([A-Za-z_][A-Za-z0-9_]*)/g
    while ((m = re1.exec(trait))) if (!out.includes(m[1])) out.push(m[1])
    const re2 = /(?:^|[<,\s])([A-Za-z_][A-Za-z0-9_]*OpInterface)\b/g
    while ((m = re2.exec(trait))) if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

function descriptionSnippetOf(description) {
  if (!description) return null
  const flat = description.replace(/\s+/g, ' ').trim()
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat
}

function chainDeclares(classMap, name, key, depth = 0, seen = new Set()) {
  if (!name || depth > 3 || seen.has(name)) return false
  seen.add(name)
  const c = classMap.get(name)
  if (!c) return false
  if (c.body && c.body[key] != null) return true
  if (key === 'args' && c.sigArgs) return true
  if (key === 'results' && c.sigResults) return true
  return c.bases.some((b) => chainDeclares(classMap, b, key, depth + 1, seen))
}

function resolveFields(raw, classMap) {
  const base = classMap.get(raw.baseName) || null
  const unresolved = []
  let inherited = false

  let args = raw.body.args
  if (!args && base) {
    if (base.body && base.body.args) { args = base.body.args; inherited = true }
    else if (base.sigArgs) { args = { operands: base.sigArgs.operands, attributes: base.sigArgs.attributes }; inherited = true }
    else if (!chainDeclares(classMap, raw.baseName, 'args')) args = { operands: [], attributes: [] }
  }
  let results = raw.body.results
  if (!results && base) {
    if (base.body && base.body.results) { results = base.body.results; inherited = true }
    else if (base.sigResults) { results = base.sigResults; inherited = true }
    else if (!chainDeclares(classMap, raw.baseName, 'results')) results = []
  }
  let regions = raw.body.regions
  if (regions == null && base && base.body && base.body.regions != null) { regions = base.body.regions; inherited = true }

  if (inherited) unresolved.push('fields:inherited')
  if (args == null) unresolved.push('operands:unparsed')
  else if (args.operands.length === 0 && args.attributes.length === 0 && !inherited) unresolved.push('operands:declared-none')
  if (results == null) unresolved.push('results:unparsed')

  const description = raw.body.description || (base && base.body && base.body.description) || null
  const inheritedDesc = !raw.body.description && description
  const summary = raw.body.summary || (base && base.body && base.body.summary) || null

  return {
    summary,
    summaryLine: raw.body.summaryLine,
    description,
    descriptionTruncated: Boolean(raw.body.descriptionTruncated),
    descFirstLine: raw.body.descFirstLine || (inheritedDesc && base && base.body ? base.body.descFirstLine : null) || null,
    operands: args ? args.operands : null,
    attributes: args ? args.attributes : null,
    results: results == null ? null : results,
    regions: regions == null ? null : regions,
    unresolved,
  }
}

function confidenceOf({ generated, operands, results }) {
  if (!generated) return operands === null || results === null ? 'medium' : 'medium'
  if (operands === null || results === null) return 'medium'
  return 'high'
}

function shortNameOf(id) {
  const idx = id.lastIndexOf('.')
  return idx >= 0 ? id.slice(idx + 1) : id
}

function writeFileSyncFsync(file, content) {
  const fd = fs.openSync(file, 'w')
  try {
    fs.writeFileSync(fd, content)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function swapIndex(tmpDir, outDir) {
  let backup = null
  if (fs.existsSync(outDir)) {
    backup = `${outDir}.bak-${process.pid}`
    fs.rmSync(backup, { recursive: true, force: true })
    fs.renameSync(outDir, backup)
  }
  try {
    fs.renameSync(tmpDir, outDir)
  } catch (err) {
    if (backup) {
      try { fs.renameSync(backup, outDir) } catch { /* 保留 backup 供人工恢复 */ }
    }
    throw err
  }
  if (backup) fs.rmSync(backup, { recursive: true, force: true })
}

/**
 * 全量构建索引。
 * @returns {{summary: object}}
 */
export function buildIndex({ skillDir, outDir, roots, hashMode = 'content', warnings = [] }) {
  const started = Date.now()
  const allWarnings = [...warnings]

  const scanned = scanCorpus({ roots, hashMode, warnings: allWarnings })
  const files = scanned.files
  const fileByKey = new Map(files.map((f) => [pathKey(f.path), f]))
  const tdFiles = files.filter((f) => f.kind === 'td')

  // ---------- 解析 TableGen ----------
  const tdInfoByKey = new Map()
  const allClasses = []
  let partialFiles = 0
  for (const file of tdFiles) {
    try {
      const text = fs.readFileSync(file.path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
      const info = parseTdFile(file.path, text)
      info.file = file
      tdInfoByKey.set(pathKey(file.path), info)
      for (const c of info.classes) allClasses.push({ ...c, file })
    } catch (err) {
      partialFiles++
      file.parseStatus = 'partial'
      file.warnings = [String(err && err.message ? err.message : err)]
      allWarnings.push({ code: 'PARSE_PARTIAL', message: `TableGen 解析失败：${file.relPath}`, details: { error: file.warnings[0] } })
    }
  }

  const classMap = buildClassMap(allClasses)
  const derivesOp = makeOpDerivation(classMap)

  // ---------- 生成头 ----------
  const generatedFiles = files.filter((f) => f.path.toLowerCase().endsWith('.h.inc'))
  const generated = parseGeneratedFiles(generatedFiles, allWarnings)

  // ---------- dialect 表 ----------
  const dialectGroups = new Map()
  for (const file of tdFiles) {
    const info = tdInfoByKey.get(pathKey(file.path))
    if (!info) continue
    for (const d of info.dialects) {
      const rec = { ...d, root: file.root, fileObj: file }
      if (!dialectGroups.has(rec.name)) dialectGroups.set(rec.name, [])
      dialectGroups.get(rec.name).push(rec)
    }
  }
  const dialectEntries = []
  for (const [name, candidates] of dialectGroups) {
    candidates.sort((a, b) => rootRank(a.fileObj) - rootRank(b.fileObj) || a.file.localeCompare(b.file) || a.line - b.line)
    const rep = candidates[0]
    dialectEntries.push({
      id: name,
      kind: 'dialect',
      name,
      defName: rep.defName,
      cppNamespace: rep.cppNamespace || null,
      summary: rep.summary || null,
      description: rep.description || null,
      source: { file: rep.file, line: rep.line, endLine: rep.endLine, kind: 'td' },
      generated: null,
      opCount: 0,
      opNames: [],
    })
  }
  const dialectByName = new Map(dialectEntries.map((d) => [d.id, d]))
  // 目录名/def 前缀 → dialect 名（acc 的 .td 在 Dialect/OpenACC/ 下，ROCDL 在 Dialect/LLVMIR/ 下）
  const aliases = buildDialectAliases(dialectEntries)
  for (const d of dialectEntries) delete d.defName

  // ---------- op 合并 ----------
  const opGroups = new Map()
  for (const file of tdFiles) {
    const info = tdInfoByKey.get(pathKey(file.path))
    if (!info) continue
    for (const raw of info.ops) {
      if (!derivesOp(raw.baseName)) continue
      const dia = resolveDialect({ file, info, defName: raw.defName, tdInfoByKey, roots, aliases })
      const fields = resolveFields(raw, classMap)
      const id = dia ? `${dia}.${raw.opName}` : raw.opName
      const traits = dedupeTraits(raw.traits)
      const cand = {
        id,
        opName: id,
        shortName: shortNameOf(id),
        dialect: dia,
        tablegenDef: raw.defName,
        baseClass: raw.baseName,
        summary: fields.summary,
        summaryLine: fields.summaryLine,
        description: fields.description,
        descriptionTruncated: fields.descriptionTruncated,
        descFirstLine: fields.descFirstLine,
        operands: fields.operands,
        attributes: fields.attributes,
        results: fields.results,
        regions: fields.regions,
        traits,
        interfaces: extractInterfacesOf(traits),
        variadic: Array.isArray(fields.operands) && fields.operands.some((o) => o.variadic),
        source: { file: raw.file, line: raw.line, endLine: raw.endLine, kind: 'td' },
        root: file.root,
        fileObj: file,
        unresolved: fields.unresolved,
      }
      if (!opGroups.has(id)) opGroups.set(id, [])
      opGroups.get(id).push(cand)
    }
  }

  let duplicateOpGroups = 0
  const ops = []
  for (const [id, candidates] of opGroups) {
    candidates.sort((a, b) => rootRank(a.fileObj) - rootRank(b.fileObj) || a.source.file.localeCompare(b.source.file) || a.source.line - b.source.line)
    if (candidates.length > 1) duplicateOpGroups++
    const rep = candidates[0]
    const gen = generated.byOpName.get(id) || null
    const dialectEntry = dialectByName.get(rep.dialect)
    const ns = namespaceOf(dialectEntry && dialectEntry.cppNamespace)
    const variants = []
    if (candidates.length > 1) {
      const seen = new Set()
      for (const c of candidates) {
        const k = `${c.source.file}:${c.source.line}`
        if (seen.has(k)) continue
        seen.add(k)
        variants.push({
          source: { file: c.source.file, line: c.source.line, kind: 'td' },
          variant: variantLabel(c.fileObj, roots),
          variantKind: c.fileObj.root === 'examples' ? 'tutorial' : 'duplicate',
          representative: c === rep,
        })
      }
    }
    const unresolved = [...rep.unresolved]
    if (!gen) unresolved.push('generated:missing')
    const confidence = gen && rep.operands !== null && rep.results !== null ? 'high' : 'medium'

    ops.push({
      id,
      kind: 'op',
      opName: id,
      shortName: rep.shortName,
      dialect: rep.dialect,
      tablegenDef: rep.tablegenDef,
      cppClass: gen ? `${ns ? `${ns}::` : ''}${gen.className}` : null,
      summary: rep.summary,
      description: rep.description,
      descriptionTruncated: rep.descriptionTruncated,
      descFirstLine: rep.descFirstLine || null,
      operands: rep.operands,
      results: rep.results,
      attributes: rep.attributes || [],
      traits: rep.traits,
      interfaces: rep.interfaces,
      regions: rep.regions,
      variadic: rep.variadic,
      source: rep.source,
      generated: gen
        ? { file: gen.file, classLine: gen.classLine, operationNameLine: gen.operationNameLine, kind: 'h.inc' }
        : null,
      variants,
      variantCount: candidates.length,
      confidence,
      unresolved,
      matchedFields: [],
    })
  }

  // ---------- generated-only ----------
  let generatedOnlyCount = 0
  for (const [opName, gen] of generated.byOpName) {
    if (opGroups.has(opName)) continue
    const idx = opName.indexOf('.')
    const dialect = idx > 0 ? opName.slice(0, idx) : null
    const dialectEntry = dialectByName.get(dialect)
    const ns = namespaceOf(dialectEntry && dialectEntry.cppNamespace)
    ops.push({
      id: opName,
      kind: 'op',
      opName,
      shortName: shortNameOf(opName),
      dialect,
      tablegenDef: null,
      cppClass: `${ns ? `${ns}::` : ''}${gen.className}`,
      summary: null,
      description: null,
      descriptionTruncated: false,
      operands: null,
      results: null,
      attributes: [],
      traits: [],
      interfaces: [],
      regions: null,
      variadic: false,
      source: null,
      generated: { file: gen.file, classLine: gen.classLine, operationNameLine: gen.operationNameLine, kind: 'h.inc' },
      variants: [],
      variantCount: 1,
      confidence: 'low',
      unresolved: ['source:generated-only'],
      matchedFields: [],
    })
    generatedOnlyCount++
  }

  // ---------- dialect 回填 ----------
  for (const op of ops) {
    if (!op.dialect) continue
    const d = dialectByName.get(op.dialect)
    if (!d) continue
    if (d.opNames.length < MAX_OP_NAMES) d.opNames.push(op.id)
    else d.opNamesTruncated = true
  }
  for (const d of dialectEntries) {
    d.opCount = d.opNames.length
    d.opNames.sort()
  }

  ops.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  dialectEntries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // ---------- 写产物 ----------
  const builtAt = new Date().toISOString()
  const durationMs = Date.now() - started
  const fileCounts = countKinds(files)
  const versionSource = detectVersionLabel(roots.source)
  const versionGenerated = detectVersionLabel(roots.generated)
  if (versionSource.label !== 'unknown' && versionGenerated.label !== 'unknown' && versionSource.label !== versionGenerated.label) {
    allWarnings.push({
      code: 'VERSION_MISMATCH',
      message: `源码版本 ${versionSource.label} 与生成头版本 ${versionGenerated.label} 不一致。`,
      details: { source: versionSource.label, generated: versionGenerated.label },
    })
  }
  if (files.length > 3000) {
    allWarnings.push({ code: 'CORPUS_LARGE', message: `语料文件数 ${files.length} 超过 3000，构建可能变慢。`, details: { total: files.length } })
  }
  if (partialFiles > 0) {
    allWarnings.push({ code: 'PARSE_PARTIAL', message: `${partialFiles} 个 .td 文件解析失败，已跳过。`, details: { files: partialFiles } })
  }

  const fileRecords = files.map((f) => ({
    path: f.path,
    relPath: f.relPath,
    kind: f.kind,
    size: f.size,
    mtimeMs: f.mtimeMs,
    sha256: f.sha256 || null,
    parseStatus: f.parseStatus || (f.kind === 'inc' && !f.path.toLowerCase().endsWith('.h.inc') ? 'skipped' : 'ok'),
    warnings: f.warnings || [],
  }))

  const stats = {
    totalFiles: files.length,
    parsedFiles: files.filter((f) => (f.parseStatus || 'ok') !== 'skipped').length,
    skippedFiles: files.filter((f) => f.parseStatus === 'skipped').length,
    opCount: ops.length,
    dialectCount: dialectEntries.length,
    generatedOnlyCount,
    duplicateOpGroups,
    opCountByConfidence: ops.reduce((acc, o) => {
      acc[o.confidence] = (acc[o.confidence] || 0) + 1
      return acc
    }, {}),
    buildDurationMs: durationMs,
    warnings: allWarnings.slice(0, MAX_WARNINGS),
  }

  const fingerprint = fingerprintOf(files)
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    versionLabel: versionSource.label,
    versionSource: versionSource.source,
    sourceVersionLabel: versionSource.label,
    generatedVersionLabel: versionGenerated.label,
    sourceRoot: roots.source,
    examplesRoot: roots.examples || null,
    generatedRoot: roots.generated || null,
    fileCounts,
    fingerprint,
    builtAt,
    buildDurationMs: durationMs,
    hashMode,
    counts: {
      ops: ops.length,
      dialects: dialectEntries.length,
      generatedOnly: generatedOnlyCount,
      duplicateOpGroups,
    },
  }

  const payloads = {
    'manifest.json': JSON.stringify(manifest, null, 2),
    'ops.jsonl': ops.map((o) => JSON.stringify(o)).join('\n') + '\n',
    'dialects.jsonl': dialectEntries.map((d) => JSON.stringify(d)).join('\n') + '\n',
    'files.jsonl': fileRecords.map((f) => JSON.stringify(f)).join('\n') + '\n',
    'stats.json': JSON.stringify(stats, null, 2),
    // 目录整体替换，这个占位文件随索引一起重建，避免 git 里出现「目录被删除」。
    '.gitkeep': '# 索引目录（可重建产物）：build 会整体替换本目录内容，只保留这个占位文件。\n',
  }

  const tmpDir = `${outDir}.tmp-${process.pid}`
  try {
    fs.mkdirSync(path.dirname(outDir), { recursive: true })
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.mkdirSync(tmpDir, { recursive: true })
    for (const [name, content] of Object.entries(payloads)) writeFileSyncFsync(path.join(tmpDir, name), content)
    swapIndex(tmpDir, outDir)
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    fail('INDEX_WRITE_FAILED', `写索引失败：${err && err.message ? err.message : String(err)}`, {
      outDir,
      error: err && err.code ? err.code : String(err),
    })
  }

  let indexBytes = 0
  for (const name of Object.keys(payloads)) {
    try { indexBytes += fs.statSync(path.join(outDir, name)).size } catch { /* ignore */ }
  }
  if (indexBytes > 20 * 1024 * 1024) {
    allWarnings.push({ code: 'OUTPUT_LIMIT', message: `索引体积 ${(indexBytes / 1024 / 1024).toFixed(1)} MB 超过 20 MB。`, details: { indexBytes } })
  }

  return {
    summary: {
      ok: true,
      counts: {
        files: files.length,
        ops: ops.length,
        dialects: dialectEntries.length,
        generatedOnly: generatedOnlyCount,
        duplicateOpGroups,
        fileKinds: fileCounts,
      },
      durationMs,
      indexPath: outDir,
      indexBytes,
      fingerprint,
      versionLabel: versionSource.label,
      warnings: allWarnings.slice(0, MAX_WARNINGS),
    },
  }
}

export function describeStale(fileRecords, { deep = false } = {}) {
  const staleFiles = []
  let checked = 0
  for (const rec of fileRecords) {
    checked++
    let st
    try {
      st = fs.statSync(rec.path)
    } catch {
      staleFiles.push({ path: rec.path, reason: 'missing' })
      continue
    }
    if (st.size !== rec.size || Math.round(st.mtimeMs) !== rec.mtimeMs) {
      staleFiles.push({ path: rec.path, reason: 'size/mtime' })
      continue
    }
    if (deep && rec.sha256) {
      try {
        const sha = crypto.createHash('sha256').update(fs.readFileSync(rec.path)).digest('hex')
        if (sha !== rec.sha256) staleFiles.push({ path: rec.path, reason: 'sha256' })
      } catch {
        staleFiles.push({ path: rec.path, reason: 'unreadable' })
      }
    }
  }
  return { stale: staleFiles.length > 0, staleFiles: staleFiles.slice(0, 20), staleCount: staleFiles.length, checked }
}
