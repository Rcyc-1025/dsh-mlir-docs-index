# dsh-mlir-docs-index

离线检索本地 LLVM/MLIR **23.1.4** 的 op 与 dialect 定义：把 `mlir/include/mlir` 的 TableGen（`.td`）与构建产物里的生成头（`.h.inc`）索引成 5 个 JSON/JSONL 文件，一条命令查 `file:line`、`summary`、`traits/interfaces`、`operands/results/attributes` 与生成头 C++ class。

这是 [DeepSeek Harness](https://github.com/deepseek-ai) 的一个 skill（`SKILL.md`），也完全可以脱离 agent 当普通命令行工具用。**不联网、不调用 mlir-opt、不解析 C++ 语义**，只做文本索引。

## 能回答什么

- `arith.addi` 定义在哪个 `.td` 的第几行？summary 是什么？带哪些 trait？
- 它的 operands / results / attributes 是什么（含 `Variadic`/`Optional` 标记）？
- 它在生成头里对应哪个 C++ class，`class` 行与 `getOperationName()` 行在哪？
- `arith` dialect 的 `name`、`cppNamespace`、定义行，以及它包含哪些 op？
- 同名 op 的多份定义（如 tutorial 里 `toy.add` 在 Ch2–Ch7 各一份）。
- 索引是否过期（源码改过之后），需要时刷新。

## 前置条件

- Node.js ≥ 18（实测 v24.18.0），**零依赖**，不需要 `npm install`。
- 一份 MLIR 源码树（含 `include/mlir`）。
- 可选：MLIR 构建目录的生成头（`<build>/tools/mlir/include/mlir`，含 `*.h.inc`）、`mlir/examples`（tutorial 语料）。

默认语料路径（可用参数或环境变量覆盖）：

| 角色 | 默认路径 | 环境变量 |
| --- | --- | --- |
| source root | `D:/Code/llvm-src/llvm-project-23.1.4.src/mlir/include/mlir` | `MLIR_SRC_ROOT` |
| generated root | `D:/Code/llvm-build/tools/mlir/include/mlir` | `MLIR_GEN_ROOT` |
| examples root | 默认不启用 | `MLIR_EXAMPLES_ROOT` |

## 安装

作为 DSH skill：把整个仓库复制进运行时的 skills 目录即可（脚本用 `import.meta.url` 定位自身，可整体搬迁；只有内置默认语料路径是硬编码的）。

当普通工具用：直接 `node scripts/mlir-docs.mjs ...`，无需安装。

## 快速开始

```bash
git clone https://github.com/Rcyc-1025/dsh-mlir-docs-index.git
cd dsh-mlir-docs-index

# 构建索引（首次约 1.6s，写到 <repo>/index/）
node scripts/mlir-docs.mjs build \
  --source-root "D:/Code/llvm-src/llvm-project-23.1.4.src/mlir/include/mlir" \
  --examples-root "D:/Code/llvm-src/llvm-project-23.1.4.src/mlir/examples" \
  --generated-root "D:/Code/llvm-build/tools/mlir/include/mlir"

# 查 op
node scripts/mlir-docs.mjs query --q arith.addi --kind op --exact

# 查 dialect
node scripts/mlir-docs.mjs query --q arith --kind dialect
```

输出默认是一个 JSON 对象（`--format text` 给人读）。出错时同样是 JSON：`ok:false` + `code` + `hint`；退出码 **成功/无结果 0，致命/参数错误 2**。

## 命令

| 命令 | 作用 | 关键参数 |
| --- | --- | --- |
| `build` | 扫描语料、原子写索引 | `--source-root` `--examples-root` `--generated-root` `--out` `--hash content\|meta` `--force` |
| `status` | 索引是否过期 | `--out` `--deep` |
| `refresh` | 有变化才重建（roots 取自 manifest） | `--out` |
| `query` | 查询 | `--q` `--kind op\|dialect\|any` `--dialect` `--field` `--exact` `--all-variants` `--limit` |

`--out` 只接受 **仓库内的相对路径**（默认 `index`），用于防止误写到任意位置。

示例：按语义关键词找 op，只要 summary/description 计分：

```bash
node scripts/mlir-docs.mjs query --q "overflow" --field summary,description --dialect arith --limit 10
```

更多配方见 [`references/query-cookbook.md`](references/query-cookbook.md)，索引字段见 [`references/schema.md`](references/schema.md)。

## 实测（LLVM/MLIR 23.1.4，Windows）

| 项 | 结果 |
| --- | --- |
| 语料 | 2053 文件 / 120.9MB（.td 363、.h 878、.inc 812） |
| op / dialect | 3578 / 50（confidence：high 1497、medium 925、low 1156） |
| 冷构建 | **1.6s** |
| 索引体积 | **5.07MB** |
| 查询 | P50 ≈ 153ms（含 Node 进程启动） |
| 内存 | 通过 `--max-old-space-size=256` 构建 |

## 验收

```bash
node test/acceptance.mjs
```

逐条跑规格 §13 的 A1–A10：A1–A7、A9、A10 只读真实语料；A8 在 `test/.tmp/` 复制两份 `.td` 做小语料，验证 stale → `INDEX_STALE` 警告 → refresh 闭环，**不会改动 llvm-src / llvm-build**。全过输出 `PASS：66/66`。

## 置信度与已知限制

- `high`：`.td` 有定义 + 生成头 `class` 行与 `getOperationName()` 行双命中 + operands/results 已确定（直接或一层基类继承都算）。
- `medium`：有 `.td`，但生成头缺失/名字对不上/字段未解析。
- `low`：generated-only（只在生成头里出现）。
- 只做**一层**基类字段继承；**不展开 `defm`/multiclass**，这类 op（如 `arm_neon.intr.*`）只从生成头收录为 generated-only。
- 生成头目录通常没有 `mlir-config.h`，因此生成头侧版本标签多为 `unknown`，`VERSION_MISMATCH` 只在两侧都已知且不同时告警。
- 评分里的「源码提及 20 分」用 `tablegenDef` 名命中近似（索引不含全文）。

### 与规格 §4.3 的有意偏离

规格把「operands/results 来自一层基类」记为 medium，但 §13 A1 要求 `arith.addi = high`，而它的 operands 正来自基类 `Arith_IntBinaryOpWithOverflowFlags`。本实现按 A1 执行：一层继承不降置信度，改为在 `unresolved` 记 `fields:inherited`。

## 许可

MIT，见 [LICENSE](LICENSE)。
