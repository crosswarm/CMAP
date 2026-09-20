# Mission 创建入口验证 · 2026-09-21

## 本轮交付

`POST /v1/missions` 可将目标、验收、风险和返工预算提交到既有 Workflow。
身份由本机控制面配置填充，客户端 request_id 作为租户/owner 范围内的重试键。
这是创建入口，不代表 WebUI、OIDC、多 Agent 或 DAG Planner 已完成。

| 行为 | 当前证据 |
|---|---|
| API 创建并启动 | 202 返回固定 mission_id/workflow_id；真实 API → PG → Temporal → Codex 完成 |
| 并发相同请求 | 只产生一个 Mission、一个 Workflow run、一个 Task、一条 MISSION_CREATED |
| 已完成后重试 | Workflow runId 与任务数不变 |
| 改变原请求内容 | API 409，原目标和状态不被覆盖 |
| 启动失败恢复 | 503 后同 request_id 重试复用 DRAFT；HTTP 边界测试通过 |
| 可信身份与租户 | body 自述 tenant/owner/state 拒绝；跨租户相同请求键独立且不能互读 |
| 本机写入边界 | 拒绝跨 Origin/opaque origin、非本机 Host、非 JSON、普通和 chunked 超过 64KiB 请求 |
| 真实结果 | 独立数出 3 个实际 sample 文件，证据 SHA-256 复算一致 |
| 事件隐私 | 新建 Mission 的事件不携带 goal 正文；目标仍在业务账本中 |

## 检查结果

- `npm run check`：typecheck 通过，196 基础 + 35 API + 48 Workflow = 279 项通过。
- `npm run test:pg`：66/66，共用 Store 契约。
- `node scripts/e2e-mission-create.mjs`：真实链路通过；独立 schema/队列/工作目录。
- 独立代码审查未发现阻断问题；codegen、语法、diff 和文档链接检查通过。
- API/Worker 已按实际启动、创建、运行、关闭的路径验证，未改线上服务。

## 测试过程说明

API 用例先在旧路由上因 404 等预期失败，再实现至通过。
Store 子任务没有按要求先执行有效红测，这是流程偏差；随后在隔离临时副本中
加载未修改的前一提交 MemoryStore，确认新增三条断言确实失败（事件含正文、
重试重置状态、冲突未拒绝），当前实现三条均通过。没有把这个补验倒称为实现前红测。

## 边界与剩余项

- 本机单用户入口，owner 配置不是身份认证；P4 之前不能对外开放。
- 幂等语义要求重试保留原请求键和内容；改变目标需新键。
- 当前模板为 inspect/v1 单任务返工；WebUI、自动 DAG 规划和多 Agent 仍未实现。
- 未引入新依赖；React/Vite 依赖确认仍未收到明确答复。
- 临时数据库连接出现已有 pg 并发 query 弃用警告，本轮没有扩大到连接池重构。

## 修改文件

- [.env.example](../.env.example)
- [README.md](../README.md)
- [API main.ts](../apps/control-plane-api/src/main.ts)
- [API server.ts](../apps/control-plane-api/src/server.ts)
- [请求归一化](../apps/control-plane-api/src/mission-submission.ts)
- [Mission 幂等比较](../packages/domain-model/src/mission-input.ts)
- [MemoryStore](../packages/domain-model/src/memory-store.ts)
- [PgStore](../packages/domain-model/src/pg-store.ts)
- [领域导出](../packages/domain-model/src/index.ts)
- [创建契约](../schemas/mission-create.v1.schema.json) / [接收响应契约](../schemas/mission-submission.v1.schema.json)
- [创建派生类型](../packages/domain-model/src/generated/mission-create.ts) / [响应派生类型](../packages/domain-model/src/generated/mission-submission.ts)
- [codegen](../scripts/codegen.mjs) / [precommit 检查](../scripts/precommit-checks.mjs)
- [真实创建链路](../scripts/e2e-mission-create.mjs)
- [创建 API 测试](../tests/api/mission-create.test.ts) / [Schema 测试](../tests/contract/mission-create.test.mjs)
- [共享 Store 契约](../tests/domain/store-contract.ts)
- [架构状态](architecture.md) / [WebUI 交接](design/webui-brief.md)
