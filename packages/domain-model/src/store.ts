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

import type { TaskState } from './task-state.ts'
import type {
  Mission,
  MissionState,
  TaskRecord,
  TaskEvent,
  EventType,
  EventActor,
  Approval,
  ApprovalDecision,
  ResourceLock,
  Artifact,
  Review,
} from './entities.ts'

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
  setMissionState(id: string, state: MissionState, actor: EventActor): Promise<Mission>

  // Task
  createTask(input: CreateTaskInput): Promise<TaskRecord>
  getTask(id: string): Promise<TaskRecord | null>
  /**
   * 推进状态。必须：校验迁移合法性 → 幂等去重 → 状态与事件同事务写入
   * → 回读校验。任一环节失败则整体回滚。
   */
  transitionTask(input: TransitionTaskInput): Promise<TaskRecord>
  queryTasks(q: TaskQuery): Promise<readonly TaskRecord[]>
  /**
   * 就绪任务：状态为 READY 且所有 deps 均已 COMPLETED。
   * 依赖未完成或已失败的任务不得被返回——否则会在依赖缺失的情况下执行。
   */
  findReadyTasks(missionId: string): Promise<readonly TaskRecord[]>

  // Event（Outbox）
  appendEvent(input: AppendEventInput): Promise<TaskEvent>
  /** 按 lamport 升序返回，保证跨主机可复现的顺序。 */
  listEvents(missionId: string): Promise<readonly TaskEvent[]>
  /** 尚未投递到外部总线的事件。投递成功后由调用方标记。 */
  listUndeliveredEvents(limit: number): Promise<readonly TaskEvent[]>
  markEventDelivered(eventId: string): Promise<void>

  // Artifact
  putArtifact(a: Artifact): Promise<Artifact>
  listArtifacts(taskId: string): Promise<readonly Artifact[]>

  // Review
  putReview(r: Review): Promise<Review>
  listReviews(missionId: string): Promise<readonly Review[]>

  // Approval
  createApproval(a: Approval): Promise<Approval>
  decideApproval(
    id: string,
    decision: ApprovalDecision,
    decidedBy: string,
    at: string,
  ): Promise<Approval>
  listPendingApprovals(missionId?: string): Promise<readonly Approval[]>

  // Resource Lock
  /** 已被他人持有且未过期时抛 LockUnavailableError；已过期的锁可被抢占。 */
  acquireLock(lock: ResourceLock): Promise<ResourceLock>
  releaseLock(lockId: string, at: string): Promise<void>
  listActiveLocks(now: string): Promise<readonly ResourceLock[]>

  /** 自检：能报出「进程活着但存储不可用」。 */
  healthCheck(): Promise<{ ok: boolean; detail?: string }>
}
