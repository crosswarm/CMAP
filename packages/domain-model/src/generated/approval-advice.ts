/* eslint-disable */
/**
 * 本文件由 schemas/approval-advice.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * 模型建议不等于新授权。can_continue 不能覆盖宿主 hooks 或替代 CMAP 真人批准。仅输出输入哈希和决策元数据。
 */
export interface ApprovalAdviceV1 {
  schema: 'cmap/approval-advice/v1'
  request_id: string
  recommendation: 'continue' | 'review' | 'reject' | 'insufficient'
  can_continue: boolean
  reason_code:
    | 'within_existing_authorization'
    | 'human_required'
    | 'authorization_missing'
    | 'scope_mismatch'
    | 'production_or_irreversible'
    | 'model_review'
    | 'model_reject'
    | 'uncertain'
    | 'unavailable'
  input_sha256: string
  model: string | null
  confidence: number | null
  elapsed_ms: number
  usage: {
    input_tokens: number
    output_tokens: number
  }
}
