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

import { proxyActivities } from '@temporalio/workflow'
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

export interface MissionWorkflowInput {
  readonly missionId: string
}

export interface MissionWorkflowResult {
  readonly missionId: string
  readonly state: 'COMPLETED' | 'FAILED'
  readonly taskIds: readonly string[]
  /** Agent 交回的结论摘要，便于调用方不查账本也能看到发生了什么。 */
  readonly summary: string
  /** 未通过的验收标准。state 为 COMPLETED 时必为空。 */
  readonly failedCriteria: readonly string[]
}

export async function missionWorkflow(
  input: MissionWorkflowInput,
): Promise<MissionWorkflowResult> {
  const { missionId } = input

  await acts.setMissionState({ missionId, state: 'RUNNING' })

  // ID 来自 Activity 返回值。该值被记入 Event History，
  // 重放时取缓存——这正是它不能在 Workflow 里生成的原因。
  // 目标与验收标准由 Activity 从 Mission 抄进信封，Workflow 不复述。
  const { taskId } = await acts.createTask({
    missionId,
    // P3 的能力路由才会按 capability 选 Adapter；现在只有 codex 一家。
    capability: 'code.analyze',
  })

  await acts.markReady(taskId)

  // 派发：写 Ledger 与调 Adapter 在同一 Activity 内完成。
  // 重复执行时该 Activity 会发现已有 binding 并跳过，不重复派发。
  await acts.dispatchTask(taskId)

  // 等 Agent 干完并收结果。验收结论由确定性程序判定，不看 Agent 的措辞。
  const collected = await longRunning.collectTaskResult(taskId)

  if (!collected.passed) {
    const reason =
      collected.failedCriteria.length > 0
        ? `验收未通过：${collected.failedCriteria.join(', ')}`
        : `Agent 未成功完成：${collected.status}`
    await acts.failTask({ taskId, reason })
    await acts.setMissionState({ missionId, state: 'FAILED' })
    return {
      missionId,
      state: 'FAILED',
      taskIds: [taskId],
      summary: collected.summary,
      failedCriteria: collected.failedCriteria,
    }
  }

  await acts.completeTask(taskId)
  await acts.setMissionState({ missionId, state: 'COMPLETED' })

  return {
    missionId,
    state: 'COMPLETED',
    taskIds: [taskId],
    summary: collected.summary,
    failedCriteria: [],
  }
}
