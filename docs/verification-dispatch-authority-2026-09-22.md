# 派发状态与审批复核 · 2026-09-22

修复范围是新执行的准入与批准检查，不是完整远程身份认证，也不是所有 Adapter 的原子发送。

## 修复与回归

- 原 legacy 路径在 DRAFT 状态也会调用 Adapter，之后才因非法 RUNNING 迁移报错。失败测试实际观察到一次启动；现在仅 READY/QUEUED/WAITING_RESOURCE 可开始新执行，探测期间进入审批等待也会拒绝，READY 转 QUEUED 带 expectedFrom 并发条件。
- 原 Codex/Kimi 路径仅依赖 Workflow 先等待审批。新增失败测试证明缺失审批或探测期间过期仍可启动；现在复用同一校验器检查 task、mission、独立 scope、approved 决定、已知非法/自批决策者标签、决策时间和有效期。
- 所有 Adapter 共享派发前复核；YonWork 发送前仍再次复核。失效批准使用现有持久拒绝记录 `APPROVAL_INVALID`，不能因重试或随后放宽条件而复活同一 Task。
- 产物物化仍只检查主机策略，允许之后进入人工审批；已有 binding 的观察与取消仍可恢复，不重新发送。
- Node 24 `npm run check`：353 基础 + 58 API + 145 Workflow，共 556 项通过；独立复审通过。
- 测试矩阵覆盖 controlled/mutating 两个 scope，以及缺失、pending、错 scope/Task/Mission、过期、Agent/自批标签、未来决策、早于创建的决策时间。修正了旧合成 fixture 中两次取时导致 decided_at 偶尔早于 created_at 的问题，没有放宽断言。

## 真实技术链路

在独立 `cmap_authority_5ydpsw71` schema/队列运行 `scripts/e2e-approval.mjs`：
Mission `mis-approval-e2e-muc5cq2i` 在批准前为 AWAITING_APPROVAL，Task 为 APPROVAL_REQUIRED 且没有 binding；错误 scope 返回 409。
正确 scope 的合成测试决策后，真实 Codex 执行并完成，审批与任务事件均可回读。
另行从磁盘核对 sample 中恰有 3 个文件，报告哈希与账本一致，并用当前 Workflow 代码重放该次历史。
这次使用明确标注的合成测试身份，只证明技术闸口，不代表真人身份认证，也不授权真实 YonWork 操作。

## 未关闭事项

本轮发现的 Codex/Kimi 启动后写 binding 窗口已由后续[CLI 派发意图修复](verification-cli-dispatch-intent-2026-09-22.md)关闭；进程重接管仍未实现。
审批者目前仍是本机记录中的声明；OIDC、工作负载身份、远程 token、完整隔离及部署继续待 P4。
YonWork 专用 profile 与诊断授权保持待答复，Claude Planner 鉴权拒绝尚未解除。
