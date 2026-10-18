/**
 * Mission 取消（实施计划 S5 续接）。由 cancelMission 信号驱动，在 Activity 里执行。
 *
 * - 未绑定任务（未派发）直接落 CANCELED，挂着的审批置为 expired；
 * - 已绑定且未出结果的任务调用其 Adapter 的 cancel，确认后落 CANCELED；未确认的保持原状态，
 *   只记 TASK_CANCEL_REQUESTED(confirmed:false)，不伪造取消——执行可能仍在进行；
 * - 已出结果但未评审的任务直接落 CANCELED（执行已结束，评审不再进行）。
 * finalize 时把 Mission 置为 CANCELED。可重复执行：每一步都以账本状态与幂等键为准。
 */
import { ApprovalDecisionConflictError, IllegalTransitionError, isTerminal, type Store, type TaskRecord } from '#domain-model'
import type { AgentAdapter } from '#adapter-sdk'

const ACTOR = { type: 'system', id: 'mission-cancel' } as const
export const MISSION_CANCELED_REASON = 'MISSION_CANCELED'

export interface CancelMissionTasksInput {
  readonly missionId: string
  readonly reason: string
  /** true 时在任务处理完后把 Mission 置为 CANCELED。 */
  readonly finalize?: boolean
}

const toCanceled = async (store: Store, task: TaskRecord): Promise<void> => {
  try {
    await store.transitionTask({
      taskId: task.id, to: 'CANCELED', actor: ACTOR, eventType: 'TASK_CANCELED',
      idempotencyKey: `mission-cancel:${task.id}`, payload: { reason: MISSION_CANCELED_REASON },
    })
  } catch (error) {
    // 并发路径（审批过期、结果采纳）可能已把它推进到终态：以账本最新状态为准。
    if (!(error instanceof IllegalTransitionError)) throw error
    const latest = await store.getTask(task.id)
    if (!latest || !isTerminal(latest.state)) throw error
  }
}

export async function cancelMissionTasks(
  store: Store,
  adapterFor: (adapterId: string) => AgentAdapter | undefined,
  input: CancelMissionTasksInput,
): Promise<{ canceled: string[]; unconfirmed: string[] }> {
  const mission = await store.getMission(input.missionId)
  if (!mission) throw new Error(`Mission 不存在：${input.missionId}`)
  const canceled: string[] = [], unconfirmed: string[] = []
  for (const task of await store.queryTasks({ missionId: mission.id })) {
    if (isTerminal(task.state)) continue
    if (task.binding && !task.result) {
      const adapter = adapterFor(task.binding.adapter)
      let confirmed = false
      if (adapter) {
        try { await adapter.cancel(task.binding, input.reason); confirmed = true } catch { confirmed = false }
      }
      await store.appendEvent({ event: {
        event_type: 'TASK_CANCEL_REQUESTED', event_version: 1, occurred_at: new Date().toISOString(),
        mission_id: mission.id, task_id: task.id, attempt: task.attempt, actor: ACTOR, causation_id: null,
        correlation_id: mission.id, trace_id: task.id, idempotency_key: `mission-cancel-bound:${task.id}:${confirmed}`,
        payload: { adapter: task.binding.adapter, remote_task_id: task.binding.remote_task_id, runner_id: task.binding.runner_id, confirmed },
      } })
      if (!confirmed) { unconfirmed.push(task.id); continue }
    }
    await toCanceled(store, task)
    canceled.push(task.id)
    for (const approval of (await store.listPendingApprovals(mission.id)).filter((a) => a.task_id === task.id)) {
      try { await store.decideApproval(approval.id, 'expired', 'system:mission-canceled', new Date().toISOString()) }
      catch (error) { if (!(error instanceof ApprovalDecisionConflictError)) throw error }
    }
  }
  if (input.finalize) await store.setMissionState(mission.id, 'CANCELED', ACTOR, `mission-canceled:${mission.id}`)
  return { canceled, unconfirmed }
}
