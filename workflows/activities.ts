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

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { Context } from '@temporalio/activity'

import type {
  Store,
  Artifact,
  EventActor,
  EventType,
  TaskEnvelopeV1,
  TaskResultV1,
  ReviewDecisionV1,
  ProgressSnapshot,
} from '#domain-model'
import { detectNoProgress } from '#domain-model'
import type { AgentAdapter } from '#adapter-sdk'

/**
 * Activity 心跳。在真实 Temporal 上下文外（单测直接调用）会抛错，忽略即可——
 * 心跳只对 Temporal 有意义，不该成为单测必须搭起 Worker 的理由。
 */
const heartbeat = (): void => {
  try {
    Context.current().heartbeat()
  } catch {
    /* 非 Activity 上下文 */
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 逐条比对信封声明的验收标准与 Agent 的回应。
 *
 * 漏答等同未通过：只看 status 会让「干完了但没答标准」被当成成功，
 * 那正是无证据即失败要防的情形。
 */
const judge = (envelope: TaskEnvelopeV1, result: TaskResultV1): CollectOutput => {
  const answered = new Map(result.criterion_results.map((c) => [c.criterion_id, c.passed]))
  const failedCriteria = (envelope.goal.success_definition ?? [])
    .map((c) => c.criterion_id)
    .filter((id) => answered.get(id) !== true)

  return {
    status: result.status,
    passed: result.status === 'completed' && failedCriteria.length === 0,
    failedCriteria,
    summary: result.summary,
  }
}

const ACTOR: EventActor = { type: 'system', id: 'mission-workflow' }
const DEFAULT_RUNNER_ID = process.env['RUNNER_ID'] ?? 'local-dev'
/** 默认返工预算。绝不无限重试——耗尽即升级给人。 */
const DEFAULT_MAX_CYCLES = 2

/** 证据保留期。到期前不得覆盖，否则结论无法复核。 */
const RETENTION_MS = 365 * 24 * 3600 * 1000

/**
 * 锁 TTL。runner 须在此周期内续租，否则视为失锁并主动终止操作。
 *
 * 这是哑资源唯一可行的脑裂防线——真机、YonWork、worktree 都无法校验
 * fencing token 并拒绝过期持有者，所以防线只能放在 runner 自己身上。
 * 见 ADR-0004。
 */
const LOCK_TTL_MS = 90_000

export interface ActivityDeps {
  readonly store: Store
  /**
   * 派发目标。不注入则无法派发——宁可明确报错，也不要让 Workflow 跑出
   * 一条「任务已 RUNNING」却根本没人干活的绿色轨迹。
   */
  readonly adapter?: AgentAdapter
  readonly runnerId?: string
  /**
   * 工作目录根。每个任务分一个子目录，避免并发任务互相污染。
   * 不给则由 Adapter 自建临时目录。
   *
   * 注意工作目录是 **runner 侧的选择**，不进信封：信封里放本机绝对路径
   * 会让同一个任务无法在另一台机器上执行。
   */
  readonly workRoot?: string
  /** 轮询 Agent 状态的间隔。测试用极小值，生产用默认。 */
  readonly pollIntervalMs?: number
  /** 等待终态的上限。默认取信封的 execution_policy.timeout_seconds。 */
  readonly waitTimeoutMs?: number
}

export interface CreateTaskInput {
  readonly missionId: string
  readonly capability: string
  /** 缺省则用 Mission 的目标。返工派生的子任务才需要单独措辞。 */
  readonly goal?: string
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

export interface HardGateInput {
  readonly taskId: string
  /** 当前是第几轮返工。0 表示首轮。 */
  readonly round: number
}

export interface HardGateOutput {
  readonly decision: ReviewDecisionV1
  /** 本轮进展快照，供下一轮做无进展检测。 */
  readonly progress: ProgressSnapshot
}

export interface CollectOutput {
  readonly status: TaskResultV1['status']
  /** 全部验收标准都被逐条回应且通过，才为 true。 */
  readonly passed: boolean
  /** 未通过或 Agent 压根没回应的标准。沉默不算通过。 */
  readonly failedCriteria: readonly string[]
  readonly summary: string
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
  const { store, adapter, workRoot } = deps
  const runnerId = deps.runnerId ?? DEFAULT_RUNNER_ID
  const pollIntervalMs = deps.pollIntervalMs ?? 2_000

  const requireAdapter = (): AgentAdapter => {
    if (!adapter) {
      throw new Error(
        '未注入 Adapter：控制面没有可派发的目标。Worker 启动时须传入 adapter。',
      )
    }
    return adapter
  }

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

      const envelope = existing.envelope as TaskEnvelopeV1
      const timeoutMs = (envelope.execution_policy?.timeout_seconds ?? 300) * 1000

      // 工作目录由 runner 侧准备。不存在时 spawn 会直接失败，
      // 而失败信息指向 codex 而不是这里，很难查。
      const worktree = workRoot ? join(workRoot, taskId) : null
      if (worktree) await mkdir(worktree, { recursive: true })

      const binding = await requireAdapter().startTask(envelope, {
        // P4 接入鉴权后换成短期、受众绑定的令牌。现在是本机单租户，
        // 但字段先占住位置，免得那时才发现调用方根本没有令牌可传。
        token: process.env['CMAP_RUNNER_TOKEN'] ?? 'local-dev-token',
        runner_id: runnerId,
        trace_id: taskId,
        correlation_id: envelope.identity.idempotency_key,
        ...(worktree ? { worktree } : {}),
        deadline_at: new Date(Date.now() + timeoutMs).toISOString(),
      })

      // 先写库再返回：Activity 内部保证「调用与记录」不分离。
      // 顺序反过来的话，进程在这两步之间崩溃就会留下一个已在跑、
      // 账本却不知道的 Agent 进程——重试会再 spawn 一个。
      await store.setTaskBinding(taskId, binding)

      await store.transitionTask({
        taskId, to: 'RUNNING', actor: ACTOR,
        eventType: 'TASK_STARTED', idempotencyKey: `running:${taskId}`,
      })

      return { dispatched: true, remoteTaskId: binding.remote_task_id }
    },

    /**
     * 等 Agent 干完，收结果，落账本。
     *
     * 三条规则：
     *  1. **等到终态才算完**。进程还在跑就收结果，拿到的是半成品。
     *  2. **身份字段由控制面填充**。Agent 自报的 mission_id / task_id 一律覆盖——
     *     账本归控制面所有，Agent 说自己是谁不作数。
     *  3. **沉默不是通过**。信封声明的验收标准若没被逐条回应，视为未通过。
     *
     * 已有结果直接返回：Activity 超时重跑是常态，重复收取不得产生重复证据。
     */
    async collectTaskResult(taskId: string): Promise<CollectOutput> {
      const t = await store.getTask(taskId)
      if (!t) throw new Error(`任务不存在：${taskId}`)

      const envelope = t.envelope as TaskEnvelopeV1
      if (t.result) return judge(envelope, t.result)

      if (!t.binding) throw new Error(`任务 ${taskId} 尚未派发，无结果可收`)
      const a = requireAdapter()

      const waitMs =
        deps.waitTimeoutMs ?? (envelope.execution_policy?.timeout_seconds ?? 300) * 1000
      const deadline = Date.now() + waitMs

      // 轮询至终态。显式超时：宁可明确失败，也不要静默挂起——
      // 卡住而无日志比失败难查得多。
      for (;;) {
        const status = await a.getStatus(t.binding)
        if (status.terminal_observed) break
        if (Date.now() > deadline) {
          await a.cancel(t.binding, `等待终态超时（${waitMs}ms）`)
          throw new Error(
            `等待任务 ${taskId} 终态超时（${waitMs}ms），最后状态 ${status.status}`,
          )
        }
        heartbeat()
        await sleep(pollIntervalMs)
      }

      const raw = await a.collectResult(t.binding)

      // Agent 自报的 artifact_id 只是它自己的叫法，实测常是 `report` 这种
      // 大众名字——落到账本的全局主键上，第二个任务就会跟第一个撞车。
      // 控制面按「任务 + 角色」重新命名，并把结论里的证据引用一起改写，
      // 否则「这条结论基于哪些证据」在账本里就断了。
      const ledgerIds = new Map<string, string>()
      const used = new Set<string>()
      raw.artifacts.forEach((art, i) => {
        let id = `${taskId}:${art.role}`
        if (used.has(id)) id = `${taskId}:${art.role}:${i}`
        used.add(id)
        ledgerIds.set(art.artifact_id, id)
      })

      const result: TaskResultV1 = {
        ...raw,
        mission_id: t.mission_id,
        task_id: taskId,
        attempt: t.attempt,
        artifacts: raw.artifacts.map((art) => ({
          ...art,
          artifact_id: ledgerIds.get(art.artifact_id) ?? art.artifact_id,
        })),
        criterion_results: raw.criterion_results.map((c) => ({
          ...c,
          ...(c.evidence_artifact_ids
            ? {
                evidence_artifact_ids: c.evidence_artifact_ids.map(
                  (x) => ledgerIds.get(x) ?? x,
                ),
              }
            : {}),
        })),
      }
      await store.setTaskResult(taskId, result)

      // 证据落库。已存在的不重写——重复收取会生成重复记录，
      // 让「这个结论基于哪些证据」多出几条同名副本。
      const seen = new Set((await store.listArtifacts(taskId)).map((x) => x.artifact_id))
      const now = new Date()
      for (const art of result.artifacts) {
        if (seen.has(art.artifact_id)) continue
        const record: Artifact = {
          artifact_id: art.artifact_id,
          mission_id: t.mission_id,
          task_id: taskId,
          role: art.role,
          uri: art.uri,
          media_type: art.media_type ?? 'application/octet-stream',
          size_bytes: art.size_bytes ?? 0,
          sha256: art.sha256,
          version: 1,
          state: 'AVAILABLE',
          producer: {
            agent_id: a.agentId,
            adapter_version: t.binding.protocol_version,
            execution_session_id:
              result.session?.provider_session_id ?? t.binding.remote_task_id,
          },
          provenance: { runner_id: t.binding.runner_id },
          retention: {
            retain_until: new Date(now.getTime() + RETENTION_MS).toISOString(),
            immutable: true,
          },
          security: {
            classification: 'internal',
            contains_secrets: false,
            contains_pii: false,
            allowed_roles: [],
          },
          created_at: now.toISOString(),
        }
        await store.putArtifact(record)
      }

      return judge(envelope, result)
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
          holder_runner_id: runnerId,
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

    /**
     * 进入硬门槛判定态。
     *
     * 独立成一步是为了让事件流读得出「验收发生过」——判定结果无论
     * 通过与否，这一步都留痕。
     */
    async markVerifying(taskId: string): Promise<void> {
      const t = await store.getTask(taskId)
      if (!t) throw new Error(`任务不存在：${taskId}`)
      if (t.state === 'VERIFYING') return

      await store.transitionTask({
        taskId, to: 'VERIFYING', actor: ACTOR,
        eventType: 'HARD_GATE_EVALUATED',
        idempotencyKey: `verifying:${taskId}`,
      })
    },

    async setMissionState(input: {
      missionId: string
      state: 'RUNNING' | 'COMPLETED' | 'ESCALATED' | 'FAILED'
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
     * 硬门槛判定：把「验收没过」变成控制面可直接执行的返工决策。
     *
     * 刻意**不用 LLM**。验收标准本来就是机读的，比一比就有答案；让模型回答
     * 「过没过」得到的是主观判断，既不可复现也无法审计，且模型倾向于报告
     * 乐观结果。软判断（Claude 评审）可以覆盖在这之上，但不得推翻硬指标。
     *
     * 放在 Activity 而非 Workflow：要读账本。判定本身是纯函数，
     * 同一份结果判几次都是同一个结论。
     */
    async evaluateHardGate(input: HardGateInput): Promise<HardGateOutput> {
      const t = await store.getTask(input.taskId)
      if (!t) throw new Error(`任务不存在：${input.taskId}`)
      if (!t.result) {
        throw new Error(`任务 ${input.taskId} 尚未收到结果，无从判定——评审不得凭空进行`)
      }

      const envelope = t.envelope as TaskEnvelopeV1
      const criteria = envelope.goal.success_definition
      const answered = new Map(t.result.criterion_results.map((c) => [c.criterion_id, c]))

      const failed = criteria
        .filter((c) => answered.get(c.criterion_id)?.passed !== true)
        .map((c) => {
          const got = answered.get(c.criterion_id)
          return {
            criterion_id: c.criterion_id,
            expected: `${c.metric} ${c.operator} ${JSON.stringify(c.expected)}`,
            // 沉默不算通过：漏答与实测未达标要能分辨，否则下一轮不知道该补什么
            actual: got ? `${c.metric} = ${JSON.stringify(got.actual)}` : '（Agent 未回应该标准）',
            reason: got
              ? `实测未达标：期望 ${JSON.stringify(c.expected)}，实测 ${JSON.stringify(got.actual)}`
              : 'Agent 未回应该标准，沉默不算通过',
            evidence: [...(got?.evidence_artifact_ids ?? [])],
          }
        })

      // Agent 自己就没跑成功时，也要有一条能说清缘由的失败记录，
      // 否则返工决策里只有「不通过」三个字，下一轮无从下手。
      if (failed.length === 0 && t.result.status !== 'completed') {
        failed.push({
          criterion_id: 'TASK-STATUS',
          expected: 'status = completed',
          actual: `status = ${t.result.status}`,
          reason: t.result.error?.message ?? `Agent 未成功完成（${t.result.status}）`,
          evidence: t.result.artifacts.map((a) => a.artifact_id),
        })
      }

      const m = await store.getMission(t.mission_id)
      const budget = m?.constraints['max_additional_cycles']
      const maxCycles = typeof budget === 'number' ? budget : DEFAULT_MAX_CYCLES

      const decision: ReviewDecisionV1 = {
        schema: 'cmap/review-decision/v1',
        mission_id: t.mission_id,
        review_round: input.round + 1,
        reviewed_task_ids: [t.id],
        decision: failed.length === 0 ? 'accept' : 'rework',
        hard_gate_summary: {
          total: criteria.length,
          passed: criteria.length - failed.filter((f) => f.criterion_id !== 'TASK-STATUS').length,
          failed: failed.length,
        },
        // 程序化判定的把握是确定的；限制在于它只看硬指标
        review_confidence: {
          level: 'high',
          limitations: ['仅程序化硬门槛判定，未做软判断'],
        },
        ...(failed.length > 0
          ? {
              failed_criteria: failed,
              required_followups: [
                {
                  capability: t.capability,
                  task_type: envelope.classification.task_type,
                  // focus 指明这一轮该收敛哪几条，避免下一轮重复无效尝试
                  focus: failed.map((f) => `${f.criterion_id}：期望 ${f.expected}，实测 ${f.actual}`),
                  ...(t.result.artifacts.length > 0
                    ? { inputs: { artifact_refs: t.result.artifacts.map((a) => a.artifact_id) } }
                    : {}),
                },
              ],
              stop_conditions: { max_additional_cycles: maxCycles },
            }
          : {}),
      }

      const firstFailedActual = failed[0]
        ? answered.get(failed[0].criterion_id)?.actual
        : undefined
      const metric = Number(firstFailedActual)

      return {
        decision,
        progress: {
          // 没有 patch 可比，用证据内容哈希代替：这一轮的产物与上一轮
          // 逐字节相同，就是「什么都没动」最直接的证据。
          patchHash: createHash('sha256')
            .update(t.result.artifacts.map((a) => a.sha256).sort().join(','))
            .digest('hex'),
          failedCriteriaIds: failed.map((f) => f.criterion_id),
          metricValue: Number.isFinite(metric) ? metric : null,
          errorFingerprint: t.result.error?.fingerprint ?? null,
        },
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

      // 幂等：Activity 超时后会真正重跑，且可能落到另一个 Worker 进程。
      // 状态迁移有幂等键保护，但 putReview 与建后继任务每次都生成新 ID——
      // 不拦住就会产生重复评审记录和孤儿任务，让「第几轮」的计数失真。
      const priorReview = (await store.listReviews(t.mission_id)).find(
        (r) => r.round === round && r.reviewed_task_ids.includes(taskId),
      )
      if (priorReview) {
        return replayOutcome(t.mission_id, taskId, round, decision)
      }

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

  /**
   * 重放已处理过的评审：从账本还原上次的结果，而不是重新执行。
   *
   * 后继任务通过 supersedes_task_id 反查，因此不依赖任何进程内状态——
   * 换个 Worker 进程重试同样能还原。
   */
  async function replayOutcome(
    missionId: string,
    taskId: string,
    round: number,
    decision: ReviewDecisionV1,
  ): Promise<ApplyReviewOutput> {
    const followups = (await store.queryTasks({ missionId }))
      .filter((x) => x.supersedes_task_id === taskId)
      .map((x) => x.id)

    if (decision.decision === 'accept') {
      return { outcome: 'accept', followupTaskIds: [] }
    }
    if (followups.length > 0) {
      return { outcome: 'rework', followupTaskIds: followups }
    }
    // 无后继任务说明上次走的是升级分支
    const maxCycles = decision.stop_conditions?.max_additional_cycles ?? 0
    return {
      outcome: 'escalated',
      followupTaskIds: [],
      escalationReason:
        round >= maxCycles
          ? `返工轮次已达上限（${round}/${maxCycles}），停止返工并升级`
          : '检测到无进展，停止返工并升级',
    }
  }

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
      eventType: 'TASK_FAILED',
      idempotencyKey: `escalate-done:${taskId}`,
      payload: { reason },
    })
    await store.setMissionState(missionId, 'ESCALATED', ACTOR)
  }

  async function createTaskInternal(input: CreateTaskInput): Promise<CreateTaskOutput> {
    const taskId = nextId('tsk')
    const now = new Date().toISOString()

    // 信封必须自洽：spawn 出来的 Agent 不继承任何上下文，它只能看到这份信封。
    // 目标与验收标准因此必须从 Mission 抄进来——写死的占位会让 Agent 去回应
    // 一条根本不存在的标准，而验收又按 Mission 的标准判，永远对不上。
    const m = await store.getMission(input.missionId)
    if (!m) throw new Error(`Mission 不存在：${input.missionId}`)

    // 没有验收标准就没有「完成」的定义，任务无从判定，也无从返工。
    // 与其派一个永远说不清算不算过的任务出去，不如在这里挡住。
    const [firstCriterion, ...restCriteria] = m.acceptance.map((c) => ({
      criterion_id: c.criterion_id,
      metric: c.metric,
      operator: c.operator,
      expected: c.expected,
      hard_gate: c.hard_gate,
    }))
    if (!firstCriterion) {
      throw new Error(`Mission ${m.id} 未声明验收标准，无法判定任务是否完成`)
    }

    const envelope = {
      schema: 'cmap/task-envelope/v1',
      identity: {
        mission_id: input.missionId,
        task_id: taskId,
        ...(input.supersedesTaskId ? { supersedes_task_id: input.supersedesTaskId } : {}),
        idempotency_key: `${input.missionId}:${taskId}`,
        revision: 1,
        tenant: m.tenant,
        owner: m.owner,
      },
      classification: {
        task_type: m.type,
        requested_capability: input.capability,
        risk_level: 'read-meta',
      },
      goal: {
        statement: input.goal ?? m.goal,
        success_definition: [firstCriterion, ...restCriteria],
      },
      // 工作目录不进信封：本机绝对路径会让同一任务无法在别的机器上执行。
      environment: { tenant: m.tenant },
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
