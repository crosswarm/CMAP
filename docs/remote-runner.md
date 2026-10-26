# 远程 runner（单用户双主机，ADR-0006）

状态：Stage 2–4 已完成（2026-10-21）。lap 守护进程以 launchd `com.cmap.runner` 运行，代码 `af0cbe2`，只监听 lap 的 Tailscale IPv4；按 [ADR-0006 修订 1](adr/0006-single-user-dual-host-exception.md) 不配置 ACL。两机真实实测全部通过（见下「Stage 4 复测（2026-10-21）」）：协议层签名与防重放；经 Temporal 派发到 `codex@lap`；能力不匹配在路由层回落；跨主机 DAG 双向；lap 离线回落；执行中守护进程重启；Worker 重启（inspect/v1 与 dag/v1）；执行中 lap 失联（生产默认与缩短宽限）。闸口逐条状态见[威胁模型「单用户双主机闸口」](threat-model.md#单用户双主机闸口)。

## 形态

CrossMini 是唯一控制面、账本写入者与 Artifact 存储。lap（`cross-m1mx`）只运行 runner 守护进程 `apps/runner`，不接入 Temporal / PostgreSQL。所有请求由 CrossMini 发起：

| 请求 | 用途 |
|---|---|
| `GET /v1/health` | 派发前 3 秒健康探测；应答同时公布 lap 的准入白名单（`admission`：租户、owner、能力、风险上限）。不健康、`runner_id` 不符或缺 `admission` 即按 `fallback_agents` 回落本地，`ROUTING_DECIDED` 记 `unhealthy`；白名单不放行则记 `tenant_mismatch` / `owner_mismatch` / `capability_mismatch` / `risk_exceeded` 并同样回落 |
| `POST /v1/tasks` | 派发：信封 + 许可 + 已冻结输入（Memross 快照、评审输入） |
| `GET /v1/tasks/{id}` | 状态轮询 |
| `GET /v1/tasks/{id}/result` | 拉取结果与产物元数据（每个产物的 sha256 与长度，M09 起不再内联字节） |
| `GET /v1/tasks/{id}/artifacts/{sha256}` | 按元数据流式拉取产物字节（见下「产物流式传输」） |
| `POST /v1/tasks/{id}/cancel` | 取消 |

**每个请求（含 health）都带请求签名，每个应答（401 除外）都带 lap 的响应签名**，见下「应用层认证」。

契约：[`schemas/remote-runner.v1.schema.json`](../schemas/remote-runner.v1.schema.json)。实现：`adapters/remote-runner`（CrossMini 侧 `RemoteRunnerAdapter`）、`apps/runner`（lap 侧守护进程，复用 `CodexAdapter`、`runner-config.ts` 与 `publishInput`）。

行为要点：

- 许可受众绑定 lap 的 `runner_id` 与 `remote-runner-adapter`；lap 用固定公钥验签，允许 2 秒时钟偏差。拿到别的 runner 重放 → `CLAIM_MISMATCH`，过期 → `EXPIRED`，两者都在执行前拒绝，账本落 `RUNNER_ADMISSION_REVOKED:PERMIT_INVALID`，保留 binding、不重发。
- 能力感知路由：CrossMini 派发前用 health 公布的白名单判断，不放行就跳过 lap、按 fallback 回落本地，不再派过去收准入拒绝。lap 派发时仍用自己的准入白名单（`RUNNER_ALLOWED_*`）复核信封身份（纵深防御，覆盖探测后白名单变化）；不放行时账本落 `RUNNER_ADMISSION_REVOKED:<CODE>`，例如 `OWNER_DENIED`。
- 执行中失联：状态查询失败（含 3 秒内无应答）在离线宽限内视为仍在执行；超过宽限进入既有「执行不确定」路径（任务 `INPUT_REQUIRED`、保留 binding），**不自动改派、不重跑**。有效宽限 = min(`CMAP_REMOTE_OFFLINE_GRACE_SECONDS`（默认 600 秒）, 首次失联时距该轮等待截止剩余时间的一半)，首次失联时算定、判定后保持（[ADR-0006 修订 2](adr/0006-single-user-dual-host-exception.md)）。取剩余时间而不是任务超时的一半，是因为失联可能发生在执行后半段；留出半个剩余窗口让轮询（2 秒间隔 + 3 秒状态超时）至少再观察到一次。失联发生在截止前不足约 10 秒时，仍可能先撞超时（同样不改派不重跑）。宽限计时在 Worker 进程内存中，Worker 重启会重新计时——只会更晚判不确定，不会多执行。
- Worker 重启（dag/v1）：`runDagAttempt` 在 Worker 失联（心跳超时 2 分钟）后重试一次，只对重启安全的 Adapter（Codex 运行记录模式、`remote-runner-adapter`）的既有 binding 恢复观察，绝不新启动 Agent；Kimi / YonWork 照旧升级 `NODE_EXECUTION_ERROR`。Activity 自身抛错不重试。新旧 Workflow 历史由 `patched('dag-attempt-restart-resume-v1')` 区分。恢复后该轮等待截止重新计时。
- lap 上的 Codex 一律以 `-m $CMAP_CODEX_MODEL` 显式指定模型（信封带 `model_policy` 时以信封为准），不依赖 lap 的 `~/.codex` 默认模型。

## 应用层认证

- **请求（CrossMini → lap）**：用 CrossMini 的派发许可私钥（`CMAP_PERMIT_KEY_FILE`，Ed25519）签 `方法 + 路径(含查询) + 请求体 sha256 + 毫秒时间戳 + nonce + 受众 runner_id`，放在 `x-cmap-timestamp` / `x-cmap-nonce` / `x-cmap-audience` / `x-cmap-content-sha256` / `x-cmap-signature` 头里（契约 `requestAuthHeaders`）。lap 在路由与读请求体**之前**验证：固定公钥验签、受众等于本机 `RUNNER_ID`、时间戳偏差 ≤ 2 秒、nonce 窗口内未用过；随后核对收到的体 sha256。任何一项不过都是同一个固定的 `401`（体为 `UNAUTHORIZED`，不签名，不区分原因），不执行任何动作。签名串带 `cmap-runner-req1` 域前缀，与派发许可的 `cmap1.` 不能互相冒用。
- **应答（lap → CrossMini）**：lap 用自己的 Ed25519 私钥签 `受众 + 所答请求的 nonce + 状态码 + 应答体 sha256`（`x-cmap-signature`，契约 `responseAuthHeaders`）。绑定请求 nonce，旧应答不能冒充新请求的答复。CrossMini 用固定的 lap 公钥验签：结果端点验签失败按 `EVIDENCE_HASH_MISMATCH` 同等处理（不落盘、不写 artifact 记录）；其他端点是 `REMOTE_RESPONSE_SIGNATURE_INVALID`，健康探测判 `unavailable`。验签通过后产物仍由 CrossMini 独立复算 sha256。
- **CrossMini 对 401 的处理**：派发被 401 拒绝时 lap 未执行，按 `PERMIT_INVALID`（`BAD_SIGNATURE`）落账、保留 binding、不重发；状态查询被 401 拒绝（密钥不符、时钟漂移）按失联处理，计入离线宽限，不重跑。
- **nonce 缓存**在 lap 进程内存（容量 4096，保留约 5 秒）。守护进程重启后，窗口内（时间戳 ±2 秒，理论上至多约 4 秒）一个已被用过的请求理论上可被重放；时间戳窗口限定了这个缺口，未落盘。
- 这一层**不替代** Tailscale ACL（ACL 仍未配置），也不加密：信封、冻结输入、结果产物的机密性依赖 tailnet 的 WireGuard；应用层只保证来源、完整性、受众与防重放。

## 产物流式传输与内容寻址存储（M09，ADR-0008 §6）

状态：✅ 两机实测通过（2026-10-24，`a178ccc`）：17825795 字节产物经监听模式（37 秒）与出站网关模式（85 秒）传输，账本、CrossMini 任务目录、内容寻址存储、lap 原件四处哈希一致。`scripts/e2e-remote-runner.mjs --artifact-bytes` 目前只在模拟模式（`--fake-codex`）生效，两机大产物需让真实 codex 生成。

- **存储**：控制面产物按 sha256 存在 `<CMAP_WORK_ROOT>/.cas/sha256/ab/cd/<hash>`（0600）。写入用 `.cas/tmp` 下的临时文件，边写边算 sha256、长度并扫已知凭据模式，结束后与声明核对，一致才原子重命名；不一致、超限、命中凭据或断流都删掉临时文件。之后再复制（APFS 上是写时复制克隆）到原来的 `<CMAP_WORK_ROOT>/<taskId>/<uri>` 并复核，既有读者（DAG 子节点输入、评审输入、Memross 回写）不变。Artifact 记录不变：按记录里的 sha256 即可在存储里定位。
- **监听模式**：结果应答只列 `{uri, sha256, size_bytes}`（已签名）。CrossMini 随后逐个 `GET /v1/tasks/{id}/artifacts/{sha256}`；lap 的应答签名把产物 sha256 当作体哈希，先签后流。CrossMini 先按声明的 sha256 验签、核对 `content-length` 等于声明长度，再边收边写入存储；签名、长度、哈希任何一项不符都按 `EVIDENCE_HASH_MISMATCH` 处理，不落盘。
- **出站模式**：runner 回报结果前逐个 `POST /v1/gateway/artifacts?lease_id=&sha256=&size=` 上传原始字节（请求签名覆盖查询串与体 sha256，即声明的哈希与长度）。API 只接受本 runner 持有的在租租约，边收边算写入存储，与声明不符回 422 `EVIDENCE_HASH_MISMATCH`、不落盘，并把上传登记在 `.cas/leases/<lease_id>/<sha256>`。结果回报只带元数据；Worker 只认本租约下登记的上传（别处已有同哈希的内容不能被借用，缺了即 `EVIDENCE_FILE_MISSING`），复制进任务目录后再复算一次。上传被拒时 runner 改报对应的 adapter 错误；网络失败重试 5 次后报 `EVIDENCE_UPLOAD_FAILED`。**API 与 Worker 必须用同一个 `CMAP_WORK_ROOT`**，API 未配置工作区时拒绝上传。
- **上限**：证据读取与传输的单文件上限 `CMAP_MAX_EVIDENCE_BYTES`（正整数字节，默认 256 MiB，非法值拒绝），两侧各自执行；读取一律流式哈希，FIFO 等非普通文件仍按 `O_NONBLOCK` + `fstat` 拒绝。API 下载流式发出、上限 `CMAP_API_MAX_ARTIFACT_BYTES`（默认同上），先流式复算一遍哈希（不符 409，不发字节）再从同一句柄发出；存储里没有的旧产物仍按任务目录路径下载。
- **兼容**：新控制面仍接受旧 runner 的内联小产物（`content_base64`，≤ 16 MiB），同样经存储核验落盘；新 runner 只发流式元数据，旧控制面不认。所以**先升级控制面，再升级 lap / 出站 runner**；lap 不必同步升级，但升级前其产物仍受 16 MiB 内联上限约束。
- 未做：派发时下发给 runner 的冻结输入（Memross 快照、评审输入、DAG 父节点产物）仍以 base64 内联，单个约 16 MiB 上限；需要内容的控制面读者（`readVerifiedArtifact`）仍把文件读进内存；进程内 Adapter（本机 codex、kimi、yonwork）的产物不进存储；存储没有清理与保留期。

## CrossMini（控制面 Worker）配置

| 变量 | 说明 |
|---|---|
| `CMAP_PERMIT_KEY_FILE` | 派发许可签名私钥路径，**同一把私钥也签所有发往 lap 的请求**。不存在则首次生成 Ed25519 PKCS8 PEM（0600）；文件对 group/other 可读即拒绝启动。配置远程 runner 时必填 |
| `CMAP_REMOTE_RUNNER_PUBKEY_FILE` | 固定的 lap 响应验签公钥（SPKI PEM，来自下面 lap 的导出命令）。配置远程 runner 时必填，没有或含私钥材料即拒绝构造适配器、Worker 启动失败；轮换 lap 密钥后必须同步更新 |
| `CMAP_REMOTE_RUNNER_URL` | 例如 `http://cross-m1mx:8790`。不设置则不注册远程 runner |
| `CMAP_REMOTE_RUNNER_ID` | lap 守护进程的 `RUNNER_ID`，例如 `lap`；不得与本机 `RUNNER_ID` 相同。注册的 Agent ID 为 `codex@<id>` |
| `CMAP_REMOTE_OFFLINE_GRACE_SECONDS` | 离线宽限上限，正整数秒，默认 `600`；有效宽限另受等待截止约束（见上「执行中失联」） |

`RUNNER_ALLOWED_CAPABILITIES` 等本机准入照旧；远程 runner 的静态能力清单与本机 Codex 相同，实际是否派给 lap 另看 lap 在 health 里公布的白名单。路由用信封的 `execution_policy`：

```json
{ "preferred_agent": "codex@lap", "fallback_agents": ["codex"] }
```

导出公钥给 lap（只导出公钥，私钥不离开 CrossMini）：

```bash
node -e "const c=require('node:crypto'),f=require('node:fs');process.stdout.write(c.createPublicKey(f.readFileSync(process.argv[1])).export({type:'spki',format:'pem'}))" "$CMAP_PERMIT_KEY_FILE" > crossmini-permit.pub
```

把 `crossmini-permit.pub` 拷到 lap（例如 `~/.cmap/crossmini-permit.pub`）。轮换私钥后必须同步更新 lap 上的公钥文件；没有网络发现。

lap 的适配器在没有显式传入密钥时，从 `CMAP_PERMIT_KEY_FILE`（请求签名）与 `CMAP_REMOTE_RUNNER_PUBKEY_FILE`（应答验签）加载，缺任一项即拒绝构造。

## 本机 runner 守护进程（S16，可选）

目的：CrossMini 本机的 Codex 也经 runner 守护进程执行，而不是在 Worker 进程内 spawn。Worker 重启（含 SIGKILL）不影响执行中的 Codex，本机与 lap 走同一条协议路径（签名请求/应答、许可受众绑定、CrossMini 复算产物哈希）。

做法：CrossMini 上再起一个 `apps/runner` 守护进程，只监听 `127.0.0.1`；Worker 把 `codex` 这个 Agent ID 注册成指向它的 `RemoteRunnerAdapter`（取代进程内 `CodexAdapter`）。lap 照旧注册为 `codex@lap`。两者 Adapter ID 都是 `remote-runner-adapter`，账本里只靠 `binding.runner_id` 区分；收结果、取消、Worker 重启恢复都按 `adapter_id + runner_id` 找回所属 runner（同一 runner 注册两次仍拒绝启动）。

Worker 新增变量（不设 `CMAP_LOCAL_RUNNER_URL` 则行为不变，仍是进程内 `CodexAdapter`）：

| 变量 | 说明 |
|---|---|
| `CMAP_LOCAL_RUNNER_URL` | 例如 `http://127.0.0.1:8791`。只接受回环地址（`127.0.0.1` / `localhost` / `[::1]`），否则拒绝启动 |
| `CMAP_LOCAL_RUNNER_ID` | 本机守护进程的 `RUNNER_ID`，例如 `crossmini-runner`；不得等于 Worker 的 `RUNNER_ID` 或 `CMAP_REMOTE_RUNNER_ID` |
| `CMAP_LOCAL_RUNNER_PUBKEY_FILE` | 本机守护进程响应验签公钥（用下面「导出 lap 公钥」同一命令从其 `CMAP_RUNNER_KEY_FILE` 导出）；与 lap 的公钥是两把 |

另需 `CMAP_PERMIT_KEY_FILE`（与 lap 共用同一把请求/许可签名私钥，受众不同不能互相冒用）；`CMAP_REMOTE_OFFLINE_GRACE_SECONDS` 对两台 runner 都生效。

本机守护进程按下面「lap 配置」同一套变量部署，差别：`RUNNER_ID` 用上面的本机 ID；`CMAP_RUNNER_LISTEN_HOST=127.0.0.1`；端口不要与别的服务冲突（例如 `8791`）；`CMAP_WORK_ROOT` 与 `CMAP_RUNNER_KEY_FILE` 必须是独立路径，**不得与 Worker 的 `CMAP_WORK_ROOT` 相同**（两边都按任务 ID 建子目录）；`RUNNER_ALLOWED_*` / `RUNNER_MAX_RISK` 应与 Worker 本机准入一致，否则路由会按 health 公布的白名单跳过 `codex`。它同样不得持有 `CMAP_PERMIT_KEY_FILE`、`CMAP_DATABASE_URL`、`MEMROSS_*`、`TEMPORAL_ADDRESS`（launchd 单独一份环境）。

边界：

- 只有 Codex 走守护进程；Kimi、YonWork 仍在 Worker 进程内执行，Worker 重启时照旧升级 `NODE_EXECUTION_ERROR`。
- 本机守护进程不在线时 `codex` 健康探测失败，**不回落进程内执行**；有 `fallback_agents` 的任务按其顺序回落（例如到 `codex@lap`），否则派发失败。
- 本机 Codex 从此以 `-m $CMAP_CODEX_MODEL` 显式指定模型（守护进程必填），不再依赖 CrossMini `~/.codex` 默认模型。
- 本机任务的 `binding.runner_id` 与产物 provenance 由 Worker 的 `RUNNER_ID` 变为本机守护进程的 `RUNNER_ID`；切换前已绑定、尚未结束的进程内任务（`codex-adapter`）在切换后的 Worker 上找不到 Adapter，切换前应等其收尾。
- 这不是第二台机器：守护进程与控制面同机，只经回环访问，不扩大 ADR-0006 的范围。
- 验证：`tests/workflow/local-runner.test.ts`（两台守护进程同时注册：各自执行 1 次、binding/provenance 按 runner 区分、Worker 重启按 runner 找回 lap、取消落到所属 runner、重复注册拒绝）；2026-10-22 CrossMini 真实实测通过：守护进程以后台进程运行于 127.0.0.1:8791，`e2e-mission` 完成且 binding 为 `remote-runner-adapter@crossmini-runner`；执行中 SIGKILL Worker 后 Codex 进程组存活，新 Worker 拉起后完成，TASK_STARTED 与运行记录各 1 条。尚未安装为 launchd 常驻。

`e2e-mission.mjs --restart-worker` 默认从 `<CMAP_WORK_ROOT>/.runs` 读运行记录；本机 runner 模式下记录在守护进程工作区，需另设 `CMAP_RUNNER_RUNS_DIR=<守护进程 CMAP_WORK_ROOT>/.runs`（只影响该脚本，不影响 Worker 或守护进程）。2026-10-23 在本机用该变量真实跑通一次：守护进程 `crossmini-runner` 监听 127.0.0.1:8791（独立工作区，复用 `~/.cmap/local-runner/` 下测试密钥），脚本自拉 Worker（`CMAP_LOCAL_RUNNER_URL` 等同上表），隔离 schema `cmap_l02` 与队列 `cmap-l02`；执行中 SIGKILL Worker、新 Worker 拉起后 Mission COMPLETED，Codex 进程组存活、只执行 1 次（运行记录与 TASK_STARTED 各 1 条），耗时 128.6 秒。

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
| 单测 | `npm test`（`tests/adapter/remote-runner.test.ts`、`tests/domain/dispatch-permit.test.ts`） | 真实 HTTP + 假 codex：执行 1 次且显式 `-m`、同 runner 重放不二次执行、许可受众不符 `CLAIM_MISMATCH`、过期 `EXPIRED`、请求受众不符/时钟超窗被 401 拒绝、owner 拒绝、输入下发与篡改拒绝、健康探测超时、health 公布白名单与缺白名单判不可用、宽限边界与「剩余时间一半」规则、状态查询挂起按 3 秒计失联、配置拒绝、密钥 0600 与公钥固定 |
| 认证 | `npm test`（`tests/adapter/remote-runner-auth.test.ts`、`tests/contract/remote-runner.test.mjs`） | health/dispatch/status/result/cancel 五个端点：未签名、错签、签名后改路径/方法/体、过期、未来、受众不符、缺头、重放均 401 且体逐字节一致、不执行（取消与派发无副作用）；应答被改/剥签/用错 lap 公钥 CrossMini 拒收，结果端点 `EVIDENCE_HASH_MISMATCH` 且不落盘；lap 自签错误字节仍被复算哈希拒绝；适配器缺密钥 fail closed；认证头契约正反样例 |
| 控制面 | `npm run test:workflow`（`tests/workflow/remote-runner.test.ts`） | 路由到 lap 并完成、lap 不在线回落并记原因、受众不符的重放 `PERMIT_INVALID`、时钟超窗的 lap 健康探测 401 并回落本地且 lap 0 次执行、篡改产物 `EVIDENCE_HASH_MISMATCH` 且无 artifact 记录、`RUNNER_ADMISSION_REVOKED:OWNER_DENIED`、失联超宽限不确定且只执行 1 次；白名单不放行租户/owner/能力/风险 → 路由记对应原因回落本地、lap 0 次；白名单过时时 lap 准入仍拒绝；配置宽限 600 秒、任务超时 2 秒的执行中失联 → 收结果与 DAG attempt 都判执行不确定；新 Worker 实例在重试 attempt 上按既有 binding 恢复、lap 只执行 1 次 |
| Worker 重启 | `npm run test:workflow`（`tests/workflow/dag-attempt-restart.test.ts`） | 真实 Temporal：首个 attempt 派发后失联，重启安全 Adapter 重试恢复并 COMPLETED、只启动 1 次，非重启安全 Adapter 仍 `NODE_EXECUTION_ERROR`；Activity 自身错误不可重试；补丁前合成历史（`tests/fixtures/dag-attempt-legacy.json`）重放 |
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

### 2026-10-19 修正（Cross 决定，lap 部署后复测）

上表 🟡/⬜ 三行对应的修正，本机单测、工作流测试与双端口模拟已覆盖，真实两机待 lap 部署后按下表复测：

| 修正 | 提交 | 复测场景与预期 |
|---|---|---|
| 能力感知路由：lap 在已签名 health 应答公布准入白名单，路由不放行即回落 | `3d9d922` | `capability`：ROUTING_DECIDED `codex@lap` skipped(`capability_mismatch`) → `codex` selected、fallback=true；本地完成、lap 0 次 |
| dag/v1 Worker 重启：重启安全 Adapter 的 attempt 重试一次，按既有 binding 恢复 | `6de79e8` | `worker-restart`：COMPLETED，ROUTING_DECIDED=1、TASK_STARTED=1、lap 运行记录 1、本地 0（Worker 拉起后约 2 分钟心跳超时才重试） |
| 离线宽限可配置且受等待截止约束 | `082c1ac` | `lap-offline`（生产默认）与 `grace`（`CMAP_REMOTE_OFFLINE_GRACE_SECONDS=30`，脚本改用真实 Worker）：执行不确定（`INPUT_REQUIRED`、`EXECUTION_UNCERTAIN:BINDING_NOT_FOUND`）、binding 保留、不改派、lap 运行记录 1 |

旧版 lap（`a4fb971`）的 health 应答没有 `admission`，新 CrossMini 会判其不可用、全部回落本地；lap 与 CrossMini 需同时更新。

## Stage 4 复测（2026-10-21，lap 与 CrossMini 均为 `af0cbe2`）

| 场景 | 结果 |
|---|---|
| `e2e-remote-runner.mjs`（两机，不经 Temporal） | ✅ 新 health 契约（含 `admission`）跨主机验签通过；受众不符、未签名、过期、重放均 401；跨 runner 许可 CLAIM_MISMATCH；20 秒完成，产物哈希一致 |
| `capability` | ✅ ROUTING_DECIDED 依次为 `codex@lap` skipped(`capability_mismatch`)、`codex` selected，fallback=true；本地完成，lap 运行记录 0、本地 1 |
| `dag`（C1 双向） | ✅ `lc@lap`：输入哈希在信封、父产物、CrossMini 字节、lap 落盘字节四处一致，产物 CrossMini 复算等于 lap 原件。`rp@lap → rc@CrossMini` 同样通过。子节点都在父节点 REVIEW_ACCEPTED 之后创建 |
| `worker-restart`（dag/v1） | ✅ 执行中 SIGKILL CrossMini Worker，新 Worker 接管后 COMPLETED；ROUTING_DECIDED=1、TASK_STARTED=1，lap 运行记录 1、进程组采样 1 |
| `grace`（`CMAP_REMOTE_OFFLINE_GRACE_SECONDS=30`） | ✅ 失联 34 秒后判 `EXECUTION_UNCERTAIN:BINDING_NOT_FOUND`。任务事件依次为 TASK_STARTED、INPUT_REQUIRED、TASK_FAILED（dag/v1 节点升级收尾时关为 FAILED_TERMINAL）。binding 保留在 lap，ROUTING_DECIDED=1，任务数 1，本地运行记录 0，lap 运行记录 1 |
| `lap-offline`（生产默认） | ✅ 失联 152 秒后判执行不确定（宽限 = 剩余等待时间的一半，先于 300 秒任务超时）。其余判据同 `grace` |

说明：dag/v1 的执行不确定先在账本记 INPUT_REQUIRED，节点升级收尾时再关为 FAILED_TERMINAL，binding 不动。是否在 lap 恢复后人工核对其运行记录与产物，属于升级处理的一部分。

## 发布复测（2026-10-22）

CrossMini 与 lap 均为 `a52251e`（之后 CrossMini 侧补 `2a97549` 修复收尾回归，lap runner 无需更新）。判据同上。

| 场景 | 结果 |
|---|---|
| `remote` | ✅ 33 秒；binding `remote-runner-adapter@lap`，ROUTING_DECIDED 选 `codex@lap`、fallback=false，TASK_STARTED=1，产物两端哈希一致，lap 运行记录 1、本地 0 |
| `capability` | ✅ 30 秒；`codex@lap` skipped(`capability_mismatch`) → `codex`、fallback=true，lap 0 次 |
| `dag` 两个方向 | ✅ 59 秒；CrossMini→lap 与 lap→CrossMini 子节点输入信封、父产物、两端落盘字节哈希一致（上次未测的方向已补） |
| `lap-restart` | ✅ 92 秒；守护进程 pid 变化、Codex 进程组存活，TASK_STARTED=1、运行记录 1 |
| `worker-restart`（dag/v1） | ✅ 134 秒；SIGKILL Worker 后按既有 binding 恢复完成，无 INPUT_REQUIRED、无重跑 |
| `grace`（宽限 30 秒） | ✅ 41 秒；Mission ESCALATED，任务 INPUT_REQUIRED（`EXECUTION_UNCERTAIN:BINDING_NOT_FOUND`），binding 保留，不改派、不重跑。首轮在 `a52251e` 上失败：S03 让任务保持 INPUT_REQUIRED 后，`finalizeDagMission` 仍视其为活跃任务抛错，Workflow 失败、Mission 停在 RUNNING；`2a97549` 修复后通过 |
| `lap-offline`（生产默认宽限） | ✅ 158 秒；离线 152 秒即判执行不确定（取剩余等待时间的一半，先于 300 秒任务超时），结果同 grace |

## 发布复测（2026-10-24，`a178ccc`）

CrossMini 生产发布与 lap 均升级到 `a178ccc`（lap：Node 26.4.0、codex-cli 0.158.0，权限档参数兼容）。

| 场景 | 结果 |
|---|---|
| 监听模式两机基线（`e2e-remote-runner.mjs`） | ✅ 认证判据全过，产物哈希一致 |
| 监听模式 17825795 字节产物 | ✅ 37 秒，四处哈希一致 |
| `e2e-remote-mission.mjs remote` | ✅ binding `remote-runner-adapter@lap`，不回落，TASK_STARTED=1 |
| `e2e-remote-mission.mjs dag` | ✅ 100 秒，四节点 COMPLETED。首轮失败：工作区在 git 仓库内时权限档拒读仓库根 AGENTS.md，codex 建会话失败；`b22882c` 以 `project_doc_max_bytes=0` 修复 |
| 出站模式（公网）a / b 执行中吊销 / c 大产物 | ✅ 见上方「出站模式」状态 |

## 出站模式（ADR-0008 §3，runner-gateway.v1）

状态：✅ 两机公网实测通过（2026-10-24，`a178ccc`，tenant e2e）：lap 以 Node 26.4.0 出站模式经 `https://cmap.spux.cn` 领取，受理约 0.8 秒，真实 Codex 执行 1 次、产物四处哈希一致、COMPLETED，ROUTING_DECIDED 带 `target_runner_id`；执行中吊销后约 23 秒判执行不确定（`EXECUTION_UNCERTAIN:BINDING_NOT_FOUND`），不重跑，被吊销 runner 的签名请求 401。2026-10-23 首测在 Node 26 上失败（HTTP/2 排队致签名过期），`1c30617` 改走 HTTP/1.1 后通过。

runner 不监听端口，主动以 HTTPS 长轮询控制面 API（`POST /v1/gateway/claim`，≤ 50 秒）领取任务、`POST /v1/gateway/reports` 回报受理/状态/结果；控制面从不连 runner。消息体沿用 remote-runner.v1。

- **队列与租约**：Worker 侧 `GatewayRunnerAdapter`（Adapter ID `gateway-runner-adapter`）把派发写入账本的网关队列；API 领取时 `FOR UPDATE SKIP LOCKED` 取最早一条并授予租约（默认 120 秒）。每次领取（`held_leases`）与回报都续租。租约过期即执行不确定（`BINDING_NOT_FOUND` → 任务 `INPUT_REQUIRED`、binding 保留），**不改派、不重跑**；过期不可逆，重新上线的 runner 也领不到它。
- **认证**：每个请求用 runner 登记的 Ed25519 私钥签名（域前缀 `cmap-gateway-req1`，身份头 `x-cmap-runner-id`）；API 用登记公钥验签，任何失败（含已吊销）都是同一个无签名 401。应答由控制面网关密钥签名，runner 用登记时固定的公钥验签。
- **许可**：受众是路由所选 runner 与 `gateway-runner-adapter`，由 Worker 的派发许可私钥签发；runner 用固定的许可公钥验签。API 不持有许可私钥：API 被攻破不等于能让 runner 执行任意信封。
- **结果**：先落账（租约关闭、回报入库），再向 `mission-<id>` 发 `runnerReported` 门铃；dag/v1 的 attempt 派发后返回 `awaiting_report`，Workflow 等门铃或 30 秒超时回读（`patched('dag-runner-report-signal-v1')`）。持有资源锁的任务仍在 Activity 内等待（锁靠它续租）。产物落盘后由 Worker 独立复算 sha256。
- **路由与 owner 亲和**（ADR-0008 §5）：按登记记录挑 runner——同租户、**owner 等于任务 owner**、未吊销、能力与风险上限放行、最近 120 秒内领取过；挑不到记 `no_runner` / `owner_mismatch` / `capability_mismatch` / `risk_exceeded` / `unhealthy` 并按 fallback 回落。跨人共享 runner 默认禁止、没有开关。派发前 Adapter 再复核一次（不符即 `OWNER_DENIED` / `TENANT_DENIED` 落准入拒绝、不入队）；runner 侧准入白名单只取自登记记录，别人的信封在执行前被拒（`OWNER_DENIED`）。

注册与吊销（ADR-0008 §4，runner-enrollment.v1）：

- admin（OIDC 角色 `admin`）`POST /v1/runner-enrollments` 签发一次性令牌：至多 1 小时、单次使用，绑定 owner、能力上限、风险上限；tenant 取自 admin 的 token claims，请求体不能指定。令牌明文只在应答里出现一次，账本只存 sha256。
- runner 首次启动生成 Ed25519 密钥，用 `CMAP_RUNNER_ENROLL_TOKEN` 调 `POST /v1/runners/enroll`（不走 OIDC）：持钥证明为新私钥对 `cmap-enroll1` LF 令牌 LF 公钥 LF host 的签名。成功后得到 `runner_id` 与控制面网关公钥，写成 0600 的登记记录；之后启动只读记录，令牌不再需要。过期、已用、未知令牌，证明错误，公钥已登记，一律同一个 `ENROLLMENT_DENIED`，失败不消耗令牌。
- admin `POST /v1/runners/{runner_id}/revoke`（体 `{}`）吊销：此后该 runner 的网关请求一律 401（长轮询中的领取也立即结束、不再下发），在途租约由 Worker 判执行不确定。他租户的 runner 按 404。

配置：

| 进程 | 变量 | 说明 |
|---|---|---|
| API | `CMAP_GATEWAY_KEY_FILE` | 网关应答签名私钥（不存在则生成 0600）；配置后启用 `/v1/gateway/*`。不得等于 `CMAP_PERMIT_KEY_FILE` |
| API | `CMAP_WORK_ROOT` | 必须与 Worker 相同：网关上传的产物写入其 `.cas`（M09） |
| Worker | `CMAP_GATEWAY_AGENT_ID` | 例如 `codex@gateway`；设置后注册网关 Adapter，需 `CMAP_PERMIT_KEY_FILE` |
| runner | `CMAP_CONTROL_PLANE_URL` | 例如 `https://cmap.spux.cn`；设置即进入出站模式。只认 https，http 仅限回环 |
| runner | `CMAP_RUNNER_KEY_FILE` | 登记的 runner 私钥（首次启动生成 0600，私钥不离开本机） |
| runner | `CMAP_RUNNER_ENROLLMENT_FILE` | 登记记录（runner-enrollment.v1 `enrolled`），默认与私钥同目录的 `enrollment.json` |
| runner | `CMAP_RUNNER_ENROLL_TOKEN` | 仅首次启动（登记记录不存在时）需要的一次性注册令牌；用过即失效，登记后可从环境移除 |
| runner | `CMAP_PERMIT_PUBLIC_KEY_FILE`、`CMAP_CODEX_MODEL`、`CMAP_PERMIT_ISSUER`、`CMAP_WORK_ROOT`、`CODEX_BIN` | 同监听模式 |

出站模式下 `RUNNER_ID` / `RUNNER_*` 准入变量被登记记录覆盖；禁止出现在 runner 上的变量与监听模式相同。守护进程重启后不恢复已持有的租约（只在内存），在途任务会在租约过期后判执行不确定。

- **runner_id 由控制面分配**：登记成功时控制面生成 `rnr_` 加 16 位随机字符的 ID，写入登记记录；`RUNNER_HOST`（缺省为本机 hostname）只是登记时附带的 host 标签，不决定 runner_id，也不参与路由。ROUTING_DECIDED 的 `runner_id` 是 Worker 自己的 ID，网关实际选中的 runner 记在 `target_runner_id`。
- **同一 owner 多台 runner**：路由在满足上述条件的 runner 里取 `last_seen_at` 最新的一台（即最近一次领取的），任务不能指定某一台。要固定到某台机器，只让那一台在线。
- **Node 版本**：已验证 Node v25.2.1 / v25.6.0（undici 7）与 v26.4.0（undici 8）。网关客户端用 `node:http`/`node:https`（HTTP/1.1）而不是 `fetch`：Node 26 的 `fetch` 对 https 默认协商 HTTP/2，长轮询领取在途时，同一连接上的回报会排到领取返回之后才发出，签名超出 ±2 秒窗口被 401（2026-10-23 生产实测，受理迟到导致 `DISPATCH_UNCERTAIN`）。回归测试见 `tests/adapter/runner-outbound-transport.test.ts`。

## Linux runner（systemd，ADR-0010）

状态：🟡 OrbStack Ubuntu 26.04（aarch64，内核 7.2.9）实测 Codex 隔离通过（2026-10-26），未在真实 Linux 主机上跑过出站任务。

- **前提**：Node ≥ 24；codex 官方 Linux 构建（自带 bwrap）。Codex 在 Linux 上用 bubblewrap 套权限档，实测与 macOS 一致：HOME 下工作区外拒读（含经符号链接）、工作区可写、`:read-only` 档只读、本机回环端口与外网不可达、hook 目录只读。发行版若限制非特权 user namespace，沙箱可能起不来——runner 启动时的沙箱自检（`CodexAdapterOptions.sandboxSelfCheck`）会因此拒绝启动，不会带着失效的隔离接任务。
- **codex 装在 HOME 下**（例如 `~/.local/bin/codex` 链到解包目录）没问题：Linux 上 codex 会在沙箱内重新执行自身二进制，Adapter 放行 codex 解析后的所在目录（`codexBinRoot`）与 npm 全局前缀（`homeToolchainRoots`）；不放行 PATH 里其他链接的目标。
- **工作目录必须在 HOME 下**：拒读清单只覆盖 HOME（ADR-0008 残余风险），`CMAP_WORK_ROOT` 放到 `/srv`、`/var/lib` 等处时其他任务的工作区与 `.runs` 不在拒绝范围内。
- **Kimi、YonWork 不支持 Linux**：两者在 Worker 侧（CrossMini），Kimi 依赖 seatbelt、在非 macOS 上拒绝运行；YonWork 运行时关联只按 macOS 布局查找。

每套服务端一个实例（多服务端见 ADR-0010）：模板单元 `~/.config/systemd/user/cmap-runner@.service`，实例名即服务端名：

```ini
[Unit]
Description=CMAP runner (%i)
After=network-online.target

[Service]
WorkingDirectory=%h/CMAP
EnvironmentFile=%h/.cmap/runner/%i/runner.env
ExecStart=%h/.local/node/bin/node apps/runner/src/main.ts
Restart=always
RestartSec=10
UMask=0077

[Install]
WantedBy=default.target
```

`~/.cmap/runner/<name>/runner.env`（0600；EnvironmentFile 不展开 `%h`，路径写绝对路径；不放令牌以外的秘密，令牌登记后删除）：

```sh
PATH=/home/<user>/.local/bin:/home/<user>/.local/node/bin:/usr/bin:/bin
CMAP_CONTROL_PLANE_URL=https://cmap.example.com
CMAP_RUNNER_KEY_FILE=/home/<user>/.cmap/runner/<name>/runner.key
CMAP_PERMIT_PUBLIC_KEY_FILE=/home/<user>/.cmap/runner/<name>/permit.pub
CMAP_PERMIT_ISSUER=<该服务端的签发方>
CMAP_WORK_ROOT=/home/<user>/.cmap/runner/<name>/work
CMAP_CODEX_MODEL=<模型>
CMAP_RUNNER_ENROLL_TOKEN=<仅首次>
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now cmap-runner@<name>
```

`loginctl enable-linger <user>` 让用户单元在未登录时也运行；日志 `journalctl --user -u cmap-runner@<name>`。TMPDIR 用系统默认（`/tmp`），不需要 macOS 那样改到物理路径。

## 已知边界

- 所有端点已有应用层请求认证与应答签名；按 ADR-0006 修订 1 **不配置 Tailscale ACL**。残余风险已接受：认证只防伪造、篡改与重放，不防同 tailnet 节点对 lap 端口的连接尝试与拒绝服务（未签名请求读完头就 401，但仍占连接）。控制面 5433/7233 只监听 127.0.0.1。
- 应用层不加密。私钥泄露即失效：CrossMini 的 `CMAP_PERMIT_KEY_FILE` 一旦泄露，攻击者既能伪造请求也能签派发许可；轮换须同时更新 lap 上的 `CMAP_PERMIT_PUBLIC_KEY_FILE`。lap 的 `CMAP_RUNNER_KEY_FILE` 泄露则可伪造应答，须同步更新 CrossMini 的 `CMAP_REMOTE_RUNNER_PUBKEY_FILE`。
- nonce 防重放缓存在内存，守护进程重启后窗口内（≤ 约 4 秒）理论上可重放；时钟偏差超过 2 秒的请求一律被拒，两机需要 NTP 同步。
- 结果产物已改为流式传输（见上「产物流式传输与内容寻址存储」），单文件上限可配（默认 256 MiB）；派发时的冻结输入仍以 base64 内联，单个约 16 MiB 上限。
- `RemoteRunnerAdapter` 的静态风险上限默认 `mutating`（与被包装的 Codex 一致），真正的上限由 lap 的 `RUNNER_MAX_RISK` 执行：派发前按 health 公布的白名单回落本地（`risk_exceeded`），探测后白名单才收紧的情形仍由 lap 准入拒绝兜底。白名单不含 `affinity.host`，指定主机不符仍由 lap 准入拒绝（`HOST_MISMATCH`）。
- 远程 runner 至多两个：lap 与可选的本机 runner 守护进程（同为 Adapter ID `remote-runner-adapter`，按 `runner_id` 区分）；第三台机器不在 ADR-0006 范围内。
