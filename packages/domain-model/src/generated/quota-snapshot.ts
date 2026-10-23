/* eslint-disable */
/**
 * 本文件由 schemas/quota-snapshot.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

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
