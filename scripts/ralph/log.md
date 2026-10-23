# CMAP 可运行缺口 Ralph 进度

## 起点（2026-08-31）

- 真实单轮 Mission 已跑通：Codex 真执行、结果与证据落账本、哈希独立复算。
- 自动返工代码已在工作区，单测与 Temporal 集成测试通过，但尚未提交。
- 真实 Codex 返工 E2E 上一次被 exit 137 中断，没有成功证据。
- 审批 Store 与 REST API 已实现，主 Workflow 尚未请求或等待审批。

## 执行约束

- 一轮只完成一个故事；验证前不得标记 `passes: true`。
- 契约先于实现，测试先于实现。
- 容器 Up、端口 LISTEN、进程 rc=0 都不能单独证明服务可用。
- controlled 与 mutating 授权互不蕴含。

## 第 1 轮：自动返工接入主 Workflow（通过）

- 实现：硬门槛确定性判定、后继 Task 派生、轮次预算与无进展两道刹车均接入 `missionWorkflow`。
- 证据：`npm run test:workflow` 40/40；真实 Temporal 用例覆盖首轮失败后第二轮通过，以及预算耗尽后升级。
- 全量基线：`npm run check` 173 + 17 + 40 全绿；`npm run test:pg` 56/56。
- 下一轮：真实 Codex `--rework` 链路，必须产生两条 Task 并以升级终态退出 0。

## 第 2 轮：真实 Codex 返工与升级（通过）

- 首次失败暴露 SPI 偏差：缺证据时 Adapter 抛异常，Workflow 直接失败；改为返回 `failed` 结果交给返工策略。
- 第二次失败暴露任务进程继承个人插件、hooks 与额外 writable roots；固定使用 Codex 原生 `--ignore-user-config --ephemeral`。
- 超时路径现在主动 `cancel` Agent，避免孤儿进程；Worker 关闭处理改为幂等。
- 真实证据：`node scripts/e2e-mission.mjs --rework` 82.5s 退出 0，产生两条真实 Codex Task，后继正确 supersedes 前一轮，事件含 `REVIEW_REWORK_REQUESTED`、`TASK_FAILED`、且仅一个 `MISSION_ESCALATED`。
- 下一轮：审批闸口接入主 Workflow，未批准不得调用 Adapter。

## 第 3 轮：审批闸口接入主 Workflow（通过）

- controlled / mutating 任务在派发前进入 `APPROVAL_REQUIRED`；批准前 binding 为空，Adapter 调用为零。
- 两类 scope 互不蕴含；API 批错 scope 返回 409，他租户审批不可见且不可决策。
- 正确批准后任务回到 READY 再派发；拒绝后 Task 落 REJECTED、Mission 落 FAILED。
- 真实验证：`node scripts/e2e-approval.mjs` 退出 0，事件流含 `APPROVAL_REQUESTED → APPROVAL_GRANTED → TASK_STARTED → MISSION_COMPLETED`。
- 真实验证期间修复：多轮审批状态事件幂等键带 Task ID；Codex 子进程 TMPDIR 解析为无符号链接的物理路径。

<promise>FINISHED</promise>

# 优化轮（2026-10-22 起，截止 2026-10-23 14:00）

范围见 `docs/user-stories/cmap-optimization-2026-10.json`（S01–S17）。主会话编排子代理逐条实现，每条由主会话核验后才标 `passes: true` 并提交；工作分支 `optimization-2026-10-22`，发布时快进合并到 main。

## S07/S08（已合入，待验收）

- `55f8769` compose 默认钉 `temporalio/auto-setup:1.29.3` 与 `temporalio/ui:2.56.0`（registry digest 与本机运行镜像一致）；`scripts/backup-db.mjs` 备份 cmap 与 temporal 到 `~/.cmap/backups`，实测备份并还原到临时库，逐 schema 行数一致。实际重启栈的验证留到 S17。
- `8dc4902` `npm run check` 纳入 `test:pg`；待下一次全量 check 通过后标记。

## S10、S11（通过）

- `6a6c18f` 凭据检测新增「凭据变量赋值」与「URL 内嵌口令」两条模式；URL 模式连主机段一起匹配，使本地开发 DSN 仍按占位符放行（pre-commit）。运行时扫描没有占位符放行，Agent 结果里出现带口令的连接串会被拒，属预期的行为变化。
- `ee4b7f0` 无进展判定按指标到 expected 的差距判断改善方向（`ProgressSnapshot.metricTarget`，缺省时保持旧语义，旧指纹不变）。
- 验证：子代理 worktree 内 typecheck 与 `npm test` 458 项全过；主检出 Planner 6 项失败已确认来自 S01 未完成的契约改动。

## S13、S14（已合入，待验收）

- `7d3ef1c` standalone（无 runsDir）时结果文件放进 `mkdtemp` 的独占临时目录。残余：codex workspace-write 沙箱通常可写 TMPDIR，Agent 运行中仍可能找到该目录预置符号链接；生产 Worker 与 lap runner 都配置 runsDir，不走此路径。
- `20a0cef` 自报重复 artifact_id 的产物按下标各自入账，证据引用指向全部同名产物。

- S13 验收：`node scripts/e2e-single-hop.mjs`（standalone，无 runsDir）真实 Codex 通过，退出 0。

## S01、S03、S04、S05、S06、S08、S09、S12、S14（通过）

- `e1ee6e2` S01：不带 plan 的请求合成单节点计划走 dag/v1；inspect/v1 只留给已入账记录；dag/v1 支持续作；修正 Agent 自报 failed 时 DAG 无法物化返工轮。真实 `e2e-mission.mjs` 默认与 `--rework` 均通过（子代理，独立 schema `e2e_s01`）。
- `e17e640` S03：执行不确定的 DAG 节点保持 INPUT_REQUIRED；e2e-remote-mission 的放宽断言已改回。
- `c5706a7` S04：收结果时去重 criterion_results（以最后一条为准，与硬门槛一致），未知标准不入账。
- `c076aa7` S05：受限产物不复制给下游节点，含不可共享产物的任务不回写 Memross。
- `adec1fc` S06：Store.listTenantEvents 一次查询；Mission 列表默认非终态加最近 50 条终态；前端不再逐个拉 RUNNING Mission 的任务。e2e-events 真实通过。遗留：侧栏未选中的 Mission 只能显示待审批，看不到 INPUT_REQUIRED 等需处理状态。
- `872ed54` S09：删除无调用方的 Store 方法与锁 Activity（生产 -233 行，测试 -379 行），`events_undelivered_idx` 幂等删除。
- `0da16c2` S12：审批 decided_by 必须等于服务端 owner（不符 403、未配 503，均不落账）。
- `20a0cef` S14：重复自报 artifact_id 的产物按下标各自入账。
- 合并冲突：S05 与 S01 的 import、S06 与 S09 的 Store 方法相邻处，均手工保留双方意图。
- 主会话验收：`0da16c2` 上 `npm run check` 全过（test 452、api 68、pg 86、workflow 311）；`e255eeb` 上 typecheck、build:web、test 452 通过。

## S16（已合入，待部署验收）

- `e255eeb` 设置 `CMAP_LOCAL_RUNNER_URL` 时本机 Codex 改经 127.0.0.1 的 runner 守护进程；Adapter 查找改为 adapter_id + runner_id，协议与契约不变。Kimi/YonWork 仍在进程内。本机守护进程不在线时无进程内回落；切换前需等进程内 Codex 任务收尾。

## S02、S15（通过）

- `3b033ba` S02：dag/v1 审批未决时 `condition(门铃, 10 分钟)` 等待，API 落账后发 `approvalDecided` 信号；`patched('dag-approval-signal-v1')` 兼容旧历史，补丁前合成历史重放通过。测试中等待 4 秒历史不再增长（修复前增长 44 个事件）。
- `10700df` S15：ADR-0007 影子模式。`CMAP_DELEGATION_POLICY_FILE` 加载并校验策略；审批闸口经 Activity 调用 Jev，只送可信字段，写 `JEV_DECIDED`（route=human），不改审批；WebUI 单独展示影子决定；`scripts/jev-shadow-stats.mjs` 统计一致率。Worker 需 `NODE_USE_ENV_PROXY=1` 才能经本机代理访问 Jev。
- `d4f69e8` e2e-approval 改走 dag/v1 并真实通过（约 39 秒）：决定后 1.4 秒派发，审批人为 owner；真实 Jev（jev-1.14.0）为两个审批各写一条影子决定，拒绝路径上 Jev 判 approve（置信度 0.34）而真人拒绝。
- 主会话验收：`d3f37a5` 上 `npm run check` 全过（test 453、api 71、pg 86、workflow 323）。

## S07（通过）

- 发布前先 `node scripts/backup-db.mjs` 备份（cmap 1.4 MB、temporal 3.7 MB），再按钉死的 compose `up -d` 重建 cmap-temporal 与 cmap-temporal-ui；`node scripts/verify-temporal.mjs` 通过，服务端 1.29.3。

## S16（通过）与 S17 进行中

- S17 已完成：快进合并并推送 main `a52251e`；CrossMini 栈按钉死镜像重启；lap 部署 `a52251e`（`~/.local/share/cmap-runner/a52251e`，复用 a4fb971 的 node_modules，锁文件未变）并 kickstart，守护进程就绪。
- CrossMini 真实验收（独立 schema，进程内 Codex）：`e2e-mission` 默认模式 22.2 秒完成；`e2e-approval` 29 秒通过，决定后 794 毫秒派发，两条 JEV_DECIDED（jev-1.14.0，shadow）。
- S16 真实验收：后台进程方式在 127.0.0.1:8791 起本机 runner（测试专用许可密钥，不复用 lap 的），`e2e-mission` 28.2 秒完成，binding 为 remote-runner-adapter@crossmini-runner，守护进程原件与控制面副本哈希一致；执行中 SIGKILL Worker 后 Codex 进程组存活，新 Worker 拉起后完成，TASK_STARTED 恰 1 条、运行记录 1 条。
- 未做：本机 runner 未安装为 launchd 常驻；`e2e-mission.mjs --restart-worker` 在本机 runner 模式下读不到运行记录（记录在守护进程工作区），本次手工编排同等流程。

## S17（通过）— 优化轮完成

- 两机复测：remote、capability、dag 两个方向、lap-restart、worker-restart、grace、lap-offline 共 7 个场景通过（详见 `docs/remote-runner.md`「发布复测（2026-10-22）」）。
- 复测发现并修复一个回归：`2a97549` 收尾时把节点已 escalated 的 INPUT_REQUIRED 任务视为等人决定，Mission 落 ESCALATED；修复前 grace 场景 Workflow 失败、Mission 停在 RUNNING。修复后 `npm run check` 全过（test 453、api 71、pg 86、workflow 324）。
- lap 运行 `a52251e`；其后的提交只涉及 CrossMini 侧 Workflow/Activity 与文档，runner 无需更新。
- 遗留：S06 侧栏看不到未选中 Mission 的 INPUT_REQUIRED 等状态；S13 standalone 结果目录仍在 TMPDIR；本机 runner 未常驻；Jev 影子模式待积累一致率数据后再评估 enforce；P4 网关与 OIDC 未在本轮范围。

<promise>FINISHED</promise>

# 多用户与额度交接轮（2026-10-23 起）

范围见 `docs/user-stories/cmap-multiuser-quota-2026-10.json`（Q01–Q07 额度交接、M01–M10 多用户、L01–L08 遗留），设计见 ADR-0008、ADR-0009。M10 公网部署等待 Cross 提供主机与域名。

## Q01–Q03、M01–M03、L02、L03、L05（通过）

- Q01 `24f1cdf` 账号级额度快照契约、零额度探针（Codex app-server、Claude get_usage；Kimi 未知）与落账；真实零额度探测两家各一次（Codex 7 天窗口 2%，Claude 5 小时 56%、7 天 93%）。
- Q02 `7e43a1b` 路由额度维度；`c16e643` 修订：额度未知不改变首选顺序（原规则让 Kimi 等读不到额度的首选被替补抢走），ADR-0009 §1 同步。
- Q03 `014f6b8` Codex 与 Kimi 的明确额度耗尽归一为 QUOTA_EXHAUSTED，未识别按普通失败。
- M01 `d0ab080` runner-gateway.v1、runner-enrollment.v1 契约与 docs/identity.md。
- M02 `fe3e7f2`、`b71c32d` API 校验 OIDC JWT（RS256、JWKS 缓存，无新依赖）、tenant/owner 取自 claims、公网 Host 与 Origin 校验、开发栈 Keycloak 26.7.5；本地 Keycloak 真实 PKCE 登录与浏览器实测通过。
- M03 `a612d55` 审批 decided_by 取 token 主体，controlled/mutating 分别要求对应 approver 角色，Mission 写操作要求 operator。
- L02 `8d6358b` `--restart-worker` 支持本机 runner 模式（`CMAP_RUNNER_RUNS_DIR`），真实运行通过；未补自动化测试。
- L03 `892aa7f` ADR-0007 确定性兜底、当日预算、`CMAP_JEV_AUTODECIDE=off`；enforce 仍未开启。
- L05 `b2e6522` Planner 403 已不复现，原因在服务端或账号侧，脚本无问题；真实 plan-mission 成功一次；提交计划到执行的整链路未验证。
- 主会话验收：`c16e643` 上 `npm run check` 全过（test 480、api 90、pg 89、workflow 337）。
- qcl 清理（ADR-0008 部署修订）：配置与清单备份到 CrossMini `~/.cmap/qcl-backup-20261023/`；停用并禁用旧 aiticket 后端、nginx、llmsandbox、qdrant、playwright-mcp、RustDesk；frps 保留；数据目录未删除。

## M10 第一阶段（已上线，故事未通过）

- `https://cmap.spux.cn`：qcl 上 Caddy（Let's Encrypt）+ Keycloak；其余请求经 CrossMini 发起的受限反向 SSH 隧道到 CrossMini API（8785）。CrossMini 以 launchd 常驻 API、Worker（cmap-main，schema public）与隧道，发布目录 `~/.local/share/cmap-control/b71c32d`。
- 实测：证书有效；未登录 401；cross 真实 PKCE 登录（含首次改密）后 `/v1/context` 返回 tenant=team-ycc；伪造、自签、`alg=none`、过期 token 均 401；无注册入口；kill 隧道约 2 秒恢复。
- realm 只有 cross 一个账号（临时口令在 CrossMini `~/.cmap/edge/cross-initial-password`，首次登录须改）。M10 要等 runner 注册吊销（M05）与越权测试（M07）在公网实测后才通过，期间不建第二个账号。
- 风险：腾讯云主机安全会封 SSH 认证反复失败的来源 IP；LaunchAgent 需保持 Cross 图形会话登录；日志未轮转；Keycloak 备份拉回尚未定时。

## L01、L06、L07、L08（通过）

- `ea1363f` L01 Mission 列表附带需要人处理摘要（一次聚合查询），侧栏未选中的 Mission 也能看到。
- `0d1657c` L06 Kimi 普通模式不输出用量，只记耗时、不估算 tokens；报表按 Agent 汇总；Mission 累计 tokens 超阈值写 MISSION_COST_ALERT（只告警不阻断）。
- `e85a382` L07 外部内容包进以内容哈希为定界符的数据区块，补注入回归；未做真实模型注入评测。
- `53e598e` L08 standalone 结果目录移到 `~/.cmap/codex-results`（0700），测试改用隔离 HOME；过期文档已更新。
- 主会话验收：`3970b45` 上 `npm run check` 全过（test 493、api 91、pg 90、workflow 339）。

## Q04–Q07（通过）

- `20a39f9` Q04 QUOTA_EXHAUSTED 后派生同轮续接任务并记 QUOTA_HANDOFF：原 Agent 记入排除项；只读级新工作区，写副作用先确认原 Agent 已退出再以工作区快照冻结输入续接，并重新审批；每节点续接上限 2；Agent 自报的额度耗尽不触发交接（`AGENT_REPORTED_QUOTA_EXHAUSTED`）。
- `d1b3bf0` Q05 额度恢复判定与 QUOTA_RESTORED，WebUI 显示账号额度与交接链路；`/v1/quota-snapshots` 尚未按租户收窄。
- `a025ba3` Q06 可切换调度者（`CMAP_DISPATCHERS`），只在确定性候选内挑选，分配直接生效（Cross 决定）；`7940112` Claude 调度者默认 Haiku。真实调度各一次：Jev 976 毫秒、Claude 9.5 秒（当时用 Opus）；Claude 七日额度 97% 时会被自动跳过。
- `fda7f81` Q07 真实 Temporal/PostgreSQL/Codex 三段式全链路通过：额度低改派 → 中途触顶续接（mutating，两次审批，半成品经快照传递）→ 恢复后派回并记 QUOTA_RESTORED；`4a8c58b` 提示词区分额度续接与返工。
- 主会话验收：`7940112` 上 `npm run check` 全过（test 498、api 92、pg 91、workflow 352）。
- 遗留：续接快照未覆盖远程 runner 工作区；inspect/v1 未接入续接。
