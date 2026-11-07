// 错误码与统一响应。所有对外错误都收敛到这里，绝不把裸 ENOENT/EACCES/SyntaxError 抛给调用方。

export const CODES = {
  CORPUS_NOT_FOUND: {
    fatal: true,
    message: '找不到 MLIR 语料根。',
    hint: '检查 --source-root（或环境变量 MLIR_SRC_ROOT）；示例：--source-root "D:/Code/llvm-src/llvm-project-23.1.4.src/mlir/include/mlir"',
  },
  CORPUS_EMPTY: {
    fatal: true,
    message: '语料根存在，但没有可索引的 .td/.h 文件。',
    hint: '确认 --source-root 指到 mlir/include/mlir（或 examples）这一层，而不是仓库根；扩展名只索引 .td/.h/.inc。',
  },
  INDEX_MISSING: {
    fatal: true,
    message: '索引不存在（缺 manifest.json）。',
    hint: '先运行 build：node scripts/mlir-docs.mjs build --source-root "<MLIR 源码根>"',
  },
  INDEX_INCOMPLETE: {
    fatal: true,
    message: '索引文件缺失或损坏。',
    hint: '运行 build --force 重建索引；旧索引已保留到 index.bak-* 以便排查。',
  },
  INDEX_STALE: {
    fatal: false,
    message: '索引已过期（语料 size/mtime 与清单不一致）。',
    hint: '运行 refresh 刷新；过期结果仅作参考。',
  },
  VERSION_MISMATCH: {
    fatal: false,
    message: '源码根与生成头根的版本标签不一致。',
    hint: '确认 build 树与源码版本匹配（23.1.4），否则 generated 行号可能来自另一版本。',
  },
  GENERATED_ROOT_MISSING: {
    fatal: false,
    message: '生成头根缺失，已降级为 metadata-only（generated 为 null）。',
    hint: '如需 C++ class / getOperationName 映射，补 --generated-root "D:/Code/llvm-build/tools/mlir/include/mlir"。',
  },
  INVALID_QUERY: {
    fatal: true,
    message: '查询词为空或过长。',
    hint: '--q 需要 1–200 个字符；例：--q arith.addi，或改用 --dialect arith --kind op。',
  },
  INVALID_ARGUMENT: {
    fatal: true,
    message: '参数非法。',
    hint: '检查参数名与范围：--limit 1–50、--out 必须在 skill 目录内、--kind 为 op/dialect/any。',
  },
  PARSE_PARTIAL: {
    fatal: false,
    message: '部分文件解析失败，结果仍可用。',
    hint: '查看 warnings 中的文件与原因；常见原因是编码或非标准 TableGen。',
  },
  OUTPUT_LIMIT: {
    fatal: false,
    message: '结果超过限制。',
    hint: '缩小范围（加 --dialect / --field / --exact），或提高 --limit（上限 50）。',
  },
  IO_ERROR: {
    fatal: true,
    message: '读文件失败（权限或占用）。',
    hint: '检查路径存在与读权限；不要自动重试。',
  },
  INDEX_WRITE_FAILED: {
    fatal: true,
    message: '写索引失败（临时目录或 rename 失败）。',
    hint: '检查 --out 所在磁盘空间与权限；旧索引已保留。',
  },
  INTERNAL: {
    fatal: true,
    message: '未预期的内部错误。',
    hint: '用 --debug 重跑并把堆栈一并报告（不要只贴 message）。',
  },
}

export class MlirDocsError extends Error {
  constructor(code, { message, hint, details = {}, warnings = [], cause } = {}) {
    const def = CODES[code] || CODES.INTERNAL
    super(message || def.message)
    this.name = 'MlirDocsError'
    this.code = CODES[code] ? code : 'INTERNAL'
    this.def = def
    this.hint = hint === undefined ? def.hint : hint
    this.details = details
    this.warnings = warnings
    this.cause = cause
    this.fatal = def.fatal
  }

  toResponse(debug = false) {
    const body = {
      ok: false,
      code: this.code,
      message: this.message,
      hint: this.hint,
      details: this.details,
      warnings: this.warnings,
    }
    if (debug) body.stack = String((this.cause && this.cause.stack) || this.stack || '')
    return body
  }
}

export function fail(code, message, details = {}, hint, warnings = []) {
  throw new MlirDocsError(code, { message, details, hint, warnings })
}

export function toErrorResponse(err, debug = false) {
  if (err instanceof MlirDocsError) return err.toResponse(debug)
  const internal = new MlirDocsError('INTERNAL', {
    message: `未预期的内部错误：${err && err.message ? err.message : String(err)}`,
    cause: err,
  })
  return internal.toResponse(debug)
}

export function warning(code, message, details = {}) {
  return { code, message, details }
}
