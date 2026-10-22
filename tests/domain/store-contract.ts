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
  RemoteTaskBinding,
  Approval,
  ResourceLock,
  Artifact,
  Review,
  TaskResultV1,
} from '#domain-model'
import {
  ConcurrentModificationError,
  EventConflictError,
  LockUnavailableError,
} from '#domain-model'
import { MissionConflictError } from '../../packages/domain-model/src/mission-input.ts'
import { BindingConflictError, ReviewConflictError, TaskConflictError } from '../../packages/domain-model/src/store.ts'

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

/**
 * acquired_at 自动取 expires_at 前一小时。
 *
 * 不能固定成"现在"：那样构造"已过期的锁"时会得到 acquired_at 晚于
 * expires_at 的记录，现实中不可能发生。真实的过期锁是获取与过期
 * 都在过去。PG 的 CHECK 约束抓出过这个问题。
 */
const lock = (id: string, resource: string, taskId: string, expiresAt: string): ResourceLock => ({
  lock_id: id,
  resource,
  task_id: taskId,
  mission_id: 'mis-1',
  holder_runner_id: 'runner-1',
  acquired_at: new Date(Date.parse(expiresAt) - 3600_000).toISOString(),
  expires_at: expiresAt,
  released_at: null,
})

const artifact = (id: string, taskId: string, role: string): Artifact => ({
  artifact_id: id,
  mission_id: 'mis-1',
  task_id: taskId,
  role,
  uri: `artifact://mis-1/${taskId}/${role}.json`,
  media_type: 'application/json',
  size_bytes: 128,
  sha256: 'a'.repeat(64),
  version: 1,
  state: 'AVAILABLE',
  producer: { agent_id: 'codex', adapter_version: '0.1.0', execution_session_id: 'sess-1' },
  provenance: {},
  retention: { retain_until: '2027-01-01T00:00:00.000Z', immutable: true },
  security: {
    classification: 'internal',
    contains_secrets: false,
    contains_pii: false,
    allowed_roles: ['engineer'],
  },
  created_at: T0,
})

const taskResult = (taskId: string, missionId: string, passed = true): TaskResultV1 => ({
  schema: 'cmap/task-result/v1',
  mission_id: missionId,
  task_id: taskId,
  attempt: 1,
  status: passed ? 'completed' : 'failed',
  summary: passed ? '统计完成，共 3 个文件' : '统计失败',
  criterion_results: [
    { criterion_id: 'FILE-COUNT', actual: 3, passed, evidence_artifact_ids: ['art-1'] },
  ],
  artifacts: [
    {
      artifact_id: 'art-1', role: 'report', uri: 'evidence/report.json',
      media_type: 'application/json', size_bytes: 42, sha256: 'd'.repeat(64),
    },
  ],
})

const binding = (remoteTaskId = 'remote-1'): RemoteTaskBinding => ({
  adapter: 'yonwork-adapter',
  remote_task_id: remoteTaskId,
  remote_context_id: 'ctx-1',
  protocol: 'yonwork-host',
  protocol_version: '1.0.0',
  runner_id: 'runner-1',
  provider_session_id: 'sess-1',
})

const review = (
  id: string,
  missionId: string,
  round: number,
  decision: 'accept' | 'rework' | 'escalate',
): Review => ({
  id,
  mission_id: missionId,
  reviewed_task_ids: ['tsk-1'],
  round,
  decision: {
    schema: 'cmap/review-decision/v1',
    mission_id: missionId,
    reviewed_task_ids: ['tsk-1'],
    decision,
    hard_gate_summary: { total: 1, passed: decision === 'accept' ? 1 : 0, failed: decision === 'accept' ? 0 : 1 },
    ...(decision === 'rework'
      ? {
          failed_criteria: [
            { criterion_id: 'C1', expected: '= 1', actual: '2', reason: '未达标' },
          ],
          required_followups: [{ capability: 'code.analyze', task_type: 'analyze' }],
          stop_conditions: { max_additional_cycles: 1 },
        }
      : {}),
    review_confidence: { level: 'high' },
  } as Review['decision'],
  created_at: T0,
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

      test('状态变更记成对应的事件，不得张冠李戴', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })

        await s.setMissionState('mis-1', 'RUNNING', ACTOR)
        const running = (await s.listEvents('mis-1')).map((e) => e.event_type)
        assert.ok(
          !running.includes('MISSION_ESCALATED'),
          '刚开始跑的 Mission 被记成「已升级」，等于给界面造了一个假的求救信号',
        )
        assert.ok(running.includes('MISSION_STATE_CHANGED'), '状态变更应留下中性事件')

        await s.setMissionState('mis-1', 'ESCALATED', ACTOR)
        assert.ok((await s.listEvents('mis-1')).some((e) => e.event_type === 'MISSION_ESCALATED'))
      })

      test('已终结的 Mission 不能回到运行态：取消后迟到的 RUNNING 不得复活它', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.setMissionState('mis-1', 'CANCELED', ACTOR)
        await assert.rejects(s.setMissionState('mis-1', 'RUNNING', ACTOR))
        assert.equal((await s.getMission('mis-1'))?.state, 'CANCELED')
      })

      test('失败与完成分别记成各自的事件', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createMission({ mission: mission('mis-2'), actor: ACTOR })

        await s.setMissionState('mis-1', 'COMPLETED', ACTOR)
        await s.setMissionState('mis-2', 'FAILED', ACTOR)

        assert.ok((await s.listEvents('mis-1')).some((e) => e.event_type === 'MISSION_COMPLETED'))
        const failed = (await s.listEvents('mis-2')).map((e) => e.event_type)
        assert.ok(failed.includes('MISSION_FAILED'), '失败必须与升级区分——一个要人来救，一个不用')
      })

      test('等待态解除后可再次回到 RUNNING，不与首次 RUNNING 的幂等键冲突', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })

        await s.setMissionState('mis-1', 'RUNNING', ACTOR)
        await s.setMissionState('mis-1', 'AWAITING_APPROVAL', ACTOR)
        await s.setMissionState('mis-1', 'RUNNING', ACTOR)
        await s.setMissionState('mis-1', 'AWAITING_APPROVAL', ACTOR, 'approval-wait:round-2')
        await s.setMissionState('mis-1', 'RUNNING', ACTOR, 'approval-resumed:round-2')

        assert.equal((await s.getMission('mis-1'))?.state, 'RUNNING')
        const changed = (await s.listEvents('mis-1')).filter(
          (event) => event.event_type === 'MISSION_STATE_CHANGED',
        )
        assert.equal(changed.length, 5, '每一轮等待与恢复都是独立迁移')
      })

      test('创建 Mission 产生事件', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        const events = await s.listEvents('mis-1')
        assert.ok(events.some((e) => e.event_type === 'MISSION_CREATED'))
        assert.equal(events.find((e) => e.event_type === 'MISSION_CREATED')?.payload['goal'], undefined)
      })

      test('同一 Mission 创建请求语义相同则幂等返回既有记录且不重复写事件', async () => {
        const s = await createStore()
        const first = {
          ...mission('mis-1'),
          constraints: { a: true, b: { x: 1, y: 2 } },
        }
        await s.createMission({ mission: first, actor: ACTOR })
        await s.setMissionState('mis-1', 'RUNNING', ACTOR)
        const existing = await s.getMission('mis-1')
        const before = await s.listEvents('mis-1')

        const again = await s.createMission({
          mission: {
            ...first,
            constraints: { b: { y: 2, x: 1 }, a: true },
            state: 'DRAFT',
            revision: 99,
            created_at: '2026-08-03T00:00:00.000Z',
            updated_at: '2026-08-03T00:00:00.000Z',
          },
          actor: ACTOR,
        })

        assert.equal(again.state, 'RUNNING')
        assert.equal(again.revision, 1)
        assert.equal(again.updated_at, existing?.updated_at)
        assert.equal((await s.listEvents('mis-1')).length, before.length)
      })

      test('同一 Mission 创建请求语义不同则冲突且不覆盖既有记录', async () => {
        const s = await createStore()
        const first = mission('mis-1')
        await s.createMission({ mission: first, actor: ACTOR })
        const before = await s.listEvents('mis-1')

        await assert.rejects(
          () => s.createMission({ mission: { ...first, goal: '换一个目标' }, actor: ACTOR }),
          MissionConflictError,
        )
        assert.equal((await s.getMission('mis-1'))?.goal, first.goal)
        assert.equal((await s.listEvents('mis-1')).length, before.length)
      })

      test('按 tenant 查询 Mission，包含还没有 Task 的 Mission 并隔离其他租户', async () => {
        const s = await createStore()
        await s.createMission({
          mission: { ...mission('mis-empty'), created_at: '2026-08-02T00:00:01.000Z' },
          actor: ACTOR,
        })
        await s.createMission({
          mission: { ...mission('mis-with-task'), created_at: '2026-08-02T00:00:00.000Z' },
          actor: ACTOR,
        })
        await s.createMission({
          mission: {
            ...mission('mis-other-tenant'),
            tenant: 'team-other',
            created_at: '2026-08-02T00:00:00.000Z',
          },
          actor: ACTOR,
        })
        await s.createTask({ task: task('tsk-1', 'mis-with-task'), actor: ACTOR })

        const got = await s.queryMissions({ tenant: 'team-ycc' })
        assert.deepEqual(
          got.map((m) => m.id),
          ['mis-with-task', 'mis-empty'],
          'Mission 列表必须从 missions 表出发，不能因没有 Task 而漏行',
        )
      })

      test('Mission 查询按真实创建时刻排序，同一时刻按 id 稳定排序', async () => {
        const s = await createStore()
        await s.createMission({
          mission: { ...mission('mis-a'), created_at: '2026-08-02T00:00:00Z' },
          actor: ACTOR,
        })
        await s.createMission({
          mission: { ...mission('mis-b'), created_at: '2026-08-02T00:00:00.000Z' },
          actor: ACTOR,
        })
        await s.createMission({
          mission: { ...mission('mis-d'), created_at: '2026-08-02T00:00:00.001Z' },
          actor: ACTOR,
        })
        await s.createMission({
          mission: { ...mission('mis-c'), created_at: '2026-08-02T00:00:00.001Z' },
          actor: ACTOR,
        })

        const got = await s.queryMissions({ tenant: 'team-ycc' })
        assert.deepEqual(got.map((m) => m.id), ['mis-a', 'mis-b', 'mis-c', 'mis-d'])
      })
    })

    describe('Task 状态迁移', () => {
      test('同一 Task 创建请求语义相同则幂等返回既有记录且不重复写事件', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        const first = task('tsk-1', 'mis-1', { deps: ['dep-1'] })
        await s.createTask({ task: first, actor: ACTOR })
        await s.transitionTask({
          taskId: 'tsk-1',
          to: 'READY',
          actor: ACTOR,
          eventType: 'TASK_READY',
          idempotencyKey: 'tsk-1:ready',
        })
        await s.setTaskBinding('tsk-1', {
          adapter: 'codex-adapter',
          remote_task_id: 'codex:tsk-1:1',
          protocol: 'codex-exec',
          protocol_version: '0.1.0',
          runner_id: 'runner-1',
        })
        await s.setTaskResult('tsk-1', taskResult('tsk-1', 'mis-1'))
        const before = await s.listEvents('mis-1')

        const again = await s.createTask({
          task: {
            ...first,
            state: 'DRAFT',
            result: null,
            binding: null,
            lamport: 999,
            created_at: '2026-08-03T00:00:00.000Z',
            updated_at: '2026-08-03T00:00:00.000Z',
          },
          actor: ACTOR,
        })

        assert.equal(again.state, 'READY')
        assert.equal(again.binding?.remote_task_id, 'codex:tsk-1:1')
        assert.equal(again.result?.status, 'completed')
        assert.deepEqual(again.deps, ['dep-1'])
        assert.equal((await s.listEvents('mis-1')).length, before.length)
        assert.equal(
          (await s.listEvents('mis-1')).filter((e) => e.event_type === 'TASK_CREATED').length,
          1,
        )
      })

      test('同一 Task 创建请求语义不同则冲突且不覆盖既有记录', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        const first = task('tsk-1', 'mis-1')
        await s.createTask({ task: first, actor: ACTOR })
        const before = await s.listEvents('mis-1')

        await assert.rejects(
          () => s.createTask({ task: { ...first, capability: 'code.modify' }, actor: ACTOR }),
          TaskConflictError,
        )
        await assert.rejects(
          () =>
            s.createTask({
              task: {
                ...first,
                envelope: {
                  ...first.envelope,
                  identity: { ...first.envelope.identity, revision: 2 },
                },
              },
              actor: ACTOR,
            }),
          TaskConflictError,
        )
        assert.equal((await s.getTask('tsk-1'))?.capability, first.capability)
        assert.equal((await s.listEvents('mis-1')).length, before.length)
      })

      test('Task 写入后不保留调用方 envelope 引用，返回值也不能改内部快照', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        const first = task('tsk-1', 'mis-1')
        const created = await s.createTask({ task: first, actor: ACTOR })

        ;(created.envelope as { identity: { revision: number } }).identity.revision = 9
        ;(first.envelope as { identity: { revision: number } }).identity.revision = 2

        assert.equal((await s.getTask('tsk-1'))?.envelope.identity.revision, 1)
        await assert.rejects(
          () => s.createTask({ task: first, actor: ACTOR }),
          TaskConflictError,
        )
        assert.equal((await s.getTask('tsk-1'))?.envelope.identity.revision, 1)
      })

      test('并发重复创建同一 Task 只产生一条记录和一条创建事件', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        const first = task('tsk-1', 'mis-1')

        const created = await Promise.all(
          Array.from({ length: 8 }, () => s.createTask({ task: first, actor: ACTOR })),
        )

        assert.deepEqual(created.map((t) => t.id), Array(8).fill('tsk-1'))
        assert.equal((await s.queryTasks({ missionId: 'mis-1' })).length, 1)
        assert.equal(
          (await s.listEvents('mis-1')).filter((e) => e.event_type === 'TASK_CREATED').length,
          1,
        )
      })

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

      test('并发相同 idempotencyKey 的同一迁移全部幂等返回', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })

        const calls = Array.from({ length: 8 }, () =>
          s.transitionTask({
            taskId: 'tsk-1',
            to: 'READY',
            actor: ACTOR,
            eventType: 'TASK_READY',
            idempotencyKey: 'same-key-concurrent',
            expectedFrom: 'DRAFT',
          }),
        )
        const results = await Promise.all(calls)

        assert.deepEqual(results.map((r) => r.state), Array(8).fill('READY'))
        assert.equal(
          (await s.listEvents('mis-1')).filter((e) => e.idempotency_key === 'same-key-concurrent').length,
          1,
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

      test('拒绝 TTL 非正的锁——过期不早于获取才有意义', async () => {
        const s = await createStore()
        const bad: ResourceLock = {
          lock_id: 'lk-bad',
          resource: 'device:x',
          task_id: 'tsk-1',
          mission_id: 'mis-1',
          holder_runner_id: 'runner-1',
          acquired_at: '2026-08-02T10:00:00.000Z',
          expires_at: '2026-08-02T09:00:00.000Z', // 早于获取时间
          released_at: null,
        }
        await assert.rejects(
          () => s.acquireLock(bad),
          '获取时间晚于过期时间的锁不应被接受：它一诞生就是过期的，等于无锁',
        )
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
      test('决定只写一次；同一决定重试保留原时间，其他决定或批准人不能覆盖', async () => {
        const s = await createStore()
        await s.createApproval(approval('apr-once', 'controlled'))
        const first = await s.decideApproval('apr-once', 'approved', 'user:a', T0)
        assert.deepEqual(await s.decideApproval('apr-once', 'approved', 'user:a', '2026-08-04T00:00:00Z'), first)
        for (const [decision, actor] of [['rejected', 'user:a'], ['expired', 'system:timeout'], ['approved', 'user:b']] as const) {
          await assert.rejects(s.decideApproval('apr-once', decision, actor, T0), { name: 'ApprovalDecisionConflictError' })
          assert.deepEqual(await s.getApproval('apr-once'), first)
        }
      })

      test('并发冲突决定只能成功一个，落库结果等于唯一成功的结果', async () => {
        const s = await createStore()
        await s.createApproval(approval('apr-race', 'controlled'))
        const results = await Promise.allSettled([
          s.decideApproval('apr-race', 'approved', 'user:a', T0),
          s.decideApproval('apr-race', 'rejected', 'user:b', T0),
        ])
        const success = results.filter((r) => r.status === 'fulfilled')
        assert.equal(success.length, 1)
        assert.deepEqual(await s.getApproval('apr-race'), success[0]!.value)
      })

      test('过期边界不能批准，无效身份/时间不能变更审批', async () => {
        const s = await createStore()
        const a = approval('apr-expired', 'mutating')
        await s.createApproval(a)
        await assert.rejects(s.decideApproval(a.id, 'approved', 'user:a', a.expires_at), { name: 'ApprovalDecisionConflictError' })
        for (const [actor, at] of [['   ', T0], ['user:a', 'invalid'], ['user:a', '2026-08-01T00:00:00Z']]) {
          await assert.rejects(s.decideApproval(a.id, 'approved', actor!, at!), RangeError)
        }
        assert.equal((await s.getApproval(a.id))?.decision, 'pending')
      })

      test('审批可按 id 读回，已决策记录也不消失', async () => {
        const s = await createStore()
        await s.createApproval(approval('apr-1', 'controlled'))
        assert.equal((await s.getApproval('apr-1'))?.decision, 'pending')

        await s.decideApproval('apr-1', 'approved', 'user:crosswarm', T0)
        assert.equal((await s.getApproval('apr-1'))?.decision, 'approved')
        assert.equal(await s.getApproval('ghost'), null)
      })

      test('相同 id 的审批重复创建是幂等的', async () => {
        const s = await createStore()
        const a = approval('apr-1', 'controlled')
        await s.createApproval(a)
        await s.createApproval(a)
        assert.equal((await s.listPendingApprovals()).length, 1)

        await s.decideApproval('apr-1', 'approved', 'user:crosswarm', T0)
        await s.createApproval(a)
        assert.equal(
          (await s.getApproval('apr-1'))?.decision,
          'approved',
          'Activity 重试不得用新的 pending 记录覆盖真人已经作出的决定',
        )
      })

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

    describe('任务绑定持久化（跨进程幂等的基础）', () => {
      test('claimTaskBinding 在 QUEUED 上原子绑定、转 RUNNING 并写派发意图事件', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        await driveTo(s, 'tsk-1', ['READY', 'QUEUED'])

        const before = await s.listEvents('mis-1')
        const out = await s.claimTaskBinding({ taskId: 'tsk-1', binding: binding(), actor: ACTOR })
        const events = await s.listEvents('mis-1')
        const intent = events.at(-1)

        assert.equal(out.claimed, true)
        assert.equal(out.task.state, 'RUNNING')
        assert.deepEqual(out.task.binding, binding())
        assert.equal(events.length, before.length + 1)
        assert.equal(intent?.event_type, 'TASK_DISPATCH_INTENT')
        assert.deepEqual(intent?.payload, {
          from: 'QUEUED',
          to: 'RUNNING',
          binding: binding(),
        })
      })

      test('claimTaskBinding 可从 WAITING_RESOURCE 恢复派发', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        await driveTo(s, 'tsk-1', ['READY', 'QUEUED', 'WAITING_RESOURCE'])

        const out = await s.claimTaskBinding({ taskId: 'tsk-1', binding: binding(), actor: ACTOR })

        assert.equal(out.claimed, true)
        assert.equal(out.task.state, 'RUNNING')
        assert.deepEqual(out.task.binding, binding())
      })

      test('claimTaskBinding 同一 binding 重放不改当前状态、结果或事件', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        await driveTo(s, 'tsk-1', ['READY', 'QUEUED'])
        await s.claimTaskBinding({ taskId: 'tsk-1', binding: binding(), actor: ACTOR })
        await s.setTaskResult('tsk-1', taskResult('tsk-1', 'mis-1'))
        await s.transitionTask({
          taskId: 'tsk-1', to: 'VERIFYING', actor: ACTOR,
          eventType: 'HARD_GATE_EVALUATED', idempotencyKey: 'tsk-1:verifying',
        })
        const eventCount = (await s.listEvents('mis-1')).length

        const replay = await s.claimTaskBinding({ taskId: 'tsk-1', binding: binding(), actor: ACTOR })

        assert.equal(replay.claimed, false)
        assert.equal(replay.task.state, 'VERIFYING')
        assert.equal(replay.task.result?.status, 'completed')
        assert.equal((await s.listEvents('mis-1')).length, eventCount)
      })

      test('claimTaskBinding 的审计事件不受调用方对象或读取方对象后续修改影响', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        await driveTo(s, 'tsk-1', ['READY', 'QUEUED'])
        const b = binding()
        const actor: EventActor = { type: 'system', id: 'dispatcher', runner_id: 'runner-1' }

        await s.claimTaskBinding({ taskId: 'tsk-1', binding: b, actor })
        ;(b as { remote_task_id: string }).remote_task_id = 'mutated-remote'
        ;(actor as { id: string }).id = 'mutated-actor'

        const first = (await s.listEvents('mis-1')).find((e) => e.event_type === 'TASK_DISPATCH_INTENT')
        assert.equal(first?.actor.id, 'dispatcher')
        assert.equal((first?.payload.binding as RemoteTaskBinding | undefined)?.remote_task_id, 'remote-1')

        ;((first?.payload.binding as RemoteTaskBinding) as { remote_task_id: string }).remote_task_id = 'tampered-read'
        ;(first?.actor as { id: string }).id = 'tampered-reader'

        const reread = (await s.listEvents('mis-1')).find((e) => e.event_type === 'TASK_DISPATCH_INTENT')
        assert.equal(reread?.actor.id, 'dispatcher')
        assert.equal((reread?.payload.binding as RemoteTaskBinding | undefined)?.remote_task_id, 'remote-1')
      })

      test('claimTaskBinding 不同 binding 冲突且不追加事件', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        await driveTo(s, 'tsk-1', ['READY', 'QUEUED'])
        await s.claimTaskBinding({ taskId: 'tsk-1', binding: binding(), actor: ACTOR })
        const eventCount = (await s.listEvents('mis-1')).length

        await assert.rejects(
          () => s.claimTaskBinding({ taskId: 'tsk-1', binding: binding('remote-2'), actor: ACTOR }),
          BindingConflictError,
        )
        assert.equal((await s.listEvents('mis-1')).length, eventCount)
      })

      test('claimTaskBinding 只允许未绑定的 QUEUED/WAITING_RESOURCE 任务', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('draft', 'mis-1'), actor: ACTOR })
        await s.createTask({ task: task('approval', 'mis-1'), actor: ACTOR })
        await s.createTask({ task: task('done', 'mis-1'), actor: ACTOR })
        await driveTo(s, 'approval', ['READY', 'APPROVAL_REQUIRED'])
        await driveTo(s, 'done', ['READY', 'QUEUED', 'RUNNING', 'VERIFYING', 'REVIEWING', 'COMPLETED'])

        await assert.rejects(
          () => s.claimTaskBinding({ taskId: 'ghost', binding: binding(), actor: ACTOR }),
          /不存在/,
        )
        await assert.rejects(
          () => s.claimTaskBinding({ taskId: 'draft', binding: binding(), actor: ACTOR }),
          IllegalTransitionError,
        )
        await assert.rejects(
          () => s.claimTaskBinding({ taskId: 'approval', binding: binding(), actor: ACTOR }),
          IllegalTransitionError,
        )
        await assert.rejects(
          () => s.claimTaskBinding({ taskId: 'done', binding: binding(), actor: ACTOR }),
          IllegalTransitionError,
        )
        assert.equal((await s.getTask('draft'))?.binding, null)
        assert.equal((await s.getTask('approval'))?.binding, null)
        assert.equal((await s.getTask('done'))?.binding, null)
      })

      test('claimTaskBinding 并发时只有一个调用者赢得未绑定任务', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        await driveTo(s, 'tsk-1', ['READY', 'QUEUED'])

        const results = await Promise.allSettled([
          s.claimTaskBinding({ taskId: 'tsk-1', binding: binding('remote-a'), actor: ACTOR }),
          s.claimTaskBinding({ taskId: 'tsk-1', binding: binding('remote-b'), actor: ACTOR }),
        ])
        const claimed = results.filter(
          (r): r is PromiseFulfilledResult<Awaited<ReturnType<Store['claimTaskBinding']>>> =>
            r.status === 'fulfilled' && r.value.claimed,
        )
        const conflicts = results.filter(
          (r): r is PromiseRejectedResult =>
            r.status === 'rejected' && r.reason instanceof BindingConflictError,
        )

        assert.equal(claimed.length, 1)
        assert.equal(conflicts.length, 1)
        assert.equal(
          (await s.listEvents('mis-1')).filter((e) => e.event_type === 'TASK_DISPATCH_INTENT').length,
          1,
        )
      })

      test('binding 写入后可读回，runner_id 不丢失', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })

        await s.setTaskBinding('tsk-1', {
          adapter: 'codex-adapter',
          remote_task_id: 'codex:tsk-1:1',
          protocol: 'codex-exec',
          protocol_version: '0.1.0',
          runner_id: 'runner-mac-a',
          provider_session_id: 'sess-9',
        })

        const back = await s.getTask('tsk-1')
        assert.equal(back?.binding?.remote_task_id, 'codex:tsk-1:1')
        assert.equal(
          back?.binding?.runner_id,
          'runner-mac-a',
          'runner_id 丢失会导致 P4 时无法定位任务在哪台机器执行',
        )
        assert.equal(back?.binding?.provider_session_id, 'sess-9')
      })

      test('未派发的任务 binding 为 null', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        assert.equal((await s.getTask('tsk-1'))?.binding, null)
      })

      test('对不存在的任务设置 binding 抛错', async () => {
        const s = await createStore()
        await assert.rejects(
          () =>
            s.setTaskBinding('ghost', {
              adapter: 'a', remote_task_id: 'r', protocol: 'p',
              protocol_version: '1', runner_id: 'runner-1',
            }),
          /不存在/,
        )
      })
    })

    describe('证据写入冲突（Agent 爱用 report 这种大众名字）', () => {
      test('同一 artifact 重复写入是幂等的', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })

        await s.putArtifact(artifact('art-1', 'tsk-1', 'report'))
        await s.putArtifact(artifact('art-1', 'tsk-1', 'report'))

        assert.equal((await s.listArtifacts('tsk-1')).length, 1)
      })

      test('同一任务、同一 role、同一 version 只能有一份（与 PG 唯一约束一致）', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })

        await s.putArtifact(artifact('art-1', 'tsk-1', 'report'))
        await assert.rejects(() => s.putArtifact(artifact('art-2', 'tsk-1', 'report')))
        await s.putArtifact({ ...artifact('art-2', 'tsk-1', 'report'), version: 2 })
        assert.equal((await s.listArtifacts('tsk-1')).length, 2)
      })

      test('同一 id 落到另一个任务必须报错，不得静默丢弃或覆盖', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-2', 'mis-1'), actor: ACTOR })

        await s.putArtifact(artifact('report', 'tsk-1', 'report'))

        // 静默处理会让第二个任务「有结论没证据」，而两个实现各自静默的
        // 方式还不一样（一个保留旧的，一个覆盖新的）——那是最难查的一类不一致
        await assert.rejects(
          () => s.putArtifact(artifact('report', 'tsk-2', 'report')),
          /冲突|已属于/,
        )
        assert.equal((await s.listArtifacts('tsk-1')).length, 1, '原任务的证据不得被顶掉')
      })
    })

    describe('任务结果落库（Agent 干完活之后）', () => {
      test('结果写入后可原样读回', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })

        await s.setTaskResult('tsk-1', taskResult('tsk-1', 'mis-1'))

        const back = await s.getTask('tsk-1')
        assert.equal(back?.result?.status, 'completed')
        assert.equal(back?.result?.summary, '统计完成，共 3 个文件')
        assert.equal(
          back?.result?.criterion_results[0]?.passed,
          true,
          '逐条验收结论必须落库——它是「这个通过是怎么来的」的唯一凭据',
        )
        assert.equal(back?.result?.artifacts[0]?.sha256, 'd'.repeat(64))
      })

      test('未收结果的任务 result 为 null', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        assert.equal((await s.getTask('tsk-1'))?.result, null)
      })

      test('重复写入以最后一次为准（重试收取同一结果不得报错）', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })

        await s.setTaskResult('tsk-1', taskResult('tsk-1', 'mis-1', false))
        await s.setTaskResult('tsk-1', taskResult('tsk-1', 'mis-1', true))

        assert.equal((await s.getTask('tsk-1'))?.result?.status, 'completed')
      })

      test('对不存在的任务写结果抛错，不得静默丢弃', async () => {
        const s = await createStore()
        await assert.rejects(() => s.setTaskResult('ghost', taskResult('ghost', 'mis-1')), /不存在/)
      })
    })

    describe('锁续租（哑资源的脑裂防线）', () => {
      test('持有者可续租，延长过期时间', async () => {
        const s = await createStore()
        const soon = new Date(Date.now() + 60_000).toISOString()
        await s.acquireLock(lock('lk-1', 'device:x', 'tsk-1', soon))

        const later = new Date(Date.now() + 600_000).toISOString()
        const ok = await s.renewLock('lk-1', later)

        assert.equal(ok, true)
        const active = await s.listActiveLocks(new Date(Date.now() + 120_000).toISOString())
        assert.ok(
          active.some((l) => l.lock_id === 'lk-1'),
          '续租后应在原过期时间点之后仍然活跃',
        )
      })

      test('已释放的锁续租失败——这是 runner 应终止操作的信号', async () => {
        const s = await createStore()
        const soon = new Date(Date.now() + 60_000).toISOString()
        await s.acquireLock(lock('lk-1', 'device:x', 'tsk-1', soon))
        await s.releaseLock('lk-1', new Date().toISOString())

        assert.equal(
          await s.renewLock('lk-1', new Date(Date.now() + 600_000).toISOString()),
          false,
          '续租必须返回失败而非静默成功，否则 runner 会以为自己仍持有独占',
        )
      })

      test('已被他人抢占后续租失败', async () => {
        const s = await createStore()
        const past = new Date(Date.now() - 1000).toISOString()
        await s.acquireLock(lock('lk-1', 'device:x', 'tsk-1', past))
        // 过期后被抢占
        await s.acquireLock(lock('lk-2', 'device:x', 'tsk-2', new Date(Date.now() + 600_000).toISOString()))

        assert.equal(
          await s.renewLock('lk-1', new Date(Date.now() + 600_000).toISOString()),
          false,
          '资源已易主，原持有者续租必须失败',
        )
      })

      test('过期期间被他人抢过又释放，原持有者续租仍须失败', async () => {
        const s = await createStore()
        const past = new Date(Date.now() - 1000).toISOString()
        await s.acquireLock(lock('lk-1', 'device:x', 'tsk-1', past))
        await s.acquireLock(lock('lk-2', 'device:x', 'tsk-2', new Date(Date.now() + 600_000).toISOString()))
        await s.releaseLock('lk-2', new Date().toISOString())

        assert.equal(
          await s.renewLock('lk-1', new Date(Date.now() + 600_000).toISOString()),
          false,
          '过期后独占已无法证明：续租成功会让两个 Agent 先后操作同一台真机',
        )
      })

      test('续租不存在的锁返回 false 而非抛错', async () => {
        const s = await createStore()
        assert.equal(await s.renewLock('nope', new Date(Date.now() + 1000).toISOString()), false)
      })
    })

    describe('Artifact', () => {
      test('写入后可按 task 读回', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        await s.putArtifact(artifact('art-1', 'tsk-1', 'report'))

        const got = await s.listArtifacts('tsk-1')
        assert.equal(got.length, 1)
        assert.equal(got[0]!.role, 'report')
        assert.equal(got[0]!.sha256.length, 64, 'sha256 必须完整保存，不得被截断')
      })

      test('按 task 隔离，不串号', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-2', 'mis-1'), actor: ACTOR })
        await s.putArtifact(artifact('art-1', 'tsk-1', 'report'))
        await s.putArtifact(artifact('art-2', 'tsk-2', 'trace'))

        assert.deepEqual((await s.listArtifacts('tsk-1')).map((a) => a.artifact_id), ['art-1'])
        assert.deepEqual((await s.listArtifacts('tsk-2')).map((a) => a.artifact_id), ['art-2'])
      })

      test('无产物时返回空数组而非报错', async () => {
        const s = await createStore()
        assert.deepEqual(await s.listArtifacts('nobody'), [])
      })
    })

    describe('Artifact 血缘', () => {
      const seed = async (s: Store) => {
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        await s.putArtifact(artifact('art-before', 'tsk-1', 'measure_before'))
        await s.putArtifact(artifact('art-after', 'tsk-1', 'measure_after'))
        await s.putArtifact(artifact('art-diff', 'tsk-1', 'metric_diff'))
      }

      test('SUPERSEDES 边写入后可读回，relation 正确', async () => {
        const s = await createStore()
        await seed(s)

        await s.linkArtifacts({
          source_artifact_id: 'art-after',
          target_artifact_id: 'art-before',
          relation: 'SUPERSEDES',
        })

        const edges = await s.listLineage('art-after')
        assert.equal(edges.length, 1)
        assert.equal(edges[0]!.target_artifact_id, 'art-before')
        assert.equal(edges[0]!.relation, 'SUPERSEDES')
      })

      test('同一 artifact 可有多条出边', async () => {
        const s = await createStore()
        await seed(s)

        // 指标对比派生自前后两份原始测量
        await s.linkArtifacts({
          source_artifact_id: 'art-diff',
          target_artifact_id: 'art-before',
          relation: 'DERIVED_FROM',
        })
        await s.linkArtifacts({
          source_artifact_id: 'art-diff',
          target_artifact_id: 'art-after',
          relation: 'DERIVED_FROM',
        })

        const edges = await s.listLineage('art-diff')
        assert.equal(edges.length, 2)
        assert.deepEqual(
          edges.map((e) => e.target_artifact_id).sort(),
          ['art-after', 'art-before'],
        )
      })

      test('对不存在的 artifact 建边必须抛错，不得留下悬空边', async () => {
        const s = await createStore()
        await seed(s)

        await assert.rejects(
          () =>
            s.linkArtifacts({
              source_artifact_id: 'art-after',
              target_artifact_id: 'ghost',
              relation: 'SUPERSEDES',
            }),
          '悬空边会让血缘链在追溯时断裂，且无法被发现',
        )

        assert.equal(
          (await s.listLineage('art-after')).length,
          0,
          '失败的建边不得留下任何痕迹',
        )
      })

      test('无血缘的 artifact 返回空数组', async () => {
        const s = await createStore()
        await seed(s)
        assert.deepEqual(await s.listLineage('art-before'), [])
      })
    })

    describe('Review', () => {
      test('写入后可按 mission 读回，且按轮次有序', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.putReview(review('rev-2', 'mis-1', 2, 'rework'))
        await s.putReview(review('rev-1', 'mis-1', 1, 'rework'))

        const got = await s.listReviews('mis-1')
        assert.deepEqual(got.map((r) => r.round), [1, 2], '返工追踪依赖轮次顺序')
      })

      test('decision 完整保留，不丢失返工指令', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.putReview(review('rev-1', 'mis-1', 1, 'rework'))

        const got = await s.listReviews('mis-1')
        assert.equal(got[0]!.decision.decision, 'rework')
        assert.equal(
          got[0]!.decision.failed_criteria?.[0]?.criterion_id,
          'C1',
          'failed_criteria 丢失会导致无法据以创建后继 Task',
        )
      })

      test('同一 Review 写入语义相同则幂等返回既有记录', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        const first = review('rev-1', 'mis-1', 1, 'accept')
        await s.putReview(first)

        const again = await s.putReview({
          ...first,
          created_at: '2026-08-03T00:00:00.000Z',
        })

        assert.equal(again.created_at, T0)
        assert.equal((await s.listReviews('mis-1')).length, 1)
      })

      test('同一 Review 写入语义不同则冲突且不覆盖既有记录', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        const first = review('rev-1', 'mis-1', 1, 'accept')
        await s.putReview(first)

        await assert.rejects(
          () => s.putReview({ ...first, decision: review('rev-1', 'mis-1', 1, 'rework').decision }),
          ReviewConflictError,
        )
        const got = await s.listReviews('mis-1')
        assert.equal(got.length, 1)
        assert.equal(got[0]!.decision.decision, 'accept')
      })

      test('Review 写入后不保留调用方 decision 引用，返回值也不能改内部快照', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        const first = review('rev-1', 'mis-1', 1, 'accept')
        const written = await s.putReview(first)

        ;(written.decision as unknown as { decision: string }).decision = 'escalate'
        ;(first.decision as unknown as { decision: string }).decision = 'rework'

        assert.equal((await s.listReviews('mis-1'))[0]!.decision.decision, 'accept')
        await assert.rejects(
          () => s.putReview(first),
          ReviewConflictError,
        )
        assert.equal((await s.listReviews('mis-1'))[0]!.decision.decision, 'accept')
      })

      test('并发重复写入同一 Review 只保留一条记录', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        const first = review('rev-1', 'mis-1', 1, 'accept')

        const written = await Promise.all(Array.from({ length: 8 }, () => s.putReview(first)))

        assert.deepEqual(written.map((r) => r.id), Array(8).fill('rev-1'))
        assert.equal((await s.listReviews('mis-1')).length, 1)
      })
    })

    describe('任务查询', () => {
      test('按 mission 过滤', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createMission({ mission: mission('mis-2'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-2', 'mis-2'), actor: ACTOR })

        assert.deepEqual(
          (await s.queryTasks({ missionId: 'mis-1' })).map((t) => t.id),
          ['tsk-1'],
        )
      })

      test('按状态过滤', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-2', 'mis-1'), actor: ACTOR })
        await driveTo(s, 'tsk-1', ['READY'])

        assert.deepEqual(
          (await s.queryTasks({ missionId: 'mis-1', states: ['READY'] })).map((t) => t.id),
          ['tsk-1'],
        )
      })

      test('按能力过滤', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        await s.createTask({
          task: task('tsk-2', 'mis-1', { capability: 'realdevice-validation' }),
          actor: ACTOR,
        })

        assert.deepEqual(
          (await s.queryTasks({ capability: 'realdevice-validation' })).map((t) => t.id),
          ['tsk-2'],
        )
      })

      test('limit 生效', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-2', 'mis-1'), actor: ACTOR })

        assert.equal((await s.queryTasks({ missionId: 'mis-1', limit: 1 })).length, 1)
      })
    })

    describe('直接追加事件', () => {
      const appendedEvent = (overrides: Partial<Parameters<Store['appendEvent']>[0]['event']> = {}) => ({
        event: {
          event_type: 'TASK_HEARTBEAT' as const,
          event_version: 7,
          occurred_at: T0,
          mission_id: 'mis-1',
          task_id: 'tsk-1',
          attempt: 2,
          actor: { ...ACTOR, runner_id: 'runner-1' },
          causation_id: 'cause-1',
          correlation_id: 'corr-1',
          trace_id: 'trace-1',
          idempotency_key: 'append-semantic',
          payload: { nested: { ok: true }, list: [1, 2] },
          ...overrides,
        },
      })

      test('写入后出现在事件流中', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })

        await s.appendEvent({
          event: {
            event_type: 'AGENT_MESSAGE_RECEIVED',
            event_version: 1,
            occurred_at: T0,
            mission_id: 'mis-1',
            task_id: null,
            attempt: null,
            actor: ACTOR,
            causation_id: null,
            correlation_id: 'mis-1',
            trace_id: null,
            idempotency_key: 'append-1',
            payload: { note: 'hello' },
          },
        })

        const events = await s.listEvents('mis-1')
        assert.ok(events.some((e) => e.event_type === 'AGENT_MESSAGE_RECEIVED'))
      })

      test('appendEvent 保留调用方提供的事件元数据', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })

        const e = await s.appendEvent(appendedEvent())

        assert.equal(e.event_version, 7)
        assert.equal(e.occurred_at, T0)
        assert.equal(e.task_id, 'tsk-1')
        assert.equal(e.attempt, 2)
        assert.deepEqual(e.actor, { ...ACTOR, runner_id: 'runner-1' })
        assert.equal(e.causation_id, 'cause-1')
        assert.equal(e.correlation_id, 'corr-1')
        assert.equal(e.trace_id, 'trace-1')
        assert.deepEqual(e.payload, { nested: { ok: true }, list: [1, 2] })

        const emptyRunner = await s.appendEvent(appendedEvent({
          actor: { ...ACTOR, runner_id: '' },
          idempotency_key: 'append-empty-runner',
        }))
        assert.deepEqual(emptyRunner.actor, { ...ACTOR, runner_id: '' })
      })

      test('相同 idempotency_key 重复追加只留一条', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })

        const mk = () => ({
          event: {
            event_type: 'TASK_HEARTBEAT' as const,
            event_version: 1,
            occurred_at: T0,
            mission_id: 'mis-1',
            task_id: null,
            attempt: null,
            actor: ACTOR,
            causation_id: null,
            correlation_id: 'mis-1',
            trace_id: null,
            idempotency_key: 'dup-append',
            payload: {},
          },
        })

        const first = await s.appendEvent(mk())
        const second = await s.appendEvent(mk())

        assert.equal(second.event_id, first.event_id, '重复投递应返回已有事件而非新建')
        assert.equal(
          (await s.listEvents('mis-1')).filter((e) => e.idempotency_key === 'dup-append').length,
          1,
        )
      })

      test('相同 idempotency_key 且仅 timestamp 不同返回首条事件', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })

        const first = await s.appendEvent(appendedEvent())
        const second = await s.appendEvent(appendedEvent({ occurred_at: '2026-08-02T00:00:01.000Z' }))

        assert.equal(second.event_id, first.event_id)
        assert.equal(second.occurred_at, T0)
      })

      test('相同 idempotency_key 但语义输入不同会拒绝', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })

        await s.appendEvent(appendedEvent())

        await assert.rejects(
          s.appendEvent(appendedEvent({ payload: { nested: { ok: false }, list: [1, 2] } })),
          EventConflictError,
        )
        await assert.rejects(
          Promise.all([
            s.appendEvent(appendedEvent({ idempotency_key: 'append-race', payload: { winner: 1 } })),
            s.appendEvent(appendedEvent({ idempotency_key: 'append-race', payload: { winner: 2 } })),
          ]),
          EventConflictError,
        )
      })

      test('追加的事件同样进入未投递队列', async () => {
        const s = await createStore()
        await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
        const e = await s.appendEvent({
          event: {
            event_type: 'TASK_HEARTBEAT',
            event_version: 1,
            occurred_at: T0,
            mission_id: 'mis-1',
            task_id: null,
            attempt: null,
            actor: ACTOR,
            causation_id: null,
            correlation_id: 'mis-1',
            trace_id: null,
            idempotency_key: 'append-outbox',
            payload: {},
          },
        })

        const pending = await s.listUndeliveredEvents(50)
        assert.ok(
          pending.some((p) => p.event_id === e.event_id),
          '经 appendEvent 写入的事件也必须能被投递器发现，否则会静默丢失',
        )
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
