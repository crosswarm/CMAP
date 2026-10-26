# ADR-0010：多服务端加入与 Linux runner

- 状态：已接受（方向由 Cross 于 2026-10-26 决定）；实现情况见文末「实现状态」
- 日期：2026-10-26
- 相关：[ADR-0006](0006-single-user-dual-host-exception.md)（双主机）、[ADR-0008](0008-multi-user-control-plane.md)（多用户）、[ADR-0009](0009-quota-aware-dispatch-and-handoff.md)（额度）、[remote-runner](../remote-runner.md)

## 场景

系统可以独立部署多套服务端（各自 API、账本、Temporal、Keycloak、域名）。同一台 runner 主机与同一个用户可以同时加入多套服务端，分别接收各自的协作任务。runner 要同时支持 macOS 与 Linux。

## 已核实的事实（2026-10-26）

- 代码里没有"多服务端"概念：一个 runner 进程只认一个 `CMAP_CONTROL_PLANE_URL`；多租户只在单个服务端内（token 的 tenant claim）。
- 任务 ID 不含服务端身份（Mission ID = sha256(tenant, owner, request_id)）。两个 runner 共用工作目录时，Codex 运行记录会被复用，**B 服务端可能拿到 A 的结果**。
- 登记记录不记录所属服务端；配错目录时 runner 拿 A 的身份连 B，一直 401，领取循环静默重试。
- 派发许可的签发方在 Worker 写死为 `cmap:local-control-plane`，所有服务端相同；跨服务端许可目前只靠每个进程固定一把公钥隐式拒绝。
- 出站模式不上报额度，网关 runner 在路由里一律"额度未知"。
- runner 只执行 Codex；Kimi 与 YonWork 在 Worker 侧。Codex 在 Linux 上用 bubblewrap 套权限档：OrbStack Ubuntu 26.04（aarch64）实测 HOME 下工作区外拒读（含符号链接）、工作区可写、`:read-only` 只读、回环端口与外网不可达、hook 目录只读，与 macOS 一致。实测还发现：Linux 上 codex 在沙箱内重新执行自身二进制，二进制在 HOME 下且被拒读时整个任务失败。
- 修复前，P4-05b/P4-06 的真实沙箱测试在非 macOS 上整体跳过，Codex health 只跑 `--version`：Linux 上隔离不生效也不会被发现。

## 决策

### 1. 每套服务端一个 runner 实例

不做"一个进程连多套服务端"。主机每加入一套服务端就起一个独立实例，各有自己的服务端地址、runner 私钥、登记记录、派发许可公钥、工作目录和服务名（macOS `com.cmap.runner.<name>`，Linux `cmap-runner@<name>`）。故障、数据和凭据按进程隔开。

- 登记记录写入所属服务端的 origin；启动时与 `CMAP_CONTROL_PLANE_URL` 不一致即拒绝启动。旧记录按当前 URL 补写。
- 出站模式必须显式设置 `CMAP_WORK_ROOT`；工作目录写入所属服务端标记，标记不同即拒绝启动。
- 鉴权失败在领取循环里明确打印，不再静默。

### 2. 服务端身份可审计

`CMAP_PERMIT_ISSUER` 在 Worker 与 runner 两侧都可配置，每套服务端取唯一值；未设置时保持 `cmap:local-control-plane`（兼容现有部署）。

### 3. 额度

出站 runner 在领取请求中附带额度快照，网关保存每个 runner 的最新快照，路由可见。**跨服务端不协调**：同一提供方账号被多套服务端使用时，各自看到的是提供方侧的真实用量，但没有预留，可能同时把额度用完，靠 `QUOTA_EXHAUSTED` 续接兜底（ADR-0009）。

### 4. 用户

每套服务端有自己的 Keycloak 账号，用户在每套各登录各的网址。不做统一身份或"一个前端切换多套服务端"。

### 5. Linux runner

- Codex 的隔离由权限档承担，macOS 与 Linux 同一套参数；额外放行 codex 解析后的所在目录（`codexBinRoot`）与 npm 全局前缀；不放行 PATH 里其他链接的目标（会暴露无关项目目录，且拒绝清单过长时 macOS seatbelt 编译失败，2026-10-26 实测 1605 条即失败）。
- **沙箱自检**：生产 runner 与 Worker 的 Codex health 先用 `codex sandbox` 实测一个被拒绝的探针文件；拒绝不生效即 `unavailable`。出站 runner 启动时自检不过就拒绝启动。通过后进程内缓存。
- P4-05b/P4-06 的 Codex 部分在所有平台真实执行，只有 Kimi 的 seatbelt 部分限 macOS。
- Linux 部署用 systemd 用户模板单元（见 remote-runner.md）；工作目录必须在 HOME 下。
- Kimi、YonWork 不支持 Linux（在 Worker 侧，不影响 runner）。

### 6. 加入别人的服务端

同一系统用户下 HOME 以外可读（ADR-0008 残余风险），这只在所有服务端都由主机主人运营时可接受。加入他人运营的服务端时，每套服务端用单独的系统用户运行 runner（提供方 CLI 需要在该用户下各自登录）。本 ADR 不为此写代码，只作部署要求。

## 后果

- 多服务端的数据串用与登记错配由启动时检查拦住，代价是出站部署必须显式设置 `CMAP_WORK_ROOT`（lap 生产是监听模式且已设置，2026-10-26 核对，不受影响）。
- 额度可能被多套服务端同时耗尽，接受。
- Linux 隔离只在 OrbStack 上实测；真实 Linux 主机上线前须再跑一次 P4-05b/P4-06 与出站任务。发行版限制非特权 user namespace 时沙箱可能起不来，由自检拒绝启动。
- macOS seatbelt 对拒绝清单有长度上限：2026-10-26 实测 1200 条可编译、1605 条失败。清单随 HOME 结构增长（工作区、工具链在 HOME 下越深，兄弟条目越多），超限时所有 Codex 任务失败；沙箱自检只用一条探针，测不出这种情况。当前生产 HOME 约 733 条。
- 没有 CI；Linux 回归靠手动在 Linux 主机上跑 `npm test` 与 `npm run test:api`。

## 实现状态

见 `scripts/ralph/log.md`「ADR-0010」一节。
