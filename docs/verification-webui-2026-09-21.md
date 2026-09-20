# 本机 WebUI 与审批辅助验证 · 2026-09-21

## 交付范围

本机 React/Vite 工作台已接入 Mission 创建、验收、证据、返工、双 scope 审批、
资源列表及 Jev 建议；由 API 同源托管。不是跨主机、多用户或完整 DAG 系统。

主要文件：`apps/web/`、`apps/control-plane-api/src/{server,main,approval-advice}.ts`、
`schemas/{control-plane-context,mission-event,task-result}.v1.schema.json`、
`schemas/webui-http.openapi.json`、`packages/domain-model/src/criterion-check.ts`、
`workflows/activities.ts`；配套 API、领域、Workflow、前端纯逻辑测试及合成数据脚本。
依赖仅使用设计约定的 React/Vite 与类型包，没有额外路由、UI 或状态管理库。

## 验证结果

- `npm run check`：类型检查通过；211 基础、55 API、50 Workflow，共 316 项通过。
- `npm run test:pg`：66 项通过；合计 382 项。
- `npm run build:web`：通过；JS 259.20kB，gzip 80.88kB；CSS 19.27kB。
- `node scripts/verify-temporal.mjs`：连接、服务版本、namespace 与 Workflow 查询通过。
- 本轮真实 Mission 的 71 个 Temporal 历史事件重放通过。
- 契约生成、diff 检查通过；没有保存原始 Agent 会话或 Workflow 历史到仓库。

### 真实浏览器 → API → PostgreSQL → Temporal → Codex

环境独立：schema `cmap_webui_20260921`，队列同名，工作目录
`/tmp/cmap-webui-20260921`，身份 `test-harness:webui`，API 仅监听 127.0.0.1:8788。

浏览器创建 Mission
`mis_f2199182760f8e47350c59c17dd1cf68eb48913bf90a25e308198b246c757bdf`。
首次 HTTP 实际已接收后，浏览器测试拦截器模拟丢失确认返回 503；UI 保留原键和输入，
“重试原请求”仍使用同一 request_id。结果为 COMPLETED，仅一个 Task、
一条 MISSION_CREATED；独立数出恰好 3 个文件，所有证据哈希复算一致。
拦截器在第二次请求后恢复，最终刷新页面显示实时连接和验收通过。

### 合成 UI / 审批验证

双 scope、资源等待、返工评审、证据预览用明确标注的合成 Mission；不是业务授权。
Jev 浏览器自动化先探索，再用 ego-browser 补可观察终态、键盘及窄屏验证：

- 证据预览同时做服务端与浏览器 SHA-256 校验。
- Jev 实际返回 `jev-1.13.0`、review、confidence 0.94，建议后两类审批仍 pending。
  自动化初次报告 done 时 UI 尚在判断中，等待真实结果后才认定通过。
  最终严格 schema 校验下复测 pending mutating 返回 review / can_continue=false、confidence 0.79；置信度并非授权。
- controlled 合成审批落账后，mutating 仍 pending、decided_by=null。
  双击工具第二次寻找按钮超时，随后查账确认仅一次处理，没有盲目重试。
- 对话框键盘循环、Escape 返回焦点、跳过导航不改变当前路由通过。
- 390px 视口页面 scrollWidth=390，无页面横向溢出。
- 截图保存在本机 `/tmp/cmap-webui-{final-desktop,mobile,evidence,dual}.png`，不入库。

## 本轮发现并修复的问题

原验收信任 Agent 自报 passed，未独立比较 actual 与 expected。现在共享纯函数
覆盖 8 个运算符、有限数值、类型与结构比较；原 passed 必须为 true 且重算通过。
缺失/非法实际值不能通过 neq。入库、评审、旧结果复核与 UI 使用相同判定，
避免后端和展示分歧。新增失败测试确认原因后实现，Workflow 回归及真实链路通过。

其他保护包括证据文件归属/越界/符号链接/2MiB 限制，审批建议输出校验，
DRAFT 恢复启动身份检查和固定 Workflow ID，以及 API 请求超时可恢复提示。

## 两层审批结论

Codex 工具层当前 approval_policy=never，重复询问来自调用流程；已授权可逆工作
直接继续，有语义判断时使用独立 Jev CLI，没有改宿主 hook 或绕过工具拒绝。
CMAP 业务层通过详情页调用独立 Jev 子进程；模型建议不写批准，controlled/mutating
分别处理。若要消耗委托预授权，仍需可信控制面的授权契约和身份验证。

## 剩余项与实际阻断

- OIDC、远程 runner、mTLS、多人权限仍未实现；服务仅限本机。
- DAG Planner、Kimi/YonWork Adapter 和能力路由仍未实现。
- Kimi 2.0.1 官方工具 allowlist 不等于 OS 隔离；独立 sandbox 写入边界已验证，
  网络域名限制没有得到有效证明（拒绝域仍返回 HTTP 200），不据此宣称 Adapter 安全可交付。
- YonWork CLI 1.0.0 可发现；Host/Gateway/registry/routes 均 exit 7、host-runtime-not-running，
  未发送消息或启动业务应用，不能称真实验证已通过。
- SSE 当前每秒扫描历史，适用于本机规模；扩大前改持久游标。资源健康缺证据时显示未知。
- 本轮本地提交，不推送、不部署生产；测试环境 API/Worker 留作本机预览。
