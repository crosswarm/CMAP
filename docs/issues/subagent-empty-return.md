# 问题报告：omc subagent 消耗大量 token 但返回空内容

- 记录日期：2026-08-04
- 状态：**已定位并修复** —— omc 升级 `4.11.2 → 4.15.7`（上游 issue #3209 / #3233）
- 影响：修复前 `product-dev-flow` 的 design/critique 阶段无法依赖 subagent

> 本文件自包含，可在新会话中直接阅读处理，无需上下文。

## 结论（TL;DR）

不是 harness 提取 bug，也不是 agent 定义问题。**omc 4.11.2 的 `SubagentStop` hook 返回了
`hookSpecificOutput.additionalContext`，这段文本被重新注入到正在结束的 subagent，把它从"已结束"
状态又拽回来生成一轮**。agent 说"我已经交付了" → 又停 → hook 又注入 → 循环 6-8 次。
Claude Code 取最后一条 assistant 文本作返回值，主 agent 于是只看到最后那句垃圾话。

完整报告一直都在，就在最后一次 `tool_use` 之后的第一条长文本消息里。

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

最早的线索是第 4 个的返回值 `Full review stands as written`——它认为自己已经写过完整 review 了。事实证明确实写过。

## 根因（已由源码确认）

omc 4.11.2 的 `SubagentStop` hook 挂了两个脚本，**都返回 `hookSpecificOutput.additionalContext`**：

`dist/hooks/subagent-tracker/index.js:553`（4.11.2）
```js
return { continue: true, hookSpecificOutput: {
  hookEventName: "SubagentStop",
  additionalContext: `Agent ${input.agent_type} ${succeeded ? "completed" : "failed"} (${input.agent_id})`,
}}
```

`SubagentStop` 上的 `additionalContext` 会被**重新注入到正在结束的 subagent**，把它从"已结束"拽回来再生成一轮。
于是：agent 交付完整报告 → 试图停止 → hook 注入 → agent 说"我已经交付了" → 又停 → hook 又注入 → 循环 6-8 次。
Claude Code 取最后一条 assistant 文本作返回值，主 agent 只看到最后那句垃圾话。

4.15.7 的源码注释直接点名了这个 bug：

```
* Because it runs on SubagentStop, it does NOT emit
* hookSpecificOutput.additionalContext: that context would be reinjected into
* the finishing subagent (the regression fixed in #3209 / #3233).
```

agent 自己也识破了（`a2a2dc47`、`acdbc98c` 的收尾消息）：

```
01:47:39  重复的系统通知，忽略即可。评审结论已在上面完整呈现
01:48:06  Duplicate system notification. Review was fully delivered above
01:48:10  Already delivered. These are duplicate lifecycle notifications.
```

### 五次复现的实测数据

完整报告**每次都存在**，位于最后一次 `tool_use` 之后：

| transcript | 完整报告长度 | 之后被唤醒 | 最后一条 |
|---|---|---|---|
| `a48ed542` | 12,695 | 7 次 | `Standing by.` |
| `a64d08ba` | 9,652 | 7 次 | `已完成。` |
| `acdbc98c` | 7,020 | 6 次 | `.` |
| `a2a2dc47` | 7,113 | 8 次 | `Nothing new. Full review stands as written.` |
| `a2fdc915` | 12,722 + 4,828 | 6 次 | `Ready for next task.` |

`a2fdc915` 的 4,828 字符那条**就是主动汇总的最终交付**，开头是「审查完成。以下是完整结论。」，
含 `VERDICT: ACCEPT-WITH-RESERVATIONS` 与 13 条逐条裁定。它被后续 6 次唤醒挤出了返回值位置。

这解释了为什么强化 prompt 无效——agent 确实已经完整交付过，它只是不肯把同一份东西说第七遍。

### 两次误判记录（排查时引以为戒）

1. 早先看到 transcript 含 `REJECTED` 11 次，推测「产出了完整裁定但没传回」。核查后发现那些
   `REJECTED` 全部来自 `role: user` 的 `tool_result`（agent 读文件的返回），**不是** agent 的裁定。
2. 随后测得「最长 assistant 消息仅 652 字符」，据此推断「内容被切碎、从未汇总」，并把方向收窄为
   「让 harness 拼接全部 assistant 消息」。该数字是取值路径漏了 content block 所致，
   实测为 12,722 / 4,828。**harness 无需改动，方向是错的。**

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
├── a2a2dc47700c18f57.jsonl   486K  critic 保留决定
└── a2fdc915094ec9b08.jsonl   569K  critic 审查返工闭环（第 5 次复现）
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

**一眼看清全貌**（时间戳 + 长度 + 开头，收尾被唤醒的次数直接可数）：

```bash
jq -r 'select(.type=="assistant") | [(.timestamp//"-")[11:19],
  (([.message.content[]?|select(.type=="text")|.text]|join(""))|length),
  (([.message.content[]?|select(.type=="text")|.text]|join(""))|gsub("\n";"⏎")|.[0:80])] | @tsv' \
  a2fdc915094ec9b08.jsonl | awk -F'\t' '$2>0'
```

**恢复被埋掉的完整报告**：

```bash
# 长度分布，最长的那条就是完整报告
jq -r 'select(.message.role=="assistant") | (.message.content // []) | map(select(.type=="text") | .text) | join("") | length' \
  a2fdc915094ec9b08.jsonl | sort -rn | head -5

# 把超过 3000 字符的都捞出来
jq -r 'select(.message.role=="assistant") | (.message.content // []) | map(select(.type=="text") | .text) | join("")' \
  a2fdc915094ec9b08.jsonl | awk 'length($0) > 3000'
```

⚠️ 两个取值陷阱（本问题排查中各踩过一次）：

- **必须拼接全部 content block**（`[.message.content[]?|select(.type=="text")|.text]|join("")`）。
  只取 `content[0].text` 会漏掉长文本，得出「最长仅数百字符」的错误结论。
- **必须区分消息角色**。`REJECTED` 等关键词常出现在 `role: "user"` 的 `tool_result` 里
  （agent 读文件的返回内容），那**不是** agent 的裁定。

## 原「需要回答的问题」及答案

1. **完整 review 是否存在于中间 assistant 消息里？** 是。位于最后一次 `tool_use` 之后，长度见上表。
2. **在哪一条？是否被覆盖？** 在收尾语之前，被 6-8 条 hook 唤醒产生的短消息挤出返回值位置。
3. **是否与上下文压缩（compact）有关？** 无关，可排除。
4. **升级是否修复？** 是。`4.15.7` 已移除两处 `SubagentStop` 的 `additionalContext`。
5. **是否仅 READ-ONLY 类型受影响？** 不是。hook 的 matcher 是 `*`，**所有 subagent 类型都受影响**，
   只是短任务因唤醒时最后一句仍有内容而不易察觉。

## 相关文件

- 病灶（旧版）：`~/.claude/plugins/cache/omc/oh-my-claudecode/4.11.2/dist/hooks/subagent-tracker/index.js:553`
- 修复版对照：`~/.claude/plugins/cache/omc/oh-my-claudecode/4.15.7/scripts/verify-deliverables.mjs`（注释说明了 #3209 / #3233）
- hook 挂载点：`.../hooks/hooks.json` 的 `SubagentStop`（matcher `*`）
- agent 定义：`.../agents/{architect,critic}.md`
- 受影响的流程：`~/.claude/skills/product-dev-flow/SKILL.md`（其 design/critique 阶段依赖 architect/critic）

## 修复

```
omc update    # 4.11.2 → 4.15.7，需重启 Claude Code 会话生效
```

若某天必须停留在旧版，本地 patch 是把 `dist/hooks/subagent-tracker/index.js` 的 stop 分支
改成 `{ continue: true, suppressOutput: true }`（会被下次 `omc update` 覆盖）。

**通用教训**：任何 `SubagentStop` / `Stop` hook 都不应返回 `hookSpecificOutput.additionalContext`，
那等于把已完成的 agent 重新唤醒。自建 hook 时同理。

### 修复前的绕行（已不需要，存档）

`product-dev-flow` 的 design 与 critique 阶段曾改由主 Claude 自行完成，代价是失去对抗的独立性——
评审者与被评审者是同一个，容易偏袒。`conclusion/temp/pdf-cmap-arch-review/critique.md`
中已显式标注了可能存在偏袒的判断。

另一种事后补救：从保全的 transcript 里把完整报告捞回来（见上方命令），内容是完好的。
第 5 次复现即用此法提取出两项真实发现——`putReview` / `createTaskInternal` 无幂等防护
（已修，commit `9d29e87`）、升级路径测试只断言返回值不查存储状态（已补断言）。
