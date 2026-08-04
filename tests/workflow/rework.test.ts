/**
 * 返工闭环测试 —— P1 出口。
 *
 * 验证的是最初那个痛点的解法：把评审者的「不满意」从一句自然语言评论，
 * 变成控制面可直接执行的后继任务，人不必再当传递者。
 *
 * 需要本地栈运行中（同 mission.test.ts）。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'

import { MemoryStore } from '#domain-model'
import type { Mission, Store, EventActor, ReviewDecisionV1 } from '#domain-model'
import { createActivities } from '../../workflows/activities.ts'

const ACTOR: EventActor = { type: 'system', id: 'test' }
const T0 = '2026-08-04T00:00:00.000Z'

let store: Store

const mission = (id: string): Mission => ({
  id, tenant: 'team-ycc', owner: 'crosswarm', type: 'perf',
  goal: '首屏 P95 降到 1800ms', constraints: {},
  acceptance: [{ criterion_id: 'PERF-P95', metric: 'p95_ms', operator: 'lte', expected: 1800, hard_gate: true }],
  workflow_template: 'perf/v1', state: 'RUNNING', revision: 1,
  created_at: T0, updated_at: T0,
})

const reworkDecision = (taskId: string, maxCycles = 2): ReviewDecisionV1 => ({
  schema: 'cmap/review-decision/v1',
  mission_id: 'mis-rw',
  reviewed_task_ids: [taskId],
  decision: 'rework',
  hard_gate_summary: { total: 1, passed: 0, failed: 1 },
  failed_criteria: [
    { criterion_id: 'PERF-P95', expected: '<= 1800 ms', actual: '1914 ms', reason: '低端设备未达标' },
  ],
  required_followups: [
    { capability: 'codex.performance.root_cause', task_type: 'performance.analyze', focus: ['config-api-serialization'] },
  ],
  stop_conditions: { max_additional_cycles: maxCycles },
  review_confidence: { level: 'high' },
}) as ReviewDecisionV1

const acceptDecision = (taskId: string): ReviewDecisionV1 => ({
  schema: 'cmap/review-decision/v1',
  mission_id: 'mis-rw',
  reviewed_task_ids: [taskId],
  decision: 'accept',
  hard_gate_summary: { total: 1, passed: 1, failed: 0 },
  review_confidence: { level: 'high' },
}) as ReviewDecisionV1

before(() => { store = new MemoryStore() })
after(() => {})

/** 把任务推到可评审状态 */
const toReviewable = async (acts: ReturnType<typeof createActivities>, missionId: string) => {
  const { taskId } = await acts.createTask({ missionId, capability: 'code.analyze', goal: '优化首屏' })
  await acts.markReady(taskId)
  await acts.dispatchTask(taskId)
  await acts.beginReview(taskId)
  return taskId
}

describe('返工闭环', () => {
  test('rework 决策创建后继 Task，并以 supersedes 关联原任务', async () => {
    const acts = createActivities({ store })
    await store.createMission({ mission: mission('mis-rw'), actor: ACTOR })

    const taskId = await toReviewable(acts, 'mis-rw')
    const out = await acts.applyReviewDecision({
      taskId, decision: reworkDecision(taskId), round: 1,
    })

    assert.equal(out.outcome, 'rework')
    assert.equal(out.followupTaskIds.length, 1, '应按 required_followups 创建后继任务')

    const followup = await store.getTask(out.followupTaskIds[0]!)
    assert.equal(
      followup?.supersedes_task_id,
      taskId,
      'supersedes 断裂会让「第几轮卡在哪」无法追溯——正是最初痛点的核心',
    )
    assert.equal(followup?.capability, 'codex.performance.root_cause')
  })

  test('原任务落 COMPLETED，不回到 RUNNING', async () => {
    const acts = createActivities({ store })
    await store.createMission({ mission: mission('mis-rw2'), actor: ACTOR })

    const taskId = await toReviewable(acts, 'mis-rw2')
    await acts.applyReviewDecision({ taskId, decision: reworkDecision(taskId), round: 1 })

    const orig = await store.getTask(taskId)
    assert.equal(
      orig?.state,
      'COMPLETED',
      '原任务已尽其责，返工由新任务承担。原地重跑会覆盖上一轮证据',
    )
  })

  test('accept 决策不创建后继任务', async () => {
    const acts = createActivities({ store })
    await store.createMission({ mission: mission('mis-rw3'), actor: ACTOR })

    const taskId = await toReviewable(acts, 'mis-rw3')
    const out = await acts.applyReviewDecision({
      taskId, decision: acceptDecision(taskId), round: 1,
    })

    assert.equal(out.outcome, 'accept')
    assert.deepEqual(out.followupTaskIds, [])
    assert.equal((await store.getTask(taskId))?.state, 'COMPLETED')
  })

  test('轮次达到 max_additional_cycles 时停止返工并升级', async () => {
    const acts = createActivities({ store })
    await store.createMission({ mission: mission('mis-rw4'), actor: ACTOR })

    const taskId = await toReviewable(acts, 'mis-rw4')
    const out = await acts.applyReviewDecision({
      taskId,
      decision: reworkDecision(taskId, 2),
      round: 2, // 已达上限
    })

    assert.equal(out.outcome, 'escalated')
    assert.deepEqual(out.followupTaskIds, [], '预算耗尽后不得再建后继任务')
    assert.ok(out.escalationReason?.includes('轮次'), '升级原因需说明是预算耗尽')

    // 只断言返回值不够：若 escalate 漏掉状态落库，返回值照样正确，
    // 而账本里任务仍停在 REVIEWING、Mission 仍是 RUNNING，无人知晓。
    assert.equal(
      (await store.getTask(taskId))?.state,
      'FAILED_TERMINAL',
      '升级后任务必须落终态，否则会被当作仍在进行',
    )
    assert.equal(
      (await store.getMission('mis-rw4'))?.state,
      'ESCALATED',
      'Mission 必须标记为已升级，否则不会出现在待人工处理的列表里',
    )
  })

  test('检测到无进展时停止返工并升级', async () => {
    const acts = createActivities({ store })
    await store.createMission({ mission: mission('mis-rw5'), actor: ACTOR })

    const taskId = await toReviewable(acts, 'mis-rw5')
    const identical = {
      patchHash: 'same', failedCriteriaIds: ['PERF-P95'],
      metricValue: 1900, errorFingerprint: 'TIMEOUT',
    }

    const out = await acts.applyReviewDecision({
      taskId,
      decision: reworkDecision(taskId, 5), // 预算充足
      round: 1,
      previousProgress: identical,
      currentProgress: identical,
    })

    assert.equal(out.outcome, 'escalated', '无进展时即便预算充足也应停止')
    assert.ok(out.escalationReason?.includes('无进展'))

    assert.equal((await store.getTask(taskId))?.state, 'FAILED_TERMINAL')
    assert.equal((await store.getMission('mis-rw5'))?.state, 'ESCALATED')
  })

  test('重复调用 applyReviewDecision 不产生重复 review 与孤儿后继任务', async () => {
    const acts = createActivities({ store })
    await store.createMission({ mission: mission('mis-idem'), actor: ACTOR })

    const taskId = await toReviewable(acts, 'mis-idem')
    const decision = reworkDecision(taskId, 3)

    const first = await acts.applyReviewDecision({ taskId, decision, round: 1 })
    const tasksAfterFirst = (await store.queryTasks({ missionId: 'mis-idem' })).length
    const reviewsAfterFirst = (await store.listReviews('mis-idem')).length

    // Activity 重试：Temporal 超时后会真正重跑，且可能落到另一个 Worker 进程
    const second = await acts.applyReviewDecision({ taskId, decision, round: 1 })

    assert.deepEqual(
      second.followupTaskIds,
      first.followupTaskIds,
      '重试必须复用已建的后继任务，而非再建一批',
    )
    assert.equal(
      (await store.queryTasks({ missionId: 'mis-idem' })).length,
      tasksAfterFirst,
      '重复调用产生孤儿任务会让「第几轮」的计数失真',
    )
    assert.equal(
      (await store.listReviews('mis-idem')).length,
      reviewsAfterFirst,
      '重复的评审记录会污染返工轮次追溯',
    )
  })

  test('端到端：执行 → 评审 rework → 后继任务 → 再评审 accept → 完成', async () => {
    const acts = createActivities({ store })
    await store.createMission({ mission: mission('mis-e2e'), actor: ACTOR })

    // 第一轮：执行后被打回
    const round1 = await toReviewable(acts, 'mis-e2e')
    const r1 = await acts.applyReviewDecision({
      taskId: round1, decision: reworkDecision(round1, 3), round: 1,
    })
    assert.equal(r1.outcome, 'rework')

    // 第二轮：后继任务执行后通过
    const round2 = r1.followupTaskIds[0]!
    await acts.markReady(round2)
    await acts.dispatchTask(round2)
    await acts.beginReview(round2)

    const r2 = await acts.applyReviewDecision({
      taskId: round2, decision: acceptDecision(round2), round: 2,
    })
    assert.equal(r2.outcome, 'accept')

    // 因果链完整：能从第二轮回溯到第一轮
    const t2 = await store.getTask(round2)
    assert.equal(t2?.supersedes_task_id, round1)
    assert.equal(t2?.state, 'COMPLETED')

    // 两轮都留在账本里，证据未被覆盖
    const all = await store.queryTasks({ missionId: 'mis-e2e' })
    assert.equal(all.length, 2, '返工派生新任务，两轮各自留痕')

    // 事件流记录了返工决策
    const events = await store.listEvents('mis-e2e')
    assert.ok(
      events.some((e) => e.event_type === 'REVIEW_REWORK_REQUESTED'),
      '返工必须在审计流中可见',
    )
  })
})
