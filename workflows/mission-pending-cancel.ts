import { createHash } from 'node:crypto'

import type { Store, TaskEvent, TaskRecord } from '#domain-model'
import { MISSION_ACTOR } from './task-creation.ts'

export { MISSION_ACTOR }

const VERSION = 'cmap/mission-pending-cancel/v1'
const MAX_ID_LENGTH = 256
const REASONS = [
  'BRANCH_ESCALATED',
  'APPROVAL_REJECTED',
  'ADMISSION_DENIED',
  'EXECUTION_UNCERTAIN',
  'WORKFLOW_ACTIVITY_FAILED',
  'MISSION_TASK_LIMIT',
] as const

export type CancelPendingMissionTasksInput = {
  readonly missionId: string
  readonly taskIds: readonly string[]
  readonly reason: (typeof REASONS)[number]
}

type PendingCancelRequest = {
  readonly missionId: string
  readonly taskIds: readonly string[]
  readonly reason: CancelPendingMissionTasksInput['reason']
  readonly requestSha256: string
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype

const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= MAX_ID_LENGTH

const receiptKey = (taskId: string): string => `mission-pending-cancel:${taskId}`

const requestHash = (missionId: string, reason: string, taskIds: readonly string[]): string =>
  createHash('sha256').update(JSON.stringify([VERSION, missionId, reason, taskIds])).digest('hex')

const snapshotInput = (input: CancelPendingMissionTasksInput): PendingCancelRequest => {
  if (!isPlainObject(input)) throw new Error('pending cancel input must be a plain object')
  const keys = Object.keys(input).sort()
  if (JSON.stringify(keys) !== JSON.stringify(['missionId', 'reason', 'taskIds'])) {
    throw new Error('pending cancel input has unexpected fields')
  }
  const { missionId, reason, taskIds } = input
  if (!validId(missionId)) throw new Error('pending cancel missionId is invalid')
  if (!REASONS.includes(reason)) throw new Error('pending cancel reason is invalid')
  if (!Array.isArray(taskIds)) throw new Error('pending cancel taskIds must be an array')
  for (const id of taskIds) if (!validId(id)) throw new Error('pending cancel taskId is invalid')
  if (new Set(taskIds).size !== taskIds.length) throw new Error('pending cancel taskIds contain duplicate ids')
  const ordered = [...taskIds]
  return { missionId, taskIds: ordered, reason, requestSha256: requestHash(missionId, reason, ordered) }
}

const expectedPayload = (request: PendingCancelRequest): Record<string, unknown> => ({
  from: 'DRAFT',
  to: 'CANCELED',
  reason: request.reason,
  request_sha256: request.requestSha256,
})

const samePayload = (actual: Readonly<Record<string, unknown>>, expected: Readonly<Record<string, unknown>>): boolean =>
  Object.keys(actual).length === Object.keys(expected).length &&
  Object.entries(expected).every(([key, value]) => actual[key] === value)

const isExpectedReceipt = (
  event: TaskEvent | undefined,
  task: TaskRecord,
  request: PendingCancelRequest,
): boolean =>
  event?.event_type === 'TASK_CANCELED' &&
  event.event_version === 1 &&
  event.mission_id === request.missionId &&
  event.task_id === task.id &&
  event.attempt === null &&
  event.actor.type === MISSION_ACTOR.type &&
  event.actor.id === MISSION_ACTOR.id &&
  event.actor.runner_id === undefined &&
  event.causation_id === null &&
  event.correlation_id === request.missionId &&
  event.trace_id === null &&
  event.idempotency_key === receiptKey(task.id) &&
  samePayload(event.payload, expectedPayload(request))

const receiptsFor = async (store: Store, request: PendingCancelRequest, task: TaskRecord): Promise<readonly TaskEvent[]> =>
  (await store.listEvents(request.missionId)).filter((event) => event.idempotency_key === receiptKey(task.id))

const assertExactReceipt = async (store: Store, request: PendingCancelRequest, task: TaskRecord): Promise<void> => {
  const events = await receiptsFor(store, request, task)
  if (events.length !== 1 || !isExpectedReceipt(events[0], task, request)) {
    throw new Error(`pending cancel receipt mismatch for ${task.id}`)
  }
}

const preflightTask = async (store: Store, request: PendingCancelRequest, taskId: string): Promise<TaskRecord> => {
  const task = await store.getTask(taskId)
  if (!task) throw new Error(`pending cancel task missing: ${taskId}`)
  if (task.mission_id !== request.missionId) throw new Error(`pending cancel task mission mismatch: ${taskId}`)
  const receipts = await receiptsFor(store, request, task)
  if (task.state === 'CANCELED') {
    if (task.binding) throw new Error(`pending cancel task has binding: ${taskId}`)
    if (task.result) throw new Error(`pending cancel task has result: ${taskId}`)
    await assertExactReceipt(store, request, task)
    return task
  }
  if (receipts.length > 0) {
    const latest = await store.getTask(taskId)
    if (latest?.mission_id === request.missionId && latest.state === 'CANCELED') {
      if (latest.binding) throw new Error(`pending cancel task has binding: ${taskId}`)
      if (latest.result) throw new Error(`pending cancel task has result: ${taskId}`)
      await assertExactReceipt(store, request, latest)
      return latest
    }
    throw new Error(`pending cancel DRAFT task has receipt: ${taskId}`)
  }
  if (task.state !== 'DRAFT') throw new Error(`pending cancel task is not DRAFT: ${taskId}`)
  if (task.binding) throw new Error(`pending cancel task has binding: ${taskId}`)
  if (task.result) throw new Error(`pending cancel task has result: ${taskId}`)
  return task
}

export async function cancelPendingMissionTasks(
  store: Store,
  input: CancelPendingMissionTasksInput,
): Promise<void> {
  const request = snapshotInput(input)
  if (!(await store.getMission(request.missionId))) throw new Error(`pending cancel mission missing: ${request.missionId}`)
  const tasks = []
  for (const taskId of request.taskIds) tasks.push(await preflightTask(store, request, taskId))

  for (const task of tasks) {
    if (task.state === 'CANCELED') continue
    await store.transitionTask({
      taskId: task.id,
      to: 'CANCELED',
      expectedFrom: 'DRAFT',
      actor: MISSION_ACTOR,
      eventType: 'TASK_CANCELED',
      idempotencyKey: receiptKey(task.id),
      payload: { reason: request.reason, request_sha256: request.requestSha256 },
    })
    const current = await store.getTask(task.id)
    if (!current || current.state !== 'CANCELED' || current.binding || current.result) {
      throw new Error(`pending cancel task verification failed: ${task.id}`)
    }
    await assertExactReceipt(store, request, current)
  }
}
