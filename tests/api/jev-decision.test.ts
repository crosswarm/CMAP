/** S15：审批详情只读查询 Jev 影子决定（JEV_DECIDED 账本记录），不改审批。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { MemoryStore, type Approval, type Mission } from '#domain-model'
import { createControlPlane } from '../../apps/control-plane-api/src/server.ts'

const T0 = '2026-10-22T00:00:00.000Z'
const actor = { type: 'system', id: 'test' } as const
const mission = (id: string, tenant: string): Mission => ({
  id, tenant, owner: 'o', type: 'inspect', goal: 'g', constraints: {},
  acceptance: [], workflow_template: 'dag/v1', state: 'AWAITING_APPROVAL', revision: 1, created_at: T0, updated_at: T0,
})
const approval = (id: string, missionId: string): Approval => ({
  id, mission_id: missionId, task_id: `tsk-${id}`, action: 'code.analyze', scope: 'controlled',
  requested_by: 'system:r', risk_level: 'controlled', reason: 'r', evidence_artifact_ids: [],
  decision: 'pending', decided_by: null, decided_at: null, expires_at: '2099-01-01T00:00:00.000Z', created_at: T0,
})
const record = (approvalId: string, missionId: string) => ({
  schema: 'cmap/jev-decision/v1', decision_id: 'jvd_abc', decision_type: 'approval',
  subject: { mission_id: missionId, task_id: `tsk-${approvalId}`, approval_id: approvalId, approval_scope: 'controlled' },
  policy_id: 'pol_x', policy_sha256: 'a'.repeat(64), mode: 'shadow', input_sha256: 'b'.repeat(64),
  model: 'jev-test', confidence: 0.9, declared_risk: 'controlled', assessed_risk: 'low', effective_risk: 'medium',
  outcome: 'approve', route: 'human', reason_code: 'shadow_mode', decided_at: T0, elapsed_ms: 5,
})

test('GET /v1/approvals/:id/jev-decision：有记录返回 jev-decision；无记录或跨租户 404；审批不变', async (t) => {
  const store = new MemoryStore()
  const server = await createControlPlane({ store, tenant: 'local' })
  await server.listen(0)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const get = async (id: string) => { const r = await fetch(`${base}/v1/approvals/${id}/jev-decision`); return { status: r.status, body: await r.json() } }

  await store.createMission({ mission: mission('m-1', 'local'), actor })
  await store.createMission({ mission: mission('m-2', 'other'), actor })
  await store.createApproval(approval('apr-1', 'm-1'))
  await store.createApproval(approval('apr-2', 'm-2'))
  assert.equal((await get('apr-1')).status, 404, '尚无记录')

  for (const [id, m] of [['apr-1', 'm-1'], ['apr-2', 'm-2']] as const) {
    await store.appendEvent({ event: {
      event_type: 'JEV_DECIDED', event_version: 1, occurred_at: T0, mission_id: m, task_id: `tsk-${id}`, attempt: null,
      actor: { type: 'system', id: 'jev:jev-test' }, causation_id: null, correlation_id: m, trace_id: null,
      idempotency_key: `jev-decided:${id}`, payload: record(id, m),
    } })
  }
  const ok = await get('apr-1')
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, record('apr-1', 'm-1'))
  assert.equal((await get('apr-2')).status, 404, '跨租户不可见')
  assert.equal((await get('ghost')).status, 404)
  assert.equal((await store.getApproval('apr-1'))?.decision, 'pending')
})
