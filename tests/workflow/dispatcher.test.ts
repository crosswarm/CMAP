/**
 * Q06 可切换调度者（ADR-0009 §4）：确定性候选集 ≥2 时，按配置顺序找第一个可用且额度不低的调度者在候选内挑选；
 * 调度者额度低或不可用换下一个，全部不可用回落确定性顺序；越界输出按无效回落；单候选不调用。
 * 决定落账为 jev-decision.v1 routing（JEV_DECIDED，带 decider）。这里全用假调度者，不消耗真实额度。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { MemoryStore } from '#domain-model'
import type { Mission, QuotaSnapshotV1, TaskEnvelopeV1 } from '#domain-model'
import { createActivities } from '../../workflows/activities.ts'
import type { Dispatcher, DispatcherInput } from '../../workflows/dispatchers.ts'
import { FakeAdapter, syntheticRunner, syntheticActivityDeps } from './fake-adapter.ts'

const ajv = new Ajv2020({ strict: true })
addFormats.default(ajv)
const validDecision = ajv.compile(JSON.parse(readFileSync(new URL('../../schemas/jev-decision.v1.schema.json', import.meta.url), 'utf8')))

const ACTOR = { type: 'system', id: 'dispatcher-test' } as const
const agent = (id: string, used = 10) => {
  const adapter = new FakeAdapter()
  Object.defineProperty(adapter, 'adapterId', { value: `${id}-adapter` })
  Object.defineProperty(adapter, 'agentId', { value: id })
  adapter.health = async () => ({ state: 'healthy', checked_at: new Date().toISOString(), quota: quotaOf(id, used) })
  return adapter
}
const quotaOf = (account: string, used: number): QuotaSnapshotV1 => ({
  schema: 'cmap/quota-snapshot/v1', provider: 'codex', account_ref: account.charCodeAt(0).toString(16).slice(-1).repeat(64),
  windows: [{ kind: 'secondary', used_percent: used, window_minutes: 10080, resets_at: null }],
  ordinary_usage_allowed: true, observed_at: new Date().toISOString(), status: 'ok',
})
const dispatcher = (id: string, choose: (input: DispatcherInput) => unknown, quota?: QuotaSnapshotV1) => {
  const calls: DispatcherInput[] = []
  const d: Dispatcher = {
    id,
    ...(quota ? { quota: async () => quota } : {}),
    async choose(input) {
      calls.push(input)
      const picked = choose(input)
      if (picked instanceof Error) throw picked
      return { agent_id: picked, model: `${id}-model-1`, confidence: 0.8 }
    },
  }
  return { d, calls }
}

async function dispatchOnce(adapters: FakeAdapter[], dispatchers: Dispatcher[], policy: Partial<TaskEnvelopeV1['execution_policy']> = {}) {
  const store = new MemoryStore()
  const now = new Date().toISOString()
  const mission: Mission = { id: 'disp-mission', tenant: 'local', owner: 'test', type: 'inspect', goal: '机密目标正文', constraints: {}, acceptance: [{ criterion_id: 'C1', metric: 'ok', operator: 'eq', expected: true, hard_gate: true }], workflow_template: 'inspect/v1', state: 'DRAFT', revision: 1, created_at: now, updated_at: now }
  await store.createMission({ mission, actor: ACTOR })
  const acts = createActivities(syntheticActivityDeps({ store, adapters, dispatchers, runner: syntheticRunner({ agents: adapters.map((a) => a.agentId) }), pollIntervalMs: 1 }))
  const taskId = 'disp-task'
  const envelope: TaskEnvelopeV1 = {
    schema: 'cmap/task-envelope/v1',
    identity: { mission_id: mission.id, task_id: taskId, idempotency_key: taskId, revision: 1, tenant: 'local', owner: 'test' },
    classification: { task_type: 'inspect', requested_capability: 'code.analyze', risk_level: 'read-meta' },
    goal: { statement: '节点目标正文', success_definition: [{ criterion_id: 'C1', metric: 'ok', operator: 'eq', expected: true }] },
    environment: {}, execution_policy: { timeout_seconds: 30, max_attempts: 1, ...policy },
    permissions: { forbidden: [] }, evidence_requirements: { required_artifact_roles: ['report'] },
    output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
  }
  await store.createTask({ actor: ACTOR, task: { id: taskId, mission_id: mission.id, parent_task_id: null, supersedes_task_id: null, capability: 'code.analyze', risk: 'read-meta', state: 'DRAFT', attempt: 1, max_attempts: 1, lamport: 0, envelope, result: null, binding: null, deps: [], created_at: now, updated_at: now } })
  await acts.markReady(taskId)
  await acts.dispatchTask(taskId)
  const events = await store.listEvents(mission.id)
  return {
    chosen: (await store.getTask(taskId))!.binding!.adapter,
    routing: events.find((e) => e.event_type === 'ROUTING_DECIDED')!.payload as any,
    decisions: events.filter((e) => e.event_type === 'JEV_DECIDED'),
  }
}

test('调度者在确定性候选内挑选：派给它选的候选，决定落账为 jev-decision routing（带 decider），输入只含可信字段', async () => {
  const one = dispatcher('fake-one', (input) => input.candidates[1]!.agent_id)
  const out = await dispatchOnce([agent('a'), agent('b'), agent('c', 95)], [one.d], { preferred_agent: 'a', fallback_agents: ['b', 'c'] })
  assert.equal(out.chosen, 'b-adapter')
  assert.equal(one.calls.length, 1)
  assert.deepEqual(one.calls[0]!.candidates.map((c) => c.agent_id), ['a', 'b'], '额度低的 c 不在候选集内')
  const sent = JSON.stringify(one.calls[0])
  assert.ok(!sent.includes('机密目标正文') && !sent.includes('节点目标正文'), '不送目标等自由文本')
  assert.equal(out.routing.decider, 'fake-one:fake-one-model-1')
  assert.deepEqual(out.routing.candidates.map((c: any) => [c.agent_id, c.verdict, c.reason]),
    [['a', 'skipped', 'not_chosen'], ['b', 'selected', null], ['c', 'skipped', 'quota_low']])
  assert.equal(out.decisions.length, 1)
  const record = out.decisions[0]!.payload as any
  assert.equal(validDecision(record), true, JSON.stringify(validDecision.errors))
  assert.equal(record.decision_type, 'routing')
  assert.equal(record.decider, 'fake-one:fake-one-model-1')
  assert.equal(record.assigned_agent, 'b')
  assert.equal(record.route, 'auto')
  assert.equal(out.decisions[0]!.idempotency_key, 'jev-routing:disp-task')
})

test('调度者选了候选外的 agent（含额度低者）按无效输出回落确定性顺序', async () => {
  for (const pick of ['zzz', 'c']) {
    const bad = dispatcher('fake-bad', () => pick)
    const next = dispatcher('fake-next', (input) => input.candidates[1]!.agent_id)
    const out = await dispatchOnce([agent('a'), agent('b'), agent('c', 95)], [bad.d, next.d], { preferred_agent: 'a', fallback_agents: ['b', 'c'] })
    assert.equal(out.chosen, 'a-adapter', pick)
    assert.equal(next.calls.length, 0, '无效输出不换下一个调度者，直接回落')
    assert.equal(out.routing.decider, null)
    const record = out.decisions[0]!.payload as any
    assert.equal(validDecision(record), true, JSON.stringify(validDecision.errors))
    assert.deepEqual([record.outcome, record.route, record.reason_code, record.decider], ['escalate', 'human', 'jev_invalid_output', 'fake-bad:fake-bad-model-1'])
  }
})

test('调度者自己额度低或不可用时换下一个', async () => {
  const low = dispatcher('fake-low', () => 'b', quotaOf('z', 97))
  const down = dispatcher('fake-down', () => new Error('timeout'))
  const ok = dispatcher('fake-ok', () => 'b')
  const out = await dispatchOnce([agent('a'), agent('b')], [low.d, down.d, ok.d])
  assert.equal(low.calls.length, 0, '额度低的调度者不被调用')
  assert.equal(down.calls.length, 1)
  assert.equal(out.chosen, 'b-adapter')
  assert.equal((out.decisions[0]!.payload as any).decider, 'fake-ok:fake-ok-model-1')
})

test('全部调度者不可用：回落确定性顺序，记 jev_unavailable 且没有 decider', async () => {
  const down = dispatcher('fake-down', () => new Error('down'))
  const low = dispatcher('fake-low', () => 'b', quotaOf('y', 100))
  const out = await dispatchOnce([agent('a'), agent('b')], [down.d, low.d])
  assert.equal(out.chosen, 'a-adapter')
  const record = out.decisions[0]!.payload as any
  assert.equal(validDecision(record), true, JSON.stringify(validDecision.errors))
  assert.deepEqual([record.outcome, record.route, record.reason_code, record.decider, record.model], ['escalate', 'human', 'jev_unavailable', undefined, null])
  assert.equal(out.routing.decider, null)
})

test('确定性候选只有一个时不调用调度者，也不落决定', async () => {
  const one = dispatcher('fake-one', () => 'a')
  const out = await dispatchOnce([agent('a'), agent('b', 99)], [one.d])
  assert.equal(out.chosen, 'a-adapter')
  assert.equal(one.calls.length, 0)
  assert.equal(out.decisions.length, 0)
})
