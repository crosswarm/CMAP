import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { request as httpRequest } from 'node:http'
import { MemoryStore } from '#domain-model'
import type { Mission } from '#domain-model'
import { createControlPlane } from '../../apps/control-plane-api/src/server.ts'

const input = {
  request_id: 'synthetic-create-1', goal: 'Count three synthetic files', risk_level: 'read-meta',
  acceptance: [{ criterion_id: 'files', metric: 'count', operator: 'eq', expected: 3 }],
}

const plan = {
  schema: 'cmap/mission-plan/v1',
  nodes: [{node_id:'count',goal:'Count files',capability:'code.analyze',deps:[],criterion_ids:['files'],risk_level:'read-meta'}],
}

test('DAG 请求保存规范化计划；默认值幂等，变更计划冲突', async (t) => {
  const {store,post} = await setup(t)
  const first = await post({...input,plan})
  assert.equal(first.status,202)
  const saved = (await store.getMission(first.body['mission_id'] as string))!
  assert.equal(saved.workflow_template,'dag/v1')
  assert.equal((saved.constraints['plan'] as {concurrency:number}).concurrency,2)
  assert.equal((await post({...input,plan:{...plan,concurrency:2}})).status,202)
  assert.equal((await post({...input,plan:{...plan,concurrency:3}})).status,409)
})

test('无效 DAG 在任何账本写入或启动之前拒绝', async (t) => {
  const {store,starts,post} = await setup(t)
  for (const node of [
    {...plan.nodes[0],deps:['count']},
    {...plan.nodes[0],deps:['missing']},
    {...plan.nodes[0],criterion_ids:['unknown']},
    {...plan.nodes[0],risk_level:'mutating'},
  ]) assert.equal((await post({...input,plan:{...plan,nodes:[node]}})).status,400)
  assert.equal((await store.queryMissions({tenant:'local'})).length,0)
  assert.equal(starts.length,0)
})

async function setup(t: TestContext, start?: (id: string) => Promise<void>, store = new MemoryStore(), tenant = 'local') {
  const starts: string[] = []
  const server = await createControlPlane({
    store, tenant, owner: 'configured-owner', startMission: async (id: string) => {
      starts.push(id)
      await start?.(id)
    },
  })
  await server.listen(0)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = async (value: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/v1/missions`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value),
    })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const postStart = async (id: string, value: unknown = {}, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/v1/missions/${id}/start`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value),
    })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  return { store, starts, base, post, postStart }
}

const mission = (id: string, owner = 'configured-owner', tenant = 'local', state: Mission['state'] = 'DRAFT'): Mission => ({
  id, tenant, owner, type: 'adhoc', goal: 'Recover existing mission', constraints: { original: true },
  acceptance: [], workflow_template: 'adhoc/v1', state, revision: 1,
  created_at: '2026-09-21T00:00:00.000Z', updated_at: '2026-09-21T00:00:00.000Z',
})

test('创建 Mission：身份来自控制面，复用验收标准并启动 Workflow', async (t) => {
  const { store, starts, post } = await setup(t)
  const { status, body } = await post(input)
  assert.equal(status, 202)
  assert.equal(body['accepted'], true)
  assert.equal(body['workflow_id'], `mission-${body['mission_id']}`)
  const mission = await store.getMission(body['mission_id'] as string)
  assert.equal(mission?.owner, 'configured-owner')
  assert.equal(mission?.tenant, 'local')
  assert.equal(mission?.acceptance[0]?.hard_gate, true)
  assert.deepEqual(starts, [mission!.id])
})

test('未配置创建能力时返回 503，不写入 Mission', async (t) => {
  const store = new MemoryStore()
  const server = await createControlPlane({ store, tenant: 'local' })
  await server.listen(0)
  t.after(() => server.close())
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/missions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  })
  assert.equal(response.status, 503)
  assert.equal((await store.queryMissions({ tenant: 'local' })).length, 0)
})

test('并发重复提交不重复 Mission/创建事件，已完成 Mission 不重启', async (t) => {
  const { store, starts, post } = await setup(t)
  const results = await Promise.all(Array.from({ length: 4 }, () => post(input)))
  assert.ok(results.every((r) => r.status === 202))
  const id = results[0]!.body['mission_id'] as string
  assert.equal(new Set(results.map((r) => r.body['mission_id'])).size, 1)
  assert.equal((await store.queryMissions({ tenant: 'local' })).length, 1)
  assert.equal((await store.listEvents(id)).filter((e) => e.event_type === 'MISSION_CREATED').length, 1)
  await store.setMissionState(id, 'COMPLETED', { type: 'system', id: 'test' })
  const count = starts.length
  assert.equal((await post(input)).status, 202)
  assert.equal(starts.length, count)
  assert.equal((await store.getMission(id))?.state, 'COMPLETED')
})

test('同请求键改变语义返回 409，不会重启或覆盖原目标', async (t) => {
  const { post, store } = await setup(t)
  const created = await post(input)
  assert.equal((await post({ ...input, goal: 'changed goal' })).status, 409)
  assert.equal((await store.getMission(created.body['mission_id'] as string))?.goal, input.goal)
})

test('Workflow 启动失败保留 DRAFT，原键重试恢复而非重建', async (t) => {
  let attempts = 0
  const { post, store } = await setup(t, async () => { if (++attempts === 1) throw new Error('synthetic outage') })
  const failed = await post(input)
  assert.equal(failed.status, 503)
  const id = failed.body['mission_id'] as string
  assert.equal((await store.getMission(id))?.state, 'DRAFT')
  const retry = await post(input)
  assert.equal(retry.status, 202)
  assert.equal(retry.body['mission_id'], id)
  assert.equal((await store.listEvents(id)).length, 1)
})

test('已落库 DRAFT 可按 Mission id 恢复启动，不创建或改写 Mission', async (t) => {
  let attempts = 0
  const { post, postStart, store, starts } = await setup(t, async () => { if (++attempts === 1) throw new Error('synthetic outage') })
  const failed = await post(input)
  assert.equal(failed.status, 503)
  const id = failed.body['mission_id'] as string
  const before = await store.getMission(id)
  assert.equal(before?.state, 'DRAFT')

  const recovered = await postStart(id)
  assert.equal(recovered.status, 202)
  assert.deepEqual(recovered.body, { accepted: true, mission_id: id, workflow_id: `mission-${id}` })
  assert.deepEqual(starts, [id, id])
  const after = await store.getMission(id)
  assert.equal(after?.goal, before?.goal)
  assert.deepEqual(after?.constraints, before?.constraints)
  assert.equal((await store.queryMissions({ tenant: 'local' })).length, 1)
})

test('重复 start 对非 DRAFT 幂等返回，不重复启动已终态 Mission', async (t) => {
  const { post, postStart, store, starts } = await setup(t)
  const created = await post(input)
  const id = created.body['mission_id'] as string
  await store.setMissionState(id, 'COMPLETED', { type: 'system', id: 'test' })
  const count = starts.length
  const again = await postStart(id)
  assert.equal(again.status, 202)
  assert.deepEqual(again.body, { accepted: true, mission_id: id, workflow_id: `mission-${id}` })
  assert.equal(starts.length, count)
})

test('start 校验 tenant 与本机 owner，未知 404、非本人 403', async (t) => {
  const store = new MemoryStore()
  await store.createMission({ mission: mission('mine'), actor: { type: 'system', id: 'test' } })
  await store.createMission({ mission: mission('not-mine', 'other-owner'), actor: { type: 'system', id: 'test' } })
  await store.createMission({ mission: mission('other-tenant', 'configured-owner', 'other'), actor: { type: 'system', id: 'test' } })
  const { postStart, starts } = await setup(t, undefined, store)

  assert.equal((await postStart('missing')).status, 404)
  assert.equal((await postStart('other-tenant')).status, 404)
  assert.equal((await postStart('not-mine')).status, 403)
  assert.deepEqual(starts, [])
})

test('start 缺启动能力或启动未确认返回 503 并保留原记录，body 只能是空对象', async (t) => {
  const store = new MemoryStore()
  await store.createMission({ mission: mission('draft-1'), actor: { type: 'system', id: 'test' } })
  const server = await createControlPlane({ store, tenant: 'local', owner: 'configured-owner' })
  await server.listen(0)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const unavailable = await fetch(`${base}/v1/missions/draft-1/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(unavailable.status, 503)
  assert.equal((await store.getMission('draft-1'))?.state, 'DRAFT')

  const failingStore = new MemoryStore()
  await failingStore.createMission({ mission: mission('draft-2'), actor: { type: 'system', id: 'test' } })
  const failing = await setup(t, async () => { throw new Error('synthetic outage') }, failingStore)
  assert.equal((await failing.postStart('draft-2')).status, 503)
  assert.equal((await failing.store.getMission('draft-2'))?.state, 'DRAFT')
  assert.equal((await failing.postStart('draft-2', { request_id: 'forged' })).status, 400)
})

test('跨租户相同请求键得到独立 Mission', async (t) => {
  const store = new MemoryStore()
  const a = await setup(t, undefined, store, 'a')
  const b = await setup(t, undefined, store, 'b')
  const first = await a.post(input)
  const second = await b.post(input)
  assert.equal(first.status, 202)
  assert.equal(second.status, 202)
  assert.notEqual(first.body['mission_id'], second.body['mission_id'])
  assert.equal((await fetch(`${a.base}/v1/missions/${second.body['mission_id']}`)).status, 404)
})

test('坏输入/越权字段/重复标准不入库、不派发', async (t) => {
  const { post, starts, store } = await setup(t)
  for (const patch of [
    { goal: ' ' }, { request_id: 'short' }, { tenant: 'other' }, { owner: 'forged' },
    { state: 'COMPLETED' }, { risk_level: 'unknown' }, { max_additional_cycles: -1 },
    { acceptance: [] }, { acceptance: [input.acceptance[0], input.acceptance[0]] },
  ]) assert.equal((await post({ ...input, ...patch })).status, 400)
  assert.equal(starts.length, 0)
  assert.equal((await store.queryMissions({ tenant: 'local' })).length, 0)
})

test('浏览器跨来源/opaque origin 和非 JSON 写入被拒绝', async (t) => {
  const { post, base } = await setup(t)
  for (const origin of ['https://untrusted.invalid', 'null']) {
    assert.equal((await post(input, { origin })).status, 403)
  }
  assert.equal((await post(input, { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await post(input, { origin: base })).status, 202)
})

test('DNS rebinding Host 和超大 JSON/chunked 请求不能触发执行', async (t) => {
  const { post, base, starts } = await setup(t)
  assert.equal((await post({ ...input, goal: 'x'.repeat(70_000) })).status, 413)
  const send = (host: string, chunks: string[]) => new Promise<number>((resolve, reject) => {
    const req = httpRequest(`${base}/v1/missions`, {
      method: 'POST', headers: { Host: host, 'content-type': 'application/json' },
    }, (res) => { res.resume(); resolve(res.statusCode!) })
    req.on('error', reject)
    for (const chunk of chunks) req.write(chunk)
    req.end()
  })
  assert.equal(await send('untrusted.invalid', [JSON.stringify(input)]), 403)
  assert.equal(await send(new URL(base).host, ['x'.repeat(40_000), 'x'.repeat(40_000)]), 413)
  assert.equal(starts.length, 0)
})

test('续作：continues_mission_id 必须指向本租户、本 owner 的已终结 Mission，否则 400 且不入账', async (t) => {
  const store = new MemoryStore()
  const base = { tenant: 'local', type: 'inspect', goal: 'prior', constraints: { risk_level: 'read-meta' },
    acceptance: [{ criterion_id: 'files', metric: 'count', operator: 'eq' as const, expected: 3, hard_gate: true }],
    workflow_template: 'inspect/v1', revision: 1, created_at: '2026-10-18T00:00:00.000Z', updated_at: '2026-10-18T00:00:00.000Z' }
  const actor = { type: 'system', id: 'test' } as const
  await store.createMission({ mission: { ...base, id: 'm-done', owner: 'configured-owner', state: 'ESCALATED' } as Mission, actor })
  await store.createMission({ mission: { ...base, id: 'm-live', owner: 'configured-owner', state: 'RUNNING' } as Mission, actor })
  await store.createMission({ mission: { ...base, id: 'm-foreign', owner: 'someone-else', state: 'COMPLETED' } as Mission, actor })
  await store.createMission({ mission: { ...base, id: 'm-tenant', tenant: 'other', owner: 'configured-owner', state: 'COMPLETED' } as Mission, actor })
  const { starts, post } = await setup(t, undefined, store)
  for (const [i, source] of ['m-live', 'm-foreign', 'm-tenant', 'm-missing'].entries()) {
    assert.equal((await post({ ...input, request_id: `synthetic-continue-${i}`, continues_mission_id: source })).status, 400, source)
  }
  assert.equal(starts.length, 0)
  const ok = await post({ ...input, request_id: 'synthetic-continue-ok', continues_mission_id: 'm-done' })
  assert.equal(ok.status, 202)
  assert.equal((await store.getMission(ok.body['mission_id'] as string))!.constraints['continues_mission_id'], 'm-done')
  assert.equal((await post({ ...input, request_id: 'synthetic-continue-plan', continues_mission_id: 'm-done', plan })).status, 400)
})
