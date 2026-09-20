# Jev 决策辅助

两层审批共用 `scripts/jev-approval.mjs`，运行在控制面之外。它只返回结构化建议，
不执行工具、不改任务状态、不 POST 审批决定，也不输出宿主 hooks 的 allow 指令。
Workflow 和硬验收保持确定性。

## Codex 工具调用

当前本机 Codex 已配置 `approval_policy=never`，重复询问不能靠再改这个开关解决。
对于确实需要语义判断的操作，调用者先核实用户已有授权，再提供脱敏摘要：

```bash
node scripts/jev-approval.mjs <<'JSON'
{
  "surface": "codex_tool",
  "request_id": "local-status-check",
  "action_summary": "Read git status in the local repository; no writes or network.",
  "risk": "read-meta",
  "environment": "local",
  "reversible": true,
  "authorization_verified": true,
  "authorization_scope": "read-meta",
  "requires_human": false
}
JSON
```

只有真实授权已核验、scope 一致、可逆且非生产、无需本人决策时，Jev 的 continue
建议才可能产生 `can_continue=true`；调用者仍遵守当前宿主的工具策略。
`authorization_verified` 是调用方已核验的事实，不是模型可以自行填 true 的开关。
凭一份来自 Agent 的 JSON 不能取得新权限，不能用此助手覆盖工具拒绝。
模型结果不会作为新的授权记录写回 CMAP。

已知确定性安全步骤（例如在已授权项目内运行现有测试）按既有规则直接执行，
不必为了“接入 AI”额外增加一次模型审批；低置信度也不自动等同于必须打断用户，
可补证据或由主 Agent 在既有授权内复核。

## CMAP 业务审批

```bash
CMAP_API_PORT=8787 node scripts/jev-approval.mjs --approval <approval-id>
```

从本机、当前租户可见的 `/v1/approvals` 读取 pending 请求，只发送 action/scope 等
最小元数据，不发送 reason 正文、证据内容或任务提示词。助手不会将建议回写为批准。
当前 controlled/mutating 必须保持各自审批；即使模型建议 continue，
`can_continue` 仍为 false。`read-meta`/`read-sensitive` 原本就不进入该人工闸口，
无需再新增一层重复审批。

若后续要让 CMAP 自动消耗预授权，需先定义由可信控制面维护的委托授权契约：
明确租户、操作、scope、有效期、资源边界和授权来源，再由确定性程序匹配。
当前接口还不能验证真人身份，不能把模型置信度当作这个缺口的替代品。

业务审批已另行补齐确定性保护：终态不可改写、同身份同决定幂等、过期不能批准、
并发只接受一个决定。这些规则由 Store/API 执行，不询问 Jev。

## 配置与结果

- 复用 `TYPESAFE_API_KEY` 环境变量或 `~/.agents/tools/jev-ultrafast/.env`，不复制密钥。
- 使用官方 `https://api.typesafe.ai/v1/systemone` 和 `jev-latest`，15 秒超时，不跟随重定向。
- 输入/输出分别由 `schemas/approval-context.v1.schema.json` 和
  `schemas/approval-advice.v1.schema.json` 校验。
- 输出只含 request_id、建议、确定性 reason_code、输入 SHA-256、实际模型、置信度、
  耗时和用量；不存动作正文和原始模型响应。
- 当前建议阈值为 confidence 与所选概率都不低于 0.9，是保守初值，未经业务校准；
  它不会扩大授权。失败、缺 key、非法响应均不产生自动继续建议。
- 退出码 0 表示返回了合法建议，**不表示批准**；2 为模型不可用，1 为输入/API 错误。

## 2026-09-20 验证

- 工具调用合成测试 5 项通过，覆盖边界、scope 隔离、失败关闭、敏感输入和真实 HTTP 读取。
- 真实 Jev `jev-1.13.0`：两次本地只读样例返回 continue / can_continue=true，confidence 分别为 0.95、0.94。
- 隔离 PostgreSQL + HTTP API 的待提交审批：Jev 返回 review / human_required；
  回读仍为 pending、decided_by=null。测试结束将合成请求标记 expired。
- 全局 Codex/OMX/Ulanzi hook 未改动；本次没有安装绕过宿主策略的自动批准 hook。
