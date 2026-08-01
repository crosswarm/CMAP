# ADR-0002：控制面部署于 qcl 公网服务器

- 状态：已接受
- 日期：2026-08-01
- 相关阶段：P4（上线），P0–P3 期间控制面在本机运行

## 背景

CMAP 的最终形态是多人多机、跨公网协作：团队成员各自的 Agent 通过 runner 接入同一控制面。这要求控制面满足三个条件：

1. **公网可达** —— 成员机器分布在不同网络
2. **7×24 常驻** —— 关掉任何人的笔记本都不应中断 Mission 推进
3. **Linux** —— 与 docker-compose 部署栈一致

## 决策

复用现有的 **`qcl`** 服务器（SSH alias，配置在本地 `~/.ssh/config`；Ubuntu，公网可达）作为 P4 控制面的部署目标。

P0–P3 期间控制面仍在本机运行，通过 `Store` / `Transport` 接口抽象保证迁移时**调度器与 Adapter 代码不需改动**——若迁移时需要大改，说明早期边界画错了。

## 与 AITicket 规范的关系（重要，避免重复误读）

AITicket 的权威规范 `aiticket/docs/standards/repository-lineage-and-release.md` 中有多处 "QCL 已废弃" 的表述，例如：

> QCL 已废弃，不属于当前 deployable 或发布链。
> ……不得把 QCL 当作 deployable、发布仓库或运行目标。

**这些条款约束的是 AITicket 的仓库血缘与发布链**，含义是这台机器不再位于 aiticket 的部署链路中，**并非判定该服务器本身不可用或已下线**。

CMAP 是与 aiticket 无血缘关系的独立项目，将 qcl 用作 CMAP 控制面**不触碰**上述规范。

> 记录此节的原因：首次读取该规范时曾把适用范围读窄，误将"不得作为运行目标"理解为服务器整体停用。后续接手者（人或 Agent）读到那段规范时，不必重新纠结。

**仍然有效的约束**：不得把 qcl 重新写入 aiticket 的 deployable、发布仓库或同步链路。CMAP 用途与 aiticket 用途必须保持隔离。

## 后果

- **网络方向**：控制面永不主动入站；runner 一律**反向拨出**建立长连接（WSS + mTLS）。成员笔记本在 NAT 后、跳板机后或离线环境时同样适用。
- **安全等级提升**：公网 + 多租户 + Agent 自动执行 = 远程代码执行平台。runner 必须**默认拒绝、白名单放行**（按 tenant / owner / capability），凭据短期化并绑定受众。详见 `docs/threat-model.md`。
- **凭据管理**：连接信息只保留在本地 `~/.ssh/config` 的 `qcl` 别名中，主机 IP、用户名、私钥路径**不写入本仓库任何文件**。
- **隔离要求**：CMAP 的部署目录、服务端口、数据库与 aiticket 的历史残留（若有）必须分离，避免相互影响。

## 待办（P4 前需确认）

- [ ] 服务器现有负载与资源余量（Temporal + PostgreSQL + MinIO 的开销）
- [ ] 历史遗留服务与端口占用情况，确认无冲突
- [ ] 备份与快照策略（任务账本与 Artifact 属关键数据）
- [ ] TLS 证书方案（mTLS 双向认证的 CA 归属）
