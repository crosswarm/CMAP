/**
 * Task Ledger 的存储契约。
 *
 * 这是控制面账本的唯一写入面。设计上有三条硬约束，它们不是实现细节，
 * 而是契约的一部分——任何实现都必须满足，否则会退化成静默失败：
 *
 *  1. **状态迁移必须经守卫**。非法迁移抛错，不静默忽略。
 *  2. **状态与事件同事务**。事件是审计与复盘的唯一依据，状态变了而事件
 *     丢了，等于变更从未发生过——这正是 Transactional Outbox 要解决的。
 *  3. **写入即回读校验**。不信返回值。
 *
 * P1 用内存实现跑通；P4 换 PostgreSQL 时调用方代码不应改动。
 */

import { isDeepStrictEqual } from 'node:util'

import type { TaskResultV1 } from './generated/task-result.ts'
import type { TaskState } from './task-state.ts'
import type {
  Mission,
  MissionState,
  TaskRecord,
  TaskEvent,
  RemoteTaskBinding,
  EventType,
  EventActor,
  Approval,
  ResourceLock,
  Artifact,
  ArtifactEdge,
  Review,
} from './entities.ts'
import type { ApprovalDecisionInputV1 } from './generated/approval-decision-input.ts'

// ------------------------------------------------------------ 写入参数

export interface CreateMissionInput {
  readonly mission: Mission
  readonly actor: EventActor
}

export interface CreateTaskInput {
  readonly task: TaskRecord
  readonly actor: EventActor
  /** 因果链：本任务由哪个事件引发（如某次 rework 决策）。 */
  readonly causationId?: string | null
}

export interface TransitionTaskInput {
  readonly taskId: string
  readonly to: TaskState
  readonly actor: EventActor
  readonly eventType: EventType
  readonly payload?: Readonly<Record<string, unknown>>
  readonly causationId?: string | null
  /**
   * 事件去重键。重复投递（网络重试、Worker 重启）不得产生重复事件，
   * 也不得重复推进状态。
   */
  readonly idempotencyKey: string
  /**
   * 乐观并发：调用方认为的当前状态。与实际不符则抛 ConcurrentModificationError。
   * 省略表示不做检查（仅限确定无并发的场景）。
   */
  readonly expectedFrom?: TaskState
}

export interface ClaimTaskBindingInput {
  readonly taskId: string
  readonly binding: RemoteTaskBinding
  readonly actor: EventActor
}

export interface ClaimTaskBindingResult {
  readonly task: TaskRecord
  readonly claimed: boolean
}

export interface AppendEventInput {
  readonly event: Omit<TaskEvent, 'event_id' | 'lamport'>
}

// -------------------------------------------------------------- 查询

export interface TaskQuery {
  readonly missionId?: string
  readonly states?: readonly TaskState[]
  readonly capability?: string
  readonly limit?: number
}

export type { MissionQueryV1 as MissionQuery } from './generated/mission-query.ts'
import type { MissionQueryV1 as MissionQuery } from './generated/mission-query.ts'

// -------------------------------------------------------------- 错误

export class ConcurrentModificationError extends Error {
  readonly taskId: string
  readonly expected: TaskState
  readonly actual: TaskState

  constructor(taskId: string, expected: TaskState, actual: TaskState) {
    super(`任务 ${taskId} 已被并发修改：期望处于 ${expected}，实际 ${actual}`)
    this.name = 'ConcurrentModificationError'
    this.taskId = taskId
    this.expected = expected
    this.actual = actual
  }
}

export class NotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} 不存在：${id}`)
    this.name = 'NotFoundError'
  }
}

export class WriteVerificationError extends Error {
  constructor(kind: string, id: string, detail: string) {
    super(`${kind} ${id} 写入后回读校验失败：${detail}`)
    this.name = 'WriteVerificationError'
  }
}

/**
 * 同一 artifact_id 指向了不同的任务或不同的内容。
 *
 * Agent 爱把证据叫 `report` 这种大众名字，落到全局主键上就会撞车。
 * 静默处理的代价是「有结论没证据」，且两个实现静默的方式还可能不一样。
 */
export class ArtifactConflictError extends Error {
  constructor(artifactId: string, detail: string) {
    super(`证据 ${artifactId} 写入冲突：${detail}`)
    this.name = 'ArtifactConflictError'
  }
}

export class TaskConflictError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} 创建参数与既有记录不一致`)
    this.name = 'TaskConflictError'
  }
}

export class ReviewConflictError extends Error {
  constructor(reviewId: string) {
    super(`Review ${reviewId} 写入参数与既有记录不一致`)
    this.name = 'ReviewConflictError'
  }
}

export class EventConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(`Event ${idempotencyKey} 写入参数与既有记录不一致`)
    this.name = 'EventConflictError'
  }
}

export class BindingConflictError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} 已绑定到不同的远端任务`)
    this.name = 'BindingConflictError'
  }
}

const comparableTaskInput = (task: TaskRecord) => ({
  id: task.id,
  mission_id: task.mission_id,
  parent_task_id: task.parent_task_id,
  supersedes_task_id: task.supersedes_task_id,
  capability: task.capability,
  risk: task.risk,
  max_attempts: task.max_attempts,
  envelope: task.envelope,
  deps: task.deps,
})

export const assertSameTaskInput = (existing: TaskRecord, incoming: TaskRecord): void => {
  if (!isDeepStrictEqual(comparableTaskInput(existing), comparableTaskInput(incoming))) {
    throw new TaskConflictError(existing.id)
  }
}

const comparableReviewInput = (review: Review) => ({
  id: review.id,
  mission_id: review.mission_id,
  reviewed_task_ids: review.reviewed_task_ids,
  round: review.round,
  decision: review.decision,
})

export const assertSameReviewInput = (existing: Review, incoming: Review): void => {
  if (!isDeepStrictEqual(comparableReviewInput(existing), comparableReviewInput(incoming))) {
    throw new ReviewConflictError(existing.id)
  }
}

const comparableEventInput = (event: Omit<TaskEvent, 'event_id' | 'lamport'> | TaskEvent) => ({
  event_type: event.event_type,
  event_version: event.event_version,
  mission_id: event.mission_id,
  task_id: event.task_id,
  attempt: event.attempt,
  actor: {
    type: event.actor.type,
    id: event.actor.id,
    runner_id: event.actor.runner_id ?? null,
  },
  causation_id: event.causation_id,
  correlation_id: event.correlation_id,
  trace_id: event.trace_id,
  idempotency_key: event.idempotency_key,
  payload: event.payload,
})

export const assertSameEventInput = (
  existing: TaskEvent,
  incoming: Omit<TaskEvent, 'event_id' | 'lamport'>,
): void => {
  if (!isDeepStrictEqual(comparableEventInput(existing), comparableEventInput(incoming))) {
    throw new EventConflictError(existing.idempotency_key)
  }
}

export class LockUnavailableError extends Error {
  readonly resource: string
  readonly heldBy: string

  constructor(resource: string, heldBy: string) {
    super(`资源 ${resource} 已被任务 ${heldBy} 持有`)
    this.name = 'LockUnavailableError'
    this.resource = resource
    this.heldBy = heldBy
  }
}

// -------------------------------------------------------------- 接口

export interface Store {
  // Mission
  createMission(input: CreateMissionInput): Promise<Mission>
  getMission(id: string): Promise<Mission | null>
  queryMissions(q: MissionQuery): Promise<readonly Mission[]>
  setMissionState(
    id: string,
    state: MissionState,
    actor: EventActor,
    idempotencyKey?: string,
  ): Promise<Mission>

  // Task
  createTask(input: CreateTaskInput): Promise<TaskRecord>
  getTask(id: string): Promise<TaskRecord | null>
  /**
   * 推进状态。必须：校验迁移合法性 → 幂等去重 → 状态与事件同事务写入
   * → 回读校验。任一环节失败则整体回滚。
   */
  transitionTask(input: TransitionTaskInput): Promise<TaskRecord>
  claimTaskBinding(input: ClaimTaskBindingInput): Promise<ClaimTaskBindingResult>
  /**
   * 持久化 Agent 交回的归一化结果。
   *
   * 覆盖写入而非追加：Activity 超时重试会重新收取同一份结果，报错或写重复
   * 记录都会把「重试」变成「失败」。要保留历史用的是返工派生新 Task，不是
   * 在同一条记录上堆版本。
   */
  setTaskResult(taskId: string, result: TaskResultV1): Promise<TaskRecord>

  queryTasks(q: TaskQuery): Promise<readonly TaskRecord[]>

  // Event（Outbox）
  appendEvent(input: AppendEventInput): Promise<TaskEvent>
  /** 按 lamport 升序返回，保证跨主机可复现的顺序。 */
  listEvents(missionId: string): Promise<readonly TaskEvent[]>
  /** 本租户全部 Mission 的事件，一次查询；按 lamport、event_id 升序。租户事件流用，避免按 Mission 逐个查。 */
  listTenantEvents(tenant: string): Promise<readonly TaskEvent[]>

  // Artifact
  putArtifact(a: Artifact): Promise<Artifact>
  listArtifacts(taskId: string): Promise<readonly Artifact[]>
  /** 某 artifact 的全部出边。无血缘时返回空数组。 */
  listLineage(artifactId: string): Promise<readonly ArtifactEdge[]>

  // Review
  putReview(r: Review): Promise<Review>
  listReviews(missionId: string): Promise<readonly Review[]>

  // Approval
  createApproval(a: Approval): Promise<Approval>
  getApproval(id: string): Promise<Approval | null>
  decideApproval(
    id: string,
    decision: ApprovalDecisionInputV1['decision'],
    decidedBy: string,
    at: string,
  ): Promise<Approval>
  listPendingApprovals(missionId?: string): Promise<readonly Approval[]>

  // Resource Lock
  /** 已被他人持有且未过期时抛 LockUnavailableError；已过期的锁可被抢占。 */
  acquireLock(lock: ResourceLock): Promise<ResourceLock>
  /**
   * 续租。返回 false 表示锁已释放、已过期（期间是否被抢占已无法证明）或不存在。
   *
   * 这是哑资源（真机、YonWork、worktree）唯一可行的脑裂防线：它们无法
   * 校验 fencing token 并拒绝过期持有者，所以防线只能放在 runner 自己
   * 身上——续租失败即认定失锁，主动终止正在进行的操作。
   *
   * 因此本方法**必须如实返回失败**，静默成功会让 runner 误以为仍持有独占。
   */
  renewLock(lockId: string, newExpiresAt: string): Promise<boolean>

  releaseLock(lockId: string, at: string): Promise<void>
  listActiveLocks(now: string): Promise<readonly ResourceLock[]>

  /** 自检：能报出「进程活着但存储不可用」。 */
  healthCheck(): Promise<{ ok: boolean; detail?: string }>
}
