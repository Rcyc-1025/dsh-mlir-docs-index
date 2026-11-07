# 查询配方（query cookbook）

所有命令都在 skill 目录下执行；`--format text` 给人看，默认 JSON 给程序用。下面示例假设已 `build` 过。

## 1. 已知 op 全名，要定义行、summary、traits

```bash
node scripts/mlir-docs.mjs query --q arith.addi --kind op --exact
```

读 `results[0].source`（`.td` 的 `file:line`）、`summary`、`traits`、`operands`、`generated`（`.h.inc` 的 `classLine` / `operationNameLine`）。

## 2. 只记得短名（`addi`、`for`、`func`）

```bash
node scripts/mlir-docs.mjs query --q addi --kind op
node scripts/mlir-docs.mjs query --q for --kind op --dialect scf
```

短名精确命中多个时 `status: "ambiguous"`，`results` 已按分数排序；加 `--dialect` 或用全名收窄。

## 3. 按语义关键词找 op（不知道名字）

```bash
node scripts/mlir-docs.mjs query --q "overflow" --field summary,description --dialect arith
node scripts/mlir-docs.mjs query --q "tensor contraction" --field description --limit 20
```

命中 description 时返回 `snippet`（命中行 ±1 行），不返回全文。`--field` 只影响计分字段，能显著减少噪声。

## 4. 找某个 trait / interface 的 op

```bash
node scripts/mlir-docs.mjs query --q Commutative --field traits --limit 50
node scripts/mlir-docs.mjs query --q LoopLikeOpInterface --field interfaces --limit 20
```

`traits` 保留模板原文（如 `DeclareOpInterfaceMethods<InferIntDivisibilityOpInterface>`），`interfaces` 是抽出的纯接口名。

## 5. 查 dialect 本身

```bash
node scripts/mlir-docs.mjs query --q arith --kind dialect
node scripts/mlir-docs.mjs query --q gpu --kind dialect --exact
```

返回 `name`、`cppNamespace`、`descriptionSnippet`、`source`、`opCount`、`opNames`（最多 500）。

## 6. 生成头的 C++ class

```bash
node scripts/mlir-docs.mjs query --q scf.for --kind op --exact --format text
```

JSON 里看 `generated` / `cppClass`。`null` 说明生成头不可用（未给 `--generated-root`、或该 op 只存在于 `.td`）。

## 7. 同名 op 的多个变体（tutorial）

```bash
node scripts/mlir-docs.mjs query --q toy.add --kind op --all-variants
```

`variantCount` 是定义份数；`variants[]` 给出每份的 `source.file/line`、`variant`（如 `toy/Ch3`）、`variantKind: "tutorial"`，`representative: true` 的那条是默认代表项。

## 8. 确认索引是否过期 / 刷新

```bash
node scripts/mlir-docs.mjs status            # stale、staleFiles、counts
node scripts/mlir-docs.mjs status --deep     # 逐文件 sha256（慢）
node scripts/mlir-docs.mjs refresh           # 有变化才重建
```

`query` 在过期索引上仍然工作，只是每条结果带 `stale: true`、`warnings[].code = "INDEX_STALE"`。

## 9. 换一套语料（另一份 LLVM / 另一个构建目录）

```bash
MLIR_SRC_ROOT=/opt/llvm/include/mlir \
MLIR_GEN_ROOT=/opt/llvm-build/tools/mlir/include/mlir \
node scripts/mlir-docs.mjs build --out index-opt
```

`--out` 只能是 skill 目录内的相对路径（安全限制），多个索引用不同子目录即可。

## 10. 在脚本/CI 里用

```js
import { spawnSync } from 'node:child_process'
const r = spawnSync(process.execPath, [
  'scripts/mlir-docs.mjs', 'query', '--q', 'arith.addi', '--kind', 'op', '--exact', '--format', 'json',
], { encoding: 'utf8' })
const res = JSON.parse(r.stdout)
if (!res.ok) throw new Error(`${res.code}: ${res.hint}`)
```

约定：**成功或无结果退出码 0，致命/参数错误 2**；错误一律是 JSON（`ok:false` + `code` + `message` + `hint`），别去解析 stderr。

## 11. 常见坑

| 现象 | 原因 / 处理 |
| --- | --- |
| `INDEX_MISSING` | 还没 build，或 `--out` 指错了目录 |
| `CORPUS_NOT_FOUND` | `--source-root` 应指向 `.../mlir/include/mlir`，不是 `.../mlir` |
| `id` 里的 dialect 为空 | 该 `.td` 没有 dialect def、include 也没链到，且目录名不可映射；用 `--q <短名>` 直接找 |
| 查不到 `arm_neon.intr.*` | 这些是 `defm` 实例化出来的 op，本索引只从生成头收录（`confidence: low`，`source: null`） |
| 结果太多 | 加 `--dialect`、`--field summary,description`、`--limit` |
| 版本对不上 | 看 `status --format json` 的 `versionLabel`；`VERSION_MISMATCH` 只在两侧标签都已知时出现 |
