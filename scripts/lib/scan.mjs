// 语料根解析、遍历、分类与指纹。只读语料，不写任何语料路径。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fail } from './errors.mjs'

export const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', 'CMakeFiles', '.svn'])
export const INDEX_EXT = new Set(['.td', '.h', '.inc'])

export function defaultSourceRoot() {
  return process.env.MLIR_SRC_ROOT || 'D:/Code/llvm-src/llvm-project-23.1.4.src/mlir/include/mlir'
}

export function defaultGeneratedRoot() {
  return process.env.MLIR_GEN_ROOT || 'D:/Code/llvm-build/tools/mlir/include/mlir'
}

export function toPosix(p) {
  return p.replace(/\\/g, '/')
}

/** Windows 下按小写做键，避免 D:/ 与 D:\ 混用导致 include 解析失败。 */
export function pathKey(p) {
  return toPosix(path.resolve(p)).toLowerCase()
}

export function statDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function resolveRoots({ sourceRoot, examplesRoot, generatedRoot, warnings }) {
  const resolved = {}

  if (!sourceRoot || !statDir(sourceRoot)) {
    fail(
      'CORPUS_NOT_FOUND',
      '找不到 MLIR 源码根。',
      {
        path: sourceRoot || null,
        expected: 'D:/Code/llvm-src/llvm-project-23.1.4.src/mlir/include/mlir',
        role: 'source-root',
      },
      `检查 --source-root 指向的目录是否存在（收到 "${sourceRoot || '(未指定)'}"）；默认路径为 "D:/Code/llvm-src/llvm-project-23.1.4.src/mlir/include/mlir"，也可用环境变量 MLIR_SRC_ROOT 覆盖。`,
    )
  }
  resolved.source = path.resolve(sourceRoot)

  if (examplesRoot) {
    if (statDir(examplesRoot)) resolved.examples = path.resolve(examplesRoot)
    else warnings.push({ code: 'EXAMPLES_ROOT_MISSING', message: `examples-root 不存在，已跳过：${examplesRoot}`, details: { path: examplesRoot } })
  }

  if (generatedRoot) {
    if (statDir(generatedRoot)) resolved.generated = path.resolve(generatedRoot)
    else warnings.push({ code: 'GENERATED_ROOT_MISSING', message: `generated-root 不存在，已降级为 metadata-only：${generatedRoot}`, details: { path: generatedRoot } })
  }

  return resolved
}

function classify(fileName) {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.td')) return 'td'
  if (lower.endsWith('.h')) return 'h'
  if (lower.endsWith('.inc')) return 'inc'
  return null
}

function walkOne(root, tag, out) {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      out.warnings.push({ code: 'IO_ERROR', message: `目录读取失败，已跳过：${dir}`, details: { error: err.code || String(err) } })
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue // 不跟随链接，避免越出语料根
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push(path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const kind = classify(entry.name)
      if (!kind) continue
      const full = path.join(dir, entry.name)
      let st
      try {
        st = fs.statSync(full)
      } catch (err) {
        out.warnings.push({ code: 'IO_ERROR', message: `文件 stat 失败，已跳过：${full}`, details: { error: err.code || String(err) } })
        continue
      }
      const rel = toPosix(path.relative(root, full))
      out.files.push({
        path: full,
        relPath: `${tag}/${rel}`,
        kind,
        root: tag,
        size: st.size,
        mtimeMs: Math.round(st.mtimeMs),
      })
    }
  }
}

export function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export function scanCorpus({ roots, hashMode = 'content', warnings = [] }) {
  const out = { files: [], warnings }
  if (roots.source) walkOne(roots.source, 'src', out)
  if (roots.examples) walkOne(roots.examples, 'examples', out)
  if (roots.generated) walkOne(roots.generated, 'generated', out)

  if (!out.files.some((f) => f.kind === 'td' || f.kind === 'h')) {
    fail('CORPUS_EMPTY', '语料根里没有可索引的 .td/.h 文件。', {
      roots,
      counts: countKinds(out.files),
    })
  }

  if (hashMode === 'content') {
    for (const f of out.files) {
      try {
        f.sha256 = hashFile(f.path)
      } catch (err) {
        warnings.push({ code: 'IO_ERROR', message: `读取失败，已跳过哈希：${f.path}`, details: { error: err.code || String(err) } })
      }
    }
  }

  return { files: out.files, warnings: out.warnings }
}

export function countKinds(files) {
  const counts = { td: 0, h: 0, inc: 0, total: files.length }
  for (const f of files) counts[f.kind] = (counts[f.kind] || 0) + 1
  return counts
}

export function fingerprintOf(files) {
  const lines = files
    .filter((f) => f.sha256)
    .map((f) => `${f.relPath}|${f.size}|${f.sha256}`)
    .sort()
  return `sha256:${crypto.createHash('sha256').update(lines.join('\n')).digest('hex')}`
}

/** 版本标签：优先 mlir-config.h，其次路径名中的 x.y.z，最后 unknown。 */
export function detectVersionLabel(root) {
  if (!root) return { label: 'unknown', source: 'unknown' }
  const configCandidates = [path.join(root, 'mlir-config.h'), path.join(root, '..', 'mlir-config.h')]
  for (const cfg of configCandidates) {
    try {
      const text = fs.readFileSync(cfg, 'utf8')
      const m = /MLIR_VERSION_STRING\s+"([0-9][0-9A-Za-z.\-]*)"/.exec(text) || /MLIR_VERSION_(?:MAJOR|MINOR|PATCH)\s+(\d+)/.exec(text)
      if (m) return { label: m[1], source: 'mlir-config.h' }
    } catch {
      /* 继续尝试 */
    }
  }
  const m = /llvm-project-(\d+\.\d+\.\d+)/.exec(toPosix(path.resolve(root)))
  if (m) return { label: m[1], source: 'path-name' }
  return { label: 'unknown', source: 'unknown' }
}
