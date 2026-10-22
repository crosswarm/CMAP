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
