import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryStore } from '#domain-model'
import type { Approval, Mission, Store } from '#domain-model'
import { createActivities } from '../../workflows/activities.ts'
import { FakeAdapter } from './fake-adapter.ts'

const ACTOR = { type: 'system', id: 'test' } as const
const T0 = '2026-08-31T00:00:00.000Z'

const mission = (id: string, risk: 'controlled' | 'mutating'): Mission => ({
  id, tenant: 'team-ycc', owner: 'crosswarm', type: 'inspect', goal: '执行受控操作',
  constraints: { risk_level: risk },
  acceptance: [{ criterion_id: 'C1', metric: 'ok', operator: 'eq', expected: true, hard_gate: true }],
  workflow_template: 'inspect/v1', state: 'DRAFT', revision: 1,
  created_at: T0, updated_at: T0,
})

const unrelatedApproval = (id: string, scope: 'controlled' | 'mutating'): Approval => ({
  id, mission_id: 'mis-1', task_id: 'other-task', action: 'other.action', scope,
  requested_by: 'system:test', risk_level: scope, reason: '另一项操作',
  evidence_artifact_ids: [], decision: 'pending', decided_by: null, decided_at: null,
  expires_at: '2099-01-01T00:00:00.000Z', created_at: T0,
})

let store: Store
let adapter: FakeAdapter
let acts: ReturnType<typeof createActivities>

beforeEach(() => {
  store = new MemoryStore()
  adapter = new FakeAdapter()
  acts = createActivities({
    store, adapter, pollIntervalMs: 1, approvalPollIntervalMs: 1,
    approvalWaitTimeoutMs: 1_000,
  })
})

const readyTask = async (risk: 'controlled' | 'mutating') => {
  await store.createMission({ mission: mission('mis-1', risk), actor: ACTOR })
  const { taskId } = await acts.createTask({ missionId: 'mis-1', capability: 'code.analyze' })
  await acts.markReady(taskId)
  return taskId
}

describe('审批 Activity', () => {
  test('等待预算耗尽与真人决定并发时，保留已落库的真人决定', async () => {
    const taskId = await readyTask('controlled')
    const id = `apr:${taskId}:controlled`
    await store.createApproval({ ...unrelatedApproval(id, 'controlled'), task_id: taskId })
    await acts.requestApproval(taskId)
    const decide = store.decideApproval.bind(store)
    store.decideApproval = async (approvalId, decision, actor, at) => {
      if (decision === 'expired') await decide(approvalId, 'approved', 'user:human', at)
      return decide(approvalId, decision, actor, at)
    }
    const expiring = createActivities({ store, adapter, approvalWaitTimeoutMs: 0 })
    const result = await expiring.waitForApproval({ taskId, approvalId: id, scope: 'controlled' })
    assert.equal(result.decision, 'approved')
    assert.equal((await store.getApproval(id))?.decided_by, 'user:human')
    assert.equal((await store.getTask(taskId))?.state, 'READY')
  })

  test('重试等待使用账本的到期时间，不重新延长过期审批', async () => {
    const taskId = await readyTask('controlled')
    const id = `apr:${taskId}:controlled`
    await store.createApproval({
      ...unrelatedApproval(id, 'controlled'), task_id: taskId,
      expires_at: '2026-09-01T00:00:00.000Z',
    })
    await acts.requestApproval(taskId)
    const get = store.getApproval.bind(store)
    let pendingReads = 0
    store.getApproval = async (approvalId) => {
      const a = await get(approvalId)
      if (a?.decision === 'pending' && ++pendingReads > 1) throw new Error('没有按账本期限立即过期')
      return a
    }
    const result = await acts.waitForApproval({ taskId, approvalId: id, scope: 'controlled' })
    assert.equal(result.decision, 'rejected')
    assert.equal((await store.getApproval(id))?.decision, 'expired')
    assert.equal(adapter.startCalls.length, 0)
  })

  test('受控任务创建对应 scope 的待审批并暂停', async () => {
    const taskId = await readyTask('controlled')

    const gate = await acts.requestApproval(taskId)

    assert.equal(gate.required, true)
    assert.equal(gate.scope, 'controlled')
    assert.equal((await store.getTask(taskId))?.state, 'APPROVAL_REQUIRED')
    const pending = await store.listPendingApprovals('mis-1')
    assert.equal(pending.length, 1)
    assert.equal(pending[0]?.task_id, taskId)
    assert.equal(pending[0]?.scope, 'controlled')
    assert.equal(adapter.startCalls.length, 0, '等待批准时绝不能调用 Adapter')
  })

  test('批准另一 scope 不放行；批准对应 scope 才恢复 READY', async () => {
    const taskId = await readyTask('mutating')
    const gate = await acts.requestApproval(taskId)
    assert.ok(gate.approvalId && gate.scope)

    await store.createApproval(unrelatedApproval('apr-controlled', 'controlled'))
    await store.decideApproval('apr-controlled', 'approved', 'user:human', T0)

    let settled = false
    const waiting = acts.waitForApproval({
      taskId, approvalId: gate.approvalId, scope: gate.scope,
    }).then((result) => { settled = true; return result })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(settled, false, 'controlled 的批准不得放行 mutating')
    assert.equal(adapter.startCalls.length, 0)

    await store.decideApproval(gate.approvalId, 'approved', 'user:human', new Date().toISOString())
    assert.equal((await waiting).decision, 'approved')
    assert.equal((await store.getTask(taskId))?.state, 'READY')
  })

  test('拒绝后任务落 REJECTED，Adapter 从未被调用', async () => {
    const taskId = await readyTask('controlled')
    const gate = await acts.requestApproval(taskId)
    assert.ok(gate.approvalId && gate.scope)

    await store.decideApproval(gate.approvalId, 'rejected', 'user:human', new Date().toISOString())
    const result = await acts.waitForApproval({
      taskId, approvalId: gate.approvalId, scope: gate.scope,
    })

    assert.equal(result.decision, 'rejected')
    assert.equal((await store.getTask(taskId))?.state, 'REJECTED')
    assert.equal(adapter.startCalls.length, 0)
  })

  test('read-meta 任务不创建审批', async () => {
    await store.createMission({
      mission: { ...mission('mis-1', 'controlled'), constraints: { risk_level: 'read-meta' } },
      actor: ACTOR,
    })
    const { taskId } = await acts.createTask({ missionId: 'mis-1', capability: 'code.analyze' })
    await acts.markReady(taskId)

    assert.deepEqual(await acts.requestApproval(taskId), { required: false })
    assert.equal((await store.listPendingApprovals()).length, 0)
  })
})
