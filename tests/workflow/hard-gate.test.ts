/**
 * 硬门槛判定：把「验收没过」变成控制面可执行的返工决策。
 *
 * 这一步刻意**不用 LLM**。让模型回答「过没过」得到的是主观判断，既不可
 * 复现也无法审计；而验收标准本来就是机读的，比一比就有答案。
 * 软判断（Claude 评审）仍可覆盖在其之上，但不得推翻硬指标。
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryStore } from '#domain-model'
import type { Mission, Store, TaskResultV1 } from '#domain-model'
import { createActivities } from '../../workflows/activities.ts'
import { FakeAdapter } from './fake-adapter.ts'

const ACTOR = { type: 'system', id: 'test' } as const

const mission = (id: string, constraints: Record<string, unknown> = {}): Mission => ({
  id,
  tenant: 'team-ycc',
  owner: 'crosswarm',
  type: 'perf',
  goal: '把首屏 P95 降到 1800ms 以内',
  constraints,
  acceptance: [
    { criterion_id: 'PERF-P95', metric: 'p95_ms', operator: 'lte', expected: 1800, hard_gate: true },
    { criterion_id: 'NO-REGRESS', metric: 'error_rate', operator: 'lte', expected: 0.01, hard_gate: true },
  ],
  workflow_template: 'perf/v1',
  state: 'DRAFT',
  revision: 1,
  created_at: '2026-08-25T00:00:00.000Z',
  updated_at: '2026-08-25T00:00:00.000Z',
})

const resultWith = (
  criteria: readonly { id: string; passed: boolean; actual: unknown }[],
  error?: TaskResultV1['error'],
): TaskResultV1 => ({
  schema: 'cmap/task-result/v1',
  mission_id: 'x',
  task_id: 'x',
  attempt: 1,
  status: 'completed',
  summary: '跑完了',
  criterion_results: criteria.map((c) => ({
    criterion_id: c.id,
    actual: c.actual,
    passed: c.passed,
    evidence_artifact_ids: ['report'],
  })),
  artifacts: [
    {
      artifact_id: 'report', role: 'report', uri: 'evidence/report.json',
      media_type: 'application/json', size_bytes: 42, sha256: 'a'.repeat(64),
    },
  ],
  ...(error ? { error } : {}),
})

let store: Store
let adapter: FakeAdapter
let acts: ReturnType<typeof createActivities>

beforeEach(async () => {
  store = new MemoryStore()
  adapter = new FakeAdapter()
  acts = createActivities({ store, adapter, pollIntervalMs: 1 })
})

/** 跑完一个任务并停在「已收结果」这一步。 */
const runTask = async (missionId: string, result?: TaskResultV1) => {
  if (result) adapter.result = result
  const { taskId } = await acts.createTask({ missionId, capability: 'perf.optimize' })
  await acts.markReady(taskId)
  await acts.dispatchTask(taskId)
  await acts.collectTaskResult(taskId)
  return taskId
}

describe('硬门槛判定', () => {
  test('标准全过则 accept', async () => {
    await store.createMission({ mission: mission('mis-1'), actor: ACTOR })
    const taskId = await runTask('mis-1', resultWith([
      { id: 'PERF-P95', passed: true, actual: 1500 },
      { id: 'NO-REGRESS', passed: true, actual: 0.001 },
    ]))

    const { decision } = await acts.evaluateHardGate({ taskId, round: 0 })

    assert.equal(decision.decision, 'accept')
    assert.deepEqual(decision.hard_gate_summary, { total: 2, passed: 2, failed: 0 })
  })

  test('有标准没过则 rework，并逐条说明期望与实测', async () => {
    await store.createMission({ mission: mission('mis-1'), actor: ACTOR })
    const taskId = await runTask('mis-1', resultWith([
      { id: 'PERF-P95', passed: false, actual: 2400 },
      { id: 'NO-REGRESS', passed: true, actual: 0.001 },
    ]))

    const { decision } = await acts.evaluateHardGate({ taskId, round: 0 })

    assert.equal(decision.decision, 'rework')
    assert.equal(decision.hard_gate_summary.failed, 1)
    const failed = decision.failed_criteria ?? []
    assert.equal(failed.length, 1)
    assert.equal(failed[0]?.criterion_id, 'PERF-P95')
    assert.ok(failed[0]?.expected.includes('1800'), `期望值要写清楚，实际是 ${failed[0]?.expected}`)
    assert.ok(failed[0]?.actual.includes('2400'), '实测值要写清楚，否则返工时不知道差多少')
    assert.ok((failed[0]?.evidence ?? []).length > 0, '判定必须指向具体证据')
  })

  test('已存旧结果自报通过但 actual 不满足时仍 rework', async () => {
    await store.createMission({ mission: mission('mis-1'), actor: ACTOR })
    const taskId = await runTask('mis-1', resultWith([
      { id: 'PERF-P95', passed: true, actual: 1500 },
      { id: 'NO-REGRESS', passed: true, actual: '' },
    ]))

    const t = await store.getTask(taskId)
    if (t?.result?.criterion_results[1]) {
      t.result.criterion_results[1] = { ...t.result.criterion_results[1], passed: true }
    }

    const { decision } = await acts.evaluateHardGate({ taskId, round: 0 })

    assert.equal(decision.decision, 'rework')
    const failed = decision.failed_criteria ?? []
    assert.equal(failed.length, 1)
    assert.equal(failed[0]?.criterion_id, 'NO-REGRESS')
  })

  test('漏答的标准同样算没过，理由要说清是「没答」', async () => {
    await store.createMission({ mission: mission('mis-1'), actor: ACTOR })
    const taskId = await runTask('mis-1', resultWith([
      { id: 'PERF-P95', passed: true, actual: 1500 },
    ]))

    const { decision } = await acts.evaluateHardGate({ taskId, round: 0 })

    assert.equal(decision.decision, 'rework')
    const missed = (decision.failed_criteria ?? []).find((c) => c.criterion_id === 'NO-REGRESS')
    assert.ok(missed, '没被回应的标准必须出现在失败清单里')
    assert.ok(/未回应|没答|缺/.test(missed.reason), `理由应说明是漏答，实际是「${missed.reason}」`)
  })

  test('返工带后继任务与轮次预算', async () => {
    await store.createMission({
      mission: mission('mis-1', { max_additional_cycles: 3 }),
      actor: ACTOR,
    })
    const taskId = await runTask('mis-1', resultWith([
      { id: 'PERF-P95', passed: false, actual: 2400 },
      { id: 'NO-REGRESS', passed: true, actual: 0.001 },
    ]))

    const { decision } = await acts.evaluateHardGate({ taskId, round: 0 })

    assert.equal(decision.stop_conditions?.max_additional_cycles, 3, '预算来自 Mission')
    const followups = decision.required_followups ?? []
    assert.equal(followups.length, 1)
    assert.equal(followups[0]?.capability, 'perf.optimize', '后继任务沿用同一能力')
    assert.ok(
      (followups[0]?.focus ?? []).some((f) => f.includes('PERF-P95')),
      'focus 要指明这一轮该收敛哪条标准，否则下一轮可能重复无效尝试',
    )
  })

  test('没有 Mission 的轮次预算时给默认值，不是无限重试', async () => {
    await store.createMission({ mission: mission('mis-1'), actor: ACTOR })
    const taskId = await runTask('mis-1', resultWith([{ id: 'PERF-P95', passed: false, actual: 2400 }]))

    const { decision } = await acts.evaluateHardGate({ taskId, round: 0 })
    const budget = decision.stop_conditions?.max_additional_cycles
    assert.ok(typeof budget === 'number' && budget > 0 && budget <= 5, `预算应是个小的正数，实际 ${budget}`)
  })

  test('进展快照取自结果，供无进展检测比对', async () => {
    await store.createMission({ mission: mission('mis-1'), actor: ACTOR })
    const taskId = await runTask('mis-1', resultWith(
      [
        { id: 'PERF-P95', passed: false, actual: 2400 },
        { id: 'NO-REGRESS', passed: true, actual: 0.001 },
      ],
      { code: 'TIMEOUT', message: '压测超时', retryable: true, fingerprint: 'timeout:perf' },
    ))

    const { progress } = await acts.evaluateHardGate({ taskId, round: 0 })

    assert.deepEqual(progress.failedCriteriaIds, ['PERF-P95'])
    assert.equal(progress.metricValue, 2400, '主指标取第一条未过标准的实测值')
    assert.equal(progress.errorFingerprint, 'timeout:perf')
    assert.ok(progress.patchHash.length > 0, '证据哈希充当 patchHash——没有它就无从判断这轮动没动东西')
  })

  test('没收到结果就评审要报错，不得凭空判定', async () => {
    await store.createMission({ mission: mission('mis-1'), actor: ACTOR })
    const { taskId } = await acts.createTask({ missionId: 'mis-1', capability: 'perf.optimize' })

    await assert.rejects(() => acts.evaluateHardGate({ taskId, round: 0 }), /没有结果|尚未/)
  })
})
