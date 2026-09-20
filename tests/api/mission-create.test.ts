import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { request as httpRequest } from 'node:http'
import { MemoryStore } from '#domain-model'
import { createControlPlane } from '../../apps/control-plane-api/src/server.ts'

const input = {
  request_id: 'synthetic-create-1', goal: 'Count three synthetic files', risk_level: 'read-meta',
  acceptance: [{ criterion_id: 'files', metric: 'count', operator: 'eq', expected: 3 }],
}

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
  return { store, starts, base, post }
}

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
