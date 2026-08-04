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
  TaskRecord,
  RemoteTaskBinding,
  EventActor,
  TaskEnvelopeV1,
} from '#domain-model'

const ACTOR: EventActor = { type: 'system', id: 'mission-workflow' }
const RUNNER_ID = process.env['RUNNER_ID'] ?? 'test-runner'

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
}

export interface CreateTaskOutput {
  readonly taskId: string
}

export interface DispatchOutput {
  /** true 表示本次真实派发；false 表示已有 binding，跳过。 */
  readonly dispatched: boolean
  readonly remoteTaskId: string
}

export const createActivities = (deps: ActivityDeps) => {
  const { store, dispatchRecorder } = deps

  let seq = 0
  /**
   * ID 生成必须在 Activity 侧。
   *
   * Workflow 代码要求确定性，禁用 Date.now() / Math.random()。若在
   * Workflow 里生成 id，重放会产生不同的值，账本出现孤儿记录。
   * Activity 的返回值被记入 Event History，重放时取缓存，因此安全。
   */
  const nextId = (prefix: string): string => {
    seq += 1
    return `${prefix}_${Date.now().toString(36)}_${String(seq).padStart(4, '0')}`
  }

  return {
    /** 创建任务并返回其 id。id 在此生成，Workflow 只负责传递。 */
    async createTask(input: CreateTaskInput): Promise<CreateTaskOutput> {
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
          success_definition: [
            { criterion_id: 'C1', metric: 'ok', operator: 'eq', expected: 1 },
          ],
        },
        environment: {},
        execution_policy: { timeout_seconds: 300, max_attempts: 1 },
        permissions: { forbidden: [] },
        evidence_requirements: { required_artifact_roles: ['report'] },
        output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
      } as TaskEnvelopeV1

      const task: TaskRecord = {
        id: taskId,
        mission_id: input.missionId,
        parent_task_id: null,
        supersedes_task_id: null,
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
      }

      await store.createTask({ task, actor: ACTOR })
      return { taskId }
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

    async setMissionState(input: { missionId: string; state: 'RUNNING' | 'COMPLETED' }): Promise<void> {
      await store.setMissionState(input.missionId, input.state, ACTOR)
    },
  }
}

export type Activities = ReturnType<typeof createActivities>
