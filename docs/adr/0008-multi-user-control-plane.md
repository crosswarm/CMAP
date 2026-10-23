# ADR-0008：多用户控制面

- 状态：已接受（方向由 Cross 于 2026-10-23 决定：公网边缘 + 通用 OIDC，核心服务留在 CrossMini；**未实现**）
- 日期：2026-10-23
- 取代：[ADR-0006](0006-single-user-dual-host-exception.md)（单用户双主机例外，实现后废止）
- 重启：[ADR-0002](0002-control-plane-host.md)（控制面部署于公网主机）
- 相关：[威胁模型](../threat-model.md)、[ADR-0009](0009-quota-aware-dispatch-and-handoff.md)

## 背景

ADR-0006 只允许 Cross 一个人、两台机器、Tailscale 私网，由控制面主动拨入 runner。第二个人的笔记本在 NAT 后面，控制面拨不进去；没有人的身份认证，审批人只能靠配置；查询层的租户过滤也没有强制。现在决定把控制面放到公网服务器，接入多个用户。

## 决策

### 1. 部署形态：公网边缘在 qcl，核心留在 CrossMini

修订（2026-10-23，Cross 决定）：qcl 只放必须在公网处理的部分，其余服务仍在 CrossMini。

- **qcl（腾讯云北京，`cmap.spux.cn`）只跑边缘**：反向代理（只对外开 443，80 仅用于证书签发与跳转）、Keycloak 及其专用 PostgreSQL。qcl 不保存账本、产物、提示词或提供方凭据。
- **CrossMini 保持核心**：Temporal、账本 PostgreSQL、API（含 WebUI 与 runner 网关）、Worker、产物存储都在这里，API 仍只监听 127.0.0.1。
- **互联：CrossMini 主动建反向 SSH 隧道**。CrossMini 用专用密钥登录 qcl 的受限账号，只把 qcl 本机的一个回环端口转发到 CrossMini 的 API 端口。该账号在 `authorized_keys` 中设 `restrict,port-forwarding,permitlisten="127.0.0.1:<端口>"`，不能开 shell。由 launchd 常驻并自动重连。qcl 不加入 tailnet，家里的网络不开任何入站。
- **路由**：反向代理把 `/auth/` 转给 Keycloak，其余请求经隧道转给 CrossMini 的 API。
  - 浏览器、成员 runner、WebUI 只认 `https://cmap.spux.cn`。
  - API 以配置的公网 Host 为准，转发头只信任来自隧道回环端口的请求。
  - OIDC 模式下每个请求都必须带有效 JWT。
- **信任面**：qcl 被攻破时，攻击者能篡改登录页、窃取会话，能碰到的只有需要有效 JWT 的 API。账本、产物、Temporal、提供方凭据都不在 qcl 上。这是本方案相对整套上公网的主要收益。
- **可用性**：CrossMini 或隧道断开时，公网入口只剩登录页；runner 的长轮询失败后按租约语义进入"执行不确定"，不改派。CrossMini 需要 24 小时开机。
- **qcl 现有服务**：保留 frp 并备份其配置；其余（旧 aiticket 前端与 nginx、qdrant、playwright-mcp、RustDesk 中继等）先导出清单与数据卷备份到 CrossMini，再停用清理。

### 2. 人的身份：Keycloak（OIDC）

- 自托管 Keycloak 作为 IdP。WebUI 用 Authorization Code + PKCE 登录；API 对每个请求校验 JWT（`iss`、`aud`、`exp`、签名，JWKS 带缓存）。
- `tenant` 与 `owner` 一律取自 token claims，不再取进程配置；请求体里的身份字段只用于和 token 对照，不一致即拒绝。
- 角色：
  - `operator`：创建、取消自己的 Mission；
  - `approver-controlled`、`approver-mutating`：两类审批**分开授予**，互不蕴含；
  - `viewer`：只读；
  - `admin`：管理 runner 与委托策略。
- 审批的 `decided_by` 是 token 的主体，不再信任客户端填写。

### 3. runner 出站网关（取代控制面拨入）

- runner 主动以 HTTPS 长轮询（≤ 50 秒）领取任务，回报状态与结果；控制面永不主动连 runner。NAT 后的笔记本可以直接用。
- 消息体沿用 `remote-runner.v1` 的派发、状态、结果、取消语义，只改传输方向；派发许可、请求签名、应答签名、产物独立复算全部保留。
- 控制面用 PostgreSQL 实现网关队列（`SKIP LOCKED`）与**租约**：runner 每次轮询续租，租约过期即进入既有"执行不确定，不改派、不重跑"路径。
- runner 回报的结果先落账，再给 Workflow 发信号唤醒（同 S02 的门铃模式），Workflow 不轮询 runner。

### 4. runner 注册与机器身份

- admin 在 WebUI 生成一次性注册令牌：1 小时过期、单次使用，绑定 tenant、owner、能力上限、风险上限。
- runner 首次启动时生成 Ed25519 密钥对，用令牌换取 `runner_id` 并登记公钥。之后每个请求都要签名；吊销后立即拒绝。
- 私钥不离开 runner 主机；控制面只保存公钥。

### 5. 路由与隔离

- **owner 亲和**：任务只派给 owner 本人的 runner（也就是本人的提供方账号）。跨人共享 runner 需要显式开启，并强制更强的沙箱，不在本 ADR 内实现。
- 额度感知路由见 ADR-0009。
- 所有 Store 查询在接口层强制带 tenant；跨租户读写一律 404。补一套越权测试，即威胁模型的 P4 安全验收清单，作为上线闸口。

### 6. 审计与数据

- `events` 表只允许追加：控制面运行账号对它没有 UPDATE/DELETE 权限，并加数据库触发器兜底。
- 产物改为流式上传到内容寻址存储（按 sha256 寻址），取代 base64 内联与 16MiB 上限；静态加密与保留期另行跟进。
- 每日备份（`scripts/backup-db.mjs`）落到主机外的位置；qcl 上的 Keycloak 库同样每日备份并拉回 CrossMini。

### 7. 现有两台机器的迁移

- CrossMini 与 lap 都作为 Cross 的 runner 用注册令牌登记，改为出站模式。ADR-0006 的拨入路径保留到出站模式实测通过，然后废止。
- Temporal 栈留在 CrossMini；从已停更的 `auto-setup` 换成官方 `temporalio/server` 加 `admin-tools` 另行进行，不与本 ADR 绑定。

## 上线闸口

在威胁模型「P4 安全验收清单」的全部拒绝用例自动化通过之前，不允许第二个人登录。此外，公网入口在以下各项都实测之后才开放：TLS、Keycloak 登录、runner 注册与吊销、越权测试。

## 不做

- 不用 mTLS：应用层 Ed25519 签名加 TLS 已经覆盖来源、完整性与防重放；给 NAT 后的笔记本分发客户端证书，运维成本更高。
- 不按租户拆 Temporal namespace：租户隔离在账本与 API 层实现，Temporal 只由控制面访问。
- 不上 Kubernetes。

## 需要 Cross 提供

- [x] 公网主机：qcl（Ubuntu 24.04，可清理重装，保留 frp）
- [x] 域名：`cmap.spux.cn`，A 记录已指向 qcl（2026-10-23 核实；HTTP 访问未被备案拦截）
- [ ] 第一批成员名单与各自的角色
