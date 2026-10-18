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
