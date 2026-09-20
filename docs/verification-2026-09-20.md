# CMAP 进度与验证 · 2026-09-20

## 当前范围

P0/P1 和 P2 后端主链路可运行。本轮补齐 Mission 列表、SSE 和控制面外 Jev 决策辅助。
P2 WebUI 尚未实现；P3 多 Agent、P4 远程 runner 与身份认证均未完成，不能将本轮通过理解为整个项目完成。

## 本轮改动

- Mission 列表直接按租户查 Mission，包含尚无 Task 的记录；Memory/PG 按真实创建时刻与 id 排序。
- Mission SSE：历史回放、实时新增、重连去重、晚提交事件、背压和断开清理；只输出白名单元数据。
- Jev CLI：工具调用与 CMAP pending 审批共用输入/建议契约，复用本机配置；不写批准、不冒充真人。
- 审批 E2E 的 synthetic 身份和文案明确标识为技术测试，去掉“真人身份批准”的错误表述。
- WebUI 单一交接文档补充方案取舍、双 scope 防误操作约束与 SSE 接线信息。

## 实测证据

| 检查 | 结果 |
|---|---|
| `node scripts/verify-temporal.mjs` | SDK 连接、namespace、Workflow 查询通过 |
| `npm run check` | typecheck 通过；189 基础测试 + 23 API + 46 Workflow，0 失败 |
| `npm run test:pg` | 61/61，同一 Store 契约验证 Memory/PG 行为 |
| `node scripts/e2e-events.mjs` | 真实 PG/HTTP：历史、实时、低 lamport 晚提交、重连、租户隔离、无任务 Mission 通过 |
| `node scripts/e2e-mission.mjs` | 真实 Codex，138.5 秒；3 个文件，证据哈希复算一致，Mission COMPLETED |
| `node scripts/e2e-mission.mjs --rework` | 真实 Codex，308.7 秒；返工 1 轮，预算耗尽后 ESCALATED，supersedes 与事件链完整 |
| `node scripts/e2e-approval.mjs` | 未批不派发、错 scope 为 409；合成测试批准后 Codex 执行并完成 |
| Jev 真调用 | `jev-1.13.0` 对已授权只读操作给出 continue/0.95；业务提交建议 review，回读仍 pending、decided_by=null |
| codegen / precommit / 文档 | 派生类型可复现；新增缺失生成文件被检测；diff 与本地文档链接检查通过 |

真实 Agent 验证使用独立 `cmap_verify_20260920` schema、专用 Temporal 队列和临时工作目录；
SSE 验证自动创建并清理随机 schema。本轮启动的 Worker/API 已正常停止。
现有 Temporal 栈未关闭，未修改公共账本或部署线上服务。

## 剩余边界

- SSE 每连接每秒扫描本 Mission 历史，尚无分页或大规模广播优化。
- Jev 辅助不是 OIDC、委托授权或宿主审批替代品；尚无 WebUI 建议展示。
- PostgreSQL 连接初始化出现既有 `client.query` 并发弃用警告，当前检查通过；未扩大到无关连接池重构。
- React/Vite 必要依赖的新增确认尚待用户回复；未绕过“新依赖需明确请求”的约束。
- 9 月 20 日阶段结束时改动尚未提交/推送；开始时 `main` 已领先 `origin/main` 9 个提交，未修改这段历史。

## 续推 · 2026-09-21

- 复现并修复审批决定可覆盖、过期可批准、Activity 重试延长等待三个问题。
- 新增 `approval-decision-input` 契约；Memory/PG 共用终态转换，PG 加行锁保证并发。
- `npm run check`：193 基础测试 + 26 API + 48 Workflow，共 267 项通过；`test:pg` 64/64。
- 真实 PG + HTTP 验证：过期 409，并发决定 200/409，同身份同决定重试保留原时间。
- 新代码的真实 API → Temporal → Codex 审批链路通过，使用另一独立 schema 与专用队列。
- `Worker.runReplayHistory` 对此前完成、返工升级、审批三份真实历史重放通过（71/101/89 个事件）；历史仅在内存中读取，未入库。
- P3 环境只读核对：本机 Kimi 2.0.1、yonworkctl 可用，但 Adapter 尚未实现；不能仅凭 CLI 存在宣称集成完成。

## 修改文件

- [AGENTS.md](../AGENTS.md)
- [README.md](../README.md)
- [apps/control-plane-api/src/server.ts](../apps/control-plane-api/src/server.ts)
- [docs/approval-advisor.md](../docs/approval-advisor.md)
- [docs/architecture.md](../docs/architecture.md)
- [docs/design/webui-brief.md](../docs/design/webui-brief.md)
- [docs/threat-model.md](../docs/threat-model.md)
- [docs/verification-2026-09-20.md](../docs/verification-2026-09-20.md)
- [packages/domain-model/src/approval-state.ts](../packages/domain-model/src/approval-state.ts)
- [packages/domain-model/src/generated/approval-advice.ts](../packages/domain-model/src/generated/approval-advice.ts)
- [packages/domain-model/src/generated/approval-context.ts](../packages/domain-model/src/generated/approval-context.ts)
- [packages/domain-model/src/generated/approval-decision-input.ts](../packages/domain-model/src/generated/approval-decision-input.ts)
- [packages/domain-model/src/generated/mission-event.ts](../packages/domain-model/src/generated/mission-event.ts)
- [packages/domain-model/src/generated/mission-query.ts](../packages/domain-model/src/generated/mission-query.ts)
- [packages/domain-model/src/index.ts](../packages/domain-model/src/index.ts)
- [packages/domain-model/src/memory-store.ts](../packages/domain-model/src/memory-store.ts)
- [packages/domain-model/src/pg-store.ts](../packages/domain-model/src/pg-store.ts)
- [packages/domain-model/src/store.ts](../packages/domain-model/src/store.ts)
- [schemas/approval-advice.v1.schema.json](../schemas/approval-advice.v1.schema.json)
- [schemas/approval-context.v1.schema.json](../schemas/approval-context.v1.schema.json)
- [schemas/approval-decision-input.v1.schema.json](../schemas/approval-decision-input.v1.schema.json)
- [schemas/mission-event.v1.schema.json](../schemas/mission-event.v1.schema.json)
- [schemas/mission-query.v1.schema.json](../schemas/mission-query.v1.schema.json)
- [scripts/codegen.mjs](../scripts/codegen.mjs)
- [scripts/e2e-approval.mjs](../scripts/e2e-approval.mjs)
- [scripts/e2e-events.mjs](../scripts/e2e-events.mjs)
- [scripts/jev-approval.mjs](../scripts/jev-approval.mjs)
- [scripts/precommit-checks.mjs](../scripts/precommit-checks.mjs)
- [tests/api/control-plane.test.ts](../tests/api/control-plane.test.ts)
- [tests/api/mission-events.test.ts](../tests/api/mission-events.test.ts)
- [tests/contract/approval-decision.test.mjs](../tests/contract/approval-decision.test.mjs)
- [tests/contract/mission-event.test.mjs](../tests/contract/mission-event.test.mjs)
- [tests/contract/mission-query.test.mjs](../tests/contract/mission-query.test.mjs)
- [tests/domain/store-contract.ts](../tests/domain/store-contract.ts)
- [tests/tooling/approval-advisor.test.mjs](../tests/tooling/approval-advisor.test.mjs)
- [tests/workflow/approval.test.ts](../tests/workflow/approval.test.ts)
- [workflows/activities.ts](../workflows/activities.ts)
