# CMAP Agent 轻量入口

本文件只保留仓库级高频约束。任务开始时先确认目标、范围和可验证的成功标准；需要架构、安全或契约细节时再按需读取 `docs/architecture.md`、`docs/threat-model.md`、`docs/adr/`，不要每轮预加载长文档。

## 核心原则

1. 先运行 `git status --short --branch`；未提交改动属于用户，必须保留并避开无关文件。
2. 只读请求保持只读；诊断先给根因和证据，除非用户明确要求修复。
3. 使用解决问题的最小实现，不新增未请求的能力、依赖、抽象或配置；不顺带重构、格式化或清理无关代码。
4. **契约先于实现**：改行为前先改 `schemas/`，再 `npm run codegen`，最后动实现。反过来做会让实现悄悄带偏契约。
5. **测试先于实现**：先写会失败的测试，确认失败原因正确，再写最小实现。补测试也算数，但要在同一次提交内。
6. 不记录、提交或回显真实凭据、令牌、Cookie、Agent 会话记录或含用户业务数据的运行时快照。

## 项目速查

- `schemas/` 是**契约单一真相源**。`packages/domain-model/src/generated/` 由 `npm run codegen` 派生，**不手写、不手改**。
- 四个契约：`task-envelope`（派发）、`task-result`（账本）、`review-decision`（返工）、`codex-output`（传给 Agent）。前三者严格，最后一个必须满足 OpenAI structured outputs 子集——原因见 [ADR-0003](docs/adr/0003-agent-output-contract-layering.md)。
- `packages/adapter-sdk/` 定义 Adapter SPI；`adapters/*/` 是各 Agent 实现。**Workflow 不得直接解析 Agent 的自然语言输出**。
- monorepo 内部引用走 `#domain-model` / `#adapter-sdk`（package.json `imports`），因为 Node 的 type stripping 不处理 `node_modules` 下的 `.ts`。
- TypeScript 走 Node 24 原生 type stripping，**零构建**；`tsc` 只做类型检查。tsconfig 开了 `erasableSyntaxOnly`，禁用 `enum`/`namespace`/参数属性。
- 本地栈：`docker compose -f infra/docker-compose/docker-compose.yml up -d`。**就绪判定一律用 `node scripts/verify-temporal.mjs`**，不看容器状态或端口监听。

## 安全边界

1. **多人多机 + 跨公网 = 远程代码执行平台。** 接入第二个人或第二台机器前，`docs/threat-model.md` 的 T1–T12 缓解必须先就位。
2. Adapter **一律显式传沙箱档**（`-s`），绝不继承本机 codex 的 `danger-full-access` 默认值。
3. **身份字段由控制面填充**，不取 Agent 自述；**证据哈希由控制面独立复算**，不采信 Agent 自报。
4. `controlled` 与 `mutating` 的授权**互不蕴含**，不得合并为单一批准。Agent 不得自批，也不得把自身判断伪装成人工授权。
5. 凭据只允许 `secretref://` 引用；日志与 Artifact 只存事件类型、时间、关联 ID、终态和内容哈希，不存提示词正文。

## 按任务执行与验证

| 任务范围 | 最小验证 |
|---|---|
| 文档、ADR | `git diff --check`；文档内链接需实际存在 |
| Schema 改动 | `npm run codegen` + `npm run check`；确认 `generated/` 已同步入库 |
| domain-model / adapter-sdk | `npm run check`（typecheck + 全量测试） |
| Adapter 实现 | 相关单测 + `node scripts/e2e-single-hop.mjs` 真实链路 |
| Workflow / Activity | 单测 + Temporal 重放测试；确认 Workflow 内无 `Date.now()`/`Math.random()` |
| 基础设施（compose/hooks） | 实际启停一次并用 SDK 验证；hook 改动须用真实坏数据验证确实拦截 |

**测试失败时记录准确的既有阻断原因；不得通过改动无关文件、放宽断言或伪造数据来获得通过。**

以下三类信号**不能**作为通过依据：容器 `Up`、端口 `LISTEN`、进程 `rc=0`。它们可以同时为真而服务实际不可用——这在本仓库已实际发生过（见 `infra/docker-compose/README.md`）。

## SDD + TDD 流程

一次行为变更的标准顺序：

```
1. 写/改 schema（契约）        → schemas/*.json
2. npm run codegen             → 派生类型
3. 写会失败的测试              → 确认失败原因正确，不是拼写或导入错误
4. 最小实现                    → 让测试变绿
5. npm run check               → typecheck + 全量测试
6. 涉及外部链路则跑真实验证     → e2e / verify-temporal，不用 mock 替代
```

第 3 步的"确认失败原因正确"不可省略：一个因模块名写错而失败的测试，通过后什么也没证明。

测试分层：

| 目录 | 职责 |
|---|---|
| `tests/contract/` | Schema 正反样例、供应商兼容性约束 |
| `tests/domain/` | 状态机、领域规则 |
| `tests/tooling/` | 工程脚本（pre-commit 规则等） |
| `scripts/e2e-*.mjs` | 真实链路，会实际调用 Agent 与外部服务 |

纯逻辑与外部交互要分离，否则测试只能依赖真实环境或退化成 mock 自己。`scripts/precommit-checks.mjs` 与 `scripts/git-precommit.mjs` 的拆分是这条的范例。

## Git 管理

- 首次 clone 后运行一次 `node scripts/install-project-hooks.mjs` 启用仓库 hooks。
- pre-commit 会拦截：凭据泄漏、禁止入库路径（`.env`、私钥、Artifact、会话记录）、契约与生成文件不一致。
- **不要用 `--no-verify` 绕过**。绕过一次，这道防线在真正需要时同样失效。若确认误报，修 `scripts/precommit-checks.mjs` 并补测试。
- 确需包含凭据样本的文件（如检测逻辑自身的测试），在文件内加一行带**理由**的豁免标记：
  `// precommit-allow-secrets: <为什么必须包含>`。空标记不生效；豁免按文件而非按目录——`tests/` 下的文件同样需要显式标记，否则真凭据混进测试文件就查不出来了。
- 工作区不干净时不得擅自切换、重置或覆盖；先保留现有改动并在其基础上工作。
- 禁止 force-push，禁止用 `git reset --hard` 或 `git checkout --` 丢弃他人改动。
- 暂存前逐项检查 `git diff --cached --name-status`，只暂存当前任务文件。
- 提交信息用中文 Conventional Commit，例如 `fix(adapter): 修复证据哈希复算`。

## 完成标准

- 改动范围与用户授权一致，现有用户改动未被覆盖。
- 已运行与变更相符的检查，结果或阻断原因清楚可复现。
- 涉及外部链路（Temporal、codex、YonWork）时说明验证方式与结果，**未以 mock 成功替代真实验证**。
- 文档中标注为"已实现"的内容必须与代码一致；不确定时标 🟡 或 ⬜，不要写成 ✅。
- 最终回复列出修改文件、验证结果、已知风险和未完成事项。
