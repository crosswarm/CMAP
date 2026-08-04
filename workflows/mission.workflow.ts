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

export interface MissionWorkflowInput {
  readonly missionId: string
}

export interface MissionWorkflowResult {
  readonly missionId: string
  readonly state: 'COMPLETED'
  readonly taskIds: readonly string[]
}

export async function missionWorkflow(
  input: MissionWorkflowInput,
): Promise<MissionWorkflowResult> {
  const { missionId } = input

  await acts.setMissionState({ missionId, state: 'RUNNING' })

  // ID 来自 Activity 返回值。该值被记入 Event History，
  // 重放时取缓存——这正是它不能在 Workflow 里生成的原因。
  const { taskId } = await acts.createTask({
    missionId,
    capability: 'code.analyze',
    goal: '验证 Workflow 骨架可运行',
  })

  await acts.markReady(taskId)

  // 派发：写 Ledger 与调 Adapter 在同一 Activity 内完成。
  // 重复执行时该 Activity 会发现已有 binding 并跳过，不重复派发。
  await acts.dispatchTask(taskId)

  await acts.completeTask(taskId)

  await acts.setMissionState({ missionId, state: 'COMPLETED' })

  return { missionId, state: 'COMPLETED', taskIds: [taskId] }
}
