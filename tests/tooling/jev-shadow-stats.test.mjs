import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '#domain-model'
import { shadowAgreement } from '../../scripts/jev-shadow-stats.mjs'

const T0 = '2026-10-22T00:00:00.000Z'
const actor = { type: 'system', id: 'test' }

test('影子一致率：只比较真人终态（approved/rejected），统计一致数与 Jev 通过而真人拒绝数；按租户隔离', async () => {
  const store = new MemoryStore()
  for (const [id, tenant] of [['m1', 'local'], ['m2', 'other']]) {
    await store.createMission({ actor, mission: { id, tenant, owner: 'o', type: 'inspect', goal: 'g', constraints: {}, acceptance: [],
      workflow_template: 'dag/v1', state: 'RUNNING', revision: 1, created_at: T0, updated_at: T0 } })
  }
  const cases = [
    ['a1', 'm1', 'approve', 'approved'],
    ['a2', 'm1', 'approve', 'rejected'],
    ['a3', 'm1', 'reject', 'rejected'],
    ['a4', 'm1', 'escalate', 'approved'],
    ['a5', 'm1', 'approve', 'pending'],
    ['a6', 'm1', 'approve', 'expired'],
    ['a7', 'm2', 'approve', 'rejected'],
  ]
  for (const [id, missionId, outcome, decision] of cases) {
    await store.createApproval({ id, mission_id: missionId, task_id: `t-${id}`, action: 'x', scope: 'controlled', requested_by: 's',
      risk_level: 'controlled', reason: 'r', evidence_artifact_ids: [], decision: 'pending', decided_by: null, decided_at: null,
      expires_at: '2099-01-01T00:00:00.000Z', created_at: T0 })
    if (decision !== 'pending') await store.decideApproval(id, decision, decision === 'expired' ? 'system:timeout' : 'crosswarm', T0)
    await store.appendEvent({ event: { event_type: 'JEV_DECIDED', event_version: 1, occurred_at: T0, mission_id: missionId, task_id: `t-${id}`,
      attempt: null, actor: { type: 'system', id: 'jev:test' }, causation_id: null, correlation_id: missionId, trace_id: null,
      idempotency_key: `jev-decided:${id}`, payload: { outcome, subject: { approval_id: id } } } })
  }
  assert.deepEqual(await shadowAgreement(store, 'local'), { total: 6, compared: 4, agree: 2, jev_approve_human_reject: 1 })
})
