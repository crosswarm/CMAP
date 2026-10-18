/**
 * S5 多任务衔接 / 协作 / 交接 / 续接的真实链路验证。
 *
 * 真实 PostgreSQL（独立 schema）+ 真实 Temporal + 真实 Codex + 真实 Memross（127.0.0.1:19092）。
 * 控制面 API 在本进程内用 createControlPlane 拉起（与 apps/control-plane-api 同一套路由），
 * Worker 由本脚本以子进程拉起（与 npm run start:worker 同一入口），独占一个任务队列。
 * 判据只认账本状态、事件、Codex 执行次数（TASK_STARTED / 进程组）与哈希，不认退出码。
 *
 *   C2 返工续接：第 1 轮必然不过，第 2 轮拿到上一轮失败标准、上一轮报告与首轮记忆快照并通过
 *   C7 知识闭环：C2 通过后结论进入 Memross propose，候选落到 Memross intake
 *   C4 续作：continues_mission_id 指向 C2，新 Mission 首任务带原证据完成
 *   C8 升级交接：一轮即升级，Memross handoff latest 读到这条交接
 *   C9 取消：DAG 中运行的节点收到 Adapter cancel，等审批的未绑定任务被取消，原因有记录
 *
 * 用法：TMPDIR=/private/tmp node scripts/e2e-continuity.mjs [--only c2,c7,c4,c8,c9]
 * 前置：本地栈就绪（node scripts/verify-temporal.mjs）、Memross 运行中、
 *       ~/.config/memross/memory-cmap-worker.token 存在（或设置 MEMROSS_TOKEN）。令牌不回显。
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'
process.env['grpc_proxy'] = ''

const { PgStore } = await import('#domain-model')
const { Client, Connection } = await import('@temporalio/client')
const { createControlPlane } = await import('../apps/control-plane-api/src/server.ts')
const { workflowTypeForTemplate } = await import('../apps/control-plane-api/src/workflow-routing.ts')

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const stamp = Date.now().toString(36)
const schema = process.env['CMAP_DB_SCHEMA'] ?? `e2e_s5_${stamp}`
const taskQueue = `cmap-e2e-s5-${stamp}`
const workRoot = process.env['CMAP_WORK_ROOT'] ?? join(repoRoot, '.cmap-work')
const memrossUrl = process.env['MEMROSS_URL'] ?? 'http://127.0.0.1:19092'
const memrossToken = (process.env['MEMROSS_TOKEN'] ?? await readFile(join(homedir(), '.config/memross/memory-cmap-worker.token'), 'utf8')).trim()
const memrossData = process.env['MEMROSS_DATA'] ?? join(homedir(), 'Studio/Memross/data')
const project = process.env['E2E_MEMORY_PROJECT'] ?? 'prj_github_com_crosswarm_cmap'
const only = (process.argv[process.argv.indexOf('--only') + 1] ?? '').split(',').filter(Boolean)
const want = (c) => process.argv.indexOf('--only') < 0 || only.includes(c)
const connectionString = process.env['CMAP_DATABASE_URL'] ?? 'postgres://temporal:temporal@localhost:5433/cmap'

const ok = (m) => console.log(`  ✓ ${m}`)
const step = (m) => console.log(`\n[${m}]`)
const workers = []
const fail = (m) => { console.error(`  ✗ ${m}`); for (const w of workers) { try { w.kill('SIGKILL') } catch {} } process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (b) => createHash('sha256').update(b).digest('hex')
const waitFor = async (read, ms, what) => {
  const deadline = Date.now() + ms
  for (;;) { const v = await read(); if (v) return v; if (Date.now() > deadline) fail(`等待超时：${what}`); await sleep(500) }
}

// ---------------------------------------------------------------- 基础设施

const store = new PgStore({ connectionString, schema })
await store.migrate()
const connection = await Connection.connect({ address: process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233', connectTimeout: 15_000 })
const client = new Client({ connection, namespace: process.env['TEMPORAL_NAMESPACE'] ?? 'default' })

const worker = spawn(process.execPath, ['apps/worker/src/main.ts'], {
  cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env, TMPDIR: process.env['TMPDIR'] ?? '/private/tmp',
    CMAP_DB_SCHEMA: schema, TEMPORAL_TASK_QUEUE: taskQueue, CMAP_WORK_ROOT: workRoot,
    MEMROSS_URL: memrossUrl, MEMROSS_TOKEN: memrossToken,
    RUNNER_ID: 'e2e-s5', RUNNER_TENANT: 'team-ycc', RUNNER_ALLOWED_TENANTS: 'team-ycc', RUNNER_ALLOWED_OWNERS: 'crosswarm',
    RUNNER_ALLOWED_CAPABILITIES: 'code.analyze', RUNNER_MAX_RISK: 'controlled',
  },
})
workers.push(worker)
process.on('exit', () => { try { worker.kill('SIGKILL') } catch {} })
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Worker 60 秒内未就绪')), 60_000)
  worker.stdout.on('data', (c) => { if (c.toString().includes('Worker 就绪')) { clearTimeout(timer); resolve() } })
  worker.stderr.resume()
  worker.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Worker 提前退出 code=${code}`)) })
}).catch((e) => fail(String(e)))
ok(`Worker 就绪：schema=${schema} queue=${taskQueue}`)

const api = await createControlPlane({
  store, tenant: 'team-ycc', owner: 'crosswarm', workRoot,
  startMission: async (missionId, workflowId) => {
    const mission = await store.getMission(missionId)
    await client.workflow.start(workflowTypeForTemplate(mission.workflow_template), {
      workflowId, taskQueue, args: [{ missionId }], workflowIdReusePolicy: 'REJECT_DUPLICATE', workflowIdConflictPolicy: 'USE_EXISTING',
    })
  },
  cancelMission: async (_missionId, workflowId, reason) => client.workflow.getHandle(workflowId).signal('cancelMission', { reason }),
})
await api.listen(0)
const base = `http://127.0.0.1:${api.address().port}`
const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}
const memross = async (op, body) => {
  const res = await fetch(`${memrossUrl}/api/memory/v1/${op}`, {
    method: 'POST', headers: { authorization: `Bearer ${memrossToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return res.json()
}

const createMission = async (request) => {
  const res = await post('/v1/missions', { request_id: `s5-${stamp}-${request.tag}`, risk_level: 'read-meta', ...request, tag: undefined })
  if (res.status !== 202) fail(`创建 Mission 失败：${res.status} ${JSON.stringify(res.body)}`)
  return res.body
}
const finish = async (created, ms = 900_000) => {
  let timer
  try {
    return await Promise.race([
      client.workflow.getHandle(created.workflow_id).result(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${ms / 1000}s 内未观测到终态：${created.workflow_id}`)), ms) }),
    ])
  } catch (error) { fail(String(error)) } finally { clearTimeout(timer) }
}
const events = async (missionId) => store.listEvents(missionId)
const fileSha = async (taskId, uri) => sha(await readFile(isAbsolute(uri) ? uri : join(workRoot, taskId, uri)))
const report = async (taskId) => {
  const a = (await store.listArtifacts(taskId)).find((x) => x.role === 'report')
  if (!a) fail(`任务 ${taskId} 没有 report`)
  if (await fileSha(taskId, a.uri) !== a.sha256.toLowerCase()) fail(`任务 ${taskId} report 哈希复算不一致`)
  return { artifact: a, json: JSON.parse(await readFile(isAbsolute(a.uri) ? a.uri : join(workRoot, taskId, a.uri), 'utf8')) }
}
const started = (kinds) => kinds.filter((k) => k === 'TASK_STARTED').length

let c2 // C4/C7 依赖 C2 的结果

// ---------------------------------------------------------------- C2

if (want('c2') || want('c7') || want('c4')) {
  step('C2 返工续接：第 2 轮拿到上一轮失败标准、上一轮报告与首轮记忆快照并通过')
  const created = await createMission({
    tag: 'c2', max_additional_cycles: 1,
    memory: { project_id: project, query: 'CMAP 返工 review input 记忆快照', limit: 2 },
    goal: '把结论写进 evidence/report.json（JSON 对象）。先检查本任务提示词里有没有「上一轮未通过」一节：' +
      '没有这一节时，attempt_kind 写 "first"，其他字段都写 null；' +
      '有这一节时，attempt_kind 写 "rework"，并在「输入证据」里找 role=report 且带 source_task_id 的条目，' +
      '读取工作区中该条目 uri 指向的文件，计算其 sha256 写入 previous_report_sha256；' +
      '再找 role=memory_context 的条目，读取文件顶部 JSON 清单，把 items 第一条的 block_id 写入 memory_block_id（没有条目写 null）。' +
      '回应验收标准时 actual 只写 attempt_kind 的值本身（如 rework）。' +
      '另外在输出的 findings 里给出一条 severity 为 low 的结论：code 为 REWORK_CONTEXT，description 说明返工任务应先读取上一轮失败标准与产物再动手。',
    acceptance: [{ criterion_id: 'ATTEMPT-KIND', metric: 'attempt_kind', operator: 'eq', expected: 'rework', hard_gate: true }],
  })
  const result = await finish(created)
  if (result.state !== 'COMPLETED') fail(`C2 Mission 应 COMPLETED，实际 ${result.state}（${result.summary}）`)
  if (result.taskIds.length !== 2) fail(`C2 应恰好 2 轮，实际 ${result.taskIds.length}`)
  const [firstId, secondId] = result.taskIds
  const first = await store.getTask(firstId), second = await store.getTask(secondId)
  const firstReport = await report(firstId)
  if (firstReport.json.attempt_kind !== 'first') fail(`第 1 轮应写 first，实际 ${firstReport.json.attempt_kind}`)
  const prev = second.envelope.inputs?.previous_attempt
  if (prev?.supersedes_task_id !== firstId || second.supersedes_task_id !== firstId) fail('第 2 轮 previous_attempt / supersedes 未指向第 1 轮')
  if (!prev.failed_criteria.some((c) => c.criterion_id === 'ATTEMPT-KIND')) fail('第 2 轮没有拿到上一轮失败标准')
  ok(`第 2 轮 ${secondId} supersedes ${firstId}，失败标准 ${prev.failed_criteria.map((c) => c.criterion_id).join(',')}`)
  const refs = second.envelope.inputs.artifact_refs
  const reportRef = refs.find((r) => r.role === 'report' && r.source_task_id === firstId)
  if (reportRef?.sha256 !== firstReport.artifact.sha256.toLowerCase()) fail('第 2 轮 report review input 与第 1 轮报告散列不一致')
  if (await fileSha(secondId, reportRef.uri) !== reportRef.sha256) fail('第 2 轮工作区里的上一轮报告副本散列不符')
  const memFirst = first.envelope.inputs.artifact_refs.find((r) => r.role === 'memory_context')
  const memSecond = refs.find((r) => r.role === 'memory_context')
  if (!memFirst || memSecond?.source_task_id !== firstId || memSecond.sha256 !== memFirst.sha256) fail('第 2 轮没有经 review input 拿到首轮记忆快照')
  if (await fileSha(secondId, memSecond.uri) !== memFirst.sha256) fail('第 2 轮工作区里的记忆快照副本散列不符')
  ok(`上一轮报告 ${reportRef.sha256.slice(0, 12)}… 与首轮记忆快照 ${memFirst.sha256.slice(0, 12)}… 均以 review input 交付，副本散列复核通过`)
  const secondReport = await report(secondId)
  if (secondReport.json.attempt_kind !== 'rework' || secondReport.json.previous_report_sha256 !== reportRef.sha256) {
    fail(`第 2 轮 Agent 未读到上一轮报告：attempt_kind=${secondReport.json.attempt_kind} previous=${secondReport.json.previous_report_sha256}`)
  }
  const snapshot = (await readFile(join(workRoot, firstId, memFirst.uri))).toString('utf8')
  const firstBlock = JSON.parse(snapshot.match(/```json\n([\s\S]*?)\n```/)[1]).items[0]?.block_id ?? null
  if (secondReport.json.memory_block_id !== firstBlock) fail(`第 2 轮 memory_block_id=${secondReport.json.memory_block_id}，首轮快照第一条 ${firstBlock}`)
  ok(`第 2 轮 Agent 读到上一轮报告散列与首轮快照块 ${firstBlock}`)
  const kinds = (await events(created.mission_id)).map((e) => e.event_type)
  if (started(kinds) !== 2) fail(`Codex 应执行 2 次，TASK_STARTED=${started(kinds)}`)
  ok(`账本：Mission COMPLETED，Codex 执行 2 次，事件 ${kinds.filter((k) => /REVIEW_|TASK_STARTED|MISSION_/.test(k)).join(' → ')}`)
  c2 = { created, result, secondId, secondReport }
}

// ---------------------------------------------------------------- C7

if (want('c7')) {
  step('C7 知识闭环：验收通过的结论进入 Memross propose / intake')
  const proposed = (await events(c2.created.mission_id)).filter((e) => e.event_type === 'KNOWLEDGE_PROPOSED' && e.task_id === c2.secondId)
  const failed = (await events(c2.created.mission_id)).filter((e) => e.event_type === 'KNOWLEDGE_PROPOSAL_FAILED')
  if (!proposed.length) fail(`没有 KNOWLEDGE_PROPOSED 事件（失败事件：${failed.map((e) => e.payload.code).join(',') || '无'}；Agent findings=${JSON.stringify(c2.secondReport && (await store.getTask(c2.secondId)).result.findings?.map((f) => f.severity))}）`)
  for (const e of proposed) {
    const id = e.payload.proposal_id
    if (!/^prop_[a-f0-9]{24}$/.test(id)) fail(`proposal_id 格式异常：${id}`)
    const record = JSON.parse(await readFile(join(memrossData, 'memory/proposals', `${id}.json`), 'utf8'))
    if (record.status !== 'candidate' || record.project_id !== project || record.actor_id !== 'cmap-worker@cross-mini') fail(`候选记录异常：${record.status} ${record.project_id} ${record.actor_id}`)
    if (!record.evidence.some((x) => x.uri.startsWith('cmap-artifact:'))) fail('候选缺少 cmap-artifact 证据')
    const intake = record.duplicate_of ? null : JSON.parse(await readFile(join(memrossData, 'maintenance/intake', `${id}.json`), 'utf8'))
    if (!record.duplicate_of && (intake.proposalId !== id || intake.kind !== 'memory_proposal')) fail('intake 记录与候选不符')
    ok(`${e.payload.kind} 候选 ${id}：status=${record.status} evidence=${record.evidence.map((x) => x.uri.split(':')[0]).join('+')}，${record.duplicate_of ? `重复于 ${record.duplicate_of}` : 'intake 已排队'}`)
  }
}

// ---------------------------------------------------------------- C4

if (want('c4')) {
  step('C4 续作：continues_mission_id 指向 C2，新 Mission 首任务带原证据完成')
  const sourceReport = (await store.listArtifacts(c2.secondId)).find((a) => a.role === 'report')
  const created = await createMission({
    tag: 'c4', max_additional_cycles: 0, continues_mission_id: c2.created.mission_id,
    goal: '这是续作任务。在「输入证据」里找 role=continuation_input 的条目（上一个 Mission 已验收的报告），' +
      '读取工作区中该条目 uri 指向的文件，计算其 sha256 写入 evidence/report.json 的 continued_report_sha256；' +
      '再找 role=handoff 的条目，读取该 JSON 文件，把其中 refs.mission_ids 的第一项写入 continued_mission_id。' +
      '两项都读到时 prior_evidence_seen 写 "yes"，否则写 "no"。',
    acceptance: [{ criterion_id: 'PRIOR-EVIDENCE', metric: 'prior_evidence_seen', operator: 'eq', expected: 'yes', hard_gate: true }],
  })
  const result = await finish(created)
  if (result.state !== 'COMPLETED') fail(`C4 Mission 应 COMPLETED，实际 ${result.state}（${result.summary}）`)
  const taskId = result.taskIds[0]
  const task = await store.getTask(taskId)
  const refs = task.envelope.inputs.artifact_refs
  const input = refs.filter((r) => r.role === 'continuation_input')
  if (input.length !== 1 || input[0].sha256 !== sourceReport.sha256.toLowerCase()) fail('续作输入与来源已验收报告散列不符')
  for (const r of refs) if (await fileSha(taskId, r.uri) !== r.sha256) fail(`续作输入 ${r.role} 副本散列不符`)
  if (!refs.some((r) => r.role === 'handoff') || !refs.some((r) => r.role === 'continuation_memory')) fail('续作缺少交接内容或记忆快照')
  const out = await report(taskId)
  if (out.json.continued_report_sha256 !== input[0].sha256 || out.json.continued_mission_id !== c2.created.mission_id) {
    fail(`Agent 未读到原证据：sha=${out.json.continued_report_sha256} mission=${out.json.continued_mission_id}`)
  }
  const kinds = (await events(created.mission_id)).map((e) => e.event_type)
  if (started(kinds) !== 1) fail(`Codex 应执行 1 次，TASK_STARTED=${started(kinds)}`)
  ok(`续作首任务 ${taskId} 带 ${refs.map((r) => r.role).join(',')} 完成；Agent 写出的来源报告散列 ${input[0].sha256.slice(0, 12)}… 与账本一致，Codex 执行 1 次`)
}

// ---------------------------------------------------------------- C8

if (want('c8')) {
  step('C8 升级交接：一轮即升级，Memross handoff latest 读到')
  const created = await createMission({
    tag: 'c8', max_additional_cycles: 0, memory: { project_id: project, limit: 1 },
    goal: '在 evidence/report.json 写入 {"answer": 1}。',
    acceptance: [{ criterion_id: 'IMPOSSIBLE', metric: 'answer', operator: 'lt', expected: -Number.MAX_VALUE, hard_gate: true }],
  })
  const result = await finish(created)
  if (result.state !== 'ESCALATED') fail(`C8 应 ESCALATED，实际 ${result.state}`)
  const recorded = (await events(created.mission_id)).filter((e) => e.event_type === 'HANDOFF_RECORDED')
  if (recorded.length !== 1) fail(`HANDOFF_RECORDED 应恰好 1 条，实际 ${recorded.length}`)
  const latest = await memross('handoff', { op: 'latest', scope: { project_id: project } })
  const h = latest.handoff
  if (h?.handoff_id !== recorded[0].payload.handoff_id) fail(`handoff latest=${h?.handoff_id}，账本记录 ${recorded[0].payload.handoff_id}`)
  if (!h.refs.mission_ids.includes(created.mission_id) || !h.failed_attempts.some((x) => x.includes('IMPOSSIBLE'))) fail('交接内容缺失 mission 引用或失败标准')
  if (!/binding=codex-adapter@e2e-s5/.test(h.state) || !/sha256=[a-f0-9]{64}/.test(h.verification)) fail('交接内容缺少绑定状态或证据散列')
  if (h.author !== 'cmap-worker@cross-mini') fail(`交接作者 ${h.author}`)
  ok(`handoff latest = ${h.handoff_id}（author ${h.author}），含失败标准、证据散列与绑定状态；Mission 仍为 ESCALATED`)
}

// ---------------------------------------------------------------- C9

if (want('c9')) {
  step('C9 取消：运行中的已绑定节点收到 cancel，等审批的未绑定任务被取消，原因有记录')
  const created = await createMission({
    tag: 'c9', risk_level: 'controlled', max_additional_cycles: 0,
    goal: 'S5 取消验证', acceptance: [
      { criterion_id: 'SLOW', metric: 'slow_done', operator: 'eq', expected: 'yes', hard_gate: true },
      { criterion_id: 'GATED', metric: 'gated_done', operator: 'eq', expected: 'yes', hard_gate: true },
    ],
    plan: { schema: 'cmap/mission-plan/v1', concurrency: 2, nodes: [
      { node_id: 'slow', goal: '先在终端执行 sleep 240，然后在 evidence/report.json 写入 {"slow_done": "yes"}。', capability: 'code.analyze', deps: [], criterion_ids: ['SLOW'], risk_level: 'read-meta' },
      { node_id: 'gated', goal: '在 evidence/report.json 写入 {"gated_done": "yes"}。', capability: 'code.analyze', deps: [], criterion_ids: ['GATED'], risk_level: 'controlled' },
    ] },
  })
  const missionId = created.mission_id
  const slow = await waitFor(async () => (await store.queryTasks({ missionId })).find((t) => t.envelope.identity.plan_node_id === 'slow' && t.binding && t.state === 'RUNNING'), 180_000, 'slow 节点绑定并运行')
  const gated = await waitFor(async () => (await store.queryTasks({ missionId })).find((t) => t.envelope.identity.plan_node_id === 'gated' && t.state === 'APPROVAL_REQUIRED'), 60_000, 'gated 节点等审批')
  const groups = () => new Set(execFileSync('ps', ['-axo', 'pgid=,command='], { maxBuffer: 64 << 20 }).toString().split('\n')
    .filter((l) => l.includes(`.cmap-result-${slow.id}.json`) && l.includes(' exec ')).map((l) => Number(l.trim().split(/\s+/)[0])))
  const before = await waitFor(async () => { const g = groups(); return g.size ? g : null }, 60_000, 'slow 节点的 Codex 进程组出现')
  ok(`slow ${slow.id} 已绑定运行（Codex 进程组 ${[...before].join(',')}）；gated ${gated.id} 等审批、未绑定`)
  const res = await post(`/v1/missions/${missionId}/cancel`, { reason: 'S5 e2e：需求变更，停止执行' })
  if (res.status !== 202) fail(`取消请求 ${res.status} ${JSON.stringify(res.body)}`)
  const result = await finish(created, 120_000)
  if (result.state !== 'CANCELED') fail(`C9 应 CANCELED，实际 ${result.state}`)
  await waitFor(async () => groups().size === 0, 30_000, 'slow 节点的 Codex 进程组退出')
  const all = await events(missionId)
  const reason = all.find((e) => e.event_type === 'MISSION_CANCEL_REQUESTED')
  if (reason?.payload.reason !== 'S5 e2e：需求变更，停止执行' || reason.actor.type !== 'human') fail('取消原因事件缺失或主体不对')
  const slowNow = await store.getTask(slow.id), gatedNow = await store.getTask(gated.id)
  const cancelReq = all.filter((e) => e.event_type === 'TASK_CANCEL_REQUESTED' && e.task_id === slow.id)
  if (slowNow.state !== 'CANCELED' || cancelReq.length !== 1 || cancelReq[0].payload.confirmed !== true || cancelReq[0].payload.adapter !== 'codex-adapter') fail(`已绑定任务：state=${slowNow.state} cancel 事件=${JSON.stringify(cancelReq.map((e) => e.payload))}`)
  if (gatedNow.state !== 'CANCELED' || gatedNow.binding) fail(`未绑定任务：state=${gatedNow.state} binding=${Boolean(gatedNow.binding)}`)
  const approval = await store.getApproval(`apr:${gated.id}:controlled`)
  if (approval?.decision !== 'expired') fail(`gated 审批应 expired，实际 ${approval?.decision}`)
  if (started(all.map((e) => e.event_type)) !== 1) fail('只应有 slow 一个任务被派发')
  if ((await store.getMission(missionId)).state !== 'CANCELED') fail('账本 Mission 不是 CANCELED')
  ok(`Mission CANCELED；slow 收到 codex-adapter cancel（confirmed）并 CANCELED、进程组已退出；gated 未派发即 CANCELED、审批 expired；原因已记录`)
}

console.log('\n✅ S5 真实链路验证通过')
await api.close()
await new Promise((resolve) => { worker.once('exit', resolve); worker.kill('SIGTERM') })
await connection.close()
await store.close()
