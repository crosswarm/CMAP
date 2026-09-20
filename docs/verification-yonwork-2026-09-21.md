# YonWork Host 入口验证 · 2026-09-21

## 当前结果

YonWork 应用 1.0.9、CLI 1.0.0 可用。后台启动现有应用后，界面从初始化页进入主页面。
CMAP 只读诊断最终观测到 Host running、Gateway reachable、Skill registry reported。
这些是传输层观察，不能证明云端账号权限、聊天完成或业务 Agent 任务已通过。

## 根因与修复范围

安装包 CLI 的候选运行目录仍是旧品牌 yonclaw；当前应用实际在 YonWork 目录生成
host-api-runtime.json。因此进程已运行时，默认 CLI 仍可能退出 7。
通过 CLI 支持的 YONCLAW_USER_DATA_DIR 指向当前目录后，Host routes/status 返回成功。
启动早期 Gateway/registry 曾超时，随后真实探测响应成功；不能把最初超时归因到模型。

新增 `scripts/probe-yonwork.mjs`，复用已安装的 yonwork-cli-adapter.mjs：

```bash
npm run probe:yonwork
node scripts/probe-yonwork.mjs --cli /Applications/YonWork.app/Contents/Resources/cli/yonworkctl
# 跨主机可显式提供已安装 bridge 与运行目录
node scripts/probe-yonwork.mjs --bridge /path/to/yonwork-cli-adapter.mjs --user-data-dir /path/to/user-data
```

目录优先级：显式参数 → 既有环境变量 → macOS 当前 YonWork 运行文件 → 旧品牌 → 平台默认。
只检查文件元数据，不读取运行文件内容或令牌。选定入口后不因 Host 错误切换账号/目录。
Host URL/Token 覆盖仍保持 bridge 的拒绝策略。输出只包含枚举状态、版本、退出码和哈希，
由 `schemas/yonwork-probe.v1.schema.json` 在运行时校验；不转发原始 stdout/stderr。
CLI/Gateway 接口名仍按当前 bridge 协商，不硬编码业务 API。

## 证据

- 默认 CLI/bridge：exit 7、host-runtime-not-running；同时原生 UI 显示应用已运行。
- 当前目录 bridge：Host routes/status exit 0；早期 Gateway/registry timeout。
- 新入口最终真跑：runtime_source=yonwork，cli_version=1.0.0，Host running、
  Gateway reachable、registry reported，四项观察退出码均为 0。
- `npm run check`：类型检查及 252 基础、55 API、63 Workflow，共 370 项通过。
- 8 项针对性测试覆盖目录优先级、缺 HOME、无效参数、非法 JSON、字段内敏感哨兵、
  负退出码和 Host API 覆盖拒绝；确实先出现行为失败再修复。
- 不复制/修改安装包 CLI、用户运行目录、账号配置或凭据。未执行 chat send、审批、清除历史。
- 当前应用保留后台运行以供后续接入验证；没有宣称 YonWork Adapter 已交付。

## 剩余项目边界

本报告记录的是 YonWork 传输探测；其后的显式 DAG 实现与真实验证见
[DAG 验证](verification-dag-2026-09-21.md)。P4 的既有部署目标见 ADR-0002（qcl）；
本轮只读 SSH 资源探测及禁用复用的独立连接探测均超时，因此没有新增服务器可用性/部署结论。身份提供方和 CA
归属仍需真实配置，不能用本机账号显示或模型置信度代替。
