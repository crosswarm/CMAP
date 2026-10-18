# ADR-0006：单用户 + Tailscale 双主机例外

- 状态：已接受
- 日期：2026-10-18
- 批准：Cross 于 2026-10-18 明确批准（范围仅限本文所述的单用户双主机，Stage 0 规则文档）
- 相关：[ADR-0002](0002-control-plane-host.md)（搁置）、[威胁模型「单用户双主机」闸口表](../threat-model.md#单用户双主机闸口)、AGENTS.md「安全边界」第 1 条

## 背景

`AGENTS.md` 与威胁模型把「接入第二台机器」视为需要 T1–T12 全部缓解先就位的事件，因为多人多机 + 跨公网等于远程代码执行平台。现实需求是：Cross 一个人拥有两台机器——CrossMini（现控制面所在）与 lap（`cross-m1mx`，笔记本）——希望让 lap 作为第二个执行节点，分担 Codex 任务。

这与 ADR-0002 设想的「公网控制面 + 多人 runner 反向拨出」不是同一个问题：没有第二个人、没有公网、没有跨租户。按 P4 全套要求（OIDC、mTLS、租户隔离）处理，成本远高于它消除的风险。

## 决策

**在单用户、Tailscale 私网、两台机器的范围内，允许 lap 作为第二执行节点；其余场景禁令照旧。** 例外成立的条件缺一不可：

1. **控制面唯一**：CrossMini 仍是唯一控制面、账本写入者与 Artifact 存储。Temporal、PostgreSQL、Task Ledger、Approval、签名私钥只存在于 CrossMini。
2. **lap 只运行 runner 守护进程**：不接入 Temporal，不连接 PostgreSQL，不持有账本写权限。它只做三件事——接收经签名的派发许可、执行 Agent 子进程、把结果与证据交还给 CrossMini。
3. **网络方向与暴露面**：runner 监听 `lap:8790`，**仅由 CrossMini 发起访问**。Tailscale ACL 只允许 CrossMini → lap:8790，不开放 lap → CrossMini 的任何入站，也不开放其他节点与其他端口。runner 不绑定公网地址。这是对 ADR-0002「runner 一律反向拨出」的有意偏离：Tailscale 私网内由控制面主动拨入更简单，且不需要在 CrossMini 上开放入站端口。
4. **lap 不持有控制面秘密**：不持有 Memross 令牌，不持有数据库地址与凭据，不持有派发许可的签名私钥（只持有验签公钥）。Memross 记忆快照仍由 CrossMini 在派发前冻结，随任务输入下发。
5. **许可签名与受众绑定 `runner_id`**：沿用 [dispatch-permit](../dispatch-permit.md) 的 Ed25519 许可，受众绑定 `runner_id`、Adapter、任务与信封摘要；错受众一律拒绝。
6. **时钟偏差上限 2 秒**：两台机器之间验签允许的时钟偏差不超过 2 秒，超出即拒绝，不通过放宽偏差来「修好」。
7. **失联不改派**：CrossMini 与 lap 失联超过 **600 秒**离线宽限后，lap 上进行中的任务进入 `EXECUTION_UNCERTAIN`，**不自动改派**到其他 runner、也不重跑。是否重做由人决定。这条沿用 Stage 1 的「执行不确定就升级，绝不重跑」。
8. **账本与证据只认 CrossMini**：lap 回传的结果经 CrossMini 采集后才写账本；Artifact 由 CrossMini 拉取并**独立复算 sha256**，不采信 lap 自报。

## 不在例外范围内

- 第二个人、第三台机器、任何公网可达的 runner：按原规则，T1–T12 缓解全部就位后才可接入。
- lap 接入 Temporal 或 PostgreSQL、lap 签发许可、lap 写账本：不允许。
- 本 ADR 只确立规则（Stage 0）。runner 守护进程、远程派发、Tailscale ACL 配置等实现（Stage 2 起）各自走契约先行与真实验证，**未实现前不得在文档中标注为已实现**。

## 后果

- AGENTS.md 的「第二台机器」条款保留原文，并指向本 ADR 作为唯一例外。
- 威胁模型新增「单用户双主机」闸口表，逐条列出上述规则及其落地状态；全部落地并验证前，lap 不得接收真实任务。
- Stage 1（Codex 适配器重启安全）是前置条件：没有「运行记录 + 绝不重跑」，失联与重启后的行为就无法满足第 7 条。
- 例外的前提是「只有 Cross 一个人」。这个前提变化（例如引入协作者）即例外失效，需要重新评审而不是顺延。

## 修订 1（2026-10-18，Cross 决定）：不改 Tailscale ACL

第 3 条中“Tailscale ACL 只允许 CrossMini → lap:8790”的要求，改为下列三层控制，不再修改 tailnet 策略：

- **原文规则不可行**：原规则要求 lap 不得访问 CrossMini 的任何端口，但 lap 的 Memross 采集器与记忆客户端要访问 CrossMini:8000。要让限制真正生效，还必须删除 tailnet 默认的全互通规则、并给设备打标签，会影响该 tailnet 内其他所有设备的互访。
- **控制面端口只监听本机**：CMAP 的 PostgreSQL（5433）与 Temporal（7233）只绑定 `127.0.0.1`（2026-10-18 核实），lap 与其他 tailnet 节点都无法连接。
- **应用层认证**：lap 守护进程只监听 lap 的 Tailscale IPv4（通配地址拒绝启动）。每个请求都必须带 CrossMini 的 Ed25519 请求签名（受众 runner_id、时间戳 ±2 秒、nonce 防重放），应答由 lap 签名；派发许可另行绑定 runner。未签名请求一律 401，且不执行任何动作。
- **残余风险（已接受）**：同 tailnet 节点可以连上 8790 端口发起无效请求，即连接层 DoS；应用层不加密，机密性依赖 WireGuard。其余条款不变。

## 修订 2（2026-10-19，Cross 决定）：离线宽限必须先于任务超时

第 7 条的 600 秒离线宽限大于 dag/v1 固定的 300 秒任务超时，执行中失联总是先撞上超时（取消请求不可达，升级 `CANCELLATION_UNCONFIRMED`），宽限路径实际不可达。改为：

- 宽限上限可配置（CrossMini Worker 的 `CMAP_REMOTE_OFFLINE_GRACE_SECONDS`，默认 600 秒）。
- 有效宽限 = min(宽限上限, 首次失联时距该轮等待截止剩余时间的一半)，保证执行中失联先被判定为执行不确定。
- 其余不变：判定后保留 binding、**不自动改派、不重跑**，由人决定。
