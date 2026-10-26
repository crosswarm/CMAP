/* eslint-disable */
/**
 * 本文件由 schemas/runner-gateway.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * ADR-0008 §3 outbound runner gateway. The runner initiates every HTTPS request; the control plane never connects to a runner, so runners behind NAT work. Message bodies reuse remote-runner.v1 semantics unchanged (dispatch with a cmap1 permit bound to runner_id, adapter audience and envelope SHA256; dispatch_accepted / status / result / error; cancel); only the transport direction changes. POST /v1/gateway/claim long-polls for work (wait_seconds at most 50) and renews every lease listed in held_leases; the reply carries at most one assignment plus pending cancels, which the control plane can no longer push. POST /v1/gateway/reports carries one remote-runner.v1 reply for a lease and also renews it. A lease the control plane reports as expired enters the existing execution-uncertain path (task INPUT_REQUIRED, binding kept): it is never reassigned or rerun. Results are written to the ledger before the workflow is signalled. Artifacts are still recomputed by the control plane; runner-reported hashes are never trusted. Result artifacts are streamed (M09): before reporting a result the runner uploads each streamedArtifact's bytes with POST /v1/gateway/artifacts (artifactUpload), and the result report then carries only their metadata; reports with inline base64 artifacts from runners that predate streaming are still accepted. Authentication: every request carries requestAuthHeaders signed by the runner's enrolled Ed25519 key (runner-enrollment.v1); any failure, a revoked runner included, is one identical unsigned 401 error with code UNAUTHORIZED and nothing is executed or recorded. Every other reply carries responseAuthHeaders signed by the control-plane key the runner pinned at enrollment. Bodies never carry credentials, database addresses, provider stderr or tenant/owner identity: identity comes from the enrolled runner record, not from the request.
 */
export type RunnerGatewayMessageV1 =
  | RunnerGatewayClaimV1
  | RunnerGatewayClaimResultV1
  | RunnerGatewayReportV1
  | RunnerGatewayReportAckV1
  | RunnerGatewayUploadAckV1
  | RunnerGatewayErrorV1
export type SchemaTag = 'cmap/runner-gateway/v1'
export type Identifier = string
export type LeaseId = string

/**
 * POST /v1/gateway/claim. runner_id must equal x-cmap-runner-id. held_leases lists every lease the runner still executes (empty when idle); each is renewed. quota (optional, ADR-0009) is the runner's latest account-level quota snapshot for its wrapped agent, read by a zero-quota probe on the runner host and sent with the claim like remote-runner.v1 health.quota; the control plane keeps the newest one per runner for routing. Omitted when nothing could be read (older runners too): the control plane then treats the quota as unknown. It is advisory for routing only.
 */
export interface RunnerGatewayClaimV1 {
  schema: SchemaTag
  kind: 'claim'
  runner_id: Identifier
  wait_seconds: number
  /**
   * @maxItems 64
   */
  held_leases: LeaseId[]
  quota?: QuotaSnapshotV1
}
/**
 * ADR-0009 §1 account-level quota snapshot. Quota is counted per provider account on the provider side, so the same account seen from two runners is one pool. Read by a zero-quota probe on the runner host that holds the provider login (Codex app-server account/rateLimits/read, Claude stream-json control request get_usage); Kimi is unknown. account_ref is an irreversible sha256 digest of the provider account identity, never the raw id, email or token. status ok means the provider answered; unknown means nothing could be read (timeout, spawn failure, unparsable reply, unsupported provider); error means the provider answered with an explicit error. Unknown and error are never treated as sufficient. ordinary_usage_allowed is the provider's own flag (Codex ordinaryUsageAllowed); null means the provider did not say and must not be inferred.
 */
export interface QuotaSnapshotV1 {
  schema: 'cmap/quota-snapshot/v1'
  provider: 'codex' | 'claude' | 'kimi'
  /**
   * sha256 hex of a provider-scoped account identity; null when the account could not be identified.
   */
  account_ref: string | null
  /**
   * @maxItems 32
   */
  windows: {
    /**
     * Codex primary/secondary; Claude five_hour/seven_day.
     */
    kind: string
    used_percent: number
    window_minutes: number | null
    resets_at: string | null
  }[]
  ordinary_usage_allowed: boolean | null
  observed_at: string
  status: 'ok' | 'unknown' | 'error'
}
/**
 * Reply to claim, sent when work or a cancel is available or wait_seconds elapsed. renewed: held leases still honored with their new expiry. expired: held leases the control plane already judged uncertain; the runner should stop them and must not report results for them. assignment: null, or one remote-runner.v1 dispatch with its new lease. cancels: remote-runner.v1 cancel messages for held leases.
 */
export interface RunnerGatewayClaimResultV1 {
  schema: SchemaTag
  kind: 'claim_result'
  runner_id: Identifier
  /**
   * @maxItems 64
   */
  renewed: RunnerGatewayLeaseV1[]
  /**
   * @maxItems 64
   */
  expired: LeaseId[]
  assignment: null | {
    lease: RunnerGatewayLeaseV1
    dispatch: RemoteRunnerDispatchV1
  }
  /**
   * @maxItems 64
   */
  cancels: {
    lease_id: LeaseId
    cancel: RemoteRunnerCancelV1
  }[]
}
/**
 * Issued with an assignment and renewed by every claim or report that names it. Past expires_at the control plane stops waiting and records execution uncertain; it does not reassign.
 */
export interface RunnerGatewayLeaseV1 {
  lease_id: LeaseId
  expires_at: string
}
/**
 * POST /v1/tasks. envelope is the exact control-plane TaskEnvelopeV1; its integrity comes from permit.envelope_sha256, not from this schema.
 */
export interface RemoteRunnerDispatchV1 {
  schema: 'cmap/remote-runner/v1'
  kind: 'dispatch'
  runner_id: string
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
    sha256: string
    content_base64: string
  }[]
}
/**
 * POST /v1/tasks/{remote_task_id}/cancel. reason is a control-plane code, never prompt text.
 */
export interface RemoteRunnerCancelV1 {
  schema: 'cmap/remote-runner/v1'
  kind: 'cancel'
  remote_task_id: string
  reason: string
}
/**
 * POST /v1/gateway/reports. body is exactly one remote-runner.v1 reply for the leased dispatch: dispatch_accepted (or a permit/admission error) right after verification, status on change, result once terminal. A result is persisted (artifacts recomputed) before the workflow is signalled.
 */
export interface RunnerGatewayReportV1 {
  schema: SchemaTag
  kind: 'report'
  runner_id: Identifier
  lease_id: LeaseId
  body: RemoteRunnerDispatchAcceptedV1 | RemoteRunnerStatusV1 | RemoteRunnerResultV1 | RemoteRunnerErrorV1
}
/**
 * Response to dispatch. A replay of the same permit to the same runner returns the existing remote_task_id without a second execution.
 */
export interface RemoteRunnerDispatchAcceptedV1 {
  schema: 'cmap/remote-runner/v1'
  kind: 'dispatch_accepted'
  runner_id: string
  remote_task_id: string
}
/**
 * Response to GET /v1/tasks/{remote_task_id}. No provider detail or stderr crosses the wire.
 */
export interface RemoteRunnerStatusV1 {
  schema: 'cmap/remote-runner/v1'
  kind: 'status'
  remote_task_id: string
  status: 'queued' | 'running' | 'input_required' | 'auth_required' | 'completed' | 'failed' | 'canceled' | 'rejected'
  terminal_observed: boolean
}
/**
 * Response to GET /v1/tasks/{remote_task_id}/result. result must validate as TaskResultV1 on the control plane; identity fields are overwritten by the control plane. Each artifact is either declared for streaming (streamedArtifact, current runners) or carried inline (inlineArtifact, runners that predate streaming); either way its sha256 is recomputed by the control plane before any ledger write.
 */
export interface RemoteRunnerResultV1 {
  schema: 'cmap/remote-runner/v1'
  kind: 'result'
  remote_task_id: string
  result: {}
  /**
   * @maxItems 64
   */
  artifacts: (RemoteRunnerStreamedArtifactV1 | RemoteRunnerInlineArtifactV1)[]
}
/**
 * Metadata sent before the bytes: uri relative to the runner task directory, the runner's declared sha256 and exact size_bytes. The control plane then fetches the bytes from artifactStream and accepts them only if their recomputed sha256 and length equal these values and the stream's response signature; otherwise nothing is persisted (EVIDENCE_HASH_MISMATCH). Each side enforces its own configured size cap (CMAP_MAX_EVIDENCE_BYTES, default 256 MiB).
 */
export interface RemoteRunnerStreamedArtifactV1 {
  uri: string
  sha256: string
  size_bytes: number
}
/**
 * Legacy inline transfer (at most 16 MiB raw bytes) from runners that predate streaming. Still accepted by the control plane; current runners send streamedArtifact instead.
 */
export interface RemoteRunnerInlineArtifactV1 {
  uri: string
  content_base64: string
}
/**
 * permit: DispatchPermitErrorCode, no execution happened. admission: RunnerAdmissionErrorCode from the runner's own allowlist, no execution happened. adapter: AdapterError code from the wrapped adapter. protocol: malformed request, unknown task or oversized body, or UNAUTHORIZED (HTTP 401, unsigned, identical for every authentication failure).
 */
export interface RemoteRunnerErrorV1 {
  schema: 'cmap/remote-runner/v1'
  kind: 'error'
  category: 'permit' | 'admission' | 'adapter' | 'protocol'
  code: string
  retryable: boolean
}
/**
 * Reply to report. lease is the renewed lease, or null once the lease is closed (terminal report recorded).
 */
export interface RunnerGatewayReportAckV1 {
  schema: SchemaTag
  kind: 'report_ack'
  lease_id: LeaseId
  lease: null | RunnerGatewayLeaseV1
}
/**
 * Reply to an artifact upload: the bytes were recomputed and kept under the lease.
 */
export interface RunnerGatewayUploadAckV1 {
  schema: SchemaTag
  kind: 'upload_ack'
  lease_id: LeaseId
  sha256: string
  size_bytes: number
}
/**
 * Gateway-level error. UNAUTHORIZED (HTTP 401, unsigned, identical for every authentication failure); LEASE_EXPIRED / LEASE_UNKNOWN for reports or uploads on a lease that is closed, expired or not held by this runner (no ledger write); INVALID_REQUEST for malformed or oversized bodies; EVIDENCE_HASH_MISMATCH / EVIDENCE_SECRET_DETECTED / EVIDENCE_FILE_TOO_LARGE for rejected artifact uploads (nothing persisted). No detail crosses the wire.
 */
export interface RunnerGatewayErrorV1 {
  schema: SchemaTag
  kind: 'error'
  code: string
  retryable: boolean
}
