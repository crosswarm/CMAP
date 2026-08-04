/**
 * Temporal Activity 实现。
 *
 * 所有副作用都在这里：写 Ledger、调 Adapter、生成 ID。
 * Workflow 侧只做确定性的流程推进。
 *
 * 本文件承载 ADR-0005 的三条规则：
 *  1. 幂等状态落库——派发前查 binding，不依赖进程内存
 *  2. ID 由 Activity 生成——Workflow 禁用随机与时间戳，重放需确定性
 *  3. 写 Ledger 与调 Adapter 合并为单个 Activity——跨 Activity 无事务保护
 */

import type {
  Store,
  RemoteTaskBinding,
  EventActor,
  EventType,
  TaskEnvelopeV1,
  ReviewDecisionV1,
  ProgressSnapshot,
} from '#domain-model'
import { detectNoProgress } from '#domain-model'

const ACTOR: EventActor = { type: 'system', id: 'mission-workflow' }
const RUNNER_ID = process.env['RUNNER_ID'] ?? 'test-runner'

/**
 * 锁 TTL。runner 须在此周期内续租，否则视为失锁并主动终止操作。
 *
 * 这是哑资源唯一可行的脑裂防线——真机、YonWork、worktree 都无法校验
 * fencing token 并拒绝过期持有者，所以防线只能放在 runner 自己身上。
 * 见 ADR-0004。
 */
const LOCK_TTL_MS = 90_000

/** 测试用的派发记录，便于断言 Adapter 被调用的次数。 */
export interface FakeDispatchRecord {
  readonly taskId: string
  readonly at: string
}

export interface ActivityDeps {
  readonly store: Store
  /** 提供时记录每次真实派发，用于测试断言。 */
  readonly dispatchRecorder?: FakeDispatchRecord[]
}

export interface CreateTaskInput {
  readonly missionId: string
  readonly capability: string
  readonly goal: string
  /** 返工时指向被取代的原任务，用于重建因果链。 */
  readonly supersedesTaskId?: string
}

export interface CreateTaskOutput {
  readonly taskId: string
}

export interface DispatchOutput {
  /** true 表示本次真实派发；false 表示已有 binding，跳过。 */
  readonly dispatched: boolean
  readonly remoteTaskId: string
}

export interface ApplyReviewInput {
  readonly taskId: string
  readonly decision: ReviewDecisionV1
  /** 当前是第几轮返工。0 表示首次评审。 */
  readonly round: number
  /** 上一轮的进展快照。与 currentProgress 同时提供才做无进展检测。 */
  readonly previousProgress?: ProgressSnapshot
  readonly currentProgress?: ProgressSnapshot
}

export interface ApplyReviewOutput {
  readonly outcome: 'accept' | 'rework' | 'escalated'
  readonly followupTaskIds: readonly string[]
  /** outcome 为 escalated 时说明为何停止，供人工介入时参考。 */
  readonly escalationReason?: string
}

export const createActivities = (deps: ActivityDeps) => {
  const { store, dispatchRecorder } = deps

  let seq = 0
  /**
   * 实例标识。多个 Activity 实例可能并存（Worker 重启、并发执行），
   * 各自的 seq 都从 0 开始——只靠时间戳加序号，同一毫秒内不同实例会
   * 生成相同的 id。加实例标识才能跨实例唯一。
   */
  const instanceTag = Math.random().toString(36).slice(2, 8)

  /**
   * ID 生成必须在 Activity 侧。
   *
   * Workflow 代码要求确定性，禁用 Date.now() / Math.random()。若在
   * Workflow 里生成 id，重放会产生不同的值，账本出现孤儿记录。
   * Activity 的返回值被记入 Event History，重放时取缓存，因此这里
   * 使用随机与时间戳都是安全的。
   */
  const nextId = (prefix: string): string => {
    seq += 1
    return `${prefix}_${Date.now().toString(36)}_${instanceTag}_${String(seq).padStart(4, '0')}`
  }

  return {
    /** 创建任务并返回其 id。id 在此生成，Workflow 只负责传递。 */
    async createTask(input: CreateTaskInput): Promise<CreateTaskOutput> {
      return createTaskInternal(input)
    },

    async markReady(taskId: string): Promise<void> {
      await store.transitionTask({
        taskId, to: 'READY', actor: ACTOR,
        eventType: 'TASK_READY', idempotencyKey: `ready:${taskId}`,
      })
    },

    /**
     * 派发：写 Ledger 与调 Adapter 在同一 Activity 内完成。
     *
     * 拆成两个 Activity 会留下「Adapter 已调用但 Ledger 未记录」的窗口，
     * 而跨 Activity 没有事务保护。合并后失败即整体标记失败。
     *
     * 幂等：先查 Ledger 中的 binding。Adapter 的内存缓存在 Worker 重启后
     * 失效，只有落库的 binding 才能让重试的 Activity 认出「已派发过」。
     */
    async dispatchTask(taskId: string): Promise<DispatchOutput> {
      const existing = await store.getTask(taskId)
      if (!existing) throw new Error(`任务不存在：${taskId}`)

      if (existing.binding) {
        // 已派发过——重试或重复执行时走到这里，不得再次调用 Adapter
        return { dispatched: false, remoteTaskId: existing.binding.remote_task_id }
      }

      await store.transitionTask({
        taskId, to: 'QUEUED', actor: ACTOR,
        eventType: 'TASK_ASSIGNED', idempotencyKey: `queued:${taskId}`,
      })

      const binding: RemoteTaskBinding = {
        adapter: 'codex-adapter',
        remote_task_id: `codex:${taskId}:1`,
        protocol: 'codex-exec',
        protocol_version: '0.1.0',
        runner_id: RUNNER_ID,
      }

      // 真实实现在此调用 adapter.startTask；测试注入 recorder 以断言调用次数。
      dispatchRecorder?.push({ taskId, at: new Date().toISOString() })

      // 先写库再返回：Activity 内部保证「调用与记录」不分离
      await store.setTaskBinding(taskId, binding)

      await store.transitionTask({
        taskId, to: 'RUNNING', actor: ACTOR,
        eventType: 'TASK_STARTED', idempotencyKey: `running:${taskId}`,
      })

      return { dispatched: true, remoteTaskId: binding.remote_task_id }
    },

    /**
     * 获取任务所需的独占资源锁。
     *
     * 拿不到锁**不是失败**——真机被占、租户被占都是正常排队。任务进入
     * WAITING_RESOURCE 等待，而非 FAILED_RETRYABLE：后者会消耗重试预算，
     * 且把「资源忙」误报成「执行出错」，掩盖真实原因。
     */
    async acquireTaskLock(input: {
      taskId: string
      resource: string
    }): Promise<{ acquired: boolean; lockId: string | null }> {
      const lockId = nextId('lk')
      const now = new Date()
      const acquiredAt = now.toISOString()
      const expiresAt = new Date(now.getTime() + LOCK_TTL_MS).toISOString()

      let t = await store.getTask(input.taskId)
      if (!t) throw new Error(`任务不存在：${input.taskId}`)

      // 申请资源本身就是排队的一部分：READY 表示依赖已满足但尚未入队，
      // 而状态机只允许从 QUEUED 进入 WAITING_RESOURCE。补上这一步使
      // 本 Activity 自洽，调用方不必记住这个前置条件。
      if (t.state === 'READY') {
        t = await store.transitionTask({
          taskId: input.taskId, to: 'QUEUED', actor: ACTOR,
          eventType: 'TASK_ASSIGNED',
          idempotencyKey: `queued-for-lock:${input.taskId}`,
        })
      }

      try {
        await store.acquireLock({
          lock_id: lockId,
          resource: input.resource,
          task_id: input.taskId,
          mission_id: t.mission_id,
          holder_runner_id: RUNNER_ID,
          acquired_at: acquiredAt,
          expires_at: expiresAt,
          released_at: null,
        })
      } catch (e) {
        if ((e as Error).name !== 'LockUnavailableError') throw e

        if (t.state !== 'WAITING_RESOURCE') {
          await store.transitionTask({
            taskId: input.taskId, to: 'WAITING_RESOURCE', actor: ACTOR,
            eventType: 'RESOURCE_LOCK_REQUESTED',
            idempotencyKey: `waiting:${input.taskId}:${input.resource}`,
            payload: { resource: input.resource },
          })
        }
        return { acquired: false, lockId: null }
      }

      // 拿到锁后回到运行态。从 WAITING_RESOURCE 与从 QUEUED 进入的路径不同，
      // 但都应落到 RUNNING。
      const cur = await store.getTask(input.taskId)
      if (cur && cur.state !== 'RUNNING') {
        await store.transitionTask({
          taskId: input.taskId, to: 'RUNNING', actor: ACTOR,
          eventType: 'RESOURCE_LOCK_ACQUIRED',
          idempotencyKey: `lock-acquired:${lockId}`,
          payload: { resource: input.resource, lock_id: lockId },
        })
      }

      return { acquired: true, lockId }
    },

    /**
     * 续租。返回 false 表示已失去独占——runner 应据此**主动终止操作**。
     *
     * 必须返回 false 而非抛错：抛错会让 Temporal 把它当作瞬时故障并重试，
     * 而失锁不是瞬时故障，重试也拿不回来。见 ADR-0004。
     */
    async renewTaskLock(lockId: string): Promise<boolean> {
      const newExpiry = new Date(Date.now() + LOCK_TTL_MS).toISOString()
      return store.renewLock(lockId, newExpiry)
    },

    async releaseTaskLock(lockId: string): Promise<void> {
      await store.releaseLock(lockId, new Date().toISOString())
    },

    /** 收取结果并推进到终态。此处简化为直接通过，真实实现会调 collectResult。 */
    async completeTask(taskId: string): Promise<void> {
      const t = await store.getTask(taskId)
      if (!t) throw new Error(`任务不存在：${taskId}`)
      if (t.state === 'COMPLETED') return

      for (const to of ['VERIFYING', 'REVIEWING', 'COMPLETED'] as const) {
        await store.transitionTask({
          taskId, to, actor: ACTOR,
          eventType: to === 'COMPLETED' ? 'TASK_COMPLETED' : 'TASK_STARTED',
          idempotencyKey: `${to.toLowerCase()}:${taskId}`,
        })
      }
    },

    async setMissionState(input: {
      missionId: string
      state: 'RUNNING' | 'COMPLETED' | 'ESCALATED'
    }): Promise<void> {
      await store.setMissionState(input.missionId, input.state, ACTOR)
    },

    /** 把任务推进到可评审状态。 */
    async beginReview(taskId: string): Promise<void> {
      const t = await store.getTask(taskId)
      if (!t) throw new Error(`任务不存在：${taskId}`)
      if (t.state === 'REVIEWING') return

      for (const to of ['VERIFYING', 'REVIEWING'] as const) {
        const cur = await store.getTask(taskId)
        if (cur?.state === to) continue
        await store.transitionTask({
          taskId, to, actor: ACTOR,
          eventType: to === 'VERIFYING' ? 'HARD_GATE_EVALUATED' : 'REVIEW_STARTED',
          idempotencyKey: `${to.toLowerCase()}:${taskId}`,
        })
      }
    },

    /**
     * 执行评审决策 —— 返工闭环的落点，也是最初痛点的解法。
     *
     * 把「不满意」从一句自然语言评论，变成控制面可直接执行的后继任务。
     *
     * 两道刹车，任一触发即升级给人：
     *  - 轮次达到 stop_conditions.max_additional_cycles（预算硬止损）
     *  - 无进展检测（每轮都在改但实际卡在原地）
     *
     * 返工一律**派生新 Task**，原任务落 COMPLETED。原地重跑会覆盖上一轮
     * 证据与因果链，那正是「反复返工却说不清第几轮卡在哪」的根源。
     */
    async applyReviewDecision(input: ApplyReviewInput): Promise<ApplyReviewOutput> {
      const { taskId, decision, round } = input

      const t = await store.getTask(taskId)
      if (!t) throw new Error(`任务不存在：${taskId}`)

      await store.putReview({
        id: nextId('rev'),
        mission_id: t.mission_id,
        reviewed_task_ids: [taskId],
        round,
        decision,
        created_at: new Date().toISOString(),
      })

      // accept：本任务收尾，不派生后继
      if (decision.decision === 'accept') {
        await finishTask(taskId, 'REVIEW_ACCEPTED')
        return { outcome: 'accept', followupTaskIds: [] }
      }

      if (decision.decision === 'escalate') {
        await finishTask(taskId, 'REVIEW_ESCALATED')
        await store.setMissionState(t.mission_id, 'ESCALATED', ACTOR)
        return {
          outcome: 'escalated',
          followupTaskIds: [],
          escalationReason: '评审者主动升级',
        }
      }

      // ---- decision === 'rework'：先过两道刹车 ----

      const maxCycles = decision.stop_conditions?.max_additional_cycles ?? 0
      if (round >= maxCycles) {
        const reason = `返工轮次已达上限（${round}/${maxCycles}），停止返工并升级`
        await escalate(taskId, t.mission_id, reason)
        return { outcome: 'escalated', followupTaskIds: [], escalationReason: reason }
      }

      if (input.previousProgress && input.currentProgress) {
        const np = detectNoProgress(input.previousProgress, input.currentProgress)
        if (np.detected) {
          const reason = `检测到无进展（${np.reasons.join('、')}），停止返工并升级`
          await escalate(taskId, t.mission_id, reason)
          return { outcome: 'escalated', followupTaskIds: [], escalationReason: reason }
        }
      }

      // ---- 派生后继任务 ----

      const followupTaskIds: string[] = []
      for (const f of decision.required_followups ?? []) {
        const { taskId: newId } = await createTaskInternal({
          missionId: t.mission_id,
          capability: f.capability,
          goal: `返工第 ${round + 1} 轮：${f.focus?.join('、') ?? f.task_type}`,
          supersedesTaskId: taskId,
        })
        followupTaskIds.push(newId)
      }

      await store.transitionTask({
        taskId, to: 'REWORK', actor: ACTOR,
        eventType: 'REVIEW_REWORK_REQUESTED',
        idempotencyKey: `rework:${taskId}:${round}`,
        payload: {
          round,
          failed_criteria: decision.failed_criteria?.map((c) => c.criterion_id) ?? [],
          followups: followupTaskIds,
        },
      })
      await store.transitionTask({
        taskId, to: 'COMPLETED', actor: ACTOR,
        eventType: 'TASK_COMPLETED',
        idempotencyKey: `rework-done:${taskId}:${round}`,
      })

      return { outcome: 'rework', followupTaskIds }
    },
  }

  // ------------------------------------------------------------ 内部

  async function finishTask(taskId: string, eventType: EventType): Promise<void> {
    const t = await store.getTask(taskId)
    if (!t || t.state === 'COMPLETED') return
    await store.transitionTask({
      taskId, to: 'COMPLETED', actor: ACTOR,
      eventType, idempotencyKey: `finish:${taskId}`,
    })
  }

  async function escalate(taskId: string, missionId: string, reason: string): Promise<void> {
    await store.transitionTask({
      taskId, to: 'REWORK', actor: ACTOR,
      eventType: 'REVIEW_ESCALATED',
      idempotencyKey: `escalate-rework:${taskId}`,
      payload: { reason },
    })
    await store.transitionTask({
      taskId, to: 'FAILED_TERMINAL', actor: ACTOR,
      eventType: 'MISSION_ESCALATED',
      idempotencyKey: `escalate-done:${taskId}`,
      payload: { reason },
    })
    await store.setMissionState(missionId, 'ESCALATED', ACTOR)
  }

  async function createTaskInternal(input: CreateTaskInput): Promise<CreateTaskOutput> {
    const taskId = nextId('tsk')
    const now = new Date().toISOString()

    const envelope = {
      schema: 'cmap/task-envelope/v1',
      identity: {
        mission_id: input.missionId,
        task_id: taskId,
        idempotency_key: `${input.missionId}:${taskId}`,
        revision: 1,
      },
      classification: {
        task_type: 'inspect',
        requested_capability: input.capability,
        risk_level: 'read-meta',
      },
      goal: {
        statement: input.goal,
        success_definition: [{ criterion_id: 'C1', metric: 'ok', operator: 'eq', expected: 1 }],
      },
      environment: {},
      execution_policy: { timeout_seconds: 300, max_attempts: 1 },
      permissions: { forbidden: [] },
      evidence_requirements: { required_artifact_roles: ['report'] },
      output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
    } as TaskEnvelopeV1

    await store.createTask({
      task: {
        id: taskId,
        mission_id: input.missionId,
        parent_task_id: null,
        supersedes_task_id: input.supersedesTaskId ?? null,
        capability: input.capability,
        risk: 'read-meta',
        state: 'DRAFT',
        attempt: 1,
        max_attempts: 1,
        lamport: 0,
        envelope,
        result: null,
        binding: null,
        deps: [],
        created_at: now,
        updated_at: now,
      },
      actor: ACTOR,
    })

    return { taskId }
  }
}

export type Activities = ReturnType<typeof createActivities>
