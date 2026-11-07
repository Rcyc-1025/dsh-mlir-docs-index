#!/usr/bin/env node
/**
 * mlir-docs-index 验收脚本：规格 §13 A1–A10。
 *
 * 用法：
 *   node test/acceptance.mjs
 *   MLIR_SRC_ROOT=/path/to/mlir/include/mlir MLIR_EXAMPLES_ROOT=/path/to/mlir/examples node test/acceptance.mjs
 *
 * 只读真实语料；A8（stale/refresh）在 test/.tmp 下用两份复制的 .td 做小语料，
 * 不会改动 llvm-src / llvm-build。
 *
 * 退出码：0 全过；1 有失败。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(skillDir, 'scripts', 'mlir-docs.mjs')

const SRC = process.env.MLIR_SRC_ROOT || 'D:\\Code\\llvm-src\\llvm-project-23.1.4.src\\mlir\\include\\mlir'
const EX = process.env.MLIR_EXAMPLES_ROOT || 'D:\\Code\\llvm-src\\llvm-project-23.1.4.src\\mlir\\examples'

const TMP = path.join(skillDir, 'test', '.tmp')
const TMP_CORPUS = path.join(TMP, 'corpus')
const TMP_SRC = path.join(TMP_CORPUS, 'src')
const TMP_OUT = 'test/.tmp/index' // 相对 skill 目录（--out 只接受 skill 内相对路径）

let checks = 0
let failures = 0
const failureLines = []

function check(ok, label, detail) {
  checks++
  if (ok) {
    console.log(`  ok   ${label}`)
    return true
  }
  failures++
  const line = `${label}${detail ? ` — ${detail}` : ''}`
  failureLines.push(line)
  console.log(`  FAIL ${line}`)
  return false
}

function section(title) {
  console.log(`\n[${title}]`)
}

function run(args) {
  const started = Date.now()
  const r = spawnSync(process.execPath, [CLI, ...args, '--format', 'json'], {
    cwd: skillDir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  const durationMs = Date.now() - started
  const stdout = r.stdout || ''
  let json = null
  try {
    json = JSON.parse(stdout)
  } catch {
    /* 非 JSON 输出（不该发生），由调用方断言 */
  }
  return { exit: r.status, stdout, stderr: r.stderr || '', json, durationMs }
}

function firstResult(resp) {
  return resp.json && Array.isArray(resp.json.results) ? resp.json.results[0] : undefined
}

function endsWithPath(p, suffix) {
  return typeof p === 'string' && p.replace(/\\/g, '/').toLowerCase().endsWith(suffix.toLowerCase())
}

function readLine(file, lineNo) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/)
    return lines[lineNo - 1] || ''
  } catch {
    return ''
  }
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)
}

// ---------------------------------------------------------------- build
section('build（真实语料）')
const build = run(['build', '--source-root', SRC, '--examples-root', EX])
check(build.exit === 0 && build.json && build.json.ok === true, 'build 退出码 0 且 ok:true', `exit=${build.exit}`)
const counts = (build.json && build.json.counts) || {}
check(Number(counts.files) > 2000, `索引文件数 > 2000（实测 ${counts.files}）`)
check(Number(counts.ops) > 2000, `op 数 > 2000（实测 ${counts.ops}）`)
const buildMs = (build.json && build.json.durationMs) || build.durationMs
const indexBytes = (build.json && build.json.indexBytes) || 0
check(buildMs <= 12000, `冷构建 ≤ 12s（实测 ${buildMs}ms）`)
check(indexBytes > 0 && indexBytes <= 20 * 1024 * 1024, `索引 ≤ 20MB（实测 ${(indexBytes / 1048576).toFixed(2)}MB）`)

// ---------------------------------------------------------------- A1
section('A1 arith.addi（op 精确）')
const a1 = run(['query', '--q', 'arith.addi', '--kind', 'op', '--exact'])
const r1 = firstResult(a1)
check(a1.exit === 0 && a1.json && a1.json.total === 1, 'total = 1', `total=${a1.json && a1.json.total}`)
check(r1 && r1.dialect === 'arith', 'dialect = arith')
check(r1 && r1.summary === 'integer addition operation', `summary 精确匹配（${r1 && r1.summary}）`)
check(r1 && endsWithPath(r1.source && r1.source.file, 'Dialect/Arith/IR/ArithOps.td'), 'source 指向 ArithOps.td')
check(r1 && r1.source && r1.source.line === 271, `source.line = 271（实测 ${r1 && r1.source && r1.source.line}）`)
check(r1 && r1.generated && endsWithPath(r1.generated.file, 'Dialect/Arith/IR/ArithOps.h.inc'), 'generated 指向 ArithOps.h.inc')
if (r1 && r1.generated) {
  const cls = readLine(r1.generated.file, r1.generated.classLine)
  const name = readLine(r1.generated.file, r1.generated.operationNameLine)
  check(/class\s+AddIOp\s*:\s*public\s+::mlir::Op</.test(cls), `classLine 指向 class AddIOp（${r1.generated.classLine}: ${cls.trim()}）`)
  check(/StringLiteral\("arith\.addi"\)/.test(name), `operationNameLine 含 StringLiteral("arith.addi")（${r1.generated.operationNameLine}）`)
} else {
  check(false, 'generated 字段存在')
}
check(r1 && r1.confidence === 'high', `confidence = high（实测 ${r1 && r1.confidence}）`)
check(r1 && Array.isArray(r1.traits) && r1.traits.includes('Commutative'), 'traits 含 Commutative')

// ---------------------------------------------------------------- A2
section('A2 func.func')
const a2 = run(['query', '--q', 'func.func', '--kind', 'op', '--exact'])
const r2 = firstResult(a2)
check(a2.exit === 0 && r2 && r2.id === 'func.func', '命中 func.func')
check(r2 && endsWithPath(r2.source && r2.source.file, 'Dialect/Func/IR/FuncOps.td'), 'source 指向 FuncOps.td')
check(r2 && r2.source && r2.source.line === 250, `source.line = 250（实测 ${r2 && r2.source && r2.source.line}）`)
check(r2 && /single/.test(r2.summary || '') && /SSACFG/.test(r2.summary || ''), `summary 含 single 与 SSACFG（${r2 && r2.summary}）`)
for (const trait of ['AffineScope', 'AutomaticAllocationScope', 'FunctionOpInterface', 'IsolatedFromAbove', 'OpAsmOpInterface']) {
  check(r2 && Array.isArray(r2.traits) && r2.traits.includes(trait), `traits 含 ${trait}`)
}

// ---------------------------------------------------------------- A3
section('A3 scf.for')
const a3 = run(['query', '--q', 'scf.for', '--kind', 'op', '--exact'])
const r3 = firstResult(a3)
check(a3.exit === 0 && r3 && r3.id === 'scf.for', '命中 scf.for')
check(r3 && endsWithPath(r3.source && r3.source.file, 'Dialect/SCF/IR/SCFOps.td'), 'source 指向 SCFOps.td')
check(r3 && r3.source && r3.source.line === 154, `source.line = 154（实测 ${r3 && r3.source && r3.source.line}）`)
check(r3 && Array.isArray(r3.traits) && r3.traits.includes('AutomaticAllocationScope'), 'traits 含 AutomaticAllocationScope')
const loopIface = (r3 && r3.interfaces) || []
check(loopIface.some((i) => i === 'LoopLikeOpInterface' || i.includes('LoopLikeOpInterface')), 'interfaces 含 LoopLikeOpInterface')
const operandNames = ((r3 && r3.operands) || []).map((o) => o.name)
for (const name of ['lowerBound', 'upperBound', 'step']) {
  check(operandNames.includes(name), `operands 含 ${name}`)
}

// ---------------------------------------------------------------- A4
section('A4 toy.add 变体')
const a4 = run(['query', '--q', 'toy.add', '--kind', 'op', '--all-variants'])
const r4 = firstResult(a4)
check(a4.exit === 0 && r4 && r4.id === 'toy.add', '命中 toy.add')
check(r4 && r4.variantCount === 6, `variantCount = 6（实测 ${r4 && r4.variantCount}）`)
const wantLines = [92, 91, 94, 94, 94, 118]
const gotLines = ((r4 && r4.variants) || []).map((v) => v.source && v.source.line)
check(JSON.stringify(gotLines) === JSON.stringify(wantLines), `变体行号 ${wantLines.join('/')}（实测 ${gotLines.join('/')}）`)
check(((r4 && r4.variants) || []).every((v) => v.variantKind === 'tutorial'), '每个变体 variantKind = tutorial')
check(((r4 && r4.variants) || []).every((v) => typeof v.source.file === 'string' && v.source.file.endsWith('Ops.td')), '每个变体带 source.file')
check(((r4 && r4.variants) || []).filter((v) => v.representative).length === 1, '恰好一个 representative')

// ---------------------------------------------------------------- A5
section('A5 arith（dialect）')
const a5 = run(['query', '--q', 'arith', '--kind', 'dialect'])
const r5 = firstResult(a5)
check(a5.exit === 0 && r5 && (r5.id === 'arith' || r5.name === 'arith'), '命中 arith dialect')
check(r5 && endsWithPath(r5.source && r5.source.file, 'Dialect/Arith/IR/ArithBase.td'), 'source 指向 ArithBase.td')
check(r5 && r5.source && r5.source.line === 15, `source.line = 15（实测 ${r5 && r5.source && r5.source.line}）`)
const desc5 = (r5 && (r5.descriptionSnippet || r5.description)) || ''
check(/basic integer and floating point/i.test(desc5), 'description 含 "basic integer and floating point"')
check(r5 && Number(r5.opCount) > 0, `opCount > 0（实测 ${r5 && r5.opCount}）`)

// ---------------------------------------------------------------- A6
section('A6 overflow（summary+description，限 arith）')
const a6 = run(['query', '--q', 'overflow', '--field', 'summary,description', '--dialect', 'arith', '--limit', '10'])
const results6 = (a6.json && a6.json.results) || []
const addi6 = results6.find((x) => x.id === 'arith.addi')
check(a6.exit === 0 && Boolean(addi6), '命中 arith.addi')
check(addi6 && Array.isArray(addi6.matchedFields) && addi6.matchedFields.includes('description'), 'matchedFields 含 description')
check(addi6 && Boolean(addi6.snippet) && addi6.snippet.startLine <= 285 && addi6.snippet.endLine >= 285, `snippet 覆盖 285 行（实测 ${addi6 && addi6.snippet && addi6.snippet.startLine}-${addi6 && addi6.snippet && addi6.snippet.endLine}）`)
check(addi6 && addi6.description === undefined, '不返回整段 description')
const scores6 = results6.map((x) => x.score)
check(scores6.every((s, i) => i === 0 || scores6[i - 1] >= s), '按分数降序')

// ---------------------------------------------------------------- A7
section('A7 addi（短名歧义）')
const a7 = run(['query', '--q', 'addi', '--kind', 'op'])
const r7 = firstResult(a7)
check(a7.exit === 0 && r7 && r7.id === 'arith.addi', `arith.addi 排第一（实测 ${r7 && r7.id}）`)
check(a7.json && a7.json.status === 'ambiguous', `status = ambiguous（实测 ${a7.json && a7.json.status}）`)
check(a7.json && a7.json.total > 1 && Array.isArray(a7.json.results) && a7.json.results.length > 1, '给出多个候选')

// ---------------------------------------------------------------- A8
section('A8 stale / query 警告 / refresh（test/.tmp 小语料）')
fs.rmSync(TMP, { recursive: true, force: true })
const copied = []
for (const f of ['ArithBase.td', 'ArithOps.td']) {
  const from = path.join(SRC, 'Dialect', 'Arith', 'IR', f)
  const to = path.join(TMP_SRC, 'Dialect', 'Arith', 'IR', f)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  copied.push(to)
}
const tmpBuild = run(['build', '--source-root', TMP_SRC, '--generated-root', '', '--out', TMP_OUT])
check(tmpBuild.exit === 0 && tmpBuild.json && tmpBuild.json.ok, 'build 小语料索引')
const st1 = run(['status', '--out', TMP_OUT])
check(st1.exit === 0 && st1.json && st1.json.stale === false, '初始 stale = false')
const touchedFile = copied[1]
const future = new Date(Date.now() + 5000)
fs.utimesSync(touchedFile, future, future)
const st2 = run(['status', '--out', TMP_OUT])
const stalePaths = ((st2.json && st2.json.staleFiles) || []).map((x) => x.path.replace(/\\/g, '/').toLowerCase())
check(st2.exit === 0 && st2.json && st2.json.stale === true, 'touch 后 stale = true')
check(stalePaths.some((p) => p.endsWith('arithops.td')), 'staleFiles 含被 touch 的 .td')
const q8 = run(['query', '--q', 'arith.addi', '--kind', 'op', '--out', TMP_OUT])
const warns8 = (q8.json && q8.json.warnings) || []
check(q8.exit === 0 && q8.json && q8.json.total === 1 && firstResult(q8) && firstResult(q8).id === 'arith.addi', '过期索引仍返回结果')
check(warns8.some((w) => w.code === 'INDEX_STALE'), 'warnings 含 INDEX_STALE')
const refresh = run(['refresh', '--out', TMP_OUT])
check(refresh.exit === 0 && refresh.json && refresh.json.ok, 'refresh 成功')
const st3 = run(['status', '--out', TMP_OUT])
check(st3.exit === 0 && st3.json && st3.json.stale === false, 'refresh 后 stale = false')

// ---------------------------------------------------------------- A9
section('A9 语料根不存在')
const a9 = run(['build', '--source-root', 'D:/does/not/exist'])
check(a9.exit === 2, `退出码 2（实测 ${a9.exit}）`)
check(a9.json && a9.json.ok === false && a9.json.code === 'CORPUS_NOT_FOUND', `code = CORPUS_NOT_FOUND（实测 ${a9.json && a9.json.code}）`)
check(a9.json && typeof a9.json.hint === 'string' && a9.json.hint.includes('D:/does/not/exist'), 'hint 含期望路径')
check(!/ENOENT/.test(a9.stdout) && !/\n\s+at\s+/.test(a9.stdout), '输出无裸 ENOENT / 堆栈')

// ---------------------------------------------------------------- A10
section('A10 非法参数')
const a10a = run(['query', '--q', ''])
check(a10a.exit === 2 && a10a.json && a10a.json.code === 'INVALID_QUERY', `空 q → INVALID_QUERY（实测 ${a10a.json && a10a.json.code}）`)
const a10b = run(['query', '--q', 'arith.addi', '--limit', '999'])
check(a10b.exit === 2 && a10b.json && a10b.json.code === 'INVALID_ARGUMENT', `limit=999 → INVALID_ARGUMENT（实测 ${a10b.json && a10b.json.code}）`)
check(a10b.json && typeof a10b.json.hint === 'string' && /1[–-]50/.test(a10b.json.hint), 'hint 给出合法范围 1–50')

// ---------------------------------------------------------------- 性能
section('性能（info）')
const qTimes = []
for (let i = 0; i < 5; i++) qTimes.push(run(['query', '--q', 'arith.addi', '--kind', 'op', '--exact']).durationMs)
console.log(`  query P50 ≈ ${median(qTimes)}ms（含 Node 启动；预算 150ms + 进程启动）`)
console.log(`  build 实测 ${buildMs}ms / 索引 ${(indexBytes / 1048576).toFixed(2)}MB`)

// ---------------------------------------------------------------- 汇总
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}：${checks - failures}/${checks} 项通过`)
if (failures > 0) {
  console.log('失败项：')
  for (const line of failureLines) console.log(`  - ${line}`)
}
process.exit(failures === 0 ? 0 : 1)
