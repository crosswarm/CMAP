# 本地开发栈

```bash
# 启动
docker compose -f infra/docker-compose/docker-compose.yml up -d

# 就绪判定（唯一权威判据，见下文）
node scripts/verify-temporal.mjs

# 停止（保留数据）
docker compose -f infra/docker-compose/docker-compose.yml down

# 停止并清库（会丢弃任务账本，仅限本地）
docker compose -f infra/docker-compose/docker-compose.yml down -v
```

| 服务 | 地址 | 说明 |
|---|---|---|
| Temporal gRPC | `localhost:7233` | Worker 与 Client 连接点 |
| Temporal Web UI | http://localhost:8088 | 查看 Workflow 执行历史，排障主力 |
| PostgreSQL | `localhost:5433` | 用户/密码/库名均为 `temporal` |

所有端口都绑定在 `127.0.0.1`，不对外暴露。

---

## 三个代理陷阱

这个栈搭建过程中踩到的问题**全部**与代理有关，且都表现为「看起来成功、实际没成」。三个陷阱位于三个不同层次，互相独立，需要分别处理。

### 陷阱一：容器内被注入不可达的代理（最隐蔽）

`~/.docker/config.json` 中若配置了：

```json
"proxies": { "default": { "httpProxy": "http://127.0.0.1:8234", ... } }
```

Docker CLI 会把它注入**每一个**容器。但容器内的 `127.0.0.1` 指向容器自身，那里并没有代理监听，于是容器内所有出站连接一律 connection refused。

对 Temporal 尤其致命：server 的 worker service 要连 frontend、CLI 要连 server，全部被这个不存在的代理劫持。

**表象极具误导性**：

- 日志刷屏 `dial tcp 127.0.0.1:8234: connect: connection refused`
- 而 8234 **不是任何 Temporal 端口**，是那个代理地址——很容易误以为是 Temporal 的某个内部端口没起来
- `docker ps` 显示 Up、`netstat` 显示 7233 在 LISTEN，宿主 `nc` 也能连通
- `temporal` CLI 无视 `--address` 参数（其实是走了代理）
- server 每 ~60 秒退出一次（ExitCode=0）被 restart policy 拉起，形成无限重启循环

**修法**：compose 中用 `x-no-proxy` 锚点为所有服务清空代理变量并设 `NO_PROXY=*`。容器间通信本就不需要代理。不必改动全局 Docker 配置。

验证：

```bash
docker exec cmap-temporal sh -c 'echo "http_proxy=[$http_proxy] NO_PROXY=[$NO_PROXY]"'
# 期望：http_proxy=[] NO_PROXY=[*]
docker logs --since 60s cmap-temporal | grep -c 8234
# 期望：0
```

### 陷阱二：colima 下 dockerd 不继承代理，拉不到镜像

本机 Docker 由 **colima**（Lima VM）提供。VM 的 shell 有代理变量指向宿主 Surge，但 **dockerd 进程不继承它们**——于是 `colima ssh -- curl` 能通、`docker pull` 却超时，两者矛盾，易误判成「网络时好时坏」。

实测对照：

| 主体 | 代理 | 访问 registry-1.docker.io |
|---|---|---|
| 宿主（走 Surge） | 有 | 401（正常认证响应，通） |
| 宿主（`--noproxy '*'`） | 无 | 超时 |
| VM shell | `192.168.5.2:6152` | 401（通） |
| dockerd | **无** | `i/o timeout` |

DNS 也不一致：VM 内解析到 `202.160.130.117`，dockerd 却卡在 `173.234.53.168`。

**修法**（`192.168.5.2` 是 VM 视角的宿主地址）：

```bash
colima ssh -- sudo mkdir -p /etc/systemd/system/docker.service.d
colima ssh -- sudo tee /etc/systemd/system/docker.service.d/http-proxy.conf <<'EOF'
[Service]
Environment="HTTP_PROXY=http://192.168.5.2:6152"
Environment="HTTPS_PROXY=http://192.168.5.2:6152"
Environment="NO_PROXY=localhost,127.0.0.1,::1,192.168.5.0/24,*.local,*.internal"
EOF
colima ssh -- sudo systemctl daemon-reload
colima ssh -- sudo systemctl restart docker
```

只重启 docker 服务，不必重启整个 colima。**重启会停掉所有运行中的容器**，操作前先 `docker ps` 确认。回滚：删除该文件后重新 `daemon-reload && restart docker`。

验证代理确实生效（而不是只写了文件）：

```bash
colima ssh -- sudo cat /proc/$(colima ssh -- pgrep dockerd | head -1)/environ | tr '\0' '\n' | grep -i proxy
```

### 陷阱三：宿主 Surge 拦截 localhost，造成静默挂起

宿主 `http_proxy` / `https_proxy` 指向 Surge（`127.0.0.1:6152`），且默认**未设 `no_proxy`**。

Surge 拦截无服务监听的 localhost 端口时，不会拒绝 TCP 连接，而是返回 HTTP 200 加一个 HTML 错误页。客户端看到连接成功，于是无限等待一个永远不会到来的有效响应——**任务卡死、无日志、无报错**，比直接失败难查得多。

因此本项目的 Node 进程**必须**设置：

```bash
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy=localhost,127.0.0.1,::1
```

`.env.example` 已包含该项，`scripts/verify-temporal.mjs` 与 codex-adapter 也在代码里显式设置。若出现「连接不报错但一直没响应」，先查这里，不要先怀疑 Temporal。

排查命令（`--noproxy` 绕过代理，能直连才说明服务真的活着）：

```bash
curl --noproxy '*' -sS http://localhost:8088/ -o /dev/null -w '%{http_code}\n'
```

---

## 就绪判定：以 SDK 为准

**不要**以 `docker ps` 显示 Up、健康检查变绿或端口 LISTEN 判断服务可用——上述陷阱下这三个信号可以同时为真而服务实际不可用。

```bash
node scripts/verify-temporal.mjs
```

该脚本按实际使用路径验证：建 gRPC 连接 → 取服务端版本 → 列 namespace → 缺失则创建并**回读确认** → 用 Client 发起一次真实查询。

## 新环境初始化

compose 中 `command: ["start"]` 跳过了镜像默认的 `autosetup`，因此**首次部署到全新数据库时**需要先建 schema 与 default namespace：

```bash
# 1. 只起数据库
docker compose -f infra/docker-compose/docker-compose.yml up -d postgresql

# 2. 用带 autosetup 的一次性容器建 schema（代理必须清空，否则会卡在等待）
docker run --rm --network cmap-dev_default \
  -e DB=postgres12 -e DB_PORT=5432 \
  -e POSTGRES_USER=temporal -e POSTGRES_PWD=temporal -e POSTGRES_SEEDS=postgresql \
  -e HTTP_PROXY= -e HTTPS_PROXY= -e http_proxy= -e https_proxy= -e NO_PROXY='*' \
  temporalio/auto-setup:latest autosetup

# 3. 起完整栈，namespace 由 verify 脚本兜底创建
docker compose -f infra/docker-compose/docker-compose.yml up -d
node scripts/verify-temporal.mjs
```

注意 `command: []` 无效——Compose 把空数组当作「未指定」，镜像默认的 `CMD ["autosetup"]` 依然生效。必须给非空的无害值。entrypoint 只识别 `autosetup` / `develop` / `bash`，其余一律落到 `start-temporal.sh`。

## 端口占用

`8233` 已被 Surge 占用，`8080` 易被其他服务抢占，故 Web UI 用 `8088`。
PostgreSQL 用 `5433` 以避开本机可能存在的 `5432`。

## 版本钉扎

镜像版本由 `TEMPORAL_VERSION` / `TEMPORAL_UI_VERSION` 控制，默认 `latest`。
`.env.example` 中已记录首次验证通过的 digest（server 1.29.3），复制为 `.env` 即可钉住，避免 `latest` 漂移导致 Workflow 重放行为变化。
