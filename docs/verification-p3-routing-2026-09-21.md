# P3 能力路由与 Adapter 边界 · 2026-09-21

## 本轮实现

- 信封既有 preferred_agent / fallback_agents 明确启动前候选顺序；没有显式候选时按注册顺序。
- Activity 在派发前检查描述身份、能力、风险上限和健康；全无匹配时不把任务写为已派发。
- 启动后严格使用 binding.adapter 收取；不将启动确认丢失解释为可以另起替补。
- Adapter 自报绑定与实际选中项不一致时拒绝入账；拒绝重复注册身份与双配置。
- Worker 使用 Adapter 列表，当前仅注册真实 Codex；不冒充已经实现 Kimi/YonWork。
- Codex 证据路径检查逻辑与物理路径边界，拒绝目录穿越、工作区外绝对路径和符号链接逃逸。
- cleanup 按实际创建归属清理，不再因为调用方工作目录在 tmp 下就误删。
- Codex 的 -C、结果输出和 TMPDIR 都使用物理路径，避免卷别名被沙箱拒绝。

修改位于 `schemas/task-envelope.v1.schema.json` 及派生类型、`workflows/activities.ts`、
`apps/worker/src/main.ts`、`adapters/codex-adapter/src/index.ts`，新增针对性测试。
没有引入注册中心服务、路由框架或新依赖。

## 验证

Schema → codegen → 有效红测 → 实现：最初路由测试因始终派发第一项与未拒绝无匹配失败；
新增证据边界测试因越界未拒绝和误删调用方目录失败。修复后通过。
独立路由审查发现绑定身份未校验，补红测后已修复。

- `npm run check`：typecheck 通过；215 基础、55 API、58 Workflow，共 328 项通过。
- `npm run test:pg`：66 项通过；合计 394 项。
- 路由新增 8 项覆盖能力、首选替补、无候选、启动不确定、风险/健康、已绑定项缺失、重复身份和错误绑定。
- 真实链路结果见下方最终记录；不以 fake Adapter 或退出码单独宣称真实验证成功。

## 真实路由链路

隔离 schema `cmap_p3_routing_20260921`、队列 `cmap-p3-routing-20260921`、
工作目录 `/tmp/cmap-p3-routing-20260921`。`scripts/e2e-mission.mjs` 完成
Mission `mis-e2e-mua5y9w0`，耗时 156.5 秒、0 次返工。Task
`tsk_mua5yg1q_an7ygp_0001` 使用 codex-adapter 绑定，实测文件数 3、证据
SHA-256 一致，10 个账本事件到 MISSION_COMPLETED。71 个 Temporal 历史事件重放通过。
这是当前 Codex 候选的真实链路；多候选选择仍由可控 fake Adapter 测试覆盖。

两次单跳测试缺少 filecount_report 而失败。控制台同时出现模型请求重连，
但读取合成结果才定位到实因：SANDBOX_SYMLINK_WRITABLE_ROOT，
工作目录经 /Volumes/MacMini 卷别名，Codex 拒绝启动工具。既有代码只规范化 TMPDIR，
没有规范化 -C。补测试确认 -C 仍是别名的红测后修正；此问题不能归因于网络超时。
路由 Mission 使用独立 /tmp 目录已成功。最终原单跳路径也通过：
`scripts/e2e-single-hop.mjs` 返回 completed，实测 3，filecount_report 文件存在且
SHA-256 一致；调用方提供的工作目录在 cleanup 后仍保留。
临时 P3 Worker 验证后已停止，未动原 WebUI 预览环境。

## Kimi 证据与边界

Kimi CLI 2.0.1 用现有真实 home 可以回复合成探针。空 KIMI_CODE_HOME 会提示无模型；
引用现有 config/OAuth 的隔离 home 返回 0，但只有 system.version，没有 assistant，
状态 turn_count=0、model=null，进程确已退出。尚未查明原因，不能称为认证失败，
也不能把 rc=0 当成隔离链路通过。没有复制凭据或要求用户重新登录。

macOS 原生 sandbox-exec 合成探针验证工作目录可写、指定外部目录不可读写；
network-outbound deny 导致网络失败，allow 可请求模型所需网络。
出站域名白名单属于 P4 仍未实现项，不单独作为本机 P3 的停止理由。

Jev 对本轮混合摘要的辅助判断返回 reject、reason_code=uncertain、confidence=0.56，
仅作不确定性记录，没有把建议转换成授权。已有自主开发授权下由确定性测试和独立复核继续推进。


### 后续定位与可行路径（同日）

官方 2.0.1 源码确认：`oauth/kimi-code` 是刷新锁文件，真实凭据位置是
`credentials/kimi-code.json`。此前引用了错误文件，不能据此推断隔离模式不可行。
修正为单文件只读引用后，实际在写入 `credentials/kimi-code.json.tmp.*` 时 EPERM：
凭据需要正常原子轮换，单文件只读引用不能完成本次启动。

第二次合成探针使用私有 KIMI_CODE_HOME，将 **credentials 目录和 oauth 锁目录**
引用到原 Kimi home；配置、会话、日志、工作区留在私有目录。没有复制或输出凭据。
外层 sandbox-exec 只允许写私有目录和既有认证存储；`tools: []`、空 skills 目录。
真实输出为 assistant `CMAP_ISOLATED_HOME_OK`，退出 0。这是有限的无工具模型调用，
不是完整 Kimi Adapter，也不证明读路径白名单、网络域名限制或代码工具沙箱已通过。
共享认证存储是有意保留的例外，不应描述为“所有状态完全隔离”。

依据：[官方数据位置](https://moonshotai.github.io/kimi-code/en/configuration/data-locations)、
[命令参考](https://moonshotai.github.io/kimi-code/en/reference/kimi-command)；源码固定
`caf7d4e2fef06967280b325da06e44a4b0516eba`，重点为
`packages/oauth/src/{toolkit,storage,oauth-manager}.ts`。
下一步是将这条已验证的运行方式接入 Adapter SPI，并验证工具边界和结构化结果，
无需先要求用户重新登录。
