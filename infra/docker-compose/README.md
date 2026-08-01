# 本地开发栈

```bash
# 启动
docker compose -f infra/docker-compose/docker-compose.yml up -d

# 查看状态（temporal 需等 auto-setup 建完 schema，约 30-60s）
docker compose -f infra/docker-compose/docker-compose.yml ps

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

## 必读：本机代理会拦截 localhost

本机 `http_proxy` / `https_proxy` 指向 Surge（`127.0.0.1:6152`），且默认**未设置 `no_proxy`**。

这是一个已知会造成**静默挂起**的组合：Surge 拦截无服务监听的 localhost 端口时，不会像正常情况那样拒绝 TCP 连接，而是返回 HTTP 200 加一个 HTML 错误页。客户端看到连接成功，于是无限等待一个永远不会到来的有效响应——表现为任务卡死、无日志、无报错，比直接失败难查得多。

因此本项目的 Node 进程**必须**设置：

```bash
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy=localhost,127.0.0.1,::1
```

`.env.example` 已包含该项。若出现"连接不报错但一直没响应"，先查这里，不要先去怀疑 Temporal。

排查命令（`--noproxy` 绕过代理，能直连才说明服务真的活着）：

```bash
curl --noproxy '*' -sS http://localhost:8088/ -o /dev/null -w '%{http_code}\n'
```

## 必读：colima 下 dockerd 不继承代理

本机 Docker 由 **colima**（Lima VM）提供。VM 的 shell 有代理变量指向宿主 Surge，但 **dockerd 进程不继承它们**——于是 `colima ssh -- curl` 能通，`docker pull` 却超时，两者表现矛盾，很容易误判成"网络时好时坏"。

实测对照：

| 主体 | 代理 | 访问 registry-1.docker.io |
|---|---|---|
| 宿主（走 Surge） | 有 | 401（正常认证响应，通） |
| 宿主（`--noproxy '*'`） | 无 | 超时 |
| VM shell | `192.168.5.2:6152` | 401（通） |
| dockerd | **无** | `i/o timeout` |

DNS 也不一致：VM 内解析到 `202.160.130.117`，dockerd 却卡在 `173.234.53.168`。

修法是给 dockerd 单独补代理（`192.168.5.2` 是 VM 视角的宿主地址）：

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

只重启 docker 服务，不必重启整个 colima。**重启会停掉所有运行中的容器**，操作前先 `docker ps` 确认。

回滚：删除该文件后重新 `daemon-reload && restart docker`。

验证代理确实生效（而不是只写了文件）：

```bash
colima ssh -- sudo cat /proc/$(colima ssh -- pgrep dockerd | head -1)/environ | tr '\0' '\n' | grep -i proxy
```

## 端口占用

`8233` 已被 Surge 占用，`8080` 易被其他服务抢占，故 Web UI 用 `8088`。
PostgreSQL 用 `5433` 以避开本机可能存在的 `5432`。

## 必读：auto-setup 不会创建 default namespace

`temporalio/auto-setup:latest`（server 1.29.3）内的 `auto-setup.sh` 在建完 schema 后会轮询等待 server 就绪，但它连的是 `127.0.0.1:8234`——而 server 实际绑定的是**容器 IP 的 7233**，且根本没有 8234 监听。这个等待永远不会成功，于是脚本后续的**「创建 default namespace」一步从未执行**，容器还会被 restart policy 反复拉起。

同一原因也让 `temporal` CLI 不可用：无论传什么 `--address`，它都固定去连 `127.0.0.1:8234`。因此本项目的健康检查与诊断都不依赖该 CLI。

表象很有迷惑性——`docker ps` 显示 Up、端口也 LISTEN，但 SDK 一连就发现 `default` 不存在。

补救（幂等，可反复执行）：

```bash
node scripts/verify-temporal.mjs
```

该脚本按实际使用路径验证：建 gRPC 连接 → 取服务端版本 → 列 namespace →
缺失则创建并**回读确认** → 用 Client 发起一次真实查询。

**判定就绪请以此脚本为准，不要以容器 Up 或端口 LISTEN 为准。**

## 版本钉扎

`docker-compose.yml` 中镜像版本由 `TEMPORAL_VERSION` / `TEMPORAL_UI_VERSION` 控制，默认 `latest`。
首次拉取后应将实际版本写入 `.env` 钉住，避免 `latest` 漂移导致 Workflow 重放行为变化。
