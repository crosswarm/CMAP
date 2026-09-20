/* eslint-disable */
/**
 * 本文件由 schemas/codex-output.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * Agent 输出契约：Codex 通过 --output-schema 强制输出，Kimi 在提示中使用同一结构并由 Adapter 在运行时严格校验。这不是账本格式，而是「Agent 只报告它知道的事实」——mission_id/task_id/attempt 等身份字段由控制面补全，因为账本归控制面所有，Agent 无权自述身份。Adapter 收到本结构后合成完整 TaskResultV1，再经严格 Schema 校验入账本。
 */
export interface CodexOutputV1 {
  /**
   * 无法完成时填 failed 并在 error 中说明，不要伪造通过
   */
  status: 'completed' | 'failed' | 'input_required' | 'auth_required'
  /**
   * 一句话结论
   */
  summary: string
  /**
   * 逐条回应信封中每个 criterion_id，一条都不能少
   */
  criterion_results: {
    criterion_id: string
    /**
     * 实测值，统一以字符串表达，数值也写成字符串
     */
    actual: string
    passed: boolean
    /**
     * 支撑该判定的 artifact_id，必须能在 artifacts 中找到
     */
    evidence_artifact_ids: string[]
  }[]
  /**
   * 证据产物。同一输出的 artifact_id 不得重复，criterion_results 中的证据引用必须指向本列表。必须是真实写入磁盘的文件，sha256 必须是文件内容的真实哈希——控制面会独立复算，对不上即判失败。
   */
  artifacts: {
    artifact_id: string
    /**
     * 必须与信封 evidence_requirements 声明的角色一致
     */
    role: string
    /**
     * 相对于工作目录的路径，例如 evidence/report.json
     */
    uri: string
    media_type: string
    size_bytes: number
    /**
     * 文件内容的 sha256 十六进制小写，64 位
     */
    sha256: string
  }[]
  /**
   * 过程中发现的问题；无则空数组
   */
  findings: {
    severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
    code: string
    description: string
  }[]
  /**
   * status 非 completed 时必填，否则填 null
   */
  error: {
    code: string
    message: string
    retryable: boolean
  } | null
}
