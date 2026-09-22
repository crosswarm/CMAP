/* eslint-disable */
/**
 * 本文件由 schemas/yonwork-output.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * 过程中发现的问题；无则空数组
 */
export type Findings = {
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
  code: string
  description: string
}[]
/**
 * status 非 completed 时必填，否则填 null
 */
export type Error = {
  code: string
  message: string
  retryable: boolean
} & ({
  code: string
  message: string
  retryable: boolean
} | null)

/**
 * Strict final reply captured as a local report. No identities, permissions, remote file claims or caller-selected paths. The report proves the reply contents only; business-operation claims need independent observations.
 */
export interface YonWorkOutputV1 {
  /**
   * 无法完成时填 failed 并在 error 中说明，不要伪造通过
   */
  status: 'completed' | 'failed' | 'input_required' | 'auth_required'
  summary: string
  /**
   * @maxItems 50
   */
  criterion_results: {
    criterion_id: string
    actual: string
    passed: boolean
  }[]
  findings: Findings
  error: Error
}
