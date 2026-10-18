/* eslint-disable */
/**
 * 本文件由 schemas/remote-runner.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * ADR-0006 thin protocol between the single control plane (CrossMini) and the lap runner daemon over Tailscale. Only the control plane initiates HTTP requests (dispatch, status, result, cancel, health); the runner never calls back. Dispatch carries a cmap1 dispatch permit bound to runner_id, adapter audience and the exact envelope SHA256; the runner verifies it with a pinned public key and at most 2 seconds of clock skew. Input files are frozen by the control plane and shipped inline; result artifacts are pulled by the control plane, which recomputes every SHA256 itself and never trusts runner-reported hashes. Bodies never carry credentials, database addresses or provider stderr; error bodies carry only category, code and retryable. Application-layer authentication (ADR-0006 Stage 3): every request, health included, carries requestAuthHeaders signed by the control plane permit key (Ed25519) over method, path+query, body sha256, millisecond timestamp (skew at most 2 seconds), nonce (single use inside the window) and audience runner_id; any failure is an identical unsigned 401 error with code UNAUTHORIZED and no detail, and nothing is executed. Every other response carries responseAuthHeaders signed by the runner key over audience, the request nonce, status and body sha256; the control plane pins the runner public key and treats a bad signature like an evidence hash mismatch.
 */
export type RemoteRunnerMessageV1 =
  | RemoteRunnerDispatchV1
  | RemoteRunnerDispatchAcceptedV1
  | RemoteRunnerStatusV1
  | RemoteRunnerResultV1
  | RemoteRunnerCancelV1
  | RemoteRunnerHealthV1
  | RemoteRunnerErrorV1
export type SchemaTag = 'cmap/remote-runner/v1'
export type Identifier = string
export type Sha256 = string
export type Base64 = string
export type RemoteTaskId = string
/**
 * @maxItems 128
 */
export type Allowlist = Identifier[]

/**
 * POST /v1/tasks. envelope is the exact control-plane TaskEnvelopeV1; its integrity comes from permit.envelope_sha256, not from this schema.
 */
export interface RemoteRunnerDispatchV1 {
  schema: SchemaTag
  kind: 'dispatch'
  runner_id: Identifier
  permit: string
  envelope: {}
  trace_id: string
  correlation_id: string
  deadline_at: string
  /**
   * @maxItems 64
   */
  inputs: {
    /**
     * 控制面已冻结的输入：memory/review 快照、continues 续作输入或 DAG 父节点产物（inputs/<node_id>/<桶>/payload）；第二段为 safe_id，不含点与斜杠。
     */
    uri: string
    sha256: Sha256
    content_base64: Base64
  }[]
}
/**
 * Response to dispatch. A replay of the same permit to the same runner returns the existing remote_task_id without a second execution.
 */
export interface RemoteRunnerDispatchAcceptedV1 {
  schema: SchemaTag
  kind: 'dispatch_accepted'
  runner_id: Identifier
  remote_task_id: RemoteTaskId
}
/**
 * Response to GET /v1/tasks/{remote_task_id}. No provider detail or stderr crosses the wire.
 */
export interface RemoteRunnerStatusV1 {
  schema: SchemaTag
  kind: 'status'
  remote_task_id: RemoteTaskId
  status: 'queued' | 'running' | 'input_required' | 'auth_required' | 'completed' | 'failed' | 'canceled' | 'rejected'
  terminal_observed: boolean
}
/**
 * Response to GET /v1/tasks/{remote_task_id}/result. result must validate as TaskResultV1 on the control plane; identity fields are overwritten by the control plane. Each artifact is pulled inline and its sha256 is recomputed by the control plane before any ledger write.
 */
export interface RemoteRunnerResultV1 {
  schema: SchemaTag
  kind: 'result'
  remote_task_id: RemoteTaskId
  result: {}
  /**
   * @maxItems 64
   */
  artifacts: {
    uri: string
    content_base64: Base64
  }[]
}
/**
 * POST /v1/tasks/{remote_task_id}/cancel. reason is a control-plane code, never prompt text.
 */
export interface RemoteRunnerCancelV1 {
  schema: SchemaTag
  kind: 'cancel'
  remote_task_id: RemoteTaskId
  reason: string
}
/**
 * Response to GET /v1/health. The control plane probes with a 3 second timeout before routing; anything but healthy falls back to local candidates. admission publishes the runner's own allowlist (the same RUNNER_ALLOWED_* / RUNNER_MAX_RISK it enforces at dispatch) so the control plane can skip the runner before dispatch when tenant, owner, capability or risk would be denied, and fall back to local candidates instead of collecting an admission denial. It is advisory for routing only: the runner still enforces admission on every dispatch (defence in depth). It is signed with the rest of the response; a health reply without it is invalid and the runner is treated as unavailable.
 */
export interface RemoteRunnerHealthV1 {
  schema: SchemaTag
  kind: 'health'
  runner_id: Identifier
  state: 'healthy' | 'degraded' | 'unavailable'
  checked_at: string
  admission: RemoteRunnerAdmissionV1
}
/**
 * The runner's dispatch allowlist, same semantics as runner-admission.v1: explicit empty lists deny all.
 */
export interface RemoteRunnerAdmissionV1 {
  allowed_tenants: Allowlist
  allowed_owners: Allowlist
  allowed_capabilities: Allowlist
  max_risk: 'read-meta' | 'read-sensitive' | 'controlled' | 'mutating'
}
/**
 * permit: DispatchPermitErrorCode, no execution happened. admission: RunnerAdmissionErrorCode from the runner's own allowlist, no execution happened. adapter: AdapterError code from the wrapped adapter. protocol: malformed request, unknown task or oversized body, or UNAUTHORIZED (HTTP 401, unsigned, identical for every authentication failure).
 */
export interface RemoteRunnerErrorV1 {
  schema: SchemaTag
  kind: 'error'
  category: 'permit' | 'admission' | 'adapter' | 'protocol'
  code: string
  retryable: boolean
}
