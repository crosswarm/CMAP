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
   * 控制面据此自动创建后继 Task。返工一律创建新 Task 并以 supersedes_task_id 关联旧结果，不复用已完成 Task，以保留证据历史与因果链。启用 mission-followup-queue-v1 的 Mission 必须按声明顺序 FIFO 执行全部后继，所有叶任务通过且队列为空才完成；每个后继继承自己父任务的进展和轮次深度。自动执行限每次 16 个后继、每 Mission 128 个已发现任务；超限在下一次外部派发前停止，已创建但未启动的任务全部明确取消并以 MISSION_TASK_LIMIT 升级。分支升级、拒绝或已知执行失败同样停止派发并清理已证明的待执行队列；已启动且终态不明的任务不伪造终止。旧无 patch 历史保留原命令顺序供重放，不宣称已修复旧历史中遗漏的子任务。
   */
  required_followups?: {
    capability: string
    task_type: string
    inputs?: {
      /**
       * 产物 ID，按声明顺序保留。新 followup format2 由控制面解析同 Mission、同 tenant/owner 的已收取终态产物，冻结 source_task_id/role/hash/目标相对路径；未知、未就绪或无权限引用拒绝，不将 ID 当文件路径。
       */
      artifact_refs?: string[]
    }
    /**
     * 后继任务的 JSON 参数，形状由 capability 决定。新 followup format2 原样深拷贝到 TaskEnvelope.inputs.parameters；task_type 同样保留为后继任务类型。参数不覆盖风险、权限或派发策略。旧格式回执仍按已冻结的旧任务形状恢复。
     */
    parameters?: {
      [k: string]: unknown
    }
    /**
     * 指明下一轮要收敛的具体方向。控制面硬门槛评审生成的 focus 必须保留 Mission 原始目标，再列失败标准，避免后继任务只看到数字而丢失实际交付要求。
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
