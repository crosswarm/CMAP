# ADR-0007：Jev 委托决策层

- 状态：提议（方向由 Cross 于 2026-10-21 提出；阈值与上线指标未定；**未实现**）
- 日期：2026-10-21
- 相关：[ADR-0001](0001-temporal-as-orchestration-engine.md)「控制面不放 LLM」、[Jev 决策辅助](../approval-advisor.md)、[威胁模型 T4/T14](../threat-model.md)
- 契约：[delegation-policy.v1](../../schemas/delegation-policy.v1.schema.json)、[jev-decision.v1](../../schemas/jev-decision.v1.schema.json)

## 背景

现在 controlled 与 mutating 审批全部由真人决定，路由由确定性规则决定，Jev 只给建议（`approval-advice.v1`，`can_continue` 恒为 false）。目标是：所有决策先过 Jev，中低风险由 Jev 直接通过、拒绝或分配，Jev 判为高风险或拿不准时转人工综合确认。

[approval-advisor.md](../approval-advisor.md) 已写明前提：模型置信度不能当授权，要自动执行须先有可信控制面维护的委托授权契约，再由确定性程序匹配。本 ADR 补上这份契约。

## 决策

**授权来源是真人签发的委托策略，Jev 只在策略边界内代为决定。** 决定以 `jev:<模型版本>` 身份记录，任何时候都不算人工授权。

### 流程

1. 决策点到达时，控制面在 Activity 中调用 Jev，得到 `jev-decision.v1` 记录。Workflow 只读取已落账的记录，重放时不再调用模型。
2. 有效风险 = max(信封声明风险的下限, 确定性规则, Jev 评估)，**只升不降**。声明为 controlled 或 mutating 的，有效风险至少为 medium。
3. 同时满足以下条件，控制面才自动执行，记录 `route=auto`：
   - 策略有效（存在、未过期、租户相符），且覆盖该决策类型、scope 与 capability；
   - Jev 的结果在该规则的 `outcomes` 之内；
   - 有效风险不高于 medium，置信度不低于 `min_confidence`；
   - 未触发下方任一兜底规则；
   - 当日自动执行次数未达 `daily_auto_budget`。
4. 否则记录 `route=human`，进入人工队列。界面同时展示 Jev 的风险评估、理由码与证据摘要，由真人综合确认。
5. Jev 超时（15 秒）、不可用或输出不合法：审批转人工，分配回落到现有确定性路由。**不存在失败即通过的路径。**

### 确定性兜底：必须转人工

由代码执行，策略不能放宽：

- `mode=shadow`；
- 有效风险为 high，或 Jev 结果为 `escalate`；
- mutating 审批中 `permissions.repository.allow_push_branches` 非空；
- YonWork 权限 `clear_test_data` 或 `gateway_control` 为 true；
- 执行不确定后的重做：声明风险高于 `read-sensitive`；
- controlled 与 mutating 各自独立决定，一次决定只覆盖一个 scope。

### 决策点

| 决策点 | Jev 可直接决定 | 说明 |
|---|---|---|
| controlled 审批 | 策略列出的 capability 内，可通过或拒绝 | 规则的 `outcomes` 可只放 `approve`，拒绝留给真人 |
| mutating 审批 | 只限 `require_no_push` 的规则 | 隔离 worktree 内改代码、不推送 |
| 分配 | 在已通过准入的候选中选一个 | 只有一个候选时不调用；不能越过准入 |
| 执行不确定后重做 | 只读级风险可决定重做 | 有写副作用的一律人工，防止重复执行 |
| 返工/升级 | 不委托 | 硬门槛仍由程序判定；语义评审另行设计 |

### 委托策略

由 Cross 编写，以 `CMAP_DELEGATION_POLICY_FILE` 指向 Agent 不可写的路径。文件对 group/other 可写时拒绝加载。策略变化即新 `policy_id`，每条决定记录策略 sha256。`mode` 从 `shadow` 起步。环境变量 `CMAP_JEV_AUTODECIDE=off` 一键回到全人工。

### 防注入

只把可信字段送给 Jev：控制面填写的信封字段、真人撰写的 Mission 目标、确定性统计（改动行数、涉及路径）。Agent 产出的文本（结果摘要、findings、证据正文、Planner 生成的节点目标）一律不送。否则被注入的 Agent 一句「此操作安全」就能影响 Jev 的判断。

### 上线节奏

1. 影子模式：Jev 照常给出决定，仍由真人确认，记录一致率。现有 0.9 阈值是未经校准的初值。
2. 一致率达标后，对 controlled 审批与分配启用 `enforce`。达标指标待定，至少包括「Jev 自动通过的项中没有真人会拒绝的」。
3. 最后再考虑 `require_no_push` 的 mutating。

## 对既有规则的修订

- **「控制面不放 LLM」**：改为「LLM 不进入 Workflow 的推进逻辑；LLM 决策只在 Activity 中产生、落账后由 Workflow 确定性执行」。重放读取已记录结果，可复现性不变。
- **AGENTS.md 安全边界第 4 条仍成立**：执行任务的 Agent 不得自批；Jev 不是执行方，其决定不伪装成人工。
- **`approval-advice.v1` 不变**：它仍是只建议的契约；代为决定走 `jev-decision.v1`。
- **威胁模型**：新增 T14「Jev 误判或被注入」。

## 前提

- Agent 不能直连控制面端口（审计 Must fix 第 1 条，Kimi 沙箱已于 2026-10-21 修复）。否则被注入的 Agent 可绕开 Jev 直接改审批。
- 人工路径在接入第二个人之前必须绑定真实身份（OIDC 或 passkey）。否则「转人工」只是换了一个未认证的接口。

## 残余风险

- Jev 与执行 Agent 的错误可能相关；兜底规则与预算只能限制影响面，不能消除误判。
- 委托策略本身是授权根，被改写即授权被改写；靠文件权限与哈希留痕防护，没有签名。
- 阈值未经校准；影子模式之前没有任何数据支持自动执行。

## 实现清单（均未开始）

- [ ] 策略加载与校验（文件权限、过期、租户、sha256）
- [ ] `decideWithJev` Activity：复用 `scripts/jev-approval.mjs` 的客户端与超时，输入只取可信字段
- [ ] `JEV_DECIDED` 事件与 `Approval.decided_by = jev:<模型版本>`
- [ ] 审批闸口、`selectAdapter`、执行不确定三处接入，以及兜底规则与当日预算
- [ ] WebUI：区分 Jev 决定与真人决定；人工队列展示 Jev 评估
- [ ] 影子模式一致率统计
