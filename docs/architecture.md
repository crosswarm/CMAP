# CMAP 架构

本文是落地版架构说明。研究基线见 [design/deep-research-report-map.md](design/deep-research-report-map.md)（该文件为研究产物，不随实现更新）；关键取舍的理由见 [adr/](adr/)。

## 要解决的问题

四类 Agent 之间的任务交接目前靠人转发：转交文档、告知结果路径、反复协调返工。每次交接都要人重新解释"读哪里、做什么、什么算通过、结果写回哪"。

```
Claude 出方案 → 人肉转交 → Codex 跑真机 → 写结果 → 人肉告知路径
  → Claude 读结果 → 不满意 → 人肉再转交 → …（人始终在传递环内）
```

目标是把人从**传递环**里摘出去，只保留在**授权闸口**和**最终验收**上。

## 两条不可动摇的原则

**一、控制面不放 LLM。** 编排智能由 Claude 产出的 Plan/DAG 承载，引擎只忠实执行。若把 LLM 放进调度循环，调度行为不可复现、失败无法归因——而这类系统的失败往往是静默的，不可复现意味着不可修。

**二、控制面不执行 Agent。** 执行一律在 runner 上。这是本机方案能平滑长成跨主机方案的唯一前提：P0–P3 的 runner 在本机进程内，P4 换成远程 WSS 连接时，调度器与 Adapter 代码不应改动。

## 分层

```
        ┌────────────────────────────────────────────────┐
        │  Control Plane                                  │
        │   Mission Service · Task Ledger · Agent Registry│
        │   Policy & Approval · Artifact Registry · Query │
        │   ── 不放 LLM，不执行 Agent ──                  │
        └────────────────────────────────────────────────┘
             │                          ▲
             ▼                          │ SSE / REST
   ┌──────────────────┐        ┌────────────────────┐
   │ Temporal Workflow│        │  Web UI (多用户)    │
   │  Engine + Worker │        │  Mission/审批/证据  │
   └──────────────────┘        └────────────────────┘
             │ Capability Router
             ▼
   ┌─────────────────────────────────────────┐
   │  Adapter 层（统一 SPI，输出归一化）        │
   └─────────────────────────────────────────┘
             │ runner（P0-P3 本机进程内；P4 反向拨出 WSS/mTLS）
   ┌─────────┼──────────┬─────────────┬──────────┐
 runner@mac-A  runner@mac-B   runner@test-1   runner@server
   │
 本机 spawn: codex · claude · kimi · yonworkctl
                                  │
                 codex+computer-use ──▶ YonWork UI-only 动作
```

**runner 反向拨出**是跨公网的关键：团队成员的笔记本在 NAT 后面，控制面不可能主动连它们；跳板机与离线机同理。控制面永不主动入站。

## 角色分工

| Agent | 角色 | 冷唤起（主力） | 热唤起（仅通知） |
|---|---|---|---|
| Claude | Planner / Reviewer / Judge | `claude -p --session-id --output-format stream-json` | agent-bridge `notifications/claude/channel` |
| Codex | Primary Engineer / Lab Operator | `codex exec --output-schema --json` | `codex remote-control` + app-server socket |
| Kimi | Fallback / Challenger | `kimi -p --output-format stream-json` | `kimi acp`（stdio ACP） |
| YonWork | Validation Agent | `yonworkctl`：`chat send` / `events tail` / `gateway health` | `watch-events --request-id` |

YonWork 是**半对等 worker**，不是纯资源：监控、通信、会话触发全走 CLI，无需 UI；只有能力中心绑定、WebView 切换这类 **UI-only 动作**才需经 codex 的 computer-use 代理。

spawn 出的 worker **不继承任何上下文**——所以任务信封必须自洽。这恰好就是消灭"人肉解释"的同一件事。

## 契约体系

契约是这套系统的核心，先于引擎确立。所有 Agent 输出必须通过 Schema 校验才能进入账本；**Workflow 不得直接解析 Agent 的自然语言终端输出**。

| 契约 | 作用 | 状态 |
|---|---|---|
| `task-envelope.v1` | 派发契约。自洽的任务描述 | ✅ 已实现 |
| `task-result.v1` | 账本格式。严格校验 | ✅ 已实现 |
| `review-decision.v1` | 返工契约 | ✅ 已实现 |
| `codex-output.v1` | 传给 Agent 的输出格式 | ✅ 已实现 |

### 为什么 Agent 输出与账本格式必须分开

`codex exec --output-schema` 走 OpenAI structured outputs，其 schema 子集要求每个属性有 `type`、所有字段列入 `required`、不支持 `pattern`/`format`——与账本所需的严格约束直接冲突。详见 [ADR-0003](adr/0003-agent-output-contract-layering.md)。

分层后确立了两条硬规则：

- **身份字段由控制面填充**（`mission_id`/`task_id`/`attempt`/`schema`），不取 Agent 自述。账本归控制面所有，否则异常 Agent 可把结果写到别的任务名下。
- **不采信 Agent 自报的证据哈希**。`collectResult` 独立复算 sha256，不符即失败。否则"证据"退化成一段自我声明的文本。

### 信封中几处刻意的强约束

| 约束 | 目的 |
|---|---|
| `context.ref` 必须是 40 位 commit SHA | 跨主机可复现；分支名与短 SHA 一律拒绝 |
| `context.paths` 禁绝对路径与 `..` | 跨主机可移植 + 防路径逃逸 |
| `account_ref` 必须 `secretref://` 开头 | 凭据绝不内联 |
| `required_resource_locks[].ttl_seconds` 必填 | runner 崩溃不得永久占住真机 |
| `evidence_requirements` 非空 | 无证据即失败的落点 |

### 返工契约是最初痛点的正解

`review-decision.v1` 把"不满意"从一句自然语言评论，变成控制面可直接据以建后继 Task 的结构化指令：

```yaml
decision: rework
failed_criteria: [{criterion_id, expected, actual, reason, evidence}]
evidence_gaps:   [{gap_code, required_coverage, actual_coverage}]
required_followups: [{capability, task_type, inputs, focus}]
stop_conditions: {max_additional_cycles}
```

Schema 层强制：`decision: rework` 时 `failed_criteria` 与 `required_followups` 必填且非空。缺任一项闭环就断了。

`accept` 仍须通过程序化硬门槛才算最终通过——**软判断不得覆盖硬指标**。

## 领域模型

`packages/domain-model` 定义账本实体：Mission、TaskRecord、TaskEvent、Artifact（含血缘）、Review、Approval、ResourceLock、AgentDescriptor、RunnerDescriptor。

### Task 状态机

16 个状态。之所以比多数任务系统细，是因为要区分几种**正常但非活跃**的停顿：

```
DRAFT → READY → QUEUED → RUNNING → VERIFYING → REVIEWING → COMPLETED
                            ↓          ↓           ↓
                     WAITING_RESOURCE  REWORK ←────┘
                     INPUT_REQUIRED
                     AUTH_REQUIRED
                     APPROVAL_REQUIRED
```

三条刻意的设计：

- **等待态（`WAITING_RESOURCE`/`INPUT_REQUIRED`/`AUTH_REQUIRED`/`APPROVAL_REQUIRED`）不是失败。** 调度器不得按失败重试，UI 也不能都显示成转圈。真机不可用时任务应进入等待而非丢失。
- **`REWORK` 不允许回到 `RUNNING`。** 返工必须派生新 Task 并以 `supersedes_task_id` 关联旧结果。原地重跑会覆盖上一轮证据与因果链——这正是"反复返工却说不清第几轮卡在哪"的根源。
- **非法迁移抛错，不静默忽略。** 静默是这类系统最难查的故障形态。

### 风险分级与授权

与 `yonwork-cli-adapter.mjs` 既有风险模型对齐，不另起一套：

| `risk` | 示例 | 闸口 |
|---|---|---|
| `read-meta` | `gateway health`、构建度量 | 自动，脱敏留证 |
| `read-sensitive` | `events tail`、失败日志 | 自动，但须限定 runId/时间窗 |
| `controlled` | `chat send`、`cron-trigger` | **独立人工授权** |
| `mutating` | 改源码、改配置、提交、合主干 | **独立人工授权**，与上一类分开批 |

`controlled` 与 `mutating` 的授权**互不蕴含**——这是现有 skill 的既定语义（"受控动作授权与修复授权完全分开"）。**UI 上不得合并成一个"批准"按钮。**

## Adapter 层

统一 SPI（`packages/adapter-sdk`）：`discover` / `startTask` / `sendInput` / `getStatus` / `subscribe` / `cancel` / `collectResult` / `health`。

**不提供续跑（`resumeSession`）**：返工一律派生新 Task 以保留证据历史与因果链，不向已结束的会话追加。这与状态机中「`REWORK` 不允许回到 `RUNNING`」是同一条设计。

### 沙箱档位与风险级别是正交的

一个容易混淆的点：**低风险不等于只读沙箱**。任何声明了证据产物的任务都必须能写文件——`artifact` 需要真实 sha256，只读沙箱下根本产不出证据。

```
risk    → 是否需要人工审批、能访问哪些外部资源
sandbox → 能否写自己的工作区
```

真正的隔离来自**工作区位置**（低风险用临时目录，`mutating` 用专用 git worktree）与 `permissions.forbidden`，而非禁止写入。

codex 本机默认是 `sandbox_mode=danger-full-access` + `approval_policy=never`——那是单机自用设置。Adapter 一律**显式传 `-s`**，绝不继承默认档。

## 编排引擎

Temporal（见 [ADR-0001](adr/0001-temporal-as-orchestration-engine.md)）。难点本质是 Durable Execution：长任务、跨天恢复、资源等待、审批等待、多轮返工、外部副作用幂等。

| 放进 Workflow（确定性） | 放进 Activity（副作用） |
|---|---|
| DAG 推进、依赖等待、返工轮次 | 调用 Claude/Codex/Kimi/YonWork |
| 超时与重试策略、资源锁生命周期 | MCP Tool 调用、Git 操作 |
| 审批等待、任务取消、Mission 终态 | 上传 Artifact、外部查询、发通知 |

**Workflow 内禁用 `Date.now()` / `Math.random()` / 无参 `new Date()`**——会破坏重放确定性。

## 当前实现状态

| 组件 | 状态 |
|---|---|
| 四个 Schema + 契约测试 | ✅ P0 |
| domain-model（实体 + 状态机） | ✅ P0 |
| adapter-sdk（SPI 定义） | ✅ P0 |
| codex-adapter | ✅ P0 |
| Temporal 本地栈（docker-compose） | ✅ P0 |
| Claude→Codex 单跳闭环 | ✅ P0，实测 68s 通过 |
| Task Ledger（内存 + PG 双实现，同一套契约） | ✅ P1 |
| Mission Workflow（骨架 + ADR-0005 三规则验证） | ✅ P1 |
| Evidence Pack（聚合 + 血缘） | ✅ P1 |
| 资源锁接入 Workflow（含续租与失锁自停） | ✅ P1 |
| 自动返工闭环（两道刹车 + 端到端验证） | ✅ P1 |
| 控制面 REST API（租户过滤 + 双 scope 审批，无任务 Mission 也可见） | ✅ P2 |
| Mission 创建 API（目标/验收/风险/预算 → 既有 Workflow） | ✅ P2，幂等请求键、启动失败原键重试、真实 API → Codex 验证；不是 DAG Planner |
| 进程入口（`npm run start:worker` / `start:api`） | ✅ P2 |
| Workflow 派发接真实 Adapter（codex 真执行） | ✅ P2，实测一次 Mission 无人值守跑完 102s |
| 任务结果与证据落账本（`setTaskResult` + Artifact 入库） | ✅ P2 |
| 验收逐条判定（漏答即不通过） | ✅ P2 |
| 硬门槛判定（确定性，不用 LLM） | ✅ P2 |
| 自动返工接进主 Workflow（两道刹车 + 升级） | ✅ P2 |
| 审批闸口接进主 Workflow（双 scope + 拒绝终止） | ✅ P2，真实 API → Workflow → Codex 链路通过 |
| 证据哈希由控制面独立复算 | ✅ P2，复算在控制面 Adapter 层，不采信 Agent 自报 |
| WebUI 原型（3 方案 × 2 轮迭代） | ✅ P2，原型已有；双 scope 同时 pending 已用合成数据验证实际 UI |
| Web UI 前端实现（Mission/审批/证据/返工追踪） | ✅ 本机 P2；真实创建与重试验证，见 [交付记录](verification-webui-2026-09-21.md) |
| SSE 实时推送 | ✅ P2，租户级与 Mission 级事件流，租户隔离、历史回放、实时追加、重连去重与断开清理；真实 PostgreSQL/HTTP 验证通过 |
| Jev 工具/审批辅助 | ✅ 控制面外 CLI，真实服务已验证；只建议，不写业务批准；审批详情已接入建议展示，见 [说明](approval-advisor.md) |
| 能力路由 | 🟡 P3，启动前按能力/风险/健康及显式首选替补选择；已绑定任务按原 Adapter 收取，不自动二次派发，见 [验证](verification-p3-routing-2026-09-21.md) |
| kimi-adapter | ✅ 本机 macOS P3；真实单跳与 Temporal → Kimi 完成，见 [运行说明](kimi-adapter.md) 与 [验证](verification-kimi-2026-09-21.md) |
| DAG 执行 | ✅ 本机显式 dag/v1；API → Temporal → Codex/Kimi 分叉汇合、依赖产物与节点验收已验证，见 [验证](verification-dag-2026-09-21.md)；不包含自动 Planner |
| 自然语言 Planner 桥接 | 🟡 外部 CLI 与契约校验已实现；Claude 真实调用返回 403，端到端验证未完成，见 [Planner](planner.md) |
| yonwork-adapter | ⬜ P3；[Host 传输探测](verification-yonwork-2026-09-21.md) 已通，Agent 派发/终态/证据闭环未实现 |
| 远程 runner、多租户、mTLS、审计流 | ⬜ P4 |

P2 后端出口验证记录在 `scripts/e2e-mission.mjs`（不代表 WebUI 或整个 P2 完成）：建 Mission → Workflow 派发 →
codex 真实执行 → 收结果落账本 → 逐条核对验收标准 → 独立复算证据哈希 →
核对事件流。与 P0 的单跳脚本互补：那个证明「能调起 codex」，这个证明
「调度系统真的会去调 codex」——两头都在不等于线接上了。

两个进程入口（`apps/worker/src/main.ts`、`apps/control-plane-api/src/main.ts`）
只做接线：Store 换成 PgStore、生命周期接信号，Workflow 与 Activity 与测试里
跑的是同一套。验证方式是实际启停一次并跑真实 Mission，不看进程是否存活。

`POST /v1/missions` 先写账本，再按固定 Workflow ID 启动；无法确认启动时返回 503，
客户端用原键恢复。Mission ID 由 tenant/owner/request_id 的哈希派生，语义输入不符则 409。
Store 重试不覆盖状态、时间或已写事件；Temporal 对运行实例 USE_EXISTING、对关闭历史
REJECT_DUPLICATE。账本已离开 DRAFT 时不再次启动。输入契约复用派发验收定义，
创建事件不再携带目标正文。API 只接受本机 Host，并对所有 POST 校验来源、JSON 类型及大小。

返工闭环已接进主 Workflow：验收不过 → 硬门槛判定产出 `review-decision` →
派生后继任务 → 再跑一轮，直到通过，或两道刹车之一触发（轮次耗尽 / 判定无进展）
后升级给人。判定刻意**不用 LLM**——验收标准本来就是机读的，让模型回答「过没过」
得到的是不可复现也无法审计的主观判断。软判断（Claude 评审）可以覆盖在其之上，
但不得推翻硬指标。

审批闸口已接进主 Workflow：controlled / mutating 任务派发前创建对应 scope 的
审批并进入 `APPROVAL_REQUIRED`；错 scope 不放行，正确批准后才调用 Adapter，
拒绝则 Task 落 `REJECTED`、Mission 落 `FAILED`。`scripts/e2e-approval.mjs`
用真实 REST API、PgStore、Temporal 与 Codex 验证整条链路。
该脚本使用明确标注的合成测试身份，只证明技术闸口；OIDC/真人身份认证仍属 P4。

审批决定只能从 pending 进入终态。相同决定与身份的重试返回原记录，保留首次时间；
其他决定或身份不能覆盖它。PG 在行锁内执行与 Memory 相同的转换规则。
到期（含边界）后批准返回 409；等待 Activity 使用账本的到期时间，重试不延期，
超时与真人决定并发时重新读回唯一终态。契约见 `schemas/approval-decision-input.v1.schema.json`。

SSE 契约为 `schemas/mission-event.v1.schema.json`，端点为
`GET /v1/missions/:id/events`。只推送事件类型、时间和关联 ID 等白名单元数据，
不传任意 payload；页面收到事件后按需读取现有 REST。`Last-Event-ID` 为 SSE `id`
（event_id 的 URI 编码），未知或不属于本 Mission 的游标返回 400。
重连完整回放，客户端以 `data.event_id` 去重；lamport 是逻辑顺序，不是 PostgreSQL
事务提交顺序，直接取最大值会漏掉晚提交事件。当前每连接每秒扫描本 Mission
事件，适用于本地 P2；事件量或连接数增长后需提交有序的持久游标，不能冒充已具备规模化推送。
`scripts/e2e-events.mjs` 用隔离 PostgreSQL schema 与两个数据库连接验证真实晚提交、
实时事件、断线回放、租户隔离和无任务 Mission 列表。

P0 出口验证记录在 `scripts/e2e-single-hop.mjs`：信封校验 → codex 真实执行 → 结果 Schema 校验 → 证据哈希独立复算 → 验收标准逐条回应 → 幂等去重。

## 跨主机扩展点

P4 迁移时**调度器与 Adapter 代码不应改动**。若需大改，说明早期边界画错了。

| 预埋项 | 当前实现 | P4 变化 |
|---|---|---|
| runner 模型 | 本机进程内 | 远程 WSS 长连接 |
| Store / Transport 接口 | 内存 / 本机 | PostgreSQL / WSS+mTLS |
| artifact 引用 | 工作区相对路径 | S3 兼容对象存储 |
| `tenant`/`owner` 字段 | 已写入，单租户 | 真实鉴权 |
| `lamport` 逻辑时钟 | 已写入 | 跨主机排序 |
| 上下文寻址 | `repo`+`ref`+相对路径 | 不变 |

## 防坑清单

前几条来自 aiticket JobMaster 的静默失败实战：

1. **无证据即失败** — 不得凭 rc=0 判成功；声明的产物缺失即 failed。
2. **握手 ≠ 完成** — YonWork `chat send` 的 SSE 连接建立不能证明消息完成，必须观测到 `complete_observed` 终态。最容易误判成功的一处。
3. **写入即校验** — 状态写入后立即回读，不信返回值。
4. **自检端点** — 进程存活 ≠ 在调度。
5. **时钟显式化** — 一律 UTC；排序用 `lamport` 不用 wall clock。
6. **不装 watchdog** — 用 `KeepAlive` + `ThrottleInterval`，进程幂等启动。
7. **预算硬止损** — 轮数/时长/成本耗尽即升级，绝不无限重试。
8. **无进展检测** — 不靠自然语言判断，用 `patch_hash_unchanged` + `failed_criteria_unchanged` + `metric_improvement_ratio` + `same_error_fingerprint` 组合判定。
9. **资源锁带 TTL 且可抢占**。
10. **外部副作用幂等** — 所有 Activity 带 `idempotency_key`。

### 判定就绪要看实际使用路径

搭建 Temporal 时遇到一个典型案例：`docker ps` 显示 Up、`netstat` 显示端口 LISTEN、宿主 `nc` 能连通——**三个信号同时为真而服务实际不可用**（`default` namespace 根本不存在，容器每 60 秒重启一次）。

根因是 `~/.docker/config.json` 的代理配置被注入每个容器，而容器内 `127.0.0.1` 无代理监听。详见 [infra/docker-compose/README.md](../infra/docker-compose/README.md)。

结论：**就绪判定一律以 SDK 实连为准**（`scripts/verify-temporal.mjs`），不以容器状态、健康检查或端口监听为准。

## 经评审修正的设计

2026-08-03 的架构评审（`pdf-cmap-arch-review`）推翻或修正了几处，记录以免重蹈：

- **fencing token 不适用于哑资源**。真机、YonWork、worktree 都无法校验并拒绝过期持有者，加该字段只会制造已防住脑裂的错觉。改为锁续租 + runner 失锁自停，见 [ADR-0004](adr/0004-brain-split-on-dumb-resources.md)。
- **幂等不能只存在进程内存**。Activity 重试可能落到另一个 Worker 进程，内存 `Map` 届时为空会导致重复 spawn Agent。binding 必须落库，见 [ADR-0005](adr/0005-workflow-ledger-boundary.md) 规则一。
- **删除投机性预留**：`resumeSession`（为尚未实现的返工预留，形状取决于实际实现）、A2A 状态映射（对应一个已决定不实现的协议栈）、`ArtifactRelation` 从 8 种收到 2 种（其余无使用场景，只制造选择负担）。
- **`runner_id` 进入 `RemoteTaskBinding`**：原先只有「任务在哪」没有「谁在执行」。

## 相关文档

- [threat-model.md](threat-model.md) — 威胁模型与安全控制
- [adr/](adr/) — 架构决策记录
- [../infra/docker-compose/README.md](../infra/docker-compose/README.md) — 本地开发栈与三个代理陷阱
