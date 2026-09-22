# ADR-0005：Workflow 与 Ledger 的职责边界

- 状态：已接受
- 日期：2026-08-03
- 来源：架构评审 `pdf-cmap-arch-review`

## 背景

系统里有两处持久状态：Temporal 的 Event History，和 Task Ledger（PostgreSQL）。若不明确划分，必然出现"两份状态不一致，且无法判定谁对"——这是分布式系统中最难查的一类故障。

## 决策

**Temporal 管流程推进，Ledger 管业务事实，依赖单向。**

```
Temporal Workflow  ──通过 Activity 写──▶  Task Ledger（唯一业务真相源）
      │                                        │
      │ 只读自己的 workflow 状态                  │ 供 WebUI / 审计 / 查询
      ▼                                        ▼
  决定「下一步派谁」                         回答「发生过什么」
```

### 四条约束

1. **Ledger 是唯一业务真相源。** 判断「任务是否完成」「证据是否齐备」「该不该返工」一律查 Ledger。
2. **Workflow 不得把业务判断建立在 Temporal 内部状态上**（如用 `workflowInfo()` 推断业务进度）。
3. **所有写 Ledger 的 Activity 必须幂等。** Workflow 重放时 Activity 结果从 Event History 取，但**超时的 Activity 会真正重跑**，此时副作用可能已发生。
4. **Ledger 不感知 Temporal。** 它不知道自己被谁驱动，因此可被 WebUI、CLI、恢复脚本平等地读写。

## 落地时必须遵守的三条实现规则

评审中发现这三条不写明就会踩雷，且症状都很隐蔽：

### 规则一：幂等状态必须落库，不能只在进程内存

评审时发现的真实缺陷：`codex-adapter` 的幂等记录是进程内 `Map`。Temporal 的 Activity 重试可能落到**另一个 Worker 进程**，那时 `Map` 是空的，会重新 spawn 一个 Agent 进程。对 `mutating` 任务等于同一份改动被应用两次。

更值得注意的是**测试为何没发现它**：e2e 中的幂等断言在同一进程内连续调用两次 `startTask`——测试范围恰好掩盖了缺陷。

规则：Adapter 先生成 prepared binding，控制面通过 `claimTaskBinding` 原子写入启动意图，获胜者才调用 `startTask`。已有 binding 只证明启动意图已登记，不证明远端启动或完成；重试先读取拒绝记录与结果，远端状态不可确认时记录 `INPUT_REQUIRED`，不得重新启动。Adapter 内存缓存不作为正确性依据。

### 规则二：所有 ID 由 Activity 侧生成，Workflow 只传递不创造

Temporal Workflow 必须确定性，禁用 `Date.now()` / `Math.random()` / UUID 生成。若在 Workflow 里生成返工任务的 id，重放时会产生不同的 id，账本出现孤儿记录。

正确路径：创建 Task 的 Activity 从 Mission ID 与逻辑 `creationKey` 派生稳定 ID。默认 key 表示唯一初始任务，独立创建意图显式使用不同 key；返工使用父 Task、轮次与后继索引构成 key。写入成功但 Activity 响应丢失后，再次执行仍指向同一条 Task，并核对不可变输入。

业务幂等键与事件 ID 职责不同：事件 ID 可以随机生成，但不能充当创建意图。仅把随机 ID 生成移到 Activity 内，不能避免 Activity 重试产生孤儿记录。

### 规则三：写 Ledger 与调用 Adapter 合并为单个 Activity

若拆成两个 Activity：

```
Activity A: Ledger 标记 QUEUED
Activity B: 调 Adapter.startTask
```

B 成功而后续失败时，Ledger 停在 `QUEUED` 而 Agent 已在运行。跨 Activity 的两阶段没有事务保护。

规则：把「写 Ledger + 调 Adapter」放进同一个 Activity，内部先登记启动意图再调用，并在发送前复核授权。单个 Activity 本身不是跨系统事务；失败后依据已持久化的意图、拒绝或结果恢复，不能把未知远端执行状态直接标成终态失败。

### 评审应用的恢复边界

Review 行存在只证明评审已保存，不证明后继任务与状态迁移都已完成。每个 Task 的评审应用先写 `REVIEW_APPLICATION_INTENT`，绑定输入哈希、轮次和冻结的返回结果；逐项修复 Review、后继任务、源 Task 与 Mission 状态后，回读验证，再写 `REVIEW_APPLICATION_COMPLETED`。完整契约见 [review-application schema](../../schemas/review-application.v1.schema.json)。

同一输入重试复用原结果；变化的决策、进展或轮次拒绝混入既有应用。旧账本仅在分支与后继对应关系可证明时恢复，歧义情况明确失败。事件只保存哈希与受限结果，不保存评审自由文本；完整决策仍在 Review 记录中。

Task 状态未知与 Mission 升级分别使用 `execution-uncertain:<task>` 和 `mission-execution-uncertain:<task>`，因为事件幂等键在全库唯一。已持久化的未知状态在 Adapter I/O 前重放，已落库的实际结果优先于未知状态记录。

## 备选方案与否决理由

| 方案 | 否决理由 |
|---|---|
| **全放 Temporal，不要 Ledger** | Event History 不是查询数据库。WebUI 要按租户列 Mission、按状态筛任务、下钻证据血缘——Temporal 做不到，且有保留期，过期后无法复盘 |
| **全放 Ledger，不要 Temporal** | 等于自研 durable execution，回到 ADR-0001 已否决的方案 |
| **双向同步** | 两份状态必然漂移，漂移后无法判定谁对 |

## 已知代价

同一件事在两处留痕：Temporal 记「Activity 执行过」，Ledger 记「任务完成了」。

接受它，因为两者语义不同——前者是流程事实，后者是业务事实。**只要依赖是单向的，就不会漂移到无法判定**：Ledger 永远是权威。

## 验证结果（2026-08-04）

三条规则已由 `tests/workflow/mission.test.ts` 的 6 条断言验证可落地，跑在真实 Temporal 上而非模拟环境。

同时解除了两个不确定性：

- **Temporal 与零构建 TS 兼容**。Worker 能直接 bundle 原生 `.ts` workflow 文件（`Workflow bundle created, size: 1.35MB`），无需额外构建步骤。
- **Temporal 真的能跑**。此前它是「装好了但从未用过」的状态，与那个 `default` namespace 从未被创建的坑同属一类风险。现已端到端验证。

因此 ADR-0001 的 Temporal 选型不再需要重新评估。

测试中有一条断言值得留意：「全新 Adapter 实例（模拟新进程）同样能识别已派发」——它显式覆盖了此前 e2e 掩盖的那个缺陷（两次调用在同一进程内）。
