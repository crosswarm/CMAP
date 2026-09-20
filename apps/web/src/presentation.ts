import type {
  Approval,
  Mission,
  TaskRecord,
  Review,
  AcceptanceCriterion,
} from '#domain-model'
import { recomputeCriterionPassed } from '#domain-model/criterion-check'

export const statusLabels: Record<string, string> = {
  DRAFT: '等待启动',
  PLANNING: '规划中',
  READY: '准备就绪',
  QUEUED: '已排队',
  RUNNING: '进行中',
  WAITING_RESOURCE: '正常等待资源',
  APPROVAL_REQUIRED: '等你审批',
  AWAITING_APPROVAL: '等你审批',
  INPUT_REQUIRED: '需要补充信息',
  AUTH_REQUIRED: '需要登录',
  VERIFYING: '核验中',
  REVIEWING: '评审中',
  REWORK: '自动返工',
  COMPLETED: '已完成',
  FAILED_RETRYABLE: '等待重试',
  FAILED_TERMINAL: '终止失败',
  FAILED: '未通过',
  ESCALATED: '等待介入',
  CANCELED: '已取消',
  REJECTED: '已拒绝',
}
export const operatorLabels: Record<AcceptanceCriterion['operator'], string> = {
  lt: '小于',
  lte: '不大于',
  gt: '大于',
  gte: '不小于',
  eq: '等于',
  neq: '不等于',
  contains: '包含',
  not_contains: '不包含',
}
export const stateTone = (state: string) => {
  if (state === 'COMPLETED') return 'success'
  if (
    [
      'APPROVAL_REQUIRED',
      'AWAITING_APPROVAL',
      'INPUT_REQUIRED',
      'AUTH_REQUIRED',
      'ESCALATED',
      'REWORK',
    ].includes(state)
  )
    return 'attention'
  if (['FAILED', 'FAILED_TERMINAL', 'REJECTED'].includes(state)) return 'danger'
  return 'neutral'
}
export const needsAction = (state: string) =>
  [
    'AWAITING_APPROVAL',
    'APPROVAL_REQUIRED',
    'INPUT_REQUIRED',
    'AUTH_REQUIRED',
    'ESCALATED',
    'FAILED',
    'FAILED_TERMINAL',
  ].includes(state)
export const missionDisplayState = (
  mission: Mission,
  tasks: readonly TaskRecord[],
): string => {
  if (mission.state !== 'RUNNING') return mission.state
  const priority = [
    'APPROVAL_REQUIRED',
    'INPUT_REQUIRED',
    'AUTH_REQUIRED',
    'FAILED_TERMINAL',
    'RUNNING',
    'WAITING_RESOURCE',
    'FAILED_RETRYABLE',
    'QUEUED',
    'READY',
  ]
  return (
    priority.find((state) => tasks.some((task) => task.state === state)) ??
    mission.state
  )
}
export const showValue = (value: unknown) =>
  value === undefined
    ? '—'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value)
export const showTime = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '时间未知'
    : new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date)
}

export function acceptanceRows(
  mission: Mission,
  tasks: readonly TaskRecord[],
  reviews: readonly Review[],
) {
  const ordered = [...tasks].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  )
  const source = ordered.find((task) => task.result)
  const review =
    source &&
    [...reviews]
      .filter((r) => r.reviewed_task_ids.includes(source.id))
      .sort((a, b) => b.round - a.round)[0]
  return mission.acceptance.map((criterion) => {
    const answer = source?.result?.criterion_results.find(
      (r) => r.criterion_id === criterion.criterion_id,
    )
    const failed = review?.decision.failed_criteria?.find(
      (f) => f.criterion_id === criterion.criterion_id,
    )
    const state = !source
      ? 'pending'
      : !answer
        ? 'unanswered'
        : !review
          ? 'pending'
          : failed || !recomputeCriterionPassed(criterion, answer)
            ? 'failed'
            : 'passed'
    return {
      criterion,
      actual: answer?.actual,
      state,
      reason: failed?.reason,
      sourceTask: source?.id,
      previousRound: Boolean(source && source.id !== ordered[0]?.id),
    }
  })
}

export function approvalPayload(
  approval: Approval,
  scope: Approval['scope'],
  decision: 'approved' | 'rejected',
  actor: string,
  now = Date.now(),
) {
  if (approval.scope !== scope)
    throw new Error('审批范围已改变，请重新查看请求')
  if (!actor.trim()) throw new Error('未配置当前操作者')
  if (approval.decision !== 'pending')
    throw new Error('此请求已处理，请刷新后查看')
  if (
    decision === 'approved' &&
    (!Number.isFinite(Date.parse(approval.expires_at)) ||
      Date.parse(approval.expires_at) <= now)
  ) {
    throw new Error('请求已过期，不能批准')
  }
  return { scope, decision, decided_by: actor }
}

export function expectedValue(
  type: 'number' | 'string' | 'boolean',
  value: string,
): string | number | boolean {
  if (type === 'string') return value
  if (type === 'boolean') {
    if (value !== 'true' && value !== 'false') throw new Error('请选择是或否')
    return value === 'true'
  }
  if (!value.trim() || !Number.isFinite(Number(value)))
    throw new Error('期望值必须是有限数字')
  return Number(value)
}
