# ADR-0001：采用 Temporal 作为编排引擎

- 状态：已接受
- 日期：2026-08-01

## 背景

控制平面要驱动四类 Agent 完成"规划 → 执行 → 真机验证 → 评审 → 返工 → 完成"的闭环。这个闭环的技术难点不在于调用模型，而在于：

- 单个 Mission 可能跑几小时到几天，需跨天恢复
- 真机设备、Git worktree 等稀缺资源需要等待与租约
- 审批闸口可能等待数小时
- 多轮返工，每轮都要保留证据与因果链
- 外部副作用（改代码、跑测试、操作真机）必须幂等
- DAG 并发、任务取消、事件审计

这是典型的 Durable Execution 问题。

## 决策

采用 **Temporal** 作为持久化工作流引擎，而非自研调度器。

边界划分：

| 放进 Workflow（确定性） | 放进 Activity（副作用） |
|---|---|
| DAG 推进、依赖等待、返工轮次 | 调用 Claude/Codex/Kimi/YonWork |
| 超时与重试策略、资源锁生命周期 | MCP Tool 调用、Git 操作 |
| 审批等待、任务取消、Mission 终态 | 上传 Artifact、外部查询、发通知 |

同时确立**控制面不放 LLM**：编排智能由 Claude 产出的 Plan/DAG 承载，引擎只忠实执行。

## 理由

自研调度器需要把重试、超时、崩溃恢复、幂等、审批等待全部实现一遍，而这类代码的典型故障形态是**静默失败**——本项目负责人在 aiticket 的 JobMaster 上已实际踩过五种：

1. owner 文件缺失但 daemon 仍存活
2. trigger 返回 true 但 DB 中没有新行
3. 任务成功但 run_count 不更新
4. launchd `gui/` 域跑 UTC 导致每日 cron 从不自触发
5. `last_status` 全 success 但实际 rc≠0（捕获失败不 raise）

原始设计的防坑清单中约一半条目，Temporal 已在引擎层解决。

## 后果

**接受的代价**

- 多一个组件：docker-compose 需起 Temporal + PostgreSQL
- Workflow 代码有确定性约束：**禁用 `Date.now()` / `Math.random()` / 无参 `new Date()`**，所有副作用必须放进 Activity
- 团队需要理解 Event History 与重放语义

该确定性约束与本项目日常使用的 Claude Code Workflow 脚本规则同源，学习成本可控。

**仍需自行保证**

即使引擎声称 exactly-once，超时后仍无法确认外部副作用是否已发生。所有 Activity 必须携带 `idempotency_key`。

## 备选方案

- **Restate**：单二进制起步、多语言 SDK、运维更轻。生态与踩坑资料较少，复杂返工场景需先做 PoC。若未来运维成本成为瓶颈可重新评估。
- **Camunda 8**：BPMN 与人工任务能力强，但 Agent 动态生成的 DAG 需额外编排层，平台偏重。
- **自研轻量调度器**：无新依赖，但见"理由"一节。
