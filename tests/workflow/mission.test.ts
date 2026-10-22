/**
 * Mission Workflow 集成测试。
 *
 * 用真实 Temporal（本地栈）而非 TestWorkflowEnvironment——后者要下载
 * test server 二进制，且模拟环境无法验证「真的能跑」。ADR-0005 要求的
 * 正是这一点：Temporal 此前是「装好了但从未用过」的状态。
 *
 * 需要本地栈运行中：
 *   docker compose -f infra/docker-compose/docker-compose.yml up -d
 *   node scripts/verify-temporal.mjs
 *
 * 本文件不在默认 npm test 内（npm run test:workflow 单独跑）。
 * 数据库或 Temporal 不可用时明确失败，不跳过——那等于用沉默替代验证。
 */
import { test, describe, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'

import { Worker, NativeConnection } from '@temporalio/worker'
import { Client, Connection } from '@temporalio/client'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { MemoryStore } from '#domain-model'
import type { Mission, RemoteTaskBinding, Store, TaskResultV1 } from '#domain-model'
import { AdapterError } from '#adapter-sdk'
import { createActivities } from '../../workflows/activities.ts'
import { FakeAdapter, FileFakeAdapter, syntheticRunner, syntheticActivityDeps } from './fake-adapter.ts'

const here = dirname(fileURLToPath(import.meta.url))
// 每次测试进程用独立队列。Temporal 会保留失败用例留下的 Workflow；固定队列
// 会让下次测试 Worker 捞起旧任务，拿新 MemoryStore 处理旧 mission，产生假失败。
const TASK_QUEUE = `cmap-test-${process.pid}-${Date.now()}`
const ADDRESS = process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233'

let worker: Worker
let workerRun: Promise<void>
let client: Client
let conn: Connection
let store: Store
let adapter: FakeAdapter
let workRoot: string

const mission = (id: string, constraints: Record<string, unknown> = {}): Mission => ({
  id,
  tenant: 'team-ycc',
  owner: 'crosswarm',
  type: 'inspect',
  goal: '验证 Workflow 骨架',
  constraints,
  acceptance: [{ criterion_id: 'C1', metric: 'ok', operator: 'eq', expected: 1, hard_gate: true }],
  workflow_template: 'inspect/v1',
  state: 'DRAFT',
  revision: 1,
  created_at: '2026-08-04T00:00:00.000Z',
  updated_at: '2026-08-04T00:00:00.000Z',
})

before(async () => {
  store = new MemoryStore()
  adapter = new FileFakeAdapter()
  workRoot = await mkdtemp(join(tmpdir(), 'cmap-mission-input-fixture-'))

  try {
    conn = await Connection.connect({ address: ADDRESS, connectTimeout: 15_000 })
    const native = await NativeConnection.connect({ address: ADDRESS })
    worker = await Worker.create({
      connection: native,
      namespace: 'default',
      taskQueue: TASK_QUEUE,
      workflowsPath: join(here, '../../workflows/mission.workflow.ts'),
      // Activity 注入 Store 与假 Adapter：这里验证的是编排逻辑，
      // 真实 Agent 调用由 scripts/e2e-single-hop.mjs 覆盖。
      activities: createActivities(syntheticActivityDeps({
        store, adapter, workRoot, runner: syntheticRunner({ runner_id: 'test-runner' }), pollIntervalMs: 1,
      })),
    })
    workerRun = worker.run()
  } catch (e) {
    throw new Error(
      `无法连接 Temporal（${ADDRESS}）。请先启动本地栈：\n` +
        `  docker compose -f infra/docker-compose/docker-compose.yml up -d\n` +
        `  node scripts/verify-temporal.mjs\n原始错误：${String(e)}`,
    )
  }
})

// 假 Adapter 由 Worker 持有，整个文件共用一个实例——每个用例前重置计数，
// 否则上一个用例设的「连续不达标」会漏到下一个用例里。
beforeEach(() => {
  adapter.failNext = 0
})

after(async () => {
  worker?.shutdown()
  await workerRun?.catch(() => {})
  await conn?.close()
  if(workRoot)await rm(workRoot,{recursive:true,force:true})
})

const run = async (missionId: string) => {
  client = new Client({ connection: conn, namespace: 'default' })
  return client.workflow.execute('missionWorkflow', {
    taskQueue: TASK_QUEUE,
    workflowId: `test-${missionId}-${Date.now()}`,
    args: [{ missionId }],
  })
}

const start = async (missionId: string) => {
  client = new Client({ connection: conn, namespace: 'default' })
  return client.workflow.start('missionWorkflow', {
    taskQueue: TASK_QUEUE,
    workflowId: `test-${missionId}-${Date.now()}`,
    args: [{ missionId }],
  })
}

const waitUntil = async <T>(read: () => Promise<T | null>): Promise<T> => {
  const deadline = Date.now() + 5_000
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error('等待测试条件超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('Mission Workflow', () => {
  test('完整跑通一个单任务 Mission', async () => {
    await store.createMission({
      mission: mission('mis-wf-1'),
      actor: { type: 'system', id: 'test' },
    })

    const result = await run('mis-wf-1')

    assert.equal(result.missionId, 'mis-wf-1')
    assert.equal(result.state, 'COMPLETED', `Mission 应完成，实际 ${result.state}`)
    assert.ok(result.taskIds.length > 0, '应至少创建一个 Task')
  })

  test('Task ID 由 Activity 生成，Workflow 不创造（ADR-0005 规则二）', async () => {
    await store.createMission({
      mission: mission('mis-wf-2'),
      actor: { type: 'system', id: 'test' },
    })

    const result = await run('mis-wf-2')
    const taskId = result.taskIds[0]!

    // Workflow 内禁用随机与时间戳，若 id 在 Workflow 里生成则重放会产生
    // 不同的值。id 必须能在 Ledger 中找到对应记录，证明它来自 Activity。
    const rec = await store.getTask(taskId)
    assert.ok(rec, `Task ${taskId} 应存在于 Ledger，说明 id 由 Activity 侧生成并落库`)
    assert.equal(rec.mission_id, 'mis-wf-2')
  })

  test('派发写 Ledger 与调 Adapter 在同一步完成（ADR-0005 规则三）', async () => {
    await store.createMission({
      mission: mission('mis-wf-3'),
      actor: { type: 'system', id: 'test' },
    })

    const before = adapter.startCalls.length
    const result = await run('mis-wf-3')
    const taskId = result.taskIds[0]!

    const rec = await store.getTask(taskId)
    assert.ok(rec?.binding, 'binding 必须已落库')
    assert.equal(
      rec.binding.runner_id,
      'test-runner',
      'binding 应携带执行方标识',
    )
    assert.ok(adapter.startCalls.length > before, 'Adapter 应被真实调用')
  })

  test('同一任务重复派发不重复调用 Adapter（ADR-0005 规则一）', async () => {
    await store.createMission({
      mission: mission('mis-wf-4'),
      actor: { type: 'system', id: 'test' },
    })

    const result = await run('mis-wf-4')
    const taskId = result.taskIds[0]!
    const afterFirst = adapter.startCalls.length

    // 模拟 Activity 重试：Temporal 在超时后会真正重跑 Activity，
    // 且可能落到另一个 Worker 进程——那时 Adapter 的内存缓存是空的。
    // 唯一能认出「已派发过」的依据是 Ledger 中的 binding。
    const acts = createActivities(syntheticActivityDeps({ store, adapter, runner: syntheticRunner({ runner_id: 'test-runner' }), pollIntervalMs: 1 }))
    const retry = await acts.dispatchTask(taskId)

    assert.equal(retry.dispatched, false, '重试必须识别出已派发，不得再次执行')
    assert.equal(
      adapter.startCalls.length,
      afterFirst,
      '已派发的任务不得重复调用 Adapter——这是跨进程幂等的核心保证',
    )
  })

  test('全新 Adapter 实例（模拟新进程）同样能识别已派发', async () => {
    await store.createMission({
      mission: mission('mis-wf-6'),
      actor: { type: 'system', id: 'test' },
    })

    const result = await run('mis-wf-6')
    const taskId = result.taskIds[0]!

    // 全新的 Activity 实例，内部无任何内存状态——正是 Worker 重启后的情形。
    // 连 Adapter 也换成新的：Adapter 的幂等缓存同样在内存里，只有 Ledger
    // 里的 binding 能跨进程认出「已经派发过了」。
    const freshAdapter = new FakeAdapter()
    const freshActs = createActivities(syntheticActivityDeps({
      store, adapter: freshAdapter, runner: syntheticRunner({ runner_id: 'test-runner' }), pollIntervalMs: 1,
    }))
    const out = await freshActs.dispatchTask(taskId)

    assert.equal(out.dispatched, false, '新进程必须从 Ledger 认出已派发')
    assert.equal(
      freshAdapter.startCalls.length,
      0,
      '此前的 e2e 幂等断言在同一进程内调用，掩盖了这个缺陷',
    )
  })

  test('第一轮没过就自动返工，第二轮过了就完成', async () => {
    await store.createMission({
      mission: mission('mis-rework-1', { max_additional_cycles: 2 }),
      actor: { type: 'system', id: 'test' },
    })
    // 第一次收结果一律判不达标，第二次通过
    adapter.failNext = 1

    const result = await run('mis-rework-1')

    assert.equal(result.state, 'COMPLETED', `应在第二轮通过，实际 ${result.state}`)
    assert.equal(result.rounds, 1, '应恰好返工一轮')
    assert.equal(result.taskIds.length, 2, '返工要派生新 Task，不是原地重跑')

    const [firstId, secondId] = result.taskIds
    const second = await store.getTask(secondId!)
    assert.equal(
      second?.supersedes_task_id,
      firstId,
      '后继任务必须指向被返工的原任务，否则说不清第几轮卡在哪',
    )
    const first = await store.getTask(firstId!)
    assert.equal(first?.state, 'COMPLETED', '原任务已尽其责，落 COMPLETED 保留证据')
    assert.ok(first?.result, '原任务那一轮的结果要留着，供下一轮比对进展')
  })

  test('轮次预算耗尽就升级给人，不无限重试', async () => {
    await store.createMission({
      mission: mission('mis-rework-2', { max_additional_cycles: 1 }),
      actor: { type: 'system', id: 'test' },
    })
    adapter.failNext = 99 // 一直不达标

    const result = await run('mis-rework-2')

    assert.equal(result.state, 'ESCALATED', '预算耗尽必须交给人，而不是继续烧')
    assert.match(result.escalationReason ?? '', /轮次/, '要说清为什么停')
    assert.equal(result.taskIds.length, 2, '预算 1 轮 = 原任务 + 一个后继任务')
    assert.equal((await store.getMission('mis-rework-2'))?.state, 'ESCALATED')

    const events = (await store.listEvents('mis-rework-2')).map((e) => e.event_type)
    assert.ok(events.includes('REVIEW_REWORK_REQUESTED'), '返工要留痕')
    assert.ok(events.includes('MISSION_ESCALATED'), '升级要留痕')
    assert.equal(
      events.filter((event) => event === 'MISSION_ESCALATED').length,
      1,
      '一次升级只能发一个 Mission 级信号，否则界面和通知会重复报警',
    )
  })

  test('终态收结果失败在预算 0 时如实升级，不让 Mission 卡 RUNNING', async () => {
    await store.createMission({
      mission: mission('mis-collect-terminal-1', { max_additional_cycles: 0 }),
      actor: { type: 'system', id: 'test' },
    })

    const originalCollect = adapter.collectResult
    adapter.collectResult = async (_binding: RemoteTaskBinding): Promise<TaskResultV1> => {
      throw new AdapterError(
        'RESULT_UNPARSABLE',
        'raw provider output with prompt and stack',
        false,
        'result-unparsable',
      )
    }

    try {
      const result = await run('mis-collect-terminal-1')

      assert.equal(result.state, 'ESCALATED')
      assert.match(result.summary, /RESULT_UNPARSABLE/)
      assert.deepEqual(result.failedCriteria, ['C1'])
      assert.equal((await store.getMission('mis-collect-terminal-1'))?.state, 'ESCALATED')

      const taskId = result.taskIds[0]!
      const task = await store.getTask(taskId)
      assert.equal(task?.state, 'FAILED_TERMINAL')
      assert.equal(task?.result?.status, 'failed')
      assert.equal(task?.result?.error?.code, 'RESULT_UNPARSABLE')
      assert.equal(task?.result?.error?.fingerprint, 'result-unparsable')
      assert.deepEqual(task?.result?.criterion_results, [])
      assert.deepEqual(task?.result?.artifacts, [])
      assert.doesNotMatch(task?.result?.error?.message ?? '', /raw provider output|prompt|stack/)
    } finally {
      adapter.collectResult = originalCollect
    }
  })

  test('收结果遇到执行状态不确定时先升级，不进入验收', async () => {
    const queue = `cmap-uncertain-${process.pid}-${Date.now()}`
    const native = await NativeConnection.connect({ address: ADDRESS })
    let verifying = false
    const states: string[] = []
    const stateKeys: string[] = []
    const uncertainWorker = await Worker.create({
      connection: native,
      namespace: 'default',
      taskQueue: queue,
      workflowsPath: join(here, '../../workflows/mission.workflow.ts'),
      activities: {
        setMissionState: async ({ state, idempotencyKey }: { state: string; idempotencyKey: string }) => {
          states.push(state)
          stateKeys.push(idempotencyKey)
        },
        createTask: async () => ({ taskId: 'tsk-uncertain' }),
        markReady: async () => {},
        requestApproval: async () => ({ required: false }),
        dispatchTask: async () => ({ dispatched: true, remoteTaskId: 'fake:tsk-uncertain' }),
        collectTaskResult: async () => ({
          executionUncertain: {
            code: 'BINDING_NOT_FOUND',
            terminalObserved: false,
          },
        }),
        markVerifying: async () => {
          verifying = true
        },
      },
    })
    const runUncertainWorker = uncertainWorker.run()
    try {
      const uncertainClient = new Client({ connection: conn, namespace: 'default' })
      const result = await uncertainClient.workflow.execute('missionWorkflow', {
        taskQueue: queue,
        workflowId: `test-uncertain-${Date.now()}`,
        args: [{ missionId: 'mis-uncertain' }],
      })

      assert.equal(result.state, 'ESCALATED')
      assert.equal(result.summary, 'EXECUTION_UNCERTAIN:BINDING_NOT_FOUND')
      assert.equal(result.escalationReason, 'EXECUTION_UNCERTAIN:BINDING_NOT_FOUND')
      assert.equal(verifying, false, '不确定执行状态不能进入 markVerifying')
      assert.deepEqual(states, ['RUNNING', 'ESCALATED'])
      assert.notEqual(stateKeys.at(-1), 'execution-uncertain:tsk-uncertain', 'Mission 与 Task 事件不得共用全局幂等键')
    } finally {
      uncertainWorker.shutdown()
      await runUncertainWorker.catch(() => {})
      await native.close()
    }
  })

  test('mutating 任务批准前不派发，批准 controlled 也不放行', async () => {
    await store.createMission({
      mission: mission('mis-approval-1', { risk_level: 'mutating' }),
      actor: { type: 'system', id: 'test' },
    })
    const callsBefore = adapter.startCalls.length
    const handle = await start('mis-approval-1')

    const pending = await waitUntil(async () => {
      const items = await store.listPendingApprovals('mis-approval-1')
      return items[0] ?? null
    })
    assert.equal(pending.scope, 'mutating')
    await waitUntil(async () =>
      (await store.getMission('mis-approval-1'))?.state === 'AWAITING_APPROVAL' ? true : null,
    )
    assert.equal(adapter.startCalls.length, callsBefore, '未批准不得调用 Adapter')
    assert.equal((await store.getMission('mis-approval-1'))?.state, 'AWAITING_APPROVAL')

    await store.createApproval({
      ...pending,
      id: 'apr-unrelated-controlled',
      task_id: 'other-task',
      scope: 'controlled',
      risk_level: 'controlled',
    })
    await store.decideApproval(
      'apr-unrelated-controlled', 'approved', 'user:human', new Date().toISOString(),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(adapter.startCalls.length, callsBefore, 'controlled 批准不得放行 mutating')

    await store.decideApproval(pending.id, 'approved', 'user:human', new Date().toISOString())
    const result = await handle.result()
    assert.equal(result.state, 'COMPLETED')
    assert.equal(adapter.startCalls.length, callsBefore + 1, '正确批准后才调用 Adapter')
  })

  test('审批被拒绝后任务终止，Adapter 从未调用', async () => {
    await store.createMission({
      mission: mission('mis-approval-2', { risk_level: 'controlled' }),
      actor: { type: 'system', id: 'test' },
    })
    const callsBefore = adapter.startCalls.length
    const handle = await start('mis-approval-2')
    const pending = await waitUntil(async () => {
      const items = await store.listPendingApprovals('mis-approval-2')
      return items[0] ?? null
    })

    await store.decideApproval(pending.id, 'rejected', 'user:human', new Date().toISOString())
    const result = await handle.result()

    assert.equal(result.state, 'FAILED')
    assert.equal(adapter.startCalls.length, callsBefore)
    assert.equal((await store.getTask(pending.task_id))?.state, 'REJECTED')
    assert.equal((await store.getMission('mis-approval-2'))?.state, 'FAILED')
  })

  test('事件流完整记录了状态推进', async () => {
    await store.createMission({
      mission: mission('mis-wf-5'),
      actor: { type: 'system', id: 'test' },
    })
    await run('mis-wf-5')

    const events = await store.listEvents('mis-wf-5')
    const types = events.map((e) => e.event_type)

    assert.ok(types.includes('TASK_CREATED'), '缺 TASK_CREATED')
    assert.ok(types.includes('TASK_ASSIGNED'), '缺 TASK_ASSIGNED —— 派发没留痕')
    assert.ok(types.includes('HARD_GATE_EVALUATED'), '缺硬门槛事件 —— 事后复核读不出验收发生过')
    // 通过评审而结束的任务记 REVIEW_ACCEPTED——状态是 COMPLETED，
    // 事件类型表达的是「为什么结束」。返工结束的那条才记 TASK_COMPLETED。
    assert.ok(types.includes('REVIEW_ACCEPTED'), '缺 REVIEW_ACCEPTED')
    assert.ok(
      !types.includes('MISSION_ESCALATED'),
      '顺利完成的 Mission 不得出现「已升级」事件 —— 那是叫人来救的信号',
    )

    for (let i = 1; i < events.length; i += 1) {
      assert.ok(events[i]!.lamport > events[i - 1]!.lamport, 'lamport 必须严格递增')
    }
  })
})
