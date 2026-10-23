# 外部自然语言 Planner

2026-10-23 在本机重新运行真实 `plan-mission.mjs`，成功产出合法计划（见文末「2026-10-23 复验」）。
此前 2026-09-21/22 两次 `PLANNER_AUTH_REJECTED`（服务端 403）未能在脚本侧复现，也未改动脚本。
语义 Reviewer 尚未实现：当前 Workflow 仅执行确定性硬门槛评审；
多分支真实执行验证中的 Reviewer 决定是明确标注的合成夹具。

[plan-mission.mjs](../scripts/plan-mission.mjs) 从 stdin 读取现有
[mission-create v1](../schemas/mission-create.v1.schema.json)，调用独立 Claude CLI，
输出同一请求加上经过校验的 `plan`。控制面和 Temporal 不运行模型，不解析自然语言结果。
当前实现已完成本地回归；真实模型请求已于 2026-10-23 成功一次，但尚未走完 API → DAG → Codex/Kimi 执行的端到端验证。

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

## 2026-10-23 复验与 403 排查

结论：**脚本侧没有可修的问题，403 属于当时的服务端/账号侧状态，现已不再出现；确切原因无法确认。**

排查过程（只读，零额度或最小额度）：

- 脚本启动 Claude 的参数为 `--safe-mode --restricted --strict-mcp-config --tools '' --no-chrome
  --no-session-persistence --permission-mode dontAsk --permission-prompts none -p --output-format json
  --json-schema ... --max-turns 3`。没有使用 `--bare`（`--bare` 会跳过 keychain、读不到 OAuth 订阅凭据，
  但本脚本不涉及），没有清空 HOME 或环境变量（`spawn` 继承父进程环境），未指定模型名，使用账号默认模型。
  所以「`--bare` / 清空环境 / 模型名不可用」这几个假设均不成立。
- 本机 CLI 为 Claude Code 2.1.299（2026-09-21 时为 2.1.278）；`claude auth status`：loggedIn=true、
  authMethod=claude.ai、subscriptionType=max、apiProvider=firstParty。
- 用同样的隔离参数组合（含 `--permission-prompts none`）发一句最小请求，均正常返回；单独用 `--safe-mode`、
  不带任何限制参数也正常。即这些参数本身不触发 403。
- 以一份 `read-meta` 的最小 Mission 请求从 stdin 直接运行 `node scripts/plan-mission.mjs`，退出码 0，
  输出经 `normalizeMissionPlan` 与 Adapter 能力/路由校验，得到 1 个节点的计划
  （`code.analyze`，preferred_agent=codex，fallback=kimi）。

可能的因素（均为推测，未验证）：CLI 升级后修复了某类请求头/客户端判定，或服务端对该订阅会话的临时限制已解除。
没有登出、换凭据或绕过任何服务拒绝。

仍未完成：将该计划经 `POST /v1/missions` 提交并走完 Codex/Kimi 执行、回读产物与历史重放。
完成前不得把 Planner 桥接标记为端到端已验证。
