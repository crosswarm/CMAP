# 远程 runner（单用户双主机，ADR-0006）

状态：Stage 2–3 已实现并在**本机双端口模拟**下验证；Stage 4（部署到 lap、配置 Tailscale ACL、两机实测）**未做**。闸口逐条状态见[威胁模型「单用户双主机闸口」](threat-model.md#单用户双主机闸口)。全部闸口落地并验证前，lap 不接收真实任务。

## 形态

CrossMini 是唯一控制面、账本写入者与 Artifact 存储。lap（`cross-m1mx`）只运行 runner 守护进程 `apps/runner`，不接入 Temporal / PostgreSQL。所有请求由 CrossMini 发起：

| 请求 | 用途 |
|---|---|
| `GET /v1/health` | 派发前 3 秒健康探测；不健康或 `runner_id` 不符即按 `fallback_agents` 回落本地，`ROUTING_DECIDED` 记 `unhealthy` |
| `POST /v1/tasks` | 派发：信封 + 许可 + 已冻结输入（Memross 快照、评审输入） |
| `GET /v1/tasks/{id}` | 状态轮询 |
| `GET /v1/tasks/{id}/result` | 拉取结果与产物字节；CrossMini 落盘后用 `readVerifiedArtifact` 独立复算 sha256 |
| `POST /v1/tasks/{id}/cancel` | 取消 |

契约：[`schemas/remote-runner.v1.schema.json`](../schemas/remote-runner.v1.schema.json)。实现：`adapters/remote-runner`（CrossMini 侧 `RemoteRunnerAdapter`）、`apps/runner`（lap 侧守护进程，复用 `CodexAdapter`、`runner-config.ts` 与 `publishInput`）。

行为要点：

- 许可受众绑定 lap 的 `runner_id` 与 `remote-runner-adapter`；lap 用固定公钥验签，允许 2 秒时钟偏差。拿到别的 runner 重放 → `CLAIM_MISMATCH`，过期 → `EXPIRED`，两者都在执行前拒绝，账本落 `RUNNER_ADMISSION_REVOKED:PERMIT_INVALID`，保留 binding、不重发。
- lap 用自己的准入白名单（`RUNNER_ALLOWED_*`）复核信封身份；不放行时账本落 `RUNNER_ADMISSION_REVOKED:<CODE>`，例如 `OWNER_DENIED`。
- 执行中失联：状态查询失败在 600 秒宽限内视为仍在执行；超过宽限进入既有「执行不确定」路径（任务 `INPUT_REQUIRED`、保留 binding），**不自动改派、不重跑**。宽限计时在 Worker 进程内存中，Worker 重启会重新计时——只会更晚判不确定，不会多执行。
- lap 上的 Codex 一律以 `-m $CMAP_CODEX_MODEL` 显式指定模型（信封带 `model_policy` 时以信封为准），不依赖 lap 的 `~/.codex` 默认模型。

## CrossMini（控制面 Worker）配置

| 变量 | 说明 |
|---|---|
| `CMAP_PERMIT_KEY_FILE` | 派发许可签名私钥路径。不存在则首次生成 Ed25519 PKCS8 PEM（0600）；文件对 group/other 可读即拒绝启动。配置远程 runner 时必填 |
| `CMAP_REMOTE_RUNNER_URL` | 例如 `http://cross-m1mx:8790`。不设置则不注册远程 runner |
| `CMAP_REMOTE_RUNNER_ID` | lap 守护进程的 `RUNNER_ID`，例如 `lap`；不得与本机 `RUNNER_ID` 相同。注册的 Agent ID 为 `codex@<id>` |

`RUNNER_ALLOWED_CAPABILITIES` 等本机准入照旧；远程 runner 的能力清单与本机 Codex 相同。路由用信封的 `execution_policy`：

```json
{ "preferred_agent": "codex@lap", "fallback_agents": ["codex"] }
```

导出公钥给 lap（只导出公钥，私钥不离开 CrossMini）：

```bash
node -e "const c=require('node:crypto'),f=require('node:fs');process.stdout.write(c.createPublicKey(f.readFileSync(process.argv[1])).export({type:'spki',format:'pem'}))" "$CMAP_PERMIT_KEY_FILE" > crossmini-permit.pub
```

把 `crossmini-permit.pub` 拷到 lap（例如 `~/.cmap/crossmini-permit.pub`）。轮换私钥后必须同步更新 lap 上的公钥文件；没有网络发现。

## lap（runner 守护进程）配置

| 变量 | 必填 | 说明 |
|---|---|---|
| `RUNNER_ID` | 是 | 例如 `lap`，与 CrossMini 的 `CMAP_REMOTE_RUNNER_ID` 一致 |
| `RUNNER_TENANT`、`RUNNER_ALLOWED_TENANTS`、`RUNNER_ALLOWED_OWNERS`、`RUNNER_ALLOWED_CAPABILITIES`、`RUNNER_MAX_RISK` | 是 | lap 自己的准入白名单，语义同 [runner 准入](runner-admission.md)；建议 `RUNNER_MAX_RISK` 从 `read-meta` 起步 |
| `RUNNER_HOST` | 否 | 默认 hostname |
| `CMAP_RUNNER_LISTEN_HOST` | 是 | lap 的 Tailscale IPv4（`tailscale ip -4`）。`0.0.0.0`、`::` 等通配地址拒绝启动 |
| `CMAP_RUNNER_PORT` | 否 | 默认 `8790` |
| `CMAP_PERMIT_PUBLIC_KEY_FILE` | 是 | CrossMini 公钥文件；含私钥材料即拒绝启动 |
| `CMAP_CODEX_MODEL` | 是 | 显式传给 codex 的模型名 |
| `CMAP_PERMIT_ISSUER` | 否 | 默认 `cmap:local-control-plane`，须与 Worker 一致 |
| `CMAP_WORK_ROOT` | 否 | 默认仓库下 `.cmap-work`；运行记录在 `<CMAP_WORK_ROOT>/.runs/` |
| `CODEX_BIN` | 否 | 默认 `codex` |

以下变量出现在 lap 上即拒绝启动：`CMAP_DATABASE_URL`、`MEMROSS_URL`、`MEMROSS_TOKEN`、`CMAP_PERMIT_KEY_FILE`、`TEMPORAL_ADDRESS`。Codex 自身的提供方登录态由 lap 上的 codex 管理，不经 CMAP 下发。

### launchd 模板

`~/Library/LaunchAgents/com.cmap.runner.plist`（路径按 lap 实际情况替换；不放任何令牌）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cmap.runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/cross/.nvm/versions/node/v24.13.0/bin/node</string>
    <string>apps/runner/src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/cross/Studio/CMAP</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/Users/cross/.homebrew/bin:/usr/bin:/bin</string>
    <key>TMPDIR</key><string>/private/tmp</string>
    <key>RUNNER_ID</key><string>lap</string>
    <key>RUNNER_TENANT</key><string>team-ycc</string>
    <key>RUNNER_ALLOWED_TENANTS</key><string>team-ycc</string>
    <key>RUNNER_ALLOWED_OWNERS</key><string>crosswarm</string>
    <key>RUNNER_ALLOWED_CAPABILITIES</key><string>code.analyze</string>
    <key>RUNNER_MAX_RISK</key><string>read-meta</string>
    <key>CMAP_RUNNER_LISTEN_HOST</key><string>100.x.y.z</string>
    <key>CMAP_RUNNER_PORT</key><string>8790</string>
    <key>CMAP_PERMIT_PUBLIC_KEY_FILE</key><string>/Users/cross/.cmap/crossmini-permit.pub</string>
    <key>CMAP_CODEX_MODEL</key><string>gpt-5.6-sol</string>
    <key>CMAP_WORK_ROOT</key><string>/Users/cross/.cmap/work</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/cross/.cmap/runner.out.log</string>
  <key>StandardErrorPath</key><string>/Users/cross/.cmap/runner.err.log</string>
</dict>
</plist>
```

`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cmap.runner.plist` 加载；守护进程只打印一行就绪信息，不打印请求体。`TMPDIR=/private/tmp` 避开 macOS 卷别名导致的 Codex 可写根问题。Tailscale IP 变化时须更新 `CMAP_RUNNER_LISTEN_HOST`；Tailscale 未就绪时绑定失败，KeepAlive 会重试。

### Tailscale ACL 规则文本

意图：只允许 CrossMini → lap:8790；lap 不得访问 CrossMini 任何端口；其他节点不得访问 lap:8790。示例（tailnet policy file，HuJSON，以 Tailscale 当前文档语法为准）：

```jsonc
{
  "tagOwners": {
    "tag:cmap-control": ["autogroup:admin"],
    "tag:cmap-runner":  ["autogroup:admin"]
  },
  "acls": [
    // CrossMini（tag:cmap-control）只能访问 lap（tag:cmap-runner）的 8790
    { "action": "accept", "src": ["tag:cmap-control"], "dst": ["tag:cmap-runner:8790"] }
    // 不写任何 src 为 tag:cmap-runner 的规则：lap 没有到 CrossMini 的入站
  ]
}
```

注意：tailnet 默认的 `{"action":"accept","src":["*"],"dst":["*:*"]}` 会让上面的限制失效；删除它会影响该 tailnet 中所有其他设备的互访，需要先把仍需保留的访问逐条写出来再替换。是否同时开放 Tailscale SSH 由 Cross 在 Stage 4 决定，不属于本例外。

## 验证

| 层 | 命令 | 覆盖 |
|---|---|---|
| 契约 | `npm test`（`tests/contract/remote-runner.test.mjs`） | 各消息正反样例：通配 runner、路径穿越、多余字段、stderr 字段均拒绝 |
| 单测 | `npm test`（`tests/adapter/remote-runner.test.ts`、`tests/domain/dispatch-permit.test.ts`） | 真实 HTTP + 假 codex：执行 1 次且显式 `-m`、同 runner 重放不二次执行、别的 runner `CLAIM_MISMATCH`、超偏差/过期 `EXPIRED`、owner 拒绝、输入下发与篡改拒绝、健康探测超时、宽限边界、配置拒绝、密钥 0600 与公钥固定 |
| 控制面 | `npm run test:workflow`（`tests/workflow/remote-runner.test.ts`） | 路由到 lap 并完成、lap 不在线回落并记原因、重放 `PERMIT_INVALID`、过期 0 次执行、篡改产物 `EVIDENCE_HASH_MISMATCH` 且无 artifact 记录、`RUNNER_ADMISSION_REVOKED:OWNER_DENIED`、失联超宽限不确定且只执行 1 次 |
| 本机双端口模拟 | `TMPDIR=/private/tmp CMAP_CODEX_MODEL=<model> node scripts/e2e-remote-runner.mjs --simulate`（加 `--fake-codex` 不调用模型） | 两个真实守护进程进程：健康、派发、重放、终态、CrossMini 复算哈希、exec 计数 |
| Stage 4（未做） | lap 部署后 `node scripts/e2e-remote-runner.mjs`（读 `CMAP_REMOTE_RUNNER_URL`/`CMAP_REMOTE_RUNNER_ID`/`CMAP_PERMIT_KEY_FILE`）；再以 `preferred_agent: codex@lap` 跑一次 `scripts/e2e-mission.mjs` 级别的 Temporal 全链路；ACL 放行与拒绝两面实测 | 跨主机验签与时钟、真实网络失联、ACL |

## 已知边界

- 状态、结果、取消端点没有应用层认证，只靠 Tailscale ACL 限定来源；派发端点有签名许可。ACL 未落地前不得在 tailnet 上启动守护进程。
- 产物随结果以 base64 内联拉取，单个约 16 MiB 上限，适合报告类证据，不适合大文件。
- `RemoteRunnerAdapter` 的风险上限默认 `mutating`（与被包装的 Codex 一致），真正的上限由 lap 的 `RUNNER_MAX_RISK` 执行；超出时落准入拒绝而不是回落本地。
- 只有一个远程 runner（固定 Adapter ID `remote-runner-adapter`）；第三台机器不在 ADR-0006 范围内。
