# CMAP

本仓库的 Agent 约束统一维护在 **[AGENTS.md](AGENTS.md)**，Claude 与 Codex 共用同一份，避免两边规则漂移。

请先读 `AGENTS.md`，其中包含核心原则、项目速查、安全边界、验证矩阵、SDD+TDD 流程与完成标准。

需要更深的背景时再按需读取：

- `docs/architecture.md` — 架构与契约体系
- `docs/threat-model.md` — 威胁模型与安全控制
- `docs/adr/` — 关键取舍的理由
- `infra/docker-compose/README.md` — 本地栈与三个代理陷阱
