# ADR-0009：额度感知调度与交接

- 状态：已接受（方向由 Cross 于 2026-10-23 决定）；实现情况见文末「实现状态」
- 日期：2026-10-23
- 相关：[ADR-0007](0007-jev-delegated-decisions.md)（Jev 委托决策）、[ADR-0008](0008-multi-user-control-plane.md)（多用户）、[mission-continuity](../mission-continuity.md)（续接）

## 场景

某个 Agent 的分时额度（如 5 小时窗口）或周额度快用完时，由一个可切换的调度者把任务分给其他 Agent；任务完成或额度恢复后，后续任务再交回原 Agent。

## 已核实的事实（2026-10-23）

| | 零额度读取 | 运行中信号 | 触顶特征 |
|---|---|---|---|
| Codex 0.159.2 | `codex app-server` 的 `account/rateLimits/read`（实测）：`ordinaryUsageAllowed`、`primary/secondary{usedPercent, windowDurationMins, resetsAt}`、credits、`planType` | `exec --json` 无额度事件；`--ephemeral` 不写 rollout | 退出码 1；文本 “You’ve hit your usage limit …”（弯撇号）或 “Quota exceeded …”；app-server 有结构化 `usageLimitExceeded` |
| Claude Code 2.1.299 | `claude -p` stream-json 控制请求 `get_usage`（实测，实验性接口）：`five_hour/seven_day{utilization, resets_at}`、`limits[]` | `rate_limit_event{status: allowed / allowed_warning / rejected, resetsAt, rateLimitType, utilization}` | assistant `error: "rate_limit"` 且事件 `status: rejected` |
| Kimi Code 2.2.0 | `/usages` 接口（源码确认，本机未实测：本地服务需认证） | 无 | HTTP 429 + `exceeded_current_quota_error` 或额度文案 |

- 三家额度都按**账号**在服务端统计；同一账号在 CrossMini 与 lap 上共享一个额度池（官方表述与数据结构推断，未跨机实测）。
- 当前 Codex 账号只有 7 天窗口，没有 5 小时窗口；周额度在 10 月 22 日曾达 84%。
- 触顶时三家退出码都是 1，不能靠退出码区分；必须按文本或结构化码分类。
- 判断"额度已恢复"以 `resetsAt` 为准并重新探测；Codex 的 `ordinaryUsageAllowed` 为 null 时不得推断已恢复。

## 决策

### 1. 额度快照（账号级）

- 额度池的键是 `(owner, provider, account_ref)`，不是机器。
- 探针在持有凭据的 runner 主机上执行（CMAP 不持有提供方凭据），零额度：Codex 用 app-server、Claude 用 `get_usage`；Kimi 先标为"未知"。
- runner 在健康应答中附带最新快照；控制面派发前读取，过期（默认 5 分钟）即重新探测。快照落账，供路由与审计。
- 读不到或读失败一律视为"未知"。**只跳过已知额度不足的候选；未知不改变首选顺序**（修订：原写"未知排在已知充足之后"，会让读不到额度的首选，如 Kimi，被替补抢走任务；未知者若实际已触顶，由 `QUOTA_EXHAUSTED` 续接兜底）。

### 2. 路由增加额度维度

- 候选的已用比例 ≥ 阈值（默认 90%，可配置）或提供方明确不允许普通用量时，标记 `skipped(quota_low)`，按 `fallback_agents` 或调度者（见 4）改派。
- `ROUTING_DECIDED` 记录每个候选的额度判定与快照时刻。
- 额度只影响**尚未派发**的任务。已绑定的任务不迁移（沿用"不自动二次派发"）。

### 3. 触顶分类与续接交接

- Adapter 把明确的额度耗尽归一为错误类别 `QUOTA_EXHAUSTED`，与普通失败、`EXECUTION_UNCERTAIN` 区分：前者是 Agent 自己确认已停止，后者是状态未知。只有前者可以安全交接。
- 任务以 `QUOTA_EXHAUSTED` 结束时，派生**续接任务**（`supersedes_task_id` 指向原任务，`previous_attempt` 携带原任务已产出、已复核的产物与失败原因），按第 2 条重新路由到其他 Agent。续接不消耗返工预算，但每条链路有续接次数上限（默认 2），超限升级给人。
- 只读级任务（read-meta、read-sensitive）新开工作区即可。有写副作用的任务，续接前必须证明原 Agent 已退出（进程组终止、运行记录完结）；续接任务以原工作区的快照（git 提交或打包，作为冻结输入）继续，**不共享可写工作区**。
- 续接任务的 controlled/mutating 审批**重新走闸口**：原审批绑定的是原任务。ADR-0007 的 enforce 开启后，可由委托策略内的 Jev 代批。

### 4. 可切换的调度者

- 确定性底座先算出合法候选集：能力、风险、准入、健康、额度、owner 亲和（ADR-0008）。候选为空就升级给人；只有一个候选时不调用调度者。
- 调度者从配置的列表中选第一个可用且额度充足的（例如 `jev → claude → kimi`），**调度者自己额度低时自动换下一个**；全部不可用时用确定性默认顺序。
- 调度者只能在候选集内挑选，不能越过任何确定性约束。决定在 Activity 中产生并落账，复用 `jev-decision.v1` 的 `routing` 类型；新增 `decider` 字段记录由谁决定。Workflow 重放读取已落账的结果。
- 调度者看不到 Agent 产出的自由文本，只看任务的可信字段与各候选的额度、健康摘要（同 ADR-0007 的防注入规则）。

### 5. 交回

- 额度恢复判定：`resetsAt` 已过，**且**重新探测显示允许普通用量、已用比例低于阈值。
- 恢复后，新任务按 `preferred_agent` 自然派回原 Agent；在跑的续接任务不打断，完成后 DAG 的后续节点按首选派回。"交回"是恢复后续派发的首选，不迁移在跑任务。
- 交接与交回都记事件（`QUOTA_HANDOFF`、`QUOTA_RESTORED`），WebUI 显示每个账号的额度与交接链路。

## 不做

- 不在执行中途主动打断任务：会话上下文无法转移，主动停止只会制造更多半成品。阈值告警只用于派发前改派。
- 不跨 owner 借用额度：A 的任务不派到 B 的账号（ADR-0008 的 owner 亲和）。
- 不根据百分比与重置时间自行推断恢复：必须重新探测。

## 验证计划

- 单测与 Workflow 测试：假探针返回不同额度；假 CLI 以三家各自的触顶文本或结构化码结束。
- 真实零额度探针：Codex、Claude 各探测一次，快照字段与本 ADR 一致。
- 全链路（真实 Temporal）：
  1. A 额度低时，新任务派给 B；
  2. A 的任务中途触顶，由 B 续接完成，链路与产物可追溯；
  3. A 额度恢复后，新任务派回 A。

  其中 Agent 的触顶用假 CLI 模拟（不真的耗尽额度），其余环节用真实 Codex。

## 残余风险

- Claude 的 `get_usage` 是实验性接口，Codex 的触顶文本可能改动：分类器要有版本与回归样例，识别不了的按普通失败处理（不续接），宁可少交接也不误重跑。
- 额度快照有延迟：快照显示充足、实际已触顶时，任务会以 `QUOTA_EXHAUSTED` 结束，再由续接兜底。

## 实现状态（2026-10-23）

| 条目 | 状态 | 落点 |
|---|---|---|
| §1 额度快照、§2 路由额度维度、§3 触顶分类 | ✅ | Q01–Q03（`packages/adapter-sdk/src/quota-probe.ts`、`workflows/activities.ts` 的 `selectAdapter`、各 Adapter 的 `QUOTA_EXHAUSTED`） |
| §3 续接交接 | ✅ dag/v1 | `handoffQuotaExhausted`（`workflows/dag-activities.ts`）、`materializeQuotaHandoff`（`workflows/dag-materialization.ts`），补丁 `dag-quota-handoff-v1`；事件 `QUOTA_HANDOFF`（[quota-handoff.v1](../../schemas/quota-handoff.v1.schema.json)）。续接任务与原任务同轮，不耗返工预算；派发时排除 `excluded_agents`（原 Agent 及本链路此前触顶者），记 `skipped(quota_handoff_excluded)`。写副作用级先复核「结果已落账 + Adapter 观测到终态」，再把原工作区（不含 `inputs/` 与符号链接）打包为 `workspace_snapshot` 冻结输入、在新工作区解包；审批绑定新任务重新走闸口。每节点上限 `CMAP_QUOTA_HANDOFF_LIMIT`（默认 2），超限 `QUOTA_HANDOFF_LIMIT`，退出无法确认 `QUOTA_HANDOFF_EXIT_UNCONFIRMED`。Agent 自报的 `QUOTA_EXHAUSTED` 改记 `AGENT_REPORTED_QUOTA_EXHAUSTED`，不触发换 Agent。inspect/v1 未接入 |
| §4 可切换调度者 | ✅ | `workflows/dispatchers.ts`，`CMAP_DISPATCHERS=jev,claude`（未配置即纯确定性）；决定记 `JEV_DECIDED`（jev-decision.v1 routing，`decider`，键 `jev-routing:<task_id>`）。授权来源记为 `pol_cmap_dispatchers` + 调度者列表 sha256，不经 ADR-0007 委托策略；确定性兜底判高风险的任务不交给调度者 |
| §5 交回 | ✅ | 恢复判定在 `selectAdapter` 落账快照时进行，首次检测记 `QUOTA_RESTORED`；派回由 `preferred_agent` 自然成立。WebUI 资源页显示各账号最新快照（`GET /v1/quota-snapshots`），任务链显示额度交接（`GET /v1/missions/:id/quota-handoffs`） |
| 全链路验证 | ✅ | `TMPDIR=/private/tmp node scripts/e2e-quota-handoff.mjs`：2026-10-23 实测三段全部通过（schema `e2e_quota_mvkhmizq`）。A 为注册成第二身份的 CodexAdapter：① 注入 95% 快照；② 快照读不到、包装脚本输出 Codex 触顶文本（mutating，两次以 API owner 身份审批）；③ 注入 3% 快照并走真实 codex。B 为真实 Codex 与真实零额度探针 |

真实调度器各调用一次（2026-10-23，候选 codex/kimi）：Jev `jev-1.14.0` 976ms 选 codex、置信度 0.9（需 `NODE_USE_ENV_PROXY=1`）；Claude `claude-opus-5-5` 9.5s 选 codex。同时探到 Claude 账号七日窗口已用 97%，路由中 claude 调度者会因自身额度低被跳过。

续接任务的 `previous_attempt.kind` 为 `quota_handoff`，提示词显示「额度续接」数据区块，与返工的「上一轮未通过」分开。

已知限制：续接快照只覆盖控制面本机工作区（远程 runner 的工作区在 lap 上，未接入）；lap 若仍是旧版本，续接任务在 lap 上的提示词会按「上一轮未通过」渲染（远程协议不按契约校验信封，不会拒收）。
