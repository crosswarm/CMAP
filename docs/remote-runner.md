# 远程 runner（单用户双主机，ADR-0006）

状态：Stage 2–3（含应用层请求/响应认证）已实现；Stage 4 部分完成（2026-10-18）——lap 守护进程以 launchd `com.cmap.runner` 运行（代码 `a4fb971`，只监听 lap 的 Tailscale IPv4），`scripts/e2e-remote-runner.mjs` 真实两机实跑通过：健康探测、派发与同 runner 重放、请求受众不符/未签名/过期/重放 401、跨 runner 许可 CLAIM_MISMATCH、32 秒完成、产物在 CrossMini 复算哈希一致、lap 上运行记录 1 条。按 [ADR-0006 修订 1](adr/0006-single-user-dual-host-exception.md) 不配置 ACL。2026-10-19 经 Temporal 全链路实测（`scripts/e2e-remote-mission.mjs`，见下「Stage 4 实测」）：派发到 `codex@lap` 完成、lap 离线回落（C5）、执行中守护进程重启与 Worker 重启（inspect/v1）完成且只执行 1 次、跨主机 DAG 的 lap→CrossMini 方向通过；发现并修复（`9edbd69`，lap 尚未部署）DAG 输入下发到 lap 的契约缺口。尚未实测：CrossMini→lap 的 DAG 子节点、执行中 lap 离线（生产默认与缩短宽限两种）。闸口逐条状态见[威胁模型「单用户双主机闸口」](threat-model.md#单用户双主机闸口)。全部闸口落地并验证前，lap 不接收真实任务。

## 形态

CrossMini 是唯一控制面、账本写入者与 Artifact 存储。lap（`cross-m1mx`）只运行 runner 守护进程 `apps/runner`，不接入 Temporal / PostgreSQL。所有请求由 CrossMini 发起：

| 请求 | 用途 |
|---|---|
| `GET /v1/health` | 派发前 3 秒健康探测；不健康或 `runner_id` 不符即按 `fallback_agents` 回落本地，`ROUTING_DECIDED` 记 `unhealthy` |
| `POST /v1/tasks` | 派发：信封 + 许可 + 已冻结输入（Memross 快照、评审输入） |
| `GET /v1/tasks/{id}` | 状态轮询 |
| `GET /v1/tasks/{id}/result` | 拉取结果与产物字节；CrossMini 落盘后用 `readVerifiedArtifact` 独立复算 sha256 |
| `POST /v1/tasks/{id}/cancel` | 取消 |

**每个请求（含 health）都带请求签名，每个应答（401 除外）都带 lap 的响应签名**，见下「应用层认证」。

契约：[`schemas/remote-runner.v1.schema.json`](../schemas/remote-runner.v1.schema.json)。实现：`adapters/remote-runner`（CrossMini 侧 `RemoteRunnerAdapter`）、`apps/runner`（lap 侧守护进程，复用 `CodexAdapter`、`runner-config.ts` 与 `publishInput`）。

行为要点：

- 许可受众绑定 lap 的 `runner_id` 与 `remote-runner-adapter`；lap 用固定公钥验签，允许 2 秒时钟偏差。拿到别的 runner 重放 → `CLAIM_MISMATCH`，过期 → `EXPIRED`，两者都在执行前拒绝，账本落 `RUNNER_ADMISSION_REVOKED:PERMIT_INVALID`，保留 binding、不重发。
- lap 用自己的准入白名单（`RUNNER_ALLOWED_*`）复核信封身份；不放行时账本落 `RUNNER_ADMISSION_REVOKED:<CODE>`，例如 `OWNER_DENIED`。
- 执行中失联：状态查询失败在 600 秒宽限内视为仍在执行；超过宽限进入既有「执行不确定」路径（任务 `INPUT_REQUIRED`、保留 binding），**不自动改派、不重跑**。宽限计时在 Worker 进程内存中，Worker 重启会重新计时——只会更晚判不确定，不会多执行。
- lap 上的 Codex 一律以 `-m $CMAP_CODEX_MODEL` 显式指定模型（信封带 `model_policy` 时以信封为准），不依赖 lap 的 `~/.codex` 默认模型。

## 应用层认证

- **请求（CrossMini → lap）**：用 CrossMini 的派发许可私钥（`CMAP_PERMIT_KEY_FILE`，Ed25519）签 `方法 + 路径(含查询) + 请求体 sha256 + 毫秒时间戳 + nonce + 受众 runner_id`，放在 `x-cmap-timestamp` / `x-cmap-nonce` / `x-cmap-audience` / `x-cmap-content-sha256` / `x-cmap-signature` 头里（契约 `requestAuthHeaders`）。lap 在路由与读请求体**之前**验证：固定公钥验签、受众等于本机 `RUNNER_ID`、时间戳偏差 ≤ 2 秒、nonce 窗口内未用过；随后核对收到的体 sha256。任何一项不过都是同一个固定的 `401`（体为 `UNAUTHORIZED`，不签名，不区分原因），不执行任何动作。签名串带 `cmap-runner-req1` 域前缀，与派发许可的 `cmap1.` 不能互相冒用。
- **应答（lap → CrossMini）**：lap 用自己的 Ed25519 私钥签 `受众 + 所答请求的 nonce + 状态码 + 应答体 sha256`（`x-cmap-signature`，契约 `responseAuthHeaders`）。绑定请求 nonce，旧应答不能冒充新请求的答复。CrossMini 用固定的 lap 公钥验签：结果端点验签失败按 `EVIDENCE_HASH_MISMATCH` 同等处理（不落盘、不写 artifact 记录）；其他端点是 `REMOTE_RESPONSE_SIGNATURE_INVALID`，健康探测判 `unavailable`。验签通过后产物仍由 CrossMini 独立复算 sha256。
- **CrossMini 对 401 的处理**：派发被 401 拒绝时 lap 未执行，按 `PERMIT_INVALID`（`BAD_SIGNATURE`）落账、保留 binding、不重发；状态查询被 401 拒绝（密钥不符、时钟漂移）按失联处理，计入 600 秒离线宽限，不重跑。
- **nonce 缓存**在 lap 进程内存（容量 4096，保留约 5 秒）。守护进程重启后，窗口内（时间戳 ±2 秒，理论上至多约 4 秒）一个已被用过的请求理论上可被重放；时间戳窗口限定了这个缺口，未落盘。
- 这一层**不替代** Tailscale ACL（ACL 仍未配置），也不加密：信封、冻结输入、结果产物的机密性依赖 tailnet 的 WireGuard；应用层只保证来源、完整性、受众与防重放。

## CrossMini（控制面 Worker）配置

| 变量 | 说明 |
|---|---|
| `CMAP_PERMIT_KEY_FILE` | 派发许可签名私钥路径，**同一把私钥也签所有发往 lap 的请求**。不存在则首次生成 Ed25519 PKCS8 PEM（0600）；文件对 group/other 可读即拒绝启动。配置远程 runner 时必填 |
| `CMAP_REMOTE_RUNNER_PUBKEY_FILE` | 固定的 lap 响应验签公钥（SPKI PEM，来自下面 lap 的导出命令）。配置远程 runner 时必填，没有或含私钥材料即拒绝构造适配器、Worker 启动失败；轮换 lap 密钥后必须同步更新 |
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

`apps/worker` 未改动：适配器在没有显式传入密钥时，从 `CMAP_PERMIT_KEY_FILE`（请求签名）与 `CMAP_REMOTE_RUNNER_PUBKEY_FILE`（应答验签）加载，缺任一项即拒绝构造。

## lap（runner 守护进程）配置

| 变量 | 必填 | 说明 |
|---|---|---|
| `RUNNER_ID` | 是 | 例如 `lap`，与 CrossMini 的 `CMAP_REMOTE_RUNNER_ID` 一致 |
| `RUNNER_TENANT`、`RUNNER_ALLOWED_TENANTS`、`RUNNER_ALLOWED_OWNERS`、`RUNNER_ALLOWED_CAPABILITIES`、`RUNNER_MAX_RISK` | 是 | lap 自己的准入白名单，语义同 [runner 准入](runner-admission.md)；建议 `RUNNER_MAX_RISK` 从 `read-meta` 起步 |
| `RUNNER_HOST` | 否 | 默认 hostname |
| `CMAP_RUNNER_LISTEN_HOST` | 是 | lap 的 Tailscale IPv4（`tailscale ip -4`）。`0.0.0.0`、`::` 等通配地址拒绝启动 |
| `CMAP_RUNNER_PORT` | 否 | 默认 `8790` |
| `CMAP_PERMIT_PUBLIC_KEY_FILE` | 是 | CrossMini 公钥文件；含私钥材料即拒绝启动 |
| `CMAP_RUNNER_KEY_FILE` | 是 | lap 自己的响应签名私钥路径（例如 `~/.cmap/runner.key`）。首次启动自动生成 Ed25519 PKCS8 PEM（0600，父目录 0700）；宽权限拒绝启动。私钥不离开 lap |
| `CMAP_CODEX_MODEL` | 是 | 显式传给 codex 的模型名 |
| `CMAP_PERMIT_ISSUER` | 否 | 默认 `cmap:local-control-plane`，须与 Worker 一致 |
| `CMAP_WORK_ROOT` | 否 | 默认仓库下 `.cmap-work`；运行记录在 `<CMAP_WORK_ROOT>/.runs/` |
| `CODEX_BIN` | 否 | 默认 `codex` |

以下变量出现在 lap 上即拒绝启动：`CMAP_DATABASE_URL`、`MEMROSS_URL`、`MEMROSS_TOKEN`、`CMAP_PERMIT_KEY_FILE`、`TEMPORAL_ADDRESS`。Codex 自身的提供方登录态由 lap 上的 codex 管理，不经 CMAP 下发。

导出 lap 公钥给 CrossMini（首次启动守护进程生成密钥后执行，只导出公钥）：

```bash
node -e "const c=require('node:crypto'),f=require('node:fs');process.stdout.write(c.createPublicKey(f.readFileSync(process.argv[1])).export({type:'spki',format:'pem'}))" "$CMAP_RUNNER_KEY_FILE" > lap-runner.pub
```

把 `lap-runner.pub` 拷到 CrossMini（例如 `~/.cmap/lap-runner.pub`）并设为 `CMAP_REMOTE_RUNNER_PUBKEY_FILE`。lap 的 `CMAP_RUNNER_KEY_FILE` 与 CrossMini 的 `CMAP_PERMIT_KEY_FILE` 是两把不同的密钥：前者签应答，后者签请求与派发许可。

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
    <key>CMAP_RUNNER_KEY_FILE</key><string>/Users/cross/.cmap/runner.key</string>
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
| 单测 | `npm test`（`tests/adapter/remote-runner.test.ts`、`tests/domain/dispatch-permit.test.ts`） | 真实 HTTP + 假 codex：执行 1 次且显式 `-m`、同 runner 重放不二次执行、许可受众不符 `CLAIM_MISMATCH`、过期 `EXPIRED`、请求受众不符/时钟超窗被 401 拒绝、owner 拒绝、输入下发与篡改拒绝、健康探测超时、宽限边界、配置拒绝、密钥 0600 与公钥固定 |
| 认证 | `npm test`（`tests/adapter/remote-runner-auth.test.ts`、`tests/contract/remote-runner.test.mjs`） | health/dispatch/status/result/cancel 五个端点：未签名、错签、签名后改路径/方法/体、过期、未来、受众不符、缺头、重放均 401 且体逐字节一致、不执行（取消与派发无副作用）；应答被改/剥签/用错 lap 公钥 CrossMini 拒收，结果端点 `EVIDENCE_HASH_MISMATCH` 且不落盘；lap 自签错误字节仍被复算哈希拒绝；适配器缺密钥 fail closed；认证头契约正反样例 |
| 控制面 | `npm run test:workflow`（`tests/workflow/remote-runner.test.ts`） | 路由到 lap 并完成、lap 不在线回落并记原因、受众不符的重放 `PERMIT_INVALID`、时钟超窗的 lap 健康探测 401 并回落本地且 lap 0 次执行、篡改产物 `EVIDENCE_HASH_MISMATCH` 且无 artifact 记录、`RUNNER_ADMISSION_REVOKED:OWNER_DENIED`、失联超宽限不确定且只执行 1 次 |
| 本机双端口模拟 | `TMPDIR=/private/tmp CMAP_CODEX_MODEL=<model> node scripts/e2e-remote-runner.mjs --simulate`（加 `--fake-codex` 不调用模型） | 两个真实守护进程进程：健康、派发、重放、受众不符 401、许可受众不符 `CLAIM_MISMATCH`、未签名/过期/重放 401、应答带签名、终态、CrossMini 复算哈希、exec 计数 |
| Stage 4 两机（不经 Temporal） | `node scripts/e2e-remote-runner.mjs`（读 `CMAP_REMOTE_RUNNER_URL`/`CMAP_REMOTE_RUNNER_ID`/`CMAP_PERMIT_KEY_FILE`/`CMAP_REMOTE_RUNNER_PUBKEY_FILE`） | 跨主机验签与时钟、派发与重放、401、CLAIM_MISMATCH、产物复算（2026-10-18 通过） |
| Stage 4 Temporal 全链路 | `TMPDIR=/private/tmp node scripts/e2e-remote-mission.mjs <场景>...`（同上四个变量；ssh 别名 `lap`；独立 schema `cmap_e2e_remote`、队列 `cmap-e2e-remote`，Worker 不配置 Memross） | 见下「Stage 4 实测」；ACL 按修订 1 不配置 |

## Stage 4 实测（2026-10-19）

CrossMini 起真实 Worker（`apps/worker/src/main.ts`），lap 守护进程为 `a4fb971`。判据只认账本状态、事件回执、执行次数（lap `.runs/<task>.json` 运行记录 + lap 上 codex 进程组采样）与 sha256。

| 场景 | 结果 |
|---|---|
| `remote`：dag/v1 单节点 `preferred_agent: codex@lap`、`fallback_agents: [codex]` | ✅ binding `remote-runner-adapter@lap`；ROUTING_DECIDED 选 `codex@lap`、fallback=false；Mission/任务 COMPLETED、MISSION_COMPLETED=1；产物 CrossMini 复算 = lap 原件哈希；lap 运行记录 1、本地 0 |
| `offline`（C5）：lap `launchctl bootout` 后派发 | ✅ ROUTING_DECIDED `codex@lap` skipped(`unhealthy`) → `codex` selected、fallback=true；本地完成；lap 运行记录 0。场景结束后守护进程已恢复 |
| `capability`：`code.implement`（lap 准入只放 `code.analyze`） | 🟡 lap 上 0 次执行、本地 0 次、不回落；但**路由层仍选中 `codex@lap`**（远程适配器静态声明与本机 Codex 相同能力），由 lap 准入拒绝：`RUNNER_ADMISSION_REVOKED:CAPABILITY_DENIED`，任务 FAILED_TERMINAL、Mission ESCALATED。与风险上限的既定设计一致（超出 lap 白名单落准入拒绝而不是回落本地）；「不在 lap 执行」成立，「不派给 lap」不成立 |
| `lap-restart`：执行中 `launchctl kickstart -k` 守护进程 | ✅ 守护进程 pid 变化、codex 进程组存活；COMPLETED，TASK_STARTED=1，lap 运行记录 1、进程组采样 1 |
| `worker-restart-inspect`：执行中 SIGKILL CrossMini Worker 再拉起（inspect/v1；测试专用 `CODEX_BIN` 让本机 codex 不健康，路由按注册顺序落到 `codex@lap`） | ✅ ROUTING_DECIDED `codex` skipped(`unhealthy`) → `codex@lap` selected；COMPLETED，TASK_STARTED=1，无 INPUT_REQUIRED，lap 运行记录 1、进程组采样 1 |
| `worker-restart`：同上但 dag/v1 | 🟡 安全但不完成：`runDagAttempt` 不重试（`maximumAttempts: 1`），Worker 被杀后心跳超时，节点升级 `NODE_EXECUTION_ERROR`；binding 保留在 lap、ROUTING_DECIDED=1、TASK_STARTED=1、lap 运行记录 1、不重跑。目前 `preferred_agent` 只能经 dag/v1 表达，所以「指定到 lap 的任务在 Worker 重启后完成」只在 inspect/v1 回落路由下成立 |
| `dag`（C1）lap→CrossMini：父 `rp@lap`、子 `rc@CrossMini` | ✅ 两节点 COMPLETED；父产物 CrossMini 复算 = lap 原件；子输入信封 sha256 = 父产物 sha256 = CrossMini 子工作区字节 |
| `dag`（C1）CrossMini→lap：父 `lp@CrossMini`、子 `lc@lap` | ⬜ 发现契约缺口：输入 uri 原只允许 `inputs/(memory\|review)/…`，DAG 输入是 `inputs/<node_id>/…`，子节点派往 lap 前即被拒。`9edbd69` 放宽为 safe_id（契约正反样例 + 适配器单测）。lap 仍为 `a4fb971`，实测中 `lc` 被旧 lap 拒收 → `DISPATCH_UNCERTAIN`、lap 0 次执行；lap 部署 `9edbd69` 后需用 `dag` 场景复测 |
| `lap-offline`：执行中 bootout，生产默认配置 | ⬜ 未实测（本次会话对 lap 的远程启停被权限拒绝）。按代码：dag/v1 任务 `timeout_seconds` 固定 300，先于 600 秒离线宽限到期，届时取消请求不可达，节点升级 `CANCELLATION_UNCONFIRMED`、不改派不重跑；600 秒宽限在生产默认下到不了 |
| `grace`：同上，测试专用进程内 Worker 把离线宽限缩到 30 秒 | ⬜ 未实测（同上原因）。脚本已写；预期执行不确定（`INPUT_REQUIRED`、`EXECUTION_UNCERTAIN:*`）、binding 保留、不二次执行 |

测试数据只在 `cmap_e2e_remote` schema 与 `.cmap-work/e2e-remote/`；未写 Memross。

## 已知边界

- 所有端点已有应用层请求认证与应答签名，但 **Tailscale ACL 仍未配置**，仍是网络层缺口：认证只防伪造、篡改与重放，不防同 tailnet 节点对 lap 端口的连接尝试与拒绝服务（未签名请求会被读头后 401，但仍占连接）。ACL 落地并实测前，不得在 tailnet 上启动守护进程接收真实任务。
- 应用层不加密。私钥泄露即失效：CrossMini 的 `CMAP_PERMIT_KEY_FILE` 一旦泄露，攻击者既能伪造请求也能签派发许可；轮换须同时更新 lap 上的 `CMAP_PERMIT_PUBLIC_KEY_FILE`。lap 的 `CMAP_RUNNER_KEY_FILE` 泄露则可伪造应答，须同步更新 CrossMini 的 `CMAP_REMOTE_RUNNER_PUBKEY_FILE`。
- nonce 防重放缓存在内存，守护进程重启后窗口内（≤ 约 4 秒）理论上可重放；时钟偏差超过 2 秒的请求一律被拒，两机需要 NTP 同步。
- 产物随结果以 base64 内联拉取，单个约 16 MiB 上限，适合报告类证据，不适合大文件。
- `RemoteRunnerAdapter` 的风险上限默认 `mutating`（与被包装的 Codex 一致），真正的上限由 lap 的 `RUNNER_MAX_RISK` 执行；超出时落准入拒绝而不是回落本地。
- 只有一个远程 runner（固定 Adapter ID `remote-runner-adapter`）；第三台机器不在 ADR-0006 范围内。
