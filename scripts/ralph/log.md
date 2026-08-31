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
