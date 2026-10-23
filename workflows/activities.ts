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
import { isDeepStrictEqual } from 'node:util'

import { Context } from '@temporalio/activity'

import type {
  Store,
  Artifact,
  Approval,
  ApprovalScope,
  RemoteTaskBinding,
  TaskEnvelopeV1,
  TaskRecord,
  TaskResultV1,
  ReviewDecisionV1,
  ProgressSnapshot,
  RunnerDescriptor,
  QuotaSnapshotV1,
} from '#domain-model'
import { needsApproval, ApprovalDecisionConflictError } from '#domain-model'
import { recomputeCriterionPassed, yonWorkProfileFromRoute, snapshotRunnerDescriptor, RunnerAdmissionError, DispatchPermitError } from '#domain-model'
import { AdapterError, type AgentAdapter, type DispatchContext, type DispatchPermitSigner } from '#adapter-sdk'
import { preflightTaskDispatch, assertCurrentTaskApproval, assertStoredTaskAdmission, persistAdmissionDenial, readAdmissionDenial, admissionDenialReason, type AdmissionDenial } from './runner-admission.ts'

import {createLedgerTask, taskCreationId, MISSION_ACTOR as ACTOR, type CreateTaskInput, type CreateTaskOutput} from './task-creation.ts'
import { MEMORY_ROLE, freezeMemoryInput, registerMemoryArtifact, type FrozenInputRef, type MemoryDeps } from './memory-context.ts'
import { safeChildDir } from './artifact-files.ts'
import { readVerifiedArtifact } from '../packages/adapter-sdk/src/structured-output.ts'
import { applyReviewApplication } from './review-application.ts'
import { proposeTaskKnowledge, recordEscalationHandoff } from './memross-writeback.ts'
import { cancelMissionTasks, type CancelMissionTasksInput } from './mission-cancel.ts'
import { continuationSource, freezeContinuationInputs, registerContinuationInputs } from './mission-continuation.ts'
import { cancelPendingMissionTasks, type CancelPendingMissionTasksInput } from './mission-pending-cancel.ts'
import { frozenInputArtifactIds, prepareReviewInputs, verifyReviewInputs } from './review-inputs.ts'
export type {CreateTaskInput, CreateTaskOutput} from './task-creation.ts'
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
const judge = (envelope: TaskEnvelopeV1, result: TaskResultV1): CollectedResult => {
  const answered = new Map(result.criterion_results.map((c) => [c.criterion_id, c]))
  const failedCriteria = (envelope.goal.success_definition ?? [])
    .filter((c) => !recomputeCriterionPassed(c, answered.get(c.criterion_id)))
    .map((c) => c.criterion_id)

  return {
    status: result.status,
    passed: result.status === 'completed' && failedCriteria.length === 0,
    failedCriteria,
    summary: result.summary,
  }
}

const TERMINAL_TASK_COLLECT_ERROR_CODES = new Set(['TASK_FAILED', 'TASK_CANCELED'])

const isTerminalCollectError = (e: unknown): e is AdapterError =>
  e instanceof AdapterError &&
  !e.retryable &&
  (
    e.code.startsWith('RESULT_') ||
    e.code.startsWith('EVIDENCE_') ||
    TERMINAL_TASK_COLLECT_ERROR_CODES.has(e.code)
  )

const failedResultFromCollectError = (
  e: AdapterError,
  envelope: TaskEnvelopeV1,
): TaskResultV1 => ({
  schema: 'cmap/task-result/v1',
  mission_id: envelope.identity.mission_id,
  task_id: envelope.identity.task_id,
  attempt: envelope.identity.revision,
  status: 'failed',
  summary: `Adapter 终态结果收取失败：${e.code}`,
  criterion_results: [],
  artifacts: [],
  error: {
    code: e.code,
    message: `Adapter 终态结果收取失败：${e.code}`,
    retryable: false,
    fingerprint: e.fingerprint,
  },
})

/** 默认返工预算。绝不无限重试——耗尽即升级给人。 */
const DEFAULT_MAX_CYCLES = 2

/** 证据保留期。到期前不得覆盖，否则结论无法复核。 */
const RETENTION_MS = 365 * 24 * 3600 * 1000

export interface ActivityDeps {
  readonly store: Store
  /**
   * 派发目标。不注入则无法派发——宁可明确报错，也不要让 Workflow 跑出
   * 一条「任务已 RUNNING」却根本没人干活的绿色轨迹。
   */
  readonly adapter?: AgentAdapter
  /** 注册顺序是无显式首选时的稳定路由顺序；不能与 adapter 同时传入。 */
  readonly adapters?: readonly AgentAdapter[]
  readonly runner: RunnerDescriptor
  readonly signDispatchPermit: DispatchPermitSigner
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
  /** 审批轮询间隔。审批来自人，生产默认无需高频查库。 */
  readonly approvalPollIntervalMs?: number
  /** 审批等待上限。默认 24 小时，超时按拒绝处理。 */
  readonly approvalWaitTimeoutMs?: number
  /** Memross 记忆检索。Mission 要求记忆而未配置时失败关闭，不静默降级。 */
  readonly memory?: MemoryDeps
}

export interface ApprovalGateOutput {
  readonly required: boolean
  readonly approvalId?: string
  readonly scope?: ApprovalScope
}

export interface WaitApprovalInput {
  readonly taskId: string
  readonly approvalId: string
  readonly scope: ApprovalScope
}

export interface WaitApprovalOutput {
  readonly decision: 'approved' | 'rejected'
  readonly decidedBy: string
}

export type DispatchOutput = {
  /** true 表示本次真实派发；false 表示已有 binding，跳过。 */
  readonly dispatched: boolean
  readonly remoteTaskId: string
} | ({ readonly dispatched: false } & AdmissionDenial)

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

interface CollectedResult {
  readonly admissionDenied?: AdmissionDenial['admissionDenied']
  readonly status: TaskResultV1['status']
  /** 全部验收标准都被逐条回应且通过，才为 true。 */
  readonly passed: boolean
  /** 未通过或 Agent 压根没回应的标准。沉默不算通过。 */
  readonly failedCriteria: readonly string[]
  readonly summary: string
}

export type CollectOutput = CollectedResult | {
  readonly executionUncertain: {
    readonly code: 'BINDING_NOT_FOUND'
    readonly terminalObserved: false
  }
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

/** binding 所属的 Adapter：本机 Adapter（无 runnerId）按 adapter_id；远程 runner 另须 runner_id 一致。 */
export const adapterForBinding = (adapters: readonly AgentAdapter[], binding: RemoteTaskBinding): AgentAdapter | undefined =>
  adapters.find((a) => a.adapterId === binding.adapter && (a.runnerId === undefined || a.runnerId === binding.runner_id))

export const createActivities = (deps: ActivityDeps) => {
  const { store, adapter, workRoot } = deps
  if (adapter && deps.adapters) throw new Error('adapter 与 adapters 不能同时配置')
  if (typeof deps.signDispatchPermit !== 'function') throw new Error('DISPATCH_PERMIT_SIGNER_REQUIRED')
  const adapters = [...(deps.adapters ?? (adapter ? [adapter] : []))]
  for (const candidate of adapters) {
    if (candidate.authorizationMode !== 'managed') throw new Error('MANAGED_ADAPTER_REQUIRED')
    if (typeof candidate.prepareBinding !== 'function') throw new Error('PREPARED_ADAPTER_REQUIRED')
  }
  // 同一 adapter_id 可注册多台 runner（本机 runner 与 lap，S16），以 adapter_id + runner_id 区分
  if (new Set(adapters.map((a) => `${a.adapterId}@${a.runnerId ?? ''}`)).size !== adapters.length ||
      new Set(adapters.map((a) => a.agentId)).size !== adapters.length) {
    throw new Error('Adapter / Agent ID 重复')
  }
  const runner = snapshotRunnerDescriptor(deps.runner)
  const runnerId = runner.runner_id
  const pollIntervalMs = deps.pollIntervalMs ?? 2_000
  const approvalPollIntervalMs = deps.approvalPollIntervalMs ?? 5_000
  const executionUncertain = {code:'BINDING_NOT_FOUND',terminalObserved:false} as const
  const hasExecutionUncertainty = async (task: TaskRecord): Promise<boolean> => {
    const receipts = (await store.listEvents(task.mission_id))
      .filter(event => event.idempotency_key === `execution-uncertain:${task.id}`)
    if (receipts.length === 0) return false
    const receipt = receipts[0]!
    const latest = await store.getTask(task.id)
    const transitioned = isDeepStrictEqual(receipt.payload, {from:'RUNNING',to:'INPUT_REQUIRED',...executionUncertain})
    if (receipts.length !== 1 || receipt.event_type !== 'INPUT_REQUIRED' || receipt.event_version !== 1 ||
      receipt.task_id !== task.id || receipt.mission_id !== task.mission_id || !isDeepStrictEqual(receipt.actor, ACTOR) ||
      (!transitioned && !isDeepStrictEqual(receipt.payload, executionUncertain)) ||
      !latest || !isDeepStrictEqual(latest.binding, task.binding) ||
      (transitioned && latest.state !== 'INPUT_REQUIRED' && !latest.result)) {
      throw new Error('CLI_RECOVERY_RECEIPT_CONFLICT')
    }
    return !latest.result
  }
  const approvalWaitTimeoutMs = deps.approvalWaitTimeoutMs ?? 24 * 3600 * 1000

  const boundAdapter = (binding: RemoteTaskBinding): AgentAdapter => {
    const selected = adapterForBinding(adapters, binding)
    if (!selected) throw new Error(`已绑定 Adapter 不可用：${binding.adapter}@${binding.runner_id}；不自动换 Agent`)
    return selected
  }

  /** 一次选择的完整记录：各候选按评估顺序的判定与原因，供 ROUTING_DECIDED 事件与路由效率评测。 */
  interface RoutingDecision {
    readonly preferred_agent: string | null
    readonly chosen_agent: string | null
    readonly chosen_adapter: string | null
    readonly fallback: boolean
    readonly candidates: readonly {agent_id: string; adapter_id: string | null; verdict: 'selected' | 'skipped'; reason: string | null}[]
    readonly decision_ms: number
    readonly runner_id: string
  }

  const selectAdapter = async (envelope: TaskEnvelopeV1): Promise<{adapter: AgentAdapter; supportsWorktreeIsolation: boolean; routing: RoutingDecision}> => {
    if (!adapters.length) throw new Error('未注入 Adapter：控制面没有可派发的目标')
    const started = Date.now()
    const policy = envelope.execution_policy
    const ids = [...(policy.preferred_agent ? [policy.preferred_agent] : []), ...(policy.fallback_agents ?? [])]
    // 按评估顺序展开：显式指定时按首选、替补顺序；未指定时按注册顺序。未注册的 ID 也记下来。
    const order = ids.length
      ? [...new Set(ids)].map((id) => ({id, matched: adapters.filter((a) => a.agentId === id)}))
      : adapters.map((a) => ({id: a.agentId, matched: [a]}))
    const candidates: {agent_id: string; adapter_id: string | null; verdict: 'selected' | 'skipped'; reason: string | null}[] = []
    const decision = (chosen: AgentAdapter | null): RoutingDecision => ({
      preferred_agent: policy.preferred_agent ?? null,
      chosen_agent: chosen?.agentId ?? null,
      chosen_adapter: chosen?.adapterId ?? null,
      fallback: Boolean(chosen && policy.preferred_agent && chosen.agentId !== policy.preferred_agent),
      candidates,
      decision_ms: Date.now() - started,
      runner_id: runnerId,
    })
    const risks = ['read-meta', 'read-sensitive', 'controlled', 'mutating']
    // health 带回的账号级额度快照落账（ADR-0009），供路由与审计；没有账号摘要的无从归属，不落账
    const quotaSeen: QuotaSnapshotV1[] = []
    const persistQuota = async (): Promise<void> => {
      for (const q of quotaSeen) if (q.account_ref) await store.putQuotaSnapshot(q)
    }
    const probe = async (candidate: AgentAdapter): Promise<{reason: string} | {supportsWorktreeIsolation: boolean}> => {
      try {
        const descriptor = await candidate.discover()
        if (descriptor.adapter_id !== candidate.adapterId || descriptor.agent_id !== candidate.agentId) return {reason: 'descriptor_mismatch'}
        if (!descriptor.capabilities.includes(envelope.classification.requested_capability)) return {reason: 'capability'}
        const required = risks.indexOf(envelope.classification.risk_level)
        const ceiling = risks.indexOf(descriptor.risk_ceiling)
        if (required < 0 || ceiling < required) return {reason: 'risk'}
        const health = await candidate.health()
        if (health.quota) quotaSeen.push(health.quota)
        if (health.state !== 'healthy') return {reason: 'unhealthy'}
        // 远程 runner 公布的准入白名单：不放行就跳过并回落，而不是派过去再收准入拒绝。runner 仍会复核。
        const allow = health.admission
        if (allow) {
          if (!allow.allowed_tenants.includes(envelope.identity.tenant ?? '')) return {reason: 'tenant_mismatch'}
          if (!allow.allowed_owners.includes(envelope.identity.owner ?? '')) return {reason: 'owner_mismatch'}
          if (!allow.allowed_capabilities.includes(envelope.classification.requested_capability)) return {reason: 'capability_mismatch'}
          if (risks.indexOf(allow.max_risk) < required) return {reason: 'risk_exceeded'}
        }
        return {supportsWorktreeIsolation: descriptor.supports_worktree_isolation}
      } catch {
        // 仅启动前探测允许转向下一候选；startTask 的不确定结果不得触发替补。
        return {reason: 'probe_error'}
      }
    }
    for (const {id, matched} of order) {
      if (!matched.length) {
        candidates.push({agent_id: id, adapter_id: null, verdict: 'skipped', reason: 'not_registered'})
        continue
      }
      for (const candidate of matched) {
        if (!runner.agents.includes(candidate.agentId)) {
          candidates.push({agent_id: id, adapter_id: candidate.adapterId, verdict: 'skipped', reason: 'not_on_runner'})
          continue
        }
        const verdict = await probe(candidate)
        if ('reason' in verdict) {
          candidates.push({agent_id: id, adapter_id: candidate.adapterId, verdict: 'skipped', reason: verdict.reason})
          continue
        }
        candidates.push({agent_id: id, adapter_id: candidate.adapterId, verdict: 'selected', reason: null})
        await persistQuota()
        return {adapter: candidate, supportsWorktreeIsolation: verdict.supportsWorktreeIsolation, routing: decision(candidate)}
      }
    }
    await persistQuota()
    throw Object.assign(new Error(`没有可用 Adapter：${envelope.classification.requested_capability}`), {routing: decision(null)})
  }

  /** 每次真实选择各记一条（键唯一）：重试时的决策可能不同，固定键会与首次内容冲突而阻断派发。 */
  const recordRouting = async (task: TaskRecord, routing: RoutingDecision): Promise<void> => {
    await store.appendEvent({event:{
      event_type:'ROUTING_DECIDED',event_version:1,occurred_at:new Date().toISOString(),
      mission_id:task.mission_id,task_id:task.id,attempt:task.attempt,actor:ACTOR,
      causation_id:null,correlation_id:task.mission_id,trace_id:task.id,
      idempotency_key:nextId('route'),payload:{...routing},
    }})
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
    async cancelPendingMissionTasks(input: CancelPendingMissionTasksInput): Promise<void> {
      await cancelPendingMissionTasks(store, input)
    },

    /** 创建任务并返回其 id。id 在此生成，Workflow 只负责传递。 */
    async createTask(input: CreateTaskInput): Promise<CreateTaskOutput> {
      // 冻结输入（记忆快照、续作证据）只附在 Mission 的首个任务上（无 creationKey、调用方未给输入证据）。
      if (input.creationKey !== undefined || input.artifactRefs !== undefined) return createLedgerTask(store,input)
      const mission = await store.getMission(input.missionId)
      const memory = mission?.constraints['memory'] as { project_id: string; query?: string; limit?: number } | undefined
      const source = mission ? await continuationSource(store, mission) : null
      if (!mission || (!memory && !source)) return createLedgerTask(store,input)
      if (!workRoot) throw new Error('MEMORY_REQUIRES_WORKROOT')
      const taskId = taskCreationId(input.missionId)
      const { child } = await safeChildDir(workRoot, taskId)
      const withParameters = source ? { ...input, parameters: { continues_mission_id: source.id } } : input
      // 重试幂等：任务已入账就沿用信封里冻结的引用，只复核字节，绝不重新检索或重新复制——
      // 重新检索可能拿到不同内容，导致同一任务的信封前后不一致。
      const existing = await store.getTask(taskId)
      const frozen = existing?.envelope.inputs?.artifact_refs
      if (existing && !frozen?.length) return createLedgerTask(store,withParameters)
      let refs: FrozenInputRef[]
      if (frozen?.length) refs = frozen as FrozenInputRef[]
      else {
        refs = source ? await freezeContinuationInputs(store, workRoot, source, taskId) as FrozenInputRef[] : []
        // artifact_id 是账本全局主键：同目标的两个 Mission 会冻结出同一份字节，必须带上任务 ID。
        if (memory) refs.push(await freezeMemoryInput(deps.memory, child, {
          projectId: memory.project_id, query: (memory.query ?? mission.goal).slice(0, 500), limit: memory.limit ?? 3,
        }, (digest) => `art_mem_${createHash('sha256').update(JSON.stringify([taskId, digest])).digest('hex').slice(0, 32)}`))
      }
      // 与 Agent 侧同一道复核：路径不越界、散列一致、不含已知凭据模式。
      const memoryRef = refs.find((r) => r.role === MEMORY_ROLE)
      const verified = memoryRef ? await readVerifiedArtifact(child, { uri: memoryRef.uri, role: memoryRef.role, sha256: memoryRef.sha256 }) : undefined
      const out = await createLedgerTask(store, { ...withParameters, artifactRefs: refs })
      if (memory && memoryRef && verified) {
        await registerMemoryArtifact(store, { missionId: mission.id, taskId: out.taskId, ref: memoryRef, projectId: memory.project_id, sizeBytes: verified.bytes.length })
      }
      if (source) await registerContinuationInputs(store, workRoot, mission, source, out.taskId, refs)
      return out
    },

    async markReady(taskId: string): Promise<void> {
      await store.transitionTask({
        taskId, to: 'READY', actor: ACTOR,
        eventType: 'TASK_READY', idempotencyKey: `ready:${taskId}`,
      })
    },

    /**
     * 高风险任务在派发前创建审批并暂停。
     *
     * approval id 由 task + scope 确定，Activity 重试不会多建审批；批准记录
     * 已存在时也不会被新的 pending 记录覆盖。
     */
    async requestApproval(taskId: string): Promise<ApprovalGateOutput> {
      const t = await store.getTask(taskId)
      if (!t) throw new Error(`任务不存在：${taskId}`)
      if (!needsApproval(t.risk)) return { required: false }

      const scope = t.risk
      const approvalId = `apr:${taskId}:${scope}`
      const existing = await store.getApproval(approvalId)

      if (!existing) {
        const now = new Date()
        const approval: Approval = {
          id: approvalId,
          mission_id: t.mission_id,
          task_id: taskId,
          action: t.capability,
          scope,
          requested_by: `system:${runnerId}`,
          risk_level: t.risk,
          reason: t.capability === 'yonwork.validate'
            ? `任务 ${taskId}：${t.envelope.goal.statement}；目标 ${t.envelope.execution_policy.preferred_agent}；policy ${String(t.envelope.inputs?.parameters?.['yonwork_policy_sha256'])}；仅独立会话、无投递/附件、回复报告；controlled 授权不包含配置或业务修改`
            : `任务 ${taskId} 风险级别为 ${scope}，执行前需要人工授权`,
          evidence_artifact_ids: [],
          decision: 'pending',
          decided_by: null,
          decided_at: null,
          expires_at: new Date(now.getTime() + approvalWaitTimeoutMs).toISOString(),
          created_at: now.toISOString(),
        }
        await store.createApproval(approval)
      }

      if (t.state === 'READY' && (await store.getApproval(approvalId))?.decision === 'pending') {
        await store.transitionTask({
          taskId, to: 'APPROVAL_REQUIRED', actor: ACTOR,
          eventType: 'APPROVAL_REQUESTED', idempotencyKey: `approval-requested:${taskId}:${scope}`,
          payload: { approval_id: approvalId, scope },
        })
      }

      return { required: true, approvalId, scope }
    },

    /** 等真人决策。批准另一 scope 不会改变本审批记录，因此不会误放行。 */
    async waitForApproval(input: WaitApprovalInput): Promise<WaitApprovalOutput> {
      const deadline = Date.now() + approvalWaitTimeoutMs

      for (;;) {
        const approval = await store.getApproval(input.approvalId)
        if (!approval) throw new Error(`审批不存在：${input.approvalId}`)
        if (approval.task_id !== input.taskId || approval.scope !== input.scope) {
          throw new Error(`审批 ${input.approvalId} 与任务或 scope 不匹配`)
        }

        if (approval.decision === 'approved') {
          const t = await store.getTask(input.taskId)
          if (t?.state === 'APPROVAL_REQUIRED') {
            await store.transitionTask({
              taskId: input.taskId, to: 'READY', actor: ACTOR,
              eventType: 'APPROVAL_GRANTED',
              idempotencyKey: `approval-granted:${input.approvalId}`,
              payload: { approval_id: input.approvalId, scope: input.scope },
            })
          }
          return { decision: 'approved', decidedBy: approval.decided_by! }
        }

        if (approval.decision === 'rejected' || approval.decision === 'expired') {
          const t = await store.getTask(input.taskId)
          if (t?.state === 'APPROVAL_REQUIRED') {
            await store.transitionTask({
              taskId: input.taskId, to: 'REJECTED', actor: ACTOR,
              eventType: 'APPROVAL_DENIED',
              idempotencyKey: `approval-denied:${input.approvalId}`,
              payload: { approval_id: input.approvalId, scope: input.scope },
            })
          }
          return { decision: 'rejected', decidedBy: approval.decided_by ?? 'system:expired' }
        }

        const expires = Date.parse(approval.expires_at)
        if (!Number.isFinite(expires)) throw new Error('审批到期时间无效')
        if (Date.now() >= Math.min(deadline, expires)) {
          try {
            await store.decideApproval(input.approvalId, 'expired', 'system:timeout', new Date().toISOString())
          } catch (error) {
            // 真人决策可能抢先落库。不能覆盖它，重新读取唯一终态。
            if (!(error instanceof ApprovalDecisionConflictError)) throw error
          }
          continue
        }

        heartbeat()
        await sleep(approvalPollIntervalMs)
      }
    },

    /**
     * 派发：写 Ledger 与调 Adapter 在同一 Activity 内完成。
     *
     * 合并 Activity 不等于外部启动与 Ledger 写入原子化。
     * 受管 Adapter 必须先准备确定性 binding；不支持预写意图的 Adapter 不进入派发。
     *
     * 幂等：先查 Ledger 中的 binding。Adapter 的内存缓存在 Worker 重启后
     * 失效，只有落库的 binding 才能让重试的 Activity 认出「已派发过」。
     */
    async dispatchTask(taskId: string): Promise<DispatchOutput> {
      const existing = await store.getTask(taskId)
      if (!existing) throw new Error(`任务不存在：${taskId}`)

      const denied = await preflightTaskDispatch(store,runner,existing)
      if (denied) return {dispatched:false,...denied}

      if (existing.binding) {
        // 已派发过——重试或重复执行时走到这里，不得再次调用 Adapter
        return { dispatched: false, remoteTaskId: existing.binding.remote_task_id }
      }

      const envelope = existing.envelope as TaskEnvelopeV1
      let selection: Awaited<ReturnType<typeof selectAdapter>>
      try {
        selection = await selectAdapter(envelope)
      } catch (error) {
        const routing = (error as {routing?: RoutingDecision}).routing
        if (routing) await recordRouting(existing, routing)
        throw error
      }
      await recordRouting(existing, selection.routing)
      const {adapter: selectedAdapter, supportsWorktreeIsolation} = selection

      const assertPreparedAuthority = async (expectedBinding?: RemoteTaskBinding, observedPolicy?: string): Promise<void> => {
        const task = await store.getTask(taskId)
        if (task) await assertStoredTaskAdmission(store,runner,task)
        if (!task || !isDeepStrictEqual(task.envelope, envelope) ||
          (expectedBinding ? task.state !== 'RUNNING' || !isDeepStrictEqual(task.binding, expectedBinding)
            : !['READY','QUEUED','WAITING_RESOURCE'].includes(task.state))) {
          throw new Error('Prepared dispatch task or binding mismatch')
        }
        if (selectedAdapter.adapterId === 'yonwork-adapter') {
          const policy = envelope.inputs?.parameters?.['yonwork_policy_sha256']
          if (task.capability !== 'yonwork.validate' || task.risk !== 'controlled' ||
            envelope.classification.risk_level !== 'controlled' ||
            !yonWorkProfileFromRoute(envelope.execution_policy.preferred_agent) ||
            envelope.execution_policy.preferred_agent !== selectedAdapter.agentId ||
            envelope.execution_policy.fallback_agents?.length ||
            envelope.permissions.yonwork?.chat_send !== true ||
            typeof policy !== 'string' || !/^[a-f0-9]{64}$/.test(policy) ||
            (observedPolicy !== undefined && observedPolicy !== policy) ||
            !envelope.execution_policy.required_resource_locks?.some(lock => lock.resource === 'yonwork:host')) {
            throw new Error('Prepared dispatch profile, permission or policy mismatch')
          }
        }
        await assertCurrentTaskApproval(store,task)
        const required = envelope.execution_policy.required_resource_locks ?? []
        if (required.length) {
          const locks = await store.listActiveLocks(new Date().toISOString())
          for (const requirement of required) {
            if (!locks.some(lock => lock.resource === requirement.resource && lock.task_id === taskId &&
              lock.mission_id === task.mission_id && lock.holder_runner_id === runnerId &&
              lock.released_at === null && Date.parse(lock.expires_at) > Date.now())) {
              throw new Error('Prepared dispatch requires active owned resource leases')
            }
          }
        }
        if (expectedBinding) await verifyReviewInputs(store, task, workRoot)
      }
      // Adapter health may await external I/O. Recheck authoritative scope before local preparation.
      const current = await store.getTask(taskId)
      if (!current) throw new Error('TASK_NOT_FOUND')
      const rechecked = await preflightTaskDispatch(store,runner,current)
      if (rechecked) return {dispatched:false,...rechecked}
      if (current.binding) return {dispatched:false,remoteTaskId:current.binding.remote_task_id}
      if (selectedAdapter.prepareBinding) {
        try {
          await assertPreparedAuthority()
          if (envelope.inputs?.artifact_refs?.some(ref => Object.hasOwn(ref, 'source_task_id')) &&
            supportsWorktreeIsolation !== true) {
            throw new RunnerAdmissionError('INPUT_INVALID')
          }
          await prepareReviewInputs(store, current, workRoot)
        }
        catch (error) {
          if (!(error instanceof RunnerAdmissionError)) throw error
          return {dispatched:false,...await persistAdmissionDenial(store,runner,current,error,'initial')}
        }
      }

      if (current.state === 'READY') {
        await store.transitionTask({
          taskId, to: 'QUEUED', expectedFrom:'READY', actor: ACTOR,
          eventType: 'TASK_ASSIGNED', idempotencyKey: `queued:${taskId}`,
        })
      }

      // 远程 runner Adapter（ADR-0006）的许可受众与 binding 绑定目标 runner，其余仍是本机 runner。
      const targetRunnerId = selectedAdapter.runnerId ?? runnerId
      const token = deps.signDispatchPermit(envelope,{runnerId:targetRunnerId,adapterId:selectedAdapter.adapterId})
      if (typeof token !== 'string' || token.length === 0) throw new Error('DISPATCH_PERMIT_SIGNER_INVALID')
      const timeoutMs = (envelope.execution_policy?.timeout_seconds ?? 300) * 1000

      // 工作目录由 runner 侧准备。不存在时 spawn 会直接失败，
      // 而失败信息指向 codex 而不是这里，很难查。
      const worktree = workRoot ? join(workRoot, taskId) : null
      if (worktree) await mkdir(worktree, { recursive: true })

      const context: DispatchContext = {
        token,
        runner_id: targetRunnerId,
        trace_id: taskId,
        correlation_id: envelope.identity.idempotency_key,
        ...(worktree ? { worktree } : {}),
        deadline_at: new Date(Date.now() + timeoutMs).toISOString(),
      }

      if (selectedAdapter.prepareBinding) {
        const prepared = selectedAdapter.prepareBinding(envelope, context)
        if (prepared.adapter !== selectedAdapter.adapterId || prepared.runner_id !== targetRunnerId) {
          throw new Error('Prepared binding identity mismatch')
        }
        const claim = await store.claimTaskBinding({taskId,binding:prepared,actor:ACTOR})
        if (!claim.claimed) {
          const receipt=await readAdmissionDenial(store,claim.task)
          if(receipt)return {dispatched:false,...receipt}
          return {dispatched:false,remoteTaskId:claim.task.binding!.remote_task_id}
        }
        let revoked: AdmissionDenial | undefined
        const checkPrepared = async (policySha256?: string): Promise<void> => {
          try {await assertPreparedAuthority(prepared,policySha256)}
          catch (error) {
            if (!(error instanceof RunnerAdmissionError)) throw error
            const task = await store.getTask(taskId)
            if (!task) throw new Error('TASK_NOT_FOUND')
            revoked = await persistAdmissionDenial(store,runner,task,error,'post-intent')
            throw error // prevents the Adapter from proceeding past beforeSend
          }
        }
        let checked = false
        let binding: RemoteTaskBinding
        try {
          await checkPrepared()
          binding = await selectedAdapter.startTask(envelope, {...context,beforeSend:async (candidate,policySha256) => {
            if (checked) throw new Error('Prepared beforeSend invoked more than once')
            if (selectedAdapter.adapterId === 'yonwork-adapter' && policySha256 === undefined) {
              throw new Error('YonWork beforeSend requires verified policy hash')
            }
            if (!isDeepStrictEqual(candidate,prepared)) throw new Error('Prepared binding changed before send')
            await checkPrepared(policySha256)
            checked = true
          }})
        } catch (error) {
          if (revoked) return {dispatched:false,...revoked}
          // 远程 runner 自己的验签或准入拒绝同样是发送意图后的确定性拒绝：保留 binding，不重发。
          if (error instanceof DispatchPermitError || error instanceof RunnerAdmissionError) {
            const task = await store.getTask(taskId)
            if (!task) throw new Error('TASK_NOT_FOUND')
            const denial = await persistAdmissionDenial(store,runner,task,
              error instanceof RunnerAdmissionError ? error : new RunnerAdmissionError('PERMIT_INVALID'),'post-intent')
            return {dispatched:false,...denial}
          }
          throw error
        }
        if (!checked || !isDeepStrictEqual(binding,prepared)) throw new Error('Prepared dispatch contract mismatch')
        // This acknowledges the start call, not remote completion. Recovery never invents it.
        await store.appendEvent({event:{
          event_type:'TASK_STARTED',event_version:1,occurred_at:new Date().toISOString(),
          mission_id:existing.mission_id,task_id:taskId,attempt:existing.attempt,actor:ACTOR,
          causation_id:null,correlation_id:existing.mission_id,trace_id:taskId,
          idempotency_key:`running:${taskId}`,payload:{},
        }})
        return {dispatched:true,remoteTaskId:binding.remote_task_id}
      }

      throw new Error('PREPARED_ADAPTER_REQUIRED')
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
      let denied: AdmissionDenial | undefined
      try {denied=await readAdmissionDenial(store,t)}
      catch {
        try {if(t.binding&&!t.result)await boundAdapter(t.binding).cancel(t.binding,'RUNNER_ADMISSION_OBSERVATION_UNAVAILABLE')}
        finally {throw new Error('RUNNER_ADMISSION_OBSERVATION_UNAVAILABLE')}
      }
      if (denied) return {status:'failed',passed:false,failedCriteria:[],summary:admissionDenialReason(denied),...denied}
      if (t.result) {
        if (t.binding) await recordResultArtifacts(t, t.result, boundAdapter(t.binding), t.binding)
        return judge(envelope, t.result)
      }

      if (!t.binding) throw new Error(`任务 ${taskId} 尚未派发，无结果可收`)
      if (await hasExecutionUncertainty(t)) return {executionUncertain}
      const a = boundAdapter(t.binding)

      const waitMs =
        deps.waitTimeoutMs ?? (envelope.execution_policy?.timeout_seconds ?? 300) * 1000
      const deadline = Date.now() + waitMs

      // 轮询至终态。显式超时：宁可明确失败，也不要静默挂起——
      // 卡住而无日志比失败难查得多。
      for (;;) {
        let revoked: AdmissionDenial | undefined
        let completed: TaskRecord | undefined
        try {
          const current=await store.getTask(taskId)
          if(!current)throw new Error('TASK_NOT_FOUND')
          if (current.result) completed = current
          revoked=await readAdmissionDenial(store,current)
        } catch {
          try {await a.cancel(t.binding,'RUNNER_ADMISSION_OBSERVATION_UNAVAILABLE')}
          finally {throw new Error('RUNNER_ADMISSION_OBSERVATION_UNAVAILABLE')}
        }
        if(revoked)return {status:'failed',passed:false,failedCriteria:[],summary:admissionDenialReason(revoked),...revoked}
        if (completed?.result) {
          await recordResultArtifacts(completed,completed.result,a,t.binding)
          return judge(envelope,completed.result)
        }
        let status
        try { status = await a.getStatus(t.binding, {deadline_at: new Date(deadline).toISOString()}) }
        catch (error) {
          if (!(error instanceof AdapterError) || error.code !== 'BINDING_NOT_FOUND' ||
            !['codex-adapter','kimi-adapter','remote-runner-adapter'].includes(t.binding.adapter)) throw error
          const current = await store.getTask(taskId)
          if (!current || !isDeepStrictEqual(current.binding,t.binding)) throw new Error('CLI_RECOVERY_BINDING_CHANGED')
          if (current.result) {
            await recordResultArtifacts(current,current.result,a,t.binding)
            return judge(envelope,current.result)
          }
          const idempotencyKey = `execution-uncertain:${taskId}`
          if (await hasExecutionUncertainty(current)) return {executionUncertain}
          if (current.state === 'RUNNING') {
            await store.transitionTask({taskId,to:'INPUT_REQUIRED',expectedFrom:'RUNNING',actor:ACTOR,
              eventType:'INPUT_REQUIRED',idempotencyKey,payload:executionUncertain})
          } else {
            // Older bound QUEUED tasks retain their last known phase; no invented RUNNING.
            await store.appendEvent({event:{
              event_type:'INPUT_REQUIRED',event_version:1,occurred_at:new Date().toISOString(),
              mission_id:current.mission_id,task_id:taskId,attempt:current.attempt,actor:ACTOR,
              causation_id:null,correlation_id:current.mission_id,trace_id:taskId,
              idempotency_key:idempotencyKey,payload:executionUncertain,
            }})
          }
          return {executionUncertain}
        }
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

      let raw: TaskResultV1
      try {
        raw = await a.collectResult(t.binding)
      } catch (e) {
        if (!isTerminalCollectError(e)) throw e
        raw = failedResultFromCollectError(e, envelope)
      }

      // Agent 自报的 artifact_id 只是它自己的叫法，实测常是 `report` 这种
      // 大众名字——落到账本的全局主键上，第二个任务就会跟第一个撞车。
      // 控制面按「任务 + 角色」重新命名，并把结论里的证据引用一起改写，
      // 否则「这条结论基于哪些证据」在账本里就断了。
      // 产物按下标映射：Agent 自报同一 id 的两份产物各自入账；引用该重复 id 的
      // 证据指向全部同名产物（按产物顺序），确定且不丢。
      const used = new Set<string>()
      const newIds = raw.artifacts.map((art, i) => {
        let id = `${taskId}:${art.role}`
        if (used.has(id)) id = `${taskId}:${art.role}:${i}`
        used.add(id)
        return id
      })
      const ledgerIds = new Map<string, string[]>()
      raw.artifacts.forEach((art, i) => {
        ledgerIds.set(art.artifact_id, [...(ledgerIds.get(art.artifact_id) ?? []), newIds[i]!])
      })

      // 归一化 criterion_results：只留信封声明的标准，重复回应以最后一条为准——
      // 与 judge / evaluateHardGate 的取数一致，DAG 复核才不会和硬门槛看到不同的数据。
      const declared = new Set(envelope.goal.success_definition.map((x) => x.criterion_id))
      const answered = new Map(
        raw.criterion_results.filter((c) => declared.has(c.criterion_id)).map((c) => [c.criterion_id, c]),
      )

      const result: TaskResultV1 = {
        ...raw,
        mission_id: t.mission_id,
        task_id: taskId,
        attempt: t.attempt,
        artifacts: raw.artifacts.map((art, i) => ({ ...art, artifact_id: newIds[i]! })),
        criterion_results: [...answered.values()].map((c) => {
          const criterion = envelope.goal.success_definition.find(
            (x) => x.criterion_id === c.criterion_id,
          )!
          return {
            ...c,
            passed: recomputeCriterionPassed(criterion, c),
            ...(c.evidence_artifact_ids
              ? {
                  evidence_artifact_ids: c.evidence_artifact_ids.flatMap(
                    (x) => ledgerIds.get(x) ?? [x],
                  ),
                }
              : {}),
          }
        }),
      }
      await store.setTaskResult(taskId, result)

      await recordResultArtifacts(t, result, a, t.binding)

      return judge(envelope, result)
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
      state: 'RUNNING' | 'AWAITING_APPROVAL' | 'COMPLETED' | 'ESCALATED' | 'FAILED'
      idempotencyKey?: string
    }): Promise<void> {
      await store.setMissionState(input.missionId, input.state, ACTOR, input.idempotencyKey)
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
        .filter((c) => !recomputeCriterionPassed(c, answered.get(c.criterion_id)))
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
      const followupInputIds = [...new Set([...t.result.artifacts.map((a) => a.artifact_id), ...frozenInputArtifactIds(t)])]
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
                  focus: [m?.goal ?? envelope.goal.statement,
                    ...failed.map((f) => `${f.criterion_id}：期望 ${f.expected}，实测 ${f.actual}`)],
                  // 上一轮产物与本任务收到的冻结输入（首轮记忆快照等）一起交给后继，前后看到同一份记忆。
                  ...(followupInputIds.length > 0 ? { inputs: { artifact_refs: followupInputIds } } : {}),
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
      // 主指标的验收方向与目标值：无进展检测据此判断数值变化是靠近还是远离目标
      const metricCriterion = failed[0] ? criteria.find((c) => c.criterion_id === failed[0]!.criterion_id) : undefined
      const metricTarget =
        metricCriterion &&
        metricCriterion.operator !== 'neq' &&
        metricCriterion.operator !== 'contains' &&
        metricCriterion.operator !== 'not_contains' &&
        typeof metricCriterion.expected === 'number' &&
        Number.isFinite(metricCriterion.expected)
          ? { operator: metricCriterion.operator, expected: metricCriterion.expected }
          : undefined

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
          ...(metricTarget ? { metricTarget } : {}),
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
      return applyReviewApplication(store, input)
    },

    /** 续接：取消 Mission 的未绑定任务，已绑定的调用其 Adapter cancel。可重复执行。 */
    async cancelMissionTasks(input: CancelMissionTasksInput): Promise<{ canceled: string[]; unconfirmed: string[] }> {
      return cancelMissionTasks(store, (binding) => adapterForBinding(adapters, binding), input)
    },

    /** 协作：验收通过的可复用结论提交 Memross 候选。旁路，失败只记事件。 */
    async proposeTaskKnowledge(input: { missionId: string; taskId: string }): Promise<void> {
      await proposeTaskKnowledge({ store, ...(workRoot ? { workRoot } : {}), ...(deps.memory ? { memory: deps.memory } : {}) }, input)
    },

    /** 交接：Mission 升级时写 Memross 交接记录。旁路，失败只记事件。 */
    async recordEscalationHandoff(input: { missionId: string; reason: string }): Promise<void> {
      await recordEscalationHandoff({ store, ...(workRoot ? { workRoot } : {}), ...(deps.memory ? { memory: deps.memory } : {}) }, input)
    },
  }

  // ------------------------------------------------------------ 内部

  async function recordResultArtifacts(
    t: TaskRecord,
    result: TaskResultV1,
    adapter: AgentAdapter,
    binding: RemoteTaskBinding,
  ): Promise<void> {
    // 证据落库可重入。结果先落账本，artifact 写入可能因瞬时存储错误失败；
    // Activity 重试必须用已验证的缓存结果补齐 registry，而不是重跑 Agent。
    const seen = new Set((await store.listArtifacts(t.id)).map((x) => x.artifact_id))
    const now = new Date()
    const unassessedReply = t.capability === 'yonwork.validate' && binding.adapter === 'yonwork-adapter'
    for (const [index, art] of result.artifacts.entries()) {
      if (seen.has(art.artifact_id)) continue
      // 同一 role 内按结果中的顺序编号：账本以 (task_id, role, version) 唯一。
      const version = result.artifacts.slice(0, index + 1).filter((a) => a.role === art.role).length
      const record: Artifact = {
        artifact_id: art.artifact_id,
        mission_id: t.mission_id,
        task_id: t.id,
        role: art.role,
        uri: art.uri,
        media_type: art.media_type ?? 'application/octet-stream',
        size_bytes: art.size_bytes ?? 0,
        sha256: art.sha256,
        version,
        state: 'AVAILABLE',
        producer: {
          agent_id: adapter.agentId,
          adapter_version: binding.protocol_version,
          execution_session_id:
            result.session?.provider_session_id ?? binding.remote_task_id,
        },
        provenance: { runner_id: binding.runner_id, ...(unassessedReply ? {content_assessment:'unassessed'} : {}) },
        retention: {
          retain_until: new Date(now.getTime() + RETENTION_MS).toISOString(),
          immutable: true,
        },
        security: {
          classification: unassessedReply ? 'restricted' : 'internal',
          contains_secrets: unassessedReply,
          contains_pii: unassessedReply,
          allowed_roles: [],
        },
        created_at: now.toISOString(),
      }
      await store.putArtifact(record)
      seen.add(art.artifact_id)
    }
  }
}

export type Activities = ReturnType<typeof createActivities>
