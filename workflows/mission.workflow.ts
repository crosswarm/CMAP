/**
 * Mission Workflow。
 *
 * 只做确定性的流程推进：决定下一步派谁、等什么、是否返工。
 * 一切副作用（写 Ledger、调 Adapter、生成 ID）都在 Activity 里。
 *
 * 确定性约束（违反会导致重放行为不一致，且症状只在崩溃恢复时出现）：
 *   - 禁用 Date.now() / Math.random() / 无参 new Date()
 *   - 禁用直接 IO
 *   - ID 一律由 Activity 生成并返回，本文件只传递不创造
 *
 * 依赖方向是单向的：Workflow → Activity → Ledger。
 * Ledger 是唯一业务真相源，Workflow 不把业务判断建立在 Temporal
 * 内部状态上（见 ADR-0005）。
 */

import { ActivityFailure, isCancellation, patched, proxyActivities } from '@temporalio/workflow'

import type { ProgressSnapshot } from '#domain-model'
import type { Activities } from './activities.ts'

const acts = proxyActivities<Activities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '2s',
    backoffCoefficient: 2,
    maximumAttempts: 3,
  },
})

/**
 * 等 Agent 干活的那一步单独放宽超时，并要求心跳。
 *
 * 与其他 Activity 共用 5 分钟会把「Agent 还在正常干活」误判成超时，
 * 进而重跑——那等于同一个任务被执行两次。重试次数压到 2：收结果是幂等的，
 * 但每次重试都要重新等一轮，多试没有收益。
 */
const longRunning = proxyActivities<Activities>({
  startToCloseTimeout: '2 hours',
  heartbeatTimeout: '2 minutes',
  retry: {
    initialInterval: '5s',
    backoffCoefficient: 2,
    maximumAttempts: 2,
  },
})

/** 人工审批可跨小时或跨天，不能沿用 Agent 执行的 2 小时上限。 */
const approvalWait = proxyActivities<Activities>({
  startToCloseTimeout: '7 days',
  heartbeatTimeout: '2 minutes',
  retry: {
    initialInterval: '5s',
    backoffCoefficient: 2,
    maximumAttempts: 3,
  },
})

const MAX_FOLLOWUPS_PER_TASK = 16
const MAX_DISCOVERED_TASKS = 128
const FOLLOWUP_QUEUE_PATCH = 'mission-followup-queue-v1'
/** S5 协作/交接：旧历史重放时 patched() 为 false，不插入新 Activity。 */
const KNOWLEDGE_PATCH = 'mission-knowledge-propose-v1'
const HANDOFF_PATCH = 'mission-escalation-handoff-v1'

type StopReason = Parameters<Activities['cancelPendingMissionTasks']>[0]['reason']

interface QueueEntry {
  readonly taskId: string
  readonly round: number
  readonly previousProgress: ProgressSnapshot | null
}

export interface MissionWorkflowInput {
  readonly missionId: string
}

export interface MissionWorkflowResult {
  readonly missionId: string
  /** ESCALATED 表示自动返工已停止，等人介入——与「失败」是两回事。 */
  readonly state: 'COMPLETED' | 'ESCALATED' | 'FAILED'
  /** 按轮次顺序排列，含每一轮返工派生的后继任务。 */
  readonly taskIds: readonly string[]
  /** Agent 交回的结论摘要，便于调用方不查账本也能看到发生了什么。 */
  readonly summary: string
  /** 最后一轮未通过的验收标准。state 为 COMPLETED 时必为空。 */
  readonly failedCriteria: readonly string[]
  /** 停止自动返工的原因：轮次耗尽，还是判定无进展。 */
  readonly escalationReason?: string
  /** 实际跑了几轮。0 表示一次过。 */
  readonly rounds: number
}

export async function missionWorkflow(
  input: MissionWorkflowInput,
): Promise<MissionWorkflowResult> {
  const { missionId } = input

  await acts.setMissionState({ missionId, state: 'RUNNING' })

  // ID 来自 Activity 返回值。该值被记入 Event History，
  // 重放时取缓存——这正是它不能在 Workflow 里生成的原因。
  // 目标与验收标准由 Activity 从 Mission 抄进信封，Workflow 不复述。
  const first = await acts.createTask({
    missionId,
    // P3 的能力路由才会按 capability 选 Adapter；现在只有 codex 一家。
    capability: 'code.analyze',
  })

  const taskIds: string[] = []
  const seen = new Set<string>()
  const queue: QueueEntry[] = []
  let current: QueueEntry = { taskId: first.taskId, round: 0, previousProgress: null }
  let branched = false
  let maxRound = 0

  const remember = (ids: readonly string[]): void => {
    for (const id of ids) {
      if (seen.has(id)) throw new Error(`任务 ${id} 被重复发现`)
      seen.add(id)
      taskIds.push(id)
    }
  }
  remember([first.taskId])

  // 旁路回写 Memross：Activity 自己吞掉 Memross 错误；这里再兜住 Activity 失败，不改变 Mission 结果。
  const sideEffect = async (run: () => Promise<void>): Promise<void> => {
    try { await run() } catch (error) { if (isCancellation(error)) throw error }
  }
  const proposeKnowledge = (taskId: string) => sideEffect(async () => {
    if (patched(KNOWLEDGE_PATCH)) await acts.proposeTaskKnowledge({ missionId, taskId })
  })
  const escalated = async (result: MissionWorkflowResult): Promise<MissionWorkflowResult> => {
    await sideEffect(async () => {
      if (patched(HANDOFF_PATCH)) await acts.recordEscalationHandoff({ missionId, reason: result.escalationReason ?? result.summary })
    })
    return result
  }

  const pendingIds = (): readonly string[] => queue.map((item) => item.taskId)
  const cancelPending = async (reason: StopReason): Promise<readonly string[]> => {
    const ids = pendingIds()
    if (ids.length > 0) await acts.cancelPendingMissionTasks({ missionId, taskIds: ids, reason })
    return ids
  }

  // 返工循环。出口只有三个：验收通过、轮次耗尽、判定无进展——
  // 后两个都交给人，绝不无限重试。
  for (;;) {
    const { taskId, round, previousProgress } = current
    maxRound = Math.max(maxRound, round)
    let recoverActivityFailure = branched

    try {
      await acts.markReady(taskId)

      // controlled 与 mutating 都必须在人明确批准后才派发，且两类授权互不蕴含。
      const gate = await acts.requestApproval(taskId)
      if (gate.required && gate.approvalId && gate.scope) {
        await acts.setMissionState({
          missionId,
          state: 'AWAITING_APPROVAL',
          idempotencyKey: `approval-wait:${taskId}`,
        })
        const approval = await approvalWait.waitForApproval({
          taskId,
          approvalId: gate.approvalId,
          scope: gate.scope,
        })

        if (approval.decision === 'rejected') {
          recoverActivityFailure = false
          await cancelPending('APPROVAL_REJECTED')
          await acts.setMissionState({ missionId, state: 'FAILED' })
          return {
            missionId,
            state: 'FAILED',
            taskIds,
            summary: `审批被 ${approval.decidedBy} 拒绝`,
            failedCriteria: [],
            rounds: maxRound,
          }
        }

        await acts.setMissionState({
          missionId,
          state: 'RUNNING',
          idempotencyKey: `approval-resumed:${taskId}`,
        })
      }

      // 派发：写 Ledger 与调 Adapter 在同一 Activity 内完成。
      // 重复执行时该 Activity 会发现已有 binding 并跳过，不重复派发。
      const dispatch = await acts.dispatchTask(taskId)
      if ('admissionDenied' in dispatch) {
        const prefix=dispatch.admissionDenied.phase==='initial'?'RUNNER_ADMISSION_DENIED':'RUNNER_ADMISSION_REVOKED'
        recoverActivityFailure = false
        await cancelPending('ADMISSION_DENIED')
        await acts.setMissionState({missionId,state:'ESCALATED',idempotencyKey:`admission:${taskId}`})
        return escalated({missionId,state:'ESCALATED',taskIds,summary:`${prefix}:${dispatch.admissionDenied.code}`,failedCriteria:[],rounds:maxRound})
      }

      // 等 Agent 干完并收结果。
      const collected = await longRunning.collectTaskResult(taskId)
      if ('executionUncertain' in collected) {
        const reason = `EXECUTION_UNCERTAIN:${collected.executionUncertain.code}`
        recoverActivityFailure = false
        await cancelPending('EXECUTION_UNCERTAIN')
        await acts.setMissionState({
          missionId,
          state: 'ESCALATED',
          idempotencyKey: `mission-execution-uncertain:${taskId}`,
        })
        return escalated({
          missionId,
          state: 'ESCALATED',
          taskIds,
          summary: reason,
          failedCriteria: [],
          escalationReason: reason,
          rounds: maxRound,
        })
      }
      if (collected.admissionDenied) {
        recoverActivityFailure = false
        await cancelPending('ADMISSION_DENIED')
        await acts.setMissionState({missionId,state:'ESCALATED',idempotencyKey:`admission:${taskId}`})
        return escalated({missionId,state:'ESCALATED',taskIds,summary:collected.summary,failedCriteria:[],rounds:maxRound})
      }

      // 硬门槛由确定性程序判定，不看 Agent 的措辞。
      await acts.markVerifying(taskId)
      const { decision, progress } = await acts.evaluateHardGate({ taskId, round })

      // 通过的才进评审态收尾；没过的从 VERIFYING 直接进 REWORK，
      // 不经过 REVIEWING——那会在事件流里显示一场并不存在的评审。
      if (decision.decision === 'accept') await acts.beginReview(taskId)

      recoverActivityFailure = false
      const outcome = await acts.applyReviewDecision({
        taskId,
        decision,
        round,
        ...(previousProgress ? { previousProgress } : {}),
        currentProgress: progress,
      })

      if (outcome.outcome === 'accept') {
        await proposeKnowledge(taskId)
        const next = queue.shift()
        if (next) {
          current = next
          continue
        }
        recoverActivityFailure = false
        await acts.setMissionState({ missionId, state: 'COMPLETED' })
        return {
          missionId,
          state: 'COMPLETED',
          taskIds,
          summary: collected.summary,
          failedCriteria: [],
          rounds: maxRound,
        }
      }

      if (outcome.outcome === 'escalated') {
        recoverActivityFailure = false
        await cancelPending('BRANCH_ESCALATED')
        // Mission 状态已由 applyReviewDecision 置为 ESCALATED
        return escalated({
          missionId,
          state: 'ESCALATED',
          taskIds,
          summary: collected.summary,
          failedCriteria: collected.failedCriteria,
          ...(outcome.escalationReason ? { escalationReason: outcome.escalationReason } : {}),
          rounds: maxRound,
        })
      }

      const followups = [...outcome.followupTaskIds]
      if (!branched && followups.length > 1 && patched(FOLLOWUP_QUEUE_PATCH)) branched = true
      if (!branched) {
        const next = followups[0]
        if (!next) {
          // 判了返工却没派生后继任务，说明决策与执行不一致。继续循环会
          // 原地重跑同一个已完成的任务，不如在这里明确失败。
          throw new Error(`任务 ${taskId} 判定返工但没有后继任务`)
        }
        remember([next])
        current = { taskId: next, round: round + 1, previousProgress: progress }
        continue
      }

      if (followups.length === 0) throw new Error(`任务 ${taskId} 判定返工但没有后继任务`)
      if (followups.length > MAX_FOLLOWUPS_PER_TASK || taskIds.length + followups.length > MAX_DISCOVERED_TASKS) {
        const toCancel = [...pendingIds(), ...followups]
        remember(followups)
        recoverActivityFailure = false
        if (toCancel.length > 0) {
          await acts.cancelPendingMissionTasks({ missionId, taskIds: toCancel, reason: 'MISSION_TASK_LIMIT' })
        }
        await acts.setMissionState({ missionId, state: 'ESCALATED', idempotencyKey: `mission-task-limit:${taskId}` })
        return escalated({
          missionId,
          state: 'ESCALATED',
          taskIds,
          summary: collected.summary,
          failedCriteria: collected.failedCriteria,
          escalationReason: 'MISSION_TASK_LIMIT',
          rounds: maxRound,
        })
      }

      remember(followups)
      queue.push(...followups.map((id) => ({ taskId: id, round: round + 1, previousProgress: progress })))
      current = queue.shift()!
    } catch (error) {
      if (isCancellation(error)) throw error
      if (!branched || !recoverActivityFailure || !(error instanceof ActivityFailure)) throw error
      recoverActivityFailure = false
      await cancelPending('WORKFLOW_ACTIVITY_FAILED')
      await acts.setMissionState({ missionId, state: 'ESCALATED', idempotencyKey: `workflow-activity-failed:${taskId}` })
      return escalated({
        missionId,
        state: 'ESCALATED',
        taskIds,
        summary: 'WORKFLOW_ACTIVITY_FAILED',
        failedCriteria: [],
        escalationReason: 'WORKFLOW_ACTIVITY_FAILED',
        rounds: maxRound,
      })
    }
  }
}
