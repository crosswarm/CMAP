import type {
  EventActor,
  MissionState,
  ProgressSnapshot,
  Review,
  ReviewDecisionV1,
  Store,
  TaskRecord,
} from '#domain-model'
import { ApplicationFailure, Context } from '@temporalio/activity'
import { ApprovalDecisionConflictError, detectNoProgress, isTerminal, snapshotRunnerDescriptor } from '#domain-model'
import { createActivities, type ActivityDeps } from './activities.ts'
import { createDagAttemptRunner } from './dag-attempt.ts'
import {
  acceptedDagAttempt,
  dagAttemptSatisfiesNode,
  getDagMission,
  materializeDagNode as materializeDagTask,
} from './dag-materialization.ts'
import type { MissionPlanV1 } from '../packages/domain-model/src/generated/mission-plan.ts'

type DagNode = MissionPlanV1['nodes'][number]

export type DagNodeOutcome = {
  readonly status: 'accepted' | 'rework' | 'failed' | 'escalated'
  readonly nodeId: string
  readonly taskId?: string
  readonly attempt?: number
  readonly progress?: ProgressSnapshot
  readonly reason?: string
}

const ACTOR: EventActor = { type: 'system', id: 'dag-controller' }
const TERMINAL_MISSION = new Set<MissionState>(['COMPLETED', 'FAILED', 'ESCALATED', 'CANCELED'])
const SAFE_REASON = /^[A-Z][A-Z0-9_:-]*$/

const now = (): string => new Date().toISOString()

/** Temporal 的 attempt 序号；单测直接调用时没有 Activity 上下文，按首次处理。 */
const activityAttempt = (): number => {
  try {
    return Context.current().info.attempt
  } catch {
    return 1
  }
}

const nodeById = (plan: MissionPlanV1, nodeId: string): DagNode => {
  const node = plan.nodes.find((n) => n.node_id === nodeId)
  if (!node) throw new Error(`DAG node missing: ${nodeId}`)
  return node
}

const nodeIdOf = (task: TaskRecord): string => {
  const id = task.envelope.identity.plan_node_id
  if (!id) throw new Error(`Task ${task.id} is not a DAG node task`)
  return id
}

const reviewId = (taskId: string, round: number): string => `dagrev:${taskId}:${round}`

const putEvent = async (
  store: Store,
  missionId: string,
  eventType: 'DAG_NODE_FINISHED' | 'DAG_NODE_BLOCKED',
  payload: Readonly<Record<string, unknown>>,
  idempotencyKey: string,
  taskId: string | null = null,
): Promise<void> => {
  await store.appendEvent({
    event: {
      event_type: eventType,
      event_version: 1,
      occurred_at: now(),
      mission_id: missionId,
      task_id: taskId,
      attempt: null,
      actor: ACTOR,
      causation_id: null,
      correlation_id: missionId,
      trace_id: taskId,
      idempotency_key: idempotencyKey,
      payload,
    },
  })
}

const finishReceipt = async (
  store: Store,
  input: { missionId: string; nodeId: string; status: DagNodeOutcome['status']; taskId?: string; reason?: string },
): Promise<void> => {
  const events = (await store.listEvents(input.missionId)).filter(
    (e) => e.event_type === 'DAG_NODE_FINISHED' && e.payload['node_id'] === input.nodeId,
  )
  const existing = events[0]
  const payload = {
    node_id: input.nodeId,
    status: input.status,
    ...(input.taskId ? { task_id: input.taskId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  }
  if (existing) {
    if (JSON.stringify(existing.payload) !== JSON.stringify(payload)) {
      throw new Error(`DAG node ${input.nodeId} already has a conflicting terminal receipt`)
    }
    return
  }
  await putEvent(
    store,
    input.missionId,
    'DAG_NODE_FINISHED',
    payload,
    `dag-node-finished:${input.missionId}:${input.nodeId}`,
    input.taskId ?? null,
  )
}

const finishFromEvent = (event: Awaited<ReturnType<Store['listEvents']>>[number]): DagNodeOutcome => ({
  status: event.payload['status'] as DagNodeOutcome['status'],
  nodeId: event.payload['node_id'] as string,
  ...(typeof event.payload['task_id'] === 'string' ? { taskId: event.payload['task_id'] } : {}),
  ...(typeof event.payload['reason'] === 'string' ? { reason: event.payload['reason'] } : {}),
})

const toVerifying = async (store: Store, task: TaskRecord): Promise<TaskRecord> => {
  if (task.state === 'VERIFYING' || task.state === 'REVIEWING' || task.state === 'REWORK' || isTerminal(task.state)) return task
  return store.transitionTask({
    taskId: task.id,
    to: 'VERIFYING',
    actor: ACTOR,
    eventType: 'HARD_GATE_EVALUATED',
    idempotencyKey: `dag-verifying:${task.id}`,
  })
}

const toCompletedFromReviewing = async (store: Store, taskId: string): Promise<void> => {
  let task = await store.getTask(taskId)
  if (!task || task.state === 'COMPLETED') return
  if (task.state === 'VERIFYING') {
    task = await store.transitionTask({
      taskId,
      to: 'REVIEWING',
      actor: ACTOR,
      eventType: 'REVIEW_STARTED',
      idempotencyKey: `dag-reviewing:${taskId}`,
    })
  }
  if (task.state === 'REVIEWING') {
    await store.transitionTask({
      taskId,
      to: 'COMPLETED',
      actor: ACTOR,
      eventType: 'REVIEW_ACCEPTED',
      idempotencyKey: `dag-accepted:${taskId}`,
    })
  }
}

const toReworkCompleted = async (
  store: Store,
  taskId: string,
  round: number,
  decision: ReviewDecisionV1,
): Promise<void> => {
  let task = await store.getTask(taskId)
  if (!task || task.state === 'COMPLETED') return
  if (task.state === 'REVIEWING') {
    throw new Error('DAG rework must be applied from VERIFYING, not REVIEWING')
  }
  if (task.state === 'VERIFYING') {
    task = await store.transitionTask({
      taskId,
      to: 'REWORK',
      actor: ACTOR,
      eventType: 'REVIEW_REWORK_REQUESTED',
      idempotencyKey: `dag-rework:${taskId}:${round}`,
      payload: {
        round,
        failed_criteria: decision.failed_criteria?.map((c) => c.criterion_id) ?? [],
      },
    })
  }
  if (task.state === 'REWORK') {
    await store.transitionTask({
      taskId,
      to: 'COMPLETED',
      actor: ACTOR,
      eventType: 'TASK_COMPLETED',
      idempotencyKey: `dag-rework-completed:${taskId}:${round}`,
    })
  }
}

const toFailedTerminal = async (store: Store, taskId: string, reason: string): Promise<void> => {
  let task = await store.getTask(taskId)
  if (!task || task.state === 'FAILED_TERMINAL') return
  if (isTerminal(task.state)) return
  // 执行不确定：保持 INPUT_REQUIRED，由人决定是否重做（ADR-0006 第 7 条）。
  if (task.state === 'INPUT_REQUIRED') return
  if (task.state === 'VERIFYING' || task.state === 'REVIEWING') {
    await store.transitionTask({
      taskId,
      to: 'FAILED_TERMINAL',
      actor: ACTOR,
      eventType: 'REVIEW_ESCALATED',
      idempotencyKey: `dag-failed-terminal:${taskId}`,
      payload: { reason },
    })
    return
  }
  if (task.state === 'REWORK') {
    await store.transitionTask({
      taskId,
      to: 'FAILED_TERMINAL',
      actor: ACTOR,
      eventType: 'TASK_FAILED',
      idempotencyKey: `dag-rework-failed:${taskId}`,
      payload: { reason },
    })
    return
  }
  await store.transitionTask({
    taskId,
    to: 'FAILED_TERMINAL',
    actor: ACTOR,
    eventType: 'TASK_FAILED',
    idempotencyKey: `dag-failed:${taskId}`,
    payload: { reason },
  })
}

const cancelIfNeverDispatched = async (store: Store, task: TaskRecord, reason: string): Promise<void> => {
  if (isTerminal(task.state)) return
  if (!task.binding && ['DRAFT', 'READY', 'QUEUED', 'APPROVAL_REQUIRED', 'WAITING_RESOURCE'].includes(task.state)) {
    await store.transitionTask({
      taskId: task.id,
      to: 'CANCELED',
      actor: ACTOR,
      eventType: 'TASK_CANCELED',
      idempotencyKey: `dag-canceled:${task.id}`,
      payload: { reason },
    })
    return
  }
  await toFailedTerminal(store, task.id, reason)
}

const validateDecision = (decision: ReviewDecisionV1, missionId: string, task: TaskRecord): void => {
  if (decision.schema !== 'cmap/review-decision/v1') throw new Error('invalid review schema')
  if (decision.mission_id !== missionId) throw new Error('review mission_id mismatch')
  if (decision.reviewed_task_ids.length !== 1 || decision.reviewed_task_ids[0] !== task.id) {
    throw new Error('reviewed_task_ids must exactly match task')
  }
  if (decision.decision === 'rework' && (decision.required_followups?.length ?? 0) !== 1) {
    throw new Error('DAG rework review must contain exactly one required_followup')
  }
}

const writeReview = async (
  store: Store,
  task: TaskRecord,
  round: number,
  decision: ReviewDecisionV1,
): Promise<Review> => store.putReview({
  id: reviewId(task.id, round),
  mission_id: task.mission_id,
  reviewed_task_ids: [task.id],
  round,
  decision,
  created_at: now(),
})

const active = (task: TaskRecord): boolean => !isTerminal(task.state)

const withProgress = (
  outcome: Omit<DagNodeOutcome, 'progress'>,
  progress: ProgressSnapshot | undefined,
): DagNodeOutcome => progress ? { ...outcome, progress } : outcome

export const createDagActivities = (deps: ActivityDeps & { readonly workRoot: string }) => {
  const { store } = deps
  const runner = snapshotRunnerDescriptor(deps.runner)
  const base = createActivities(deps)
  const runAttempt = createDagAttemptRunner(deps)
  const adapters = deps.adapters ?? (deps.adapter ? [deps.adapter] : [])

  return {
    async loadDagSchedule(missionId: string): Promise<{
      nodes: readonly { node_id: string; deps: readonly string[] }[]
      concurrency: number
      maxAdditionalCycles: number
      state: MissionState
    }> {
      const { mission, plan } = await getDagMission(store, missionId)
      const budget = mission.constraints['max_additional_cycles']
      if (!Number.isInteger(budget) || (budget as number) < 0) {
        throw new Error(`DAG Mission ${missionId} has invalid attempt budget`)
      }
      if (!TERMINAL_MISSION.has(mission.state) && mission.state !== 'RUNNING') {
        await store.setMissionState(missionId, 'RUNNING', ACTOR, `dag-running:${missionId}`)
      }
      const reread = await store.getMission(missionId)
      if (!reread) throw new Error(`Mission missing: ${missionId}`)
      return {
        nodes: plan.nodes.map((n) => ({ node_id: n.node_id, deps: n.deps })),
        concurrency: plan.concurrency ?? 2,
        maxAdditionalCycles: budget as number,
        state: reread.state,
      }
    },

    async materializeDagNode(input: Parameters<typeof materializeDagTask>[1]) {
      return materializeDagTask({ store, workRoot: deps.workRoot, runner, ...(deps.memory ? { memory: deps.memory } : {}) }, input)
    },

    /**
     * dag/v1 Workflow 只在 Worker 失联（心跳/超时）后重试一次：Activity 自己抛的错一律不可重试，避免二次路由。
     * 重试的 attempt 先确认已落账的 binding 属于重启安全的 Adapter，否则不碰它、照旧升级；没有 binding 说明
     * 此前没有启动过 Agent（binding 先于 startTask 落账），照常首次派发。恢复本身靠 runner 对 binding 的幂等。
     */
    async runDagAttempt(input: { taskId: string }) {
      if (activityAttempt() > 1) {
        const binding = (await store.getTask(input.taskId))?.binding
        if (binding && adapters.find((a) => a.adapterId === binding.adapter)?.restartSafe !== true) {
          throw ApplicationFailure.nonRetryable(`Adapter ${binding.adapter} 不支持 Worker 重启恢复，不重试`, 'ATTEMPT_NOT_RESTART_SAFE')
        }
      }
      try {
        return await runAttempt(input)
      } catch (error) {
        throw ApplicationFailure.fromError(error, { nonRetryable: true })
      }
    },

    async checkDagApproval(taskId: string): Promise<{ decision: 'approved' | 'pending' | 'rejected' }> {
      const task = await store.getTask(taskId)
      if (!task) throw new Error(`任务不存在：${taskId}`)
      if (task.state === 'DRAFT') await base.markReady(taskId)
      const gate = await base.requestApproval(taskId)
      if (!gate.required) return { decision: 'approved' }
      const approval = await store.getApproval(gate.approvalId!)
      if (!approval) throw new Error(`审批不存在：${gate.approvalId}`)
      if (approval.decision === 'pending' && Date.now() >= Date.parse(approval.expires_at)) {
        try {
          await store.decideApproval(approval.id, 'expired', 'system:timeout', now())
        } catch (error) {
          if (!(error instanceof ApprovalDecisionConflictError)) throw error
        }
      }
      const reread = await store.getApproval(approval.id)
      if (!reread) throw new Error(`审批不存在：${approval.id}`)
      if (reread.decision === 'pending') return { decision: 'pending' }
      const waited = await base.waitForApproval({ taskId, approvalId: reread.id, scope: reread.scope })
      return { decision: waited.decision === 'approved' ? 'approved' : 'rejected' }
    },

    async reviewDagAttempt(input: {
      taskId: string
      previousProgress?: ProgressSnapshot
      decision?: ReviewDecisionV1
    }): Promise<DagNodeOutcome> {
      let task = await store.getTask(input.taskId)
      if (!task) throw new Error(`任务不存在：${input.taskId}`)
      const { mission, plan } = await getDagMission(store, task.mission_id)
      const node = nodeById(plan, nodeIdOf(task))
      const terminalReceipt = (await store.listEvents(mission.id))
        .find((e) =>
          e.event_type === 'DAG_NODE_FINISHED' &&
          (e.payload['task_id'] === task!.id || e.payload['node_id'] === node.node_id),
        )
      if (terminalReceipt) return finishFromEvent(terminalReceipt)
      task = await toVerifying(store, task)
      const round = task.attempt - 1
      const hard = input.decision
        ? { decision: input.decision, progress: undefined }
        : await base.evaluateHardGate({ taskId: task.id, round })
      const prior = (await store.listReviews(mission.id)).find((r) => r.id === reviewId(task.id, round))
      const decision = prior?.decision ?? hard.decision
      validateDecision(decision, mission.id, task)

      if (decision.decision === 'accept') {
        if (!dagAttemptSatisfiesNode(mission, node, task)) {
          throw new Error('DAG accept review cannot override failed hard metrics')
        }
        await writeReview(store, task, round, decision)
        await toCompletedFromReviewing(store, task.id)
        await finishReceipt(store, { missionId: mission.id, nodeId: node.node_id, status: 'accepted', taskId: task.id })
        return withProgress(
          { status: 'accepted', nodeId: node.node_id, taskId: task.id, attempt: task.attempt },
          hard.progress,
        )
      }

      if (decision.decision === 'escalate') {
        const reason = decision.escalation?.reason ?? 'REVIEW_ESCALATED'
        await writeReview(store, task, round, decision)
        await toFailedTerminal(store, task.id, reason)
        await finishReceipt(store, { missionId: mission.id, nodeId: node.node_id, status: 'escalated', taskId: task.id, reason })
        return withProgress(
          { status: 'escalated', nodeId: node.node_id, taskId: task.id, attempt: task.attempt, reason },
          hard.progress,
        )
      }

      const budget = mission.constraints['max_additional_cycles'] as number
      if (round >= budget) {
        const reason = 'BUDGET_EXHAUSTED'
        await writeReview(store, task, round, decision)
        await toFailedTerminal(store, task.id, reason)
        await finishReceipt(store, { missionId: mission.id, nodeId: node.node_id, status: 'escalated', taskId: task.id, reason })
        return withProgress(
          { status: 'escalated', nodeId: node.node_id, taskId: task.id, attempt: task.attempt, reason },
          hard.progress,
        )
      }
      if (input.previousProgress && hard.progress) {
        const noProgress = detectNoProgress(input.previousProgress, hard.progress)
        if (noProgress.detected) {
          const reason = 'NO_PROGRESS'
          await writeReview(store, task, round, decision)
          await toFailedTerminal(store, task.id, reason)
          await finishReceipt(store, { missionId: mission.id, nodeId: node.node_id, status: 'escalated', taskId: task.id, reason })
          return withProgress(
            { status: 'escalated', nodeId: node.node_id, taskId: task.id, attempt: task.attempt, reason },
            hard.progress,
          )
        }
      }

      await writeReview(store, task, round, decision)
      await toReworkCompleted(store, task.id, round, decision)
      return withProgress(
        { status: 'rework', nodeId: node.node_id, taskId: task.id, attempt: task.attempt },
        hard.progress,
      )
    },

    async finishDagNode(input: {
      missionId: string
      nodeId: string
      taskId?: string
      status: 'failed' | 'escalated'
      reason: string
    }): Promise<DagNodeOutcome> {
      if (!SAFE_REASON.test(input.reason)) throw new Error('DAG finish reason must be a safe reason code')
      const { plan } = await getDagMission(store, input.missionId)
      nodeById(plan, input.nodeId)
      if (input.taskId) {
        const task = await store.getTask(input.taskId)
        if (!task || task.mission_id !== input.missionId || nodeIdOf(task) !== input.nodeId) {
          throw new Error('DAG finish task does not match node')
        }
        await cancelIfNeverDispatched(store, task, input.reason)
        for (const approval of (await store.listPendingApprovals(input.missionId)).filter((a) => a.task_id === input.taskId)) {
          try {
            await store.decideApproval(approval.id, 'expired', 'system:dag-stopped', now())
          } catch (error) {
            if (!(error instanceof ApprovalDecisionConflictError)) throw error
          }
        }
      }
      await finishReceipt(store, {
        missionId: input.missionId,
        nodeId: input.nodeId,
        status: input.status,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        reason: input.reason,
      })
      return {
        status: input.status,
        nodeId: input.nodeId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        reason: input.reason,
      }
    },

    async finalizeDagMission(missionId: string): Promise<{
      missionId: string
      state: 'COMPLETED' | 'FAILED' | 'ESCALATED' | 'CANCELED'
      taskIds: string[]
      blockedNodeIds: string[]
      nodeOutcomes: DagNodeOutcome[]
    }> {
      const { mission, plan } = await getDagMission(store, missionId)
      const tasks = await store.queryTasks({ missionId })
      const events = await store.listEvents(missionId)
      const receipts = events.filter((e) => e.event_type === 'DAG_NODE_FINISHED').map(finishFromEvent)
      const byNode = new Map(receipts.map((o) => [o.nodeId, o]))
      const taskIds = tasks.map((t) => t.id).sort()

      for (const task of tasks) {
        if (active(task)) throw new Error(`DAG Mission ${missionId} still has active task ${task.id}`)
      }

      const outcomes: DagNodeOutcome[] = []
      const fatal = new Set<string>()
      for (const node of plan.nodes) {
        const receipt = byNode.get(node.node_id)
        if (!receipt) continue
        if (receipt.status === 'accepted') {
          if (!receipt.taskId || !(await acceptedDagAttempt(store, mission, node, receipt.taskId))) {
            throw new Error(`DAG node ${node.node_id} missing accepted proof`)
          }
        } else {
          fatal.add(node.node_id)
        }
        outcomes.push(receipt)
      }

      const blockedNodeIds: string[] = []
      const reachesFatal = (nodeId: string, seen: ReadonlySet<string> = new Set()): boolean => {
        if (fatal.has(nodeId)) return true
        if (seen.has(nodeId)) return false
        const node = nodeById(plan, nodeId)
        const nextSeen = new Set(seen)
        nextSeen.add(nodeId)
        return node.deps.some((dep) => reachesFatal(dep, nextSeen))
      }
      for (const node of plan.nodes) {
        if (byNode.has(node.node_id)) continue
        if (fatal.size > 0) {
          const upstreamBlocked = node.deps.some((dep) => reachesFatal(dep))
          blockedNodeIds.push(node.node_id)
          const reason = upstreamBlocked ? 'UPSTREAM_TERMINAL' : 'GLOBAL_STOP'
          await putEvent(
            store,
            missionId,
            'DAG_NODE_BLOCKED',
            {
              node_id: node.node_id,
              blocked_by: upstreamBlocked ? node.deps.filter((dep) => reachesFatal(dep)) : [...fatal],
              reason,
            },
            `dag-node-blocked:${missionId}:${node.node_id}`,
          )
          outcomes.push({ status: 'failed', nodeId: node.node_id, reason })
          continue
        }
        throw new Error(`DAG Mission ${missionId} missing terminal proof for node ${node.node_id}`)
      }

      const hasEscalated = outcomes.some((o) => o.status === 'escalated' || o.reason?.includes('LOCK') || o.reason?.includes('UNCERTAIN'))
      const hasFailed = outcomes.some((o) => o.status === 'failed')
      const finalState = mission.state === 'CANCELED'
        ? 'CANCELED'
        : hasEscalated
          ? 'ESCALATED'
          : hasFailed
            ? 'FAILED'
            : 'COMPLETED'
      if (mission.state !== 'CANCELED') {
        await store.setMissionState(missionId, finalState, ACTOR, `dag-final:${missionId}:${finalState}`)
      }
      return { missionId, state: finalState, taskIds, blockedNodeIds, nodeOutcomes: outcomes }
    },
  }
}

export type DagActivities = ReturnType<typeof createDagActivities>
