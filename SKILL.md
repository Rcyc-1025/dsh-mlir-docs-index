---
name: mlir-docs-index
description: 离线检索本地 LLVM/MLIR 23.1.4 的 op 与 dialect 定义：把 mlir/include/mlir 的 .td、生成头 .h.inc 建成索引，查询 op 名/短名/dialect 时返回 file:line、summary、traits/interfaces、operands/results/attributes 与生成头 C++ class 位置。用于写 MLIR pass、找 op 语义、确认 trait、定位 ODS 定义或生成代码，不联网。
---

# mlir-docs-index

把本地 MLIR 源码树（TableGen `.td`）与构建产物（`.h.inc`）索引成 5 个 JSON/JSONL 文件，然后用一条命令查：

- 某个 op 定义在哪个 `.td` 的第几行、summary/description 是什么；
- 它的 traits、interfaces、operands/results/attributes（含 `Variadic`/`Optional` 标记）；
- 它在生成头里的 C++ class 名与 `class` / `getOperationName()` 所在行；
- 某个 dialect 的 `name`、`cppNamespace`、定义行，以及它包含哪些 op；
- 同名 op 的多个变体（例如 `toy.add` 在 tutorial Ch2–Ch7 各有一份）。

只读本地文件，**不联网、不调用 mlir-opt**。索引来自文本解析，不保证与 C++ 语义完全一致（见「置信度与限制」）。

## 何时使用

- 写/改 MLIR pass、pattern 或 dialect 时，需要确认某个 op 的 `summary`、`traits`、`operands/results` 语义与来源行；
- 想知道某个 op 的 ODS 定义在哪（`.td:line`）、生成头里的 C++ class 叫什么、在哪一行；
- 需要一个 dialect 的 `cppNamespace`、定义行、包含哪些 op；
- 要做离线检索（CI、断网环境、批量脚本）而不想读整个 `mlir/include` 目录树；
- 要在同一台机器上对比多个版本/多份语料的 op 集合（各自 `--out` 一个索引目录）。

## 何时不用

- 问的是 **C++ 实现细节**（某个 pass 怎么实现的、某个方法做了什么）——索引只有 ODS 声明，没有 `.cpp` 实现；
- 问的是 **IR 语义/运行行为**（“这个 op 会不会 fold”“这段 IR 合法吗”）——请用 `mlir-opt`、`mlir-opt --verify-diagnostics` 或实际编译；
- 需要**跨文件全文搜索**（“哪里提到了 X”）——本索引只覆盖 op/dialect 名称与 summary/description/traits，不含 `.cpp` 正文与注释全文；
- 需要 `defm`/multiclass **实例化细节**——本工具不展开 `defm`，这类 op 只能给生成头位置（`confidence: low`）；
- 语料不是本地 LLVM/MLIR 源码树（例如远程仓库、压缩包）——请先自行下载/解压。

## 前置条件

- Node.js ≥ 18（实测 v24.18.0），只用内置模块，无需 `npm install`。
- 本地有一份 MLIR 源码树（要含 `include/mlir`，下称 source root）：
  默认可通过环境变量覆盖，也可每次用 `--source-root` 指定。
- 可选：MLIR 构建目录里的生成头（`<build>/tools/mlir/include/mlir`，含 `*.h.inc`），用于映射 C++ class；
  可选：`mlir/examples`（tutorial 语料，用于看到 `toy.*` 的多个变体）。

本机默认值（脚本内置，可用参数或环境变量覆盖）：

| 角色 | 默认路径 | 环境变量 |
| --- | --- | --- |
| source root | `D:/Code/llvm-src/llvm-project-23.1.4.src/mlir/include/mlir` | `MLIR_SRC_ROOT` |
| generated root | `D:/Code/llvm-build/tools/mlir/include/mlir` | `MLIR_GEN_ROOT` |
| examples root | （默认不启用） | `MLIR_EXAMPLES_ROOT` |

## 快速开始

```bash
# 1) 构建索引（首次约 1.6s；默认写到 <skill>/index/）
node scripts/mlir-docs.mjs build \
  --source-root "D:/Code/llvm-src/llvm-project-23.1.4.src/mlir/include/mlir" \
  --examples-root "D:/Code/llvm-src/llvm-project-23.1.4.src/mlir/examples" \
  --generated-root "D:/Code/llvm-build/tools/mlir/include/mlir"

# 2) 查 op（精确名）
node scripts/mlir-docs.mjs query --q arith.addi --kind op --exact

# 3) 查 dialect
node scripts/mlir-docs.mjs query --q arith --kind dialect

# 4) 索引是否过期
node scripts/mlir-docs.mjs status
```

所有命令默认输出**一个 JSON 对象**，便于程序消费；`--format text` 给人类读的摘要。出错时同样输出 JSON（`ok:false` + `code` + `hint`），**不要解析 stderr**。

## 命令

### `build`

扫描语料并原子写索引（先写 `index.tmp-<pid>/`，逐文件 fsync，再 rename 生效）。

| 参数 | 说明 |
| --- | --- |
| `--source-root DIR` | 必填（或环境变量）。缺/不存在 → `CORPUS_NOT_FOUND` |
| `--examples-root DIR` | 可选；不存在只告警，不失败 |
| `--generated-root DIR` | 可选；不存在降级为 metadata-only 并告警 |
| `--out DIR` | 必须是 **skill 目录内的相对路径**，默认 `index`；会按真实路径（realpath）二次校验，junction/symlink 指向外部同样拒绝 |
| `--hash content\|meta` | 指纹模式，默认 `content`（sha256）；`meta` 只看 size/mtime |
| `--force` | 已有索引时也重建（默认重建同样是全量，`--force` 仅跳过「无变化」提示） |

返回 `counts.files / ops / dialects / generatedOnly / duplicateOpGroups`、`durationMs`、`indexBytes`、`fingerprint`、`versionLabel`、`warnings`。`--format text` 输出与之一致的摘要（`ok`/`version`/`index`/`files`/`ops`/`fingerprint`）。

### `status`

先校验索引完整性：`manifest.json / ops.jsonl / dialects.jsonl / files.jsonl / stats.json` 必须都存在且非空、`schemaVersion` 匹配、`ops.jsonl`/`dialects.jsonl` 行数与 manifest 计数一致；缺文件/损坏 → `INDEX_INCOMPLETE`（退出码 2），索引目录不存在 → `INDEX_MISSING`。校验通过后再对比磁盘 size/mtime 判断是否过期，返回 `ready`、`stale`、`staleFiles`、`counts`、`builtAt`、`versionLabel`。`--deep` 时额外做 sha256 校验（慢）。

### `refresh`

先廉价比较（manifest 记录的 roots + 文件 size/mtime），无变化返回 `upToDate:true`；有变化则做一次全量 `build`。**refresh 只接受 `--out`**，roots 从 manifest 里取（所以不要传 `--source-root` 等）。`--format text` 输出 `upToDate` 与 changed/added/removed 计数。

### `query`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--q TEXT` | （必填，除非给 `--dialect`） | 1–200 字符；空 → `INVALID_QUERY` |
| `--kind op\|dialect\|any` | `any` | 只在 op / dialect / 两者里搜 |
| `--dialect NAME` | — | 过滤 dialect（对 op 与 dialect 都适用） |
| `--field LIST` | `all` | 逗号分隔：`summary,description,traits,interfaces,opName,any` |
| `--exact` | 关 | 只接受名称精确相等（不做 prefix/summary 匹配） |
| `--all-variants` | 关 | 返回同名 op 的全部变体（tutorial 各章） |
| `--limit N` | 10 | 1–50，越界 → `INVALID_ARGUMENT` |

返回：

```json
{
  "ok": true,
  "status": "ok | ambiguous | no-match",
  "query": { "q": "arith.addi", "kind": "op", "exact": true, "dialect": null, "limit": 10, "field": "all" },
  "index": { "versionLabel": "23.1.4", "builtAt": "...", "fingerprint": "sha256:...", "stale": false },
  "total": 1,
  "returned": 1,
  "truncated": false,
  "results": [ { "id": "arith.addi", "dialect": "arith", "tablegenDef": "Arith_AddIOp", "cppClass": "arith::AddIOp", "score": 100, "matchedFields": ["opName"], "summary": "...", "traits": ["..."], "operands": [ { "name": "lhs", "type": "Arith_SignlessIntegerOrIndexLike" } ], "source": { "file": "...ArithOps.td", "line": 271 }, "generated": { "file": "...ArithOps.h.inc", "classLine": 1676, "operationNameLine": 1707 }, "confidence": "high", "variants": [], "unresolved": [] } ],
  "warnings": [],
  "hint": null
}
```

- 短名（不含 `.`）精确命中多个 op 时 `status: "ambiguous"`，`results` 按分数列出候选；用 `--kind op` + 全名或 `--dialect` 收窄。
- 命中 `summary`/`description` 时附 `snippet: { file, startLine, endLine, text }`（约 ±1 行、≤400 字符），不返回整段 description。
- 索引过期时 **仍然返回结果**，同时 `warnings[].code = "INDEX_STALE"`，每条结果带 `stale: true`。

## 查询评分（`score`）

| 分 | 条件 |
| --- | --- |
| 100 | opName / dialect 名精确相等 |
| 95 | 短名精确相等 |
| 80 | opName 前缀 |
| 75 | 短名前缀 |
| 60 | summary 命中 |
| 50 | traits / interfaces 命中 |
| 40 | description 命中 |
| 20 | tablegenDef 名命中（近似「源码提及」） |
| +5 | dialect 过滤命中 |

排序：`score` → `confidence` → source 根优先级（src > examples > generated）→ 路径 → 行号。

## 置信度与限制

- `confidence: "high"`：`.td` 有定义 **且** 生成头里 `class` 行与 `getOperationName()` 行都找到 **且** operands/results 已确定（直接声明或一层基类继承都算）。
  - 这是与规格 §4.3 的一处裁决差异——规格把「字段来自一层基类」定成 medium，但 §13 A1 要求 `arith.addi = high`，而它的 operands 正是来自基类 `Arith_IntBinaryOpWithOverflowFlags`。**裁决：以 §13 验收契约为准（A1 优先），一层继承仍算 high**，并把 `operands:inherited` 记进 `unresolved` 作为提示；README 与 `references/schema.md` 同步写明了该裁决。
- `medium`：有 `.td`，但生成头缺失 / 名字对不上 / 字段仍未解析。
- `low`：generated-only，只在生成头里出现、`.td` 里找不到（典型是 `defm`/multiclass 实例化出来的 op，如 `arm_neon.intr.*`、`arm_sme.intr.*`）。本实现**不展开 defm**，因此这些 op 只能给生成头位置。
- 只做**一层**基类字段继承（与规格一致），更深的继承链不追。
- 版本校验：生成头目录下通常没有 `mlir-config.h`，此时生成头侧 `versionLabel=unknown`，不与源码侧比较，`VERSION_MISMATCH` 只在两侧都已知且不同时告警。
- 只认 `.td` / `.h` / `.inc`；跳过 `.git`、`node_modules`、`.cache`、`CMakeFiles`、`.svn` 与符号链接。
- 不解析 C++ 语义、不展开宏、不读 `.cpp.inc`。

## 错误码

| code | 含义 | 处理 |
| --- | --- | --- |
| `CORPUS_NOT_FOUND` | source root 缺失或不是目录 | 看 `hint` 里的路径与默认值 |
| `CORPUS_EMPTY` | 语料里没有任何 `.td/.h/.inc` | 检查 `--source-root` 层级（应指向 `include/mlir`） |
| `INDEX_MISSING` | 索引不存在 | 先 `build` |
| `INDEX_INCOMPLETE` | 索引文件缺失/行损坏 | `build --force` 重建 |
| `INDEX_STALE` | 索引过期（warning，不致命） | `refresh` 或 `build` |
| `VERSION_MISMATCH` | 源码与生成头版本标签不一致 | 检查 `--generated-root` 是否对应同一版本 |
| `GENERATED_ROOT_MISSING` | 生成头目录不存在（warning） | 可忽略，op 只有 `.td` 信息 |
| `INVALID_QUERY` | `--q` 为空或超 200 字符 | 给 1–200 字符 |
| `INVALID_ARGUMENT` | 未知/重复参数、越界 | `hint` 给合法范围 |
| `PARSE_PARTIAL` | 部分文件解析失败（warning） | 结果仍可用，`warnings` 列出文件 |
| `OUTPUT_LIMIT` | 输出超过上限 | 收紧 `--limit` / `--field` |
| `IO_ERROR` | 读盘失败 | 检查路径与权限 |
| `INDEX_WRITE_FAILED` | 写索引失败（含 rename） | 检查 `--out` 是否在 skill 目录内、磁盘空间 |
| `INTERNAL` | 未预期异常（`--debug` 带栈） | 带 `--debug` 复现并报告 |

退出码：成功或无结果 `0`；致命错误与参数错误 `2`。

## 安装（DSH skill）

把整个 `mlir-docs-index/` 目录放进运行时的 skills 目录即可（不同 DSH 版本的全局 skills 位置不同；本仓库交付时**未**改动 DSH 安装目录）。脚本用 `import.meta.url` 定位自身，因此整个目录可以整体复制/移动，不依赖绝对路径；只有内置的默认语料路径是硬编码的，建议用参数或环境变量覆盖。

## 验收

```bash
node test/acceptance.mjs
```

逐条跑规格 §13 A1–A10：A1–A7、A9、A10 只读真实语料；A8 在 `test/.tmp/` 下复制两份 `.td` 做小语料，验证 stale → warning → refresh 闭环，不会改动 `llvm-src` / `llvm-build`。另含 B1–B6 回归（junction 逃逸、损坏索引 status、`--format text`、`cppClass`/`tablegenDef`、dialect `opCount`）。全过输出 `PASS：80/80`，退出码 0。

字段与文件格式详见 `references/schema.md`，常用查询配方见 `references/query-cookbook.md`。
