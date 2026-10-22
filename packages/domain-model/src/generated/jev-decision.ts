/* eslint-disable */
/**
 * 本文件由 schemas/jev-decision.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 *
 * 注意：本 Schema 含顶层 allOf(if/then) 条件必填约束，无法用 TypeScript
 * 结构类型表达。类型检查通过不代表满足契约——运行时仍须经 ajv 校验。
 */

export type Identifier = string
export type Sha256 = string

/**
 * Jev 在委托策略内做出的一次决定的账本记录（ADR-0007）。有效风险 = max(信封声明风险的下限, 确定性规则, Jev 评估)，只升不降。route=auto 表示控制面已按策略自动执行；高风险、影子模式、Jev 判升级或模型不可用一律 route=human。只存哈希与枚举，不存动作正文、理由原文或原始模型响应。
 */
export interface JevDecisionV1 {
  schema: 'cmap/jev-decision/v1'
  decision_id: string
  decision_type: 'approval' | 'routing' | 'retry_uncertain'
  subject: {
    mission_id: Identifier
    task_id: Identifier
    approval_id?: Identifier
    approval_scope?: 'controlled' | 'mutating'
  }
  policy_id: string
  policy_sha256: Sha256
  mode: 'shadow' | 'enforce'
  input_sha256: Sha256
  model: string | null
  confidence: number | null
  declared_risk: 'read-meta' | 'read-sensitive' | 'controlled' | 'mutating'
  assessed_risk: 'low' | 'medium' | 'high' | null
  effective_risk: 'low' | 'medium' | 'high'
  outcome: 'approve' | 'reject' | 'assign' | 'retry' | 'escalate'
  assigned_agent?: Identifier
  route: 'auto' | 'human'
  reason_code:
    | 'within_policy'
    | 'shadow_mode'
    | 'assessed_high_risk'
    | 'deterministic_high_risk'
    | 'below_confidence'
    | 'budget_exhausted'
    | 'policy_missing'
    | 'policy_expired'
    | 'policy_scope_mismatch'
    | 'jev_unavailable'
    | 'jev_invalid_output'
  decided_at: string
  elapsed_ms: number
}
