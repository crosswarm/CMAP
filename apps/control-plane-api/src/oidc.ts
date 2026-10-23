/**
 * OIDC Bearer JWT 校验（ADR-0008 §2，映射见 docs/identity.md）。
 *
 * 只用 node:crypto：只接受 RS256，JWKS 按 kid 缓存，未知 kid 才重拉（限频）。
 * 401 不区分原因，避免给探测者反馈。
 */
import { createPublicKey, verify, type JsonWebKeyInput, type KeyObject } from 'node:crypto'

export interface OidcConfig {
  readonly issuer: string
  readonly audience: string
  readonly jwksUrl: string
}

export const OIDC_ROLES = ['operator', 'approver-controlled', 'approver-mutating', 'viewer', 'admin'] as const
export type OidcRole = typeof OIDC_ROLES[number]

export interface OidcIdentity {
  readonly tenant: string
  readonly owner: string
  readonly roles: ReadonlySet<OidcRole>
}

export class OidcError extends Error {
  readonly status: 401 | 403
  constructor(status: 401 | 403, message: string) {
    super(message)
    this.status = status
  }
}

const LEEWAY_SECONDS = 30
const MIN_REFETCH_MS = 30_000
const MAX_CACHE_MS = 10 * 60_000

const decodePart = (part: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JWT 段不是对象')
  return value as Record<string, unknown>
}

export const createOidcVerifier = (config: OidcConfig) => {
  let keys = new Map<string, KeyObject>()
  let fetchedAt = -Infinity
  let inflight: Promise<void> | undefined

  const refresh = async (): Promise<void> => {
    fetchedAt = Date.now()
    const res = await fetch(config.jwksUrl, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`JWKS ${res.status}`)
    const body = await res.json() as { keys?: Array<JsonWebKeyInput['key'] & { kid?: unknown; use?: unknown; alg?: unknown }> }
    const next = new Map<string, KeyObject>()
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || (jwk.use ?? 'sig') !== 'sig' || (jwk.alg ?? 'RS256') !== 'RS256') continue
      next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }))
    }
    keys = next
  }

  const keyFor = async (kid: string): Promise<KeyObject | undefined> => {
    const age = Date.now() - fetchedAt
    if ((!keys.has(kid) || age > MAX_CACHE_MS) && age >= MIN_REFETCH_MS) {
      // IdP 暂不可达时沿用旧缓存；未知 kid 照样拒绝。
      try { await (inflight ??= refresh().finally(() => { inflight = undefined })) } catch { /* 见上 */ }
    }
    return keys.get(kid)
  }

  return async (token: string): Promise<OidcIdentity> => {
    const unauthorized = new OidcError(401, '未认证')
    const parts = token.split('.')
    if (parts.length !== 3) throw unauthorized
    let header: Record<string, unknown>, payload: Record<string, unknown>
    try { header = decodePart(parts[0]!); payload = decodePart(parts[1]!) } catch { throw unauthorized }
    if (header['alg'] !== 'RS256' || typeof header['kid'] !== 'string' || header['crit'] !== undefined) throw unauthorized
    const key = await keyFor(header['kid'])
    if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, 'base64url'))) throw unauthorized

    const now = Date.now() / 1000
    const aud = payload['aud']
    const audiences = Array.isArray(aud) ? aud : [aud]
    if (payload['iss'] !== config.issuer || !audiences.includes(config.audience)) throw unauthorized
    if (typeof payload['exp'] !== 'number' || payload['exp'] + LEEWAY_SECONDS <= now) throw unauthorized
    if (payload['nbf'] !== undefined && (typeof payload['nbf'] !== 'number' || payload['nbf'] - LEEWAY_SECONDS > now)) throw unauthorized
    const sub = payload['sub']
    if (typeof sub !== 'string' || !sub.trim()) throw unauthorized

    const tenant = payload['tenant']
    if (typeof tenant !== 'string' || !tenant.trim()) throw new OidcError(403, 'token 缺少 tenant claim')
    const claimed = Array.isArray(payload['roles']) ? payload['roles'] : []
    const roles = new Set(OIDC_ROLES.filter((role) => claimed.includes(role)))
    return { tenant, owner: sub, roles }
  }
}
