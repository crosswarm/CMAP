# 核心创建、评审与返工恢复验证

日期：2026-09-22。范围为本地核心链路；未推送、未远程部署，不代表整个项目完成。

## 实现

- `workflows/task-creation.ts`：按 Mission 与逻辑创建键派生稳定 Task ID；创建提交后丢响应不会再生成孤儿 Task。
- `schemas/review-application.v1.schema.json`、`workflows/review-application.ts`：先记录输入哈希与冻结结果，修复所有子任务和状态，再写完成回执。变化或矛盾输入拒绝；旧数据根据实际分支证据恢复，无法唯一对应时明确报错。
- `packages/domain-model/src/{store,memory-store,pg-store}.ts`：相同事件键不同语义拒绝；PG 保留事件元数据、采用 UUID，并在取行锁后重查幂等键。
- `workflows/activities.ts`、`workflows/mission.workflow.ts`：执行未知状态在 Adapter I/O 前重放，校验最新 Task；Mission 升级与 Task 事件使用不同全局键。硬门槛生成的返工 focus 保留 Mission 原始目标。
- `scripts/e2e-mission.mjs`：返工使用任何有限数都不能满足的阈值；每轮独立验证磁盘确有 3 个文件、实测值一致及证据哈希。

未增加依赖、表或审批服务。Jev 方案建议继续复用现有账本；审批建议不替代授权，`controlled` 与 `mutating` 边界未合并。

## 验证

| 检查 | 结果 |
|---|---|
| `npm run check` | 644 项通过：默认 392、API 58、Workflow 194；包含 typecheck |
| `node --test tests/workflow/retry-recovery.test.ts` | 后续补齐 3 个提交丢响应窗口后，26/26 通过；实现未再变化 |
| `npm run test:pg` | 90/90 通过，包括 8 个并发同键迁移及固定时钟下跨 Store 事件 ID |
| `tests/workflow/pg-retry-recovery.test.ts` | 真实 PgStore + Temporal Worker，3/3 通过；创建与评审的 Activity attempt 至少为 2，未知执行状态正确升级且不靠重试循环 |
| `node scripts/verify-temporal.mjs` | SDK 连接、namespace 与 Workflow 查询通过 |
| 真实 Codex 返工 | 329.9 秒，返工 1 轮后按预算升级；两个 Task 各有 3 个真实文件，报数一致，证据哈希复算通过 |
| 历史重放 | 旧单任务、审批、DAG、启动意图历史各 71/89/89/89 个事件，新返工历史 101 个事件，全部通过 |
| 更新后本机预览 | WebUI HTTP 200；`/v1/health` 返回 ok，3 个 Mission / 9 个 Task；API 与 Worker 已重启加载本次实现 |

真实返工 Mission：`mis-e2e-mucfon87`；使用独立 schema `cmap_review_live_20260922`、队列 `cmap-review-live-20260922` 和 `/tmp/cmap-review-live-20260922` 工作目录。真实 Agent 与人工合成故障注入分别验证，不将后者称为真实 Agent 结果。

故障注入覆盖意图、Review、两个 child、源 Task、Mission 和完成回执的提交丢响应。独立审查确认回执矛盾、旧升级分支与并发未知状态恢复的阻断均已修复。

真实验收曾发现两处问题，保留失败证据：要求 5 个文件可以被 Agent 补建满足；要求 -1 时后继任务丢失原始目标并虚报 -1。最终脚本没有放宽磁盘/实测值/哈希断言；生产修复位于返工目标传递处，没有加入文件计数特例。一般业务指标仍需其自身的独立测量来源，哈希一致只证明内容完整性。

## 未完成范围

- 旧 Mission Workflow 仍只消费第一个 followup；默认硬门槛只生成一个，不代表任意多后继 Workflow 已完成。
- 远程 Runner、WSS/mTLS 与身份接入不属于本次修复；未部署到远程主机。
- WebUI 本机地址 `http://127.0.0.1:8789/`；API 仍仅绑定回环地址。
