# 证据接收的已知凭据模式门禁

`packages/adapter-sdk/src/secret-patterns.ts` 是唯一模式源，复用仓库已有 API key、私钥、JWT、AWS、GitHub、Host token 赋值和 Authorization 头模式。
pre-commit 仍单独处理 Git diff、占位符及文件豁免；运行时不接受这些豁免。

## 执行边界

- `normalizeAgentOutput` 同步快照结果，在 schema 诊断之前扫描结构化内容与 session ID；命中返回非重试型 `RESULT_SECRET_DETECTED`。
- `readVerifiedArtifact` 同步快照描述符，在路径检查之前扫描元数据，读取后立即扫描实际字节，再复算哈希；命中返回非重试型 `EVIDENCE_SECRET_DETECTED`。
- 两种新错误的消息和指纹均固定，不包含匹配内容、产物 URI、角色或命中标签。
- Codex、Kimi、YonWork 结果归一化，以及 DAG/返工复制均复用这些入口。现有终态收取逻辑将拒绝落为无 Artifact 的 failed TaskResult；既有返工预算继续约束后续动作。
- 源文件不改写、不自动删除，不重算另一份“脱敏后”证据替代原始证据。不能交付的字节不会作为正常产物登记或复制给后继任务。

## 明确限制

这是已知文本模式检测，不是完整 DLP。未知秘密、编码/压缩/二进制内嵌内容、PII、历史账本回扫、模型原始工作区/会话清理、角色 ACL 仍不在已验证覆盖内。
历史安全字段保持兼容，不新增“已评估”证明，不因正则阴性宣称无秘密或 PII。

## 验证

使用合成凭据形状与真实临时文件；不使用账号凭据，不向模型发送命中样本。
测试覆盖正确哈希仍拒绝、元数据先于路径错误检查、占位符/豁免文字不能绕过、重复检测、异步输入突变、失败结果和事件不含样本、旧安全字段不能绕过 DAG/返工复制。

```sh
node --test tests/adapter/structured-output.test.ts tests/workflow/dispatch.test.ts tests/workflow/review-inputs.test.ts tests/workflow/dag-materialization.test.ts tests/tooling/precommit.test.mjs tests/tooling/approval-advisor.test.mjs
npm run check
npm run test:pg
node scripts/e2e-single-hop.mjs
```

执行记录见 [2026-09-22 验证](verification-evidence-guard-2026-09-22.md)。
