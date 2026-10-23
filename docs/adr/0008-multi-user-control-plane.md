# ADR-0008：多用户控制面

- 状态：已接受（方向由 Cross 于 2026-10-23 决定：公网服务器 + 通用 OIDC；**未实现**）
- 日期：2026-10-23
- 取代：[ADR-0006](0006-single-user-dual-host-exception.md)（单用户双主机例外，实现后废止）
- 重启：[ADR-0002](0002-control-plane-host.md)（控制面部署于公网主机）
- 相关：[威胁模型](../threat-model.md)、[ADR-0009](0009-quota-aware-dispatch-and-handoff.md)

## 背景

ADR-0006 只允许 Cross 一个人、两台机器、Tailscale 私网，由控制面主动拨入 runner。第二个人的笔记本在 NAT 后面，控制面拨不进去；没有人的身份认证，审批人只能靠配置；查询层的租户过滤也没有强制。现在决定把控制面放到公网服务器，接入多个用户。

## 决策

### 1. 部署形态

- 控制面部署在一台公网 Linux 主机（qcl 或新主机，待定）上，只对外暴露 443，由反向代理终结 TLS。
- Temporal、PostgreSQL、Keycloak 只在主机内部网络可达，不对外开端口。
- 控制面仍不执行 Agent：主机上只跑 API、Worker、网关与基础设施。

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
- 每日备份（`scripts/backup-db.mjs`）落到主机外的位置。

### 7. 现有两台机器的迁移

- CrossMini 与 lap 都作为 Cross 的 runner 用注册令牌登记，改为出站模式。ADR-0006 的拨入路径保留到出站模式实测通过，然后废止。
- Temporal 栈从已停更的 `auto-setup` 换成官方 `temporalio/server` 加 `admin-tools`，在新主机上部署。

## 上线闸口

在威胁模型「P4 安全验收清单」的全部拒绝用例自动化通过之前，不允许第二个人登录。此外，公网入口在以下各项都实测之后才开放：TLS、Keycloak 登录、runner 注册与吊销、越权测试。

## 不做

- 不用 mTLS：应用层 Ed25519 签名加 TLS 已经覆盖来源、完整性与防重放；给 NAT 后的笔记本分发客户端证书，运维成本更高。
- 不按租户拆 Temporal namespace：租户隔离在账本与 API 层实现，Temporal 只由控制面访问。
- 不上 Kubernetes。

## 需要 Cross 提供

- 公网主机（qcl 或新主机）及其 root/sudo 访问方式；
- 域名与 DNS 解析权限（签发 TLS 证书需要）；
- 第一批成员名单与各自的角色。
