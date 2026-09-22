import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { Ajv2020 } from 'ajv/dist/2020.js'

import {
  detectNoProgress,
  type EventActor,
  type Review,
  type ReviewApplicationV1,
  type ReviewDecisionV1,
  type Store,
  type TaskEvent,
  type TaskRecord,
} from '#domain-model'
import type { ApplyReviewInput, ApplyReviewOutput } from './activities.ts'
import { resolveReviewInputs, reviewArtifactUri, type ReviewInputMatrix } from './review-inputs.ts'
import { MISSION_ACTOR, createLedgerTask, snapshotTaskParameters, taskCreationId, taskCreationMatches } from './task-creation.ts'
import type { CreateTaskInput } from './task-creation.ts'

const ACTOR: EventActor = MISSION_ACTOR
const VERSION = 'cmap/review-application/v1'
const CONTROL_ESCALATION_REASON = '评审者主动升级'
const CONTROL_LEGACY_FORCED_ESCALATION_REASON = '历史评审已决定升级，停止返工并升级'
const receiptSchema = JSON.parse(readFileSync(new URL('../schemas/review-application.v1.schema.json', import.meta.url), 'utf8')) as object
const reviewDecisionSchema = JSON.parse(readFileSync(new URL('../schemas/review-decision.v1.schema.json', import.meta.url), 'utf8')) as object
const ajv = new Ajv2020({ strict: false, allErrors: true })
const validateReceipt = ajv.compile(receiptSchema)
const validateReviewDecision = ajv.compile(reviewDecisionSchema)

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const now = (): string => new Date().toISOString()

const json = (value: unknown): string => JSON.stringify(value)
const keyOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => stable(item))
  }
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

const progress = (snapshot: ApplyReviewInput['currentProgress']): unknown => {
  if (!snapshot) return null
  return stable({
    patchHash: snapshot.patchHash,
    failedCriteriaIds: [...snapshot.failedCriteriaIds].sort(keyOrder),
    metricValue: snapshot.metricValue,
    errorFingerprint: snapshot.errorFingerprint,
  })
}

type FollowupFormat = 1 | 2

const snapshotParameters = (parameters: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  if (parameters === undefined) return undefined
  return snapshotTaskParameters(parameters)
}

const assertFollowupParameters = (decision: ReviewDecisionV1): void => {
  for (const followup of decision.required_followups ?? []) {
    snapshotParameters(followup.parameters)
  }
}

const canonicalInput = (
  input: ApplyReviewInput,
  format: FollowupFormat,
  matrix?: ReviewInputMatrix,
) => stable({
  taskId: input.taskId,
  round: input.round,
  decision: input.decision,
  previousProgress: progress(input.previousProgress),
  currentProgress: progress(input.currentProgress),
  ...(format === 2 ? { followup_format: 2, followup_inputs: matrix ?? [] } : {}),
})

const inputSha = (input: ApplyReviewInput, format: FollowupFormat, matrix?: ReviewInputMatrix): string =>
  sha256(json(canonicalInput(input, format, matrix)))
const reviewId = (taskId: string): string => `rev_${sha256(json([VERSION, taskId]))}`
const taskIdFor = (missionId: string, key: string): string => taskCreationId(missionId, key)

const reviewTaskKey = (taskId: string, round: number, index: number): string =>
  `review:${taskId}:${round}:followup:${index}`

const reviewEventPayload = (
  phase: ReviewApplicationV1['phase'],
  round: number,
  hash: string,
  id: string,
  output: ApplyReviewOutput,
  format: FollowupFormat,
  matrix?: ReviewInputMatrix,
): ReviewApplicationV1 => ({
  schema: VERSION,
  phase,
  round,
  input_sha256: hash,
  review_id: id,
  ...(format === 2 ? { followup_format: 2, followup_inputs: matrix ?? [] } : {}),
  output: {
    outcome: output.outcome,
    followupTaskIds: [...output.followupTaskIds],
    ...(output.escalationReason ? { escalationReason: output.escalationReason } : {}),
  },
})

const asOutput = (payload: ReviewApplicationV1): ApplyReviewOutput => ({
  outcome: payload.output.outcome,
  followupTaskIds: [...payload.output.followupTaskIds],
  ...(payload.output.escalationReason ? { escalationReason: payload.output.escalationReason } : {}),
})

const eventTypeForPhase = (phase: ReviewApplicationV1['phase']): TaskEvent['event_type'] =>
  phase === 'intent' ? 'REVIEW_APPLICATION_INTENT' : 'REVIEW_APPLICATION_COMPLETED'

const parseReceiptEvent = (
  event: TaskEvent,
  task: TaskRecord,
  phase: ReviewApplicationV1['phase'],
  id: string,
): ReviewApplicationV1 | null => {
  if (event.event_type !== eventTypeForPhase(phase)) return null
  const expectedKey = `review-application:${phase}:${id}`
  if (event.task_id !== task.id && event.idempotency_key !== expectedKey) return null
  if (event.event_version !== 1 ||
      event.mission_id !== task.mission_id ||
      event.task_id !== task.id ||
      event.attempt !== task.attempt ||
      !isDeepStrictEqual(event.actor, ACTOR) ||
      event.correlation_id !== task.mission_id ||
      event.trace_id !== task.id ||
      event.idempotency_key !== expectedKey) {
    throw new Error('corrupt review application receipt')
  }
  if (!validateReceipt(event.payload)) throw new Error('corrupt review application receipt')
  const payload = event.payload as unknown as ReviewApplicationV1
  if (payload.phase !== phase || payload.review_id !== id) throw new Error('corrupt review application receipt')
  return payload
}

const appendReviewApplicationEvent = async (
  store: Store,
  task: TaskRecord,
  phase: ReviewApplicationV1['phase'],
  round: number,
  hash: string,
  id: string,
  output: ApplyReviewOutput,
  format: FollowupFormat,
  matrix?: ReviewInputMatrix,
): Promise<void> => {
  const payload = reviewEventPayload(phase, round, hash, id, output, format, matrix)
  if (!validateReceipt(payload)) throw new Error('invalid review application receipt')
  await store.appendEvent({
    event: {
      event_type: phase === 'intent' ? 'REVIEW_APPLICATION_INTENT' : 'REVIEW_APPLICATION_COMPLETED',
      event_version: 1,
      occurred_at: now(),
      mission_id: task.mission_id,
      task_id: task.id,
      attempt: task.attempt,
      actor: ACTOR,
      causation_id: null,
      correlation_id: task.mission_id,
      trace_id: task.id,
      idempotency_key: `review-application:${phase}:${id}`,
      payload: { ...payload },
    },
  })
}

const reviewApplicationEvents = async (
  store: Store,
  task: TaskRecord,
  phase: ReviewApplicationV1['phase'],
  id: string,
): Promise<readonly ReviewApplicationV1[]> => (await store.listEvents(task.mission_id))
  .flatMap((event) => {
    const parsed = parseReceiptEvent(event, task, phase, id)
    return parsed ? [parsed] : []
  })

const taskReviews = async (store: Store, task: TaskRecord): Promise<readonly Review[]> =>
  (await store.listReviews(task.mission_id)).filter((r) => r.reviewed_task_ids.includes(task.id))

const assertProgress = (snapshot: ApplyReviewInput['currentProgress']): void => {
  if (!snapshot) return
  if (typeof snapshot.patchHash !== 'string' ||
      !Array.isArray(snapshot.failedCriteriaIds) ||
      !snapshot.failedCriteriaIds.every((id) => typeof id === 'string') ||
      !(snapshot.metricValue === null || Number.isFinite(snapshot.metricValue)) ||
      !(snapshot.errorFingerprint === null || typeof snapshot.errorFingerprint === 'string')) {
    throw new Error('invalid review progress')
  }
}

const assertInput = (task: TaskRecord, input: ApplyReviewInput): void => {
  if (input.round < 0 || !Number.isSafeInteger(input.round)) throw new Error('review round must be a non-negative safe integer')
  if (!validateReviewDecision(input.decision)) throw new Error('invalid review decision')
  if (input.decision.mission_id !== task.mission_id) throw new Error('review mission_id mismatch')
  if (input.decision.review_round !== undefined && input.decision.review_round !== input.round + 1) {
    throw new Error('review round mismatch')
  }
  if (input.decision.reviewed_task_ids.length !== 1 || input.decision.reviewed_task_ids[0] !== task.id) {
    throw new Error('reviewed_task_ids must exactly match task')
  }
  assertProgress(input.previousProgress)
  assertProgress(input.currentProgress)
  assertFollowupParameters(input.decision)
}

const assertReceiptFormat = (
  receipt: ReviewApplicationV1,
  format: FollowupFormat,
  matrix: ReviewInputMatrix | undefined,
): void => {
  if (format === 1) {
    if (receipt.followup_format !== undefined || receipt.followup_inputs !== undefined) {
      throw new Error('Review application conflict')
    }
    return
  }
  if (receipt.followup_format !== 2 || !isDeepStrictEqual(receipt.followup_inputs ?? [], matrix ?? [])) {
    throw new Error('Review application conflict')
  }
}

const assertMatrixMatchesOutput = (
  decision: ReviewDecisionV1,
  output: ApplyReviewOutput,
  format: FollowupFormat,
  matrix: ReviewInputMatrix | undefined,
): void => {
  if (format === 1) return
  const expected = output.outcome === 'rework' ? decision.required_followups?.length ?? 0 : 0
  if (!matrix || matrix.length !== expected) throw new Error('Review application conflict')
  if (output.outcome === 'rework' && output.followupTaskIds.length !== matrix.length) {
    throw new Error('Review application conflict')
  }
  if (output.outcome !== 'rework') return
  for (const [index, row] of matrix.entries()) {
    const declared = decision.required_followups?.[index]?.inputs?.artifact_refs ?? []
    if (row.length !== declared.length) throw new Error('Review application conflict')
    for (const [refIndex, ref] of row.entries()) {
      const artifactId = declared[refIndex]
      if (ref.artifact_id !== artifactId || ref.uri !== reviewArtifactUri(ref.artifact_id)) {
        throw new Error('Review application conflict')
      }
    }
  }
}

const budgetEscalationReason = (round: number, max: number): string =>
  `返工轮次已达上限（${round}/${max}），停止返工并升级`

const assertFrozenOutputMatchesInput = (input: ApplyReviewInput, output: ApplyReviewOutput): void => {
  const decision = input.decision
  if (decision.decision === 'accept') {
    if (!isDeepStrictEqual(output, { outcome: 'accept', followupTaskIds: [] })) {
      throw new Error('Review application conflict')
    }
    return
  }
  if (decision.decision === 'escalate') {
    if (!isDeepStrictEqual(output, {
      outcome: 'escalated',
      followupTaskIds: [],
      escalationReason: CONTROL_ESCALATION_REASON,
    })) {
      throw new Error('Review application conflict')
    }
    return
  }

  const max = decision.stop_conditions?.max_additional_cycles ?? 0
  if (input.round >= max) {
    if (!isDeepStrictEqual(output, {
      outcome: 'escalated',
      followupTaskIds: [],
      escalationReason: budgetEscalationReason(input.round, max),
    })) {
      throw new Error('Review application conflict')
    }
    return
  }
  if (input.previousProgress && input.currentProgress) {
    const result = detectNoProgress(input.previousProgress, input.currentProgress)
    if (result.detected) {
      const escalationReason = `检测到无进展（${result.reasons.join('、')}），停止返工并升级`
      if (!isDeepStrictEqual(output, { outcome: 'escalated', followupTaskIds: [], escalationReason })) {
        throw new Error('Review application conflict')
      }
      return
    }
  }

  const followupCount = decision.required_followups?.length ?? 0
  if (output.outcome !== 'rework' ||
      output.followupTaskIds.length !== followupCount ||
      new Set(output.followupTaskIds).size !== output.followupTaskIds.length ||
      output.escalationReason !== undefined) {
    throw new Error('Review application conflict')
  }
}

const legacyOrderedFollowupIds = async (
  store: Store,
  task: TaskRecord,
  decision: ReviewDecisionV1,
  round: number,
): Promise<readonly string[] | null> => {
  const ordered = (await store.listEvents(task.mission_id))
    .filter((event) => event.task_id === task.id && event.event_type === 'REVIEW_REWORK_REQUESTED')
    .map((event) => (event.payload as Record<string, unknown>)['followups'])
    .filter((followups): followups is readonly unknown[] => Array.isArray(followups))
  if (ordered.length === 0) return null
  if (ordered.length > 1) throw new Error('ambiguous legacy review child')
  const ids = ordered[0]
  if (!ids) throw new Error('ambiguous legacy review child')
  const followups = decision.required_followups ?? []
  if (ids.length !== followups.length || !ids.every((id) => typeof id === 'string')) {
    throw new Error('ambiguous legacy review child')
  }
  const childIds = ids as readonly string[]
  if (new Set(childIds).size !== childIds.length) throw new Error('ambiguous legacy review child')
  for (const [index, id] of childIds.entries()) {
    const child = await store.getTask(id)
    if (!child || child.supersedes_task_id !== task.id) throw new Error('ambiguous legacy review child')
    if (!(await taskCreationMatches(store, child, childInput(task, decision, round, index)))) {
      throw new Error('ambiguous legacy review child')
    }
  }
  return childIds
}

const plannedOutput = async (
  store: Store,
  task: TaskRecord,
  input: ApplyReviewInput,
  format: FollowupFormat,
  matrix?: ReviewInputMatrix,
): Promise<ApplyReviewOutput> => {
  const decision = input.decision
  if (decision.decision === 'accept') return { outcome: 'accept', followupTaskIds: [] }
  if (decision.decision === 'escalate') {
    return { outcome: 'escalated', followupTaskIds: [], escalationReason: CONTROL_ESCALATION_REASON }
  }

  const max = decision.stop_conditions?.max_additional_cycles ?? 0
  if (input.round >= max) {
    return {
      outcome: 'escalated',
      followupTaskIds: [],
      escalationReason: budgetEscalationReason(input.round, max),
    }
  }
  if (input.previousProgress && input.currentProgress) {
    const result = detectNoProgress(input.previousProgress, input.currentProgress)
    if (result.detected) {
      return {
        outcome: 'escalated',
        followupTaskIds: [],
        escalationReason: `检测到无进展（${result.reasons.join('、')}），停止返工并升级`,
      }
    }
  }

  const followups = decision.required_followups ?? []
  if (followups.length === 0) throw new Error('rework review requires followup tasks')
  const ordered = format === 1 ? await legacyOrderedFollowupIds(store, task, decision, input.round) : null
  if (ordered) {
    return {
      outcome: 'rework',
      followupTaskIds: [...ordered],
    }
  }
  const existing = (await store.queryTasks({ missionId: task.mission_id }))
    .filter((candidate) => candidate.supersedes_task_id === task.id)
  const followupTaskIds = await Promise.all(followups.map(async (_, i) => {
    if (format === 2 && matrix === undefined) return taskIdFor(task.mission_id, reviewTaskKey(task.id, input.round, i))
    const matches = []
    for (const candidate of existing) {
      if (await taskCreationMatches(store, candidate, childInput(task, decision, input.round, i, format, matrix))) matches.push(candidate.id)
    }
    if (matches.length > 1) throw new Error('ambiguous legacy review child')
    return matches[0] ?? taskIdFor(task.mission_id, reviewTaskKey(task.id, input.round, i))
  }))
  if (new Set(followupTaskIds).size !== followupTaskIds.length) throw new Error('ambiguous legacy review child')
  return {
    outcome: 'rework',
    followupTaskIds,
  }
}

const childInput = (
  source: TaskRecord,
  decision: ReviewDecisionV1,
  round: number,
  index: number,
  format: FollowupFormat = 1,
  matrix?: ReviewInputMatrix,
): CreateTaskInput => {
  const followup = decision.required_followups?.[index]
  if (!followup) throw new Error(`missing followup ${index}`)
  const base = {
    missionId: source.mission_id,
    capability: followup.capability,
    goal: `返工第 ${round + 1} 轮：${followup.focus?.join('、') ?? followup.task_type}`,
    supersedesTaskId: source.id,
    creationKey: reviewTaskKey(source.id, round, index),
  }
  if (format === 1) return base
  const refs = matrix?.[index]
  if (!refs) throw new Error('review input proof mismatch')
  const parameters = snapshotParameters(followup.parameters)
  return {
    ...base,
    taskType: followup.task_type,
    ...(parameters !== undefined ? { parameters } : {}),
    ...(refs.length > 0 ? { artifactRefs: structuredClone(refs) } : {}),
  }
}

const createReviewChild = async (
  store: Store,
  source: TaskRecord,
  decision: ReviewDecisionV1,
  round: number,
  index: number,
  id: string,
  format: FollowupFormat,
  matrix?: ReviewInputMatrix,
): Promise<string> => {
  await createLedgerTask(store, childInput(source, decision, round, index, format, matrix), id)
  return id
}

const assertChildProof = async (
  store: Store,
  task: TaskRecord,
  decision: ReviewDecisionV1,
  round: number,
  ids: readonly string[],
  format: FollowupFormat,
  matrix?: ReviewInputMatrix,
): Promise<void> => {
  for (const [index, id] of ids.entries()) {
    const followup = decision.required_followups?.[index]
    if (!followup) throw new Error('missing followup proof')
    const expectedId = taskIdFor(task.mission_id, reviewTaskKey(task.id, round, index))
    if (id === expectedId) continue
    const existing = await store.getTask(id)
    if (!existing || existing.supersedes_task_id !== task.id) throw new Error('review child proof mismatch')
    if (!(await taskCreationMatches(store, existing, childInput(task, decision, round, index, format, matrix)))) {
      throw new Error('review child proof mismatch')
    }
  }
}

const finishAccept = async (store: Store, task: TaskRecord, round: number): Promise<void> => {
  const latest = await store.getTask(task.id)
  if (!latest || latest.state === 'COMPLETED') return
  if (latest.state !== 'REVIEWING') throw new Error(`accept requires REVIEWING task, got ${latest.state}`)
  await store.transitionTask({
    taskId: task.id,
    to: 'COMPLETED',
    actor: ACTOR,
    eventType: 'REVIEW_ACCEPTED',
    idempotencyKey: `review-accepted:${task.id}:${round}`,
    payload: { round },
  })
}

const finishExplicitEscalated = async (store: Store, task: TaskRecord, round: number): Promise<void> => {
  const latest = await store.getTask(task.id)
  if (!latest) return
  if (latest.state === 'REVIEWING') {
    await store.transitionTask({
      taskId: task.id,
      to: 'COMPLETED',
      actor: ACTOR,
      eventType: 'REVIEW_ESCALATED',
      idempotencyKey: `review-explicit-escalated:${task.id}:${round}`,
      payload: { round, reason: CONTROL_ESCALATION_REASON },
    })
  } else if (latest.state !== 'COMPLETED') {
    throw new Error(`explicit escalation requires REVIEWING task, got ${latest.state}`)
  }
  await store.setMissionState(task.mission_id, 'ESCALATED', ACTOR, `review-explicit-escalated-mission:${task.id}:${round}`)
}

const finishForcedEscalated = async (store: Store, task: TaskRecord, round: number, reason: string): Promise<void> => {
  const latest = await store.getTask(task.id)
  if (!latest) return
  if (latest.state === 'REVIEWING' || latest.state === 'VERIFYING') {
    const reworked = await store.transitionTask({
      taskId: task.id,
      to: 'REWORK',
      actor: ACTOR,
      eventType: 'REVIEW_ESCALATED',
      idempotencyKey: `review-escalated:${task.id}:${round}`,
      payload: { round, reason },
    })
    if (reworked.state !== 'REWORK') throw new Error('forced escalation rework proof missing')
  }
  const afterRework = await store.getTask(task.id)
  if (afterRework?.state === 'REWORK') {
    await store.transitionTask({
      taskId: task.id,
      to: 'FAILED_TERMINAL',
      actor: ACTOR,
      eventType: 'TASK_FAILED',
      idempotencyKey: `review-escalated-done:${task.id}:${round}`,
      payload: { round, reason },
    })
  } else if (afterRework?.state !== 'FAILED_TERMINAL') {
    throw new Error(`forced escalation requires VERIFYING/REVIEWING/REWORK task, got ${afterRework?.state}`)
  }
  await store.setMissionState(task.mission_id, 'ESCALATED', ACTOR, `review-escalated-mission:${task.id}:${round}`)
}

const finishRework = async (
  store: Store,
  task: TaskRecord,
  input: ApplyReviewInput,
  childIds: readonly string[],
  format: FollowupFormat,
  matrix?: ReviewInputMatrix,
): Promise<void> => {
  for (const [index, id] of childIds.entries()) {
    await createReviewChild(store, task, input.decision, input.round, index, id, format, matrix)
  }
  let latest = await store.getTask(task.id)
  if (!latest) return
  if (latest.state === 'REVIEWING' || latest.state === 'VERIFYING') {
    latest = await store.transitionTask({
      taskId: task.id,
      to: 'REWORK',
      actor: ACTOR,
      eventType: 'REVIEW_REWORK_REQUESTED',
      idempotencyKey: `review-rework:${task.id}:${input.round}`,
      payload: {
        round: input.round,
        failed_criteria: input.decision.failed_criteria?.map((c) => c.criterion_id) ?? [],
        followups: [...childIds],
      },
    })
  }
  if (latest.state === 'REWORK') {
    await store.transitionTask({
      taskId: task.id,
      to: 'COMPLETED',
      actor: ACTOR,
      eventType: 'TASK_COMPLETED',
      idempotencyKey: `review-rework-completed:${task.id}:${input.round}`,
    })
  } else if (latest.state !== 'COMPLETED') {
    throw new Error(`rework requires VERIFYING/REVIEWING/REWORK task, got ${latest.state}`)
  }
}

const proof = async (
  store: Store,
  task: TaskRecord,
  input: ApplyReviewInput,
  output: ApplyReviewOutput,
  format: FollowupFormat,
  matrix?: ReviewInputMatrix,
): Promise<void> => {
  const latest = await store.getTask(task.id)
  if (!latest) throw new Error('review source task missing')

  if (output.outcome === 'accept') {
    if (latest.state !== 'COMPLETED') throw new Error('accept review is not completed')
    return
  }
  if (output.outcome === 'escalated') {
    const mission = await store.getMission(task.mission_id)
    const terminal = input.decision.decision === 'escalate' ? 'COMPLETED' : 'FAILED_TERMINAL'
    if (latest.state !== terminal || mission?.state !== 'ESCALATED') {
      throw new Error('escalated review proof missing')
    }
    return
  }

  if (latest.state !== 'COMPLETED') throw new Error('rework source task is not completed')
  const children = (await store.queryTasks({ missionId: task.mission_id }))
    .filter((candidate) => candidate.supersedes_task_id === task.id)
    .sort((a, b) => output.followupTaskIds.indexOf(a.id) - output.followupTaskIds.indexOf(b.id))
  if (!isDeepStrictEqual(children.map((child) => child.id), output.followupTaskIds)) {
    throw new Error('review followup proof mismatch')
  }
  for (const [index, child] of children.entries()) {
    if (
      child.id !== output.followupTaskIds[index] ||
      child.supersedes_task_id !== task.id ||
      !(await taskCreationMatches(store, child, childInput(task, input.decision, input.round, index, format, matrix)))
    ) {
      throw new Error('review child proof mismatch')
    }
  }
}

const assertLegacyCanContinue = async (
  store: Store,
  task: TaskRecord,
  input: ApplyReviewInput,
  legacy: readonly Review[],
  output: ApplyReviewOutput,
): Promise<void> => {
  if (legacy.length === 0) return
  if (legacy.length > 1) throw new Error('ambiguous legacy review application')
  if (!isDeepStrictEqual(legacy[0]!.decision, input.decision)) throw new Error('Review application conflict')
  if (input.decision.decision !== 'rework') return
  const events = await store.listEvents(task.mission_id)
  const hasBranchEvent = events.some((e) => e.task_id === task.id && e.event_type === 'REVIEW_REWORK_REQUESTED')
  const hasEscalationEvent = events.some((e) => e.task_id === task.id &&
    (e.event_type === 'REVIEW_ESCALATED' || e.event_type === 'TASK_FAILED'))
  const hasChildren = (await store.queryTasks({ missionId: task.mission_id }))
    .some((child) => child.supersedes_task_id === task.id)
  if (output.outcome === 'rework' && !hasBranchEvent && !hasChildren) throw new Error('ambiguous legacy rework review')
  if (output.outcome === 'escalated' && !hasEscalationEvent) throw new Error('ambiguous legacy rework review')
}

const legacyForcedEscalationOutput = async (
  store: Store,
  task: TaskRecord,
  input: ApplyReviewInput,
  legacy: readonly Review[],
): Promise<ApplyReviewOutput | null> => {
  if (legacy.length !== 1 || legacy[0]!.decision.decision !== 'rework') return null
  const [latest, mission, events] = await Promise.all([
    store.getTask(task.id),
    store.getMission(task.mission_id),
    store.listEvents(task.mission_id),
  ])
  const hasReviewEscalated = events.some((e) => {
    const payload = e.payload as Record<string, unknown>
    const hasCurrentShape = e.idempotency_key === `review-escalated:${task.id}:${input.round}` &&
      payload['round'] === input.round
    const hasLegacyShape = e.idempotency_key === `escalate-rework:${task.id}`
    return e.task_id === task.id &&
      e.event_type === 'REVIEW_ESCALATED' &&
      isDeepStrictEqual(e.actor, ACTOR) &&
      (hasCurrentShape || hasLegacyShape) &&
      (payload['from'] === 'REVIEWING' || payload['from'] === 'VERIFYING') &&
      payload['to'] === 'REWORK'
  })
  if (!hasReviewEscalated) return null
  const hasReworkBranch = events.some((e) => e.task_id === task.id && e.event_type === 'REVIEW_REWORK_REQUESTED')
  const hasChildren = (await store.queryTasks({ missionId: task.mission_id }))
    .some((child) => child.supersedes_task_id === task.id)
  if (hasReworkBranch || hasChildren) throw new Error('ambiguous legacy rework review')
  if (latest?.state === 'REWORK') {
    if (mission?.state === 'ESCALATED') throw new Error('ambiguous legacy review application')
  } else if (latest?.state === 'FAILED_TERMINAL') {
    const hasTaskFailed = events.some((e) => {
      const payload = e.payload as Record<string, unknown>
      const hasCurrentShape = e.idempotency_key === `review-escalated-done:${task.id}:${input.round}` &&
        payload['round'] === input.round
      const hasLegacyShape = e.idempotency_key === `escalate-done:${task.id}`
      return e.task_id === task.id &&
        e.event_type === 'TASK_FAILED' &&
        isDeepStrictEqual(e.actor, ACTOR) &&
        (hasCurrentShape || hasLegacyShape) &&
        payload['from'] === 'REWORK' &&
        payload['to'] === 'FAILED_TERMINAL'
    })
    if (!hasTaskFailed) return null
  } else {
    return null
  }
  return {
    outcome: 'escalated',
    followupTaskIds: [],
    escalationReason: CONTROL_LEGACY_FORCED_ESCALATION_REASON,
  }
}

const assertTaskReviewConflicts = (reviews: readonly Review[], input: ApplyReviewInput): readonly Review[] => {
  for (const review of reviews) {
    if (review.round !== input.round) throw new Error('Review application conflict')
  }
  const matching = reviews.filter((review) => review.round === input.round)
  if (matching.length > 1) throw new Error('ambiguous legacy review application')
  if (matching[0] && !isDeepStrictEqual(matching[0].decision, input.decision)) {
    throw new Error('Review application conflict')
  }
  return matching
}

const assertStoredReview = async (store: Store, task: TaskRecord, input: ApplyReviewInput): Promise<void> => {
  const matching = assertTaskReviewConflicts(await taskReviews(store, task), input)
  if (matching.length !== 1) throw new Error('review application missing stored review')
}

export const applyReviewApplication = async (
  store: Store,
  input: ApplyReviewInput,
): Promise<ApplyReviewOutput> => {
  const frozen = structuredClone(input) as ApplyReviewInput
  const task = await store.getTask(frozen.taskId)
  if (!task) throw new Error(`任务不存在：${frozen.taskId}`)
  assertInput(task, frozen)

  const id = reviewId(task.id)
  const legacy = assertTaskReviewConflicts(await taskReviews(store, task), frozen)
  const intents = await reviewApplicationEvents(store, task, 'intent', id)
  if (intents.length > 1) throw new Error('conflicting review intents')
  const format: FollowupFormat = intents[0] ? (intents[0].followup_format === 2 ? 2 : 1) : legacy.length === 0 ? 2 : 1
  const legacyEscalation = format === 1 ? await legacyForcedEscalationOutput(store, task, frozen, legacy) : null
  let matrix: ReviewInputMatrix | undefined
  let output: ApplyReviewOutput
  if (intents[0]) {
    matrix = format === 2 ? intents[0].followup_inputs ?? [] : undefined
    output = asOutput(intents[0])
  } else {
    const preliminary = legacyEscalation ?? await plannedOutput(store, task, frozen, format)
    matrix = format === 2
      ? preliminary.outcome === 'rework' ? await resolveReviewInputs(store, task, frozen.decision) : []
      : undefined
    output = legacyEscalation ?? await plannedOutput(store, task, frozen, format, matrix)
  }
  const hash = inputSha(frozen, format, matrix)
  if (intents[0]) {
    assertReceiptFormat(intents[0], format, matrix)
    if (intents[0].input_sha256 !== hash || intents[0].round !== frozen.round) {
      throw new Error('Review application conflict')
    }
  }
  const legacyForcedReplay = format === 1 && legacyEscalation !== null && isDeepStrictEqual(output, legacyEscalation)
  if (!legacyForcedReplay) assertFrozenOutputMatchesInput(frozen, output)
  assertMatrixMatchesOutput(frozen.decision, output, format, matrix)

  const completions = await reviewApplicationEvents(store, task, 'complete', id)
  if (completions.length > 1) throw new Error('conflicting review completion receipts')
  if (completions[0] && !intents[0]) throw new Error('review completion without intent')
  if (completions[0]) {
    assertReceiptFormat(completions[0], format, matrix)
    if (completions[0].input_sha256 !== hash || completions[0].round !== frozen.round) {
      throw new Error('Review application conflict')
    }
    const recorded = asOutput(completions[0])
    if (!isDeepStrictEqual(recorded, output)) throw new Error('Review application conflict')
    await assertStoredReview(store, task, frozen)
    await proof(store, task, frozen, recorded, format, matrix)
    return recorded
  }

  if (!intents[0]) {
    await assertLegacyCanContinue(store, task, frozen, legacy, output)
    await appendReviewApplicationEvent(store, task, 'intent', frozen.round, hash, id, output, format, matrix)
  }

  if (legacy.length === 0) {
    await store.putReview({
      id,
      mission_id: task.mission_id,
      reviewed_task_ids: [task.id],
      round: frozen.round,
      decision: frozen.decision,
      created_at: now(),
    })
  }

  if (output.outcome === 'accept') {
    await finishAccept(store, task, frozen.round)
  } else if (output.outcome === 'escalated') {
    if (frozen.decision.decision === 'escalate') await finishExplicitEscalated(store, task, frozen.round)
    else await finishForcedEscalated(store, task, frozen.round, output.escalationReason ?? 'review escalation')
  } else {
    await assertChildProof(store, task, frozen.decision, frozen.round, output.followupTaskIds, format, matrix)
    await finishRework(store, task, frozen, output.followupTaskIds, format, matrix)
  }

  await assertStoredReview(store, task, frozen)
  await proof(store, task, frozen, output, format, matrix)
  await appendReviewApplicationEvent(store, task, 'complete', frozen.round, hash, id, output, format, matrix)
  return output
}
