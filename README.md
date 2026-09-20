# CMAP — Agent Control Plane

跨主机多 Agent 统一调度、协作与任务管理平台。

## 解决什么问题

四类 Agent（Claude / Codex / Kimi-code / YonWork）之间的任务交接目前靠人：转交文档、告知结果路径、反复协调返工。人被困在传递环里，每次交接都要重新解释"读哪里、做什么、什么算通过、结果写回哪"。

目标是把人从**传递环**摘出去，只保留在**授权闸口**和**最终验收**上。

## 两条不可动摇的分离原则

1. **控制面不放 LLM** —— 编排智能由 Claude 产出的 Plan/DAG 承载，引擎只忠实执行。否则调度不可复现、失败无法归因。
2. **控制面不执行 Agent** —— 执行一律在 runner 上。这是本机方案能平滑长成跨主机方案的唯一前提。

## 角色分工

| Agent | 角色 |
|---|---|
| Claude | Planner / Reviewer / Judge |
| Codex | Primary Engineer / Lab Operator（持 computer-use） |
| Kimi-code | Fallback / Challenger |
| YonWork | Validation Agent（经 `yonworkctl` 接入，仅 UI-only 动作需 codex 代理） |

## 技术选型

Temporal（持久化工作流引擎）+ PostgreSQL（任务账本）+ S3 兼容对象存储（Artifact）+ REST/SSE 控制面 + React WebUI。

选 Temporal 的原因见 `docs/adr/`：难点本质是 Durable Execution（长任务、跨天恢复、资源等待、审批等待、多轮返工、外部副作用幂等），自研调度器的典型故障是静默失败。

## 文档

- `docs/design/deep-research-report-map.md` — 架构研究基线（研究产物，勿改）
- `docs/architecture.md` — 落地版架构
- `docs/threat-model.md` — 威胁模型（多人多机跨公网 = 远程代码执行平台）
- `docs/adr/` — 架构决策记录
- [Jev 决策辅助](docs/approval-advisor.md) — 工具调用与业务审批的独立建议，保留实际授权来源

## 本地运行

```bash
# 1. 起基础设施（Temporal + PostgreSQL）
docker compose -f infra/docker-compose/docker-compose.yml up -d
node scripts/verify-temporal.mjs        # 就绪判定的唯一权威判据

# 2. 构建 WebUI，再起两个进程（各占一个终端）
npm run build:web                       # API 同源托管前端
npm run start:worker                     # Temporal Worker，队列 cmap-main
npm run start:api                        # 控制面 API，http://127.0.0.1:8787

# 3. 真跑一次 Mission（codex 会被真实调起，约 1-3 分钟）
node scripts/e2e-mission.mjs

# 4. 验证审批闸口（需 Worker 与 API 同时运行）
node scripts/e2e-approval.mjs
```

两个进程都会幂等建表，空库首次启动即可用。环境变量见 `.env.example`，
存在 `.env` 时自动加载。

### 创建 Mission

本机 `POST /v1/missions` 接受 JSON；`tenant` 与 `owner` 由 API 配置填写，
分别来自 `CMAP_TENANT` 和 `CMAP_OWNER`（后者默认 `local-operator`，不是 OIDC 身份）。

```json
{
  "request_id": "local-inspect-001",
  "goal": "在沙箱中创建 3 个 sample 文本文件，统计数量并写入 evidence/report.json。",
  "acceptance": [{ "criterion_id": "FILE-COUNT", "metric": "sample_file_count", "operator": "eq", "expected": 3 }],
  "risk_level": "read-meta",
  "max_additional_cycles": 0
}
```

返回 202 和 `mission_id`、`workflow_id`，表示接收，不表示完成。
相同请求键与字段内容可重试；改变目标或约束返回 409。启动 Workflow 暂时失败时
返回 503，但账本保留同一 Mission，使用**原 request_id**重试即可恢复。
运行中请求复用 Workflow，已结束的 Mission 不重新启动；新目标使用新请求键。
`controlled`/`mutating` 仍分别进入审批闸口。

写入要求同源或本机 CLI、`application/json`、请求体不超过 64KiB；
跨来源网页及非本机 Host 均拒绝。当前仍只允许本机使用，不具备多人身份认证。
创建接口启动既有 `inspect/v1` 流程，尚不执行自动 DAG 规划。

真实创建链路验证：给 API、Worker 和验证脚本配置相同的独立 `CMAP_DB_SCHEMA`、
`TEMPORAL_TASK_QUEUE`、`CMAP_WORK_ROOT`、`CMAP_OWNER`，然后运行
`node scripts/e2e-mission-create.mjs`（会实际调用 Codex；不允许使用 public schema）。

## 状态

P0（契约层 + 单跳闭环）、P1（任务账本 + Workflow + 自动返工闭环）已完成。

P2 进行中：控制面已能**无人值守跑完一次 Mission**——派发给 codex、真实执行、
收结果落账本、逐条核对验收标准、独立复算证据哈希；验收不过会自动派生后继任务
返工，轮次耗尽或判定无进展则升级给人；高风险任务会暂停等待对应 scope 的真人
批准，错 scope 不放行。Mission 列表包含尚无任务的记录，SSE 事件流支持实时推送与断线历史回放。
WebUI 已接入目标创建、验收账本、证据预览、返工追踪、独立 scope 审批和 Jev 建议。
启动后打开 http://127.0.0.1:8787；开发前端可用 `npm run start:web`（仍需 API）。
当前只覆盖本机 inspect/v1；本机 Kimi Adapter 已接入（[运行说明](docs/kimi-adapter.md)）；DAG、YonWork Adapter、OIDC 与远程 runner 尚未完成。
验证见 [WebUI 交付记录](docs/verification-webui-2026-09-21.md)。
逐项状态见 [docs/architecture.md](docs/architecture.md#当前实现状态)。

SSE：`GET /v1/missions/:id/events`，事件名 `mission-event`，按当前 API 租户过滤。
首次连接和重连均回放历史，再推送新增事件；客户端按 `data.event_id` 去重。
`Last-Event-ID` 使用原 SSE `id`，不以 `lamport` 高水位过滤晚提交事务。
浏览器使用 EventSource；服务端每秒读取账本，15 秒发送心跳，不修改 Outbox 投递标记。
真实 PostgreSQL/HTTP 验证：`node scripts/e2e-events.mjs`（自动创建并清理独立测试 schema）。
