/** Real Pg/Temporal/Codex execution; only the two-followup reviewer decision is synthetic. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, Connection } from '@temporalio/client'
import { NativeConnection, Worker } from '@temporalio/worker'
import { PgStore, issueDispatchPermit, verifyDispatchPermit } from '#domain-model'
import { CodexAdapter } from '../adapters/codex-adapter/src/index.ts'
import { createActivities } from '../workflows/activities.ts'
import { buildRunnerDescriptor } from '../apps/worker/src/runner-config.ts'

process.env.NO_PROXY = process.env.no_proxy = 'localhost,127.0.0.1,::1'
process.env.grpc_proxy = ''

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const suffix = Date.now().toString(36)
const schema = 'cmap_followups_e2e_' + suffix
const taskQueue = 'cmap-followups-e2e-' + suffix
const missionId = 'mis-followups-e2e-' + suffix
const runnerId = 'followups-e2e-runner'
const workRoot = await mkdtemp(join(tmpdir(), 'cmap-followups-e2e-'))
const store = new PgStore({
  connectionString: process.env.CMAP_DATABASE_URL ?? 'postgres://temporal:temporal@localhost:5433/cmap',
  schema,
})
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const issuer = 'cmap:followups-e2e'
const adapter = new CodexAdapter({
  outputSchemaPath: join(repoRoot, 'schemas/codex-output.v1.schema.json'),
  authorization: { mode: 'managed', verifier: (token, envelope, adapterId, contextRunner) => {
    assert.equal(contextRunner, runnerId)
    return verifyDispatchPermit(token, { publicKey, issuer, runnerId, adapterId, envelope })
  } },
})
const startedTaskIds = []
const startTask = adapter.startTask.bind(adapter)
adapter.startTask = async (envelope, context) => {
  startedTaskIds.push(envelope.identity.task_id)
  return startTask(envelope, context)
}
const descriptor = await adapter.discover()
const runner = buildRunnerDescriptor({
  RUNNER_ID: runnerId, RUNNER_TENANT: 'team-ycc', RUNNER_ALLOWED_TENANTS: 'team-ycc',
  RUNNER_ALLOWED_OWNERS: 'test-harness:followups', RUNNER_ALLOWED_CAPABILITIES: 'code.analyze',
  RUNNER_MAX_RISK: 'read-sensitive',
}, [descriptor])
const activities = createActivities({
  store, adapter, runner, workRoot, pollIntervalMs: 200,
  signDispatchPermit: (envelope, { runnerId, adapterId }) =>
    issueDispatchPermit({ privateKey, issuer, runnerId, adapterId, envelope }),
})
const goal = '在当前工作目录创建 sample/，写入恰好 3 个文本文件，实际统计文件数并写入 evidence/report.json；如实报告实际数量。'
let stage = 'database'
let connection
let native
try {
  await store.migrate()
  const now = new Date().toISOString()
  await store.createMission({ actor: { type: 'system', id: 'e2e-followups' }, mission: {
    id: missionId, tenant: 'team-ycc', owner: 'test-harness:followups', type: 'inspect', goal,
    constraints: { max_additional_cycles: 1 },
    acceptance: [{ criterion_id: 'FILE-COUNT', metric: 'sample_file_count', operator: 'eq', expected: 3, hard_gate: true }],
    workflow_template: 'inspect/v1', state: 'DRAFT', revision: 1, created_at: now, updated_at: now,
  } })
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233'
  connection = await Connection.connect({ address, connectTimeout: 15_000 })
  native = await NativeConnection.connect({ address })
  const client = new Client({ connection, namespace: 'default' })
  const worker = await Worker.create({
    connection: native, namespace: 'default', taskQueue,
    workflowsPath: join(repoRoot, 'workflows/index.ts'),
    activities: {
      ...activities,
      evaluateHardGate: async (input) => {
        const evaluated = await activities.evaluateHardGate(input)
        if (input.round !== 0) return evaluated
        assert.equal(evaluated.decision.decision, 'accept', 'Source must actually pass before the synthetic review fixture')
        // This fixture requests two independent rebuilds; it does not impersonate business approval.
        return { ...evaluated, decision: {
          ...evaluated.decision, decision: 'rework',
          hard_gate_summary: { total: 2, passed: 1, failed: 1 },
          failed_criteria: [{ criterion_id: 'TEST-INDEPENDENT-REVIEW', expected: 'two independent rebuilds',
            actual: 'source task only', reason: 'Synthetic test reviewer requires two independent rebuilds' }],
          required_followups: ['A', 'B'].map(label => ({ capability: 'code.analyze', task_type: 'inspect',
            focus: [goal, '独立复核 ' + label + '：在自己的工作目录重新完成目标，并生成自己的证据。'] })),
          stop_conditions: { max_additional_cycles: 1 },
          review_confidence: { level: 'high', limitations: ['Synthetic reviewer fixture, not a human approval or real Claude review'] },
        } }
      },
    },
  })
  stage = 'real-agent-workflow'
  console.log(JSON.stringify({ stage, missionId, schema, taskQueue, workRoot, reviewer: 'synthetic', adapter: 'real-codex' }))
  const started = Date.now()
  let handle
  const result = await worker.runUntil(async () => {
    handle = await client.workflow.start('missionWorkflow', {
      taskQueue, workflowId: 'e2e-' + missionId, args: [{ missionId }], workflowExecutionTimeout: '20 minutes',
    })
    return handle.result()
  })
  stage = 'ledger-and-disk-proof'
  assert.equal(result.state, 'COMPLETED')
  assert.equal(result.rounds, 1)
  assert.equal(result.taskIds.length, 3)
  assert.deepEqual(startedTaskIds, result.taskIds)
  assert.equal(new Set(startedTaskIds).size, 3)
  const tasks = await store.queryTasks({ missionId })
  assert.equal(tasks.length, 3)
  assert.equal((await store.getMission(missionId))?.state, 'COMPLETED')
  for (const taskId of result.taskIds) {
    const task = tasks.find(task => task.id === taskId)
    assert.equal(task?.state, 'COMPLETED')
    assert.equal(task.binding?.adapter, 'codex-adapter')
    assert.equal(task.supersedes_task_id, taskId === result.taskIds[0] ? null : result.taskIds[0])
    const count = (await readdir(join(workRoot, taskId, 'sample'), { withFileTypes: true })).filter(entry => entry.isFile()).length
    assert.equal(count, 3)
    const criterion = task.result?.criterion_results.find(item => item.criterion_id === 'FILE-COUNT')
    assert.equal(Number(criterion?.actual), count)
    assert.equal(criterion?.passed, true)
    const artifacts = await store.listArtifacts(taskId)
    assert.ok(artifacts.length > 0)
    for (const artifact of artifacts) {
      const path = isAbsolute(artifact.uri) ? artifact.uri : join(workRoot, taskId, artifact.uri)
      assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), artifact.sha256.toLowerCase())
    }
  }
  const events = await store.listEvents(missionId)
  assert.equal(events.filter(event => event.event_type === 'TASK_CANCELED').length, 0)
  assert.equal(events.filter(event => event.event_type === 'REVIEW_APPLICATION_COMPLETED').length, 3)
  stage = 'history-replay'
  const history = await handle.fetchHistory()
  await Worker.runReplayHistory({ workflowsPath: join(repoRoot, 'workflows/index.ts') }, history)
  console.log(JSON.stringify({ verified: true, missionId, schema, taskQueue, workRoot,
    taskIds: result.taskIds, taskCount: tasks.length, historyEvents: history.events.length,
    elapsedSeconds: (Date.now() - started) / 1000, reviewer: 'synthetic', adapter: 'real-codex',
    evidence: 'three files per task; reported counts, hashes, parentage, task/Mission completion and fresh history replay verified' }))
} catch (error) {
  console.error(JSON.stringify({ verified: false, stage, missionId, schema, error: error instanceof Error ? error.name : 'UnknownError' }))
  process.exitCode = 1
} finally {
  await connection?.close()
  await native?.close()
  await store.close()
}
