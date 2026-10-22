/**
 * S02：审批决定落账后向 Mission Workflow 按门铃（approvalDecided），信号不带业务数据；
 * 发送失败只记录，不影响已落账的 HTTP 结果。
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { MemoryStore, type Approval, type Mission } from '#domain-model'
import { createControlPlane } from '../../apps/control-plane-api/src/server.ts'

const OWNER = 'configured-owner'
const actor = { type: 'system', id: 'test' } as const
const T0 = '2026-10-22T00:00:00.000Z'

const mission = (id: string): Mission => ({
  id, tenant: 'local', owner: OWNER, type: 'inspect', goal: 'synthetic', constraints: { risk_level: 'controlled' },
  acceptance: [{ criterion_id: 'c', metric: 'm', operator: 'eq', expected: 1, hard_gate: true }],
  workflow_template: 'dag/v1', state: 'AWAITING_APPROVAL', revision: 1, created_at: T0, updated_at: T0,
})
const approval = (id: string, missionId: string): Approval => ({
  id, mission_id: missionId, task_id: `tsk-${id}`, action: 'yonwork.chat_send', scope: 'controlled',
  requested_by: 'agent:codex', risk_level: 'controlled', reason: 'synthetic', evidence_artifact_ids: [],
  decision: 'pending', decided_by: null, decided_at: null, expires_at: '2099-01-01T00:00:00.000Z', created_at: T0,
})

async function setup(t: TestContext, notify: (missionId: string, workflowId: string) => Promise<void>) {
  const store = new MemoryStore()
  const server = await createControlPlane({ store, tenant: 'local', owner: OWNER, notifyApprovalDecided: notify })
  await server.listen(0)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const decide = async (id: string, body: unknown) => {
    const res = await fetch(`${base}/v1/approvals/${id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  return { store, decide }
}

test('决定落账后向 mission-<id> 发 approvalDecided 门铃；拒绝的请求不发', async (t) => {
  const rung: [string, string][] = []
  const { store, decide } = await setup(t, async (missionId, workflowId) => {
    // 门铃必须在落账之后：此刻回读账本已是终态。
    assert.equal((await store.getApproval('apr-1'))?.decision, 'approved')
    rung.push([missionId, workflowId])
  })
  await store.createMission({ mission: mission('m-1'), actor })
  await store.createApproval(approval('apr-1', 'm-1'))

  assert.equal((await decide('apr-1', { decision: 'approved', scope: 'mutating', decided_by: OWNER })).status, 409)
  assert.equal(rung.length, 0, '未落账的请求不得按门铃')
  const ok = await decide('apr-1', { decision: 'approved', scope: 'controlled', decided_by: OWNER })
  assert.equal(ok.status, 200)
  assert.deepEqual(rung, [['m-1', 'mission-m-1']])
})

test('门铃发送失败只记录：HTTP 仍返回已落账的决定', async (t) => {
  const { store, decide } = await setup(t, async () => { throw new Error('temporal down') })
  await store.createMission({ mission: mission('m-2'), actor })
  await store.createApproval(approval('apr-2', 'm-2'))
  const res = await decide('apr-2', { decision: 'rejected', scope: 'controlled', decided_by: OWNER })
  assert.equal(res.status, 200)
  assert.equal(res.body['decision'], 'rejected')
  assert.equal((await store.getApproval('apr-2'))?.decision, 'rejected')
})
