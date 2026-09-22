/** Real HTTP -> Temporal -> Codex/Kimi fork/join. Dedicated local schema/queue required. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { PgStore } from '#domain-model'
import { Client, Connection } from '@temporalio/client'
import { Worker } from '@temporalio/worker'

process.env.NO_PROXY = process.env.no_proxy = 'localhost,127.0.0.1,::1'
process.env.grpc_proxy = ''
const schema = process.env.CMAP_DB_SCHEMA
const workRoot = process.env.CMAP_WORK_ROOT
assert.ok(schema?.startsWith('cmap_dag_'), 'Use a dedicated cmap_dag_* schema')
assert.ok(workRoot && isAbsolute(workRoot), 'An absolute isolated work root is required')
const port = Number(process.env.CMAP_API_PORT ?? 8789)
const store = new PgStore({ connectionString: process.env.CMAP_DATABASE_URL ?? 'postgres://temporal:temporal@localhost:5433/cmap', schema })
const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233', connectTimeout: 5000 })
const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' })
const criterion = (id, expected) => ({ criterion_id: id, metric: id, operator: 'eq', expected, hard_gate: true })
const requestId = `dag-e2e-${Date.now()}`
const resourceLock = (node) => ({resource:`${requestId}:${node}`,ttl_seconds:15})
const producer = (node_id, value, preferred_agent) => ({
  node_id, goal: `Write evidence/report.json containing exactly {"value":${value}}. Read it back and report the value as the actual value for criterion ${node_id}. Include this file as a report artifact.`,
  capability: 'code.analyze', deps: [], criterion_ids: [node_id], risk_level: 'read-meta', preferred_agent,
  required_resource_locks: [resourceLock(node_id)],
})
const request = {
  request_id: requestId, goal: 'Run two independent producers then sum their verified copied reports.',
  risk_level: 'read-meta', max_additional_cycles: 1,
  acceptance: [criterion('left', 17), criterion('right', 25), criterion('total', 42)],
  plan: { schema: 'cmap/mission-plan/v1', concurrency: 2, nodes: [
    producer('left', 17, 'codex'), producer('right', 25, 'kimi'),
    { node_id: 'join', goal: 'Read every report supplied in inputs.artifact_refs (the payload files contain JSON regardless of extension). Sum their value fields. Write evidence/report.json with {"total": the_sum, "input_count":2}. Report the sum as the actual value for criterion total. Include the report artifact. Do not assume inputs; read the supplied files.',
      capability: 'code.analyze', deps: ['left', 'right'], criterion_ids: ['total'], risk_level: 'read-meta', preferred_agent: 'codex',
      required_resource_locks: [resourceLock('right'), resourceLock('left')] },
  ] },
}

try {
  let started
  if (process.argv[2] === '--workflow-id' && process.argv[3]) {
    started = {workflow_id:process.argv[3]}
  } else {
    assert.equal(process.argv.length, 2, 'Usage: e2e-dag.mjs [--workflow-id existing-id]')
    const response = await fetch(`http://127.0.0.1:${port}/v1/missions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(20000),
    })
    assert.equal(response.status, 202, 'API must accept and start DAG')
    started = await response.json()
  }
  console.log(JSON.stringify({ phase: 'started', ...started }))
  const handle = client.workflow.getHandle(started.workflow_id)
  const result = await handle.result()
  assert.equal(result.state, 'COMPLETED', JSON.stringify(result))
  const mission = await store.getMission(result.missionId)
  assert.equal(mission.workflow_template, 'dag/v1')
  assert.equal(mission.state, 'COMPLETED')
  const tasks = await store.queryTasks({ missionId: mission.id })
  const accepted = Object.fromEntries(result.nodeOutcomes.map(o => [o.nodeId, tasks.find(t => t.id === o.taskId)]))
  assert.equal(accepted.left.binding.adapter, 'codex-adapter')
  assert.equal(accepted.right.binding.adapter, 'kimi-adapter')
  assert.deepEqual(accepted.join.deps, [accepted.left.id, accepted.right.id])
  const reviews = await store.listReviews(mission.id)
  for (const [nodeId, task] of Object.entries(accepted)) {
    assert.equal(task.state, 'COMPLETED')
    assert.ok(reviews.some(r => r.decision.decision === 'accept' && r.reviewed_task_ids.length === 1 && r.reviewed_task_ids[0] === task.id))
    for (const artifact of await store.listArtifacts(task.id)) {
      const bytes = await readFile(isAbsolute(artifact.uri) ? artifact.uri : join(workRoot, task.id, artifact.uri))
      assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256)
      if (artifact.role === 'report' && (nodeId === 'left' || nodeId === 'right')) {
        assert.ok(JSON.parse(bytes).value === (nodeId === 'left' ? 17 : 25), 'Producer report must independently match its own criterion')
      }
    }
  }
  const inputs = accepted.join.envelope.inputs.artifact_refs
  assert.equal(inputs.length, 2)
  let total = 0
  for (const input of inputs) {
    const bytes = await readFile(join(workRoot, accepted.join.id, input.uri))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), input.sha256)
    total += JSON.parse(bytes).value
  }
  assert.equal(total, 42)
  const report = (await store.listArtifacts(accepted.join.id)).find(a => a.role === 'report')
  const joined = JSON.parse(await readFile(isAbsolute(report.uri) ? report.uri : join(workRoot, accepted.join.id, report.uri), 'utf8'))
  assert.equal(joined.total, 42)
  assert.equal(joined.input_count, 2)
  const events = await store.listEvents(mission.id)
  const joinCreated = events.findIndex(e => e.event_type === 'TASK_CREATED' && e.task_id === accepted.join.id)
  for (const parent of [accepted.left, accepted.right]) {
    const acceptedIndex = events.findIndex(e => e.event_type === 'REVIEW_ACCEPTED' && e.task_id === parent.id)
    assert.ok(acceptedIndex >= 0 && acceptedIndex < joinCreated, 'join starts only after parent acceptance')
  }
  assert.equal(events.filter(e => e.event_type === 'MISSION_COMPLETED').length, 1)
  assert.equal((await store.listActiveLocks(new Date().toISOString())).filter(l=>l.mission_id===mission.id).length,0)
  // Replay in memory: histories can contain prompts and must not be committed or logged.
  const history = await handle.fetchHistory()
  await Worker.runReplayHistory({ workflowsPath: resolve('workflows/index.ts') }, history)
  console.log(JSON.stringify({ phase: 'verified', missionId: mission.id, workflowId: started.workflow_id,
    adapters: ['codex','kimi'], tasks: tasks.length, inputCount: inputs.length, total,
    events: events.length, historyEvents: history.events.length, replay: 'passed' }))
} finally {
  await connection.close()
  await store.close()
}
