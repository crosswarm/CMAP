# 问题报告：omc subagent 消耗大量 token 但返回空内容

- 记录日期：2026-08-04
- 状态：**未解决**，需专项排查
- 影响：`product-dev-flow` 的 design/critique 阶段无法依赖 subagent，只能由主 Claude 自行完成，削弱了对抗评审的独立性

> 本文件自包含，可在新会话中直接阅读处理，无需上下文。

## 现象

在 CMAP 架构评审（`run_id: pdf-cmap-arch-review`）中，通过 Agent 工具派发 4 个 omc subagent 做架构评审与对抗批判。**四个全部失败**：各自消耗 10-14 万 token、跑了 21-30 次工具调用、耗时 5-12 分钟，但**最终返回值只有一句话**。

| # | agentId | 类型 | tokens | tool_uses | 耗时 | 最终返回 |
|---|---|---|---|---|---|---|
| 1 | `a48ed542d64c464c3` | `oh-my-claudecode:architect` | 129,828 | 27 | 363s | `Standing by.` |
| 1b | 同上（追问后） | 同上 | 142,408 | 14 | 266s | `完成。` |
| 2 | `a64d08ba43849b710` | `oh-my-claudecode:architect` | 126,376 | 21 | 431s | `在这里，等你下一步。` |
| 2b | 同上（追问后） | 同上 | 132,723 | 21 | 720s | `已完成。` |
| 3 | `acdbc98cd8dd35a1e` | `oh-my-claudecode:critic` | 102,466 | 23 | 316s | `.` |
| 4 | `a2a2dc47700c18f57` | `oh-my-claudecode:critic` | 114,349 | 30 | 322s | `Nothing new. Full review stands as written.` |

累计约 **74.8 万 token**，零可用产出。

## 关键线索

**第 4 个的返回值 "Full review stands as written" 暗示它认为自己已经写过完整 review 了。**

保全的 transcript 中确实含有我在 prompt 里要求的输出结构关键词：

```
a48ed542d64c464c3.jsonl  含「裁决/逐项/总判」 8 处
a2a2dc47700c18f57.jsonl  含「裁决/逐项/总判」 3 处
```

（注意：部分命中可能来自 prompt 自身的回显，需要在排查时区分。）

**最可能的假设：agent 在中间某条 assistant 消息里产出了完整内容，但 harness 只把最后一条消息作为返回值传回主 agent。**

## 已排除的原因

**不是 agent 定义要求简短输出。** 检查 `~/.claude/plugins/cache/omc/oh-my-claudecode/4.11.2/agents/architect.md`（122 行），其 `<Output_Format>` 段要求非常详细的结构化输出：

```
## Summary / ## Analysis / ## Root Cause / ## Recommendations
## Trade-offs（表格）/ ## References（file:line）
```

`<Final_Checklist>` 也要求「every finding cites a specific file:line」。定义本身与观察到的行为完全相反。

## 已尝试且无效的措施

1. **用 SendMessage 追问**，明确告知「你的最终文本消息就是唯一交付物，我看不到中间过程」，并重申完整输出格式 → 两个 agent 追问后仍返回 `完成。` / `已完成。`
2. **在 prompt 开头加 ⚠️ 首要约束**：「绝不要以『完成』『standing by』这类话收尾——那等于交付了空白」 → 第 3、4 个 agent 仍然返回 `.` 和一句话
3. 同时提供量化事实供 agent 交叉验证或反驳，降低其"无话可说"的可能 → 无效

## 排查材料

四份完整 transcript 已保全（原始文件在 `/private/tmp` 下会被清理）：

```
~/Studio/CMAP/conclusion/temp/subagent-failure/
├── a48ed542d64c464c3.jsonl   677K  architect 精简视角
├── a64d08ba43849b710.jsonl   602K  architect 扩展性视角
├── acdbc98cd8dd35a1e.jsonl   434K  critic 必改项
└── a2a2dc47700c18f57.jsonl   486K  critic 保留决定
```

该目录已被 `.gitignore` 排除，不会入库。

**⚠️ 不要用 `cat` / `Read` 直接读这些文件——单行最长约 5.7 万字符，会撑爆上下文。**

安全的检查方式（只取结构与长度，不输出正文）：

```bash
cd ~/Studio/CMAP/conclusion/temp/subagent-failure

# 每行的类型与长度分布
jq -r '[.type // "?", (.message.role // "-"), (. | tostring | length)] | @tsv' a48ed542d64c464c3.jsonl | head -40

# 只看 assistant 文本消息的长度，定位最长的那条
jq -r 'select(.message.role=="assistant") | [.message.content[]? | select(.type=="text") | (.text | length)] | add // 0' a48ed542d64c464c3.jsonl

# 确认最后一条 assistant 消息的内容（应该就是那句空话）
jq -r 'select(.message.role=="assistant") | [.message.content[]? | select(.type=="text") | .text] | join("")' a48ed542d64c464c3.jsonl | tail -c 500
```

## 需要回答的问题

1. **完整 review 是否真的存在于某条中间 assistant 消息里？** 若是，则问题在返回值提取，而非 agent 本身。
2. 若内容确实存在，是哪一条消息、位于什么位置？是否紧接着又被一条收尾消息覆盖？
3. 是否与 **上下文压缩（compact）** 有关？这些 agent 都消耗了 10 万+ token，接近或超过某个阈值时可能触发压缩，导致最终消息退化为摘要式的收尾语。
4. 是否与 `oh-my-claudecode` 的版本有关？当前 `4.11.2`，而系统提示过有 `v4.15.7` 可用（`omc update`）。升级是否修复？
5. 其他 subagent 类型（如内置 `Explore` / `Plan`，或 `oh-my-claudecode:executor`）是否有同样问题？还是仅 READ-ONLY 类型（architect/critic 的 `disallowedTools: Write, Edit`）受影响？

第 5 点值得优先验证——如果只有 READ-ONLY 类型受影响，可能与「agent 想写文件但被阻止，于是把结果放在别处」有关。

## 相关文件

- agent 定义：`~/.claude/plugins/cache/omc/oh-my-claudecode/4.11.2/agents/{architect,critic}.md`
- marketplace 副本：`~/.claude/plugins/marketplaces/omc/agents/`
- 受影响的流程：`~/.claude/skills/product-dev-flow/SKILL.md`（其 design/critique 阶段依赖 architect/critic）

## 临时绕行方案

在问题解决前，`product-dev-flow` 的 design 与 critique 阶段由主 Claude 自行完成。**代价是失去了对抗的独立性**——评审者与被评审者是同一个，容易偏袒。本次评审已在 `conclusion/temp/pdf-cmap-arch-review/critique.md` 中显式标注了可能存在偏袒的判断。
