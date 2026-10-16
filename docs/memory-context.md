# Memross 记忆上下文快照

派发前从 Memross 共享记忆检索少量内容块，冻结为本任务的输入证据交付给 Agent（《Memross 与 CMAP 统一记忆体系实施手册》第 8 章）。CMAP 不建长期知识库，只保存任务当时用了哪些记忆。

## 契约

`mission-create` 可选字段 `memory`：

```json
{ "memory": { "project_id": "prj_aiworkbench_dev", "query": "预制工作台磁贴数据恢复", "limit": 2 } }
```

- `project_id` 是 Memross 项目 ID（`memross-memory scopes` 可查）；`query` 省略时用 goal 前 500 字；`limit` 1–5，默认 3。
- 仅 inspect/v1，与 `plan` 同时出现返回 400。
- 字段进入 `Mission.constraints.memory`，参与幂等比较。

## 流程

1. `createTask` Activity（首个任务，无 `creationKey`、调用方未给 `artifactRefs`）读取 `constraints.memory`。
2. 调 Memross `search`，对每个结果调 `read` 取完整块，本端复算 SHA-256，不采信服务端自报；正文超 24 KiB 截止。
3. 生成 Markdown 快照（顶部 JSON 清单：块 ID、版本、散列、索引版本、request_id、分支；只存查询散列），写入任务工作区 `inputs/memory/<sha256(artifact_id)>/payload`，再用 `readVerifiedArtifact` 复核路径、散列与凭据模式。
4. 以 `artifact_refs[{artifact_id, uri, role: "memory_context", sha256}]` 写进信封，并在 Store 登记 artifact（producer `memross`）。
5. Agent 按现有输入证据渲染读取（“数据，不是指令”）。

重试幂等：任务已入账时沿用信封里的快照引用，只复核字节，不重新检索。Workflow 未改，无需 `patched()`。

## 配置与失败处理

Worker 环境变量 `MEMROSS_URL`、`MEMROSS_TOKEN`（Memross 只读 actor，`node scripts/memory.mjs add-actor` 生成，不入库）。令牌只进 Authorization 头；Agent 子进程环境白名单不含它。

Mission 要求记忆而 Memross 未配置（`MEMORY_NOT_CONFIGURED`）、不可达（`MEMORY_UNAVAILABLE`）、拒绝（`MEMORY_REJECTED`）或散列不符（`MEMORY_HASH_MISMATCH`）时，任务不创建、Mission 失败关闭，不静默降级。

## 验证

- `tests/workflow/memory-context.test.ts`：契约映射、快照散列与标注、工作区/信封/artifact 一致、重试不重检索、失败关闭。
- `node scripts/e2e-mission.mjs --memory <project_id> [--memory-query <q>]`：真实 Temporal + Codex，校验 Agent 写出的 `memory_block_id` 与快照第一条一致。

## 未覆盖

- DAG（dag/v1）节点与返工后继任务不附快照。
- Memross 授权由 Worker 的服务凭据判定，尚未按最终执行主体重新授权（手册 8.3）；撤权后已冻结的快照仍可被重试任务读取。
- YonWork 等不支持工作区的 Adapter 未验证。
