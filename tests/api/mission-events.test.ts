import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { MemoryStore } from '#domain-model'
import type { Mission, TaskEvent } from '#domain-model'
import { createControlPlane } from '../../apps/control-plane-api/src/server.ts'

const actor = { type: 'system' as const, id: 'sse-test' }
const mission = (id: string, tenant = 'local'): Mission => ({
  id, tenant, owner: 'test', type: 'inspect', goal: 'synthetic test', constraints: {},
  acceptance: [], workflow_template: 'inspect/v1', state: 'DRAFT', revision: 1,
  created_at: '2026-09-20T00:00:00Z', updated_at: '2026-09-20T00:00:00Z',
})

async function setup(t: TestContext) {
  const store = new MemoryStore()
  await store.createMission({ mission: mission('visible'), actor })
  await store.createMission({ mission: mission('hidden', 'other'), actor })
  const server = await createControlPlane({ store, tenant: 'local' })
  await server.listen(0)
  t.after(() => server.close())
  return { store, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

async function connect(base: string, cursor?: string) {
  const abort = new AbortController()
  const res = await fetch(`${base}/v1/missions/visible/events`, {
    headers: cursor ? { 'Last-Event-ID': cursor } : {}, signal: abort.signal,
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type')!, /^text\/event-stream/)
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffered = ''
  return {
    close: () => abort.abort(),
    async next(): Promise<{ id: string; data: Record<string, unknown> }> {
      for (;;) {
        const split = buffered.indexOf('\n\n')
        if (split >= 0) {
          const frame = buffered.slice(0, split)
          buffered = buffered.slice(split + 2)
          if (!frame.includes('event: mission-event\n')) continue
          return {
            id: frame.match(/^id: (.*)$/m)![1]!,
            data: JSON.parse(frame.match(/^data: (.*)$/m)![1]!),
          }
        }
        const chunk = await reader.read()
        assert.equal(chunk.done, false, 'stream unexpectedly ended')
        buffered += chunk.value
      }
    },
  }
}

test('SSE 历史、实时事件、双客户端独立推送，事件不泄漏 payload', { timeout: 6000 }, async (t) => {
  const { store, base } = await setup(t)
  const a = await connect(base)
  t.after(a.close)
  const b = await connect(base)
  t.after(b.close)
  const first = await a.next()
  assert.equal(first.data['event_type'], 'MISSION_CREATED')
  assert.deepEqual(await b.next(), first)
  await store.setMissionState('visible', 'RUNNING', actor)
  const second = await a.next()
  assert.equal(second.data['event_type'], 'MISSION_STATE_CHANGED')
  assert.equal(second.data['mission_id'], 'visible')
  assert.equal(second.data['schema'], 'cmap/mission-event/v1')
  assert.equal('payload' in second.data, false)
  assert.equal('actor' in second.data, false)
  assert.deepEqual(await b.next(), second)
  assert.equal((await store.listUndeliveredEvents(100)).length, 3)
})

test('SSE 重连完整回放，可按 event_id 去重且不漏断线事件', { timeout: 6000 }, async (t) => {
  const { store, base } = await setup(t)
  const a = await connect(base)
  const first = await a.next()
  a.close()
  await store.setMissionState('visible', 'RUNNING', actor)
  const b = await connect(base, first.id)
  t.after(b.close)
  assert.deepEqual(await b.next(), first)
  assert.equal((await b.next()).data['event_type'], 'MISSION_STATE_CHANGED')
})

test('SSE 拒绝跨租户、缺失 Mission 以及未知或其他 Mission 的游标', async (t) => {
  const { store, base } = await setup(t)
  for (const id of ['hidden', 'absent']) {
    const res = await fetch(`${base}/v1/missions/${id}/events`)
    assert.equal(res.status, 404)
  }
  const hidden = (await store.listEvents('hidden'))[0]!
  for (const cursor of ['unknown', hidden.event_id]) {
    const res = await fetch(`${base}/v1/missions/visible/events`, { headers: { 'Last-Event-ID': cursor } })
    assert.equal(res.status, 400)
  }
})

test('SSE 不以 lamport 高水位跳过晚提交事件', { timeout: 6000 }, async (t) => {
  const { store, base } = await setup(t)
  const original = store.listEvents.bind(store)
  let late: TaskEvent | undefined
  store.listEvents = async (id) => {
    const events = await original(id)
    return id === 'visible' && late ? [late, ...events] : events
  }
  const a = await connect(base)
  t.after(a.close)
  await a.next()
  const first = (await original('visible'))[0]!
  late = { ...first, event_id: 'late-commit', lamport: 0 }
  assert.equal((await a.next()).id, 'late-commit')
})

test('SSE server.close 会关闭活跃连接，不等待客户端断开', { timeout: 3000 }, async (t) => {
  const { server, base } = await setup(t)
  const a = await connect(base)
  t.after(a.close)
  await a.next()
  await server.close()
})
