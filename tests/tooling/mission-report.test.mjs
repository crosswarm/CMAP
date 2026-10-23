import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '#domain-model'
import { buildReport } from '../../scripts/mission-report.mjs'

const T0 = '2026-10-22T00:00:00.000Z'
const actor = { type: 'system', id: 'test' }

const task = (id, missionId, adapter, cost) => ({
  id, mission_id: missionId, parent_task_id: null, supersedes_task_id: null, capability: 'code.analyze', risk: 'read-meta',
  state: 'COMPLETED', attempt: 1, max_attempts: 1, lamport: 0, envelope: {}, deps: [], created_at: T0, updated_at: T0,
  binding: { adapter, remote_task_id: id, protocol: 'p', protocol_version: '1', runner_id: 'r' },
  result: cost ? { schema: 'cmap/task-result/v1', status: 'completed', cost } : null,
})

test('报表按 Agent 汇总 tokens 与耗时，Kimi 与 Codex 分开列出；无用量的任务不计入 tokens', async () => {
  const store = new MemoryStore()
  await store.createMission({ actor, mission: { id: 'm1', tenant: 'local', owner: 'o', type: 'inspect', goal: 'g', constraints: {}, acceptance: [],
    workflow_template: 'dag/v1', state: 'COMPLETED', revision: 1, created_at: T0, updated_at: T0 } })
  await store.createTask({ actor, task: task('t1', 'm1', 'codex-adapter', { tokens: 1000, duration_seconds: 5 }) })
  await store.createTask({ actor, task: task('t2', 'm1', 'kimi-adapter', { tokens: 300, duration_seconds: 2 }) })
  await store.createTask({ actor, task: task('t3', 'm1', 'kimi-adapter', { duration_seconds: 4 }) })

  const { rows, by_agent } = await buildReport(store, { tenant: 'local', since: '1970-01-01' })

  assert.deepEqual(rows[0].by_agent, {
    'codex-adapter': { tasks: 1, tokens: 1000, agent_seconds: 5 },
    'kimi-adapter': { tasks: 2, tokens: 300, agent_seconds: 6 },
  })
  assert.equal(rows[0].tokens, 1300)
  assert.deepEqual(by_agent['kimi-adapter'], { tasks: 2, tokens: 300, agent_seconds: 6, tasks_without_tokens: 1 })
})

test('报表标出触发过成本告警的 Mission 数', async () => {
  const store = new MemoryStore()
  await store.createMission({ actor, mission: { id: 'm1', tenant: 'local', owner: 'o', type: 'inspect', goal: 'g', constraints: {}, acceptance: [],
    workflow_template: 'dag/v1', state: 'RUNNING', revision: 1, created_at: T0, updated_at: T0 } })
  await store.appendEvent({ event: { event_type: 'MISSION_COST_ALERT', event_version: 1, occurred_at: T0, mission_id: 'm1', task_id: null, attempt: null,
    actor, causation_id: null, correlation_id: 'm1', trace_id: null, idempotency_key: 'mission-cost-alert:m1', payload: { total_tokens: 9, threshold_tokens: 5 } } })

  const report = await buildReport(store, { tenant: 'local', since: '1970-01-01' })

  assert.equal(report.rows[0].cost_alert, true)
  assert.equal(report.cost_alerts, 1)
})
