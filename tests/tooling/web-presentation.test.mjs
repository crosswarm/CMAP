import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptanceRows, approvalPayload, expectedValue, stateTone, missionDisplayState } from '../../apps/web/src/presentation.ts'

test('正常资源等待与等待审批不能使用相同的行动提示', () => {
  assert.equal(stateTone('WAITING_RESOURCE'), 'neutral')
  assert.equal(stateTone('APPROVAL_REQUIRED'), 'attention')
})

test('任务队列从实际Task状态区分资源等待和需要人工输入', () => {
  assert.equal(missionDisplayState({ state: 'RUNNING' }, [{ state: 'WAITING_RESOURCE' }]), 'WAITING_RESOURCE')
  assert.equal(missionDisplayState({ state: 'RUNNING' }, [{ state: 'INPUT_REQUIRED' }]), 'INPUT_REQUIRED')
  assert.equal(missionDisplayState({ state: 'COMPLETED' }, [{ state: 'WAITING_RESOURCE' }]), 'COMPLETED')
})

test('前端不把未经评审的 Agent 自报通过显示成验收通过，漏答单独表达', () => {
  const mission = { acceptance: [{ criterion_id: 'a' }, { criterion_id: 'b' }] }
  const task = { id: 't', created_at: '2026-09-21T00:00:00Z', result: { criterion_results: [{ criterion_id: 'a', actual: 3, passed: true }] } }
  assert.deepEqual(acceptanceRows(mission, [task], []).map((r) => r.state), ['pending', 'unanswered'])
  const reviews = [{ round: 1, reviewed_task_ids: ['t'], decision: { failed_criteria: [{ criterion_id: 'a', reason: '控制面核验失败' }] } }]
  assert.equal(acceptanceRows(mission, [task], reviews)[0].state, 'failed')
})

test('旧账本自报通过也不能覆盖明确不达标的 actual', () => {
  const mission = { acceptance: [{ criterion_id: 'a', operator: 'eq', expected: 3 }] }
  const task = { id: 't', created_at: '2026-09-21T00:00:00Z', result: { criterion_results: [{ criterion_id: 'a', actual: '5', passed: true }] } }
  const reviews = [{ round: 1, reviewed_task_ids: ['t'], decision: { decision: 'accept' } }]
  assert.equal(acceptanceRows(mission, [task], reviews)[0].state, 'failed')
})

test('首轮尚无结果时不编造上轮结果提示', () => {
  const mission = { acceptance: [{ criterion_id: 'a', operator: 'eq', expected: 3 }] }
  const task = { id: 't', created_at: '2026-09-21T00:00:00Z', result: null }
  assert.equal(acceptanceRows(mission, [task], [])[0].previousRound, false)
})

test('批准当前 scope 不会合并另一类授权，过期或已处理不可再批', () => {
  const approval = { scope: 'controlled', decision: 'pending', expires_at: '2099-01-01T00:00:00Z' }
  assert.deepEqual(approvalPayload(approval, 'controlled', 'approved', 'test:operator'), { scope: 'controlled', decision: 'approved', decided_by: 'test:operator' })
  assert.throws(() => approvalPayload(approval, 'mutating', 'approved', 'test:operator'))
  assert.throws(() => approvalPayload({ ...approval, decision: 'approved' }, 'controlled', 'approved', 'test:operator'))
  assert.throws(() => approvalPayload({ ...approval, expires_at: '2000-01-01T00:00:00Z' }, 'controlled', 'approved', 'test:operator'))
})

test('数字和布尔验收不会把空输入、NaN 或任意文本当有效值', () => {
  assert.equal(expectedValue('number', '3'), 3)
  assert.equal(expectedValue('boolean', 'false'), false)
  for (const value of ['', 'NaN', 'Infinity']) assert.throws(() => expectedValue('number', value))
  assert.throws(() => expectedValue('boolean', 'yes'))
})
