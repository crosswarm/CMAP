/**
 * runner 出站网关的领域规则（ADR-0008 §3，契约 schemas/runner-gateway.v1.schema.json）。
 *
 * 租约状态机只有三态：queued（已入队、未被领取）→ leased（runner 已领取，靠续租保活）→ closed（终态回报已落账或入队后被撤回）。
 * 「过期」不是状态而是事实：leased 且 expires_at 已过即过期，此后续租、回报一律拒绝——时间单调，过期不可逆，
 * 所以不需要额外的写入就能保证「判过不确定的租约不会复活」。过期绝不改派、不重跑。
 *
 * MemoryStore 与 PgStore 都用这里的纯函数推进租约，保证两实现同语义。
 */
import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import type { RiskLevel } from './entities.ts'
import type { RemoteRunnerMessageV1, RemoteRunnerDispatchV1 } from './generated/remote-runner.ts'
import type { RunnerGatewayMessageV1 } from './generated/runner-gateway.ts'
import type { RunnerEnrollmentMessageV1 } from './generated/runner-enrollment.ts'

export type GatewayReportBody = Extract<RemoteRunnerMessageV1, { kind: 'dispatch_accepted' | 'status' | 'result' | 'error' }>
export type GatewayCancel = Extract<RemoteRunnerMessageV1, { kind: 'cancel' }>

/** 已登记的出站 runner。身份与上限来自注册令牌记录，不来自 runner 自述。 */
export interface GatewayRunner {
  readonly runner_id: string
  /** 原始 32 字节 Ed25519 公钥，base64url。 */
  readonly public_key: string
  readonly tenant: string
  readonly owner: string
  readonly allowed_capabilities: readonly string[]
  readonly max_risk: RiskLevel
  readonly host: string
  readonly enrolled_at: string
  readonly revoked_at: string | null
  /** 最近一次通过认证的网关请求；路由据此判断 runner 是否在线。 */
  readonly last_seen_at: string | null
}

/** 一次性注册令牌。只存令牌的 sha256，明文只在签发应答里出现一次。 */
export interface EnrollmentToken {
  readonly token_id: string
  readonly token_sha256: string
  /** 取自签发者（admin）的 token claims，不取自请求。 */
  readonly tenant: string
  readonly owner: string
  readonly allowed_capabilities: readonly string[]
  readonly max_risk: RiskLevel
  readonly issued_by: string
  readonly expires_at: string
  readonly created_at: string
  readonly used_at: string | null
  readonly runner_id: string | null
}

export interface EnrollGatewayRunnerInput {
  readonly token_sha256: string
  readonly runner_id: string
  readonly public_key: string
  readonly host: string
  readonly now: string
}

/** 令牌可用：未用过且未过期。 */
export const enrollmentTokenUsable = (token: EnrollmentToken | null | undefined, nowMs: number): token is EnrollmentToken =>
  Boolean(token && token.used_at === null && Date.parse(token.expires_at) > nowMs)

export const runnerFromToken = (token: EnrollmentToken, input: EnrollGatewayRunnerInput): GatewayRunner => ({
  runner_id: input.runner_id, public_key: input.public_key, tenant: token.tenant, owner: token.owner,
  allowed_capabilities: [...token.allowed_capabilities], max_risk: token.max_risk, host: input.host,
  enrolled_at: input.now, revoked_at: null, last_seen_at: null,
})

export type GatewayLeaseState = 'queued' | 'leased' | 'closed'

export interface GatewayLease {
  readonly lease_id: string
  readonly runner_id: string
  readonly task_id: string
  readonly remote_task_id: string
  readonly dispatch: RemoteRunnerDispatchV1
  readonly state: GatewayLeaseState
  /** queued 时为 null；leased/closed 为最后一次授予的期限。 */
  readonly expires_at: string | null
  /** 派发阶段的回报：dispatch_accepted，或执行前的拒绝（error）。 */
  readonly accepted: GatewayReportBody | null
  readonly status: GatewayReportBody | null
  /** 终态回报：result 或执行后的 error。 */
  readonly outcome: GatewayReportBody | null
  /** 待下发给 runner 的取消；入队未领取时取消会直接关闭租约。 */
  readonly cancel: GatewayCancel | null
  readonly created_at: string
  readonly updated_at: string
}

export interface EnqueueGatewayLeaseInput {
  readonly lease_id: string
  readonly runner_id: string
  readonly task_id: string
  readonly remote_task_id: string
  readonly dispatch: RemoteRunnerDispatchV1
  readonly created_at: string
}

export type GatewayReportOutcome =
  | { readonly lease: GatewayLease }
  | { readonly error: 'LEASE_UNKNOWN' | 'LEASE_EXPIRED' | 'INVALID_REQUEST' }

export const isLeaseExpired = (lease: GatewayLease, nowMs: number): boolean =>
  lease.state === 'leased' && lease.expires_at !== null && Date.parse(lease.expires_at) <= nowMs

/** 只有本 runner 持有、仍在期限内的 leased 租约可续。 */
export const canRenewLease = (lease: GatewayLease | null | undefined, runnerId: string, nowMs: number): lease is GatewayLease =>
  Boolean(lease && lease.runner_id === runnerId && lease.state === 'leased' && !isLeaseExpired(lease, nowMs))

export const newLease = (input: EnqueueGatewayLeaseInput): GatewayLease => ({
  ...input, state: 'queued', expires_at: null, accepted: null, status: null, outcome: null, cancel: null, updated_at: input.created_at,
})

/** 同一 lease_id 重复入队只接受完全相同的派发（Activity 重试）；不同内容是冲突，不覆盖。 */
export const sameEnqueue = (lease: GatewayLease, input: EnqueueGatewayLeaseInput): boolean =>
  lease.runner_id === input.runner_id && lease.task_id === input.task_id && lease.remote_task_id === input.remote_task_id &&
  isDeepStrictEqual(lease.dispatch, input.dispatch)

/**
 * 一次回报对租约的推进。派发阶段只收 dispatch_accepted 或 error；之后 status 更新、result/error 关闭租约。
 * 非终态回报同时续租。不属于本 runner、未领取或已关闭 → LEASE_UNKNOWN；已过期 → LEASE_EXPIRED（不落账）。
 */
export const applyGatewayReport = (
  lease: GatewayLease | null | undefined, runnerId: string, body: GatewayReportBody, nowMs: number, expiresAt: string,
): GatewayReportOutcome => {
  if (!lease || lease.runner_id !== runnerId || lease.state !== 'leased') return { error: 'LEASE_UNKNOWN' }
  if (isLeaseExpired(lease, nowMs)) return { error: 'LEASE_EXPIRED' }
  if ('remote_task_id' in body && body.remote_task_id !== lease.remote_task_id) return { error: 'INVALID_REQUEST' }
  if (body.kind === 'dispatch_accepted' && body.runner_id !== runnerId) return { error: 'INVALID_REQUEST' }
  const updated_at = new Date(nowMs).toISOString()
  if (lease.accepted === null) {
    if (body.kind === 'dispatch_accepted') return { lease: { ...lease, accepted: body, expires_at: expiresAt, updated_at } }
    if (body.kind === 'error') return { lease: { ...lease, accepted: body, outcome: body, state: 'closed', updated_at } }
    return { error: 'INVALID_REQUEST' }
  }
  if (body.kind === 'dispatch_accepted') {
    return isDeepStrictEqual(body, lease.accepted) ? { lease: { ...lease, expires_at: expiresAt, updated_at } } : { error: 'INVALID_REQUEST' }
  }
  if (lease.accepted.kind !== 'dispatch_accepted') return { error: 'LEASE_UNKNOWN' }
  if (body.kind === 'status') return { lease: { ...lease, status: body, expires_at: expiresAt, updated_at } }
  return { lease: { ...lease, outcome: body, state: 'closed', updated_at } }
}

/** 取消：未领取的直接关闭（永不下发）；已领取的记下取消，随下一次 claim 下发；已关闭的不变。 */
export const applyGatewayCancel = (lease: GatewayLease, cancel: GatewayCancel, nowMs: number): GatewayLease => {
  const updated_at = new Date(nowMs).toISOString()
  if (lease.state === 'queued') return { ...lease, state: 'closed', cancel, updated_at }
  if (lease.state === 'leased' && lease.cancel === null) return { ...lease, cancel, updated_at }
  return lease
}

// ---------------------------------------------------------------- 机器身份

const RAW_ED25519 = /^[A-Za-z0-9_-]{43}$/

/** 登记的原始公钥 → KeyObject；形状不对即抛错。 */
export const ed25519PublicKeyFromRaw = (raw: string): KeyObject => {
  if (!RAW_ED25519.test(raw)) throw new Error('ED25519_RAW_KEY_INVALID')
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' })
}

export const rawEd25519PublicKey = (key: KeyObject): string => {
  const jwk = key.export({ format: 'jwk' })
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new Error('ED25519_KEY_REQUIRED')
  return jwk.x
}

/** 持钥证明（runner-enrollment.v1 enroll.proof）：新私钥对 'cmap-enroll1' LF token LF public_key LF host 的签名。 */
const proofBytes = (token: string, publicKey: string, host: string): Buffer => Buffer.from(`cmap-enroll1\n${token}\n${publicKey}\n${host}`, 'utf8')

export const signEnrollmentProof = (input: { privateKey: KeyObject; token: string; publicKey: string; host: string }): string =>
  sign(null, proofBytes(input.token, input.publicKey, input.host), input.privateKey).toString('base64url')

/** 任何异常（公钥形状、签名长度）都按证明无效处理。 */
export const verifyEnrollmentProof = (input: { token: string; publicKey: string; host: string; proof: string }): boolean => {
  try {
    return verify(null, proofBytes(input.token, input.publicKey, input.host), ed25519PublicKeyFromRaw(input.publicKey), Buffer.from(input.proof, 'base64url'))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 契约校验

const readSchema = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../../../schemas/${name}`, import.meta.url), 'utf8'))

const ajv = new Ajv2020({ strict: true })
addFormats.default(ajv)
// runner-gateway.v1 按相对路径引用 remote-runner.v1 的 $defs；remote-runner 的 health.quota 又引用 quota-snapshot（相对其 $id 解析）。
const remoteRunnerSchema = readSchema('remote-runner.v1.schema.json')
ajv.addSchema(readSchema('quota-snapshot.v1.schema.json'), new URL('quota-snapshot.v1.schema.json', remoteRunnerSchema['$id'] as string).href)
ajv.addSchema(remoteRunnerSchema, 'https://cmap.local/schemas/remote-runner.v1.schema.json')
/** 网关两侧（API、出站 runner）共用的唯一校验器。 */
export const validateGatewayMessage = ajv.compile<RunnerGatewayMessageV1>(readSchema('runner-gateway.v1.schema.json'))
export const validateEnrollmentMessage = ajv.compile<RunnerEnrollmentMessageV1>(readSchema('runner-enrollment.v1.schema.json'))
