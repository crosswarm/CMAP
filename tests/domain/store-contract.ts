/**
 * Store 的行为契约测试套件（实现无关）。
 *
 * 内存实现与 PostgreSQL 实现跑同一套断言——契约由测试定义，不由某个
 * 实现定义。将来加 PG 实现时只需再写一个几行的 test 文件调用本套件。
 *
 * 本文件不以 .test.ts 结尾，避免被测试运行器当作独立用例执行。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { IllegalTransitionError } from '#domain-model'
import type {
  Store,
  Mission,
  TaskRecord,
  EventActor,
  TaskState,
  Approval,
  ResourceLock,
} from '#domain-model'
import {
  ConcurrentModificationError,
  LockUnavailableError,
} from '#domain-model'

const ACTOR: EventActor = { type: 'system', id: 'test-runner' }
const T0 = '2026-08-02T00:00:00.000Z'

const mission = (id: string): Mission => ({
  id,
  tenant: 'team-ycc',
  owner: 'crosswarm',
  type: 'performance-optimization',
  goal: '首屏 P95 降到 1800ms 以内',
  constraints: {},
  acceptance: [
    { criterion_id: 'PERF-P95', metric: 'p95_ms', operator: 'lte', expected: 1800, hard_gate: true },
  ],
  workflow_template: 'performance-optimization/v1',
  state: 'DRAFT',
  revision: 1,
  created_at: T0,
  updated_at: T0,
})

const task = (
  id: string,
  missionId: string,
  overrides: Partial<TaskRecord> = {},
): TaskRecord => ({
  id,
  mission_id: missionId,
  parent_task_id: null,
  supersedes_task_id: null,
  capability: 'code.analyze',
  risk: 'read-meta',
  state: 'DRAFT',
  attempt: 1,
  max_attempts: 2,
  lamport: 0,
  envelope: {
    schema: 'cmap/task-envelope/v1',
    identity: {
      mission_id: missionId,
      task_id: id,
      idempotency_key: `${missionId}:${id}`,
      revision: 1,
    },
    classification: {
      task_type: 'inspect',
      requested_capability: 'code.analyze',
      risk_level: 'read-meta',
    },
    goal: {
      statement: '测试用任务',
      success_definition: [
        { criterion_id: 'C1', metric: 'm', operator: 'eq', expected: 1 },
      ],
    },
    environment: {},
    execution_policy: { timeout_seconds: 60, max_attempts: 1 },
    permissions: { forbidden: [] },
    evidence_requirements: { required_artifact_roles: ['report'] },
    output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
  } as TaskRecord['envelope'],
  result: null,
  binding: null,
  deps: [],
  created_at: T0,
  updated_at: T0,
  ...overrides,
})

const lock = (id: string, resource: string, taskId: string, expiresAt: string): ResourceLock => ({
  lock_id: id,
  resource,
  task_id: taskId,
  mission_id: 'mis-1',
  holder_runner_id: 'runner-1',
  acquired_at: T0,
  expires_at: expiresAt,
  released_at: null,
})

const approval = (id: string, scope: 'controlled' | 'mutating'): Approval => ({
  id,
  mission_id: 'mis-1',
  task_id: 'tsk-1',
  action: scope === 'mutating' ? 'code.commit' : 'yonwork.chat_send',
  scope,
  requested_by: 'agent:codex',
  risk_level: scope,
  reason: '测试',
  evidence_artifact_ids: [],
  decision: 'pending',
  decided_by: null,
  decided_at: null,
  expires_at: '2026-08-03T00:00:00.000Z',
  created_at: T0,
})

/** 把 Task 推到指定状态，沿合法路径逐步迁移 */
const driveTo = async (store: Store, taskId: string, path: readonly TaskState[]) => {
  for (const [i, to] of path.entries()) {
    await store.transitionTask({
      taskId,
      to,
      actor: ACTOR,
      eventType: 'TASK_STARTED',
      idempotencyKey: `${taskId}:drive:${i}:${to}`,
    })
  }
}

export const runStoreContractTests = (implName: string, createStore: () => Promise<Store>) => {
  describe(`Store 契约 — ${implName}`, () => {
    describe('Mission', () => {
      test('创建后能原样读回', async () => {
        const s = await createStore()
        const m = mission('mis-1')
        await s.createMission({ mission: m, actor: ACTOR })
        const got = await s.getMission('mis-1')
        assert.equal(got?.id, 'mis-1')
        assert.equal(got?.goal, m.goal)
        assert.equal(got?.tenant, 'team-ycc')
      })

      test('不存在的 Mission 返回 null 而非抛错', async () => {
        const s = await createStore()
        assert.equal(await s.getMission('no-such'), null)
      })

      test('创建 Mission 产生事件', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        const events = await s.listEvents('mis-1')
        assert.ok(events.some((e) => e.event_type === 'MISSION_CREATED'))
      })
    })

    describe('Task 状态迁移', () => {
      test('合法迁移成功并更新状态', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })

        const after = await s.transitionTask({
          taskId: 'tsk-1',
          to: 'READY',
          actor: ACTOR,
          eventType: 'TASK_READY',
          idempotencyKey: 'k1',
        })
        assert.equal(after.state, 'READY')
        assert.equal((await s.getTask('tsk-1'))?.state, 'READY')
      })

      test('非法迁移抛 IllegalTransitionError 且状态不变', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })

        await assert.rejects(
          () =>
            s.transitionTask({
              taskId: 'tsk-1',
              to: 'COMPLETED',
              actor: ACTOR,
              eventType: 'TASK_COMPLETED',
              idempotencyKey: 'k-illegal',
            }),
          IllegalTransitionError,
        )
        assert.equal((await s.getTask('tsk-1'))?.state, 'DRAFT', '失败的迁移不得改变状态')
      })

      test('非法迁移不得留下事件（同事务回滚）', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        const before = (await s.listEvents('mis-1')).length

        await assert.rejects(() =>
          s.transitionTask({
            taskId: 'tsk-1',
            to: 'COMPLETED',
            actor: ACTOR,
            eventType: 'TASK_COMPLETED',
            idempotencyKey: 'k-illegal-2',
          }),
        )
        assert.equal(
          (await s.listEvents('mis-1')).length,
          before,
          '状态未变则不应产生事件，否则审计流会记录一个从未发生的变更',
        )
      })

      test('每次成功迁移都产生一条事件', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        const before = (await s.listEvents('mis-1')).length

        await s.transitionTask({
          taskId: 'tsk-1', to: 'READY', actor: ACTOR,
          eventType: 'TASK_READY', idempotencyKey: 'k2',
        })
        assert.equal((await s.listEvents('mis-1')).length, before + 1)
      })

      test('对不存在的任务迁移抛 NotFoundError', async () => {
        const s = await createStore()
        await assert.rejects(
          () =>
            s.transitionTask({
              taskId: 'ghost', to: 'READY', actor: ACTOR,
              eventType: 'TASK_READY', idempotencyKey: 'k3',
            }),
          /不存在/,
        )
      })
    })

    describe('幂等与并发', () => {
      test('相同 idempotencyKey 重复迁移只生效一次', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })

        await s.transitionTask({
          taskId: 'tsk-1', to: 'READY', actor: ACTOR,
          eventType: 'TASK_READY', idempotencyKey: 'dup',
        })
        const n1 = (await s.listEvents('mis-1')).length

        // 重复投递（网络重试 / Worker 重启）
        const again = await s.transitionTask({
          taskId: 'tsk-1', to: 'READY', actor: ACTOR,
          eventType: 'TASK_READY', idempotencyKey: 'dup',
        })

        assert.equal(again.state, 'READY')
        assert.equal(
          (await s.listEvents('mis-1')).length, n1,
          '重复投递不得产生重复事件',
        )
      })

      test('expectedFrom 与实际不符时抛 ConcurrentModificationError', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        await driveTo(s, 'tsk-1', ['READY', 'QUEUED'])

        await assert.rejects(
          () =>
            s.transitionTask({
              taskId: 'tsk-1', to: 'RUNNING', actor: ACTOR,
              eventType: 'TASK_STARTED', idempotencyKey: 'k-conc',
              expectedFrom: 'DRAFT', // 过期的认知
            }),
          ConcurrentModificationError,
        )
      })

      test('expectedFrom 相符时正常推进', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        await driveTo(s, 'tsk-1', ['READY', 'QUEUED'])

        const after = await s.transitionTask({
          taskId: 'tsk-1', to: 'RUNNING', actor: ACTOR,
          eventType: 'TASK_STARTED', idempotencyKey: 'k-ok',
          expectedFrom: 'QUEUED',
        })
        assert.equal(after.state, 'RUNNING')
      })
    })

    describe('事件顺序与投递', () => {
      test('lamport 严格递增，跨主机排序不依赖 wall clock', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        await driveTo(s, 'tsk-1', ['READY', 'QUEUED', 'RUNNING'])

        const events = await s.listEvents('mis-1')
        assert.ok(events.length >= 4)
        for (let i = 1; i < events.length; i += 1) {
          assert.ok(
            events[i]!.lamport > events[i - 1]!.lamport,
            `事件 ${i} 的 lamport 未递增`,
          )
        }
      })

      test('未投递事件可被查出并标记（Outbox）', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })

        const pending = await s.listUndeliveredEvents(10)
        assert.ok(pending.length > 0, '新事件默认处于未投递状态')

        await s.markEventDelivered(pending[0]!.event_id)
        const after = await s.listUndeliveredEvents(10)
        assert.ok(
          !after.some((e) => e.event_id === pending[0]!.event_id),
          '已标记的事件不应再出现在未投递列表',
        )
      })
    })

    describe('就绪任务查询', () => {
      test('依赖全部完成才算就绪', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('dep-1', 'mis-1'), actor: ACTOR })
        await s.createTask({
          task: task('tsk-2', 'mis-1', { deps: ['dep-1'] }),
          actor: ACTOR,
        })
        await driveTo(s, 'dep-1', ['READY'])
        await driveTo(s, 'tsk-2', ['READY'])

        assert.deepEqual(
          (await s.findReadyTasks('mis-1')).map((t) => t.id),
          ['dep-1'],
          '依赖未完成的任务不得就绪',
        )

        // 让依赖走完整条路径到 COMPLETED
        await driveTo(s, 'dep-1', ['QUEUED', 'RUNNING', 'VERIFYING', 'REVIEWING', 'COMPLETED'])

        assert.deepEqual(
          (await s.findReadyTasks('mis-1')).map((t) => t.id),
          ['tsk-2'],
          '依赖完成后应就绪',
        )
      })

      test('只返回 READY 状态的任务', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        assert.deepEqual(await s.findReadyTasks('mis-1'), [], 'DRAFT 不算就绪')
      })
    })

    describe('资源锁', () => {
      test('未过期的锁不可被他人获取', async () => {
        const s = await createStore()
        const future = '2099-01-01T00:00:00.000Z'
        await s.acquireLock(lock('lk-1', 'device:android-03', 'tsk-1', future))

        await assert.rejects(
          () => s.acquireLock(lock('lk-2', 'device:android-03', 'tsk-2', future)),
          LockUnavailableError,
        )
      })

      test('已过期的锁可被抢占——runner 崩溃不得永久占住真机', async () => {
        const s = await createStore()
        const past = '2020-01-01T00:00:00.000Z'
        await s.acquireLock(lock('lk-1', 'device:android-03', 'tsk-1', past))

        const taken = await s.acquireLock(
          lock('lk-2', 'device:android-03', 'tsk-2', '2099-01-01T00:00:00.000Z'),
        )
        assert.equal(taken.task_id, 'tsk-2')
      })

      test('释放后可再次获取', async () => {
        const s = await createStore()
        const future = '2099-01-01T00:00:00.000Z'
        await s.acquireLock(lock('lk-1', 'device:x', 'tsk-1', future))
        await s.releaseLock('lk-1', T0)

        const again = await s.acquireLock(lock('lk-2', 'device:x', 'tsk-2', future))
        assert.equal(again.task_id, 'tsk-2')
      })

      test('活跃锁列表按时间点过滤过期项', async () => {
        const s = await createStore()
        await s.acquireLock(lock('lk-1', 'r1', 'tsk-1', '2099-01-01T00:00:00.000Z'))
        await s.acquireLock(lock('lk-2', 'r2', 'tsk-2', '2020-01-01T00:00:00.000Z'))

        const active = await s.listActiveLocks('2026-08-02T00:00:00.000Z')
        assert.deepEqual(active.map((l) => l.lock_id), ['lk-1'])
      })
    })

    describe('审批', () => {
      test('待审批可被查出', async () => {
        const s = await createStore()
        await s.createApproval(approval('apr-1', 'controlled'))
        const pending = await s.listPendingApprovals()
        assert.equal(pending.length, 1)
        assert.equal(pending[0]!.scope, 'controlled')
      })

      test('决策后不再处于待审批', async () => {
        const s = await createStore()
        await s.createApproval(approval('apr-1', 'controlled'))
        await s.decideApproval('apr-1', 'approved', 'user:crosswarm', T0)

        assert.equal((await s.listPendingApprovals()).length, 0)
      })

      test('controlled 与 mutating 各自独立，批准一个不影响另一个', async () => {
        const s = await createStore()
        await s.createApproval(approval('apr-c', 'controlled'))
        await s.createApproval(approval('apr-m', 'mutating'))

        await s.decideApproval('apr-c', 'approved', 'user:crosswarm', T0)

        const pending = await s.listPendingApprovals()
        assert.deepEqual(
          pending.map((a) => a.id),
          ['apr-m'],
          'controlled 的批准不得放行 mutating——两类授权互不蕴含',
        )
      })

      test('决策记录批准人，不得为空', async () => {
        const s = await createStore()
        await s.createApproval(approval('apr-1', 'mutating'))
        const decided = await s.decideApproval('apr-1', 'approved', 'user:crosswarm', T0)
        assert.equal(decided.decided_by, 'user:crosswarm')
        assert.equal(decided.decided_at, T0)
      })
    })

    describe('自检', () => {
      test('healthCheck 报告可用性', async () => {
        const s = await createStore()
        const h = await s.healthCheck()
        assert.equal(h.ok, true)
      })
    })
  })
}
