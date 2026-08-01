# ADR-0003：Agent 输出契约与账本契约分层

- 状态：已接受
- 日期：2026-08-01

## 背景

最初的设计是让 codex 直接产出 `task-result.v1`——即让 Agent 的输出格式等同于账本格式。实测立刻失败：

```
Invalid schema for response_format 'codex_output_schema':
In context=('properties', 'schema'), schema must have a 'type' key.
```

`codex exec --output-schema` 底层走的是 OpenAI structured outputs，其 schema 子集比标准 JSON Schema 严格得多：

| 限制 | 与 `task-result.v1` 的冲突 |
|---|---|
| 每个属性必须有 `type` 键 | 我们用了裸 `const`（如 `"schema": {"const": "..."}`） |
| 所有属性必须列入 `required` | 我们有大量可选字段（`findings`、`error`、`session`…） |
| 不支持 `pattern` / `format` | 我们用 `pattern` 约束 sha256 与 commit SHA |

这不是可以绕过的写法问题，而是两个 schema 服务于**不同目标**：一个要迁就模型供应商的输出能力，另一个要为账本提供严格校验。用同一份必然互相拖累——放松约束会削弱账本校验，收紧则模型根本无法产出。

## 决策

分成两层，并明确各自的权威范围。

**`codex-output.v1`** — 传给 `--output-schema`，遵守 OpenAI structured outputs 子集。只包含 **Agent 有资格陈述的事实**：执行状态、结论摘要、逐条验收结果、证据产物、发现、错误。

**`task-result.v1`** — 账本格式，保持严格。由 Adapter 在 `collectResult` 中合成，随后经 ajv 校验才可入账本。

**身份字段一律由控制面填充，不取 Agent 自述**：`mission_id`、`task_id`、`attempt`、`schema`。账本归控制面所有，Agent 无权自述身份——否则一个行为异常的 Agent 可以把结果写进别的任务名下。

## 由此确立的一条原则：不采信 Agent 自报的证据哈希

分层后 `collectResult` 承担了验证职责，其中最关键的一条是**独立复算 sha256**：

```
读取声明路径的文件 → 复算哈希 → 与 Agent 声明值比对 → 不符即 EVIDENCE_HASH_MISMATCH
```

理由：Agent 完全可能在没有真正写文件的情况下编造一个看起来合理的哈希，或写了文件但内容与声明不符。若照单全收，「证据」就退化成一段自我声明的文本，整个「无证据即失败」的防线随之失效。

同理，文件不存在时报 `EVIDENCE_FILE_MISSING`，而不是当作可选缺失放行。

## 后果

- 新增 Adapter 时需要同时提供「供应商兼容的输出 schema」与「向账本格式的映射」，这是 Adapter SPI 的固有职责，不应泄漏到 Workflow。
- 两份 schema 需保持语义一致；字段增删时必须同步，契约测试应覆盖映射的完整性。
- Agent 的提示词必须明确告知：文件要真写、哈希要真算、控制面会复核。已在 `renderPrompt` 中写明。
- 该分层对 Kimi、YonWork 同样适用——各家结构化输出能力不同，但账本格式只有一个。
