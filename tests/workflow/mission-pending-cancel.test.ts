import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import pg from 'pg'

import { MemoryStore, PgStore } from '#domain-model'
import type { EventActor, Mission, RemoteTaskBinding, Store, TaskRecord, TaskResultV1 } from '#domain-model'
import {
  cancelPendingMissionTasks,
  MISSION_ACTOR,
  type CancelPendingMissionTasksInput,
} from '../../workflows/mission-pending-cancel.ts'

const ACTOR: EventActor = { type: 'system', id: 'test' }
const T0 = '2026-09-22T00:00:00.000Z'
const CONN = process.env['CMAP_DATABASE_URL'] ?? 'postgres://temporal:temporal@localhost:5433/cmap'
const pgSchemas: string[] = []

process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'

const mission = (id: string): Mission => ({
  id,
  tenant: 'team-ycc',
  owner: 'crosswarm',
  type: 'perf',
  goal: '验证 pending cleanup',
  constraints: {},
  acceptance: [{ criterion_id: 'C1', metric: 'm', operator: 'eq', expected: 1, hard_gate: true }],
  workflow_template: 'perf/v1',
  state: 'RUNNING',
  revision: 1,
  created_at: T0,
  updated_at: T0,
})

const task = (missionId: string, id: string, patch: Partial<TaskRecord> = {}): TaskRecord => ({
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
    identity: { mission_id: missionId, task_id: id, idempotency_key: `${missionId}:${id}`, revision: 1 },
    classification: { task_type: 'inspect', requested_capability: 'code.analyze', risk_level: 'read-meta' },
    goal: { statement: '测试任务', success_definition: [{ criterion_id: 'C1', metric: 'm', operator: 'eq', expected: 1 }] },
    environment: {},
    execution_policy: { timeout_seconds: 60, max_attempts: 1 },
    permissions: { forbidden: [] },
    evidence_requirements: { required_artifact_roles: ['report'] },
    output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
  },
  result: null,
  binding: null,
  deps: [],
  created_at: T0,
  updated_at: T0,
  ...patch,
})

const BOUND: RemoteTaskBinding = {
  adapter: 'codex',
  remote_task_id: 'remote-1',
  protocol: 'codex-cli',
  protocol_version: '1',
  runner_id: 'runner-1',
}

const result = (missionId: string, taskId: string): TaskResultV1 => ({
  schema: 'cmap/task-result/v1',
  mission_id: missionId,
  task_id: taskId,
  attempt: 1,
  status: 'completed',
  summary: 'done',
  criterion_results: [{ criterion_id: 'C1', actual: 1, passed: true, evidence_artifact_ids: [] }],
  artifacts: [],
})

const setup = async (store: Store, missionId: string, taskIds: readonly string[]): Promise<void> => {
  await store.createMission({ mission: mission(missionId), actor: ACTOR })
  for (const id of taskIds) await store.createTask({ task: task(missionId, id), actor: ACTOR })
}

const withPgStore = async (fn: (store: PgStore) => Promise<void>): Promise<void> => {
  const schema = `cmap_pending_cancel_${process.pid}_${Date.now()}_${pgSchemas.length}`
  pgSchemas.push(schema)
  const store = new PgStore({ connectionString: CONN, schema })
  await store.migrate()
  try {
    await fn(store)
  } finally {
    await store.close()
  }
}

after(async () => {
  for (const schema of pgSchemas.splice(0)) {
    const client = new pg.Client({ connectionString: CONN })
    await client.connect()
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    } finally {
      await client.end()
    }
  }
})

class LostTransitionReturnStore extends MemoryStore {
  #key: string
  #remaining: number

  constructor(key: string, times = 1) {
    super()
    this.#key = key
    this.#remaining = times
  }

  override async transitionTask(input: Parameters<MemoryStore['transitionTask']>[0]) {
    const out = await super.transitionTask(input)
    if (input.idempotencyKey === this.#key && this.#remaining > 0) {
      this.#remaining -= 1
      throw new Error('lost transition return after commit')
    }
    return out
  }
}

class DuplicateReceiptStore extends MemoryStore {
  injectDuplicates = false

  override async listEvents(missionId: string) {
    const events = await super.listEvents(missionId)
    const receipt = events.find((event) => event.idempotency_key.startsWith('mission-pending-cancel:'))
    return this.injectDuplicates && receipt
      ? [...events, { ...receipt, event_id: `${receipt.event_id}-dup`, lamport: receipt.lamport + 100 }]
      : events
  }
}

class CommitDuringReceiptReadStore extends MemoryStore {
  #done = false
  readonly #missionId: string
  readonly #taskIds: readonly string[]
  readonly #reason: CancelPendingMissionTasksInput['reason']

  constructor(missionId: string, taskIds: readonly string[], reason: CancelPendingMissionTasksInput['reason']) {
    super()
    this.#missionId = missionId
    this.#taskIds = taskIds
    this.#reason = reason
  }

  override async listEvents(missionId: string) {
    if (!this.#done && missionId === this.#missionId) {
      this.#done = true
      const taskId = this.#taskIds[0]!
      await super.transitionTask({
        taskId,
        to: 'CANCELED',
        expectedFrom: 'DRAFT',
        actor: MISSION_ACTOR,
        eventType: 'TASK_CANCELED',
        idempotencyKey: `mission-pending-cancel:${taskId}`,
        payload: {
          reason: this.#reason,
          request_sha256: requestSha(this.#missionId, this.#reason, this.#taskIds),
        },
      })
    }
    return super.listEvents(missionId)
  }
}

const requestSha = (
  missionId: string,
  reason: CancelPendingMissionTasksInput['reason'],
  taskIds: readonly string[],
): string => createHash('sha256')
  .update(JSON.stringify(['cmap/mission-pending-cancel/v1', missionId, reason, [...taskIds]]))
  .digest('hex')

const input = (
  missionId: string,
  taskIds: readonly string[],
  reason: CancelPendingMissionTasksInput['reason'] = 'BRANCH_ESCALATED',
): CancelPendingMissionTasksInput => ({ missionId, taskIds, reason })

const assertCanceled = async (store: Store, missionId: string, taskId: string, reason = 'BRANCH_ESCALATED') => {
  const t = await store.getTask(taskId)
  assert.equal(t?.state, 'CANCELED')
  assert.equal(t?.binding, null)
  assert.equal(t?.result, null)
  const events = (await store.listEvents(missionId)).filter((e) => e.idempotency_key === `mission-pending-cancel:${taskId}`)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.event_type, 'TASK_CANCELED')
  assert.equal(events[0]?.actor.id, 'mission-workflow')
  assert.equal(events[0]?.payload['from'], 'DRAFT')
  assert.equal(events[0]?.payload['to'], 'CANCELED')
  assert.equal(events[0]?.payload['reason'], reason)
  assert.equal(typeof events[0]?.payload['request_sha256'], 'string')
}

const runSharedCases = (name: string, makeStore: (fn: (store: Store) => Promise<void>) => Promise<void>) => {
  describe(`cancelPendingMissionTasks ${name}`, () => {
    test('cancels only unbound result-free DRAFT tasks with strict receipt', async () => {
      await makeStore(async (store) => {
        await setup(store, 'mis-cancel', ['tsk-a', 'tsk-b'])
        await cancelPendingMissionTasks(store, input('mis-cancel', ['tsk-a', 'tsk-b']))
        await assertCanceled(store, 'mis-cancel', 'tsk-a')
        await assertCanceled(store, 'mis-cancel', 'tsk-b')
      })
    })

    test('accepts exact retry and rejects changed reason or ordered ids', async () => {
      await makeStore(async (store) => {
        await setup(store, 'mis-retry', ['tsk-a', 'tsk-b'])
        await cancelPendingMissionTasks(store, input('mis-retry', ['tsk-a', 'tsk-b']))
        await cancelPendingMissionTasks(store, input('mis-retry', ['tsk-a', 'tsk-b']))
        await assert.rejects(
          cancelPendingMissionTasks(store, input('mis-retry', ['tsk-a', 'tsk-b'], 'APPROVAL_REJECTED')),
          /conflicting|receipt/i,
        )
        await assert.rejects(
          cancelPendingMissionTasks(store, input('mis-retry', ['tsk-b', 'tsk-a'])),
          /conflicting|receipt/i,
        )
      })
    })

    test('preflights every task before writing', async () => {
      await makeStore(async (store) => {
        await setup(store, 'mis-preflight', ['tsk-a', 'tsk-b'])
        await store.transitionTask({
          taskId: 'tsk-b',
          to: 'READY',
          actor: ACTOR,
          eventType: 'TASK_READY',
          idempotencyKey: 'tsk-b-ready',
        })
        await assert.rejects(cancelPendingMissionTasks(store, input('mis-preflight', ['tsk-a', 'tsk-b'])), /pending cancel/i)
        assert.equal((await store.getTask('tsk-a'))?.state, 'DRAFT')
      })
    })

    test('rejects foreign, bound, result-bearing, duplicate, and forged receipt inputs', async () => {
      await makeStore(async (store) => {
        await setup(store, 'mis-main', ['tsk-a', 'tsk-result', 'tsk-forged'])
        await store.createTask({ task: task('mis-main', 'tsk-bound', { binding: BOUND }), actor: ACTOR })
        await store.createMission({ mission: mission('mis-other'), actor: ACTOR })
        await store.createTask({ task: task('mis-other', 'tsk-foreign'), actor: ACTOR })
        await store.setTaskResult('tsk-result', result('mis-main', 'tsk-result'))
        await store.transitionTask({
          taskId: 'tsk-forged',
          to: 'CANCELED',
          actor: ACTOR,
          eventType: 'TASK_CANCELED',
          idempotencyKey: 'other-cancel',
          payload: { reason: 'BRANCH_ESCALATED', request_sha256: '0'.repeat(64) },
        })
        await assert.rejects(cancelPendingMissionTasks(store, input('mis-main', ['tsk-a', 'tsk-a'])), /duplicate/i)
        await assert.rejects(cancelPendingMissionTasks(store, input('mis-main', ['tsk-foreign'])), /mission/i)
        await assert.rejects(cancelPendingMissionTasks(store, input('mis-main', ['tsk-bound'])), /binding/i)
        await assert.rejects(cancelPendingMissionTasks(store, input('mis-main', ['tsk-result'])), /result/i)
        await assert.rejects(cancelPendingMissionTasks(store, input('mis-main', ['tsk-forged'])), /receipt/i)
      })
    })
  })
}

runSharedCases('MemoryStore', async (fn) => fn(new MemoryStore()))
runSharedCases('PgStore', withPgStore)

test('lost commit ack retry finishes remaining tasks from a fresh call', async () => {
  const store = new LostTransitionReturnStore('mission-pending-cancel:tsk-a')
  await setup(store, 'mis-lost', ['tsk-a', 'tsk-b'])
  await assert.rejects(cancelPendingMissionTasks(store, input('mis-lost', ['tsk-a', 'tsk-b'])), /lost transition/)
  assert.equal((await store.getTask('tsk-a'))?.state, 'CANCELED')
  assert.equal((await store.getTask('tsk-b'))?.state, 'DRAFT')
  await cancelPendingMissionTasks(store, input('mis-lost', ['tsk-a', 'tsk-b']))
  await assertCanceled(store, 'mis-lost', 'tsk-a')
  await assertCanceled(store, 'mis-lost', 'tsk-b')
})

test('snapshots input before awaits', async () => {
  const store = new MemoryStore()
  await setup(store, 'mis-mutate', ['tsk-a', 'tsk-b'])
  const req: CancelPendingMissionTasksInput = input('mis-mutate', ['tsk-a'])
  const pending = cancelPendingMissionTasks(store, req)
  ;(req.taskIds as string[]).push('tsk-b')
  await pending
  await assertCanceled(store, 'mis-mutate', 'tsk-a')
  assert.equal((await store.getTask('tsk-b'))?.state, 'DRAFT')
})

test('DRAFT task with an existing cancel receipt fails before any write', async () => {
  const store = new MemoryStore()
  await setup(store, 'mis-draft-receipt', ['tsk-a', 'tsk-b'])
  await store.appendEvent({ event: {
    event_type: 'TASK_CANCELED',
    event_version: 1,
    occurred_at: T0,
    mission_id: 'mis-draft-receipt',
    task_id: 'tsk-b',
    attempt: null,
    actor: ACTOR,
    causation_id: null,
    correlation_id: 'mis-draft-receipt',
    trace_id: null,
    idempotency_key: 'mission-pending-cancel:tsk-b',
    payload: { from: 'DRAFT', to: 'CANCELED', reason: 'BRANCH_ESCALATED', request_sha256: '0'.repeat(64) },
  } })
  await assert.rejects(cancelPendingMissionTasks(store, input('mis-draft-receipt', ['tsk-a', 'tsk-b'])), /DRAFT task has receipt/)
  assert.equal((await store.getTask('tsk-a'))?.state, 'DRAFT')
})

test('exact canceled retry still rejects binding, result, and duplicate receipts', async () => {
  const bound = new MemoryStore()
  await bound.createMission({ mission: mission('mis-bound-canceled'), actor: ACTOR })
  await bound.createTask({ task: task('mis-bound-canceled', 'tsk-a', { state: 'CANCELED', binding: BOUND }), actor: ACTOR })
  await assert.rejects(cancelPendingMissionTasks(bound, input('mis-bound-canceled', ['tsk-a'])), /binding/)

  const withResult = new MemoryStore()
  await setup(withResult, 'mis-result-canceled', ['tsk-a'])
  await cancelPendingMissionTasks(withResult, input('mis-result-canceled', ['tsk-a']))
  await withResult.setTaskResult('tsk-a', result('mis-result-canceled', 'tsk-a'))
  await assert.rejects(cancelPendingMissionTasks(withResult, input('mis-result-canceled', ['tsk-a'])), /result/)

  const dup = new DuplicateReceiptStore()
  await setup(dup, 'mis-dup-receipt', ['tsk-a'])
  await cancelPendingMissionTasks(dup, input('mis-dup-receipt', ['tsk-a']))
  dup.injectDuplicates = true
  await assert.rejects(cancelPendingMissionTasks(dup, input('mis-dup-receipt', ['tsk-a'])), /receipt mismatch/)
})

test('same-request concurrent commit between DRAFT read and receipt read is accepted', async () => {
  const store = new CommitDuringReceiptReadStore('mis-race', ['tsk-a'], 'BRANCH_ESCALATED')
  await setup(store, 'mis-race', ['tsk-a'])
  await cancelPendingMissionTasks(store, input('mis-race', ['tsk-a']))
  await assertCanceled(store, 'mis-race', 'tsk-a')
})
