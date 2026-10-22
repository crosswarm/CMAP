import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { MemoryStore } from '#domain-model'
import type { Mission } from '#domain-model'
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
    return { status: res.status, body: await res.json() as { items?: Mission[] } }
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
