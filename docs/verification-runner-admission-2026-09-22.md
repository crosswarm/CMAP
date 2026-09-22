# 本机 runner 准入验证 · 2026-09-22

本轮完成本机准入执行点和崩溃恢复；完整 P4 与项目总目标仍未完成。
规划经 Architect 三轮、独立 Critic 批准，记录见 [计划](plans/cmap-p4-runner-admission.md) 与 [交接](plans/cmap-p4-runner-admission-handoff.json)。

## 代码与自动检查

- 新增 normalized runner 配置 Schema、生成类型、严格启动解析，以及基于持久化身份的确定性准入。
- DAG 复制前、加锁前与共享派发前复用同一规则；拒绝记录与状态事务持久化，优先于 binding 恢复和新授权判断。
- 真实 red → green 包括：原始越权 owner 会启动 FakeAdapter；未知 risk 被当作低风险；非法 descriptor ID 未拒绝；新增账本读取失败未取消已知绑定。均先复现后修复。
- Node 24 `npm run check`：353 基础 + 58 API + 141 Workflow，共 552 项通过；类型检查通过。
- `npm run test:pg`：82 项通过，包括新增的真实并发迁移回归。
- 独立代码复审通过；未新增依赖或 runner 注册表。

## 真实拒绝链路

隔离 schema/队列 `cmap_dag_admission_20260922_pozrfz10`，测试 API 8790/8791；8789 预览未参与该测试。
CLI 包装器只记录 `exec` 启动次数，不记录参数或提示词。

1. owner 不在白名单：Mission `mis_1659f9e32da811f773ca0c3df9fe9eb964226f1c55f38c14faeb91222ab7fbea` 进入 ESCALATED；唯一 Task 为 CANCELED，无 binding、结果、目录或派发事件，Codex 启动增量 0。新 Activity 实例在真实 PostgreSQL 上放宽合成策略后仍返回同一拒绝；历史重放通过。
2. DAG 父节点允许、子节点超风险：Mission `mis_a54186e527c8843d2a8a9a814ad4b090f1d5d16d3ccf3aafd30bfd906edc5864` 的父节点由真实 Codex 完成。独立回读报告数值为 42、哈希匹配；子节点在产物复制前返回 RISK_DENIED，无 Task、子目录或待审批记录，只有父节点的 1 次执行。历史重放通过。

## 真实允许链路与兼容性

Mission `mis_e567ab7200ae03f031d89ffdd472fdb7efbc74924267675721a64b3927411209` 经 API → Temporal → Codex/Kimi 执行：
3 个任务完成，两个父报告独立核验为 17/25，汇合报告为 42、输入数为 2；哈希及资源锁释放核验通过。
27 条领域事件、89 条 Temporal 历史事件，重放通过。补强逐父报告断言后使用 `--workflow-id` 只回读复验，没有重发 Agent。
变更前的真实 Legacy 71 条历史、DAG 89 条历史也用新 Workflow 代码重放通过。

## 同轮修复：并发空库初始化

Worker 与两个 API 首次并发启动时，一个 API 因 PostgreSQL 23505 退出，其余进程正常。
确认退出后只重启该 API，没有重启仍工作的 Worker 或重复发送已接受的任务。
根因是 `CREATE SCHEMA IF NOT EXISTS` 与 DDL 缺少并发串行化；`migrate()` 现复用事务并持有数据库/schema 级事务 advisory lock。
新增回归在真实 PostgreSQL 上并发启动 4 个独立 Store 连接：旧实现复现 `pg_namespace_nspname_index` 重复，修复后验证核心表和序列存在。只清理测试自身随机 schema。

## 保留的边界

本地配置标签不是远程认证。P4 注册/心跳、WSS/mTLS、OIDC、短期令牌、完整隔离、远程产物与上线仍未完成。
Claude Planner 本轮真实重试仍返回 `PLANNER_AUTH_REJECTED`；早先 qcl 只读探测达到 12 秒截止，后续已通过现有密钥直连验证主机可达，见 [部署主机核验](adr/0002-control-plane-host.md)。
YonWork 的专用 profile 与 controlled 诊断已提供[具体待授权方案](yonwork-live-acceptance.md)，当前没有收到批准，没有修改业务 Agent 或发送真实诊断。
Jev 对先落实际准入点的建议为 gate（confidence/probability 0.99），只作为方案参考，未用于授予权限。

## 后续修复：连接会话初始化

`Pool` 的 `connect` 事件不等待异步监听器。旧实现丢弃 `SET search_path` 的 Promise；普通查询虽然目前被 pg 串行排队，但初始化失败不会可靠地反馈给调用方，还会产生 pg 9 将禁止的查询重叠警告。
现直接使用已安装 pg 8.22 / pg-pool 3.14 的 `onConnect`，等待 schema 初始化完成后才交出连接；失败时由连接池关闭该连接并拒绝调用方。无新依赖，未改变 schema 配置或 SQL 契约。行为由[官方连接池文档](https://node-postgres.com/apis/pool)及已安装源码确认。

新回归先在旧实现复现应用查询过早发出；修复后验证延迟初始化、初始化失败及真实 PostgreSQL 并发迁移。另建两个独立随机 schema，保存同名 Mission 的不同目标，关闭后重新建立连接、不再调用 migrate，并发读取仍分别得到正确目标；只删除测试自身 schema。
`npm run check` 通过 360 基础 + 58 API + 157 Workflow 共 575 项；`npm run test:pg` 通过 85 项，最终 typecheck 通过。本机现有库另行用全新连接读取健康状态通过，未再出现查询重叠警告。
