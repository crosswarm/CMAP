# Memross 记忆上下文快照

派发前从 Memross 共享记忆检索少量内容块，冻结为本任务的输入证据交付给 Agent（《Memross 与 CMAP 统一记忆体系实施手册》第 8 章）。CMAP 不建长期知识库，只保存任务当时用了哪些记忆。

## 契约

`mission-create` 可选字段 `memory`：

```json
{ "memory": { "project_id": "prj_aiworkbench_dev", "query": "预制工作台磁贴数据恢复", "limit": 2 } }
```

- `project_id` 是 Memross 项目 ID（`memross-memory scopes` 可查）；`query` 省略时用 goal 前 500 字；`limit` 1–5，默认 3。
- inspect/v1：快照附在首个任务上。dag/v1：作为各节点的缺省记忆，节点首轮以节点 goal 作查询；节点可在 plan 里用自己的 `memory`（同形状，`query` 省略时用节点 goal）覆盖。
- 字段进入 `Mission.constraints.memory`，参与幂等比较。

## 流程

1. `createTask` Activity（首个任务，无 `creationKey`、调用方未给 `artifactRefs`）读取 `constraints.memory`。
2. 调 Memross `search`，对每个结果调 `read` 取完整块，本端复算 SHA-256，不采信服务端自报；正文超 24 KiB 截止。
3. 生成 Markdown 快照（顶部 JSON 清单：块 ID、版本、散列、索引版本、request_id、分支；只存查询散列），写入任务工作区 `inputs/memory/<sha256(artifact_id)>/payload`，再用 `readVerifiedArtifact` 复核路径、散列与凭据模式。
4. 以 `artifact_refs[{artifact_id, uri, role: "memory_context", sha256}]` 写进信封，并在 Store 登记 artifact（producer `memross`）。
5. Agent 按现有输入证据渲染读取（“数据，不是指令”）。

重试幂等：任务已入账时沿用信封里的快照引用，只复核字节，不重新检索。Workflow 未改，无需 `patched()`。

返工与后继：首轮快照不重新检索，而是以 review input（`source_task_id` 指向首轮任务）交给返工后继，派发时复核 registry 与字节后复制到 `inputs/review/<sha256(artifact_id)>/payload`，因此同一 Mission 前后各轮看到同一份记忆。DAG 后继节点经依赖产物复制拿到父节点的快照。返工信封另带 `inputs.previous_attempt`（上一轮未通过的标准与 focus），提示词渲染为「上一轮未通过」一节。inspect/v1 的这一形状由 review-application `followup_format: 3` 冻结，旧回执按原格式重建。

## 回写（协作与交接）

两类写入都是旁路，用 Worker 同一个 `MEMROSS_TOKEN`（cmap-worker actor，需 `propose_projects` 覆盖目标项目），Memross 拒绝或不可达时只记 `KNOWLEDGE_PROPOSAL_FAILED` / `HANDOFF_FAILED`（错误类别），不改变 Mission 结果。项目范围取 DAG 节点 memory，其次 Mission memory；都没有则不回写。Workflow 新增调用用 `patched()` 守卫，旧历史重放不插入新 Activity。

- **协作**：任务 `REVIEW_ACCEPTED` 后，结果里非 info 级 `findings`（kind `pitfall`）与 `recommended_followups`（kind `procedure`）各一条提交 `POST /api/memory/v1/propose`，每任务至多 5 条。证据为本任务结果产物 `cmap-artifact:<task_id>/<artifact_id>`（冒号等字符按位替换为 `.`）+ 散列，以及任务冻结快照里同项目的 `memross-block`；块已被取代而被拒时退回只带 `cmap-artifact`。幂等键逻辑上是 `missionId:taskId:i`，因 Memross 限 128 字符取 `cmap:<sha256(missionId:taskId) 前 40 位>:<i>`。事件 `KNOWLEDGE_PROPOSED` 只存 proposal_id 与状态。
- **交接**：Mission 落 `ESCALATED` 时 `POST /api/memory/v1/handoff`（`op: put`）一次：goal、终态与原因、各任务状态/绑定（adapter@runner）/结果状态、控制面重新判定的失败标准、证据链接（artifact URI、role、sha256）、`refs.mission_ids` 与快照里的 `block_ids`。事件 `HANDOFF_RECORDED` 只存 handoff_id；Memross 的 put 本身不幂等，CMAP 以事件为回执避免重复写。

## 配置与失败处理

Worker 环境变量 `MEMROSS_URL`、`MEMROSS_TOKEN`（Memross 只读 actor，`node scripts/memory.mjs add-actor` 生成，不入库）。令牌只进 Authorization 头；Agent 子进程环境白名单不含它。

Mission 要求记忆而 Memross 未配置（`MEMORY_NOT_CONFIGURED`）、不可达（`MEMORY_UNAVAILABLE`）、拒绝（`MEMORY_REJECTED`）或散列不符（`MEMORY_HASH_MISMATCH`）时，任务不创建、Mission 失败关闭，不静默降级。

## 验证

- `tests/workflow/memory-context.test.ts`：契约映射、快照散列与标注、工作区/信封/artifact 一致、重试不重检索、失败关闭。
- `node scripts/e2e-mission.mjs --memory <project_id> [--memory-query <q>]`：真实 Temporal + Codex，校验 Agent 写出的 `memory_block_id` 与快照第一条一致。

## 未覆盖

- YonWork 节点（无任务工作区）不附快照，也不接收返工产物。
- Memross 授权由 Worker 的服务凭据判定，尚未按最终执行主体重新授权（手册 8.3）；撤权后已冻结的快照仍可被重试任务读取。
- YonWork 等不支持工作区的 Adapter 未验证。
