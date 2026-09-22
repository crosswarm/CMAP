# 评审后继输入验证（2026-09-22）

## 范围

修复 Reviewer 的 `task_type`、`parameters` 和 `inputs.artifact_refs` 在后继创建/执行间丢失的问题。行为和边界见 [输入交付](review-inputs.md)。这次不修改 Workflow 命令序列，不新增依赖、数据库表或审批服务。

修改覆盖四个 schema 及其生成类型、task creation、review application、dispatch、共享提示词和文件复制。DAG 原有复制逻辑提取到 `workflows/artifact-files.ts` 后复用。测试 FakeAdapter 的文件版本写入真实合成字节和哈希，不绕过输入校验。

## 回归

- schema → codegen、失败测试 → 最小实现按顺序执行。后续独立审查发现合法产物 ID 含 `/` 被误拒绝，新增复制/验证回归，先观察 `INPUT_INVALID` 失败再修复；ID 与角色保持契约允许的原字符串，只有路径桶使用哈希。
- `npm run check`：705/705，通过 typecheck、394 个默认测试、58 个 API 测试、253 个 Workflow 测试。
- `npm run test:pg`：90/90。
- 最终补充 `npm run typecheck`、codegen、脚本语法检查、`git diff --check` 均通过。
- 首次全量检查发现拒绝码枚举测试遗漏 `INPUT_INVALID`，已更新；第二次发生既有 Kimi 测试对全局临时目录计数的并发干扰。最终完整检查使用独立 `TMPDIR`，未放宽测试断言。

## 真实链路

### 自动返工

- 独立 schema：`cmap_inputs_rework_20260922`；queue：`cmap-inputs-rework-20260922`。
- `node scripts/e2e-mission.mjs --rework` 通过，Mission `mis-e2e-mucmly9q`。
- 两个真实 Codex 任务各生成 3 个文件；不可能达到的硬标准由控制面判为失败，返工一轮后按预算升级，耗时 367.8 秒。
- 后继自动获得 1 个输入副本，额外复算副本 SHA256 并核对生产任务 ID；101 个事件历史重放通过。

### 两分支输入传递

- `node scripts/e2e-mission-followups.mjs --inputs`：`verified=true`，耗时 554.670 秒。
- Mission：`mis-followups-e2e-mucmkvf9`；独立 schema：`cmap_followups_e2e_mucmkvf9`。
- 三个真实 Codex 任务全部完成，每个任务实际生成 3 个文件；两个后继均从输入副本正确读出源 nonce，保留各自随机任务类型、参数 marker 和 `[0,false,null]`。
- 产物哈希、父子关系、Task/Mission 终态均通过；163 个事件的新历史重放通过。Reviewer 的两分支决定明确为合成测试夹具，不代表真实 Claude Reviewer 或人工审批。

### DAG 共享复制回归

- 刷新后的预览 Worker 运行 `node scripts/e2e-dag.mjs`，HTTP → Temporal → Codex/Kimi → Codex 汇合全部通过。
- Mission：`mis_08e9239db82e694237a9dd4eb9dc5c9750002be1139027abbc78f053427259ee`。
- 三个任务完成，汇合读取 2 个实际输入副本并得到 `17 + 25 = 42`；独立复算文件哈希、核对依赖接受顺序、30 个账本事件、锁释放及 89 个历史事件重放通过。

## 运行边界

- 本机 WebUI：`http://127.0.0.1:8789/`；GET 200，健康检查正常，最终 `missions=4 tasks=12`。原任务均完成后刷新 Worker，Temporal SDK 已确认新进程轮询 Workflow/Activity 队列。
- Jev `jev-1.13.0` 对派发阶段复制和版本化冻结回执提供辅助判断（置信度分别 0.99、1.0）；实际授权、哈希和测试仍由代码验证。
- Cross `sync.py --quick --check`：OK，8 项共享记忆、32 个项目知识索引、30 条待提炼；不导入原始会话。
- 不代表真实 Claude Reviewer 已通过。远程 Runner、OIDC/WSS/mTLS、角色 ACL、YonWork 专用 profile 完整验收仍未完成。
- 没有推送或远程部署；原始 Agent 会话不入库。
