/* eslint-disable */
/**
 * 本文件由 schemas/task-result.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * Agent 回报给控制面的结果契约。Adapter 必须把厂商输出归一化为本结构——Workflow 不得直接解析 Agent 的自然语言终端输出。
 */
export interface TaskResultV1 {
  schema: 'cmap/task-result/v1'
  mission_id: string
  task_id: string
  attempt: number
  status: 'completed' | 'failed' | 'input_required' | 'auth_required' | 'canceled' | 'rejected'
  summary: string
  confidence?: {
    level: 'low' | 'medium' | 'high'
    score?: number
    /**
     * 如实声明覆盖边界，例如仅覆盖单一网络环境
     */
    limitations?: string[]
  }
  /**
   * 逐条回应信封中的 success_definition。缺失任一 criterion_id 视为结果不完整。
   */
  criterion_results: {
    criterion_id: string
    expected?: {
      operator?: string
      value?: unknown
    }
    actual?: unknown
    unit?: string
    passed: boolean
    /**
     * 结论必须可追溯到原始 Artifact
     */
    evidence_artifact_ids?: string[]
  }[]
  findings?: {
    severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
    code: string
    description: string
    evidence_artifact_ids?: string[]
  }[]
  /**
   * 证据产物。evidence_requirements 声明的 role 若缺失，控制面判 failed，不接受 rc=0 作为成功依据。
   */
  artifacts: {
    artifact_id: string
    role: string
    uri: string
    media_type?: string
    size_bytes?: number
    /**
     * 内容寻址。防止证据被覆盖导致结论不可验证。
     */
    sha256: string
  }[]
  /**
   * Agent 侧的会话标识，供事后诊断与追溯。控制面不走续跑路线——返工一律派生新 Task 以保留证据历史。
   */
  session?: {
    provider_session_id?: string
    worktree?: string
    commit_sha?: string | null
  }
  /**
   * YonWork chat send 专用。SSE 连接建立或心跳不能证明消息完成——必须观测到终态才可标记 success。这是最容易误判成功的一处。
   */
  sse_observations?: {
    accepted?: boolean
    delta_observed?: boolean
    complete_observed?: boolean
    history_observed?: boolean
    run_id?: string
    request_id?: string
  }
  /**
   * 执行能力降级须如实标注，不得以低等级冒充高等级。等级定义见 execution-portability.md。
   */
  degradation?: {
    level?: 'A' | 'B' | 'C' | 'D'
    reason?: string
    capability_gaps?: string[]
  }
  error?: {
    code?: string
    message?: string
    retryable?: boolean
    /**
     * 错误指纹，供无进展检测比对相邻两轮是否同一错误
     */
    fingerprint?: string
  }
  cost?: {
    tokens?: number
    duration_seconds?: number
    cost_units?: number
  }
  recommended_followups?: {
    capability: string
    reason: string
  }[]
}
