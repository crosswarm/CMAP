import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '#domain-model'
import type { Mission, RiskLevel, TaskEnvelopeV1 } from '#domain-model'
import type { AdapterHealth } from '#adapter-sdk'
import { createActivities } from '../../workflows/activities.ts'
import { FakeAdapter, syntheticRunner, syntheticActivityDeps } from './fake-adapter.ts'

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
async function fixture(adapters: FakeAdapter[], policy: Partial<TaskEnvelopeV1['execution_policy']> = {}, risk: RiskLevel = 'read-meta') {
  const store = new MemoryStore()
  const now = new Date().toISOString()
  const mission: Mission = { id: 'routing-mission', tenant: 'local', owner: 'test', type: 'inspect', goal: 'routing', constraints: {}, acceptance: [{ criterion_id: 'C1', metric: 'ok', operator: 'eq', expected: true, hard_gate: true }], workflow_template: 'inspect/v1', state: 'DRAFT', revision: 1, created_at: now, updated_at: now }
  await store.createMission({ mission, actor: ACTOR })
  const acts = createActivities(syntheticActivityDeps({ store, adapters, runner: syntheticRunner(), pollIntervalMs: 1 }))
  const taskId = 'routing-task'
  const envelope: TaskEnvelopeV1 = {
    schema:'cmap/task-envelope/v1',
    identity:{mission_id:mission.id,task_id:taskId,idempotency_key:taskId,revision:1,tenant:mission.tenant,owner:mission.owner},
    classification:{task_type:'inspect',requested_capability:'code.analyze',risk_level:risk},
    goal:{statement:mission.goal,success_definition:[{criterion_id:'C1',metric:'ok',operator:'eq',expected:true}]},
    environment:{},execution_policy:{timeout_seconds:30,max_attempts:1,...policy},
    permissions:{forbidden:[]},evidence_requirements:{required_artifact_roles:['report']},
    output_contract:{schema_uri:'https://cmap.local/schemas/task-result/v1'},
  }
  await store.createTask({actor:ACTOR,task:{id:taskId,mission_id:mission.id,parent_task_id:null,supersedes_task_id:null,capability:'code.analyze',risk,state:'DRAFT',attempt:1,max_attempts:1,lamport:0,envelope,result:null,binding:null,deps:[],created_at:now,updated_at:now}})
  await acts.markReady(taskId)
  if(risk==='controlled'||risk==='mutating') {
    // Synthetic authority for fake routing candidates only.
    const gate=await acts.requestApproval(taskId)
    await store.decideApproval(gate.approvalId!,'approved','test-harness:human',new Date().toISOString())
    await acts.waitForApproval({taskId,approvalId:gate.approvalId!,scope:risk})
  }
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
  const { acts, store, taskId } = await fixture([low, broken], {}, 'controlled')
  await assert.rejects(acts.dispatchTask(taskId), /没有可用 Adapter/)
  assert.equal(low.startCalls.length + broken.startCalls.length, 0)
  assert.equal((await store.getTask(taskId))!.state, 'READY')
})

test('注册表缺少已绑定 Adapter 时拒绝收取，不转给另一 Agent', async () => {
  const original = candidate('original')
  const { acts, store, taskId } = await fixture([original])
  await acts.dispatchTask(taskId)
  const replacement = createActivities(syntheticActivityDeps({ store, adapters: [candidate('replacement')], runner: syntheticRunner() }))
  await assert.rejects(replacement.collectTaskResult(taskId), /已绑定 Adapter 不可用/)
})

test('重复注册身份和双配置在初始化时拒绝', () => {
  const store = new MemoryStore()
  assert.throws(() => createActivities(syntheticActivityDeps({ store, adapters: [candidate('dup'), candidate('dup')], runner: syntheticRunner() })), /ID 重复/)
  assert.throws(() => createActivities(syntheticActivityDeps({ store, adapter: candidate('a'), adapters: [candidate('b')], runner: syntheticRunner() })), /不能同时配置/)
})

test('Adapter 返回错误绑定身份时拒绝入账', async () => {
  const a = candidate('actual')
  const start = a.startTask.bind(a)
  a.startTask = async (env, ctx) => ({ ...await start(env, ctx), adapter: 'other-adapter' })
  const other = candidate('other')
  const { acts, store, taskId } = await fixture([a, other])
  await assert.rejects(acts.dispatchTask(taskId), /Prepared dispatch contract mismatch/)
  const task = (await store.getTask(taskId))!
  assert.deepEqual(task.binding, {
    adapter: a.adapterId,
    remote_task_id: `fake:${taskId}`,
    protocol: 'fake-exec',
    protocol_version: '0.0.1',
    runner_id: 'runner-test',
  })
  assert.equal((await store.listEvents(task.mission_id)).filter((e) => e.event_type === 'TASK_STARTED').length, 0)
  assert.equal(other.startCalls.length, 0)
})

// 路由效率评测（实施计划 S0.0 C 层）：每次派发前的选择过程落 ROUTING_DECIDED 事件，供首选命中率、回落原因与决策耗时统计。
test('路由决策落事件：逐个候选记录判定与原因、选中者、是否回落与耗时', async () => {
  const primary = candidate('primary', ['code.analyze'], 'unavailable')
  const wrong = candidate('wrong', ['other'])
  const backup = candidate('backup')
  const { acts, store, taskId } = await fixture([primary, wrong, backup], { preferred_agent: 'primary', fallback_agents: ['ghost', 'wrong', 'backup'] })
  await acts.dispatchTask(taskId)
  const events = (await store.listEvents('routing-mission')).filter(e => e.event_type === 'ROUTING_DECIDED')
  assert.equal(events.length, 1)
  const payload = events[0]!.payload as any
  assert.equal(payload.chosen_agent, 'backup')
  assert.equal(payload.preferred_agent, 'primary')
  assert.equal(payload.fallback, true)
  assert.deepEqual(payload.candidates.map((c: any) => [c.agent_id, c.verdict, c.reason]), [
    ['primary', 'skipped', 'unhealthy'],
    ['ghost', 'skipped', 'not_registered'],
    ['wrong', 'skipped', 'capability'],
    ['backup', 'selected', null],
  ])
  assert.equal(typeof payload.decision_ms, 'number')
  assert.equal(events[0]!.task_id, taskId)
})

test('没有可用执行者时也先记录决策与原因再报错', async () => {
  const a = candidate('primary', ['code.analyze'], 'unavailable')
  const { acts, store, taskId } = await fixture([a], { preferred_agent: 'primary' })
  await assert.rejects(acts.dispatchTask(taskId), /没有可用 Adapter/)
  const [event] = (await store.listEvents('routing-mission')).filter(e => e.event_type === 'ROUTING_DECIDED')
  assert.equal((event!.payload as any).chosen_agent, null)
  assert.deepEqual((event!.payload as any).candidates.map((c: any) => c.reason), ['unhealthy'])
})

// ADR-0009 §1：health 带来的额度快照落账（账号级），供路由与审计。
test('派发前健康探测拿到的额度快照落账', async () => {
  const quota = {
    schema: 'cmap/quota-snapshot/v1', provider: 'codex', account_ref: 'b'.repeat(64),
    windows: [{ kind: 'primary', used_percent: 12, window_minutes: 10080, resets_at: null }],
    ordinary_usage_allowed: true, observed_at: new Date().toISOString(), status: 'ok',
  } as const
  const a = candidate('primary')
  a.health = async () => ({ state: 'healthy', checked_at: new Date().toISOString(), quota: structuredClone(quota) as any })
  const { acts, store, taskId } = await fixture([a])
  await acts.dispatchTask(taskId)
  assert.deepEqual(await store.getLatestQuotaSnapshot('codex', 'b'.repeat(64)), quota)
})
