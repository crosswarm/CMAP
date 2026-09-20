# 显式 DAG 本机执行验证

本轮实现 `dag/v1`：客户端提交有类型的计划，控制面校验图、验收覆盖和风险上限，
Temporal 调度真实 Codex/Kimi Adapter，依赖节点读取父节点已验收的最终产物。
这不是自然语言 Planner，也不包含远程 runner 或 YonWork Agent 执行。

## 实现与边界

- [计划契约](../schemas/mission-plan.v1.schema.json)：最多 32 节点，并发 1–4；
  默认 2。环、缺失依赖、重复节点/验收覆盖以及超出 Mission 风险上限在写库前拒绝。
- [DAG Workflow](../workflows/dag.workflow.ts) 独立于旧 `missionWorkflow`；
  API 新建和 DRAFT 恢复都读取持久化模板选择 Workflow，Worker 同时注册两者。
- 每个节点由最终 Task、精确 accept Review、确定性指标和 AVAILABLE Artifact 登记共同证明。
  已完成的返工旧 Task 不能解锁后继。全局终态只由 finalizer 回读账本后写入。
- 直接依赖的全部 AVAILABLE 产物经物理路径校验和独立哈希复算，复制同一份读取字节，
  原子发布到子任务命名空间。源/目标符号链接、篡改和重试冲突均拒绝。
- Task/Review 同键同输入幂等，异输入冲突；MemoryStore 的快照语义与 PostgreSQL 一致。
- 节点等待审批后才申请资源；`controlled` 和 `mutating` 仍是独立授权范围。
  Jev 提供建议，不能伪装为本人批准。宿主工具审批没有被关闭或绕过。
- WebUI 按 `plan_node_id` 投影验收、依赖、轮次与执行端；返工完成与节点验收分开，
  全局停止后未创建的节点显示阻塞。

## 真实验证

独立本机 schema/queue/workroot：`cmap_dag_live_20260921` /
`cmap-dag-live-20260921` / `/tmp/cmap-dag-live-20260921`。
通过真实 HTTP 创建，非直接写测试结果到 Store。

第一轮 Mission：`mis_9424e547d11c85921cbd3620c7bf60cb8a3655e0a0963a84971d5f12167a2bbb`。
Codex 输出 17，Kimi 输出 25，Codex 汇合读取两份复制的真实报告，输出 42、input_count=2。
3 个 Task、27 条账本事件；子任务创建晚于两份 accept 事件；Mission 只完成一次。
所有报告与输入文件的哈希独立复算一致，89 个 Temporal 历史事件内存重放通过。

第二轮使用 Node 24.13.0 的 API/Worker，Mission：
`mis_8b66ed5b6c006de78f3d710abec00c42b64482cb45bffda13db610aa8d6cbb2a`。
父节点各持有 15 秒租约，汇合节点申请相同两项资源。实际观测到租约持有 146 秒后仍剩余
13 秒且到期时间已延长；最终仍是 3 个 Task、两份输入、总和 42、27 条账本事件，
无残留有效锁，89 个历史事件重放通过。

验证脚本 [e2e-dag.mjs](../scripts/e2e-dag.mjs) 支持
`--workflow-id <既有运行>` 只回读和重放，不重新执行 Agent。
首轮验证曾因脚本误把 Adapter ID 写成简称而失败，改为实际 SPI 标识后重验同次运行通过。

旧 inspect 历史用新版 Workflow bundle 重放通过：

| 运行 | 事件数 | 结果 |
| --- | ---: | --- |
| `e2e-mis-e2e-mua7nzte`（Kimi） | 71 | 通过 |
| `e2e-mis-e2e-mua5y9w0`（Codex） | 71 | 通过 |
| `e2e-mis-e2e-mu9yvyx8`（成功） | 71 | 通过 |
| `e2e-mis-e2e-mu9yzrzo`（返工升级） | 101 | 通过 |
| `e2e-mis-approval-e2e-mu9z1m3r`（审批） | 89 | 通过 |

Ego TaskSpace 3 的同一页面验证了实际完成的 Mission：三项结果 17/25/42 分别归属正确节点，
执行端和依赖正确；桌面与 390px 窄屏均无页面级横向溢出。历史与截图未入库。

Node 24.13.0 最终检查：`npm run check` 通过（277 基础、58 API、121 Workflow），
`npm run test:pg` 74 项通过，`npm run build:web` 通过。
回归测试先复现再修复：未启动独立节点未被阻塞、返工 Review 部分落库、轮询异常未取消、
挂起的取消/状态查询没有真正受 5 秒上限约束、派发期间租约续租、父目录符号链接越界，
以及包装进程退出后残留子进程与同键并发派发。
Codex 同键并发测试修复前实际启动 8 次、修复后 1 次；Codex/Kimi 进程树测试用真实本机子进程。
并行测试曾因 PID 文件在 2.51 秒才生成而超过 2 秒就绪等待；仅将 fixture 就绪等待改为 10 秒，
取消确认的 5 秒约束保留，失败路径补齐已拥有进程的清理。
额外回归证明：5 秒观察期后才返回的派发，无论成功还是绑定落库后报错，都会继续尝试取消
本次已拥有的 Agent；立即派发失败但绑定已经存在时也不会遗留运行进程。

## 辅助判断和未完成项

Jev `jev-1.13.0` 对本机合成 DAG 验证建议 continue，confidence=0.53、reason_code=uncertain；
此建议不代替真实测试。输入仅为脱敏动作摘要，未发送仓库或业务数据。

自然语言 Planner、YonWork 派发/终态/证据闭环、P4 OIDC/mTLS/远程 runner 和部署仍未完成。
全项目原目标保持进行中；上述本机验证不等于多用户或生产交付。
