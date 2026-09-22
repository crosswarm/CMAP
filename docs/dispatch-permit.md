# 受管派发凭据

当前实现是**本机受管执行契约**。Worker 内控制面与 Adapter 仍同进程，不能据此宣称已认证远程主机、用户或审批人。

## 执行顺序

1. 读取已持久化拒绝记录或 binding；恢复不重新签发、不重复启动。
2. 复核主机准入、任务状态、独立审批与资源锁。
3. 签发最长 60 秒的 Ed25519 凭据，原子保存确定性 binding / RUNNING / TASK_DISPATCH_INTENT。
4. Adapter 在准备前验签，并持有任务与上下文的独立快照；异步准备结束后，执行控制面的 `beforeSend` 复核，再验签，最后才启动进程或发送消息。
5. 明确的 `DispatchPermitError` 转成 `PERMIT_INVALID` 拒绝记录：保留 binding，任务进入 FAILED_TERMINAL，没有 TaskResult。其他提供方错误不能冒充这类拒绝。

错受众、错任务、内容漂移、过期、未来生效、错误签名及超长凭据均拒绝。准备后的拒绝清理自有临时目录；YonWork 可能已准备空会话，但不得发送 chat。

## 格式与信任来源

Schema：[`dispatch-permit.v1.schema.json`](../schemas/dispatch-permit.v1.schema.json)。编码为 `cmap1.<payload>.<signature>`，两段使用规范的无填充 base64url。Ed25519 签名覆盖 `cmap1.` 前缀与原始 UTF-8 payload 字节，不重新序列化后验签，不声明 JWT/JWS 兼容。

声明绑定 issuer、公钥指纹 kid、runner、确切 Adapter 受众、Mission/Task/revision/idempotency key、信封 SHA256、时间及 nonce。信封摘要定义为 Node `JSON.stringify(envelope)` 的 UTF-8 字节；当前 Node 两端必须保留这一序列化契约。payload 上限 4 KiB，token 上限 8 KiB，`expires_at - issued_at <= 60`，不放宽时钟偏差。

Worker 启动时生成一次临时密钥：Activities 取得签发函数，Adapter 取得只使用公钥的验证函数。可信 issuer、runner、公钥来自构造配置，不来自凭据自述。密钥和凭据不写入账本、事件、Artifact、子进程环境或日志；没有旧 `CMAP_RUNNER_TOKEN` 透传或受管默认令牌。

## 接入规则

- 受管 Adapter 构造参数必须显式配置 `authorization: { mode: 'managed', verifier }`；Activities 必须配置 `signDispatchPermit`，并拒绝 standalone 或无 `prepareBinding` 的 Adapter。
- 直接 SDK 单跳显式配置 `authorization: { mode: 'standalone' }`，不进入受管 Workflow，也不具备签名授权或持久化派发保证。已有单跳脚本已明确选择此模式。
- Codex/Kimi 仅继承运行所需环境白名单；Codex 保留明确的自身提供方配置/凭据变量。控制面数据库、runner 令牌、TypeSafe 与其他未知环境变量不传给提供方。健康探测同样过滤。环境过滤不等于完整文件系统或网络隔离。

远程 WSS/mTLS、认证注册/心跳、OIDC、跨进程持久防重放与审计存储仍待 P4；nonce 本身不能替代防重放状态。验收证据见[验证记录](verification-dispatch-permit-2026-09-22.md)。
