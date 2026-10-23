import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '#domain-model'
import type { Mission, QuotaSnapshotV1, RiskLevel, TaskEnvelopeV1 } from '#domain-model'
import { AdapterError, type AdapterHealth } from '#adapter-sdk'
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
async function fixture(adapters: FakeAdapter[], policy: Partial<TaskEnvelopeV1['execution_policy']> = {}, risk: RiskLevel = 'read-meta', extra: object = {}) {
  const store = new MemoryStore()
  const now = new Date().toISOString()
  const mission: Mission = { id: 'routing-mission', tenant: 'local', owner: 'test', type: 'inspect', goal: 'routing', constraints: {}, acceptance: [{ criterion_id: 'C1', metric: 'ok', operator: 'eq', expected: true, hard_gate: true }], workflow_template: 'inspect/v1', state: 'DRAFT', revision: 1, created_at: now, updated_at: now }
  await store.createMission({ mission, actor: ACTOR })
  const acts = createActivities(syntheticActivityDeps({ store, adapters, runner: syntheticRunner(), pollIntervalMs: 1, ...extra }))
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

// ADR-0009 §3：Adapter 归一出的 QUOTA_EXHAUSTED 作为终态失败落账，与执行不确定区分。
test('收取时 Adapter 报 QUOTA_EXHAUSTED：任务结果为 failed 且 error.code 为 QUOTA_EXHAUSTED', async () => {
  const a = candidate('primary')
  a.collectResult = async () => { throw new AdapterError('QUOTA_EXHAUSTED', 'Codex 报告额度已耗尽', false, 'quota-exhausted:codex') }
  const { acts, store, taskId } = await fixture([a])
  await acts.dispatchTask(taskId)
  const collected = await acts.collectTaskResult(taskId)
  assert.equal((collected as any).status, 'failed')
  const result = (await store.getTask(taskId))!.result!
  assert.equal(result.status, 'failed')
  assert.equal(result.error?.code, 'QUOTA_EXHAUSTED')
  assert.equal(result.error?.retryable, false)
})

// ---------------------------------------------------------------- ADR-0009 §2 额度维度

let accounts = 0
const quotaOf = (used: number, overrides: Partial<QuotaSnapshotV1> = {}): QuotaSnapshotV1 => ({
  schema: 'cmap/quota-snapshot/v1', provider: 'codex', account_ref: (++accounts % 16).toString(16).repeat(64),
  windows: [{ kind: 'primary', used_percent: used, window_minutes: 10080, resets_at: null }],
  ordinary_usage_allowed: true, observed_at: new Date().toISOString(), status: 'ok', ...overrides,
})
const withQuota = (adapter: FakeAdapter, ...snapshots: (QuotaSnapshotV1 | undefined)[]) => {
  let calls = 0
  adapter.health = async () => {
    const quota = snapshots[Math.min(calls, snapshots.length - 1)]
    calls += 1
    return { state: 'healthy', checked_at: new Date().toISOString(), ...(quota ? { quota } : {}) }
  }
  return () => calls
}
const routed = async (store: MemoryStore) => {
  const [event] = (await store.listEvents('routing-mission')).filter(e => e.event_type === 'ROUTING_DECIDED')
  return event!.payload as any
}
const qfixture = (adapters: FakeAdapter[], policy: Partial<TaskEnvelopeV1['execution_policy']> = {}) =>
  fixture(adapters, policy, 'read-meta', { runner: syntheticRunner({ agents: adapters.map((a) => a.agentId) }) })
const verdicts = (payload: any) => payload.candidates.map((c: any) => [c.agent_id, c.verdict, c.reason])

test('额度低（已用 ≥ 90%）的首选记 skipped(quota_low)，新任务派给替补；判定与快照时刻落 ROUTING_DECIDED', async () => {
  const a = candidate('a')
  const b = candidate('b')
  const low = quotaOf(95)
  const ok = quotaOf(40)
  withQuota(a, low)
  withQuota(b, ok)
  const { acts, store, taskId } = await qfixture([a, b], { preferred_agent: 'a', fallback_agents: ['b'] })
  await acts.dispatchTask(taskId)
  assert.equal(a.startCalls.length, 0)
  assert.equal(b.startCalls.length, 1)
  const payload = await routed(store)
  assert.deepEqual(verdicts(payload), [['a', 'skipped', 'quota_low'], ['b', 'selected', null]])
  assert.deepEqual(payload.candidates.map((c: any) => [c.quota, c.quota_observed_at]), [['low', low.observed_at], ['sufficient', ok.observed_at]])
  assert.equal(payload.fallback, true)
})

test('提供方明确不允许普通用量（ordinary_usage_allowed=false）同样记 quota_low', async () => {
  const a = candidate('a')
  const b = candidate('b')
  withQuota(a, quotaOf(10, { ordinary_usage_allowed: false }))
  withQuota(b, quotaOf(10))
  const { acts, store, taskId } = await qfixture([a, b])
  await acts.dispatchTask(taskId)
  assert.equal(b.startCalls.length, 1)
  assert.deepEqual(verdicts(await routed(store)), [['a', 'skipped', 'quota_low'], ['b', 'selected', null]])
})

test('额度未知不改变首选顺序：只跳过已知额度不足的候选', async () => {
  const unknown = candidate('u')
  const known = candidate('k')
  withQuota(unknown, undefined)
  withQuota(known, quotaOf(20))
  const first = await qfixture([unknown, known])
  await first.acts.dispatchTask(first.taskId)
  assert.equal(unknown.startCalls.length, 1, '首选读不到额度（如 Kimi）时仍按首选派发，不被替补抢走')
  assert.equal(known.startCalls.length, 0)
  assert.deepEqual(verdicts(await routed(first.store)), [['u', 'selected', null]])

  const u2 = candidate('u')
  const errored = candidate('e')
  const lowest = candidate('l')
  withQuota(u2, quotaOf(0, { status: 'unknown', windows: [], account_ref: null }))
  withQuota(errored, quotaOf(0, { status: 'error', windows: [], account_ref: null }))
  withQuota(lowest, quotaOf(99))
  const second = await qfixture([lowest, u2, errored])
  await second.acts.dispatchTask(second.taskId)
  assert.equal(u2.startCalls.length, 1)
  assert.equal(errored.startCalls.length, 0, '选中后不再探测后续候选')
  assert.deepEqual(verdicts(await routed(second.store)), [['l', 'skipped', 'quota_low'], ['u', 'selected', null]])
})

test('快照过期（默认 5 分钟）时以 health 重新获取；仍过期则按未知处理', async () => {
  const stale = new Date(Date.now() - 6 * 60_000).toISOString()
  const a = candidate('a')
  const b = candidate('b')
  const aCalls = withQuota(a, quotaOf(10, { observed_at: stale }), quotaOf(97))
  withQuota(b, quotaOf(10))
  const { acts, store, taskId } = await qfixture([a, b])
  await acts.dispatchTask(taskId)
  assert.equal(aCalls(), 2, '过期快照触发一次重新获取')
  assert.equal(b.startCalls.length, 1)
  assert.deepEqual(verdicts(await routed(store)), [['a', 'skipped', 'quota_low'], ['b', 'selected', null]])

  const c = candidate('c')
  const d = candidate('d')
  withQuota(c, quotaOf(10, { observed_at: stale }))
  withQuota(d, quotaOf(10))
  const second = await qfixture([c, d])
  await second.acts.dispatchTask(second.taskId)
  assert.equal(c.startCalls.length, 1, '仍过期按未知处理：不改变首选顺序')
  assert.equal(d.startCalls.length, 0)
  assert.deepEqual((await routed(second.store)).candidates.map((x: any) => x.quota), ['unknown'])
})

test('阈值可由 CMAP_QUOTA_LOW_PERCENT 配置', async () => {
  const a = candidate('a')
  const b = candidate('b')
  withQuota(a, quotaOf(85))
  withQuota(b, quotaOf(10))
  process.env['CMAP_QUOTA_LOW_PERCENT'] = '80'
  try {
    const { acts, store, taskId } = await qfixture([a, b])
    await acts.dispatchTask(taskId)
    assert.equal(b.startCalls.length, 1)
    assert.deepEqual(verdicts(await routed(store)), [['a', 'skipped', 'quota_low'], ['b', 'selected', null]])
  } finally {
    delete process.env['CMAP_QUOTA_LOW_PERCENT']
  }
  const c = candidate('c')
  withQuota(c, quotaOf(85))
  const { acts, taskId } = await qfixture([c])
  await acts.dispatchTask(taskId)
  assert.equal(c.startCalls.length, 1, '默认阈值 90%，85% 仍可派')
})

test('所有候选额度都低时不派发，先记决策再报错', async () => {
  const a = candidate('a')
  withQuota(a, quotaOf(100))
  const { acts, store, taskId } = await qfixture([a])
  await assert.rejects(acts.dispatchTask(taskId), /没有可用 Adapter/)
  assert.equal(a.startCalls.length, 0)
  assert.deepEqual(verdicts(await routed(store)), [['a', 'skipped', 'quota_low']])
})

test('已绑定任务不因额度变化迁移：额度转低后重试派发仍复用原 binding', async () => {
  const a = candidate('a')
  const b = candidate('b')
  withQuota(a, quotaOf(10), quotaOf(99))
  withQuota(b, quotaOf(10))
  const { acts, store, taskId } = await qfixture([a, b])
  const first = await acts.dispatchTask(taskId)
  const again = await acts.dispatchTask(taskId)
  assert.equal(again.dispatched, false)
  assert.equal((again as any).remoteTaskId, (first as any).remoteTaskId)
  assert.equal(a.startCalls.length, 1)
  assert.equal(b.startCalls.length, 0)
  assert.equal((await store.getTask(taskId))!.binding!.adapter, 'a-adapter')
  assert.equal((await store.listEvents('routing-mission')).filter(e => e.event_type === 'ROUTING_DECIDED').length, 1)
})
