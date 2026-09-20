import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '#domain-model'
import type { Mission, TaskEnvelopeV1 } from '#domain-model'
import type { AdapterHealth } from '#adapter-sdk'
import { createActivities } from '../../workflows/activities.ts'
import { FakeAdapter } from './fake-adapter.ts'

const ACTOR = { type: 'system', id: 'routing-test' } as const
const candidate = (id: string, caps = ['code.analyze'], state: AdapterHealth['state'] = 'healthy') => {
  const adapter = new FakeAdapter()
  Object.defineProperty(adapter, 'adapterId', { value: `${id}-adapter` })
  Object.defineProperty(adapter, 'agentId', { value: id })
  const original = adapter.discover.bind(adapter)
  adapter.discover = async () => ({ ...await original(), capabilities: caps })
  adapter.health = async () => ({ state, checked_at: new Date().toISOString() })
  return adapter
}
async function fixture(adapters: FakeAdapter[], policy: Partial<TaskEnvelopeV1['execution_policy']> = {}) {
  const store = new MemoryStore()
  const now = new Date().toISOString()
  const mission: Mission = { id: 'routing-mission', tenant: 'local', owner: 'test', type: 'inspect', goal: 'routing', constraints: {}, acceptance: [{ criterion_id: 'C1', metric: 'ok', operator: 'eq', expected: true, hard_gate: true }], workflow_template: 'inspect/v1', state: 'DRAFT', revision: 1, created_at: now, updated_at: now }
  await store.createMission({ mission, actor: ACTOR })
  const acts = createActivities({ store, adapters, pollIntervalMs: 1 })
  const { taskId } = await acts.createTask({ missionId: mission.id, capability: 'code.analyze' })
  // 输入来源仍是已验证信封；只改变测试的路由策略。
  const task = (await store.getTask(taskId))!
  Object.assign((task.envelope as TaskEnvelopeV1).execution_policy, policy)
  await acts.markReady(taskId)
  return { acts, store, taskId }
}

test('按能力派发并按 binding 收结果，不回到注册表第一项', async () => {
  const wrong = candidate('wrong', ['other'])
  const right = candidate('right')
  const { acts, store, taskId } = await fixture([wrong, right])
  await acts.dispatchTask(taskId)
  assert.equal(wrong.startCalls.length, 0)
  assert.equal(right.startCalls.length, 1)
  assert.equal((await store.getTask(taskId))!.binding!.adapter, 'right-adapter')
  await acts.collectTaskResult(taskId)
  assert.equal((await store.getTask(taskId))!.result!.status, 'completed')
})

test('首选不可用时只选显式替补，不选健康的未授权候选', async () => {
  const unrelated = candidate('unrelated')
  const first = candidate('primary', ['code.analyze'], 'unavailable')
  const fallback = candidate('backup')
  const { acts, taskId } = await fixture([unrelated, first, fallback], { preferred_agent: 'primary', fallback_agents: ['backup'] })
  await acts.dispatchTask(taskId)
  assert.equal(unrelated.startCalls.length, 0)
  assert.equal(first.startCalls.length, 0)
  assert.equal(fallback.startCalls.length, 1)
})

test('没有匹配候选时不派发', async () => {
  const a = candidate('other')
  const { acts, taskId } = await fixture([a], { preferred_agent: 'missing' })
  await assert.rejects(acts.dispatchTask(taskId), /没有可用 Adapter/)
  assert.equal(a.startCalls.length, 0)
})

test('启动失败不转发替补，避免重复外部副作用', async () => {
  const primary = candidate('primary')
  primary.startTask = async () => { throw new Error('ack lost') }
  const backup = candidate('backup')
  const { acts, taskId } = await fixture([primary, backup])
  await assert.rejects(acts.dispatchTask(taskId), /ack lost/)
  assert.equal(backup.startCalls.length, 0)
})


test('风险上限不足或健康探测抛错都不派发', async () => {
  const low = candidate('low')
  const desc = low.discover.bind(low)
  low.discover = async () => ({ ...await desc(), risk_ceiling: 'read-meta' })
  const broken = candidate('broken')
  broken.health = async () => { throw new Error('probe failed') }
  const { acts, store, taskId } = await fixture([low, broken])
  const task = (await store.getTask(taskId))!
  Object.assign((task.envelope as TaskEnvelopeV1).classification, { risk_level: 'controlled' })
  await assert.rejects(acts.dispatchTask(taskId), /没有可用 Adapter/)
  assert.equal(low.startCalls.length + broken.startCalls.length, 0)
  assert.equal((await store.getTask(taskId))!.state, 'READY')
})

test('注册表缺少已绑定 Adapter 时拒绝收取，不转给另一 Agent', async () => {
  const original = candidate('original')
  const { acts, store, taskId } = await fixture([original])
  await acts.dispatchTask(taskId)
  const replacement = createActivities({ store, adapters: [candidate('replacement')] })
  await assert.rejects(replacement.collectTaskResult(taskId), /已绑定 Adapter 不可用/)
})

test('重复注册身份和双配置在初始化时拒绝', () => {
  const store = new MemoryStore()
  assert.throws(() => createActivities({ store, adapters: [candidate('dup'), candidate('dup')] }), /ID 重复/)
  assert.throws(() => createActivities({ store, adapter: candidate('a'), adapters: [candidate('b')] }), /不能同时配置/)
})

test('Adapter 返回错误绑定身份时拒绝入账', async () => {
  const a = candidate('actual')
  const start = a.startTask.bind(a)
  a.startTask = async (env, ctx) => ({ ...await start(env, ctx), adapter: 'other-adapter' })
  const other = candidate('other')
  const { acts, store, taskId } = await fixture([a, other])
  await assert.rejects(acts.dispatchTask(taskId), /Adapter binding mismatch/)
  assert.equal((await store.getTask(taskId))!.binding, null)
  assert.equal(other.startCalls.length, 0)
})
