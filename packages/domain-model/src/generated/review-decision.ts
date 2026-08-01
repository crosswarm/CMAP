/* eslint-disable */
/**
 * 本文件由 schemas/review-decision.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 *
 * 注意：本 Schema 含顶层 allOf(if/then) 条件必填约束，无法用 TypeScript
 * 结构类型表达。类型检查通过不代表满足契约——运行时仍须经 ajv 校验。
 */

/**
 * Reviewer（Claude）的评审契约。这是整个系统最初要解决的痛点的正解：把「不满意」从一句自然语言评论，变成控制面可直接据以创建后继 Task 的结构化返工指令。控制面只接受符合本 Schema 的评审。
 */
export interface ReviewDecisionV1 {
  schema: 'cmap/review-decision/v1'
  mission_id: string
  review_round?: number
  /**
   * @minItems 1
   */
  reviewed_task_ids: [string, ...string[]]
  /**
   * accept 仍须通过程序化硬门槛才算最终通过——软判断不得覆盖硬指标。
   */
  decision: 'accept' | 'rework' | 'escalate'
  hard_gate_summary: {
    total: number
    passed: number
    failed: number
  }
  /**
   * decision 为 rework 时必须非空，且每条都要指向具体证据。
   */
  failed_criteria?: {
    criterion_id: string
    expected: string
    actual: string
    reason: string
    /**
     * 支撑该判定的 artifact_id
     */
    evidence?: string[]
  }[]
  /**
   * 证据不足以支撑判定时的缺口说明。缺证据本身就是打回理由，不得靠推测补齐。
   */
  evidence_gaps?: {
    gap_code: string
    description: string
    required_coverage?: number
    actual_coverage?: number
  }[]
  /**
   * 控制面据此自动创建后继 Task。返工一律创建新 Task 并以 supersedes_task_id 关联旧结果，不复用已完成 Task，以保留证据历史与因果链。
   */
  required_followups?: {
    capability: string
    task_type: string
    inputs?: {
      artifact_refs?: string[]
    }
    /**
     * 后继任务的参数，形状由 capability 决定，此处刻意保持自由
     */
    parameters?: {
      [k: string]: unknown
    }
    /**
     * 指明下一轮要收敛的具体方向，避免重复上一轮的无效尝试
     */
    focus?: string[]
  }[]
  /**
   * 无进展检测。不靠自然语言判断，由确定性程序比对相邻两轮。四项中多项同时成立即判定无进展，触发 Challenger 介入或升级。
   */
  no_progress?: {
    detected?: boolean
    consecutive_rounds?: number
    patch_hash_unchanged?: boolean
    failed_criteria_unchanged?: boolean
    metric_improvement_ratio?: number
    same_error_fingerprint?: boolean
  }
  stop_conditions?: {
    /**
     * 预算硬止损。耗尽即升级，绝不无限重试。
     */
    max_additional_cycles: number
  }
  /**
   * decision 为 escalate 时必填：交回人类需要什么信息才能决策。
   */
  escalation?: {
    reason?: string
    options?: {
      label: string
      tradeoff: string
    }[]
    blocking_question?: string
  }
  review_confidence: {
    level: 'low' | 'medium' | 'high'
    score?: number
    limitations?: string[]
  }
  /**
   * 评审者身份。Agent 不得自批授权，也不得把自身判断伪装成人工授权。
   */
  reviewer?: {
    actor_type?: 'agent' | 'human'
    actor_id?: string
    model?: string
    prompt_version?: string
  }
}
