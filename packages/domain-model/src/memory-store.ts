/**
 * Store 的内存实现。
 *
 * 用于单测与本机开发。行为由 tests/domain/store-contract.ts 定义——
 * PostgreSQL 实现将跑同一套断言，契约由测试而非某个实现决定。
 *
 * 「同事务」在内存里的等价物是：先做全部校验，全部通过后才写；任一
 * 校验失败则一个字节都不落。顺序颠倒会留下「状态没变但事件已记」的
 * 脏数据，而审计流一旦失真就再也无法复盘。
 */

import { isDeepStrictEqual } from 'node:util'

import type { TaskResultV1 } from './generated/task-result.ts'
import { assertTransition, IllegalTransitionError } from './task-state.ts'
import type {
  Mission,
  MissionState,
  EventType,
  TaskRecord,
  TaskEvent,
  EventActor,
  RemoteTaskBinding,
  Approval,
  ResourceLock,
  Artifact,
  ArtifactEdge,
  Review,
} from './entities.ts'
import type {
  Store,
  CreateMissionInput,
  CreateTaskInput,
  TransitionTaskInput,
  AppendEventInput,
  MissionQuery,
  TaskQuery,
  ClaimTaskBindingInput,
  ClaimTaskBindingResult,
} from './store.ts'
import type { ApprovalDecisionInputV1 } from './generated/approval-decision-input.ts'
import { decideApprovalState } from './approval-state.ts'
import { assertSameMissionInput } from './mission-input.ts'
import {
  ArtifactConflictError,
  BindingConflictError,
  ConcurrentModificationError,
  NotFoundError,
  WriteVerificationError,
  LockUnavailableError,
  assertSameEventInput,
  assertSameReviewInput,
  assertSameTaskInput,
} from './store.ts'

const missionEventType = (state: MissionState): EventType => {
  switch (state) {
    case 'COMPLETED':
      return 'MISSION_COMPLETED'
    case 'ESCALATED':
      return 'MISSION_ESCALATED'
    case 'FAILED':
      return 'MISSION_FAILED'
    default:
      return 'MISSION_STATE_CHANGED'
  }
}

const cloneTask = (task: TaskRecord): TaskRecord => structuredClone(task) as TaskRecord
const cloneEvent = (event: TaskEvent): TaskEvent => structuredClone(event) as TaskEvent
const cloneReview = (review: Review): Review => structuredClone(review) as Review

export class MemoryStore implements Store {
  readonly #missions = new Map<string, Mission>()
  readonly #tasks = new Map<string, TaskRecord>()
  readonly #events: TaskEvent[] = []
  readonly #artifacts = new Map<string, Artifact>()
  readonly #edges: ArtifactEdge[] = []
  readonly #reviews: Review[] = []
  readonly #approvals = new Map<string, Approval>()
  readonly #locks = new Map<string, ResourceLock>()
  readonly #delivered = new Set<string>()
  /** idempotencyKey → 已产生的 event_id，用于重复投递去重 */
  readonly #seenKeys = new Map<string, string>()

  #lamport = 0
  #seq = 0

  #nextLamport(): number {
    this.#lamport += 1
    return this.#lamport
  }

  #nextId(prefix: string): string {
    this.#seq += 1
    return `${prefix}_${String(this.#seq).padStart(6, '0')}`
  }

  #record(
    missionId: string,
    taskId: string | null,
    eventType: TaskEvent['event_type'],
    actor: EventActor,
    idempotencyKey: string,
    payload: Readonly<Record<string, unknown>> = {},
    causationId: string | null = null,
  ): TaskEvent {
    const event: TaskEvent = {
      event_id: this.#nextId('evt'),
      event_type: eventType,
      event_version: 1,
      occurred_at: new Date().toISOString(),
      mission_id: missionId,
      task_id: taskId,
      attempt: null,
      actor: structuredClone(actor),
      causation_id: causationId,
      correlation_id: missionId,
      trace_id: null,
      lamport: this.#nextLamport(),
      idempotency_key: idempotencyKey,
      payload: structuredClone(payload),
    }
    this.#events.push(event)
    this.#seenKeys.set(idempotencyKey, event.event_id)
    return cloneEvent(event)
  }

  // ---------------------------------------------------------- Mission

  async createMission(input: CreateMissionInput): Promise<Mission> {
    const m = { ...input.mission }
    const existing = this.#missions.get(m.id)
    if (existing) {
      assertSameMissionInput(existing, m)
      return existing
    }

    this.#missions.set(m.id, m)
    this.#record(m.id, null, 'MISSION_CREATED', input.actor, `mission-created:${m.id}`)

    // 写入即回读校验：不信写入本身
    const back = this.#missions.get(m.id)
    if (!back || back.id !== m.id) {
      throw new WriteVerificationError('Mission', m.id, '回读为空或 id 不符')
    }
    return back
  }

  async getMission(id: string): Promise<Mission | null> {
    return this.#missions.get(id) ?? null
  }

  async queryMissions(q: MissionQuery): Promise<readonly Mission[]> {
    return [...this.#missions.values()]
      .filter((m) => m.tenant === q.tenant)
      .sort((a, b) => {
        const byCreatedAt = Date.parse(a.created_at) - Date.parse(b.created_at)
        if (byCreatedAt !== 0) return byCreatedAt
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
  }

  async setMissionState(
    id: string,
    state: MissionState,
    actor: EventActor,
    idempotencyKey?: string,
  ): Promise<Mission> {
    const m = this.#missions.get(id)
    if (!m) throw new NotFoundError('Mission', id)
    if (m.state === state) return m

    const next: Mission = { ...m, state, updated_at: new Date().toISOString() }
    this.#missions.set(id, next)
    this.#record(
      id, null,
      missionEventType(state),
      actor,
      idempotencyKey ?? `mission-state:${id}:${m.state}->${state}`,
      { from: m.state, state },
    )

    const back = this.#missions.get(id)
    if (back?.state !== state) {
      throw new WriteVerificationError('Mission', id, `回读状态为 ${back?.state}`)
    }
    return back
  }

  // ------------------------------------------------------------- Task

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const t = cloneTask(input.task)
    const existing = this.#tasks.get(t.id)
    if (existing) {
      assertSameTaskInput(existing, t)
      return cloneTask(existing)
    }

    this.#tasks.set(t.id, t)
    this.#record(
      t.mission_id, t.id, 'TASK_CREATED', input.actor,
      `task-created:${t.id}`, { capability: t.capability, risk: t.risk },
      input.causationId ?? null,
    )

    const back = this.#tasks.get(t.id)
    if (!back || back.id !== t.id) {
      throw new WriteVerificationError('Task', t.id, '回读为空或 id 不符')
    }
    return cloneTask(back)
  }

  async getTask(id: string): Promise<TaskRecord | null> {
    const task = this.#tasks.get(id)
    return task ? cloneTask(task) : null
  }

  async transitionTask(input: TransitionTaskInput): Promise<TaskRecord> {
    // ── 阶段一：全部校验。任一失败则一个字节都不写 ──

    // 幂等去重放在最前：重复投递应直接返回当前状态，
    // 既不重复推进，也不因「当前状态已是目标态」而误判为非法迁移。
    if (this.#seenKeys.has(input.idempotencyKey)) {
      const existing = this.#tasks.get(input.taskId)
      if (!existing) throw new NotFoundError('Task', input.taskId)
      return cloneTask(existing)
    }

    const t = this.#tasks.get(input.taskId)
    if (!t) throw new NotFoundError('Task', input.taskId)

    if (input.expectedFrom !== undefined && t.state !== input.expectedFrom) {
      throw new ConcurrentModificationError(input.taskId, input.expectedFrom, t.state)
    }

    // 非法迁移在此抛出，此时尚未写入任何事件
    assertTransition(t.state, input.to)

    // ── 阶段二：提交。状态与事件一起落 ──

    const next: TaskRecord = {
      ...t,
      state: input.to,
      lamport: this.#lamport + 1,
      updated_at: new Date().toISOString(),
    }
    this.#tasks.set(t.id, next)
    this.#record(
      t.mission_id, t.id, input.eventType, input.actor,
      input.idempotencyKey, { from: t.state, to: input.to, ...(input.payload ?? {}) },
      input.causationId ?? null,
    )

    const back = this.#tasks.get(t.id)
    if (back?.state !== input.to) {
      throw new WriteVerificationError('Task', t.id, `回读状态为 ${back?.state}`)
    }
    return cloneTask(back)
  }

  async setTaskBinding(taskId: string, binding: RemoteTaskBinding): Promise<TaskRecord> {
    const t = this.#tasks.get(taskId)
    if (!t) throw new NotFoundError('Task', taskId)

    const next: TaskRecord = { ...t, binding: structuredClone(binding), updated_at: new Date().toISOString() }
    this.#tasks.set(taskId, next)

    const back = this.#tasks.get(taskId)
    if (back?.binding?.remote_task_id !== binding.remote_task_id) {
      throw new WriteVerificationError('Task', taskId, 'binding 回读不符')
    }
    return cloneTask(back)
  }

  async claimTaskBinding(input: ClaimTaskBindingInput): Promise<ClaimTaskBindingResult> {
    const t = this.#tasks.get(input.taskId)
    if (!t) throw new NotFoundError('Task', input.taskId)

    if (t.binding) {
      if (isDeepStrictEqual(t.binding, input.binding)) {
        return { task: cloneTask(t), claimed: false }
      }
      throw new BindingConflictError(input.taskId)
    }
    if (t.state !== 'QUEUED' && t.state !== 'WAITING_RESOURCE') {
      throw new IllegalTransitionError(t.state, 'RUNNING')
    }

    const next: TaskRecord = {
      ...t,
      state: 'RUNNING',
      binding: structuredClone(input.binding),
      lamport: this.#lamport + 1,
      updated_at: new Date().toISOString(),
    }
    this.#tasks.set(t.id, next)
    this.#record(
      t.mission_id, t.id, 'TASK_DISPATCH_INTENT', input.actor,
      `task-dispatch-intent:${t.id}:${input.binding.adapter}:${input.binding.remote_task_id}`,
      { from: t.state, to: 'RUNNING', binding: input.binding },
    )

    const back = this.#tasks.get(t.id)
    if (back?.state !== 'RUNNING' || !isDeepStrictEqual(back.binding, input.binding)) {
      throw new WriteVerificationError('Task', t.id, 'claim binding 回读不符')
    }
    return { task: cloneTask(back), claimed: true }
  }

  async setTaskResult(taskId: string, result: TaskResultV1): Promise<TaskRecord> {
    const t = this.#tasks.get(taskId)
    if (!t) throw new NotFoundError('Task', taskId)

    const next: TaskRecord = { ...t, result: structuredClone(result), updated_at: new Date().toISOString() }
    this.#tasks.set(taskId, next)

    const back = this.#tasks.get(taskId)
    if (back?.result?.status !== result.status) {
      throw new WriteVerificationError('Task', taskId, 'result 回读不符')
    }
    return cloneTask(back)
  }

  async queryTasks(q: TaskQuery): Promise<readonly TaskRecord[]> {
    let out = [...this.#tasks.values()]
    if (q.missionId) out = out.filter((t) => t.mission_id === q.missionId)
    if (q.states) out = out.filter((t) => q.states!.includes(t.state))
    if (q.capability) out = out.filter((t) => t.capability === q.capability)
    return (q.limit ? out.slice(0, q.limit) : out).map(cloneTask)
  }

  async findReadyTasks(missionId: string): Promise<readonly TaskRecord[]> {
    const all = [...this.#tasks.values()].filter((t) => t.mission_id === missionId)
    const byId = new Map(all.map((t) => [t.id, t]))

    return all.filter((t) => {
      if (t.state !== 'READY') return false
      // 依赖必须全部 COMPLETED。缺失的依赖视为未满足——
      // 宁可不调度，也不能在依赖缺失的情况下执行。
      return t.deps.every((d) => byId.get(d)?.state === 'COMPLETED')
    }).map(cloneTask)
  }

  // ------------------------------------------------------------ Event

  async appendEvent(input: AppendEventInput): Promise<TaskEvent> {
    const existingId = this.#seenKeys.get(input.event.idempotency_key)
    if (existingId) {
      const found = this.#events.find((e) => e.event_id === existingId)
      if (found) {
        assertSameEventInput(found, input.event)
        return cloneEvent(found)
      }
    }

    const event: TaskEvent = {
      ...structuredClone(input.event),
      event_id: this.#nextId('evt'),
      lamport: this.#nextLamport(),
    }
    this.#events.push(event)
    this.#seenKeys.set(event.idempotency_key, event.event_id)
    return cloneEvent(event)
  }

  async listEvents(missionId: string): Promise<readonly TaskEvent[]> {
    return this.#events
      .filter((e) => e.mission_id === missionId)
      .sort((a, b) => a.lamport - b.lamport)
      .map(cloneEvent)
  }

  async listUndeliveredEvents(limit: number): Promise<readonly TaskEvent[]> {
    return this.#events
      .filter((e) => !this.#delivered.has(e.event_id))
      .sort((a, b) => a.lamport - b.lamport)
      .slice(0, limit)
      .map(cloneEvent)
  }

  async markEventDelivered(eventId: string): Promise<void> {
    this.#delivered.add(eventId)
  }

  // --------------------------------------------------------- Artifact

  async putArtifact(a: Artifact): Promise<Artifact> {
    const prev = this.#artifacts.get(a.artifact_id)
    if (prev && (prev.task_id !== a.task_id || prev.sha256 !== a.sha256)) {
      throw new ArtifactConflictError(
        a.artifact_id,
        `已属于任务 ${prev.task_id}（sha256 ${prev.sha256.slice(0, 12)}…），` +
          `不能改指任务 ${a.task_id}`,
      )
    }
    this.#artifacts.set(a.artifact_id, a)
    return a
  }

  async listArtifacts(taskId: string): Promise<readonly Artifact[]> {
    return [...this.#artifacts.values()].filter((a) => a.task_id === taskId)
  }

  async linkArtifacts(edge: ArtifactEdge): Promise<void> {
    // PG 靠外键约束保证两端存在，内存版必须显式校验，否则两个实现
    // 行为不一致：一边拒绝悬空边，另一边默默写入。
    for (const id of [edge.source_artifact_id, edge.target_artifact_id]) {
      if (!this.#artifacts.has(id)) throw new NotFoundError('Artifact', id)
    }
    this.#edges.push({ ...edge })
  }

  async listLineage(artifactId: string): Promise<readonly ArtifactEdge[]> {
    return this.#edges.filter((e) => e.source_artifact_id === artifactId)
  }

  // ----------------------------------------------------------- Review

  async putReview(r: Review): Promise<Review> {
    const review = cloneReview(r)
    const existing = this.#reviews.find((review) => review.id === r.id)
    if (existing) {
      assertSameReviewInput(existing, review)
      return cloneReview(existing)
    }

    this.#reviews.push(review)
    return cloneReview(review)
  }

  async listReviews(missionId: string): Promise<readonly Review[]> {
    // 必须按 round 排序，与 PG 版的 ORDER BY round 保持一致。
    // 返工追踪依赖轮次顺序：按插入顺序返回会让「第几轮卡在哪」失真。
    return this.#reviews
      .filter((r) => r.mission_id === missionId)
      .sort((a, b) => a.round - b.round)
      .map(cloneReview)
  }

  // --------------------------------------------------------- Approval

  async createApproval(a: Approval): Promise<Approval> {
    const existing = this.#approvals.get(a.id)
    if (existing) return existing
    this.#approvals.set(a.id, { ...a })
    return a
  }

  async getApproval(id: string): Promise<Approval | null> {
    return this.#approvals.get(id) ?? null
  }

  async decideApproval(
    id: string,
    decision: ApprovalDecisionInputV1['decision'],
    decidedBy: string,
    at: string,
  ): Promise<Approval> {
    const a = this.#approvals.get(id)
    if (!a) throw new NotFoundError('Approval', id)

    const next = decideApprovalState(a, { decision, decided_by: decidedBy, at })
    this.#approvals.set(id, next)

    const back = this.#approvals.get(id)
    if (back?.decision !== decision || back.decided_by !== decidedBy) {
      throw new WriteVerificationError('Approval', id, '回读与写入不符')
    }
    return back
  }

  async listPendingApprovals(missionId?: string): Promise<readonly Approval[]> {
    return [...this.#approvals.values()].filter(
      (a) => a.decision === 'pending' && (!missionId || a.mission_id === missionId),
    )
  }

  // ----------------------------------------------------- Resource Lock

  async acquireLock(lock: ResourceLock): Promise<ResourceLock> {
    // 与 PG 的 locks_ttl_positive CHECK 约束保持一致：
    // 一诞生就过期的锁等于无锁，接受它会让调用方误以为拿到了独占。
    if (Date.parse(lock.expires_at) <= Date.parse(lock.acquired_at)) {
      throw new RangeError(
        `锁 ${lock.lock_id} 的 TTL 非正：expires_at(${lock.expires_at}) 不晚于 acquired_at(${lock.acquired_at})`,
      )
    }

    const now = Date.now()
    const holder = [...this.#locks.values()].find(
      (l) =>
        l.resource === lock.resource &&
        l.released_at === null &&
        // 过期锁可被抢占——runner 崩溃不得永久占住真机
        Date.parse(l.expires_at) > now,
    )
    if (holder) throw new LockUnavailableError(lock.resource, holder.task_id)

    this.#locks.set(lock.lock_id, { ...lock })
    return lock
  }

  async renewLock(lockId: string, newExpiresAt: string): Promise<boolean> {
    const l = this.#locks.get(lockId)
    if (!l || l.released_at !== null) return false

    // 已过期且资源已被他人持有 → 续租失败。
    // 这是 runner 必须终止操作的信号，不能静默成功。
    const now = Date.now()
    if (Date.parse(l.expires_at) <= now) {
      const taken = [...this.#locks.values()].some(
        (o) =>
          o.lock_id !== lockId &&
          o.resource === l.resource &&
          o.released_at === null &&
          Date.parse(o.expires_at) > now,
      )
      if (taken) return false
    }

    this.#locks.set(lockId, { ...l, expires_at: newExpiresAt })
    return true
  }

  async releaseLock(lockId: string, at: string): Promise<void> {
    const l = this.#locks.get(lockId)
    if (!l) throw new NotFoundError('ResourceLock', lockId)
    this.#locks.set(lockId, { ...l, released_at: at })
  }

  async listActiveLocks(now: string): Promise<readonly ResourceLock[]> {
    const t = Date.parse(now)
    return [...this.#locks.values()].filter(
      (l) => l.released_at === null && Date.parse(l.expires_at) > t,
    )
  }

  // ------------------------------------------------------------ 自检

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: `missions=${this.#missions.size} tasks=${this.#tasks.size}` }
  }
}
