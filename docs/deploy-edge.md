# 部署：公网边缘（qcl）+ 核心（CrossMini）

依据 [ADR-0008 §1 部署形态修订](adr/0008-multi-user-control-plane.md)。身份映射见 [identity.md](identity.md)。上线闸口未过之前（威胁模型 P4 拒绝用例全部自动化通过），realm 里只允许有 Cross 本人的账号。

## 形态

```
浏览器 ──443──> qcl Caddy ──/auth/*──> 127.0.0.1:8180 Keycloak ── compose 内网 ── keycloak-db
                        └──其余────> 127.0.0.1:9443 ══反向 SSH 隧道══> CrossMini 127.0.0.1:8785 API ── Temporal / 账本 PG
```

| 主机 | 组件 | 监听 |
|---|---|---|
| qcl | Caddy 2.10.2（宿主网络，Let's Encrypt 自动签发） | `*:80`（签发与跳转）、`*:443` |
| qcl | Keycloak 26.7.5（`/auth`，edge：TLS 在 Caddy 终止） | `127.0.0.1:8180` |
| qcl | Keycloak 专用 postgres:16-alpine | 只在 compose 内网 |
| qcl | sshd 反向转发（账号 `cmap-tunnel`） | `127.0.0.1:9443` |
| CrossMini | `com.cmap.api`（OIDC 模式） | `127.0.0.1:8785` |
| CrossMini | `com.cmap.worker`（队列 `cmap-main`，schema `public`） | — |
| CrossMini | `com.cmap.tunnel`（`ssh -N -R 127.0.0.1:9443:127.0.0.1:8785`） | — |

生产 API 端口用 8785，避开开发与 e2e 常用的 8787。qcl 上原有的 frps（supervisor 托管，7000/7500/8080）与本栈无关，不要动。

Caddy 对 `/auth/admin*` 与 `/auth/realms/master*` 一律返回 404：管理控制台、管理 API 与 master realm 不经公网，只经 SSH 转发访问（见下「管理 Keycloak」）。

## 仓库文件

| 文件 | 用途 |
|---|---|
| `infra/edge/docker-compose.yml` | qcl 上的 Caddy + Keycloak + Keycloak 库 |
| `infra/edge/Caddyfile` | 路由与安全头 |
| `infra/edge/keycloak/cmap-realm.json` | 生产 realm：从开发 realm 派生，无用户、无口令；关闭自助注册与找回口令，开启暴力破解保护（5 次失败起递增锁定，最长 15 分钟）、口令至少 12 位，`sslRequired=all`；`cmap-web` 只登记 `https://cmap.spux.cn/*`；`tenant` 取自用户属性（用户画像里只有 admin 可见可改，用户自己改不了） |
| `infra/edge/deploy.sh` | CrossMini 上执行：同步 `infra/edge` 到 qcl `/opt/cmap-edge` 并 `docker compose up -d` |
| `infra/edge/backup-keycloak.sh`、`cmap-edge-backup.cron` | qcl 每日 03:17（Asia/Shanghai）`pg_dump -Fc`，保留 14 份 |
| `infra/edge/pull-backups.sh` | CrossMini 上执行：把备份拉回 `~/.cmap/backups/keycloak` |
| `infra/launchd/com.cmap.{api,worker,tunnel}.plist` | launchd 模板，`__HOME__` 等占位符由 deploy 脚本替换 |
| `infra/launchd/deploy.sh` | CrossMini 发布：`git archive` → 发布目录 → 构建 WebUI → 切 `current` → 重启服务 |

秘密一律不进仓库：qcl 的 `/opt/cmap-edge/.env`（root 0600），CrossMini 的 `~/.cmap/edge/`（目录 0700、文件 0600）。

## qcl：一次性准备

所有 ssh 一律 `-o IdentityAgent=none -o BatchMode=yes`，远端用 `sudo -n`。已有 Docker 与 Compose 插件（28.x / 2.39）即可，不另装。

**隧道账号**：

```bash
sudo useradd --system --create-home --home-dir /home/cmap-tunnel --shell /usr/sbin/nologin cmap-tunnel
sudo passwd -l cmap-tunnel
sudo install -d -m 0755 -o root -g root /home/cmap-tunnel/.ssh
# authorized_keys 由 root 持有（0644），隧道账号自己改不了
echo 'restrict,port-forwarding,permitlisten="127.0.0.1:9443",command="/bin/false" ssh-ed25519 AAAA... cmap-tunnel@crossmini' \
  | sudo tee /home/cmap-tunnel/.ssh/authorized_keys
```

`/etc/ssh/sshd_config.d/60-cmap-tunnel.conf`（改前先备份 `/etc/ssh/sshd_config*`，改后 `sudo sshd -t` 通过再 `sudo systemctl reload ssh`，并**新开一个连接**确认 ubuntu 仍能登录）：

```
Match User cmap-tunnel
	AuthenticationMethods publickey
	AllowTcpForwarding remote
	PermitListen 127.0.0.1:9443
	PermitOpen none
	GatewayPorts no
	X11Forwarding no
	PermitTTY no
	AllowAgentForwarding no
	AllowStreamLocalForwarding no
	PermitTunnel no
	ForceCommand /bin/false
	ClientAliveInterval 15
	ClientAliveCountMax 3
```

`AllowTcpForwarding remote` 禁掉正向转发（`-L`），否则隧道密钥能从 qcl 内部连到 Keycloak 等回环端口。`ClientAlive*` 让网络断开后旧会话约 45 秒内释放 9443，新隧道才能绑上。

**秘密**：生成 `/opt/cmap-edge/.env`（root 0600），三项 `KC_DB_PASSWORD`、`KC_BOOTSTRAP_ADMIN_USERNAME`、`KC_BOOTSTRAP_ADMIN_PASSWORD`，口令用 `openssl rand` 生成，不回显：

```bash
gen() { openssl rand -base64 48 | tr -dc A-Za-z0-9 | cut -c1-32; }
printf 'KC_DB_PASSWORD=%s\nKC_BOOTSTRAP_ADMIN_USERNAME=cmap-admin\nKC_BOOTSTRAP_ADMIN_PASSWORD=%s\n' "$(gen)" "$(gen)" \
  | sudo install -D -m 0600 -o root -g root /dev/stdin /opt/cmap-edge/.env
```

**启动**（在 CrossMini 仓库根目录）：`infra/edge/deploy.sh`（`CMAP_EDGE_SSH` 可改 ssh 目标，默认 `qcl`）。腾讯云安全组须放行 80/443；Let's Encrypt 签发失败时先查这里。

- realm 文件只在 realm **不存在**时导入（`--import-realm` 跳过已存在的 realm），之后的改动走管理 API，不靠改文件。
- `KC_BOOTSTRAP_ADMIN_*` 在 Keycloak 26 里是"临时管理员"，后续应在 master realm 建正式管理员并删掉它。

## 管理 Keycloak

管理入口只在 qcl 回环上：

```bash
ssh -o IdentityAgent=none -o BatchMode=yes -N -L 18180:127.0.0.1:8180 qcl
# 浏览器打开 http://127.0.0.1:18180/auth/admin/
```

本地端口用 18180：8180 留给本地开发栈的 Keycloak，两者同时在用时转发会绑不上或连错实例。

建用户（tenant 是用户属性，角色按需授予，互不蕴含）：在 qcl 上用 master realm 的 `admin-cli` 取管理 token（口令从 `/opt/cmap-edge/.env` 读，经 stdin 传给 curl，不上命令行），然后：

- `POST /auth/admin/realms/cmap/users`：`{"username":…, "enabled":true, "attributes":{"tenant":["team-ycc"]}, "requiredActions":["UPDATE_PASSWORD"], "credentials":[{"type":"password","value":<随机>,"temporary":true}]}`
- `POST /auth/admin/realms/cmap/users/<id>/role-mappings/realm`：角色对象数组（从 `GET /auth/admin/realms/cmap/roles` 取）

临时口令只写到发给本人的 0600 文件里。

机器账号（服务账号客户端，client credentials）：`aud`、`tenant`、`roles` 三个映射器挂在**客户端**上（见 realm 文件里 `cmap-web` 的 `protocolMappers`），不是 realm 级的。新建客户端不会继承它们，须在该客户端上把三个映射器逐个按同样配置复制一遍；缺 `aud` 或 `tenant` 时 API 拒绝它的 token，缺 `roles` 时 token 能通过但没有任何角色（所有需要角色的操作都被拒）。

## CrossMini：一次性准备

```bash
umask 077; mkdir -p ~/.cmap/edge
ssh-keygen -t ed25519 -N '' -C cmap-tunnel@crossmini -f ~/.cmap/edge/tunnel_ed25519
# 固定 qcl 主机公钥：从已信任的 qcl 连接读取，不用 ssh-keyscan 首次信任
echo "cmap.spux.cn $(ssh -o IdentityAgent=none -o BatchMode=yes qcl 'cut -d" " -f1,2 /etc/ssh/ssh_host_ed25519_key.pub')" > ~/.cmap/edge/known_hosts
```

隧道 ssh 用 `-F /dev/null`，不读 `~/.ssh/config`、不用 agent，只认这把专用密钥与这个 known_hosts。

`~/.cmap/edge/api.env`（0600）：

```
CMAP_API_PORT=8785
CMAP_DATABASE_URL=postgres://temporal:temporal@localhost:5433/cmap
CMAP_DB_SCHEMA=public
CMAP_WORK_ROOT=/Users/<you>/.local/share/cmap-control/work
CMAP_OIDC_ISSUER=https://cmap.spux.cn/auth/realms/cmap
CMAP_OIDC_AUDIENCE=cmap-api
CMAP_OIDC_JWKS_URL=https://cmap.spux.cn/auth/realms/cmap/protocol/openid-connect/certs
CMAP_PUBLIC_ORIGIN=https://cmap.spux.cn
CMAP_GATEWAY_KEY_FILE=/Users/<you>/.cmap/edge/gateway.key
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=cmap-main
```

`~/.cmap/edge/worker.env`（0600）：

```
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=cmap-main
CMAP_DATABASE_URL=postgres://temporal:temporal@localhost:5433/cmap
CMAP_DB_SCHEMA=public
CMAP_WORK_ROOT=/Users/<you>/.local/share/cmap-control/work
RUNNER_ID=crossmini
RUNNER_TENANT=team-ycc
RUNNER_ALLOWED_TENANTS=team-ycc
RUNNER_ALLOWED_OWNERS=<cross 在 Keycloak 的用户 ID，即 token 的 sub>
RUNNER_ALLOWED_CAPABILITIES=code.analyze
RUNNER_MAX_RISK=read-sensitive
CODEX_BIN=/Users/<you>/.homebrew/bin/codex
CMAP_PERMIT_KEY_FILE=/Users/<you>/.cmap/edge/permit.key
CMAP_GATEWAY_AGENT_ID=codex@gateway
```

- `CMAP_GATEWAY_KEY_FILE`（API）签网关应答，配置后才启用 `/v1/gateway/*`；`CMAP_PERMIT_KEY_FILE`（Worker）签派发许可，两者必须是不同文件。不存在时首次启动各自生成（0600）。出站 runner 登记时自动拿到网关公钥，许可公钥则要手动导出给它：按 [remote-runner.md](remote-runner.md) 的导出命令生成 `permit.pub`，拷到 runner 主机并设为其 `CMAP_PERMIT_PUBLIC_KEY_FILE`。轮换 `permit.key` 后须同步更新所有出站 runner 上的 `permit.pub`。

- OIDC 模式下 Mission 的 owner 是 token 的 `sub`，不是用户名；准入白名单里写用户名会让本人的任务全部 `OWNER_DENIED`。
- `CMAP_WORK_ROOT` 必须在发布目录之外，否则切换发布会丢掉运行记录与产物。
- API 与 Worker 必须同 schema、同队列；不配置 `CMAP_DELEGATION_POLICY_FILE`（不启用 Jev 委托）。Memross 未配置时要求记忆的 Mission 失败关闭。
- 代理变量（`NODE_USE_ENV_PROXY=1`、`HTTP(S)_PROXY` 指向 Surge）与 `TMPDIR=/private/tmp` 写在 Worker 的 plist 里：`NODE_USE_ENV_PROXY` 须在进程启动时就存在。API 直连 qcl 取 JWKS，不走代理。

## 发布（CrossMini）

```bash
infra/launchd/deploy.sh            # 默认 HEAD；也可传提交号
```

1. 工作区 `package.json` / `package-lock.json` 与发布提交不一致即拒绝（`node_modules` 从工作区克隆）。
2. 发布目录 `~/.local/share/cmap-control/<sha>` 不存在时：`git archive <sha>` 解包，`cp -c -R` 克隆 `node_modules`（APFS 克隆，不占额外空间），带 `VITE_CMAP_OIDC_ISSUER=https://cmap.spux.cn/auth/realms/cmap`、`VITE_CMAP_OIDC_CLIENT_ID=cmap-web` 构建 WebUI。已存在则直接复用。
3. `current` 软链切到该目录；plist 有变化则 bootout + bootstrap，否则 `launchctl kickstart -k` 重启 API 与 Worker。隧道不随发布重启。

`CMAP_NODE` 指定 node 路径（默认 `command -v node`；zsh 里 node 若是 nvm 包装函数，须显式指定真实路径）。日志在 `~/.local/share/cmap-control/logs/`（不轮转，需定期清理）。

回滚：`ln -sfn ~/.local/share/cmap-control/<旧sha> ~/.local/share/cmap-control/current`，再 `launchctl kickstart -k gui/$(id -u)/com.cmap.api` 与 `…/com.cmap.worker`。

LaunchAgent 只在 Cross 的图形会话里运行：CrossMini 须保持该用户登录（开机自动登录或不注销）。

## 备份

- qcl：cron 每日以 root 执行 `/opt/cmap-edge/backup-keycloak.sh`，写 `/var/backups/cmap-edge/keycloak-<UTC时间戳>.dump`（目录 0700、文件 0600），保留 14 份，日志 `/var/log/cmap-edge-backup.log`。
- 拉回 CrossMini：`infra/edge/pull-backups.sh`（rsync，远端 `sudo -n rsync` 读 root 文件），落到 `~/.cmap/backups/keycloak`，本地同样保留 14 份。
- CrossMini 定时任务（由 `infra/launchd/deploy.sh` 安装，发布时不触发；手动补跑 `launchctl kickstart gui/$(id -u)/<label>`）：
  - `com.cmap.backup`（每日 03:40，`infra/launchd/cmap-backup.sh`）：`scripts/backup-db.mjs`（账本与 Temporal 库）+ `pull-backups.sh`，任一步失败仍做完其余步骤并以非零退出，日志 `~/.local/share/cmap-control/logs/backup*.log`。
  - `com.cmap.backup-mirror`（每日 04:10）：`/usr/bin/rsync -a --delete ~/.cmap/backups/` 到 iCloud Drive 的 `CMAP-backups`，作为主机外副本，日志 `backup-mirror*.log`。iCloud Drive 受 TCC 保护，须在「系统设置 › 隐私与安全性 › 完全磁盘访问权限」中添加 `/usr/bin/rsync`（未授权时报 `Operation not permitted`）。授权后，凡以 rsync 为 TCC 责任进程启动的（如 launchd 直接拉起）都获得全盘访问；从终端等其他程序调用时仍按调用方的授权。
- 还原校验：`docker exec -i cmap-edge-keycloak-db pg_restore -l < <dump>` 能列出表即文件完整；灾难恢复时先停 keycloak，再对清空的 `keycloak` 库 `pg_restore --no-owner`。

## 验收

```bash
curl -sSI https://cmap.spux.cn/auth/                     # 有效证书（Let's Encrypt）
curl -s -o /dev/null -w '%{http_code}\n' https://cmap.spux.cn/v1/context     # 401
curl -s -o /dev/null -w '%{http_code}\n' https://cmap.spux.cn/auth/admin/     # 404（管理入口不经公网）
docker exec cmap-temporal temporal task-queue describe --address temporal:7233 --task-queue cmap-main   # Worker 在 Pollers 里
kill "$(launchctl list | awk '$3=="com.cmap.tunnel"{print $1}')"   # 隧道约 10 秒内由 launchd 拉起
```

登录链路（PKCE、首次改密、伪造/过期 token、未注册用户、注册端点）用脚本走真实 Keycloak 表单验证；**不要在生产 schema 上跑会派发真实 Agent 的 e2e**（e2e 脚本一律用独立 schema 与队列）。

## 注意

- qcl 装有腾讯云主机安全（iptables 链 `YJ-FIREWALL-INPUT`），会封禁 SSH 认证反复失败的来源 IP。隧道密钥或 known_hosts 配错时 launchd 每 10 秒重试一次，可能把 CrossMini 的出口 IP 封掉，连带 ubuntu 运维登录；改密钥前先手动验证一次。
- 隧道断开时公网入口只剩登录页，其余返回 502。
- 审计流只追加（ADR-0008 §6）：`events` 表的 UPDATE/DELETE 已由迁移建的触发器拒绝，这只是兜底——表所有者能删触发器。**生产部署项（未完成）**：控制面运行账号不能是表所有者，并对它 `REVOKE UPDATE, DELETE, TRUNCATE ON events`；当前 `CMAP_DATABASE_URL` 用的 `temporal` 账号既是所有者又是运行账号，做不到权限分离。
