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
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'

import { Worker, NativeConnection } from '@temporalio/worker'
import { Client, Connection } from '@temporalio/client'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { MemoryStore } from '#domain-model'
import type { Mission, Store } from '#domain-model'
import { createActivities } from '../../workflows/activities.ts'
import type { FakeDispatchRecord } from '../../workflows/activities.ts'

const here = dirname(fileURLToPath(import.meta.url))
const TASK_QUEUE = 'cmap-test'
const ADDRESS = process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233'

let worker: Worker
let workerRun: Promise<void>
let client: Client
let conn: Connection
let store: Store
let dispatched: FakeDispatchRecord[]

const mission = (id: string): Mission => ({
  id,
  tenant: 'team-ycc',
  owner: 'crosswarm',
  type: 'inspect',
  goal: '验证 Workflow 骨架',
  constraints: {},
  acceptance: [{ criterion_id: 'C1', metric: 'ok', operator: 'eq', expected: 1, hard_gate: true }],
  workflow_template: 'inspect/v1',
  state: 'DRAFT',
  revision: 1,
  created_at: '2026-08-04T00:00:00.000Z',
  updated_at: '2026-08-04T00:00:00.000Z',
})

before(async () => {
  store = new MemoryStore()
  dispatched = []

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
      activities: createActivities({ store, dispatchRecorder: dispatched }),
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

after(async () => {
  worker?.shutdown()
  await workerRun?.catch(() => {})
  await conn?.close()
})

const run = async (missionId: string) => {
  client = new Client({ connection: conn, namespace: 'default' })
  return client.workflow.execute('missionWorkflow', {
    taskQueue: TASK_QUEUE,
    workflowId: `test-${missionId}-${Date.now()}`,
    args: [{ missionId }],
  })
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

    const before = dispatched.length
    const result = await run('mis-wf-3')
    const taskId = result.taskIds[0]!

    const rec = await store.getTask(taskId)
    assert.ok(rec?.binding, 'binding 必须已落库')
    assert.equal(
      rec.binding.runner_id,
      'test-runner',
      'binding 应携带执行方标识',
    )
    assert.ok(dispatched.length > before, 'Adapter 应被调用')
  })

  test('同一任务重复派发不重复调用 Adapter（ADR-0005 规则一）', async () => {
    await store.createMission({
      mission: mission('mis-wf-4'),
      actor: { type: 'system', id: 'test' },
    })

    const result = await run('mis-wf-4')
    const taskId = result.taskIds[0]!
    const afterFirst = dispatched.length

    // 模拟 Activity 重试：Temporal 在超时后会真正重跑 Activity，
    // 且可能落到另一个 Worker 进程——那时 Adapter 的内存缓存是空的。
    // 唯一能认出「已派发过」的依据是 Ledger 中的 binding。
    const acts = createActivities({ store, dispatchRecorder: dispatched })
    const retry = await acts.dispatchTask(taskId)

    assert.equal(retry.dispatched, false, '重试必须识别出已派发，不得再次执行')
    assert.equal(
      dispatched.length,
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

    // 全新的 Activity 实例，内部无任何内存状态——正是 Worker 重启后的情形
    const freshRecorder: FakeDispatchRecord[] = []
    const freshActs = createActivities({ store, dispatchRecorder: freshRecorder })
    const out = await freshActs.dispatchTask(taskId)

    assert.equal(out.dispatched, false, '新进程必须从 Ledger 认出已派发')
    assert.equal(
      freshRecorder.length,
      0,
      '此前的 e2e 幂等断言在同一进程内调用，掩盖了这个缺陷',
    )
  })

  test('锁被他人持有时进入 WAITING_RESOURCE，而非失败重试', async () => {
    await store.createMission({
      mission: mission('mis-lock-1'),
      actor: { type: 'system', id: 'test' },
    })

    // 先由别人占住资源
    await store.acquireLock({
      lock_id: 'lk-other',
      resource: 'device:shared',
      task_id: 'other-task',
      mission_id: 'other-mission',
      holder_runner_id: 'runner-other',
      acquired_at: new Date(Date.now() - 1000).toISOString(),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      released_at: null,
    })

    const acts = createActivities({ store, dispatchRecorder: dispatched })
    const { taskId } = await acts.createTask({
      missionId: 'mis-lock-1',
      capability: 'realdevice-validation',
      goal: '需要独占真机',
    })
    await acts.markReady(taskId)

    const got = await acts.acquireTaskLock({ taskId, resource: 'device:shared' })
    assert.equal(got.acquired, false, '资源被占时不应拿到锁')

    const rec = await store.getTask(taskId)
    assert.equal(
      rec?.state,
      'WAITING_RESOURCE',
      '等资源是正常停顿，不是失败——按失败重试会浪费预算且掩盖真实原因',
    )
  })

  test('锁释放后能从 WAITING_RESOURCE 回到 RUNNING 并完成', async () => {
    await store.createMission({
      mission: mission('mis-lock-2'),
      actor: { type: 'system', id: 'test' },
    })

    await store.acquireLock({
      lock_id: 'lk-hold',
      resource: 'device:exclusive',
      task_id: 'holder',
      mission_id: 'other',
      holder_runner_id: 'runner-x',
      acquired_at: new Date(Date.now() - 1000).toISOString(),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      released_at: null,
    })

    const acts = createActivities({ store, dispatchRecorder: dispatched })
    const { taskId } = await acts.createTask({
      missionId: 'mis-lock-2',
      capability: 'realdevice-validation',
      goal: '等待真机释放',
    })
    await acts.markReady(taskId)

    const first = await acts.acquireTaskLock({ taskId, resource: 'device:exclusive' })
    assert.equal(first.acquired, false)
    assert.equal((await store.getTask(taskId))?.state, 'WAITING_RESOURCE')

    // 持有者释放
    await store.releaseLock('lk-hold', new Date().toISOString())

    const second = await acts.acquireTaskLock({ taskId, resource: 'device:exclusive' })
    assert.equal(second.acquired, true, '资源释放后应能获取')
    assert.equal(
      (await store.getTask(taskId))?.state,
      'RUNNING',
      '等待解除后必须能回到运行态，否则任务永久卡死',
    )

    await acts.releaseTaskLock(second.lockId!)
    assert.equal(
      (await store.listActiveLocks(new Date().toISOString())).some(
        (l) => l.lock_id === second.lockId,
      ),
      false,
      '释放后不应仍在活跃锁列表中',
    )
  })

  test('续租失败返回 false 而非抛错（runner 据此自停）', async () => {
    await store.createMission({
      mission: mission('mis-lock-3'),
      actor: { type: 'system', id: 'test' },
    })

    const acts = createActivities({ store, dispatchRecorder: dispatched })
    const { taskId } = await acts.createTask({
      missionId: 'mis-lock-3',
      capability: 'realdevice-validation',
      goal: '续租测试',
    })
    await acts.markReady(taskId)

    const got = await acts.acquireTaskLock({ taskId, resource: 'device:renew' })
    assert.equal(got.acquired, true)

    assert.equal(await acts.renewTaskLock(got.lockId!), true, '持有中应能续租')

    await acts.releaseTaskLock(got.lockId!)
    assert.equal(
      await acts.renewTaskLock(got.lockId!),
      false,
      '已释放的锁续租必须返回 false——抛错会让 Activity 进入重试而非让 runner 自停',
    )
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
    assert.ok(types.includes('TASK_COMPLETED'), '缺 TASK_COMPLETED')

    for (let i = 1; i < events.length; i += 1) {
      assert.ok(events[i]!.lamport > events[i - 1]!.lamport, 'lamport 必须严格递增')
    }
  })
})
