import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { MemoryStore, type Mission, type MissionState } from '#domain-model'
import { createControlPlane } from '../../apps/control-plane-api/src/server.ts'

const mission = (id: string, state: MissionState, owner = 'configured-owner', tenant = 'local'): Mission => ({
  id, tenant, owner, type: 'inspect', goal: 'synthetic', constraints: { risk_level: 'read-meta' },
  acceptance: [{ criterion_id: 'c', metric: 'm', operator: 'eq', expected: 1, hard_gate: true }],
  workflow_template: 'inspect/v1', state, revision: 1, created_at: '2026-10-18T00:00:00.000Z', updated_at: '2026-10-18T00:00:00.000Z',
})

async function setup(t: TestContext, signal?: () => Promise<void>) {
  const store = new MemoryStore()
  const signals: { missionId: string; workflowId: string; reason: string }[] = []
  const server = await createControlPlane({
    store, tenant: 'local', owner: 'configured-owner',
    startMission: async () => {},
    cancelMission: async (missionId, workflowId, reason) => { signals.push({ missionId, workflowId, reason }); await signal?.() },
  })
  await server.listen(0)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const cancel = async (id: string, body: unknown) => {
    const res = await fetch(`${base}/v1/missions/${id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  return { store, signals, cancel }
}

const actor = { type: 'system', id: 'test' } as const

test('运行中的 Mission：先记取消原因事件，再向 Workflow 发信号；重复请求幂等', async (t) => {
  const { store, signals, cancel } = await setup(t)
  await store.createMission({ mission: mission('m-run', 'RUNNING'), actor })
  const res = await cancel('m-run', { reason: '需求变更' })
  assert.equal(res.status, 202)
  assert.deepEqual(res.body, { accepted: true, mission_id: 'm-run', workflow_id: 'mission-m-run' })
  assert.deepEqual(signals, [{ missionId: 'm-run', workflowId: 'mission-m-run', reason: '需求变更' }])
  const events = (await store.listEvents('m-run')).filter((e) => e.event_type === 'MISSION_CANCEL_REQUESTED')
  assert.equal(events.length, 1)
  assert.equal(events[0]!.payload['reason'], '需求变更')
  assert.equal(events[0]!.actor.type, 'human')
  assert.equal((await cancel('m-run', { reason: '需求变更' })).status, 202)
  assert.equal((await store.listEvents('m-run')).filter((e) => e.event_type === 'MISSION_CANCEL_REQUESTED').length, 1)
  assert.equal((await store.getMission('m-run'))!.state, 'RUNNING', '状态由 Workflow 收尾，API 不抢写')
})

test('DRAFT 直接落 CANCELED 不发信号；终态 409；他人 403；跨租户 404；坏请求 400；信号失败 503', async (t) => {
  const { store, signals, cancel } = await setup(t)
  await store.createMission({ mission: mission('m-draft', 'DRAFT'), actor })
  assert.equal((await cancel('m-draft', { reason: '不做了' })).status, 202)
  assert.equal((await store.getMission('m-draft'))!.state, 'CANCELED')
  assert.equal(signals.length, 0)
  for (const state of ['COMPLETED', 'FAILED', 'ESCALATED', 'CANCELED'] as const) {
    await store.createMission({ mission: mission(`m-${state}`, state), actor })
    assert.equal((await cancel(`m-${state}`, { reason: 'x' })).status, 409)
  }
  await store.createMission({ mission: mission('m-other', 'RUNNING', 'someone-else'), actor })
  assert.equal((await cancel('m-other', { reason: 'x' })).status, 403)
  await store.createMission({ mission: mission('m-tenant', 'RUNNING', 'configured-owner', 'other'), actor })
  assert.equal((await cancel('m-tenant', { reason: 'x' })).status, 404)
  await store.createMission({ mission: mission('m-bad', 'RUNNING'), actor })
  assert.equal((await cancel('m-bad', {})).status, 400)
  assert.equal((await cancel('m-bad', { reason: 'x', extra: 1 })).status, 400)
  assert.equal(signals.length, 0)

  const failing = await setup(t, async () => { throw new Error('temporal down') })
  await failing.store.createMission({ mission: mission('m-503', 'RUNNING'), actor })
  assert.equal((await failing.cancel('m-503', { reason: 'x' })).status, 503)
})
