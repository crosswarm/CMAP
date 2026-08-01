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

## 状态

P0 契约层建设中。
