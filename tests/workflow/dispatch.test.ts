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
import type { Artifact, Mission, RemoteTaskBinding, Store, TaskEnvelopeV1, TaskResultV1 } from '#domain-model'
import { AdapterError } from '#adapter-sdk'
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

class TerminalCollectErrorAdapter extends FakeAdapter {
  override async collectResult(_binding: RemoteTaskBinding): Promise<TaskResultV1> {
    throw new AdapterError(
      'RESULT_UNPARSABLE',
      'raw provider output with prompt and stack',
      false,
      'result-unparsable',
    )
  }
}

class TransientCollectErrorAdapter extends FakeAdapter {
  override async collectResult(_binding: RemoteTaskBinding): Promise<TaskResultV1> {
    throw new AdapterError(
      'TASK_STILL_RUNNING',
      '任务尚未结束',
      true,
      'still-running',
    )
  }
}

class TerminalTaskCollectErrorAdapter extends FakeAdapter {
  readonly #code: 'TASK_FAILED' | 'TASK_CANCELED'

  constructor(code: 'TASK_FAILED' | 'TASK_CANCELED') {
    super()
    this.#code = code
  }

  override async collectResult(_binding: RemoteTaskBinding): Promise<TaskResultV1> {
    throw new AdapterError(
      this.#code,
      'raw provider output with prompt and stack',
      false,
      this.#code.toLowerCase().replace('_', '-'),
    )
  }
}

class CountingAdapter extends FakeAdapter {
  statusCalls = 0
  collectCalls = 0

  override async getStatus(binding?: RemoteTaskBinding) {
    void binding
    this.statusCalls += 1
    return super.getStatus()
  }

  override async collectResult(binding: RemoteTaskBinding): Promise<TaskResultV1> {
    this.collectCalls += 1
    return super.collectResult(binding)
  }
}

class FailingArtifactStore extends MemoryStore {
  failPutArtifactOnce = true

  override async putArtifact(a: Artifact): Promise<Artifact> {
    if (this.failPutArtifactOnce) {
      this.failPutArtifactOnce = false
      throw new Error('putArtifact failed once')
    }
    return super.putArtifact(a)
  }
}

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

  test('等待资源解除后可直接派发，不回退到 QUEUED', async () => {
    const taskId = await startTask()
    await store.transitionTask({
      taskId,
      to: 'QUEUED',
      actor: ACTOR,
      eventType: 'TASK_ASSIGNED',
      idempotencyKey: `queued-before-waiting:${taskId}`,
    })
    await store.transitionTask({
      taskId,
      to: 'WAITING_RESOURCE',
      actor: ACTOR,
      eventType: 'RESOURCE_LOCK_REQUESTED',
      idempotencyKey: `waiting-before-dispatch:${taskId}`,
    })

    const out = await acts.dispatchTask(taskId)

    assert.equal(out.dispatched, true)
    assert.equal(adapter.startCalls.length, 1)
    assert.equal((await store.getTask(taskId))?.state, 'RUNNING')
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

  test('结果已缓存但证据落库失败时，重试只修复 registry，不重跑 Adapter', async () => {
    store = new FailingArtifactStore()
    const counting = new CountingAdapter()
    adapter = counting
    acts = newActs()
    await store.createMission({ mission: mission('mis-1'), actor: ACTOR })
    const taskId = await startTask()
    await acts.dispatchTask(taskId)

    await assert.rejects(
      () => acts.collectTaskResult(taskId),
      /putArtifact failed once/,
    )
    const cached = await store.getTask(taskId)
    assert.equal(cached?.result?.artifacts[0]?.artifact_id, `${taskId}:report`)
    assert.equal((await store.listArtifacts(taskId)).length, 0)
    const statusCalls = counting.statusCalls
    const collectCalls = counting.collectCalls

    const out = await acts.collectTaskResult(taskId)

    assert.equal(out.passed, true)
    assert.equal(counting.statusCalls, statusCalls, '缓存结果修复不得重新轮询 Adapter')
    assert.equal(counting.collectCalls, collectCalls, '缓存结果修复不得重新 collect Adapter')
    const artifacts = await store.listArtifacts(taskId)
    assert.equal(artifacts.length, 1)
    assert.equal(artifacts[0]?.artifact_id, `${taskId}:report`)
    assert.equal(
      (await store.getTask(taskId))?.result?.criterion_results[0]?.evidence_artifact_ids?.[0],
      `${taskId}:report`,
    )
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

  test('Agent 自报通过但 actual 不满足时，控制面复算为未通过并落库', async () => {
    const taskId = await startTask()
    adapter.result = {
      schema: 'cmap/task-result/v1',
      mission_id: 'x', task_id: 'x', attempt: 1,
      status: 'completed',
      summary: '自报通过但数量不对',
      criterion_results: [{ criterion_id: 'FILE-COUNT', actual: 5, passed: true }],
      artifacts: [],
    }
    await acts.dispatchTask(taskId)
    const out = await acts.collectTaskResult(taskId)

    assert.equal(out.passed, false)
    assert.deepEqual(out.failedCriteria, ['FILE-COUNT'])
    assert.equal((await store.getTask(taskId))?.result?.criterion_results[0]?.passed, false)
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

  test('终态收结果的受控 AdapterError 落成 failed TaskResult，不让任务卡 RUNNING', async () => {
    adapter = new TerminalCollectErrorAdapter()
    acts = newActs()
    const taskId = await startTask()
    await acts.dispatchTask(taskId)

    const out = await acts.collectTaskResult(taskId)
    const t = await store.getTask(taskId)

    assert.equal(out.status, 'failed')
    assert.equal(out.passed, false)
    assert.deepEqual(out.failedCriteria, ['FILE-COUNT'])
    assert.equal(t?.state, 'RUNNING', '收结果只落结果，状态推进仍交给后续硬门槛路径')
    assert.equal(t?.result?.mission_id, 'mis-1')
    assert.equal(t?.result?.task_id, taskId)
    assert.equal(t?.result?.attempt, t?.attempt)
    assert.equal(t?.result?.status, 'failed')
    assert.equal(t?.result?.summary, 'Adapter 终态结果收取失败：RESULT_UNPARSABLE')
    assert.deepEqual(t?.result?.criterion_results, [], '不得伪造任何验收标准通过')
    assert.deepEqual(t?.result?.artifacts, [])
    assert.equal(t?.result?.error?.code, 'RESULT_UNPARSABLE')
    assert.equal(t?.result?.error?.fingerprint, 'result-unparsable')
    assert.doesNotMatch(t?.result?.error?.message ?? '', /raw provider output|prompt|stack/)
  })

  test('非终态 collectResult AdapterError 继续抛出，不落 failed 结果', async () => {
    adapter = new TransientCollectErrorAdapter()
    acts = newActs()
    const taskId = await startTask()
    await acts.dispatchTask(taskId)

    await assert.rejects(
      () => acts.collectTaskResult(taskId),
      (err) => err instanceof AdapterError && err.code === 'TASK_STILL_RUNNING',
    )
    assert.equal((await store.getTask(taskId))?.result, null)
  })

  for (const code of ['TASK_FAILED', 'TASK_CANCELED'] as const) {
    test(`已确认终态的 ${code} 落成 failed TaskResult`, async () => {
      adapter = new TerminalTaskCollectErrorAdapter(code)
      acts = newActs()
      const taskId = await startTask()
      await acts.dispatchTask(taskId)

      const out = await acts.collectTaskResult(taskId)
      const result = (await store.getTask(taskId))?.result

      assert.equal(out.status, 'failed')
      assert.equal(out.passed, false)
      assert.equal(result?.status, 'failed')
      assert.equal(result?.error?.code, code)
      assert.equal(result?.error?.fingerprint, code.toLowerCase().replace('_', '-'))
      assert.deepEqual(result?.criterion_results, [])
      assert.deepEqual(result?.artifacts, [])
      assert.doesNotMatch(result?.error?.message ?? '', /raw provider output|prompt|stack/)
    })
  }

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
