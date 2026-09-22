import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { MemoryStore } from '#domain-model'
import type { EventActor, Mission, ReviewDecisionV1, TaskEnvelopeV1, TaskRecord } from '#domain-model'
import { createActivities } from '../../workflows/activities.ts'
import { FakeAdapter, syntheticActivityDeps, syntheticRunner } from './fake-adapter.ts'

const ACTOR: EventActor = { type: 'system', id: 'test' }
const APPLICATION_ACTOR: EventActor = { type: 'system', id: 'mission-workflow' }
const T0 = '2026-08-04T00:00:00.000Z'
const reviewApplicationId = (taskId: string): string =>
  `rev_${createHash('sha256').update(JSON.stringify(['cmap/review-application/v1', taskId])).digest('hex')}`

const keyOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => stable(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => keyOrder(a, b))
        .map(([k, v]) => [k, stable(v)]),
    )
  }
  return value
}
const progressSnapshot = (snapshot: unknown): unknown => {
  if (!snapshot) return null
  const p = snapshot as {
    patchHash: string
    failedCriteriaIds: readonly string[]
    metricValue: number | null
    errorFingerprint: string | null
  }
  return stable({
    patchHash: p.patchHash,
    failedCriteriaIds: [...p.failedCriteriaIds].sort(keyOrder),
    metricValue: p.metricValue,
    errorFingerprint: p.errorFingerprint,
  })
}
const reviewInputSha = (input: {
  taskId: string
  round: number
  decision: ReviewDecisionV1
  previousProgress?: unknown
  currentProgress?: unknown
}): string => createHash('sha256').update(JSON.stringify(stable({
  taskId: input.taskId,
  round: input.round,
  decision: input.decision,
  previousProgress: progressSnapshot(input.previousProgress),
  currentProgress: progressSnapshot(input.currentProgress),
}))).digest('hex')

const activities = (store: MemoryStore) =>
  createActivities(syntheticActivityDeps({
    store,
    adapter: new FakeAdapter(),
    runner: syntheticRunner(),
    pollIntervalMs: 1,
  }))

class ThrowAfterCommitStore extends MemoryStore {
  #createTaskThrows = 0
  #createTaskThrowAfterSkips = 0
  #putReviewThrows = 0
  #appendThrows = new Map<string, number>()
  #transitionThrows = new Map<string, number>()
  #setMissionThrows = 0

  throwAfterCreateTaskCommit(times = 1): void {
    this.#createTaskThrows = times
  }

  throwAfterCreateTaskCommitOnNextCall(callNumber: number): void {
    this.#createTaskThrowAfterSkips = callNumber
  }

  throwAfterPutReviewCommit(times = 1): void {
    this.#putReviewThrows = times
  }

  throwAfterAppendEventCommit(idempotencyKey: string, times = 1): void {
    this.#appendThrows.set(idempotencyKey, times)
  }

  throwAfterTransitionCommit(idempotencyKey: string, times = 1): void {
    this.#transitionThrows.set(idempotencyKey, times)
  }

  throwAfterSetMissionStateCommit(times = 1): void {
    this.#setMissionThrows = times
  }

  override async createTask(input: Parameters<MemoryStore['createTask']>[0]) {
    const out = await super.createTask(input)
    if (this.#createTaskThrowAfterSkips > 0) {
      this.#createTaskThrowAfterSkips -= 1
      if (this.#createTaskThrowAfterSkips === 0) throw new Error('lost createTask return after commit')
    }
    if (this.#createTaskThrows > 0) {
      this.#createTaskThrows -= 1
      throw new Error('lost createTask return after commit')
    }
    return out
  }

  override async putReview(input: Parameters<MemoryStore['putReview']>[0]) {
    const out = await super.putReview(input)
    if (this.#putReviewThrows > 0) {
      this.#putReviewThrows -= 1
      throw new Error('lost putReview return after commit')
    }
    return out
  }

  override async appendEvent(input: Parameters<MemoryStore['appendEvent']>[0]) {
    const out = await super.appendEvent(input)
    const key = input.event.idempotency_key
    const remaining = this.#appendThrows.get(key) ?? 0
    if (remaining > 0) {
      this.#appendThrows.set(key, remaining - 1)
      throw new Error(`lost appendEvent return after commit: ${key}`)
    }
    return out
  }

  override async transitionTask(input: Parameters<MemoryStore['transitionTask']>[0]) {
    const out = await super.transitionTask(input)
    const remaining = this.#transitionThrows.get(input.idempotencyKey) ?? 0
    if (remaining > 0) {
      this.#transitionThrows.set(input.idempotencyKey, remaining - 1)
      throw new Error(`lost transitionTask return after commit: ${input.idempotencyKey}`)
    }
    return out
  }

  override async setMissionState(...args: Parameters<MemoryStore['setMissionState']>) {
    const out = await super.setMissionState(...args)
    if (this.#setMissionThrows > 0) {
      this.#setMissionThrows -= 1
      throw new Error('lost setMissionState return after commit')
    }
    return out
  }
}

const mission = (id: string): Mission => ({
  id,
  tenant: 'team-ycc',
  owner: 'crosswarm',
  type: 'perf',
  goal: '首屏 P95 降到 1800ms',
  constraints: {},
  acceptance: [
    { criterion_id: 'PERF-P95', metric: 'p95_ms', operator: 'lte', expected: 1800, hard_gate: true },
  ],
  workflow_template: 'perf/v1',
  state: 'RUNNING',
  revision: 1,
  created_at: T0,
  updated_at: T0,
})

const acceptDecision = (missionId: string, taskId: string): ReviewDecisionV1 => ({
  schema: 'cmap/review-decision/v1',
  mission_id: missionId,
  reviewed_task_ids: [taskId],
  decision: 'accept',
  hard_gate_summary: { total: 1, passed: 1, failed: 0 },
  review_confidence: { level: 'high' },
}) as ReviewDecisionV1

const reworkDecision = (
  missionId: string,
  taskId: string,
  followups = 1,
): ReviewDecisionV1 => ({
  schema: 'cmap/review-decision/v1',
  mission_id: missionId,
  reviewed_task_ids: [taskId],
  decision: 'rework',
  hard_gate_summary: { total: 1, passed: 0, failed: 1 },
  failed_criteria: [
    { criterion_id: 'PERF-P95', expected: '<= 1800 ms', actual: '1914 ms', reason: '低端设备未达标' },
  ],
  required_followups: Array.from({ length: followups }, (_, i) => ({
    capability: 'codex.performance.root_cause',
    task_type: 'performance.analyze',
    focus: [`root-cause-${i + 1}`],
  })),
  stop_conditions: { max_additional_cycles: 3 },
  review_confidence: { level: 'high' },
}) as ReviewDecisionV1

const escalateDecision = (missionId: string, taskId: string): ReviewDecisionV1 => ({
  schema: 'cmap/review-decision/v1',
  mission_id: missionId,
  reviewed_task_ids: [taskId],
  decision: 'escalate',
  hard_gate_summary: { total: 1, passed: 0, failed: 1 },
  escalation: { reason: 'raw reviewer reason' },
  review_confidence: { level: 'high' },
}) as ReviewDecisionV1

const toReviewable = async (store: MemoryStore, missionId: string): Promise<string> => {
  const acts = activities(store)
  const { taskId } = await acts.createTask({ missionId, capability: 'code.analyze', goal: '优化首屏' })
  await acts.markReady(taskId)
  await acts.dispatchTask(taskId)
  await acts.beginReview(taskId)
  return taskId
}

const createLegacyFollowup = async (
  store: MemoryStore,
  missionId: string,
  source: TaskRecord,
  childId: string,
  goal: string,
): Promise<void> => {
  const m = await store.getMission(missionId)
  assert.ok(m)
  const envelope: TaskEnvelopeV1 = {
    schema: 'cmap/task-envelope/v1',
    identity: {
      mission_id: missionId,
      task_id: childId,
      supersedes_task_id: source.id,
      idempotency_key: `${missionId}:${childId}`,
      revision: 1,
      tenant: m.tenant,
      owner: m.owner,
    },
    classification: {
      task_type: m.type,
      requested_capability: 'codex.performance.root_cause',
      risk_level: source.risk,
    },
    goal: {
      statement: goal,
      success_definition: source.envelope.goal.success_definition,
    },
    environment: { tenant: m.tenant },
    execution_policy: { timeout_seconds: 300, max_attempts: 1 },
    permissions: { forbidden: [] },
    evidence_requirements: { required_artifact_roles: ['report'] },
    output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
  }
  await store.createTask({
    actor: ACTOR,
    task: {
      id: childId,
      mission_id: missionId,
      parent_task_id: null,
      supersedes_task_id: source.id,
      capability: 'codex.performance.root_cause',
      risk: source.risk,
      state: 'DRAFT',
      attempt: 1,
      max_attempts: 1,
      lamport: 0,
      envelope,
      result: null,
      binding: null,
      deps: [],
      created_at: T0,
      updated_at: T0,
    },
  })
}

const completionReceipts = async (store: MemoryStore, missionId: string, taskId: string): Promise<number> => {
  const id = reviewApplicationId(taskId)
  return (await store.listEvents(missionId))
    .filter((event) => event.event_type === 'REVIEW_APPLICATION_COMPLETED' &&
      event.idempotency_key === `review-application:complete:${id}`)
    .length
}

describe('Activity retry recovery', () => {
  test('createTask recovers a committed task when the Activity return is lost', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-create-retry'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })

    store.throwAfterCreateTaskCommit()
    await assert.rejects(
      () => activities(store).createTask({ missionId, capability: 'code.analyze', goal: 'same logical initial task' }),
      /lost createTask return/,
    )

    const retry = await activities(store).createTask({
      missionId,
      capability: 'code.analyze',
      goal: 'same logical initial task',
    })

    const tasks = await store.queryTasks({ missionId })
    assert.equal(tasks.length, 1)
    assert.equal(retry.taskId, tasks[0]!.id)
    assert.equal((await store.listEvents(missionId)).filter((e) => e.event_type === 'TASK_CREATED').length, 1)
  })

  test('applyReviewDecision repairs task state after a committed review loses its return', async () => {
    const acceptStore = new ThrowAfterCommitStore()
    const acceptMission = 'mis-review-accept-retry'
    await acceptStore.createMission({ mission: mission(acceptMission), actor: ACTOR })
    const acceptedTask = await toReviewable(acceptStore, acceptMission)

    acceptStore.throwAfterPutReviewCommit()
    await assert.rejects(
      () => activities(acceptStore).applyReviewDecision({
        taskId: acceptedTask,
        decision: acceptDecision(acceptMission, acceptedTask),
        round: 1,
      }),
      /lost putReview return/,
    )

    assert.deepEqual(
      await activities(acceptStore).applyReviewDecision({
        taskId: acceptedTask,
        decision: acceptDecision(acceptMission, acceptedTask),
        round: 1,
      }),
      { outcome: 'accept', followupTaskIds: [] },
    )
    assert.equal((await acceptStore.getTask(acceptedTask))?.state, 'COMPLETED')

    const reworkStore = new ThrowAfterCommitStore()
    const reworkMission = 'mis-review-rework-retry'
    await reworkStore.createMission({ mission: mission(reworkMission), actor: ACTOR })
    const reworkedTask = await toReviewable(reworkStore, reworkMission)

    reworkStore.throwAfterPutReviewCommit()
    await assert.rejects(
      () => activities(reworkStore).applyReviewDecision({
        taskId: reworkedTask,
        decision: reworkDecision(reworkMission, reworkedTask),
        round: 1,
      }),
      /lost putReview return/,
    )

    const replay = await activities(reworkStore).applyReviewDecision({
      taskId: reworkedTask,
      decision: reworkDecision(reworkMission, reworkedTask),
      round: 1,
    })

    assert.equal(replay.outcome, 'rework')
    assert.equal(replay.followupTaskIds.length, 1)
    assert.equal((await reworkStore.getTask(reworkedTask))?.state, 'COMPLETED')
  })

  test('applyReviewDecision completes a partially committed two-followup batch on retry', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-two-followups-retry'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)

    store.throwAfterCreateTaskCommit()
    await assert.rejects(
      () => activities(store).applyReviewDecision({
        taskId,
        decision: reworkDecision(missionId, taskId, 2),
        round: 1,
      }),
      /lost createTask return/,
    )

    const replay = await activities(store).applyReviewDecision({
      taskId,
      decision: reworkDecision(missionId, taskId, 2),
      round: 1,
    })

    assert.equal(replay.outcome, 'rework')
    assert.equal(replay.followupTaskIds.length, 2)
    assert.equal(new Set(replay.followupTaskIds).size, 2)
    assert.equal((await store.getTask(taskId))?.state, 'COMPLETED')
    assert.deepEqual(
      (await store.queryTasks({ missionId }))
        .filter((t) => t.supersedes_task_id === taskId)
        .map((t) => t.id),
      [...replay.followupTaskIds],
    )
  })

  test('second review child lost ack retries to the frozen output without duplicate children', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-second-child-lost-ack'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const decision = reworkDecision(missionId, taskId, 2)

    store.throwAfterCreateTaskCommitOnNextCall(2)
    await assert.rejects(
      () => activities(store).applyReviewDecision({ taskId, decision, round: 1 }),
      /lost createTask return/,
    )

    const replay = await activities(store).applyReviewDecision({ taskId, decision, round: 1 })

    assert.equal(replay.outcome, 'rework')
    assert.equal(replay.followupTaskIds.length, 2)
    assert.equal(new Set(replay.followupTaskIds).size, 2)
    assert.equal((await store.queryTasks({ missionId })).filter((t) => t.supersedes_task_id === taskId).length, 2)
    assert.equal(await completionReceipts(store, missionId, taskId), 1)
  })

  test('source rework completion lost ack retries exact children and single completion receipt', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-rework-completed-lost-ack'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const decision = reworkDecision(missionId, taskId, 2)

    store.throwAfterTransitionCommit(`review-rework-completed:${taskId}:1`)
    await assert.rejects(
      () => activities(store).applyReviewDecision({ taskId, decision, round: 1 }),
      /lost transitionTask return/,
    )

    const replay = await activities(store).applyReviewDecision({ taskId, decision, round: 1 })

    assert.equal(replay.outcome, 'rework')
    assert.equal(replay.followupTaskIds.length, 2)
    assert.equal((await store.getTask(taskId))?.state, 'COMPLETED')
    assert.deepEqual(
      (await store.queryTasks({ missionId }))
        .filter((t) => t.supersedes_task_id === taskId)
        .map((t) => t.id),
      replay.followupTaskIds,
    )
    assert.equal(await completionReceipts(store, missionId, taskId), 1)
  })

  test('forced escalation mission-state lost ack retries exact output and single completion receipt', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-escalated-mission-state-lost-ack'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const decision = reworkDecision(missionId, taskId)
    const progress = { patchHash: 'same', failedCriteriaIds: ['A'], metricValue: 10, errorFingerprint: 'err' }
    const input = { taskId, decision, round: 1, previousProgress: progress, currentProgress: progress }

    store.throwAfterSetMissionStateCommit()
    await assert.rejects(
      () => activities(store).applyReviewDecision(input),
      /lost setMissionState return/,
    )

    const replay = await activities(store).applyReviewDecision(input)

    assert.equal(replay.outcome, 'escalated')
    assert.match(replay.escalationReason ?? '', /^检测到无进展（.+），停止返工并升级$/)
    assert.equal((await store.getTask(taskId))?.state, 'FAILED_TERMINAL')
    assert.equal((await store.getMission(missionId))?.state, 'ESCALATED')
    assert.equal(await completionReceipts(store, missionId, taskId), 1)
  })

  test('same task and round reject a changed review decision instead of replaying caller input', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-conflict'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)

    await activities(store).applyReviewDecision({
      taskId,
      decision: reworkDecision(missionId, taskId),
      round: 1,
    })

    await assert.rejects(
      () => activities(store).applyReviewDecision({
        taskId,
        decision: acceptDecision(missionId, taskId),
        round: 1,
      }),
      /conflict|冲突|不一致|Review/i,
    )
  })

  test('changed object key order keeps the same review application hash', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-canonical'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)

    const first = reworkDecision(missionId, taskId)
    const reordered = {
      review_confidence: { level: 'high' },
      stop_conditions: { max_additional_cycles: 3 },
      required_followups: first.required_followups,
      failed_criteria: first.failed_criteria,
      hard_gate_summary: { failed: 1, passed: 0, total: 1 },
      decision: 'rework',
      reviewed_task_ids: [taskId],
      mission_id: missionId,
      schema: 'cmap/review-decision/v1',
    } as ReviewDecisionV1

    const out = await activities(store).applyReviewDecision({ taskId, decision: first, round: 1 })
    assert.deepEqual(
      await activities(store).applyReviewDecision({ taskId, decision: reordered, round: 1 }),
      out,
    )
  })

  test('changed progress for the same task and round conflicts', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-progress-conflict'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const decision = reworkDecision(missionId, taskId)

    await activities(store).applyReviewDecision({
      taskId,
      decision,
      round: 1,
      currentProgress: { patchHash: 'a', failedCriteriaIds: ['B', 'A'], metricValue: 10, errorFingerprint: 'err' },
    })

    await assert.rejects(
      () => activities(store).applyReviewDecision({
        taskId,
        decision,
        round: 1,
        currentProgress: { patchHash: 'a', failedCriteriaIds: ['A', 'B'], metricValue: 11, errorFingerprint: 'err' },
      }),
      /conflict|Review/i,
    )
  })

  test('lost completion receipt return replays the stored exact output', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-lost-completion'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const decision = reworkDecision(missionId, taskId, 2)
    const id = reviewApplicationId(taskId)

    store.throwAfterAppendEventCommit(`review-application:complete:${id}`)
    await assert.rejects(
      () => activities(store).applyReviewDecision({ taskId, decision, round: 1 }),
      /lost appendEvent return/,
    )
    const replay = await activities(store).applyReviewDecision({ taskId, decision, round: 1 })
    assert.equal(replay.outcome, 'rework')
    assert.equal(replay.followupTaskIds.length, 2)
  })

  test('lost intent and branch transition are repaired without duplicate children', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-phase-faults'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const decision = reworkDecision(missionId, taskId, 2)

    store.throwAfterTransitionCommit(`review-rework:${taskId}:1`)
    await assert.rejects(
      () => activities(store).applyReviewDecision({ taskId, decision, round: 1 }),
      /lost transitionTask return/,
    )

    const replay = await activities(store).applyReviewDecision({ taskId, decision, round: 1 })
    assert.equal(replay.followupTaskIds.length, 2)
    assert.equal((await store.queryTasks({ missionId })).filter((t) => t.supersedes_task_id === taskId).length, 2)
  })

  test('frozen no-progress input escalates and replays as the same receipt', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-no-progress'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const progress = { patchHash: 'same', failedCriteriaIds: ['A'], metricValue: 10, errorFingerprint: 'err' }
    const input = {
      taskId,
      decision: reworkDecision(missionId, taskId),
      round: 1,
      previousProgress: progress,
      currentProgress: progress,
    }

    const first = await activities(store).applyReviewDecision(input)
    assert.equal(first.outcome, 'escalated')
    assert.match(first.escalationReason ?? '', /^检测到无进展（.+），停止返工并升级$/)
    assert.deepEqual(await activities(store).applyReviewDecision(input), first)
    assert.equal((await store.getTask(taskId))?.state, 'FAILED_TERMINAL')
    assert.equal((await store.getMission(missionId))?.state, 'ESCALATED')
    assert.deepEqual(
      (await store.listEvents(missionId))
        .filter((e) => e.task_id === taskId && ['REVIEW_ESCALATED', 'TASK_FAILED'].includes(e.event_type))
        .map((e) => e.event_type),
      ['REVIEW_ESCALATED', 'TASK_FAILED'],
    )
  })

  test('explicit escalate preserves completed task semantics and bounded reason', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-explicit-escalate'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)

    const out = await activities(store).applyReviewDecision({
      taskId,
      decision: escalateDecision(missionId, taskId),
      round: 1,
    })

    assert.deepEqual(out, { outcome: 'escalated', followupTaskIds: [], escalationReason: '评审者主动升级' })
    assert.equal((await store.getTask(taskId))?.state, 'COMPLETED')
    assert.equal((await store.getMission(missionId))?.state, 'ESCALATED')
    assert.equal(
      (await store.listEvents(missionId)).find((e) => e.event_type === 'REVIEW_ESCALATED')?.payload['reason'],
      '评审者主动升级',
    )
  })

  test('explicit escalate retry repairs mission state after committed task transition loses its return', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-explicit-escalate-lost-transition'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)

    store.throwAfterTransitionCommit(`review-explicit-escalated:${taskId}:1`)
    await assert.rejects(
      () => activities(store).applyReviewDecision({
        taskId,
        decision: escalateDecision(missionId, taskId),
        round: 1,
      }),
      /lost transitionTask return/,
    )
    assert.equal((await store.getTask(taskId))?.state, 'COMPLETED')
    assert.equal((await store.getMission(missionId))?.state, 'RUNNING')

    const replay = await activities(store).applyReviewDecision({
      taskId,
      decision: escalateDecision(missionId, taskId),
      round: 1,
    })

    assert.deepEqual(replay, { outcome: 'escalated', followupTaskIds: [], escalationReason: '评审者主动升级' })
    assert.equal((await store.getMission(missionId))?.state, 'ESCALATED')
  })

  test('intent output cannot change an accept decision into an escalation', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-corrupt-intent-branch'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const decision = acceptDecision(missionId, taskId)
    const input = { taskId, decision, round: 1 }
    const id = reviewApplicationId(taskId)

    await store.appendEvent({ event: {
      event_type: 'REVIEW_APPLICATION_INTENT',
      event_version: 1,
      occurred_at: T0,
      mission_id: missionId,
      task_id: taskId,
      attempt: 1,
      actor: APPLICATION_ACTOR,
      causation_id: null,
      correlation_id: missionId,
      trace_id: taskId,
      idempotency_key: `review-application:intent:${id}`,
      payload: {
        schema: 'cmap/review-application/v1',
        phase: 'intent',
        round: 1,
        input_sha256: reviewInputSha(input),
        review_id: id,
        output: { outcome: 'escalated', followupTaskIds: [], escalationReason: '评审者主动升级' },
      },
    } })

    await assert.rejects(
      () => activities(store).applyReviewDecision(input),
      /conflict|invalid|Review/i,
    )
    assert.equal((await store.getTask(taskId))?.state, 'REVIEWING')
    assert.equal((await store.getMission(missionId))?.state, 'RUNNING')
  })

  test('completion receipt without intent is rejected', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-orphan-completion'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const id = reviewApplicationId(taskId)

    await store.appendEvent({ event: {
      event_type: 'REVIEW_APPLICATION_COMPLETED',
      event_version: 1,
      occurred_at: T0,
      mission_id: missionId,
      task_id: taskId,
      attempt: 1,
      actor: APPLICATION_ACTOR,
      causation_id: null,
      correlation_id: missionId,
      trace_id: taskId,
      idempotency_key: `review-application:complete:${id}`,
      payload: {
        schema: 'cmap/review-application/v1',
        phase: 'complete',
        round: 1,
        input_sha256: 'a'.repeat(64),
        review_id: id,
        output: { outcome: 'accept', followupTaskIds: [] },
      },
    } })

    await assert.rejects(
      () => activities(store).applyReviewDecision({ taskId, decision: acceptDecision(missionId, taskId), round: 1 }),
      /without intent|completion/i,
    )
  })

  test('corrupt receipt event binding is rejected', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-corrupt-receipt'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const id = reviewApplicationId(taskId)

    await store.appendEvent({ event: {
      event_type: 'REVIEW_APPLICATION_INTENT',
      event_version: 1,
      occurred_at: T0,
      mission_id: missionId,
      task_id: taskId,
      attempt: 1,
      actor: APPLICATION_ACTOR,
      causation_id: null,
      correlation_id: missionId,
      trace_id: taskId,
      idempotency_key: `review-application:intent:${id}`,
      payload: {
        schema: 'cmap/review-application/v1',
        phase: 'complete',
        round: 1,
        input_sha256: 'a'.repeat(64),
        review_id: `${id}-other`,
        output: { outcome: 'accept', followupTaskIds: [] },
      },
    } })

    await assert.rejects(
      () => activities(store).applyReviewDecision({ taskId, decision: acceptDecision(missionId, taskId), round: 1 }),
      /corrupt/i,
    )
  })

  test('receipt with current key but wrong task binding is rejected', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-wrong-task-receipt'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const id = reviewApplicationId(taskId)
    const decision = acceptDecision(missionId, taskId)
    const input = { taskId, decision, round: 1 }

    await store.appendEvent({ event: {
      event_type: 'REVIEW_APPLICATION_INTENT',
      event_version: 1,
      occurred_at: T0,
      mission_id: missionId,
      task_id: 'tsk_wrong_task',
      attempt: 1,
      actor: APPLICATION_ACTOR,
      causation_id: null,
      correlation_id: missionId,
      trace_id: taskId,
      idempotency_key: `review-application:intent:${id}`,
      payload: {
        schema: 'cmap/review-application/v1',
        phase: 'intent',
        round: 1,
        input_sha256: reviewInputSha(input),
        review_id: id,
        output: { outcome: 'accept', followupTaskIds: [] },
      },
    } })

    await assert.rejects(
      () => activities(store).applyReviewDecision(input),
      /corrupt/i,
    )
  })

  test('legacy forced escalation proof recovers escalation output without retry progress', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-legacy-forced-escalation-no-progress'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const decision = reworkDecision(missionId, taskId, 1)
    await store.putReview({ id: 'legacy-forced-escalation-review', mission_id: missionId, reviewed_task_ids: [taskId], round: 1, decision, created_at: T0 })
    await store.transitionTask({
      taskId,
      to: 'REWORK',
      actor: APPLICATION_ACTOR,
      eventType: 'REVIEW_ESCALATED',
      idempotencyKey: `escalate-rework:${taskId}`,
      payload: { reason: 'arbitrary old text' },
    })
    await store.transitionTask({
      taskId,
      to: 'FAILED_TERMINAL',
      actor: APPLICATION_ACTOR,
      eventType: 'TASK_FAILED',
      idempotencyKey: `escalate-done:${taskId}`,
      payload: { reason: 'arbitrary old text' },
    })
    await store.setMissionState(missionId, 'ESCALATED', APPLICATION_ACTOR)

    const out = await activities(store).applyReviewDecision({ taskId, decision, round: 1 })

    assert.deepEqual(out, {
      outcome: 'escalated',
      followupTaskIds: [],
      escalationReason: '历史评审已决定升级，停止返工并升级',
    })
  })

  test('legacy forced escalation with only review-escalated event repairs failed terminal and mission', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-legacy-forced-escalation-rework-window'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const decision = reworkDecision(missionId, taskId, 1)
    await store.putReview({ id: 'legacy-forced-escalation-rework-window-review', mission_id: missionId, reviewed_task_ids: [taskId], round: 1, decision, created_at: T0 })
    await store.transitionTask({
      taskId,
      to: 'REWORK',
      actor: APPLICATION_ACTOR,
      eventType: 'REVIEW_ESCALATED',
      idempotencyKey: `escalate-rework:${taskId}`,
      payload: { reason: 'arbitrary old text' },
    })

    const out = await activities(store).applyReviewDecision({ taskId, decision, round: 1 })

    assert.deepEqual(out, { outcome: 'escalated', followupTaskIds: [], escalationReason: '历史评审已决定升级，停止返工并升级' })
    assert.equal((await store.getTask(taskId))?.state, 'FAILED_TERMINAL')
    assert.equal((await store.getMission(missionId))?.state, 'ESCALATED')
  })

  test('legacy forced escalation with task failed but mission running repairs mission state', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-legacy-forced-escalation-mission-window'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const decision = reworkDecision(missionId, taskId, 1)
    await store.putReview({ id: 'legacy-forced-escalation-mission-window-review', mission_id: missionId, reviewed_task_ids: [taskId], round: 1, decision, created_at: T0 })
    await store.transitionTask({
      taskId,
      to: 'REWORK',
      actor: APPLICATION_ACTOR,
      eventType: 'REVIEW_ESCALATED',
      idempotencyKey: `escalate-rework:${taskId}`,
      payload: { reason: 'arbitrary old text' },
    })
    await store.transitionTask({
      taskId,
      to: 'FAILED_TERMINAL',
      actor: APPLICATION_ACTOR,
      eventType: 'TASK_FAILED',
      idempotencyKey: `escalate-done:${taskId}`,
      payload: { reason: 'arbitrary old text' },
    })

    const out = await activities(store).applyReviewDecision({ taskId, decision, round: 1 })

    assert.deepEqual(out, { outcome: 'escalated', followupTaskIds: [], escalationReason: '历史评审已决定升级，停止返工并升级' })
    assert.equal((await store.getMission(missionId))?.state, 'ESCALATED')
  })

  test('legacy ordered followup payload disambiguates identical child specs', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-legacy-ordered-identical-children'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const task = await store.getTask(taskId)
    assert.ok(task)
    const decision = reworkDecision(missionId, taskId, 2)
    decision.required_followups = [
      { capability: 'codex.performance.root_cause', task_type: 'performance.analyze' },
      { capability: 'codex.performance.root_cause', task_type: 'performance.analyze' },
    ]
    await store.putReview({ id: 'legacy-ordered-review', mission_id: missionId, reviewed_task_ids: [taskId], round: 1, decision, created_at: T0 })
    await createLegacyFollowup(store, missionId, task, 'legacy-child-a', '返工第 2 轮：performance.analyze')
    await createLegacyFollowup(store, missionId, task, 'legacy-child-b', '返工第 2 轮：performance.analyze')
    await store.transitionTask({
      taskId,
      to: 'REWORK',
      actor: ACTOR,
      eventType: 'REVIEW_REWORK_REQUESTED',
      idempotencyKey: `legacy-ordered-rework:${taskId}:1`,
      payload: { followups: ['legacy-child-b', 'legacy-child-a'] },
    })

    const out = await activities(store).applyReviewDecision({ taskId, decision, round: 1 })

    assert.deepEqual(out.followupTaskIds, ['legacy-child-b', 'legacy-child-a'])
  })

  test('legacy identical child specs without ordered payload fail closed', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-legacy-unordered-identical-children'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const task = await store.getTask(taskId)
    assert.ok(task)
    const decision = reworkDecision(missionId, taskId, 2)
    decision.required_followups = [
      { capability: 'codex.performance.root_cause', task_type: 'performance.analyze' },
      { capability: 'codex.performance.root_cause', task_type: 'performance.analyze' },
    ]
    await store.putReview({ id: 'legacy-unordered-review', mission_id: missionId, reviewed_task_ids: [taskId], round: 1, decision, created_at: T0 })
    await createLegacyFollowup(store, missionId, task, 'legacy-child-a', '返工第 2 轮：performance.analyze')
    await createLegacyFollowup(store, missionId, task, 'legacy-child-b', '返工第 2 轮：performance.analyze')
    await store.transitionTask({
      taskId,
      to: 'REWORK',
      actor: ACTOR,
      eventType: 'REVIEW_REWORK_REQUESTED',
      idempotencyKey: `legacy-unordered-rework:${taskId}:1`,
    })

    await assert.rejects(
      () => activities(store).applyReviewDecision({ taskId, decision, round: 1 }),
      /ambiguous legacy review child/i,
    )
  })

  test('legacy random child is adopted and missing indexed child is repaired', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-legacy-child'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const task = await store.getTask(taskId)
    assert.ok(task)
    const decision = reworkDecision(missionId, taskId, 2)
    await store.putReview({ id: 'legacy-review', mission_id: missionId, reviewed_task_ids: [taskId], round: 1, decision, created_at: T0 })
    await createLegacyFollowup(store, missionId, task, 'legacy-child', '返工第 2 轮：root-cause-1')
    await store.transitionTask({
      taskId,
      to: 'REWORK',
      actor: ACTOR,
      eventType: 'REVIEW_REWORK_REQUESTED',
      idempotencyKey: `legacy-rework:${taskId}:1`,
    })

    const out = await activities(store).applyReviewDecision({ taskId, decision, round: 1 })
    assert.equal(out.outcome, 'rework')
    assert.equal(out.followupTaskIds[0], 'legacy-child')
    assert.equal(out.followupTaskIds.length, 2)
    assert.equal((await store.queryTasks({ missionId })).filter((t) => t.supersedes_task_id === taskId).length, 2)
  })

  test('legacy budget escalation branch event repairs terminal state', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-legacy-escalation'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)
    const decision = reworkDecision(missionId, taskId, 1)
    decision.stop_conditions = { max_additional_cycles: 1 }
    await store.putReview({ id: 'legacy-escalation-review', mission_id: missionId, reviewed_task_ids: [taskId], round: 1, decision, created_at: T0 })
    await store.transitionTask({
      taskId,
      to: 'REWORK',
      actor: ACTOR,
      eventType: 'REVIEW_ESCALATED',
      idempotencyKey: `legacy-escalated:${taskId}:1`,
    })

    const out = await activities(store).applyReviewDecision({ taskId, decision, round: 1 })
    assert.deepEqual(out, {
      outcome: 'escalated',
      followupTaskIds: [],
      escalationReason: '返工轮次已达上限（1/1），停止返工并升级',
    })
    assert.equal((await store.getTask(taskId))?.state, 'FAILED_TERMINAL')
    assert.equal((await store.getMission(missionId))?.state, 'ESCALATED')
  })

  test('invalid progress numbers are rejected before receipts', async () => {
    const store = new ThrowAfterCommitStore()
    const missionId = 'mis-review-invalid-progress'
    await store.createMission({ mission: mission(missionId), actor: ACTOR })
    const taskId = await toReviewable(store, missionId)

    await assert.rejects(
      () => activities(store).applyReviewDecision({
        taskId,
        decision: reworkDecision(missionId, taskId),
        round: 1,
        currentProgress: { patchHash: 'x', failedCriteriaIds: ['A'], metricValue: Number.NaN, errorFingerprint: null },
      }),
      /progress/i,
    )
  })
})
