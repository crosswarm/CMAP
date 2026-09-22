# 已知凭据证据门禁验证（2026-09-22）

## 实现与范围

在共用结果归一化及证据读取入口加入已知凭据模式拒绝；独立审查通过。
规则从 `scripts/precommit-checks.mjs` 原样移到 `packages/adapter-sdk/src/secret-patterns.ts`，Git 豁免留在原脚本，运行时不豁免。
没有增加依赖、服务、审批权限或数据库结构，未改写证据字节与哈希。具体边界见 [说明](evidence-credential-guard.md)。

## 失败证据

- 真实临时文件包含合成 API-key 形状、正确 SHA256，旧 `readVerifiedArtifact` 仍返回字节。
- 三项 SDK 新测试在实现前失败：结构化结果缺少拒绝、证据字节缺少拒绝、调用方异步突变污染结果。
- 真实文件 → FakeAdapter 收取 → 共用归一化 → Activity 的回归，在旧读取器下得到 `completed`，预期为 `failed`。
- DAG/返工测试证明旧安全字段为 false 时，正确哈希的合成凭据文件仍会被复制；随后加入共用门禁使其被拒绝。

上述均为合成样本，不是实际账号凭据；负例没有发送给模型。

## 验证结果

- Node 24.13.0，针对性 SDK、Activity、DAG/返工、pre-commit、Jev helper：84/84。
- `npm run test:pg`：90/90。
- 独立 `TMPDIR` 下 `npm run check`：711/711（397 默认、58 API、256 Workflow），含 typecheck。
- `node scripts/e2e-single-hop.mjs`：真实 Codex 通过；同一运行经历超时重连后完成，未重复派发。实际 3 个文件、报告 `sample_file_count=3`、证据 SHA256 与验收覆盖一致。
- 此脚本提供合成信封，实际调用 Codex，**不调用 Claude**；已修正其旧输出措辞，不将其当作 Planner/Reviewer 的通过证据。
- 新错误只包含固定 code/message/fingerprint；负例结果无 Artifact，账本与事件不含样本。DAG 无子任务，返工目标无 payload。
- 预览队列通过 Temporal SDK 查询确认为 0 个运行中 Workflow 后，已刷新本机 Worker；SDK 确认新进程轮询 Workflow 与 Activity。WebUI GET 200，健康检查 `missions=4 tasks=12`。

## 其他核验与未完成项

- Claude `plan-mission.mjs` 的 2026-09-22 真实复测仍返回 `PLANNER_AUTH_REJECTED`；没有生成计划或修改账号。
- 当前 Workflow 只有确定性硬门槛判定。语义 Reviewer / Judge 尚未接入，已在架构状态表单列，不能与 Planner 认证阻断混同。
- Jev `jev-1.13.0` 对共享入口拒绝方案给出 `shared_reject`，confidence 0.92、probability 0.94；Architect → Critic 共识批准，实现后独立审查无阻断。
- 模式未命中不证明内容没有秘密/PII；历史账本、未知/编码/二进制秘密、原始会话清理、角色 ACL 和远程安全控制仍未完成。
- 没有推送或远程部署。
