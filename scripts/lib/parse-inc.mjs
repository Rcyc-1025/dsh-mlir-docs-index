// 生成头扫描：*.h.inc 里的 class XxxOp : public ::mlir::Op<...> 与 getOperationName。
// 只按行扫描，不构造 AST；跳过前向声明（class Foo;）。

import fs from 'node:fs'

const CLASS_START = /^\s*class\s+([A-Za-z_]\w*)\s*:\s*public\s+::mlir::Op\s*</
const OP_NAME = /getOperationName/
const STRING_LITERAL = /StringLiteral\s*\(\s*"([^"]+)"\s*\)/

export function parseGeneratedFiles(files, warnings = []) {
  const byOpName = new Map()
  let classes = 0

  for (const file of files) {
    let text
    try {
      text = fs.readFileSync(file.path, 'utf8')
    } catch (err) {
      warnings.push({ code: 'IO_ERROR', message: `生成头读取失败，已跳过：${file.path}`, details: { error: err.code || String(err) } })
      continue
    }
    const lines = text.split('\n')
    let current = null

    const finalize = (opName, lineNo) => {
      if (!current || !opName) return
      if (byOpName.has(opName)) return
      byOpName.set(opName, {
        file: file.path,
        classLine: current.classLine,
        operationNameLine: lineNo,
        className: current.className,
      })
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const cm = CLASS_START.exec(line)
      if (cm) {
        if (current && current.opName) finalize(current.opName, current.opNameLine)
        current = { className: cm[1], classLine: i + 1, opName: null, opNameLine: null }
        classes++
        continue
      }
      if (!current || current.opName) continue
      if (!OP_NAME.test(line)) continue
      let m = STRING_LITERAL.exec(line)
      let lineNo = i + 1
      if (!m) {
        for (let k = 1; k <= 4 && i + k < lines.length; k++) {
          m = STRING_LITERAL.exec(lines[i + k])
          if (m) { lineNo = i + k + 1; break }
        }
      }
      if (m) {
        current.opName = m[1]
        current.opNameLine = lineNo
      }
    }
    if (current && current.opName) finalize(current.opName, current.opNameLine)
  }

  return { byOpName, warnings, classes }
}
