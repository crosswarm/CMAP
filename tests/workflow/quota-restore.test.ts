/**
 * Q05 交回（ADR-0009 §5）：A 额度低时新任务派 B；resets_at 已过且重新探测确认允许用量、低于阈值后，
 * 新任务按 preferred_agent 自然派回 A，并在首次检测到恢复时记一次 QUOTA_RESTORED。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '#domain-model'
import type { Mission, QuotaSnapshotV1, TaskEnvelopeV1 } from '#domain-model'
import { createActivities } from '../../workflows/activities.ts'
import { FakeAdapter, syntheticRunner, syntheticActivityDeps } from './fake-adapter.ts'

const ACTOR = { type: 'system', id: 'restore-test' } as const
const MISSION = 'restore-mission'

const agent = (id: string) => {
  const adapter = new FakeAdapter()
  Object.defineProperty(adapter, 'adapterId', { value: `${id}-adapter` })
  Object.defineProperty(adapter, 'agentId', { value: id })
  return adapter
}
/** 当前快照由测试改写；每次 health 都带上它，模拟 runner 侧的零额度探针。 */
const probed = (adapter: FakeAdapter, quota: () => QuotaSnapshotV1) => {
  adapter.health = async () => ({ state: 'healthy', checked_at: new Date().toISOString(), quota: quota() })
}
const snapshot = (account: string, used: number, resetsAt: string | null, overrides: Partial<QuotaSnapshotV1> = {}): QuotaSnapshotV1 => ({
  schema: 'cmap/quota-snapshot/v1', provider: 'codex', account_ref: account.repeat(64),
  windows: [{ kind: 'secondary', used_percent: used, window_minutes: 10080, resets_at: resetsAt }],
  ordinary_usage_allowed: true, observed_at: new Date().toISOString(), status: 'ok', ...overrides,
})

async function harness(adapters: FakeAdapter[]) {
  const store = new MemoryStore()
  const now = new Date().toISOString()
  const mission: Mission = { id: MISSION, tenant: 'local', owner: 'test', type: 'inspect', goal: 'restore', constraints: {}, acceptance: [{ criterion_id: 'C1', metric: 'ok', operator: 'eq', expected: true, hard_gate: true }], workflow_template: 'inspect/v1', state: 'DRAFT', revision: 1, created_at: now, updated_at: now }
  await store.createMission({ mission, actor: ACTOR })
  const acts = createActivities(syntheticActivityDeps({ store, adapters, runner: syntheticRunner({ agents: adapters.map((a) => a.agentId) }), pollIntervalMs: 1 }))
  let seq = 0
  /** 每个新任务都首选 a、替补 b，派发后返回选中的 Adapter。 */
  const dispatchNew = async (): Promise<string> => {
    const taskId = `restore-task-${++seq}`
    const envelope: TaskEnvelopeV1 = {
      schema: 'cmap/task-envelope/v1',
      identity: { mission_id: MISSION, task_id: taskId, idempotency_key: taskId, revision: 1, tenant: 'local', owner: 'test' },
      classification: { task_type: 'inspect', requested_capability: 'code.analyze', risk_level: 'read-meta' },
      goal: { statement: 'restore', success_definition: [{ criterion_id: 'C1', metric: 'ok', operator: 'eq', expected: true }] },
      environment: {}, execution_policy: { timeout_seconds: 30, max_attempts: 1, preferred_agent: 'a', fallback_agents: ['b'] },
      permissions: { forbidden: [] }, evidence_requirements: { required_artifact_roles: ['report'] },
      output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
    }
    await store.createTask({ actor: ACTOR, task: { id: taskId, mission_id: MISSION, parent_task_id: null, supersedes_task_id: null, capability: 'code.analyze', risk: 'read-meta', state: 'DRAFT', attempt: 1, max_attempts: 1, lamport: 0, envelope, result: null, binding: null, deps: [], created_at: now, updated_at: now } })
    await acts.markReady(taskId)
    await acts.dispatchTask(taskId)
    return (await store.getTask(taskId))!.binding!.adapter
  }
  const restored = async () => (await store.listEvents(MISSION)).filter((e) => e.event_type === 'QUOTA_RESTORED')
  return { store, dispatchNew, restored }
}

test('A 额度低派 B；resets_at 已过且重新探测确认恢复后新任务派回 A，只在首次恢复时记 QUOTA_RESTORED', async () => {
  const a = agent('a')
  const b = agent('b')
  const resetsAt = new Date(Date.now() + 150).toISOString()
  let current = snapshot('a', 96, resetsAt)
  probed(a, () => current)
  probed(b, () => snapshot('b', 10, null))
  const { dispatchNew, restored } = await harness([a, b])

  assert.equal(await dispatchNew(), 'b-adapter', 'A 额度低时新任务派给 B')
  const low = current
  await new Promise((r) => setTimeout(r, 200))
  current = snapshot('a', 3, new Date(Date.now() + 7 * 24 * 3600_000).toISOString())
  assert.equal(await dispatchNew(), 'a-adapter', '恢复后按 preferred_agent 派回 A')
  const events = await restored()
  assert.equal(events.length, 1)
  assert.deepEqual(events[0]!.payload, {
    provider: 'codex', account_ref: 'a'.repeat(64), low_observed_at: low.observed_at, resets_at: resetsAt, restored_observed_at: current.observed_at,
  })
  assert.equal(events[0]!.task_id, 'restore-task-2')

  current = snapshot('a', 4, null)
  assert.equal(await dispatchNew(), 'a-adapter')
  assert.equal((await restored()).length, 1, '已恢复后不重复记录')
})

test('重置时刻未过、或 Codex 未明确允许普通用量（null）时不判恢复', async () => {
  const a = agent('a')
  const b = agent('b')
  let current = snapshot('e', 97, new Date(Date.now() + 3600_000).toISOString())
  probed(a, () => current)
  probed(b, () => snapshot('f', 10, null))
  const { dispatchNew, restored } = await harness([a, b])
  assert.equal(await dispatchNew(), 'b-adapter')
  current = snapshot('e', 5, new Date(Date.now() + 3600_000).toISOString())
  await dispatchNew()
  assert.equal((await restored()).length, 0, '重置时刻未过，不凭百分比推断恢复')

  current = snapshot('e', 10, null, { ordinary_usage_allowed: false })
  await dispatchNew()
  current = snapshot('e', 10, null, { ordinary_usage_allowed: null })
  await dispatchNew()
  assert.equal((await restored()).length, 0, 'ordinaryUsageAllowed 为 null 不得推断已恢复')
})
