/* eslint-disable */
/**
 * 本文件由 schemas/review-application.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 *
 * 注意：本 Schema 含顶层 allOf(if/then) 条件必填约束，无法用 TypeScript
 * 结构类型表达。类型检查通过不代表满足契约——运行时仍须经 ajv 校验。
 */

/**
 * Private ledger receipt payload. One immutable application per Task; round and canonical semantic input SHA bind decision/progress. Missing progress normalizes to null; object keys and failedCriteriaIds sort, other array order remains significant. Events contain no raw decisions, focus text or prompts. Intent precedes review/child/state writes; completion is appended only after exact child/source/Mission proof. Same idempotency key with changed semantic event fields conflicts, timestamps and generated IDs do not.
 */
export interface ReviewApplicationV1 {
  schema: 'cmap/review-application/v1'
  phase: 'intent' | 'complete'
  round: number
  input_sha256: string
  review_id: string
  output: {
    outcome: 'accept' | 'rework' | 'escalated'
    followupTaskIds: string[]
    escalationReason?: string
  }
}
