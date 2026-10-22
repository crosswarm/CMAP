# Mission 续接：取消、长等待与续作

实施计划 S5「续接」在 CMAP 侧的落地。衔接（返工上下文）、协作（propose）与交接（handoff）见 [记忆上下文](memory-context.md)。

## 取消

`POST /v1/missions/:id/cancel`，请求体 `{"reason": "..."}`（`schemas/mission-cancel.v1.schema.json`，1–500 字），响应复用 mission-submission v1（202）。

- 只有本机 owner 可取消自己的 Mission；跨租户 404，他人 403，终态 409，坏请求 400。
- 先写 `MISSION_CANCEL_REQUESTED`（actor 为本机 owner，payload 含原因），再向 `mission-<id>` 发送 `cancelMission` 信号；信号未确认送达返回 503，原样重试即可（事件按幂等键去重）。
- DRAFT（Workflow 未启动）直接落 CANCELED，不发信号。
- Workflow（inspect/v1 与 dag/v1）收到信号后立即并行执行 `cancelMissionTasks` Activity：
  - 未绑定任务落 `CANCELED`（`TASK_CANCELED`，reason `MISSION_CANCELED`），挂着的审批置为 `expired`；
  - 已绑定且未出结果的任务调用其 Adapter 的 `cancel`，记 `TASK_CANCEL_REQUESTED`（adapter、remote_task_id、runner_id、confirmed）；确认后落 `CANCELED`，未确认的保持原状态，不伪造取消；
  - 已出结果、未评审的任务直接落 `CANCELED`，不再评审。
- 主循环在下一个检查点（每轮开始、审批等待后、派发后、收结果后、Activity 失败时）再扫一遍并把 Mission 置为 `CANCELED`，返回 `state: 'CANCELED'`。最后一个任务已验收通过时 Mission 仍以 COMPLETED 收尾。
- 新分支由 `patched('mission-cancel-v1')` / `patched('dag-cancel-v1')` 守卫：旧历史即使收到过同名信号（当时没有处理器），重放时照旧忽略。

已知限制：Adapter 未确认停止的已绑定任务会让 Workflow 继续等该任务的终态（inspect/v1），或让 DAG 收尾时因仍有活动任务而失败；这是如实反映「执行可能还在进行」，需人工处理。

## DAG 长等待换历史（continueAsNew）

dag/v1 节点等资源锁（`runDagAttempt` 返回 waiting_resource）时每秒轮询一次，每轮都写入 Activity 与 Timer 事件；等上数天会逼近 Temporal 单历史上限。

等审批（`checkDagApproval` 返回 pending）不再轮询：API 在 `POST /v1/approvals/:id/decision` 落账后向 `mission-<id>` 发 `approvalDecided` 信号（只作门铃，不带业务数据，发送失败只记日志），Workflow 用 `condition` 等门铃、停止或收拢，最长 10 分钟后也回读账本，历史不随等待时间线性增长。由 `patched('dag-approval-signal-v1')` 守卫，旧历史照旧每秒轮询并可重放（`tests/workflow/dag-approval-signal.test.ts`）。

- 历史事件数达到 `maxHistoryLength`（Workflow 输入，默认 8000）或服务端 `continueAsNewSuggested` 时开始收拢：不再派生新节点，各节点在下一个等待点停下（记下 task、轮次、上一轮进度与所处阶段），仍在执行 Activity 的节点照常跑完。
- 所有节点都停下或结束后 `continueAsNew`，把已终结节点的结论与停下的节点交给新 run；新 run 从等待点继续，不重新物化任务，账本是唯一事实来源。
- 收拢途中触发停止（分支失败或取消）时不换历史，停下的节点按停止原因收尾。
- 由 `patched('dag-continue-as-new-v1')` 守卫；`tests/workflow/dag-continue-as-new.test.ts` 用小阈值在真实 Temporal 上跑出多段历史，并逐段 `runReplayHistory` 验证确定性。

inspect/v1 的审批等待在单个 7 天 Activity 内轮询，历史不随等待增长，未引入 continueAsNew。

## 续作 Mission（continues_mission_id）

`POST /v1/missions` 可选 `continues_mission_id`（仅限不带 plan 的请求，由合成单节点 dag/v1 的首轮任务接收；不能与 plan 同时出现）。来源必须同租户、同 owner 且已终结，否则 400（不区分不存在与无权）。字段进入 `constraints`，参与幂等比较。

新 Mission 首个任务在入账前冻结三类输入，写进工作区 `inputs/continues/<sha256(artifact_id)>/payload` 并登记在本任务名下（producer `cmap-continuation`，provenance 记来源 mission/task/artifact）：

| role | 内容 |
|---|---|
| `continuation_input` | 来源中 `REVIEW_ACCEPTED` 任务的可共享结果产物（字节经来源 registry 与散列复核） |
| `continuation_memory` | 来源各任务冻结过的 Memross 记忆快照（按散列去重） |
| `handoff` | 从来源账本推出的交接内容（JSON，与升级时写给 Memross 的同一构造） |

信封另带 `parameters.continues_mission_id`。不恢复 Agent 会话。账本 artifacts 以 `(task_id, role, version)` 唯一，同角色多份以 `version` 序号区分。重试沿用信封里的引用，只复核字节、补登记。返工后继经 review input 继承这些冻结输入。来源不合法时任务不创建、Mission 失败关闭（`CONTINUATION_INVALID`）。

## 真实链路验证

`TMPDIR=/private/tmp node scripts/e2e-continuity.mjs [--only c2,c7,c4,c8,c9]`：独立 PostgreSQL schema、独占任务队列、本脚本拉起的 Worker（与 `npm run start:worker` 同一入口）、进程内 `createControlPlane`、真实 Codex 与真实 Memross（cmap-worker 令牌从 `~/.config/memross/memory-cmap-worker.token` 读取，不回显）。判据只认账本状态、事件、Codex 执行次数（`TASK_STARTED`/进程组）与哈希。

2026-10-18 实测全部通过：

| 场景 | 判据 |
|---|---|
| C2 返工续接 | 2 个任务、`TASK_STARTED`=2；第 2 轮 `previous_attempt` 指向第 1 轮并含 ATTEMPT-KIND；上一轮报告与首轮记忆快照以 review input 交付，副本散列复核一致；Agent 写出的上一轮报告散列与快照首块 block_id 与账本一致；Mission COMPLETED |
| C7 知识闭环 | `KNOWLEDGE_PROPOSED` 的 proposal_id 在 Memross `proposals/` 为 candidate（actor cmap-worker@cross-mini，证据 cmap-artifact + memross-block），`maintenance/intake/` 已排队 |
| C4 续作 | 首任务带 continuation_input（散列＝来源已验收报告）、continuation_memory、handoff，副本散列一致；Agent 写出的来源报告散列与 mission id 正确；`TASK_STARTED`=1；COMPLETED |
| C8 升级交接 | `HANDOFF_RECORDED` 恰 1 条；Memross `handoff latest` 返回同一 handoff_id，含失败标准、证据散列、`binding=codex-adapter@e2e-s5` |
| C9 取消 | DAG 运行中节点收到 codex-adapter cancel（`TASK_CANCEL_REQUESTED` confirmed）并 CANCELED、Codex 进程组退出；等审批的未绑定节点 CANCELED、无 binding、审批 expired；`MISSION_CANCEL_REQUESTED` 记录原因与人类主体；`TASK_STARTED`=1；Mission CANCELED |

首轮实测发现：返工轮 Agent 照抄了「上一轮未通过」里 `actual` 的描述格式（`attempt_kind = "rework"`），导致本应通过的标准判不过。已在该节提示词中说明 `actual` 只写实测值。
