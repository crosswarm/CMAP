# CLI 派发意图与恢复验证 · 2026-09-22

Codex/Kimi 的控制面派发改为：确定性 binding → 原子写 binding/RUNNING/TASK_DISPATCH_INTENT → 最后复核准入、审批与锁 → 启动进程。复用现有 Store/SPI，不增加进程注册服务或依赖。

## 行为与边界

- 两个 Adapter 的 `prepareBinding` 无 I/O；`beforeSend` 在异步准备完成后、spawn 前执行。拒绝时不启动，并清理自有临时目录，保留调用方工作区。Codex 删除了仅用于写入后立即读回的提示词文件，避免覆盖调用方同名文件。
- prepared 派发对所有声明的资源锁检查 task/mission/runner/有效期；YonWork 仍必须提供匹配的策略哈希，CLI 不伪造哈希。controlled/mutating 两种审批继续独立校验。
- 成功返回且绑定一致时只记一次 TASK_STARTED。响应丢失或事件写入失败后的恢复不能伪造启动确认，持久意图仍阻止再次启动。
- 新 CLI Adapter 无法观察旧进程时，仅对明确 BINDING_NOT_FOUND 返回 executionUncertain；RUNNING 原子转 INPUT_REQUIRED，重复收取只保留一条待处理事件，无 TaskResult/终态伪造。历史 QUEUED 绑定保持原状态。
- 旧 Mission 和 DAG 均升级处理；DAG 外层轮询也进入同一不确定记录路径，不杀未知进程，不凭未知状态释放锁。
- 这解决重复启动窗口，不提供进程重接管、全局 exactly-once 或远程身份认证。未实现 prepareBinding 的第三方 Adapter 仍有旧窗口；不带控制面回调的直接 SDK 用法也没有账本保证。

## 验证

- 行为红测试：原 CLI 忽略拒绝回调；原恢复抛 BINDING_NOT_FOUND；缺少 YonWork 哈希仍被接受；prepared 路径没有启动事件。修复后相应回归通过。
- Node 24 `npm run check`：360 基础 + 58 API + 156 Workflow，共 574 项通过；随后新增的启动事件写入失败补充回归也通过（prepared 文件 8/8），合计 575 个用例。最终 typecheck 通过。
- PostgreSQL Store：82 项通过，包含真实并发迁移与原子绑定契约。
- 真实 Codex 单跳：3 个样本文件，结果契约及证据哈希通过；中途服务请求超时后同次执行恢复，没有重派。
- 真实 Kimi 单跳：3 个样本文件，证据哈希通过。
- 隔离 schema `cmap_dag_cli_6b789596`、队列 `cmap-cli-6b789596`：真实 HTTP → Temporal → Codex/Kimi fork/join，3 Task 完成，2 份输入，总数 42，证据哈希一致，30 个事件、89 条历史，回放通过。
- 另行读取真实 PostgreSQL：三个 Task 均只有一个 TASK_DISPATCH_INTENT 与一个 TASK_STARTED，意图 lamport 均先于启动确认。
- 新 Mission：`mis_a62c14db352c37fbca6728680cdd2e9a0a6d9d3ad6ec6838a8eee527c6eb6c41`。
- 旧历史回放：`e2e-mis-e2e-mubzqo6b`（71）、`mission-mis_9424e547d11c85921cbd3620c7bf60cb8a3655e0a0963a84971d5f12167a2bbb`（89）、`e2e-mis-approval-e2e-muc5cq2i`（89）均通过。
- 独立代码复核通过；运行时原始输出与历史未入库。

## 本机预览

`http://127.0.0.1:8789` 首页、JS/CSS 和健康接口均为 HTTP 200。确认原有 2 Mission/6 Task 全部完成后，仅更新本机 Worker；Temporal DescribeTaskQueue 确认新进程实际轮询原队列。隔离验收 API/Worker 已正常停止，账本与私有证据保留。

## 仍未完成

YonWork 专用 profile 的真实配置/诊断授权仍待答复；Claude Planner 的实际鉴权拒绝尚未解除。远程 runner 注册/心跳、OIDC、mTLS、短令牌、完整隔离和远程发布仍是 P4 工作，不能据此宣称整个项目完成。
