/* eslint-disable */
/**
 * 本文件由 schemas/delegation-policy.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

export type Identifier = string
/**
 * @minItems 1
 * @maxItems 128
 */
export type Capabilities = [Identifier, ...Identifier[]]

/**
 * 真人签发的委托策略（ADR-0007）：授权来源是本策略，不是 Jev 的置信度。策略只能在确定性兜底规则之内收窄 Jev 可代为决定的范围，不能放宽兜底规则。controlled 与 mutating 逐 scope 委托、互不蕴含；mutating 只能委托不推送的改动；执行不确定后的重做只限只读级风险。shadow 模式下 Jev 的决定只记录、不执行。
 */
export interface DelegationPolicyV1 {
  schema: 'cmap/delegation-policy/v1'
  policy_id: string
  tenant: Identifier
  /**
   * 签发策略的真人；Agent 或 Jev 身份无效。
   */
  issued_by: string
  issued_at: string
  expires_at: string
  mode: 'shadow' | 'enforce'
  min_confidence: number
  /**
   * 每租户每 UTC 日 Jev 自动执行决定的上限；0 表示不自动执行。
   */
  daily_auto_budget: number
  /**
   * @minItems 1
   * @maxItems 64
   */
  rules: [ApprovalRule | RoutingRule | RetryRule, ...(ApprovalRule | RoutingRule | RetryRule)[]]
}
export interface ApprovalRule {
  decision_type: 'approval'
  approval_scope: 'controlled' | 'mutating'
  capabilities: Capabilities
  /**
   * @minItems 1
   */
  outcomes: ['approve' | 'reject', ...('approve' | 'reject')[]]
  require_no_push?: true
}
export interface RoutingRule {
  decision_type: 'routing'
  capabilities: Capabilities
}
export interface RetryRule {
  decision_type: 'retry_uncertain'
  capabilities: Capabilities
  max_declared_risk: 'read-meta' | 'read-sensitive'
}
