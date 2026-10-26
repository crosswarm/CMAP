/* eslint-disable */
/**
 * 本文件由 schemas/runner-enrollment.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * ADR-0008 §4 runner enrollment. An admin (OIDC role admin) issues a one-time token: tenant comes from the admin's token claims, never from the request; it is bound to owner, a capability ceiling and a risk ceiling, expires within ttl_seconds (at most 3600) and is consumed by the first successful enroll. The token value is returned once and the control plane keeps only its sha256. On first start the runner generates an Ed25519 key pair, keeps the private key on its own host and enrolls with the token, its raw public key and a proof signature; it receives a runner_id plus the control-plane public key to pin for runner-gateway.v1 replies. The enrolled runner's tenant, owner and ceilings come from the token record; nothing in the enroll request can widen them. Revocation (POST /v1/runners/{runner_id}/revoke by an admin of the same tenant, empty JSON body, reply revoked) is a control-plane record change and takes effect on the next request: every gateway request from the runner is then the gateway's identical 401, and its in-flight leases are treated as execution uncertain (never reassigned or rerun). Every enroll failure (unknown, expired or used token, bad proof, key already enrolled) is the same ENROLLMENT_DENIED with no detail.
 */
export type RunnerEnrollmentMessageV1 =
  | RunnerEnrollmentIssueV1
  | RunnerEnrollmentIssuedV1
  | RunnerEnrollmentRequestV1
  | RunnerEnrollmentAcceptedV1
  | RunnerEnrollmentRevokedV1
  | RunnerEnrollmentErrorV1
export type SchemaTag = 'cmap/runner-enrollment/v1'
export type Identifier = string
/**
 * @maxItems 128
 */
export type Allowlist = Identifier[]
export type Risk = 'read-meta' | 'read-sensitive' | 'controlled' | 'mutating'
/**
 * Opaque one-time secret: cmapenr1. followed by 32 random bytes in base64url.
 */
export type Token = string
/**
 * Raw 32-byte Ed25519 public key, base64url without padding.
 */
export type Ed25519PublicKey = string
export type Origin = string

/**
 * POST /v1/runner-enrollments by an admin.
 */
export interface RunnerEnrollmentIssueV1 {
  schema: SchemaTag
  kind: 'issue'
  owner: Identifier
  allowed_capabilities: Allowlist
  max_risk: Risk
  ttl_seconds: number
}
/**
 * Reply to issue. token is shown only here; issued_by is the admin token subject.
 */
export interface RunnerEnrollmentIssuedV1 {
  schema: SchemaTag
  kind: 'issued'
  token: Token
  token_id: Identifier
  tenant: Identifier
  owner: Identifier
  allowed_capabilities: Allowlist
  max_risk: Risk
  issued_by: Identifier
  expires_at: string
  single_use: true
}
/**
 * POST /v1/runners/enroll by the runner (no OIDC token; the enrollment token is the credential). proof is the base64url Ed25519 signature by the new private key over 'cmap-enroll1' LF token LF public_key LF host, proving possession of the key being registered.
 */
export interface RunnerEnrollmentRequestV1 {
  schema: SchemaTag
  kind: 'enroll'
  token: Token
  public_key: Ed25519PublicKey
  host: Identifier
  proof: string
}
/**
 * Reply to enroll. Identity and ceilings are copied from the token record. control_plane_public_key is pinned by the runner to verify runner-gateway.v1 replies. control_plane_origin is never sent by the control plane: the runner adds it to its local enrollment record on enrolling (or on first start with an older record) and refuses to start when it differs from its CMAP_CONTROL_PLANE_URL origin, so one runner process cannot be pointed at a different control plane than the one it enrolled with.
 */
export interface RunnerEnrollmentAcceptedV1 {
  schema: SchemaTag
  kind: 'enrolled'
  runner_id: Identifier
  tenant: Identifier
  owner: Identifier
  allowed_capabilities: Allowlist
  max_risk: Risk
  control_plane_public_key: Ed25519PublicKey
  enrolled_at: string
  control_plane_origin?: Origin
}
/**
 * Reply to POST /v1/runners/{runner_id}/revoke. Idempotent: revoking again returns the original revoked_at. A runner of another tenant is 404, not 403.
 */
export interface RunnerEnrollmentRevokedV1 {
  schema: SchemaTag
  kind: 'revoked'
  runner_id: Identifier
  revoked_at: string
}
/**
 * ENROLLMENT_DENIED for every enroll failure; INVALID_REQUEST for malformed bodies; FORBIDDEN when the issuer lacks the admin role.
 */
export interface RunnerEnrollmentErrorV1 {
  schema: SchemaTag
  kind: 'error'
  code: 'ENROLLMENT_DENIED' | 'INVALID_REQUEST' | 'FORBIDDEN'
  retryable: boolean
}
