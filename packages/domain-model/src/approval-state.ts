import type { Approval } from './entities.ts'
import type { ApprovalDecisionInputV1 } from './generated/approval-decision-input.ts'

export class ApprovalDecisionConflictError extends Error {
  constructor(id: string, reason: string) {
    super(`审批 ${id} 无法决策：${reason}`)
    this.name = 'ApprovalDecisionConflictError'
  }
}

/** 两种 Store 共用同一转换规则；PG 必须在行锁内调用。 */
export const decideApprovalState = (approval: Approval, input: ApprovalDecisionInputV1): Approval => {
  const at = Date.parse(input.at)
  const created = Date.parse(approval.created_at)
  const expires = Date.parse(approval.expires_at)
  if (!['approved', 'rejected', 'expired'].includes(input.decision) ||
      typeof input.decided_by !== 'string' || !input.decided_by.trim() ||
      !Number.isFinite(at) || !Number.isFinite(created) || !Number.isFinite(expires) || at < created) {
    throw new RangeError('审批决定、身份或时间无效')
  }
  if (approval.decision !== 'pending') {
    if (approval.decision === input.decision && approval.decided_by === input.decided_by) return approval
    throw new ApprovalDecisionConflictError(approval.id, '已有终态决定，不能覆盖')
  }
  if (input.decision === 'approved' && at >= expires) {
    throw new ApprovalDecisionConflictError(approval.id, '审批已过期')
  }
  return { ...approval, decision: input.decision, decided_by: input.decided_by, decided_at: input.at }
}
