# 本机 runner 准入

Worker 从操作员配置读取许可范围，不能从收到的任务推导权限。配置契约是
`schemas/runner-admission.v1.schema.json`；`RunnerDescriptor` 中的 runner/tenant/host 是本机声明，尚非 mTLS 或 OIDC 身份。

必填环境变量：`RUNNER_ID`、`RUNNER_TENANT`、`RUNNER_ALLOWED_TENANTS`、`RUNNER_ALLOWED_OWNERS`、
`RUNNER_ALLOWED_CAPABILITIES`、`RUNNER_MAX_RISK`。`RUNNER_HOST` 可省略，默认本机 hostname。
白名单是逗号分隔的精确标识；标识不能包含空白或通配符。空值表示 deny-all，缺失变量拒绝启动，重复和空白成员拒绝。
Agent inventory 来自已注册 Adapter 的 `agent_id`，不是 `adapter_id`；声明能力不会自动获得主机授权。
`runner_tenant` 不提供隐式授权，实际许可取决于显式 `allowed_tenants`。

API 的 `CMAP_TENANT`/`CMAP_OWNER` 必须与 Worker 许可匹配，但不会用作 Worker 缺失配置的默认值。
例如现有 8789 预览使用 `test-harness:dag`，不能只填 `.env.example` 中的 `local-operator`。
风险上限不会代替批准：controlled 和 mutating 仍分别走原有审批。
所有 Adapter 的新派发都会复核当前批准和合法执行状态，详见 [派发授权验证](verification-dispatch-authority-2026-09-22.md)。

## 执行与恢复

- 对照持久化 Mission/Task 核验信封身份、能力和风险，再判断 tenant/owner/capability/risk/host。
- DAG 在读取、复制父产物前检查，在未绑定任务获取资源锁前再次检查；共享派发在 Adapter 探测、目录创建和启动前检查。
- 初始拒绝将未派发 Task 合法转为 CANCELED；创建前的 DAG 拒绝不产生 Task 或目录。
- YonWork 意图已持久化、发送前拒绝时保留 binding，转为 FAILED_TERMINAL；不能清掉绑定后重发。
- 拒绝的 phase/code 与状态通过现有事件事务一起持久化。重试先恢复拒绝记录，再考虑已有 binding 或新策略；放宽配置不会让同一已拒绝 Task 复活。
- 已绑定任务的观察、结果收取和取消仍可用；观察期间账本读取失败则尝试取消已知绑定并保持不确定结果，不宣称远端完成。

`RUNNER_ADMISSION_DENIED:<CODE>` 表示初始拒绝，`RUNNER_ADMISSION_REVOKED:<CODE>` 表示发送意图后的拒绝。
策略拒绝进入 Mission/node ESCALATED；不把确定性的拒绝包装成重试耗尽。

## 验证

`npm run check` 验证契约、配置、领域规则、Workflow 和 API；`npm run test:pg` 验证数据库契约及并发迁移。
真实验收见 [本轮记录](verification-runner-admission-2026-09-22.md)。
`scripts/e2e-runner-admission.mjs` 要求独立 `cmap_dag_admission_*` schema、允许/拒绝 owner 的两个 API，
以及只统计 Codex `exec` 次数的本机包装器；不记录命令参数或提示词。`--dag-only` 用于前一拒绝场景已验证后的续跑。
正常分叉汇合使用 `scripts/e2e-dag.mjs`，只回读既有执行时用 `--workflow-id`，不会重新调起 Agent。

P4 的远程注册、WSS/mTLS、短期受众令牌、OIDC、完整隔离和远程存储仍未完成，不能据此开放第二个用户或主机。
