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

规则：派发前先查 `TaskRecord.binding`，非空即视为已派发；派发成功后立刻 `setTaskBinding` 落库。Adapter 内存缓存降级为同进程快速路径，**不作为正确性依据**。

### 规则二：所有 ID 由 Activity 侧生成，Workflow 只传递不创造

Temporal Workflow 必须确定性，禁用 `Date.now()` / `Math.random()` / UUID 生成。若在 Workflow 里生成返工任务的 id，重放时会产生不同的 id，账本出现孤儿记录。

正确路径：id 由创建 Task 的那个 Activity 生成并返回，其结果被记入 Event History，重放时取缓存值。

当前 `MemoryStore` / `PgStore` 的 id 生成都在 Store 内部（即 Activity 侧），**碰巧是安全的**——但必须写成规矩，否则将来有人把 id 生成挪进 Workflow 就会踩雷，且只在重放时暴露。

### 规则三：写 Ledger 与调用 Adapter 合并为单个 Activity

若拆成两个 Activity：

```
Activity A: Ledger 标记 QUEUED
Activity B: 调 Adapter.startTask
```

B 成功而后续失败时，Ledger 停在 `QUEUED` 而 Agent 已在运行。跨 Activity 的两阶段没有事务保护。

规则：把「写 Ledger + 调 Adapter」放进同一个 Activity，内部先写后调，失败则整体标记失败。

## 备选方案与否决理由

| 方案 | 否决理由 |
|---|---|
| **全放 Temporal，不要 Ledger** | Event History 不是查询数据库。WebUI 要按租户列 Mission、按状态筛任务、下钻证据血缘——Temporal 做不到，且有保留期，过期后无法复盘 |
| **全放 Ledger，不要 Temporal** | 等于自研 durable execution，回到 ADR-0001 已否决的方案 |
| **双向同步** | 两份状态必然漂移，漂移后无法判定谁对 |

## 已知代价

同一件事在两处留痕：Temporal 记「Activity 执行过」，Ledger 记「任务完成了」。

接受它，因为两者语义不同——前者是流程事实，后者是业务事实。**只要依赖是单向的，就不会漂移到无法判定**：Ledger 永远是权威。

## 待验证

Temporal 目前是「装好了但从未用过」的状态。**P1 内必须写出第一个可运行的 Mission Workflow**，验证上述三条规则可落地。若两周内跑不通，说明学习成本被低估，应重新评估 ADR-0001。
