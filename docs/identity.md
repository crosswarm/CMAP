# 身份：OIDC claims 到 tenant / owner / 角色的映射

依据 [ADR-0008 §2](adr/0008-multi-user-control-plane.md)。本文只定义映射规则；API 是否已按此实现，以 `tests/api/` 中的 OIDC 测试为准。

## 两种模式

| 模式 | 何时生效 | 身份来源 |
|---|---|---|
| 本机模式 | 未配置 `CMAP_OIDC_ISSUER` | 进程配置 `CMAP_TENANT` / `CMAP_OWNER`；只接受本机 Host 与同源写入；`/v1/context` 返回 `authentication: "local"` |
| OIDC 模式 | 配置了 `CMAP_OIDC_ISSUER`、`CMAP_OIDC_AUDIENCE`、`CMAP_OIDC_JWKS_URL` | 每个请求的 Bearer JWT；本机模式自动关闭（不再使用 `CMAP_TENANT` / `CMAP_OWNER`）；`/v1/context` 返回 `authentication: "oidc"` |

两种模式不混用：OIDC 模式下没有"本机免认证"的后门。只配了一部分 OIDC 变量时 API 拒绝启动。

### 经反向代理对外（ADR-0008 部署修订）

公网主机（qcl，`cmap.spux.cn`）只跑反向代理与 Keycloak；API 与 WebUI 仍在 CrossMini，只监听 `127.0.0.1`，经 CrossMini 主动建立的反向 SSH 隧道接收 qcl 转发的请求。

- `CMAP_PUBLIC_ORIGIN`（例如 `https://cmap.spux.cn`，不带路径）：OIDC 模式下额外放行其 Host；经该 Host 的写入，`Origin` 必须**逐字等于**它（`http://` 降级、其他域名一律 403），`Sec-Fetch-Site: cross-site` 也拒绝。本机地址（`127.0.0.1:<端口>`、`localhost:<端口>`）照旧放行，来源须为 `http://<host>`；其他 Host 一律 403。
- 只配 `CMAP_PUBLIC_ORIGIN` 而未配 OIDC，API 拒绝启动：本机模式没有认证，不能经反向代理对外。
- 反向代理须原样转发 `Host`（例如 nginx `proxy_set_header Host $host`），否则请求会以隧道端的本机 Host 到达。
- Keycloak 在公网按 `/auth/` 前缀转发（Keycloak 侧 `KC_HTTP_RELATIVE_PATH=/auth`、`KC_HOSTNAME=https://cmap.spux.cn/auth`），issuer 为 `https://cmap.spux.cn/auth/realms/<realm>`。`CMAP_OIDC_ISSUER` / `CMAP_OIDC_JWKS_URL` 与 WebUI 构建变量 `VITE_CMAP_OIDC_ISSUER` 按此配置；本地开发用 compose 的 `http://localhost:8180/realms/cmap`。WebUI 的 `redirect_uri` 取当前页面 Origin，经公网访问即为公网 Origin，生产 realm 的 client 须登记 `https://cmap.spux.cn/*`（开发 realm 只登记本机地址）。

## 令牌校验

每个 `/v1/*` 请求（含 `/v1/health`）必须带 `Authorization: Bearer <access token>`，否则 401。以下任一不满足也是 401，响应不区分原因：

- 签名：只接受 `RS256`；`kid` 必须在 JWKS 中。JWKS 从 `CMAP_OIDC_JWKS_URL` 拉取并缓存，遇到未知 `kid` 才重新拉取（两次拉取至少间隔 30 秒，防止用随机 `kid` 打满 IdP）。
- `iss` 与 `CMAP_OIDC_ISSUER` 逐字相等。
- `aud`（字符串或数组）包含 `CMAP_OIDC_AUDIENCE`。
- `exp` 必填且未过期；`nbf` 若存在须已生效。允许 30 秒时钟偏差。
- `sub` 必填。

## claims 映射

| 控制面字段 | 取自 claim | 缺失时 |
|---|---|---|
| `tenant` | `tenant`（字符串） | 403 |
| `owner`（Mission 归属、审批 `decided_by`、取消事件的 actor） | `sub` | 401（见上） |
| 角色 | `roles`（字符串数组；只认下表 5 个值，其余忽略） | 视为无角色 |

选 `sub` 而不是 `preferred_username`：用户名在 IdP 里可以改，`sub` 不变，审计流里的人才对得上。WebUI 只把它当不透明 ID 显示。

请求体里出现的身份字段只用于与 token 对照，不一致即拒绝（例如审批的 `decided_by`）；Mission 的 `tenant` / `owner` 从不取自请求体。

## 角色

角色**互不蕴含**：`admin` 不自带 operator 或审批权，`approver-mutating` 不自带 `approver-controlled`，反之亦然。

| 角色 | 允许 |
|---|---|
| `viewer` | 只读：Mission、任务、证据、评审、审批列表、锁、事件流、产物下载、审批建议（只查询，不改审批） |
| `operator` | 只读，加上创建 Mission、启动/取消**自己**（`owner == sub`）的 Mission |
| `approver-controlled` | 只读，加上决定 `scope=controlled` 的审批 |
| `approver-mutating` | 只读，加上决定 `scope=mutating` 的审批 |
| `admin` | 只读，加上管理 runner（签发注册令牌、吊销，见 [runner-enrollment.v1](../schemas/runner-enrollment.v1.schema.json)）与委托策略 |

没有任何上述角色的有效 token：所有 `/v1/*` 一律 403。只有 `/` 与 `/assets/*`（登录前要加载的 WebUI 静态资源）不要求 token。跨租户资源仍按 404 处理，不用 403 泄漏存在性。

## Keycloak 开发 realm

开发栈的 realm 导入文件见 `infra/docker-compose/keycloak/`：一个 `tenant` 硬编码 claim 映射器、一个把 realm 角色平铺成 `roles` 的映射器、一个把 `aud` 设为 API 受众的映射器。生产 IdP 只要产出同样的 `iss` / `aud` / `sub` / `tenant` / `roles` 即可，不依赖 Keycloak 专有的 `realm_access`。
