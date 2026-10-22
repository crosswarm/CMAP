/**
 * 审批闸口合成测试：真实 dag/v1 Workflow 暂停 → REST API 测试决策 → Codex 才执行。
 * 只证明技术闸口，不代表真人批准或身份认证；应在隔离测试 schema 与队列运行。
 *
 * Mission 走与 POST /v1/missions 相同的提交逻辑（missionFromRequest）：不带 plan → 合成单节点计划 → dag/v1，
 * workflowId 为 mission-<missionId>（API 的 approvalDecided 信号按此 ID 投递）。
 * 先批准一个 Mission（含错 scope、决定到执行的间隔、decided_by），再拒绝另一个 Mission（拒绝后永不派发）。
 *
 * 设置 CMAP_DELEGATION_POLICY_FILE（与 Worker 同值）时，另断言每个审批都有 JEV_DECIDED 影子记录：
 * route=human，审批终态仍由本脚本的真人身份做出。
 *
 * 前置：npm run start:worker 与 npm run start:api 都在运行（相同 schema / 队列 / owner=crosswarm）。
 */
process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'
process.env['grpc_proxy'] = ''

const { PgStore } = await import('#domain-model')
const { Client, Connection } = await import('@temporalio/client')
const { missionFromRequest } = await import('../apps/control-plane-api/src/mission-submission.ts')
const { workflowTypeForTemplate } = await import('../apps/control-plane-api/src/workflow-routing.ts')

const connectionString =
  process.env['CMAP_DATABASE_URL'] ?? 'postgres://temporal:temporal@localhost:5433/cmap'
const schema = process.env['CMAP_DB_SCHEMA'] ?? 'public'
const address = process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233'
const namespace = process.env['TEMPORAL_NAMESPACE'] ?? 'default'
const taskQueue = process.env['TEMPORAL_TASK_QUEUE'] ?? 'cmap-main'
const tenant = process.env['CMAP_TENANT'] ?? 'team-ycc'
const api = `http://127.0.0.1:${process.env['CMAP_API_PORT'] ?? 8787}`
const expectJev = Boolean(process.env['CMAP_DELEGATION_POLICY_FILE'])
// 信号接线后决定到任务开始只需数秒；无信号时要等 10 分钟超时回读。
const MAX_RESUME_MS = 60_000

const ok = (message) => console.log(`  ✓ ${message}`)
const fail = (message) => {
  console.error(`  ✗ ${message}`)
  process.exit(1)
}
const waitUntil = async (read, label, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (Date.now() > deadline) fail(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

const store = new PgStore({ connectionString, schema })
await store.migrate()
const connection = await Connection.connect({ address, connectTimeout: 15_000 })
const client = new Client({ connection, namespace })

// API 只接受 decided_by 等于其 CMAP_OWNER；从 /v1/context 取，避免脚本与 API 配置漂移。
const { owner: apiOwner } = await (await fetch(`${api}/v1/context`)).json()
if (!apiOwner) fail('API 未配置 owner，无法决策审批')

const decide = (approvalId, body) =>
  fetch(`${api}/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, decided_by: apiOwner }),
  })

const jevEvents = async (missionId) =>
  (await store.listEvents(missionId)).filter((event) => event.event_type === 'JEV_DECIDED')

/** 与 API 同一提交逻辑建 Mission、启动 dag/v1 Workflow，等到审批出现并确认任务已暂停。 */
const startGatedMission = async (label) => {
  const mission = missionFromRequest({
    request_id: `e2e-approval-${label}-${Date.now().toString(36)}`,
    goal:
      '在当前工作目录下创建 sample/ 并写入 3 个文本文件；统计文件数量，' +
      '把结果写入 evidence/report.json。',
    risk_level: 'controlled',
    acceptance: [
      {
        criterion_id: 'FILE-COUNT', metric: 'sample_file_count',
        operator: 'eq', expected: 3, hard_gate: true,
      },
    ],
  }, tenant, 'crosswarm')
  if (mission.workflow_template !== 'dag/v1') fail(`Mission 应走 dag/v1，实际 ${mission.workflow_template}`)
  const missionId = mission.id
  await store.createMission({ mission, actor: { type: 'system', id: 'e2e-approval' } })
  ok(`[${label}] Mission ${missionId} 已创建，风险 controlled，模板 dag/v1`)

  const handle = await client.workflow.start(workflowTypeForTemplate(mission.workflow_template), {
    taskQueue,
    workflowId: `mission-${missionId}`,
    args: [{ missionId }],
  })

  const approval = await waitUntil(async () => {
    const response = await fetch(`${api}/v1/approvals`)
    if (!response.ok) fail(`审批 API 不可用：HTTP ${response.status}`)
    const body = await response.json()
    return body.items.find((item) => item.mission_id === missionId) ?? null
  }, '待审批记录出现')

  // 审批记录先于任务转入 APPROVAL_REQUIRED 落账，等转移完成再断言。
  const taskBefore = await waitUntil(async () => {
    const task = await store.getTask(approval.task_id)
    return task?.state === 'APPROVAL_REQUIRED' ? task : null
  }, '任务进入 APPROVAL_REQUIRED')
  if (taskBefore.binding !== null) fail('批准前已经调用 Adapter，审批闸口失效')
  if ((await store.getMission(missionId))?.state !== 'RUNNING') fail('dag/v1 等审批期间 Mission 应为 RUNNING')
  ok(`[${label}] 批准前任务已暂停，binding 为空，Codex 尚未启动`)

  // 影子记录在审批首次进入等待时写入；先等它落账，再由真人身份决定，证明决定与 Jev 无关。
  if (expectJev) {
    await waitUntil(async () => ((await jevEvents(missionId)).length > 0 ? true : null), 'JEV_DECIDED 落账', 60_000)
  }
  return { missionId, approval, handle }
}

const jevRecords = []
const assertJevShadow = async (label, missionId, approval) => {
  if (!expectJev) return
  const events = await jevEvents(missionId)
  if (events.length !== 1) fail(`[${label}] 应恰有 1 条 JEV_DECIDED，实际 ${events.length}`)
  const [event] = events
  const record = event.payload
  if (event.idempotency_key !== `jev-decided:${approval.id}`) fail(`[${label}] JEV_DECIDED 幂等键不符：${event.idempotency_key}`)
  if (record.subject?.approval_id !== approval.id || record.subject?.approval_scope !== 'controlled') {
    fail(`[${label}] JEV_DECIDED 未对应本审批：${JSON.stringify(record.subject)}`)
  }
  if (record.route !== 'human' || record.mode !== 'shadow') {
    fail(`[${label}] 影子记录必须 route=human、mode=shadow：${record.route}/${record.mode}`)
  }
  if (!['shadow_mode', 'jev_unavailable', 'jev_invalid_output'].includes(record.reason_code)) {
    fail(`[${label}] 影子记录 reason_code 异常：${record.reason_code}`)
  }
  const after = await store.getApproval(approval.id)
  if (after?.decided_by !== apiOwner || String(after.decided_by).startsWith('jev:')) {
    fail(`[${label}] 审批决定必须由真人身份做出，实际 ${after?.decided_by}`)
  }
  jevRecords.push({
    label, approval_id: approval.id, model: record.model, route: record.route, reason_code: record.reason_code,
    outcome: record.outcome, assessed_risk: record.assessed_risk, effective_risk: record.effective_risk,
    confidence: record.confidence, elapsed_ms: record.elapsed_ms, actor: event.actor.id,
  })
  ok(`[${label}] JEV_DECIDED：model=${record.model} route=${record.route} reason_code=${record.reason_code}，审批人 ${after.decided_by}`)
}

// ------------------------------------------------------ 1. 批准路径

console.log('\n[1] 批准路径')
const { missionId, approval, handle } = await startGatedMission('approve')

const wrong = await decide(approval.id, { decision: 'approved', scope: 'mutating' })
if (wrong.status !== 409) fail(`错 scope 应返回 409，实际 ${wrong.status}`)
if ((await store.getTask(approval.task_id))?.binding !== null) fail('错 scope 竟然放行了任务')
if ((await store.getApproval(approval.id))?.decision !== 'pending') fail('错 scope 改变了审批状态')
ok('错 scope 返回 409，审批仍待决，任务仍未派发')

const decidedAt = Date.now()
const approved = await decide(approval.id, { decision: 'approved', scope: 'controlled' })
if (!approved.ok) fail(`正确批准失败：HTTP ${approved.status} ${await approved.text()}`)
ok('对应 scope 已由合成测试决策放行（不代表真人授权）')

// 审批信号接线：决定后 Workflow 应被 approvalDecided 唤醒并开始执行，而不是等 10 分钟超时回读。
const started = await waitUntil(async () => {
  const task = await store.getTask(approval.task_id)
  return task?.binding ? task : null
}, '批准后任务开始执行（Adapter 已绑定）', MAX_RESUME_MS)
const resumeMs = Date.now() - decidedAt
ok(`批准后 ${resumeMs}ms 内 Adapter 已绑定、任务进入 ${started.state}，远小于 10 分钟回读超时`)

const result = await handle.result()
if (result.state !== 'COMPLETED') fail(`批准后 Mission 未完成：${result.state}`)
const taskAfter = await store.getTask(approval.task_id)
if (!taskAfter?.binding) fail('批准后仍没有 binding，Adapter 没被调用')
if (taskAfter.state !== 'COMPLETED') fail(`批准后任务状态 ${taskAfter.state}`)

const approvalAfter = await store.getApproval(approval.id)
if (approvalAfter?.decision !== 'approved') fail(`审批终态应为 approved，实际 ${approvalAfter?.decision}`)
if (approvalAfter.decided_by !== apiOwner) fail(`decided_by 应等于 API owner ${apiOwner}，实际 ${approvalAfter.decided_by}`)
ok(`审批人 decided_by = API owner（${apiOwner}）`)

const events = (await store.listEvents(missionId)).map((event) => event.event_type)
for (const required of ['APPROVAL_REQUESTED', 'APPROVAL_GRANTED', 'TASK_STARTED', 'MISSION_COMPLETED']) {
  if (!events.includes(required)) fail(`事件流缺少 ${required}`)
}
ok(`批准后 Codex 真执行并完成：${taskAfter.binding.remote_task_id}`)
ok(`审批事件可审计：${events.join(' → ')}`)
await assertJevShadow('approve', missionId, approval)

// ------------------------------------------------------ 2. 拒绝路径

console.log('\n[2] 拒绝路径')
const denied = await startGatedMission('reject')
const rejected = await decide(denied.approval.id, { decision: 'rejected', scope: 'controlled' })
if (!rejected.ok) fail(`拒绝失败：HTTP ${rejected.status} ${await rejected.text()}`)
ok('已拒绝（合成测试决策）')

const rejectedResult = await denied.handle.result()
if (rejectedResult.state === 'COMPLETED') fail('审批被拒后 Mission 不应完成')
const deniedTask = await store.getTask(denied.approval.task_id)
if (deniedTask?.binding !== null) fail('审批被拒后仍调用了 Adapter')
if (['RUNNING', 'COMPLETED'].includes(deniedTask?.state)) fail(`审批被拒后任务状态 ${deniedTask.state}`)
const deniedApproval = await store.getApproval(denied.approval.id)
if (deniedApproval?.decision !== 'rejected' || deniedApproval.decided_by !== apiOwner) {
  fail(`拒绝终态应为 rejected/${apiOwner}，实际 ${deniedApproval?.decision}/${deniedApproval?.decided_by}`)
}
const deniedEvents = (await store.listEvents(denied.missionId)).map((event) => event.event_type)
if (!deniedEvents.includes('APPROVAL_DENIED')) fail('事件流缺少 APPROVAL_DENIED')
if (deniedEvents.includes('TASK_STARTED') || deniedEvents.includes('APPROVAL_GRANTED')) {
  fail('拒绝后事件流不应出现 TASK_STARTED / APPROVAL_GRANTED')
}
ok(`拒绝后 Mission ${rejectedResult.state}，binding 为空，Adapter 从未调用`)
ok(`拒绝事件可审计：${deniedEvents.join(' → ')}`)
await assertJevShadow('reject', denied.missionId, denied.approval)

if (expectJev) console.log(`\nJEV_DECIDED 记录：${JSON.stringify(jevRecords)}`)
console.log('\n✅ 审批闸口真实链路通过：没批不执行，批错不执行，批对才执行，拒绝不执行。')
await connection.close()
await store.close()
