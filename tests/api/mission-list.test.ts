import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { MemoryStore } from '#domain-model'
import type { Mission, MissionAttention, TaskRecord } from '#domain-model'
import { createControlPlane } from '../../apps/control-plane-api/src/server.ts'

const actor = { type: 'system' as const, id: 'list-test' }
const mission = (id: string, state: Mission['state'], second: number): Mission => ({
  id, tenant: 'local', owner: 'test', type: 'inspect', goal: 'synthetic test', constraints: {},
  acceptance: [], workflow_template: 'inspect/v1', state, revision: 1,
  created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, second)).toISOString(),
  updated_at: '2026-10-01T00:00:00Z',
})

async function setup(t: TestContext) {
  const store = new MemoryStore()
  for (let i = 0; i < 60; i++) await store.createMission({ mission: mission(`done-${i}`, 'COMPLETED', i), actor })
  for (let i = 0; i < 3; i++) await store.createMission({ mission: mission(`live-${i}`, 'RUNNING', i), actor })
  const server = await createControlPlane({ store, tenant: 'local' })
  await server.listen(0)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return async (query = '') => {
    const res = await fetch(`${base}/v1/missions${query}`)
    return { status: res.status, body: await res.json() as { items?: Array<Mission & { attention?: MissionAttention }> } }
  }
}

test('GET /v1/missions 默认返回全部非终态加最近 50 条终态', async (t) => {
  const list = await setup(t)
  const { status, body } = await list()
  assert.equal(status, 200)
  const ids = body.items!.map((m) => m.id)
  assert.equal(ids.length, 53)
  assert.equal(ids.filter((id) => id.startsWith('live-')).length, 3)
  assert.equal(ids.includes('done-9'), false)
  assert.equal(ids.includes('done-10'), true)
})

test('terminal_limit 可调整终态条数，非法值返回 400', async (t) => {
  const list = await setup(t)
  assert.equal((await list('?terminal_limit=5')).body.items!.length, 8)
  assert.equal((await list('?terminal_limit=0')).body.items!.length, 3)
  for (const bad of ['abc', '-1', '1.5', '501', '']) {
    assert.equal((await list(`?terminal_limit=${bad}`)).status, 400, bad)
  }
})

test('每个 Mission 附带需要人处理的任务数摘要，一次查询、无任务者为全 0，终态 Mission 全 0', async (t) => {
  const store = new MemoryStore()
  await store.createMission({ mission: mission('live-a', 'RUNNING', 1), actor })
  await store.createMission({ mission: mission('live-b', 'RUNNING', 2), actor })
  await store.createMission({ mission: mission('done-a', 'COMPLETED', 3), actor })
  const task = (id: string, missionId: string, state: TaskRecord['state']) => ({
    id, mission_id: missionId, parent_task_id: null, supersedes_task_id: null, capability: 'code.analyze',
    risk: 'read-meta', state, attempt: 1, max_attempts: 1, lamport: 0, envelope: {}, result: null, binding: null,
    deps: [], created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  }) as unknown as TaskRecord
  for (const [id, m, state] of [['t1', 'live-a', 'INPUT_REQUIRED'], ['t2', 'live-a', 'APPROVAL_REQUIRED'], ['t3', 'live-a', 'RUNNING'], ['t4', 'done-a', 'FAILED_TERMINAL']] as const) {
    await store.createTask({ task: task(id, m, state), actor })
  }
  let attentionQueries = 0
  const original = store.countMissionAttention.bind(store)
  store.countMissionAttention = async (tenant) => { attentionQueries++; return original(tenant) }
  const server = await createControlPlane({ store, tenant: 'local' })
  await server.listen(0)
  t.after(() => server.close())
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/missions`)
  const { items } = await res.json() as { items: Array<Mission & { attention: MissionAttention }> }
  const byId = Object.fromEntries(items.map((m) => [m.id, m.attention]))
  assert.deepEqual(byId['live-a'], { INPUT_REQUIRED: 1, AUTH_REQUIRED: 0, APPROVAL_REQUIRED: 1, FAILED_TERMINAL: 0 })
  assert.deepEqual(byId['live-b'], { INPUT_REQUIRED: 0, AUTH_REQUIRED: 0, APPROVAL_REQUIRED: 0, FAILED_TERMINAL: 0 })
  assert.deepEqual(byId['done-a'], { INPUT_REQUIRED: 0, AUTH_REQUIRED: 0, APPROVAL_REQUIRED: 0, FAILED_TERMINAL: 0 })
  assert.equal(attentionQueries, 1)
})
