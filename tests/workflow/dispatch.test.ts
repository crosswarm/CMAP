/**
 * 派发与收结果：控制面真的把活交给 Agent，并把结果落进账本。
 *
 * 这里用假 Adapter（实现同一套 SPI）而不是真 codex：验证的是控制面这一侧
 * 的接线——调没调、落没落库、身份字段谁说了算。真实 codex 链路由
 * scripts/e2e-mission.mjs 覆盖，两者缺一不可：假 Adapter 证明逻辑正确，
 * 真链路证明它接的是真东西。
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryStore } from '#domain-model'
import type { Mission, Store, TaskEnvelopeV1 } from '#domain-model'
import { createActivities } from '../../workflows/activities.ts'
import { FakeAdapter } from './fake-adapter.ts'

const ACTOR = { type: 'system', id: 'test' } as const

const mission = (id: string): Mission => ({
  id,
  tenant: 'team-ycc',
  owner: 'crosswarm',
  type: 'inspect',
  goal: '统计 sample/ 下的文件数',
  constraints: {},
  acceptance: [
    { criterion_id: 'FILE-COUNT', metric: 'sample_file_count', operator: 'eq', expected: 3, hard_gate: true },
  ],
  workflow_template: 'inspect/v1',
  state: 'DRAFT',
  revision: 1,
  created_at: '2026-08-25T00:00:00.000Z',
  updated_at: '2026-08-25T00:00:00.000Z',
})

let store: Store
let adapter: FakeAdapter
let acts: ReturnType<typeof createActivities>

const newActs = () =>
  createActivities({ store, adapter, runnerId: 'runner-test', pollIntervalMs: 1 })

beforeEach(async () => {
  store = new MemoryStore()
  adapter = new FakeAdapter()
  acts = newActs()
  await store.createMission({ mission: mission('mis-1'), actor: ACTOR })
})

const startTask = async () => {
  const { taskId } = await acts.createTask({
    missionId: 'mis-1',
    capability: 'code.analyze',
    goal: '统计 sample/ 下的文件数',
  })
  await acts.markReady(taskId)
  return taskId
}

describe('信封由 Mission 派生', () => {
  test('目标与验收标准来自 Mission，不是写死的占位', async () => {
    const taskId = await startTask()
    const t = await store.getTask(taskId)
    const env = t?.envelope as TaskEnvelopeV1

    assert.equal(env.goal.statement, '统计 sample/ 下的文件数')
    assert.deepEqual(
      env.goal.success_definition.map((c) => c.criterion_id),
      ['FILE-COUNT'],
      '验收标准必须来自 Mission——写死的 C1 会让 Agent 回应一条不存在的标准',
    )
    assert.equal(env.goal.success_definition[0]?.expected, 3)
  })

  test('Mission 没有验收标准就不许派任务出去', async () => {
    await store.createMission({
      mission: { ...mission('mis-空'), acceptance: [] },
      actor: ACTOR,
    })
    await assert.rejects(
      () => acts.createTask({ missionId: 'mis-空', capability: 'code.analyze' }),
      /未声明验收标准/,
    )
  })

  test('租户与发起人写进信封身份，供跨租户隔离使用', async () => {
    const taskId = await startTask()
    const env = (await store.getTask(taskId))?.envelope as TaskEnvelopeV1
    assert.equal(env.identity.tenant, 'team-ycc')
    assert.equal(env.identity.owner, 'crosswarm')
  })
})

describe('派发真的调用 Adapter', () => {
  test('startTask 被调用，binding 落库', async () => {
    const taskId = await startTask()
    const out = await acts.dispatchTask(taskId)

    assert.equal(adapter.startCalls.length, 1, 'Adapter 必须被真实调用')
    assert.equal(out.dispatched, true)
    assert.equal((await store.getTask(taskId))?.binding?.remote_task_id, `fake:${taskId}`)
    assert.equal((await store.getTask(taskId))?.state, 'RUNNING')
  })

  test('重复派发不重复调用 Adapter（账本里的 binding 说了算）', async () => {
    const taskId = await startTask()
    await acts.dispatchTask(taskId)

    // 全新实例：模拟 Activity 重试落到另一个 Worker 进程
    const fresh = newActs()
    const retry = await fresh.dispatchTask(taskId)

    assert.equal(retry.dispatched, false)
    assert.equal(adapter.startCalls.length, 1, '重试不得再次 spawn Agent')
  })

  test('派发上下文带 runner_id 与截止时间，不是空壳', async () => {
    const taskId = await startTask()
    await acts.dispatchTask(taskId)

    const ctx = adapter.contexts[0]
    assert.equal(ctx?.runner_id, 'runner-test')
    assert.ok(ctx && Date.parse(ctx.deadline_at) > Date.now(), '截止时间必须是将来的时刻')
  })
})

describe('收结果并落账本', () => {
  test('结果写入账本，验收逐条可读回', async () => {
    const taskId = await startTask()
    await acts.dispatchTask(taskId)

    const out = await acts.collectTaskResult(taskId)

    assert.equal(out.passed, true)
    assert.equal(out.status, 'completed')
    const t = await store.getTask(taskId)
    assert.equal(t?.result?.summary, '干完了')
    assert.equal(t?.result?.criterion_results[0]?.criterion_id, 'FILE-COUNT')
  })

  test('身份字段由控制面填充，不采信 Agent 自述', async () => {
    const taskId = await startTask()
    await acts.dispatchTask(taskId)
    await acts.collectTaskResult(taskId)

    const t = await store.getTask(taskId)
    assert.equal(t?.result?.task_id, taskId, 'Agent 自报的 task_id 必须被覆盖')
    assert.equal(t?.result?.mission_id, 'mis-1')
  })

  test('证据产物落库，可被 Evidence Pack 检索', async () => {
    const taskId = await startTask()
    await acts.dispatchTask(taskId)
    await acts.collectTaskResult(taskId)

    const arts = await store.listArtifacts(taskId)
    assert.equal(arts.length, 1)
    assert.equal(arts[0]?.role, 'report')
    const t = await store.getTask(taskId)
    assert.equal(arts[0]?.sha256, t?.result?.artifacts[0]?.sha256, '账本里的哈希要与结果一致')
    assert.equal(arts[0]?.mission_id, 'mis-1')
  })

  test('两个任务的 Agent 都自称 report 时，证据各归各的', async () => {
    // 真实跑出来的缺陷：codex 把证据命名为 `report`，第二次跑就跟第一条
    // 撞主键。PG 静默保留旧行、内存版静默覆盖——第二个任务变成「有结论没证据」。
    const a = await startTask()
    await acts.dispatchTask(a)
    await acts.collectTaskResult(a)

    const b = await startTask()
    await acts.dispatchTask(b)
    await acts.collectTaskResult(b)

    assert.equal((await store.listArtifacts(a)).length, 1, '先跑的任务证据不得被顶掉')
    assert.equal((await store.listArtifacts(b)).length, 1, '后跑的任务必须也有证据')
  })

  test('结论里的证据引用指向账本里的 id，链路不断', async () => {
    const taskId = await startTask()
    await acts.dispatchTask(taskId)
    await acts.collectTaskResult(taskId)

    const t = await store.getTask(taskId)
    const refs = t?.result?.criterion_results[0]?.evidence_artifact_ids ?? []
    const ids = (await store.listArtifacts(taskId)).map((x) => x.artifact_id)
    assert.ok(refs.length > 0, '结论必须能追溯到证据')
    for (const r of refs) {
      assert.ok(ids.includes(r), `结论引用的证据 ${r} 在账本里找不到`)
    }
  })

  test('重复收取不重复写证据（Activity 重试是常态）', async () => {
    const taskId = await startTask()
    await acts.dispatchTask(taskId)
    await acts.collectTaskResult(taskId)
    await newActs().collectTaskResult(taskId)

    assert.equal((await store.listArtifacts(taskId)).length, 1)
  })

  test('验收未通过时 passed 为 false，并列出失败标准', async () => {
    const taskId = await startTask()
    adapter.result = {
      schema: 'cmap/task-result/v1',
      mission_id: 'x', task_id: 'x', attempt: 1,
      status: 'completed',
      summary: '只找到 2 个文件',
      criterion_results: [{ criterion_id: 'FILE-COUNT', actual: 2, passed: false }],
      artifacts: [],
    }
    await acts.dispatchTask(taskId)
    const out = await acts.collectTaskResult(taskId)

    assert.equal(out.passed, false)
    assert.deepEqual(out.failedCriteria, ['FILE-COUNT'])
  })

  test('Agent 漏答某条验收标准即判不通过（沉默不是通过）', async () => {
    const taskId = await startTask()
    adapter.result = {
      schema: 'cmap/task-result/v1',
      mission_id: 'x', task_id: 'x', attempt: 1,
      status: 'completed',
      summary: '干完了',
      criterion_results: [],
      artifacts: [],
    }
    await acts.dispatchTask(taskId)
    const out = await acts.collectTaskResult(taskId)

    assert.equal(out.passed, false)
    assert.deepEqual(out.failedCriteria, ['FILE-COUNT'])
  })

  test('等不到终态时明确超时失败，不静默挂起', async () => {
    const taskId = await startTask()
    adapter.runningRounds = Number.MAX_SAFE_INTEGER
    await acts.dispatchTask(taskId)

    await assert.rejects(
      () => createActivities({ store, adapter, pollIntervalMs: 1, waitTimeoutMs: 5 }).collectTaskResult(taskId),
      /超时/,
    )
    assert.equal(adapter.cancelCalls.length, 1, '超时后必须终止 Agent，不能留下孤儿进程继续占资源')
  })
})
