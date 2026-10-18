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

dag/v1 节点等审批（`checkDagApproval` 返回 pending）或等资源锁（`runDagAttempt` 返回 waiting_resource）时每秒轮询一次，每轮都写入 Activity 与 Timer 事件；等上数天会逼近 Temporal 单历史上限。

- 历史事件数达到 `maxHistoryLength`（Workflow 输入，默认 8000）或服务端 `continueAsNewSuggested` 时开始收拢：不再派生新节点，各节点在下一个等待点停下（记下 task、轮次、上一轮进度与所处阶段），仍在执行 Activity 的节点照常跑完。
- 所有节点都停下或结束后 `continueAsNew`，把已终结节点的结论与停下的节点交给新 run；新 run 从等待点继续，不重新物化任务，账本是唯一事实来源。
- 收拢途中触发停止（分支失败或取消）时不换历史，停下的节点按停止原因收尾。
- 由 `patched('dag-continue-as-new-v1')` 守卫；`tests/workflow/dag-continue-as-new.test.ts` 用小阈值在真实 Temporal 上跑出多段历史，并逐段 `runReplayHistory` 验证确定性。

inspect/v1 的审批等待在单个 7 天 Activity 内轮询，历史不随等待增长，未引入 continueAsNew。
