/**
 * 审批闸口真实链路：Workflow 暂停 → REST API 决策 → Codex 才执行。
 *
 * 前置：npm run start:worker 与 npm run start:api 都在运行。
 */
process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'
process.env['grpc_proxy'] = ''

const { PgStore } = await import('#domain-model')
const { Client, Connection } = await import('@temporalio/client')

const connectionString =
  process.env['CMAP_DATABASE_URL'] ?? 'postgres://temporal:temporal@localhost:5433/cmap'
const schema = process.env['CMAP_DB_SCHEMA'] ?? 'public'
const address = process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233'
const namespace = process.env['TEMPORAL_NAMESPACE'] ?? 'default'
const taskQueue = process.env['TEMPORAL_TASK_QUEUE'] ?? 'cmap-main'
const api = `http://127.0.0.1:${process.env['CMAP_API_PORT'] ?? 8787}`

const ok = (message) => console.log(`  ✓ ${message}`)
const fail = (message) => {
  console.error(`  ✗ ${message}`)
  process.exit(1)
}
const waitUntil = async (read, label) => {
  const deadline = Date.now() + 30_000
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (Date.now() > deadline) fail(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

const store = new PgStore({ connectionString, schema })
await store.migrate()
const missionId = `mis-approval-e2e-${Date.now().toString(36)}`
const now = new Date().toISOString()

await store.createMission({
  mission: {
    id: missionId,
    tenant: process.env['CMAP_TENANT'] ?? 'team-ycc',
    owner: 'crosswarm',
    type: 'inspect',
    goal:
      '在当前工作目录下创建 sample/ 并写入 3 个文本文件；统计文件数量，' +
      '把结果写入 evidence/report.json。',
    constraints: { risk_level: 'controlled' },
    acceptance: [
      {
        criterion_id: 'FILE-COUNT', metric: 'sample_file_count',
        operator: 'eq', expected: 3, hard_gate: true,
      },
    ],
    workflow_template: 'inspect/v1',
    state: 'DRAFT', revision: 1, created_at: now, updated_at: now,
  },
  actor: { type: 'system', id: 'e2e-approval' },
})
ok(`Mission ${missionId} 已创建，风险 controlled`)

const connection = await Connection.connect({ address, connectTimeout: 15_000 })
const client = new Client({ connection, namespace })
const handle = await client.workflow.start('missionWorkflow', {
  taskQueue,
  workflowId: `e2e-${missionId}`,
  args: [{ missionId }],
})

const approval = await waitUntil(async () => {
  const response = await fetch(`${api}/v1/approvals`)
  if (!response.ok) fail(`审批 API 不可用：HTTP ${response.status}`)
  const body = await response.json()
  return body.items.find((item) => item.mission_id === missionId) ?? null
}, '待审批记录出现')

const taskBefore = await store.getTask(approval.task_id)
if (taskBefore?.state !== 'APPROVAL_REQUIRED') fail(`任务未暂停：${taskBefore?.state}`)
if (taskBefore.binding !== null) fail('批准前已经调用 Adapter，审批闸口失效')
if ((await store.getMission(missionId))?.state !== 'AWAITING_APPROVAL') {
  fail('Mission 未进入 AWAITING_APPROVAL')
}
ok('批准前任务已暂停，binding 为空，Codex 尚未启动')

const wrong = await fetch(`${api}/v1/approvals/${encodeURIComponent(approval.id)}/decision`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    decision: 'approved', scope: 'mutating', decided_by: 'user:e2e-human',
  }),
})
if (wrong.status !== 409) fail(`错 scope 应返回 409，实际 ${wrong.status}`)
if ((await store.getTask(approval.task_id))?.binding !== null) fail('错 scope 竟然放行了任务')
ok('错 scope 返回 409，任务仍未派发')

const approved = await fetch(`${api}/v1/approvals/${encodeURIComponent(approval.id)}/decision`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    decision: 'approved', scope: 'controlled', decided_by: 'user:e2e-human',
  }),
})
if (!approved.ok) fail(`正确批准失败：HTTP ${approved.status} ${await approved.text()}`)
ok('对应 scope 已由真人身份批准')

const result = await handle.result()
if (result.state !== 'COMPLETED') fail(`批准后 Mission 未完成：${result.state}`)
const taskAfter = await store.getTask(approval.task_id)
if (!taskAfter?.binding) fail('批准后仍没有 binding，Adapter 没被调用')
if (taskAfter.state !== 'COMPLETED') fail(`批准后任务状态 ${taskAfter.state}`)

const events = (await store.listEvents(missionId)).map((event) => event.event_type)
for (const required of ['APPROVAL_REQUESTED', 'APPROVAL_GRANTED', 'TASK_STARTED', 'MISSION_COMPLETED']) {
  if (!events.includes(required)) fail(`事件流缺少 ${required}`)
}
ok(`批准后 Codex 真执行并完成：${taskAfter.binding.remote_task_id}`)
ok(`审批事件可审计：${events.join(' → ')}`)

console.log('\n✅ 审批闸口真实链路通过：没批不执行，批错不执行，批对才执行。')
await connection.close()
await store.close()
