/* eslint-disable */
/**
 * 本文件由 schemas/runner-admission.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

export type Identifier = string
/**
 * @maxItems 128
 */
export type Allowlist = Identifier[]

/**
 * Normalized operator configuration for the local runner. Labels are not authenticated remote identity. Explicit empty allowlists deny all; grants never replace controlled or mutating approvals.
 */
export interface RunnerAdmissionV1 {
  schema: 'cmap/runner-admission/v1'
  runner_id: Identifier
  runner_tenant: Identifier
  host: Identifier
  allowed_tenants: Allowlist
  allowed_owners: Allowlist
  allowed_capabilities: Allowlist
  max_risk: 'read-meta' | 'read-sensitive' | 'controlled' | 'mutating'
}
