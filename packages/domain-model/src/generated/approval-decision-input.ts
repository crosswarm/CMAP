/* eslint-disable */
/**
 * 本文件由 schemas/approval-decision-input.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * Store 审批终态转换。仅 pending 可转换；同一 decision 和 decided_by 的重试返回原记录，不改首次时间；冲突决定必须拒绝。批准时间必须在 created_at（含）与 expires_at（不含）之间。at 由可信控制面提供，不接受浏览器时间。expired 也可用于控制面等待预算耗尽，不覆盖已决策记录。
 */
export interface ApprovalDecisionInputV1 {
  decision: 'approved' | 'rejected' | 'expired'
  decided_by: string
  at: string
}
