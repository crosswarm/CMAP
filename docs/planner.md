# 外部自然语言 Planner

2026-09-22 再次运行真实 `plan-mission.mjs`，仍返回 `PLANNER_AUTH_REJECTED`，未产生计划。
这项外部认证阻断与语义 Reviewer 尚未实现是两件事：当前 Workflow 仅执行确定性硬门槛评审；
多分支真实执行验证中的 Reviewer 决定是明确标注的合成夹具。

[plan-mission.mjs](../scripts/plan-mission.mjs) 从 stdin 读取现有
[mission-create v1](../schemas/mission-create.v1.schema.json)，调用独立 Claude CLI，
输出同一请求加上经过校验的 `plan`。控制面和 Temporal 不运行模型，不解析自然语言结果。
当前实现已完成本地回归；**Claude 真实模型请求被服务端 403 拒绝，端到端验证未完成**。

```bash
node scripts/plan-mission.mjs < /tmp/request.json > /tmp/planned.json
```

输入保留现有必填字段：`request_id`、`goal`、`acceptance`、`risk_level`，可选预算。
Planner 不改变这些字段；若输入已含有效 `plan`，只做确定性规范化，不调用模型。
输出只含请求和规范化计划，没有 CLI 会话、用量或原始回答。
输入及输出请求均限制为 64KiB，不能把私有请求或输出加入 git。

保留输出后，使用既有 `POST /v1/missions` 提交该 JSON。提交失败时重发**相同输出**，
不要用同一 `request_id` 重新规划；重新规划可能产生不同图，幂等契约会正确拒绝冲突。
Planner 本身不提交 HTTP、不创建任务、不写审批，也不授予权限。
`controlled` 与 `mutating` 节点仍分别经过原有批准闸口。

## 契约与隔离

- [mission-plan v1](../schemas/mission-plan.v1.schema.json) 是单一真相源。
  给 Claude 的 Draft-07 投影从源契约展开引用生成，不手写第二份图定义。
- 只接受 Claude 成功结果的 `structured_output`；拒绝普通文字、无计划结果、非零退出、
  超时和超限输出。随后复用 `normalizeMissionPlan` 校验图、验收覆盖和风险上限。
- 能力与 Agent 信息来自实际 Adapter 的 `discover()` 声明。生成计划中的未知路由或能力不匹配
  被拒绝。声明并不代表 Worker 已注册或当前健康；执行时仍由现有路由做实时核验。
- Claude 使用 `--safe-mode --restricted --strict-mcp-config --tools '' --no-chrome`、
  `--no-session-persistence --permission-mode dontAsk --permission-prompts none`；
  用户目标经 stdin 输入，在私有临时目录运行，不传入仓库或 Vault 正文。
- 最多 3 个 CLI turn，120 秒外层截止；标准输出上限 1MiB。
  进程组取消复用 Codex/Kimi 的同一实现，先 TERM 再 KILL，并观察进程组消失。
  未确认消失时返回 `PLANNER_CANCELLATION_UNCONFIRMED`，不交付计划。

## 2026-09-21 验证与实际阻断

本机 CLI 为 Claude Code 2.1.278；只读取鉴权状态的结果为 loggedIn=true、
authMethod=claude.ai、apiProvider=firstParty。使用上述隔离参数的真实规划调用和两个最小
诊断请求均返回非零退出；服务响应为 `Failed to authenticate. API Error: 403 Request not allowed`。
这是当前观察，不推断为账号失效或网络故障。没有登出、更换凭据、修改账号或绕过服务拒绝。
本地 CLI 会把这类已观测的失败归类为 `PLANNER_AUTH_REJECTED`，不输出服务正文。

本地回归覆盖成功投影、原始请求保留、有效显式计划不调用模型、非法图/字段/风险/路由、
Unicode 跨 stdout 块、认证失败、输出上限、超时与隔离参数。
新行为先用失败测试复现；验证不会把 fake CLI 成功当成真实 Claude 完成。

Node 24.13.0 下 `npm run check` 通过：286 项基础（含 9 项 Planner）、58 项 API、
121 项 Workflow。两个 Adapter 的重复进程组清理函数提取到
[公共模块](../packages/adapter-sdk/src/process-group.ts)，行为不变；真实 Codex 与 Kimi
单跳均完成 3 文件计数，证据哈希一致。Codex 复验曾出现请求超时重连，同一运行最终成功，
没有因观察超时重新派发。这两次成功证明 Adapter 公共函数抽取，不代表 Claude Planner 成功。

Jev `jev-1.13.0` 对外部 CLI 方案给出 external_cli，confidence=0.97、probability=0.99。
模型建议不代替运行证据。恢复 Claude 服务访问后，下一步是生成真实计划，保留输出并通过
现有 API → DAG → Codex/Kimi 执行、回读产物与历史重放，之后才能标记 Planner 桥接已验证。

参考官方契约（2026-09-21 核对）：

- [CLI reference](https://code.claude.com/docs/en/cli-reference.md)
- [Headless execution](https://code.claude.com/docs/en/headless.md)
- [Structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs.md)
