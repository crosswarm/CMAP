import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { MemoryStore } from '#domain-model'
import type { Artifact, EventActor, Mission, ReviewDecisionV1, TaskEnvelopeV1, TaskEvent, TaskRecord, TaskResultV1 } from '#domain-model'
import { createActivities } from '../../workflows/activities.ts'
import { reviewArtifactUri } from '../../workflows/review-inputs.ts'
import { FakeAdapter, syntheticActivityDeps, syntheticRunner } from './fake-adapter.ts'

const ACTOR: EventActor = { type: 'system', id: 'review-input-fields-test' }
const APPLICATION_ACTOR: EventActor = { type: 'system', id: 'mission-workflow' }
const T0 = '2026-09-22T00:00:00.000Z'
const sha = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')
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
const reviewApplicationId = (taskId: string): string =>
  `rev_${sha(JSON.stringify(['cmap/review-application/v1', taskId]))}`
const reviewInputSha = (
  taskId: string,
  round: number,
  reviewDecision: ReviewDecisionV1,
  followupInputs: unknown,
): string => sha(JSON.stringify(stable({
  taskId,
  round,
  decision: reviewDecision,
  previousProgress: null,
  currentProgress: null,
  followup_format: 2,
  followup_inputs: followupInputs,
})))

const mission = (id: string): Mission => ({
  id,
  tenant: 'team-ycc',
  owner: 'crosswarm',
  type: 'perf',
  goal: '首屏 P95 降到 1800ms',
  constraints: {},
  acceptance: [{ criterion_id: 'PERF-P95', metric: 'p95_ms', operator: 'lte', expected: 1800, hard_gate: true }],
  workflow_template: 'perf/v1',
  state: 'RUNNING',
  revision: 1,
  created_at: T0,
  updated_at: T0,
})

const activities = (store: MemoryStore) =>
  createActivities(syntheticActivityDeps({
    store,
    adapter: new FakeAdapter(),
    runner: syntheticRunner(),
    pollIntervalMs: 1,
  }))

class CorruptReceiptStore extends MemoryStore {
  mode: 'none' | 'downgrade' | 'matrix' = 'none'

  override async listEvents(missionId: string): Promise<readonly TaskEvent[]> {
    return (await super.listEvents(missionId)).map((event) => {
      if (this.mode === 'none' || event.event_type !== 'REVIEW_APPLICATION_INTENT') return event
      const payload = structuredClone(event.payload) as Record<string, unknown>
      if (this.mode === 'downgrade') {
        delete payload['followup_format']
        delete payload['followup_inputs']
      } else {
        payload['followup_inputs'] = [[]]
      }
      return { ...event, payload }
    })
  }
}

class ReviewInputFaultStore extends MemoryStore {
  throwAfterIntent = false
  revokeArtifacts = false
  onListArtifacts?: () => void

  override async appendEvent(input: Parameters<MemoryStore['appendEvent']>[0]) {
    const out = await super.appendEvent(input)
    if (this.throwAfterIntent && input.event.idempotency_key.startsWith('review-application:intent:')) {
      this.throwAfterIntent = false
      throw new Error('lost intent return after commit')
    }
    return out
  }

  override async listArtifacts(taskId: string): Promise<readonly Artifact[]> {
    this.onListArtifacts?.()
    const artifacts = await super.listArtifacts(taskId)
    if (!this.revokeArtifacts) return artifacts
    return artifacts.map((item) => ({ ...item, state: 'REVOKED' as const }))
  }
}

const toReviewable = async (store: MemoryStore, missionId: string): Promise<TaskRecord> => {
  const acts = activities(store)
  const { taskId } = await acts.createTask({ missionId, capability: 'code.analyze', goal: '优化首屏' })
  await acts.markReady(taskId)
  await acts.dispatchTask(taskId)
  await acts.beginReview(taskId)
  const task = await store.getTask(taskId)
  assert.ok(task)
  return task
}

const result = (m: Mission, taskId: string, artifactId: string, digest: string): TaskResultV1 => ({
  schema: 'cmap/task-result/v1',
  mission_id: m.id,
  task_id: taskId,
  attempt: 1,
  status: 'completed',
  summary: 'done',
  criterion_results: [{ criterion_id: 'PERF-P95', actual: 1914, passed: false, evidence_artifact_ids: [artifactId] }],
  artifacts: [{ artifact_id: artifactId, role: 'report', uri: 'evidence/report.txt', sha256: digest, size_bytes: 4 }],
})

const producer = (m: Mission, id: string, artifactId: string, digest: string): TaskRecord => ({
  id,
  mission_id: m.id,
  parent_task_id: null,
  supersedes_task_id: null,
  capability: 'code.analyze',
  risk: 'read-meta',
  state: 'COMPLETED',
  attempt: 1,
  max_attempts: 1,
  lamport: 0,
  envelope: {
    schema: 'cmap/task-envelope/v1',
    identity: { mission_id: m.id, task_id: id, idempotency_key: `${m.id}:${id}`, revision: 1, tenant: m.tenant, owner: m.owner },
    classification: { task_type: m.type, requested_capability: 'code.analyze', risk_level: 'read-meta' },
    goal: { statement: 'produce evidence', success_definition: m.acceptance as TaskEnvelopeV1['goal']['success_definition'] },
    environment: { tenant: m.tenant },
    execution_policy: { timeout_seconds: 30, max_attempts: 1 },
    permissions: { forbidden: [] },
    evidence_requirements: { required_artifact_roles: ['report'] },
    output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
  },
  result: result(m, id, artifactId, digest),
  binding: null,
  deps: [],
  created_at: T0,
  updated_at: T0,
})

const artifact = (m: Mission, taskId: string, artifactId: string, digest: string): Artifact => ({
  artifact_id: artifactId,
  mission_id: m.id,
  task_id: taskId,
  role: 'report',
  uri: 'evidence/report.txt',
  media_type: 'text/plain',
  size_bytes: 4,
  sha256: digest,
  version: 1,
  state: 'AVAILABLE',
  producer: { agent_id: 'codex', adapter_version: 'test', execution_session_id: 'session' },
  provenance: {},
  retention: { retain_until: '2099-01-01T00:00:00.000Z', immutable: true },
  security: { classification: 'internal', contains_secrets: false, contains_pii: false, allowed_roles: [] },
  created_at: T0,
})

const decision = (missionId: string, taskId: string): ReviewDecisionV1 => ({
  schema: 'cmap/review-decision/v1',
  mission_id: missionId,
  reviewed_task_ids: [taskId],
  decision: 'rework',
  hard_gate_summary: { total: 1, passed: 0, failed: 1 },
  failed_criteria: [{ criterion_id: 'PERF-P95', expected: '<= 1800 ms', actual: '1914 ms', reason: 'slow' }],
  required_followups: [{
    capability: 'codex.performance.root_cause',
    task_type: 'performance.deep-diagnosis',
    inputs: { artifact_refs: ['art-report'] },
    parameters: { marker: 'keep-me', nested: { zero: 0, no: false, empty: null, list: [1, 'two'] } },
    focus: ['root-cause'],
  }],
  stop_conditions: { max_additional_cycles: 3 },
  review_confidence: { level: 'high' },
}) as ReviewDecisionV1

test('new review applications freeze format2 inputs and pass task type, parameters and artifact refs to child envelope', async () => {
  const store = new MemoryStore()
  const m = mission('mis-review-input-fields')
  const digest = sha('data')
  await store.createMission({ mission: m, actor: ACTOR })
  const source = await toReviewable(store, m.id)
  await store.createTask({ task: producer(m, 'producer', 'art-report', digest), actor: ACTOR })
  await store.putArtifact(artifact(m, 'producer', 'art-report', digest))

  const out = await activities(store).applyReviewDecision({ taskId: source.id, decision: decision(m.id, source.id), round: 1 })
  const child = await store.getTask(out.followupTaskIds[0]!)
  assert.ok(child)

  assert.equal(child.envelope.classification.task_type, 'performance.deep-diagnosis')
  assert.deepEqual(child.envelope.inputs?.parameters, { marker: 'keep-me', nested: { zero: 0, no: false, empty: null, list: [1, 'two'] } })
  assert.deepEqual(child.envelope.inputs?.artifact_refs, [{
    artifact_id: 'art-report',
    source_task_id: 'producer',
    role: 'report',
    uri: reviewArtifactUri('art-report'),
    sha256: digest,
  }])

  const receipts = (await store.listEvents(m.id)).filter((event) => event.event_type === 'REVIEW_APPLICATION_INTENT')
  assert.equal(receipts.length, 1)
  assert.deepEqual(receipts[0]!.payload, {
    schema: 'cmap/review-application/v1',
    phase: 'intent',
    round: 1,
    input_sha256: receipts[0]!.payload.input_sha256,
    review_id: receipts[0]!.payload.review_id,
    followup_format: 2,
    followup_inputs: [[{
      artifact_id: 'art-report',
      source_task_id: 'producer',
      role: 'report',
      uri: reviewArtifactUri('art-report'),
      sha256: digest,
    }]],
    output: out,
  })
})

test('format2 rejects changed parameters after the intent freezes hash and output', async () => {
  const store = new MemoryStore()
  const m = mission('mis-review-input-fields-conflict')
  const digest = sha('data')
  await store.createMission({ mission: m, actor: ACTOR })
  const source = await toReviewable(store, m.id)
  await store.createTask({ task: producer(m, 'producer', 'art-report', digest), actor: ACTOR })
  await store.putArtifact(artifact(m, 'producer', 'art-report', digest))
  const frozen = decision(m.id, source.id)
  await activities(store).applyReviewDecision({ taskId: source.id, decision: frozen, round: 1 })

  const changed = decision(m.id, source.id)
  changed.required_followups![0]!.parameters = { marker: 'changed' }
  await assert.rejects(
    () => activities(store).applyReviewDecision({ taskId: source.id, decision: changed, round: 1 }),
    /Review application conflict/,
  )

  const changedType = decision(m.id, source.id)
  changedType.required_followups![0]!.task_type = 'performance.other'
  await assert.rejects(
    () => activities(store).applyReviewDecision({ taskId: source.id, decision: changedType, round: 1 }),
    /Review application conflict/,
  )

  const changedRefs = decision(m.id, source.id)
  changedRefs.required_followups![0]!.inputs = { artifact_refs: ['art-other'] }
  await assert.rejects(
    () => activities(store).applyReviewDecision({ taskId: source.id, decision: changedRefs, round: 1 }),
    /Review application conflict/,
  )
})

test('format2 rejects contradictory matrix even when the receipt hash was computed from it', async () => {
  const store = new MemoryStore()
  const m = mission('mis-review-input-fields-bad-matrix')
  const digest = sha('data')
  await store.createMission({ mission: m, actor: ACTOR })
  const source = await toReviewable(store, m.id)
  await store.createTask({ task: producer(m, 'producer', 'art-report', digest), actor: ACTOR })
  await store.putArtifact(artifact(m, 'producer', 'art-report', digest))
  const frozen = decision(m.id, source.id)
  const badMatrix = [[{
    artifact_id: 'art-other',
    source_task_id: 'producer',
    role: 'report',
    uri: reviewArtifactUri('art-other'),
    sha256: digest,
  }]]
  const id = reviewApplicationId(source.id)
  await store.appendEvent({ event: {
    event_type: 'REVIEW_APPLICATION_INTENT',
    event_version: 1,
    occurred_at: T0,
    mission_id: m.id,
    task_id: source.id,
    attempt: source.attempt,
    actor: APPLICATION_ACTOR,
    causation_id: null,
    correlation_id: m.id,
    trace_id: source.id,
    idempotency_key: `review-application:intent:${id}`,
    payload: {
      schema: 'cmap/review-application/v1',
      phase: 'intent',
      round: 1,
      input_sha256: reviewInputSha(source.id, 1, frozen, badMatrix),
      review_id: id,
      followup_format: 2,
      followup_inputs: badMatrix,
      output: { outcome: 'rework', followupTaskIds: ['tsk_bad_matrix_child'] },
    },
  } })

  await assert.rejects(
    () => activities(store).applyReviewDecision({ taskId: source.id, decision: frozen, round: 1 }),
    /Review application conflict/,
  )
  assert.equal((await store.listReviews(m.id)).length, 0)
})

test('format2 rejects receipt downgrade and matrix corruption on replay', async () => {
  for (const mode of ['downgrade', 'matrix'] as const) {
    const store = new CorruptReceiptStore()
    const m = mission(`mis-review-input-fields-${mode}`)
    const digest = sha('data')
    await store.createMission({ mission: m, actor: ACTOR })
    const source = await toReviewable(store, m.id)
    await store.createTask({ task: producer(m, 'producer', 'art-report', digest), actor: ACTOR })
    await store.putArtifact(artifact(m, 'producer', 'art-report', digest))
    const frozen = decision(m.id, source.id)
    await activities(store).applyReviewDecision({ taskId: source.id, decision: frozen, round: 1 })

    store.mode = mode
    await assert.rejects(
      () => activities(store).applyReviewDecision({ taskId: source.id, decision: frozen, round: 1 }),
      /corrupt|Review application conflict/,
    )
  }
})

test('format2 intent replay uses frozen refs after source registry revocation when no child was created', async () => {
  const store = new ReviewInputFaultStore()
  const m = mission('mis-review-input-fields-intent-lost')
  const digest = sha('data')
  await store.createMission({ mission: m, actor: ACTOR })
  const source = await toReviewable(store, m.id)
  await store.createTask({ task: producer(m, 'producer', 'art-report', digest), actor: ACTOR })
  await store.putArtifact(artifact(m, 'producer', 'art-report', digest))
  const frozen = decision(m.id, source.id)

  store.throwAfterIntent = true
  await assert.rejects(
    () => activities(store).applyReviewDecision({ taskId: source.id, decision: frozen, round: 1 }),
    /lost intent return/,
  )
  assert.equal((await store.queryTasks({ missionId: m.id })).filter((task) => task.supersedes_task_id === source.id).length, 0)

  store.revokeArtifacts = true
  const out = await activities(store).applyReviewDecision({ taskId: source.id, decision: frozen, round: 1 })
  const child = await store.getTask(out.followupTaskIds[0]!)
  assert.ok(child)
  assert.deepEqual(child.envelope.inputs?.artifact_refs, [{
    artifact_id: 'art-report',
    source_task_id: 'producer',
    role: 'report',
    uri: reviewArtifactUri('art-report'),
    sha256: digest,
  }])
})

test('format2 completed replay is independent of current source registry retention', async () => {
  const store = new ReviewInputFaultStore()
  const m = mission('mis-review-input-fields-complete-retention')
  const digest = sha('data')
  await store.createMission({ mission: m, actor: ACTOR })
  const source = await toReviewable(store, m.id)
  await store.createTask({ task: producer(m, 'producer', 'art-report', digest), actor: ACTOR })
  await store.putArtifact(artifact(m, 'producer', 'art-report', digest))
  const frozen = decision(m.id, source.id)
  const out = await activities(store).applyReviewDecision({ taskId: source.id, decision: frozen, round: 1 })

  store.revokeArtifacts = true
  assert.deepEqual(await activities(store).applyReviewDecision({ taskId: source.id, decision: frozen, round: 1 }), out)
})

test('format2 freezes caller decision before async input resolution', async () => {
  const store = new ReviewInputFaultStore()
  const m = mission('mis-review-input-fields-mutation')
  const digest = sha('data')
  await store.createMission({ mission: m, actor: ACTOR })
  const source = await toReviewable(store, m.id)
  await store.createTask({ task: producer(m, 'producer', 'art-report', digest), actor: ACTOR })
  await store.putArtifact(artifact(m, 'producer', 'art-report', digest))
  const original = decision(m.id, source.id)
  let mutated = false
  store.onListArtifacts = () => {
    if (mutated) return
    mutated = true
    original.required_followups![0]!.task_type = 'performance.mutated'
    original.required_followups![0]!.parameters = { marker: 'mutated' }
    original.required_followups![0]!.inputs = { artifact_refs: ['art-mutated'] }
  }

  const out = await activities(store).applyReviewDecision({ taskId: source.id, decision: original, round: 1 })
  const child = await store.getTask(out.followupTaskIds[0]!)
  assert.ok(child)
  assert.equal(child.envelope.classification.task_type, 'performance.deep-diagnosis')
  assert.deepEqual(child.envelope.inputs?.parameters, { marker: 'keep-me', nested: { zero: 0, no: false, empty: null, list: [1, 'two'] } })
  assert.equal(child.envelope.inputs?.artifact_refs?.[0]?.artifact_id, 'art-report')
})

test('malformed followup parameters are rejected before review receipts', async () => {
  const store = new MemoryStore()
  const m = mission('mis-review-input-fields-bad-json')
  await store.createMission({ mission: m, actor: ACTOR })
  const source = await toReviewable(store, m.id)
  const bad = decision(m.id, source.id)
  bad.required_followups![0]!.parameters = { value: Number.NaN }

  await assert.rejects(
    () => activities(store).applyReviewDecision({ taskId: source.id, decision: bad, round: 1 }),
    /TASK_PARAMETERS_INVALID/,
  )
  assert.equal((await store.listEvents(m.id)).filter((event) => event.event_type === 'REVIEW_APPLICATION_INTENT').length, 0)
})
