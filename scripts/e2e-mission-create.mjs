/** POST → PostgreSQL → Temporal → 真 Codex；并发重试和完成后重试不重跑。需独立测试 schema/队列及已运行的 API/Worker。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

process.env.NO_PROXY = 'localhost,127.0.0.1,::1'
process.env.no_proxy = process.env.NO_PROXY
process.env.grpc_proxy = ''
const { PgStore } = await import('#domain-model')
const { Client, Connection } = await import('@temporalio/client')

const schema = process.env.CMAP_DB_SCHEMA
assert.ok(schema && schema !== 'public', '真实创建验证必须指定独立 CMAP_DB_SCHEMA')
const store = new PgStore({ connectionString: process.env.CMAP_DATABASE_URL ?? 'postgres://temporal:temporal@localhost:5433/cmap', schema })
const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233', connectTimeout: 5000 })
const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' })
const base = `http://127.0.0.1:${process.env.CMAP_API_PORT ?? 8787}`
const workRoot = resolve(process.env.CMAP_WORK_ROOT ?? '.cmap-work')
const request = {
  request_id: `create-e2e-${Date.now()}`, risk_level: 'read-meta', max_additional_cycles: 0,
  goal: '在当前工作目录新建 sample/ 并写入 3 个文本文件；统计 sample/ 下的文件数量，写入 evidence/report.json。',
  acceptance: [{ criterion_id: 'FILE-COUNT', metric: 'sample_file_count', operator: 'eq', expected: 3, hard_gate: true }],
}
const post = async () => {
  const response = await fetch(`${base}/v1/missions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(25_000),
  })
  assert.equal(response.status, 202)
  return response.json()
}
let timer
try {
  const [first, duplicate] = await Promise.all([post(), post()])
  assert.deepEqual(first, duplicate)
  console.log('ACCEPTED', first.mission_id, first.workflow_id)
  const handle = client.workflow.getHandle(first.workflow_id)
  const initial = await handle.describe()
  const result = await Promise.race([
    handle.result(),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('10 分钟内未观测到终态；请检查已打印的原 Workflow，不要重新派发')), 600_000) }),
  ])
  clearTimeout(timer)
  assert.equal(result.state, 'COMPLETED')
  const mission = await store.getMission(first.mission_id)
  assert.equal(mission.state, 'COMPLETED')
  assert.equal(mission.owner, process.env.CMAP_OWNER ?? 'local-operator')
  const tasks = await store.queryTasks({ missionId: first.mission_id })
  assert.equal(tasks.length, 1, '并发请求不能产生两个任务')
  assert.ok(tasks[0].binding)
  assert.equal(tasks[0].result.criterion_results[0].passed, true)
  const sample = await readdir(join(workRoot, tasks[0].id, 'sample'), { withFileTypes: true })
  assert.equal(sample.filter((entry) => entry.isFile()).length, 3, '独立核对实际文件数，不只接受 Agent 自报')
  const evidence = await (await fetch(`${base}/v1/missions/${first.mission_id}/evidence`)).json()
  assert.equal(evidence.tasks.length, 1)
  assert.ok(evidence.tasks[0].artifacts.length > 0)
  for (const artifact of evidence.tasks[0].artifacts) {
    const path = isAbsolute(artifact.uri) ? artifact.uri : join(workRoot, tasks[0].id, artifact.uri)
    const bytes = await readFile(path)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256.toLowerCase())
  }
  const events = await store.listEvents(first.mission_id)
  assert.equal(events.filter((e) => e.event_type === 'MISSION_CREATED').length, 1)
  assert.equal('goal' in events.find((e) => e.event_type === 'MISSION_CREATED').payload, false)
  assert.deepEqual(await post(), first)
  assert.equal((await handle.describe()).runId, initial.runId)
  assert.equal((await store.queryTasks({ missionId: first.mission_id })).length, 1)
  console.log('PASS: API 并发创建只产生一个 Mission/Workflow/Task；Codex 完成，证据哈希一致；终态重试未重跑。')
} finally {
  clearTimeout(timer)
  await connection.close()
  await store.close()
}
