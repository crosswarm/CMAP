# YonWork 真实验收准备

当前代码已通过本地回归，但当前 Host 的两个 Agent 均非 `cmap-*`，没有适用的专用测试 profile。
以下是待授权的具体环境操作，不是已完成记录，也不代表代理可以写入自己的人工批准。

## 拟执行范围

1. 使用同安装包 `yonworkctl`，创建 `cmap-validation`，名称 `CMAP 验证`、`inheritWorkspace:false`。如已有同名 Agent，先核验来源，不覆盖或借用。
2. 从该 Host 对应 Gateway 读取配置快照及 baseHash，只将新 Agent 的工具策略设置为 `deny:["*"]`。使用官方 `config.patch` 的并发校验；保留现有 Agent、模型、账号和渠道配置。因为数组更新是替换，必须保留完整现有 agents.list，逐项核验差异仅发生在新 Agent。原始配置不打印、不入库。
3. 官方配置变更可能触发 Gateway 配置重载。若实际接口需要超出此范围的全局重配或重启操作，停止该分支并报告。
4. 准备专用策略基线会话 `agent:cmap-validation:explicit:cmap-policy`，从真实 `tools.effective` 核验空工具清单且无 notices，记录策略哈希。
5. 通过 CMAP API 创建一个独立的 controlled 验收任务：要求只返回结构化报告，确定性标准为 `17 + 25 = 42`；`deliver:false`、无附件、无业务系统查询、无外发或工具执行。授权必须由真实用户来源进入 CMAP 的 controlled 审批，不能由 Jev 或 Agent 自批。
6. 核验 API → Temporal → YonWork 的预写意图、run/session 相关 final 事件、独立报告哈希、账本与审查结果、资源锁释放及 Temporal 历史重放。未观察到远端终态不得重发；仅可取消该次拥有的 run。

完成后保留专用测试 Agent 和最小审计记录供后续验证；不删除现有 Agent、会话历史或用户业务数据。
真实发送前若空工具策略无法核实，不发送测试消息。

## 已核对的入口

- YonWork.app `yonworkctl agents create --json` 转发 `name/inheritWorkspace/purpose/desiredAgentId`；不接受 tools 策略。
- `agents update` 仅更新名称；不可用它伪装工具权限设置。
- 当前安装包 OpenClaw 支持带 baseHash 的 `config.patch`；数组使用替换语义，因此必须完整保留原 entries。
- 匹配 YonWork.app 的 OpenClaw 已通过真实 `gateway call health`，解析结果 `ok:true`。PATH 中的其他 OpenClaw 不作为该环境的入口。

授权边界依据仓库 `AGENTS.md`：`controlled` 与 `mutating` 互不蕴含，Agent 不得自批；当前测试需要明确的配置变更范围及独立 controlled 诊断授权。
