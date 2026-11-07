# 索引文件格式（schemaVersion 1）

索引落在 `<skill>/index/`（可用 `--out` 改成 skill 内的其它相对目录），共 5 个文件：

```
index/
  manifest.json    构建元信息、roots、指纹、计数
  ops.jsonl        op 记录，一行一个，按 id 升序
  dialects.jsonl   dialect 记录，一行一个，按 id 升序
  files.jsonl      语料文件记录（用于 stale 判定）
  stats.json       构建统计与告警汇总
```

写入是原子的：先写 `index.tmp-<pid>/` 并逐文件 fsync，再把旧 `index/` 改名为 `index.bak-<pid>`，最后 rename 新目录；rename 失败会尝试恢复旧目录。因此失败时不会留下半个索引。

## manifest.json

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | number | 当前为 `1`；格式不兼容时递增 |
| `versionLabel` | string | 源码侧版本标签（`mlir-config.h` → 路径名 → `unknown`） |
| `versionSource` | string | 标签来源：`config-h` / `path-name` / `unknown` |
| `sourceVersionLabel` | string | 同 `versionLabel`（显式命名，便于生成头对照） |
| `generatedVersionLabel` | string | 生成头侧标签；通常 `unknown`（生成头目录一般没有 `mlir-config.h`） |
| `sourceRoot` | string | 构建时用的源码根（绝对路径） |
| `examplesRoot` | string \| null | 构建时用的 examples 根 |
| `generatedRoot` | string \| null | 构建时用的生成头根；`null` 表示 metadata-only |
| `fileCounts` | object | `{ td, h, inc, total }` |
| `fingerprint` | string | `sha256:` 前缀；`content` 模式对每个文件 `relPath|size|sha256` 排序后再 sha256；`meta` 模式用 size/mtime |
| `builtAt` | string | ISO 时间 |
| `buildDurationMs` | number | 构建耗时 |
| `hashMode` | `content` \| `meta` | 指纹模式 |
| `counts` | object | `{ ops, dialects, generatedOnly, duplicateOpGroups }` |

## ops.jsonl

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `<dialect>.<mnemonic>`，如 `arith.addi`；无 dialect 时就是 mnemonic |
| `kind` | `"op"` | |
| `opName` | string | 同 `id` |
| `shortName` | string | `id` 最后一个 `.` 之后的部分（短名查询用） |
| `dialect` | string \| null | dialect 名；`null` 表示没解析出来 |
| `tablegenDef` | string \| null | `.td` 里的 `def` 名，如 `Arith_AddIOp` |
| `cppClass` | string \| null | 生成头类名（带 cppNamespace），如 `arith::AddIOp`；只在生成头命中时非 null |
| `summary` | string \| null | `let summary = "..."`（跨行已合并） |
| `description` | string \| null | `let description = [{...}]` 去公共缩进后的文本；超过 8KB 截断 |
| `descriptionTruncated` | boolean | description 是否被截断 |
| `descFirstLine` | number \| null | description 首字符所在行（snippet 的行号基准） |
| `operands` | array \| null | `[{ name, type, variadic, optional }]`；`null` 表示未声明/未解析 |
| `results` | array \| null | 同上；`[]` 表示显式声明为空 |
| `attributes` | array | 与 operands 同结构，收纳 `...Attr` 类参数（如 `overflowFlags`） |
| `traits` | string[] | trait 模板原文（如 `Commutative`、`DeclareOpInterfaceMethods<InferIntDivisibilityOpInterface>`） |
| `interfaces` | string[] | 从 traits 里抽出的接口名（如 `LoopLikeOpInterface`） |
| `regions` | number \| null | `let regions = (region ...)` 的 region 数 |
| `variadic` | boolean | 是否有 variadic operand |
| `source` | object \| null | `{ file, line, endLine, kind: "td" }`；generated-only 时为 `null` |
| `generated` | object \| null | `{ file, classLine, operationNameLine, kind: "h.inc" }` |
| `variants` | array | 同名 op 的所有定义（多于 1 条时才非空）：`{ source, variant, variantKind, representative }` |
| `variantCount` | number | 定义总数（含代表项） |
| `confidence` | `high` \| `medium` \| `low` | 见下节 |
| `unresolved` | string[] | 未解析项提示，如 `fields:inherited`、`generated:missing`、`source:generated-only` |
| `matchedFields` | string[] | 预留字段（构建后为空，查询时由查询层填充） |

### confidence 判据

| 值 | 条件 |
| --- | --- |
| `high` | 有 `.td` 定义 + `generated.classLine` 与 `generated.operationNameLine` 都命中 + `operands` 与 `results` 均非 `null`（直接声明或一层基类继承都算） |
| `medium` | 有 `.td`，但生成头缺失/名字对不上，或字段仍未解析 |
| `low` | generated-only（`.td` 里找不到），此时 `source: null`、`unresolved` 含 `source:generated-only` |

**与规格 §4.3 的偏离（有意）**：规格把「operands/results 来自一层基类」记为 medium，但 §13 A1 要求 `arith.addi = high`，而它的 operands 恰好来自基类 `Arith_IntBinaryOpWithOverflowFlags`。本实现按 A1 执行：一层基类继承不降置信度，改为写 `unresolved: ["fields:inherited"]`。toy 系列没有生成头，所以是 `medium`。

### variants

- 同一 `id` 在多个 `.td` 出现时，`variants` 才非空，并按「source > examples > generated → 路径 → 行号」选代表项。
- `variant`：examples 下为 `toy/Ch2`（取 `examples/<x>/<y>`），其它为 `<root>:<relPath>`。
- `variantKind`：`tutorial`（examples 根）或 `duplicate`（同一源码树里的重复定义）。
- 只有一个定义时 `variants: []`、`variantCount: 1`；`--all-variants` 只在有多变体时有意义。

## dialects.jsonl

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` / `name` | string | dialect 名，如 `arith` |
| `kind` | `"dialect"` | |
| `cppNamespace` | string \| null | 如 `::mlir::arith` |
| `summary` | string \| null | 通常为 null（多数 dialect 只写 description） |
| `description` | string \| null | 全文（供查询时切片） |
| `source` | object | `{ file, line, endLine, kind: "td" }` |
| `generated` | null | 预留（dialect 不做生成头映射） |
| `opCount` | number | 该 dialect 下的 op 数 |
| `opNames` | string[] | 该 dialect 的 op id，最多 500 条（超出时置 `opNamesTruncated: true`） |

注意 `buildDialectAliases` 只在构建期用于把目录名/def 前缀映射到 dialect 名（`OpenACC/` → `acc`，`LLVMIR/` → `llvm`/`rocdl`/`nvvm`），不会写进索引。

## files.jsonl

| 字段 | 说明 |
| --- | --- |
| `path` | 绝对路径 |
| `relPath` | 相对各根的前缀路径：`src/...` / `examples/...` / `generated/...` |
| `kind` | `td` \| `h` \| `inc` |
| `size` | 字节数 |
| `mtimeMs` | 修改时间（毫秒） |
| `sha256` | `content` 模式下的内容摘要；`meta` 模式为 `null` |
| `parseStatus` | `ok` \| `partial` \| `skipped`（非 `.h.inc` 的 `.inc` 记 `skipped`） |
| `warnings` | 该文件的解析告警（字符串数组） |

`stale` 判定：拿 `files.jsonl` 逐条 stat，比较 `size` 与 `mtimeMs`；不等即 stale，并给出 `reason: "size/mtime"`。`--deep` 时再比 sha256（`reason: "sha256"`）。

## stats.json

`totalFiles` / `parsedFiles` / `skippedFiles` / `opCount` / `dialectCount` / `generatedOnlyCount` / `duplicateOpGroups` / `opCountByConfidence` / `buildDurationMs` / `warnings`（最多保留前若干条）。

## 查询层的派生行为

| 行为 | 规则 |
| --- | --- |
| `score` | 100 全名精确 / 95 短名精确 / 80 全名前缀 / 75 短名前缀 / 60 summary / 50 traits\|interfaces / 40 description / 20 tablegenDef / +5 dialect 过滤 |
| 排序 | `score` → `confidence` → source 根优先级 → 路径 → 行号 |
| `ambiguous` | `--q` 不含 `.` 且短名精确命中多个 op |
| `snippet` | 命中 summary/description 时附带：以命中行为中心取 ±1 行、≤400 字符（description 片段 ≤300 字符） |
| `descriptionSnippet` | dialect 命中 description 时截前 300 字符 |
| `stale` | 每条结果带 `stale: true` 与 `staleReason: "INDEX_STALE"`；同时写进 `warnings` |
| `OUTPUT_LIMIT` | 结果总字符超过上限时截断并置 `truncated: true` |

「源码提及（20 分）」在规格里指跨文件搜索，本实现的索引不含全文，用 `tablegenDef` 名命中近似替代，故分数语义略有收窄。
