/* eslint-disable */
/**
 * 本文件由 schemas/dispatch-permit.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * Opaque cmap1 token payload signed with Ed25519 over ASCII cmap1. plus original UTF8 payload bytes. Binds exact Node JSON.stringify TaskEnvelope SHA256 and managed runner/adapter audience. Integer epoch seconds; issued_at <= not_before < expires_at, lifetime <=60 seconds, issued_at/not_before <= trusted now < expires_at. Managed adapter verifies before preparation and again before provider spawn/send. Denial is PERMIT_INVALID post-intent admission receipt, preserving binding without a TaskResult. Tokens and private keys are never logged, persisted, or passed to provider children. Local ephemeral trust does not authenticate another host.
 */
export interface DispatchPermitV1 {
  schema: 'cmap/dispatch-permit/v1'
  kid: string
  issuer: string
  audience: string
  runner_id: string
  mission_id: string
  task_id: string
  revision: number
  idempotency_key: string
  envelope_sha256: string
  issued_at: number
  not_before: number
  expires_at: number
  nonce: string
}
