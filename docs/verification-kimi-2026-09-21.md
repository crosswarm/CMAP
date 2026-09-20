# Kimi Adapter 与真实 Workflow 验证 · 2026-09-21

## 交付

本机 macOS Kimi Code 2.0.1 接入 AgentAdapter SPI。Worker 的 CMAP_AGENTS 显式注册
codex/kimi；默认仍是 Codex。复用既有机读输出结构、证据路径/哈希校验和硬门槛。
没有新增依赖、路由服务或模型解析框架。实现与限制见 [说明](kimi-adapter.md)。

修改集中在 `adapters/kimi-adapter/src/`、`packages/adapter-sdk/src/structured-output.ts`、
`apps/worker/src/{main,adapter-config}.ts`、`workflows/activities.ts` 和相应契约/测试。
Codex 删除重复的提示渲染和结果归一化，改为共用已验证逻辑。

## 最终验证

- `npm run check`：类型检查通过；244 基础 + 55 API + 63 Workflow = 362 项。
- `npm run test:pg`：66 项；合计 **428 项通过**。
- `scripts/e2e-kimi.mjs`：实际 Kimi 生成 3 个文件，控制面身份、严格 JSON、实际文件数、
  证据 SHA-256 和 report.sample_file_count 全部通过；并发相同键复用一次派发。
- `scripts/e2e-single-hop.mjs`：真实 Codex 回归通过，证明共享归一化仍接在真实 Codex 上。
- `scripts/e2e-mission.mjs`：设置 CMAP_EXPECT_ADAPTER=kimi-adapter，核验真实账本绑定。
  Mission `mis-e2e-mua7nzte`，Task `tsk_mua7o5uv_mb2e6o_0001`，32.8 秒、0 次返工完成；
  实测 3，report 哈希一致，10 条账本事件到 MISSION_COMPLETED。
- 该 Kimi Workflow 的 71 个 Temporal 历史事件重放通过。
- 原生 sandbox-exec 使用真实坏数据验证：拒绝越界写入、用户私有文件读取、MCP 创建与
  符号链接创建；启动前拒绝普通/符号链接 MCP 配置及 Git 根目录 MCP 继承。

隔离 schema `cmap_kimi_20260921`、队列 `cmap-kimi-20260921`、工作目录
`/tmp/cmap-kimi-workflow-20260921`。验证后停止本轮临时 Kimi Worker，原 WebUI 预览保持。
未运行生产任务，未推送或部署。

## 实际失败与修复

1. 初版真实健康检查失败：探针 SBPL 默认拒绝执行。修正为专用可运行探针，任务本身
   仍使用严格沙箱；另补正确 KIMI_CODE_HOME/TMPDIR 和环境变量白名单。
2. 终态最初仅看退出码，现改为进程关闭后严格解析并验证证据再报告终态；覆盖无结果、
   非零退出、UTF-8 分块、最后一行无换行、超时、取消、输出上限和清理。
3. 独立审查证明共享归一化允许悬空证据引用；现在拒绝不存在的引用与重复 artifact_id。
4. 首次真实 Kimi Workflow 最终回复不符合 JSON，明确失败，没有宽松抽取正文。
   收紧最终输出提示，并只记录格式类别/内容哈希；失败指纹按类别保持稳定，避免破坏无进展检测。
5. 同次失败暴露收取异常使账本仍 RUNNING。现在对已确认终态、非重试型 Adapter 结果/
   证据/任务错误落失败结果，进入既有返工/升级。瞬态、绑定缺失和基础设施错误仍抛出。
   Temporal 测试验证预算 0 时 Mission ESCALATED、Task FAILED_TERMINAL，没有伪造证据。
   旧失败测试 Mission `mis-e2e-mua7b2le` 在核实 Temporal FAILED 后，以测试系统身份
   显式对齐为失败；未把失败记录改成成功。后续新 Mission 才是上述成功证据。

## 流程与边界

最初两个新模块的红测只是缺少导入，不符合有效 TDD，未倒称为有效红测。
之后环境泄漏、终态、截止时间、清理、MCP 边界、悬空引用和失败落账等均先观察到
准确行为失败，再修复为绿测；已有 Codex 目录证据读取错误的提取回归也已修正。

Jev 本轮最小摘要建议 continue，confidence=0.62，reason_code=uncertain，
can_continue=false；作为不确定性记录，未把模型结论写成权限或验收证据。

共享 OAuth 存储允许正常轮换，属于隔离例外。网络域名限制、跨用户身份、OIDC、
远程 runner 及 mTLS 尚未完成。Kimi model_policy 显式拒绝，避免努力度参数静默降级。
YonWork Adapter、DAG 与完整多主机交付继续保持未完成。
