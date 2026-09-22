# YonWork Adapter（本机接入）

状态：本地实现与合成集成回归已通过，真实 YonWork 任务尚未验收。验证记录见
[核心链路回归](verification-yonwork-core-2026-09-22.md)。

Worker 默认仍注册 Codex。显式注册 YonWork 的配置为：

```sh
CMAP_AGENTS=codex,kimi,yonwork
CMAP_YONWORK_AGENT_ID=cmap-<已配置的专用Agent标识>
```

仅填写变量不会创建或隔离 Agent。必须事先存在专用 `cmap-*` Agent，禁止使用默认或业务 Agent 代替。
Adapter 使用现有 `yonworkctl` / `openclaw` CLI；不复制凭据，不接受 Host URL 或令牌覆盖。

## 任务契约

显式 DAG 节点使用 `capability: yonwork.validate`、`risk_level: controlled`、
`preferred_agent: yonwork:cmap-<标识>`、无 fallback，并声明 `yonwork:host` 资源锁。
节点 `yonwork.chat_send` 必须为 true，`yonwork.policy_sha256` 必须为实测策略的 SHA256。
不能填占位哈希来绕过准备过程。

策略基线会话为 `agent:<标识>:explicit:cmap-policy`。必须由当前 Gateway 的
`tools.effective` 证明工具清单为空且没有未解决 notices；磁盘配置本身不能代替有效策略。
持久化派发意图后，为该尝试准备独立空会话，再核验同一策略，并重新核对批准和锁后发送。
适用的 controlled 批准必须来自真实授权流程；Jev 建议不是批准记录。

## 结果与恢复

仅接受匹配预定 runId/sessionKey 的 Gateway final/error/aborted。
Host `chat.complete`、连接关闭或取消 ACK 不算远端终态。
回复必须符合 `schemas/yonwork-output.v1.schema.json`；捕获文件路径、结果身份和证据哈希由控制面处理。
报告标记 restricted 和内容未评估，不能据此宣称业务系统操作已完成。

已有派发意图的任务不会在 Worker 恢复后自动重发；不确定接受状态可能需要人工核验。
取消未确认远端终态时保持不确定状态，不能以本地进程退出作为释放资源的依据。
尚不支持任意工具调用、默认业务 profile、附件上传、模型策略覆盖或任意远程文件读取。
