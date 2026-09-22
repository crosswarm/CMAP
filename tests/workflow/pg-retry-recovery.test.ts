import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'

import { Client, Connection } from '@temporalio/client'
import { NativeConnection, Worker } from '@temporalio/worker'
import pg from 'pg'

import { PgStore } from '#domain-model'
import type {
  Approval,
  Artifact,
  ArtifactEdge,
  CreateMissionInput,
  CreateTaskInput,
  EventActor,
  Mission,
  MissionQuery,
  MissionState,
  RemoteTaskBinding,
  ResourceLock,
  Review,
  Store,
  TaskEvent,
  TaskResultV1,
  TransitionTaskInput,
} from '#domain-model'
import type { ApprovalDecisionInputV1 } from '#domain-model'
import { AdapterError } from '#adapter-sdk'
import { createActivities } from '../../workflows/activities.ts'
import { FakeAdapter, FileFakeAdapter, syntheticActivityDeps, syntheticRunner } from './fake-adapter.ts'

const here = dirname(fileURLToPath(import.meta.url))
const TEMPORAL_ADDRESS = process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233'
const CONN = process.env['CMAP_DATABASE_URL'] ?? 'postgres://temporal:temporal@localhost:5433/cmap'
const TASK_QUEUE = `cmap-pg-retry-${process.pid}-${Date.now()}`
const SCHEMA = `cmap_pg_retry_${randomUUID().replaceAll('-', '')}`
const ACTOR: EventActor = { type: 'system', id: 'pg-retry-test' }
const T0 = '2026-09-22T00:00:00.000Z'

const mission = (id: string): Mission => ({
  id,
  tenant: 'team-ycc',
  owner: 'crosswarm',
  type: 'inspect',
  goal: '验证 PgStore 与 Temporal Activity 重试恢复',
  constraints: {},
  acceptance: [{ criterion_id: 'C1', metric: 'ok', operator: 'eq', expected: 1, hard_gate: true }],
  workflow_template: 'inspect/v1',
  state: 'DRAFT',
  revision: 1,
  created_at: T0,
  updated_at: T0,
})

class ThrowAfterCommitStore implements Store {
  readonly inner: PgStore
  createTaskCalls = 0
  putReviewCalls = 0
  #createTaskThrows = 0
  #putReviewThrows = 0

  constructor(inner: PgStore) {
    this.inner = inner
  }

  throwAfterCreateTaskCommit(times = 1): void { this.#createTaskThrows = times }
  throwAfterPutReviewCommit(times = 1): void { this.#putReviewThrows = times }

  async createMission(input: CreateMissionInput) { return this.inner.createMission(input) }
  async getMission(id: string) { return this.inner.getMission(id) }
  async queryMissions(q: MissionQuery) { return this.inner.queryMissions(q) }
  async setMissionState(id: string, state: MissionState, actor: EventActor, idempotencyKey?: string) {
    return this.inner.setMissionState(id, state, actor, idempotencyKey)
  }

  async createTask(input: CreateTaskInput) {
    const out = await this.inner.createTask(input)
    this.createTaskCalls += 1
    if (this.#createTaskThrows > 0) {
      this.#createTaskThrows -= 1
      throw new Error('lost createTask acknowledgement after commit')
    }
    return out
  }
  async getTask(id: string) { return this.inner.getTask(id) }
  async transitionTask(input: TransitionTaskInput) { return this.inner.transitionTask(input) }
  async setTaskBinding(taskId: string, binding: RemoteTaskBinding) { return this.inner.setTaskBinding(taskId, binding) }
  async claimTaskBinding(input: Parameters<Store['claimTaskBinding']>[0]) { return this.inner.claimTaskBinding(input) }
  async setTaskResult(taskId: string, result: TaskResultV1) { return this.inner.setTaskResult(taskId, result) }
  async queryTasks(q: Parameters<Store['queryTasks']>[0]) { return this.inner.queryTasks(q) }
  async findReadyTasks(missionId: string) { return this.inner.findReadyTasks(missionId) }

  async appendEvent(input: Parameters<Store['appendEvent']>[0]) { return this.inner.appendEvent(input) }
  async listEvents(missionId: string) { return this.inner.listEvents(missionId) }
  async listUndeliveredEvents(limit: number) { return this.inner.listUndeliveredEvents(limit) }
  async markEventDelivered(eventId: string) { return this.inner.markEventDelivered(eventId) }

  async putArtifact(a: Artifact) { return this.inner.putArtifact(a) }
  async listArtifacts(taskId: string) { return this.inner.listArtifacts(taskId) }
  async linkArtifacts(edge: ArtifactEdge) { return this.inner.linkArtifacts(edge) }
  async listLineage(artifactId: string) { return this.inner.listLineage(artifactId) }

  async putReview(r: Review) {
    const out = await this.inner.putReview(r)
    this.putReviewCalls += 1
    if (this.#putReviewThrows > 0) {
      this.#putReviewThrows -= 1
      throw new Error('lost putReview acknowledgement after commit')
    }
    return out
  }
  async listReviews(missionId: string) { return this.inner.listReviews(missionId) }

  async createApproval(a: Approval) { return this.inner.createApproval(a) }
  async getApproval(id: string) { return this.inner.getApproval(id) }
  async decideApproval(id: string, decision: ApprovalDecisionInputV1['decision'], decidedBy: string, at: string) {
    return this.inner.decideApproval(id, decision, decidedBy, at)
  }
  async listPendingApprovals(missionId?: string) { return this.inner.listPendingApprovals(missionId) }

  async acquireLock(lock: ResourceLock) { return this.inner.acquireLock(lock) }
  async renewLock(lockId: string, newExpiresAt: string) { return this.inner.renewLock(lockId, newExpiresAt) }
  async releaseLock(lockId: string, at: string) { return this.inner.releaseLock(lockId, at) }
  async listActiveLocks(now: string) { return this.inner.listActiveLocks(now) }
  async healthCheck() { return this.inner.healthCheck() }
}

type CliMissingBindingAdapter = FakeAdapter & { missingBinding: boolean }

const cliMissingBindingAdapter = (): CliMissingBindingAdapter => {
  const adapter = new FileFakeAdapter() as CliMissingBindingAdapter
  Object.defineProperty(adapter, 'adapterId', { value: 'codex-adapter' })
  Object.defineProperty(adapter, 'agentId', { value: 'codex' })
  adapter.missingBinding = false
  const getStatus = adapter.getStatus.bind(adapter)
  adapter.getStatus = async () => {
    if (adapter.missingBinding) {
      throw new AdapterError('BINDING_NOT_FOUND', 'synthetic missing CLI binding', false, 'missing-cli-binding')
    }
    return getStatus()
  }
  return adapter
}

let store: ThrowAfterCommitStore
let pgStore: PgStore
let adapter: CliMissingBindingAdapter
let conn: Connection
let native: NativeConnection
let worker: Worker
let workerRun: Promise<void>
let client: Client
let workRoot: string

before(async () => {
  pgStore = new PgStore({ connectionString: CONN, schema: SCHEMA })
  await pgStore.migrate()
  store = new ThrowAfterCommitStore(pgStore)
  adapter = cliMissingBindingAdapter()
  workRoot = await mkdtemp(join(tmpdir(), 'cmap-pg-retry-input-fixture-'))
  conn = await Connection.connect({ address: TEMPORAL_ADDRESS, connectTimeout: 15_000 })
  native = await NativeConnection.connect({ address: TEMPORAL_ADDRESS })
  worker = await Worker.create({
    connection: native,
    namespace: 'default',
    taskQueue: TASK_QUEUE,
    workflowsPath: join(here, '../../workflows/mission.workflow.ts'),
    activities: createActivities(syntheticActivityDeps({
      store,
      adapter,
      workRoot,
      runner: syntheticRunner({ runner_id: 'pg-retry-runner' }),
      pollIntervalMs: 1,
    })),
  })
  workerRun = worker.run()
  client = new Client({ connection: conn, namespace: 'default' })
})

after(async () => {
  worker?.shutdown()
  await workerRun?.catch(() => {})
  await conn?.close()
  await native?.close()
  await pgStore?.close()
  if(workRoot)await rm(workRoot,{recursive:true,force:true})
  const c = new pg.Client({ connectionString: CONN })
  await c.connect()
  try {
    await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  } finally {
    await c.end()
  }
})

const run = async (missionId: string) => {
  const handle = await client.workflow.start('missionWorkflow', {
    taskQueue: TASK_QUEUE,
    workflowId: `pg-retry-${missionId}-${Date.now()}`,
    args: [{ missionId }],
  })
  const result = await handle.result()
  const history = await handle.fetchHistory()
  return { result, history }
}

const activityAttempts = (history: unknown, activityName: string): number => {
  const events = (history as { readonly events?: readonly Record<string, unknown>[] }).events ?? []
  const scheduledIds = new Set<string>()
  for (const event of events) {
    const attrs = event['activityTaskScheduledEventAttributes'] as Record<string, unknown> | undefined
    const activityType = attrs?.['activityType'] as Record<string, unknown> | undefined
    if (activityType?.['name'] === activityName) scheduledIds.add(String(event['eventId']))
  }
  return Math.max(0, ...events.map((event) => {
    const attrs = event['activityTaskStartedEventAttributes'] as Record<string, unknown> | undefined
    if (!attrs || !scheduledIds.has(String(attrs['scheduledEventId']))) return 0
    return Number(attrs['attempt'])
  }))
}

const taskEvents = (events: readonly TaskEvent[], type: TaskEvent['event_type']): readonly TaskEvent[] =>
  events.filter((e) => e.event_type === type)

describe('PgStore + Temporal retry recovery', () => {
  test('initial createTask lost acknowledgement is retried without an orphan task', async () => {
    const missionId = 'mis-pg-create-retry'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    store.throwAfterCreateTaskCommit()

    const { result, history } = await run(missionId)

    const tasks = await store.queryTasks({ missionId })
    const events = await store.listEvents(missionId)
    assert.equal(result.state, 'COMPLETED')
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0]!.state, 'COMPLETED')
    assert.equal(taskEvents(events, 'TASK_CREATED').length, 1)
    assert.ok(activityAttempts(history, 'createTask') >= 2, 'Temporal should have retried createTask')
    assert.ok(store.createTaskCalls >= 2)
  })

  test('review putReview lost acknowledgement is retried and repairs the child chain', async () => {
    const missionId = 'mis-pg-review-retry'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    adapter.failNext = 1
    store.throwAfterPutReviewCommit()

    const { result, history } = await run(missionId)

    const tasks = await store.queryTasks({ missionId })
    const reviews = await store.listReviews(missionId)
    const source = tasks.find((t) => t.supersedes_task_id === null)
    assert.ok(source)
    const children = tasks.filter((t) => t.supersedes_task_id === source.id)
    assert.equal(result.state, 'COMPLETED')
    assert.equal(tasks.length, 2)
    assert.equal(reviews.length, 2)
    assert.equal(source.state, 'COMPLETED')
    assert.equal(children.length, 1)
    assert.equal(children[0]!.state, 'COMPLETED')
    assert.ok(activityAttempts(history, 'applyReviewDecision') >= 2, 'Temporal should have retried applyReviewDecision')
    assert.ok(store.putReviewCalls >= 3)
  })

  test('fresh CLI BINDING_NOT_FOUND escalates mission with distinct durable receipts', async () => {
    const missionId = 'mis-pg-uncertain'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    adapter.missingBinding = true

    try {
      const { result, history } = await run(missionId)

      const tasks = await store.queryTasks({ missionId })
      const task = tasks[0]
      assert.ok(task)
      const taskKey = `execution-uncertain:${task.id}`
      const missionKey = `mission-execution-uncertain:${task.id}`
      const events = await store.listEvents(missionId)
      assert.equal(result.state, 'ESCALATED')
      assert.equal(result.summary, 'EXECUTION_UNCERTAIN:BINDING_NOT_FOUND')
      assert.equal(result.escalationReason, 'EXECUTION_UNCERTAIN:BINDING_NOT_FOUND')
      assert.equal(tasks.length, 1)
      assert.equal(task.state, 'INPUT_REQUIRED')
      assert.equal(task.result, null)
      assert.ok(task.binding)
      assert.notEqual(taskKey, missionKey)
      assert.equal(events.filter((e) => e.idempotency_key === taskKey).length, 1)
      assert.equal(events.filter((e) => e.idempotency_key === missionKey).length, 1)
      assert.equal(events.find((e) => e.idempotency_key === taskKey)?.event_type, 'INPUT_REQUIRED')
      assert.equal(events.find((e) => e.idempotency_key === missionKey)?.event_type, 'MISSION_ESCALATED')
      assert.equal(activityAttempts(history, 'collectTaskResult'), 1)
    } finally {
      adapter.missingBinding = false
    }
  })
})
