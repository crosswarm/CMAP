/**
 * dag/v1 Worker 重启恢复：runDagAttempt 在 Worker 失联（心跳超时）后重试一次，
 * 只按既有 binding / 运行记录恢复观察，绝不新启动 Agent；非重启安全的 Adapter 仍升级 NODE_EXECUTION_ERROR。
 *
 * Worker 被杀在这里用「首个 attempt 完成真实派发后抛可重试错误」模拟：Temporal 对两者都按重试策略处理，
 * 区别只在等待心跳超时的 2 分钟。真实 SIGKILL 由 scripts/e2e-remote-mission.mjs worker-restart 覆盖。
 */
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'

import { ApplicationFailure, Context } from '@temporalio/activity'
import { Client, Connection } from '@temporalio/client'
import { NativeConnection, Worker } from '@temporalio/worker'
import proto from '@temporalio/proto'

import { MemoryStore, type EventActor, type Mission, type TaskEnvelopeV1 } from '#domain-model'
import { createActivities } from '../../workflows/activities.ts'
import { createDagActivities, type DagActivities, type DagNodeOutcome } from '../../workflows/dag-activities.ts'
import type { DagWorkflowResult } from '../../workflows/dag.workflow.ts'
import { FakeAdapter, syntheticActivityDeps, syntheticRunner } from './fake-adapter.ts'

process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = process.env['NO_PROXY']

const ACTOR: EventActor = { type: 'system', id: 'dag-attempt-restart-test' }
const T0 = '2026-10-19T00:00:00.000Z'

/** 重启安全（Codex 运行记录模式 / 远程 runner）的假 Adapter：状态只看 binding，不依赖进程内存。 */
class RestartSafeAdapter extends FakeAdapter {
  readonly restartSafe: boolean = true
  statusCalls = 0
  override async getStatus() {
    this.statusCalls += 1
    return super.getStatus()
  }
}

/** 不声明重启安全（Kimi / YonWork 一类）。 */
class VolatileAdapter extends RestartSafeAdapter {
  override readonly restartSafe = false
}

const seedTask = async (store: MemoryStore, taskId: string): Promise<void> => {
  const missionId = `mis-${taskId}`
  const mission: Mission = {
    id: missionId, tenant: 'team-ycc', owner: 'crosswarm', type: 'inspect', goal: 'restart', constraints: {},
    acceptance: [{ criterion_id: 'DONE', metric: 'done', operator: 'eq', expected: true, hard_gate: true }],
    workflow_template: 'dag/v1', state: 'RUNNING', revision: 1, created_at: T0, updated_at: T0,
  }
  const envelope: TaskEnvelopeV1 = {
    schema: 'cmap/task-envelope/v1',
    identity: { mission_id: missionId, task_id: taskId, idempotency_key: `${missionId}:${taskId}`, revision: 1, tenant: 'team-ycc', owner: 'crosswarm' },
    classification: { task_type: 'inspect', requested_capability: 'code.analyze', risk_level: 'read-meta' },
    goal: { statement: 'restart', success_definition: [{ criterion_id: 'DONE', metric: 'done', operator: 'eq', expected: true, hard_gate: true }] },
    environment: { tenant: 'team-ycc' },
    execution_policy: { timeout_seconds: 30, max_attempts: 1 },
    permissions: { forbidden: [] },
    evidence_requirements: { required_artifact_roles: ['report'] },
    output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
  }
  await store.createMission({ mission, actor: ACTOR })
  await store.createTask({
    actor: ACTOR,
    task: {
      id: taskId, mission_id: missionId, parent_task_id: null, supersedes_task_id: null, capability: 'code.analyze', risk: 'read-meta',
      state: 'DRAFT', attempt: 1, max_attempts: 1, lamport: 0, envelope, result: null, binding: null, deps: [], created_at: T0, updated_at: T0,
    },
  })
  await store.transitionTask({ taskId, to: 'READY', actor: ACTOR, eventType: 'TASK_READY', idempotencyKey: `ready:${taskId}` })
}

const setup = async (adapter: FakeAdapter, taskId: string) => {
  const store = new MemoryStore()
  await seedTask(store, taskId)
  const workRoot = await mkdtemp(join(tmpdir(), 'cmap-dag-restart-'))
  const deps = syntheticActivityDeps({ runner: syntheticRunner(), store, adapter, workRoot, pollIntervalMs: 5 })
  return { store, deps, base: createActivities(deps), dag: createDagActivities(deps) }
}

const count = async (store: MemoryStore, taskId: string, type: string) =>
  (await store.listEvents(`mis-${taskId}`)).filter((e) => e.event_type === type && e.task_id === taskId).length

/** 在 Activity 上下文之外模拟 Temporal 的第 n 次 attempt。 */
const asAttempt = (attempt: number) => mock.method(Context, 'current', () => ({
  info: { attempt }, heartbeat: () => {},
}) as unknown as ReturnType<typeof Context.current>)

describe('runDagAttempt 重启恢复（Activity 侧）', () => {
  test('重启后新 runner 对已有 binding 幂等：只恢复观察并收结果，不二次 startTask、不二次路由', async () => {
    const adapter = new RestartSafeAdapter()
    const { store, base, dag } = await setup(adapter, 'tsk-restart-safe')
    // 被杀的那次 attempt：已路由、已落 binding、已启动 Agent
    assert.equal((await base.dispatchTask('tsk-restart-safe')).dispatched, true)
    const current = asAttempt(2)
    try {
      assert.deepEqual(await dag.runDagAttempt({ taskId: 'tsk-restart-safe' }), { outcome: 'collected', taskId: 'tsk-restart-safe' })
    } finally {
      current.mock.restore()
    }
    assert.equal(adapter.startCalls.length, 1)
    assert.ok(adapter.statusCalls >= 1)
    assert.equal(await count(store, 'tsk-restart-safe', 'ROUTING_DECIDED'), 1)
    assert.equal(await count(store, 'tsk-restart-safe', 'TASK_STARTED'), 1)
    assert.ok((await store.getTask('tsk-restart-safe'))!.result)
  })

  test('非重启安全的 binding 在重试 attempt 上直接不可重试失败：不观察、不启动', async () => {
    const adapter = new VolatileAdapter()
    const { store, base, dag } = await setup(adapter, 'tsk-restart-volatile')
    await base.dispatchTask('tsk-restart-volatile')
    const statusBefore = adapter.statusCalls
    const current = asAttempt(2)
    try {
      await assert.rejects(dag.runDagAttempt({ taskId: 'tsk-restart-volatile' }),
        (error: unknown) => error instanceof ApplicationFailure && error.nonRetryable && error.type === 'ATTEMPT_NOT_RESTART_SAFE')
    } finally {
      current.mock.restore()
    }
    assert.equal(adapter.startCalls.length, 1)
    assert.equal(adapter.statusCalls, statusBefore)
    assert.equal((await store.getTask('tsk-restart-volatile'))!.result, null)
  })

  test('重试时还没有 binding（被杀在路由前）：此前没有启动过 Agent，照常首次派发', async () => {
    const adapter = new VolatileAdapter()
    const { store, dag } = await setup(adapter, 'tsk-restart-unbound')
    const current = asAttempt(2)
    try {
      assert.equal((await dag.runDagAttempt({ taskId: 'tsk-restart-unbound' })).outcome, 'collected')
    } finally {
      current.mock.restore()
    }
    assert.equal(adapter.startCalls.length, 1)
    assert.equal(await count(store, 'tsk-restart-unbound', 'TASK_STARTED'), 1)
  })

  test('Activity 自身抛错一律不可重试：只有 Worker 失联（心跳/超时）才会重试', async () => {
    const adapter = new RestartSafeAdapter()
    const { dag } = await setup(adapter, 'tsk-restart-own-error')
    await assert.rejects(dag.runDagAttempt({ taskId: 'tsk-missing' }),
      (error: unknown) => error instanceof ApplicationFailure && error.nonRetryable && /任务不存在/.test(error.message))
    assert.equal(adapter.startCalls.length, 0)
  })
})

describe('dagMissionWorkflow 重启恢复（Temporal）', () => {
  const queue = `cmap-dag-restart-${process.pid}-${Date.now()}`
  let connection: Connection, native: NativeConnection, worker: Worker, running: Promise<void>, client: Client
  const runs = new Map<string, { adapter: RestartSafeAdapter; attempts: number; outcomes: DagNodeOutcome[]; acts: Awaited<ReturnType<typeof setup>> }>()

  before(async () => {
    connection = await Connection.connect({ address: process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233' })
    native = await NativeConnection.connect({ address: process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233' })
    client = new Client({ connection })
    const of = (id: string) => runs.get(id.replace(/^tsk-/, ''))!
    const activities: DagActivities = {
      async loadDagSchedule() { return { nodes: [{ node_id: 'n1', deps: [] }], concurrency: 1, maxAdditionalCycles: 0, state: 'RUNNING' } },
      async materializeDagNode(input) { return { taskId: `tsk-${input.missionId}` } },
      async checkDagApproval() { return { decision: 'approved' } },
      async runDagAttempt(input) {
        const run = of(input.taskId)
        run.attempts += 1
        // 首个 attempt：真实路由、落 binding、启动 Agent，随后 Worker「失联」
        if (Context.current().info.attempt === 1) {
          await run.acts.base.dispatchTask(input.taskId)
          throw new Error('simulated worker loss')
        }
        return run.acts.dag.runDagAttempt(input)
      },
      async reviewDagAttempt({ taskId }) {
        const out: DagNodeOutcome = { status: 'accepted', nodeId: 'n1', taskId, attempt: 1 }
        of(taskId).outcomes.push(out)
        return out
      },
      // 本文件不产生 QUOTA_EXHAUSTED，Workflow 不会调用续接
      async handoffQuotaExhausted() { throw new Error('unused') },
      async finishDagNode(input) {
        const out: DagNodeOutcome = { ...input }
        runs.get(input.missionId)!.outcomes.push(out)
        return out
      },
      async finalizeDagMission(missionId) {
        const { outcomes } = runs.get(missionId)!
        return {
          missionId, state: outcomes.some((o) => o.status === 'escalated') ? 'ESCALATED' : 'COMPLETED',
          taskIds: [`tsk-${missionId}`], blockedNodeIds: [], nodeOutcomes: outcomes,
        }
      },
    }
    worker = await Worker.create({
      connection: native, taskQueue: queue, workflowsPath: resolve('workflows/dag.workflow.ts'),
      activities: { ...activities, proposeTaskKnowledge: async () => {}, recordEscalationHandoff: async () => {}, cancelMissionTasks: async () => ({ canceled: [], unconfirmed: [] }) },
    })
    running = worker.run()
  })
  after(async () => {
    worker?.shutdown()
    await running
    await connection?.close()
    await native?.close()
  })

  const start = async (id: string, adapter: RestartSafeAdapter) => {
    runs.set(id, { adapter, attempts: 0, outcomes: [], acts: await setup(adapter, `tsk-${id}`) })
    const result = await client.workflow.execute('dagMissionWorkflow', { workflowId: id, taskQueue: queue, args: [{ missionId: id }] }) as DagWorkflowResult
    await Worker.runReplayHistory({ workflowsPath: resolve('workflows/dag.workflow.ts') }, await client.workflow.getHandle(id).fetchHistory())
    return { result, run: runs.get(id)! }
  }

  test('重启安全的 Adapter：attempt 重试一次，按既有 binding 恢复并完成；Agent 只启动 1 次；历史可重放', async () => {
    const { result, run } = await start(`restart-safe-${Date.now()}`, new RestartSafeAdapter())
    assert.equal(result.state, 'COMPLETED')
    assert.equal(run.attempts, 2)
    assert.equal(run.adapter.startCalls.length, 1)
    const taskId = `tsk-${result.missionId}`
    assert.equal(await count(run.acts.store, taskId, 'ROUTING_DECIDED'), 1)
    assert.equal(await count(run.acts.store, taskId, 'TASK_STARTED'), 1)
  })

  test('非重启安全的 Adapter：重试 attempt 拒绝恢复，节点照旧升级 NODE_EXECUTION_ERROR；Agent 只启动 1 次', async () => {
    const { result, run } = await start(`restart-volatile-${Date.now()}`, new VolatileAdapter())
    assert.equal(result.state, 'ESCALATED')
    assert.deepEqual(result.nodeOutcomes.map((o) => [o.nodeId, o.status, o.reason]), [['n1', 'escalated', 'NODE_EXECUTION_ERROR']])
    assert.equal(run.attempts, 2)
    assert.equal(run.adapter.startCalls.length, 1)
    assert.equal((await run.acts.store.getTask(`tsk-${result.missionId}`))!.result, null)
  })

  test('补丁前的历史（runDagAttempt maximumAttempts 1、首次失败即升级）在新代码下仍可确定性重放', async () => {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/dag-attempt-legacy.json', import.meta.url), 'utf8'))
    const history = proto.temporal.api.history.v1.History.fromObject(fixture)
    assert.equal(history.events.length, 49)
    await Worker.runReplayHistory({ workflowsPath: resolve('workflows/dag.workflow.ts') }, history)
  })
})
