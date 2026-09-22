# 派发凭据验证 · 2026-09-22

## 实现与回归

- Schema → codegen → 原有未拒绝行为红测试 → 实现。历史版本的 Codex 在两个真实签名负例中均产生 `Missing expected rejection`；缺少签发器、standalone 混入和缺少 prepared binding 的组合也先复现未拒绝，再变绿。
- Ed25519 覆盖原始 payload 字节，固定算法，严格 base64url、UTF-8、大小、声明与时间校验。特别覆盖从 issued_at 计算完整生存期、非字符串 token、NaN 时钟拒绝；子进程通过私有 stdin 验证原始字节，不向提供方传密钥。
- 三个 Adapter 使用真实签名验证首次拒绝和 `beforeSend` 后过期拒绝。受管执行没有默认令牌或非 prepared 回退路径。
- 已复现并修复两项复核发现：Codex/健康探测继承控制面环境；异步准备期间调用方修改再恢复信封导致“签名内容与实际提示词不同”。环境白名单及私有信封/上下文快照的行为红测试均已转绿。
- `npm run check`：386 基础 + 58 API + 164 Workflow，共 **608 项通过**；`npm run test:pg`：**85 项通过**。一次整套运行暴露旧审批 fixture 的 1ms 实时时钟竞态；该测试现只冻结 Date 来验证显式停止，没有修改生产超时或放宽断言，之后整套重跑通过。
- 独立代码复核通过；未添加依赖。

## 真实边界与执行

隔离 schema `cmap_dag_admission_permit_472f032f`、队列 `cmap-permit-472f032f`，使用真实 PgStore、CodexAdapter 和只统计 `exec` 次数的私有 CLI 包装器：

| 用例 | 结果 |
|---|---|
| 错受众凭据 | 0 次 exec；FAILED_TERMINAL、保留 binding、无 TaskResult；新实例重读拒绝，不重新签发 |
| 过期凭据 | 同上 |
| 签名篡改 | 同上 |
| 白名单外 owner 经 HTTP/Temporal 提交 | 0 次 exec；准入拒绝、历史重放通过 |
| 合法父任务 → 超出主机风险上限的子任务 | 父任务真实执行一次，报告 value=42 且哈希一致；子任务不创建、不复制目录、不执行，历史重放通过 |

三个凭据负例覆盖真实数据库与 Adapter 边界，使用隔离的合成信任配置；不冒充 OIDC 或真实跨主机认证。合法父任务则由实际 Worker 启动时生成的受管信任配置签发、验证。

对应 Mission：`permit-wrong-audience-1790057544299`、`permit-expired-1790057544898`、`permit-tampered-1790057545014`、`mis_5b588e1a231d1b0b990daf747ac69b2f091a076a5ec5219d7a89c7a860245db0`、`mis_42232eaaa66bc0f09c335ce3188258c43631dd90af03b08f6bc8b9ad32b891e7`。

包装器只记录调用种类和禁止环境变量名称，不记录参数、变量值或提示词；5 次提供方调用（4 次探测、1 次 exec）均没有禁止变量。原始进程输出、密钥和凭据未提交到 Git；领域结果按既有 TaskResult 契约入账。

Codex/Kimi 显式 standalone 真实单跳也均通过文件数量与哈希核验，证明环境过滤保留了当前可用认证路径；这两个单跳不作为受管签名证明。

## 本机预览与边界

WebUI 仍为 `http://127.0.0.1:8789`。本机 Worker 已切换到受管模式，并由 Temporal DescribeTaskQueue 确认实际轮询；首页与健康接口可用，当前预览为 3 Mission / 9 Task。

新增 Mission `mis_1edbc70de1b8653dccc401cc95c9801f0ad3568bd95cdddc9825e3ee01ce573a` 经实际 HTTP → Temporal → 受管 Codex/Kimi 执行：3 Task 完成，2 份输入汇合为 42，证据哈希及锁释放通过；30 个领域事件、86 条历史，当前 Workflow 代码回放通过。不是 standalone 单跳结果。

另外回放旧 Legacy（71 条）、审批链（89 条）、旧 DAG（89 条）及前一轮 CLI 意图链（89 条），全部通过。隔离验收的两个 API 与 Worker 已正常停止，本机 WebUI 与受管 Worker 保持运行。

本轮不开放公网、不部署远端、不改变 YonWork 业务配置。WSS/mTLS、认证 runner 注册/心跳、OIDC、完整隔离及远程审计仍未完成。Jev 的方案选择建议为 permit（概率 0.93，confidence 0.9），只辅助设计，没有授予权限。
