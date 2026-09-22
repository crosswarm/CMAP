# 评审后继输入交付

新 review application 将 `required_followups` 的 `task_type`、`parameters` 和产物引用交给后继 Task。Codex/Kimi 共用的提示词将类型和参数作为数据展示；这些字段不能授予权限或改写风险、路由和审批。

## 回执与恢复

`review-application/v1` 的新回执携带 `followup_format: 2` 和有序 `followup_inputs`。每个描述符只包含产物 ID、生产任务、角色、SHA256 和目标相对路径。格式和矩阵参与请求哈希，intent 与 complete 必须一致。

intent 写入前解析元数据；重试通过冻结的矩阵恢复缺失子任务，不依赖产物此时仍然可用。真正派发时重新检查当前可用性。没有新格式字段的历史回执维持原哈希和原子任务内容，不追溯升级。旧强制升级回执重复恢复只在历史 Review、分支事件和终态证明一致时接受。

## 派发边界

1. 先完成 Runner 准入和现有审批校验。
2. 仅接收同 Mission、tenant、owner 的 AVAILABLE 产物；要求公开或内部分类、明确不含秘密和 PII、无角色限制，拒绝标记为 unassessed 的内容。生产任务结果必须包含唯一匹配的产物证明。
3. 复算源文件哈希，将字节原子发布到 `inputs/review/<sha256(artifact_id)>/payload`。产物 ID 和角色是普通字符串，不作为文件路径片段。复用 DAG 的文件校验和发布函数。
4. 声明工作区隔离的 Adapter 才能接收文件。写入 binding 后不再复制；`beforeSend` 只读复核 registry 和目标副本，包含路径组件的符号链接检查。
5. 确定性的非法输入通过现有准入回执记录 `INPUT_INVALID`，不调用外部 Agent。I/O 暂时性错误保留重试语义。

这只支持本机 Runner 的受限输入交付。远程文件传输、实际角色 ACL 和受限/未评估内容共享尚未实现。Jev 建议不代替授权。

历史 Artifact 的 `contains_secrets:false` / `contains_pii:false` 是原有本机策略默认值，不是内容评估证据。
复制时还会对实际源字节执行[已知凭据模式检查](evidence-credential-guard.md)；未命中不证明内容不含秘密或 PII。

## 验证入口

```sh
npm run check
npm run test:pg
node scripts/e2e-mission-followups.mjs --inputs
```

真实脚本创建独立 Pg schema、Temporal 队列和工作区。只有 reviewer 的两分支决定是合成夹具，三个任务由真实 Codex 执行。源 nonce 只写入源工作区，后继必须从输入副本读出；还核对独立随机任务类型、参数、`[0,false,null]`、文件数量、哈希、父子关系及历史重放。
