# Kimi Adapter（本机 P3）

Kimi Code 2.0.1 通过现有 AgentAdapter SPI 接入。Workflow 只读取归一化结果，
不解析厂商自然语言。当前实现针对 macOS 打包 CLI 和已有 Kimi Code OAuth 登录态。

## 运行

```bash
# 独立测试 schema/队列/工作目录，先确认 Temporal SDK 检查通过
node scripts/verify-temporal.mjs
CMAP_AGENTS=kimi npm run start:worker

# 独立真实单跳：实际调用 Kimi、创建样本并验证证据
node scripts/e2e-kimi.mjs
```

默认注册仍为 Codex。`CMAP_AGENTS=kimi,codex` 指定注册顺序；信封有 preferred_agent /
fallback_agents 时按显式列表。替补仅用于启动前筛选，启动确认不明不换 Agent 重跑。
配置仅支持 codex/kimi，拒绝未知或重复项。身份由控制面填充。

## 成本计量

结果的 `cost.duration_seconds` 为进程启动到退出的耗时。**tokens 不可得**：Kimi Code 2.2.0 的
`-p --output-format stream-json` 只输出 `assistant` / `tool` / `meta` 行，源码里的 JSON writer 没有任何用量记录
（仅 `/goal` 模式末尾会输出带 `tokensUsed` 的 `goal.summary`，CMAP 不使用 `/goal`）。因此默认 `cost.tokens` 缺省，
不估算、不编造；输出里出现合法的 `goal.summary.tokensUsed`（非负整数）时才写入。报表中这类任务计入 `tasks_without_tokens`。

## 运行时与权限

- 每次任务生成私有 KIMI_CODE_HOME、空 skills 目录和固定 agent-file；不复制用户配置。
- 仅启用 Bash、Read、Glob、Grep、Write、Edit；不启用浏览器、子 Agent 或 MCP 工具。
- 原 credentials 与 oauth 锁目录通过目录引用复用，允许正常令牌原子轮换；不复制/输出凭据。
  这是共享认证存储例外，不能称为“所有状态完全隔离”。
- sandbox-exec 显式限制写入到任务工作区、私有运行目录及认证存储；限制普通用户 home 读取。
- 拒绝当前工作目录或 Git 根目录已有 MCP 配置（包括符号链接）；沙箱拒绝后续创建该配置/链接。
- 子进程只继承运行所需的少量环境变量；不透传数据库令牌和任意 API key。
- P3 仍允许模型所需的网络出口；没有宣称完成域名白名单、跨用户授权或 P4 隔离。
- Kimi 托管模型的努力度取值由服务目录动态决定。目前显式拒绝 model_policy，避免静默降级。
  默认使用 kimi-for-coding；不把未验证的请求参数显示为已经生效。

## 结果与生命周期

JSONL meta/version 或退出码 0 都不足以完成。进程关闭后，最后一条 assistant 消息
必须是严格 JSON，符合既有 codex-output.v1 输出结构，再由共享归一化器校验：
必需证据角色、工作区路径、文件存在性、独立 SHA-256、证据 ID 唯一性与引用完整性。
没有经过这一阶段，getStatus 不返回完成。账本层另行重算 actual 与 expected。

超时、取消和输出限额均有明确失败状态；取消使用进程组终止。并发同一幂等键只派发一次。
事件只暴露元数据，不包含原始工具输出、stderr 或提示词。
调用方提供工作区时，收取成功/失败结果后清理厂商运行目录；证据留在工作区。
Adapter 自建工作区时由 cleanup 显式清理；清理不会忘记已派发幂等键。
原始厂商会话属于私有临时运行目录，不进 Git、Artifact 或共享记忆。

已确认的结果解析/证据/任务终态失败会落为失败 TaskResult，交给既有返工和升级逻辑；
不会在 Workflow 异常退出后仍把这类任务显示为运行中。
验证结果见 [2026-09-21 记录](verification-kimi-2026-09-21.md)。

## 来源与范围

[命令参考](https://moonshotai.github.io/kimi-code/en/reference/kimi-command)、
[Agent 文件](https://moonshotai.github.io/kimi-code/en/customization/agents)、
[数据位置](https://moonshotai.github.io/kimi-code/en/configuration/data-locations)。
源代码契约固定为 2.0.1 / caf7d4e2fef06967280b325da06e44a4b0516eba；升级后需重新验证。

此接入提供本机代码任务替补，不代表 YonWork、DAG、多用户或远程 runner 已完成。
