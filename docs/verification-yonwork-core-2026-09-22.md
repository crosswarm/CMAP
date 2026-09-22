# YonWork 核心链路接入与既有链路回归

## 当前结论

YonWork Adapter 已完成本地实现与合成集成回归，尚未通过真实 YonWork 聊天验收。
本记录不会把合成 Runtime 测试当作真实 Host/Gateway 执行证据。
本机 WebUI：`http://127.0.0.1:8789`，已回读健康接口，任务组与任务列表可读取。

## 已验证

- Temporal SDK 验证：服务端 1.29.3，default namespace 可查询。
- Memory/Pg 共享 Store 契约：本轮 PostgreSQL 81 项通过。
- 预写派发测试 7 项通过：RUNNING/binding/intent 在发送前原子持久化；审批范围、有效期和来源检查；真实持有的资源锁；策略/锁变化拒绝发送；并发只发送一次；确认丢失后不重发；报告保守分级。
- 独立代码审查通过共享派发、Store CAS、DAG 映射和报告元数据路径；审查运行相关测试 101 项通过。
- API 58 项、Workflow 132 项通过。后者包括真实 YonWorkAdapter 与合成 Runtime 的 3 项集成检查：预写意图、相关 final 帧、严格 JSON、落库身份与独立报告哈希；仍不代表真实 YonWork 聊天成功。
- WebUI 生产构建通过；YonWork 只读探测返回 CLI 1.0.0、Host running、Gateway reachable、registry reported，观测范围仅为传输可达。
- 最终 Node 24 `npm run check` 通过：334 项基础测试 + 58 项 API 测试 + 132 项 Workflow 测试，共 524 项；类型检查通过。
- Adapter 独立复审通过。取消覆盖启动中断、延迟返回的发送句柄后续取消/清理、统一 5 秒等待上限；过期或无效 deadline 不发送。相关 16 项 Adapter 测试通过。
- 真实既有链路：使用新 Worker、隔离 PostgreSQL schema `cmap_yon_regression_20260922` 与队列 `cmap-yon-regression-20260922`，运行 `scripts/e2e-mission.mjs`。
  Mission `mis-e2e-mubzqo6b` 在 160.6 秒后 COMPLETED、无返工；实际 Codex 创建 3 个样本文件，29 字节报告由控制面独立复算 SHA256，账本及 10 条领域事件均回读通过。
- 同一真实执行的 71 条 Temporal 历史事件在内存中重放通过；未将历史或原始提示写入仓库。

## 当前边界

发送前要求显式 `yonwork:cmap-*` profile、空有效工具清单、冻结策略哈希、适用的 controlled 批准及真实 `yonwork:host` 锁。Jev 建议不修改批准记录。
Gateway `final/error/aborted` 必须匹配预定 runId 和 sessionKey；Host complete、EOF、退出码或 abort ACK 不证明远端结束。
捕获报告仅证明收到结构化回复，不能代替独立业务操作证据；报告登记为 restricted、内容未评估。

## 尚未完成

- Runtime 使用当前 Host 的 Agent 目录定位对应 OpenClaw 配置和状态目录，并核对 Gateway；拒绝配置指向远程 Gateway，避免误用本机默认 OpenClaw。此路径仍需专用 profile 的真实工具策略查询验收。
- 专用 `cmap-*` profile、其空工具有效策略和适用受控批准未完成真实链路核验；没有发送真实 YonWork 聊天或修改业务 profile。
- Claude Planner 上次真实调用返回 403；P4 远程 runner、身份认证与发布仍未完成。

本轮 Jev 返回 continue，但置信度 0.48、辅助入口 reason_code=uncertain；未据此放宽权限或声明通过。继续本地修改依据用户既有授权、代码审查及测试证据。
