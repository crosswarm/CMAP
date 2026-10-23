/** Q05：WebUI 只读查询各账号最新额度快照与 Mission 内的额度交接链路（ADR-0009 §5）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { MemoryStore, type Mission, type QuotaSnapshotV1 } from '#domain-model'
import { createControlPlane } from '../../apps/control-plane-api/src/server.ts'

const T0 = '2026-10-23T00:00:00.000Z'
const actor = { type: 'system', id: 'test' } as const
const mission = (id: string, tenant: string): Mission => ({
  id, tenant, owner: 'o', type: 'inspect', goal: 'g', constraints: {},
  acceptance: [], workflow_template: 'dag/v1', state: 'RUNNING', revision: 1, created_at: T0, updated_at: T0,
})
const snapshot = (account: string, observedAt: string, used: number): QuotaSnapshotV1 => ({
  schema: 'cmap/quota-snapshot/v1', provider: 'codex', account_ref: account.repeat(64),
  windows: [{ kind: 'secondary', used_percent: used, window_minutes: 10080, resets_at: null }],
  ordinary_usage_allowed: true, observed_at: observedAt, status: 'ok',
})
const handoff = (missionId: string, index: number) => ({
  schema: 'cmap/quota-handoff/v1', node_id: 'n1', from_task_id: `${missionId}-t${index}`, to_task_id: `${missionId}-t${index + 1}`,
  handoff_index: index, from_agent: 'codex', excluded_agents: ['codex'], risk_level: 'read-meta', workspace: 'fresh', snapshot: null, exit_proof: null,
})

test('GET /v1/quota-snapshots 返回各账号最新快照；GET /v1/missions/:id/quota-handoffs 按发生顺序返回交接记录，跨租户 404', async (t) => {
  const store = new MemoryStore()
  const server = await createControlPlane({ store, tenant: 'local' })
  await server.listen(0)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const get = async (path: string) => { const r = await fetch(`${base}${path}`); return { status: r.status, body: await r.json() as any } }

  await store.putQuotaSnapshot(snapshot('a', T0, 96))
  const latest = snapshot('a', '2026-10-23T01:00:00.000Z', 3)
  await store.putQuotaSnapshot(latest)
  const quota = await get('/v1/quota-snapshots')
  assert.equal(quota.status, 200)
  assert.deepEqual(quota.body, { items: [latest] })

  await store.createMission({ mission: mission('m-1', 'local'), actor })
  await store.createMission({ mission: mission('m-2', 'other'), actor })
  for (const [m, i] of [['m-1', 1], ['m-1', 2], ['m-2', 1]] as const) {
    await store.appendEvent({ event: {
      event_type: 'QUOTA_HANDOFF', event_version: 1, occurred_at: T0, mission_id: m, task_id: `${m}-t${i + 1}`, attempt: 1,
      actor, causation_id: null, correlation_id: m, trace_id: `${m}-t${i}`, idempotency_key: `quota-handoff:${m}-t${i}`, payload: handoff(m, i),
    } })
  }
  const chain = await get('/v1/missions/m-1/quota-handoffs')
  assert.equal(chain.status, 200)
  assert.deepEqual(chain.body, { items: [handoff('m-1', 1), handoff('m-1', 2)] })
  assert.equal((await get('/v1/missions/m-2/quota-handoffs')).status, 404, '跨租户不可见')
  assert.equal((await get('/v1/missions/ghost/quota-handoffs')).status, 404)
})
