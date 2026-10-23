# 身份：OIDC claims 到 tenant / owner / 角色的映射

依据 [ADR-0008 §2](adr/0008-multi-user-control-plane.md)。本文只定义映射规则；API 是否已按此实现，以 `tests/api/` 中的 OIDC 测试为准。

## 两种模式

| 模式 | 何时生效 | 身份来源 |
|---|---|---|
| 本机模式 | 未配置 `CMAP_OIDC_ISSUER` | 进程配置 `CMAP_TENANT` / `CMAP_OWNER`；只接受本机 Host 与同源写入；`/v1/context` 返回 `authentication: "local"` |
| OIDC 模式 | 配置了 `CMAP_OIDC_ISSUER`、`CMAP_OIDC_AUDIENCE`、`CMAP_OIDC_JWKS_URL` | 每个请求的 Bearer JWT；本机模式自动关闭（不再看 Host，也不再使用 `CMAP_TENANT` / `CMAP_OWNER`）；`/v1/context` 返回 `authentication: "oidc"` |

两种模式不混用：OIDC 模式下没有"本机免认证"的后门。只配了一部分 OIDC 变量时 API 拒绝启动。

## 令牌校验

每个 `/v1/*` 请求（`/v1/health` 除外）必须带 `Authorization: Bearer <access token>`，否则 401。以下任一不满足也是 401，响应不区分原因：

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

没有任何上述角色的有效 token：除 `/v1/health` 外一律 403。跨租户资源仍按 404 处理，不用 403 泄漏存在性。

## Keycloak 开发 realm

开发栈的 realm 导入文件见 `infra/docker-compose/keycloak/`：一个 `tenant` 硬编码 claim 映射器、一个把 realm 角色平铺成 `roles` 的映射器、一个把 `aud` 设为 API 受众的映射器。生产 IdP 只要产出同样的 `iss` / `aud` / `sub` / `tenant` / `roles` 即可，不依赖 Keycloak 专有的 `realm_access`。
