# Mission 多后继执行验证记录（2026-09-22）

## 结论

Mission Workflow 的新运行已支持一次 review 产生多个 followup 后按声明顺序 FIFO 执行。Mission 只在队列清空且所有已处理叶任务 accept 后完成；分支升级、审批拒绝、准入拒绝、执行不确定、Activity 已知失败和任务数超限会停止继续派发，并只取消未绑定、无结果的 DRAFT pending 任务。

旧无 `mission-followup-queue-v1` patch marker 的历史保持原命令顺序用于 replay，不宣称自动补跑旧历史遗漏的后继。

## 代码与契约

- `schemas/review-decision.v1.schema.json` / `packages/domain-model/src/generated/review-decision.ts`：记录新 Mission queue 语义、16 个 immediate followup / 128 个总发现任务上限、按 lineage 继承 progress 和轮次。
- `schemas/mission-event.v1.schema.json` / `packages/domain-model/src/generated/mission-event.ts`：记录 `TASK_CANCELED` 可表示分支停止后的 pending cleanup，且取消回执绑定完整有序请求 hash。
- `workflows/mission.workflow.ts`：新增 versioned FIFO queue；仅在多 followup 且 `patched('mission-followup-queue-v1')` 为 true 时走新分支路径。
- `workflows/mission-pending-cancel.ts`：新增 narrow cleanup Activity helper。输入完整校验；全量 preflight 通过后才写；只取消 unbound/result-free DRAFT；重复必须匹配精确回执；DRAFT 上已有同 key 回执会失败关闭，除非回读确认是同请求并发已提交的 CANCELED。
- `workflows/activities.ts`：将 `cancelPendingMissionTasks` 注册为真实 Activity。
- `tests/workflow/mission-followups.test.ts`：真实 Temporal Worker 覆盖 FIFO、晚出现的分叉、嵌套分支、审批拒绝、执行取消、最终写入失败、fanout/total limits、ActivityFailure 边界；128 个任务在边界内全部执行。
- `tests/fixtures/mission-followups-legacy.json`：113-event 纯合成旧历史；已解码核对全部 31 个 payload，并移除实际 worker identity，用于跨机器重复运行旧历史重放。
- `tests/workflow/mission-pending-cancel.test.ts`：MemoryStore 和真实 PgStore 临时 schema 覆盖 idempotency、lost ack、全量 preflight、伪造/重复 receipt、foreign/bound/result task、输入突变和同请求并发提交竞态。
- `scripts/e2e-mission-followups.mjs`：真实 Pg/Temporal/Codex 链路验证脚本；只有“评审要求两个 independent followup”是合成夹具，不代表人工或业务审批。

## 实际验证

本机环境：

- Temporal: `node scripts/verify-temporal.mjs` 通过，服务端版本 `1.29.3`，namespace `default` 可用。
- WebUI/API: `http://127.0.0.1:8789/` GET 返回 HTTP 200 前端 HTML；`/v1/health` 返回 `{"ok":true,"detail":"missions=3 tasks=9"}`。原有 Mission 全部完成后已更新本机 Worker，Temporal SDK 确认新进程同时轮询 Workflow 与 Activity 队列；API 无需重启。
- Cross memory: `sync.py --quick --check` 返回 OK。

命令结果：

- `node --test --test-concurrency=1 tests/workflow/mission-pending-cancel.test.ts`：13 passed。
- `node --test --test-concurrency=1 tests/workflow/mission-followups.test.ts tests/workflow/mission-pending-cancel.test.ts`：29/29 通过（16 项 Workflow、13 项 cleanup）。
- `node scripts/e2e-mission-followups.mjs`：`verified=true`。
  - mission: `mis-followups-e2e-muchpame`
  - schema: `cmap_followups_e2e_muchpame`
  - taskQueue: `cmap-followups-e2e-muchpame`
  - workRoot: `$TMPDIR/cmap-followups-e2e-dju6Be`
  - taskIds:
    - `tsk_14e2b7dc87bd40b5d7e59d958b17a3fb21bd057902636b13a1a89684d5c4d183`
    - `tsk_900a3255ae2c2095aee3d490ca8f46cd5cfe8a7fbb109711c45fcf4b7dd65610`
    - `tsk_953b4534ccb6f786333e8717f0405dd64a6e8613a19761dfc2dec61ff3306d03`
  - 3 个真实 Codex task 全部完成；每个 task 生成 3 个 sample 文件；reported counts、artifact hash、parentage、task/Mission completion 和 fresh history replay 均验证通过。
  - history events: 163；耗时 547.384 秒。
- 新旧真实历史各 71/89/89/89/101/163 个事件均重放通过；另有上述 113-event portable 合成旧历史。
- `npm run check`：676/676 通过，包含 typecheck。
  - default tests: 392 passed。
  - API tests: 58 passed。
  - workflow tests: 226 passed。
- `npm run test:pg`：90 passed。

## 明确边界

- 本次没有推送远端，也没有远程部署。
- 本次没有把 Jev 建议写成人工批准。Jev 仅用于方案辅助；权限、schema、测试和真实链路由代码与证据验证。
- Reviewer followup 的 `inputs`、`parameters`、`task_type` 尚未完整物化；本次证明全部后继调度，不宣称 Reviewer 指令已完整支持。
- Remote Runner / OIDC / WSS、真实 Claude reviewer 认证、YonWork 专用 profile 仍是独立后续范围。
