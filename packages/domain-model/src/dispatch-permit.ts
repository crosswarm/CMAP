import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify, type KeyObject } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { Ajv2020 } from 'ajv/dist/2020.js'

import type { DispatchPermitV1 } from './generated/dispatch-permit.ts'
import type { TaskEnvelopeV1 } from './generated/task-envelope.ts'

export type DispatchPermitErrorCode =
  | 'MALFORMED'
  | 'BAD_SIGNATURE'
  | 'UNKNOWN_KEY'
  | 'CLAIM_MISMATCH'
  | 'NOT_YET_VALID'
  | 'EXPIRED'
  | 'INVALID_LIFETIME'

export class DispatchPermitError extends Error {
  readonly code: DispatchPermitErrorCode

  constructor(code: DispatchPermitErrorCode) {
    super(code)
    this.name = 'DispatchPermitError'
    this.code = code
  }
}

type IssueDispatchPermitInput = {
  privateKey: KeyObject
  issuer: string
  runnerId: string
  adapterId: string
  envelope: TaskEnvelopeV1
  nowMs?: number
  ttlSeconds?: number
}

type VerifyDispatchPermitInput = {
  publicKey: KeyObject
  issuer: string
  runnerId: string
  adapterId: string
  envelope: TaskEnvelopeV1
  nowMs?: number
  /** Cross-host only (ADR-0006): integer 0..2 seconds. Local verification keeps the default 0. */
  clockSkewSeconds?: number
}

const PREFIX = 'cmap1'
const MAX_TOKEN_BYTES = 8192
const MAX_PAYLOAD_BYTES = 4096
const SIGNING_PREFIX = Buffer.from(`${PREFIX}.`, 'ascii')
const utf8 = new TextDecoder('utf-8', { fatal: true })

const readSchema = () =>
  JSON.parse(readFileSync(new URL('../../../schemas/dispatch-permit.v1.schema.json', import.meta.url), 'utf8'))

const validatePermit = new Ajv2020({ strict: true }).compile<DispatchPermitV1>(readSchema())

const fail = (code: DispatchPermitErrorCode): never => {
  throw new DispatchPermitError(code)
}

const assertEd25519 = (key: KeyObject, type: 'private' | 'public'): void => {
  if (key.type !== type || key.asymmetricKeyType !== 'ed25519') fail('UNKNOWN_KEY')
}

const publicKeyId = (publicKey: KeyObject): string =>
  createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')

const envelopeHash = (envelope: TaskEnvelopeV1): string =>
  createHash('sha256').update(JSON.stringify(envelope), 'utf8').digest('hex')

const nowSeconds = (nowMs = Date.now()): number => Math.floor(nowMs / 1000)

const trustedNowSeconds = (nowMs?: number): number => {
  const seconds = nowSeconds(nowMs)
  if (!Number.isSafeInteger(seconds) || seconds < 0) fail('INVALID_LIFETIME')
  return seconds
}

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

const decodeB64url = (value: string, maxBytes: number): Buffer => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail('MALFORMED')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length > maxBytes || b64url(bytes) !== value) fail('MALFORMED')
  return bytes
}

const decodeUtf8 = (bytes: Uint8Array): string => {
  try {
    return utf8.decode(bytes)
  } catch {
    return fail('MALFORMED')
  }
}

const requireTokenPart = (value: string | undefined): string => value ? value : fail('MALFORMED')

const decodePayload = (encoded: string): { bytes: Buffer; permit: DispatchPermitV1 } => {
  const bytes = decodeB64url(encoded, MAX_PAYLOAD_BYTES)
  const text = decodeUtf8(bytes)

  let permit: unknown
  try {
    permit = JSON.parse(text)
  } catch {
    fail('MALFORMED')
  }
  if (!validatePermit(permit)) fail('MALFORMED')
  return { bytes, permit: permit as DispatchPermitV1 }
}

const signingBytes = (payload: Uint8Array): Buffer => Buffer.concat([SIGNING_PREFIX, Buffer.from(payload)])

const expectedClaims = (
  input: Pick<IssueDispatchPermitInput, 'issuer' | 'runnerId' | 'adapterId' | 'envelope'>,
  kid: string,
  issuedAt: number,
  expiresAt: number,
): DispatchPermitV1 => ({
  schema: 'cmap/dispatch-permit/v1',
  kid,
  issuer: input.issuer,
  audience: input.adapterId,
  runner_id: input.runnerId,
  mission_id: input.envelope.identity.mission_id,
  task_id: input.envelope.identity.task_id,
  revision: input.envelope.identity.revision,
  idempotency_key: input.envelope.identity.idempotency_key,
  envelope_sha256: envelopeHash(input.envelope),
  issued_at: issuedAt,
  not_before: issuedAt,
  expires_at: expiresAt,
  nonce: randomUUID(),
})

const assertLifetime = (permit: DispatchPermitV1): void => {
  if (
    permit.issued_at > permit.not_before ||
    permit.not_before >= permit.expires_at ||
    permit.expires_at - permit.issued_at > 60
  ) fail('INVALID_LIFETIME')
}

const assertClaims = (
  permit: DispatchPermitV1,
  input: VerifyDispatchPermitInput,
  kid: string,
): void => {
  if (permit.kid !== kid) fail('UNKNOWN_KEY')
  if (
    permit.issuer !== input.issuer ||
    permit.audience !== input.adapterId ||
    permit.runner_id !== input.runnerId ||
    permit.mission_id !== input.envelope.identity.mission_id ||
    permit.task_id !== input.envelope.identity.task_id ||
    permit.revision !== input.envelope.identity.revision ||
    permit.idempotency_key !== input.envelope.identity.idempotency_key ||
    permit.envelope_sha256 !== envelopeHash(input.envelope)
  ) fail('CLAIM_MISMATCH')
}

const MAX_CLOCK_SKEW_SECONDS = 2

const assertTime = (permit: DispatchPermitV1, now: number, skew: number): void => {
  if (now + skew < permit.issued_at || now + skew < permit.not_before) fail('NOT_YET_VALID')
  if (now - skew >= permit.expires_at) fail('EXPIRED')
}

export const issueDispatchPermit = (input: IssueDispatchPermitInput): string => {
  assertEd25519(input.privateKey, 'private')
  const ttl = input.ttlSeconds ?? 60
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 60) fail('INVALID_LIFETIME')

  const publicKey = createPublicKey(input.privateKey)
  const issuedAt = trustedNowSeconds(input.nowMs)
  const permit = expectedClaims(input, publicKeyId(publicKey), issuedAt, issuedAt + ttl)
  if (!validatePermit(permit)) fail('MALFORMED')

  const payload = Buffer.from(JSON.stringify(permit), 'utf8')
  if (payload.length > MAX_PAYLOAD_BYTES) fail('MALFORMED')
  const signature = sign(null, signingBytes(payload), input.privateKey)
  if (signature.length !== 64) fail('BAD_SIGNATURE')
  const token = `${PREFIX}.${b64url(payload)}.${b64url(signature)}`
  if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) fail('MALFORMED')
  return token
}

export const verifyDispatchPermit = (token: string, input: VerifyDispatchPermitInput): undefined => {
  assertEd25519(input.publicKey, 'public')
  const skew = input.clockSkewSeconds ?? 0
  if (!Number.isInteger(skew) || skew < 0 || skew > MAX_CLOCK_SKEW_SECONDS) throw new RangeError('CLOCK_SKEW_OUT_OF_RANGE')
  if (typeof token !== 'string') fail('MALFORMED')
  if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) fail('MALFORMED')
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== PREFIX) fail('MALFORMED')
  const payloadPart = requireTokenPart(parts[1])
  const signaturePart = requireTokenPart(parts[2])

  const { bytes: payload, permit } = decodePayload(payloadPart)
  const kid = publicKeyId(input.publicKey)
  if (permit.kid !== kid) fail('UNKNOWN_KEY')
  const signature = decodeB64url(signaturePart, 64)
  if (signature.length !== 64) fail('MALFORMED')
  if (!verify(null, signingBytes(payload), input.publicKey, signature)) fail('BAD_SIGNATURE')

  assertLifetime(permit)
  assertClaims(permit, input, kid)
  assertTime(permit, trustedNowSeconds(input.nowMs), skew)
  return undefined
}

/**
 * Control-plane signing key (CMAP_PERMIT_KEY_FILE). Generated once as PKCS8 PEM with 0600 so the lap
 * runner can pin the matching public key; a key file readable by group/other is refused, not repaired.
 */
export const loadOrCreatePermitKey = (path: string): { privateKey: KeyObject; publicKey: KeyObject } => {
  try {
    const pair = generateKeyPairSync('ed25519')
    writeFileSync(path, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 })
    return pair
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const st = statSync(path)
  if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error('PERMIT_KEY_FILE_MODE')
  const privateKey = createPrivateKey(readFileSync(path))
  assertEd25519(privateKey, 'private')
  return { privateKey, publicKey: createPublicKey(privateKey) }
}

/** Runner-side trust anchor: a pinned SPKI public key file, never private key material. */
export const loadPinnedPublicKey = (path: string): KeyObject => {
  const pem = readFileSync(path, 'utf8')
  if (pem.includes('PRIVATE KEY')) throw new Error('PINNED_KEY_NOT_PUBLIC')
  const publicKey = createPublicKey(pem)
  assertEd25519(publicKey, 'public')
  return publicKey
}

/**
 * ADR-0006 Stage 3：CrossMini ↔ lap 的应用层请求/响应认证（schemas/remote-runner.v1.schema.json 的 requestAuthHeaders / responseAuthHeaders）。
 *
 * 请求由 CrossMini 的派发许可私钥签名，覆盖方法、路径（含查询）、请求体 sha256、时间戳（毫秒）、nonce 与受众 runner_id；
 * 响应由 lap 自己的密钥签名，覆盖受众、所答请求的 nonce、状态码与响应体 sha256（不能把旧响应重放给新请求）。
 * 签名串带各自的域前缀（cmap-runner-req1 / cmap-runner-res1），与许可的 `cmap1.` 互不通用。
 * 任何失败都只抛 RunnerAuthError，不带原因：对外一律 401，不泄露是哪一项没过。
 */
export class RunnerAuthError extends Error {
  constructor() {
    super('UNAUTHORIZED')
    this.name = 'RunnerAuthError'
  }
}

export const RUNNER_AUTH_MAX_SKEW_MS = 2000
export const RUNNER_AUTH_HEADERS = {
  timestamp: 'x-cmap-timestamp',
  nonce: 'x-cmap-nonce',
  audience: 'x-cmap-audience',
  contentSha256: 'x-cmap-content-sha256',
  signature: 'x-cmap-signature',
} as const

/**
 * 两套签名方案共用同一算法：remote-runner.v1（控制面签请求、lap 签应答，身份头为受众）与
 * runner-gateway.v1（ADR-0008 §3：runner 签请求、控制面签应答，身份头为发起请求的 runner_id）。
 * 域前缀不同，一方的签名不能重放到另一方。
 */
export type RunnerAuthScheme = 'runner' | 'gateway'
const SCHEMES = {
  runner: { request: 'cmap-runner-req1\n', response: 'cmap-runner-res1\n', identity: 'x-cmap-audience' },
  gateway: { request: 'cmap-gateway-req1\n', response: 'cmap-gateway-res1\n', identity: 'x-cmap-runner-id' },
} as const
export const GATEWAY_RUNNER_ID_HEADER = SCHEMES.gateway.identity
const AUTH_TIMESTAMP = /^[0-9]{10,16}$/
const AUTH_NONCE = /^[A-Za-z0-9_-]{16,64}$/
const AUTH_SHA256 = /^[a-f0-9]{64}$/

const authFail = (): never => {
  throw new RunnerAuthError()
}

const bodySha256 = (body: Uint8Array | string | undefined): string =>
  createHash('sha256').update(body ?? '').digest('hex')

/** 换行会让签名串字段边界歧义，签发与验证两侧都拒绝。 */
const assertLineSafe = (...fields: string[]): void => {
  for (const field of fields) if (field.includes('\n') || field.includes('\r')) authFail()
}

const requestSigningBytes = (scheme: RunnerAuthScheme, f: { method: string; target: string; contentSha256: string; timestamp: string; nonce: string; audience: string }): Buffer =>
  Buffer.from(`${SCHEMES[scheme].request}${f.method}\n${f.target}\n${f.contentSha256}\n${f.timestamp}\n${f.nonce}\n${f.audience}`, 'utf8')

const responseSigningBytes = (scheme: RunnerAuthScheme, f: { audience: string; requestNonce: string; status: number; bodySha256: string }): Buffer =>
  Buffer.from(`${SCHEMES[scheme].response}${f.audience}\n${f.requestNonce}\n${f.status}\n${f.bodySha256}`, 'utf8')

/** 返回需要附在请求上的认证头。target 是 `pathname + search`，与服务端从请求行解析出的一致。 */
export const signRunnerRequest = (input: {
  privateKey: KeyObject
  method: string
  target: string
  body?: Uint8Array | string
  /** 流式请求体（M09 产物上传）：调用方已知的体 sha256，代替 body；服务端边收边算核对。 */
  contentSha256?: string
  audience: string
  nowMs?: number
  scheme?: RunnerAuthScheme
}): Record<string, string> => {
  const scheme = input.scheme ?? 'runner'
  assertEd25519(input.privateKey, 'private')
  assertLineSafe(input.method, input.target, input.audience)
  if (input.contentSha256 !== undefined && !AUTH_SHA256.test(input.contentSha256)) authFail()
  const fields = {
    method: input.method,
    target: input.target,
    contentSha256: input.contentSha256 ?? bodySha256(input.body),
    timestamp: String(input.nowMs ?? Date.now()),
    nonce: randomBytes(18).toString('base64url'),
    audience: input.audience,
  }
  return {
    [RUNNER_AUTH_HEADERS.timestamp]: fields.timestamp,
    [RUNNER_AUTH_HEADERS.nonce]: fields.nonce,
    [SCHEMES[scheme].identity]: fields.audience,
    [RUNNER_AUTH_HEADERS.contentSha256]: fields.contentSha256,
    [RUNNER_AUTH_HEADERS.signature]: b64url(sign(null, requestSigningBytes(scheme, fields), input.privateKey)),
  }
}

/**
 * 只验头部（签名、受众、时间窗），不读请求体：未认证的请求在读体之前就被拒绝。
 * 调用方随后必须核对 `bodySha256(收到的体) === contentSha256`，并用 nonce 做防重放。
 */
export const verifyRunnerRequest = (input: {
  publicKey: KeyObject
  method: string
  target: string
  /** 本机 runner_id：请求受众必须等于它。 */
  audience: string
  headers: Record<string, string | string[] | undefined>
  nowMs?: number
  scheme?: RunnerAuthScheme
}): { nonce: string; contentSha256: string } => {
  const scheme = input.scheme ?? 'runner'
  assertEd25519(input.publicKey, 'public')
  const one = (name: string): string => {
    const value = input.headers[name]
    return typeof value === 'string' ? value : authFail()
  }
  const timestamp = one(RUNNER_AUTH_HEADERS.timestamp)
  const nonce = one(RUNNER_AUTH_HEADERS.nonce)
  const audience = one(SCHEMES[scheme].identity)
  const contentSha256 = one(RUNNER_AUTH_HEADERS.contentSha256)
  const signature = one(RUNNER_AUTH_HEADERS.signature)
  assertLineSafe(input.method, input.target, input.audience)
  if (!AUTH_TIMESTAMP.test(timestamp) || !AUTH_NONCE.test(nonce) || !AUTH_SHA256.test(contentSha256)) authFail()
  if (Math.abs((input.nowMs ?? Date.now()) - Number(timestamp)) > RUNNER_AUTH_MAX_SKEW_MS) authFail()
  if (audience !== input.audience) authFail()
  let signatureBytes: Buffer
  try {
    signatureBytes = decodeB64url(signature, 64)
  } catch {
    return authFail()
  }
  if (signatureBytes.length !== 64) authFail()
  if (!verify(null, requestSigningBytes(scheme, { method: input.method, target: input.target, contentSha256, timestamp, nonce, audience }), input.publicKey, signatureBytes)) authFail()
  return { nonce, contentSha256 }
}

export const runnerBodySha256 = bodySha256

/** 体的 sha256：流式体（M09 产物流）由调用方给出已知哈希，否则按实际字节计算。 */
const responseBodySha256 = (input: { body?: Uint8Array | string; bodySha256?: string }): string => {
  if (input.bodySha256 === undefined) return bodySha256(input.body)
  if (!AUTH_SHA256.test(input.bodySha256)) authFail()
  return input.bodySha256
}

/** lap 对响应体签名；body 必须是实际发出的字节，流式体给出其 bodySha256。 */
export const signRunnerResponse = (input: {
  privateKey: KeyObject
  audience: string
  requestNonce: string
  status: number
  body?: Uint8Array | string
  bodySha256?: string
  scheme?: RunnerAuthScheme
}): string => {
  assertEd25519(input.privateKey, 'private')
  assertLineSafe(input.audience, input.requestNonce)
  return b64url(sign(null, responseSigningBytes(input.scheme ?? 'runner', { ...input, bodySha256: responseBodySha256(input) }), input.privateKey))
}

/** CrossMini 对收到的响应验签；失败即不采信（调用方按证据完整性失败处理）。 */
export const verifyRunnerResponse = (input: {
  publicKey: KeyObject
  audience: string
  requestNonce: string
  status: number
  body?: Uint8Array | string
  /** 流式体：先按声明的 sha256 验签再读字节，读完由调用方复算核对。 */
  bodySha256?: string
  signature: string | null | undefined
  scheme?: RunnerAuthScheme
}): undefined => {
  assertEd25519(input.publicKey, 'public')
  assertLineSafe(input.audience, input.requestNonce)
  if (typeof input.signature !== 'string') authFail()
  let signatureBytes: Buffer
  try {
    signatureBytes = decodeB64url(input.signature as string, 64)
  } catch {
    return authFail()
  }
  if (signatureBytes.length !== 64) authFail()
  if (!verify(null, responseSigningBytes(input.scheme ?? 'runner', { ...input, bodySha256: responseBodySha256(input) }), input.publicKey, signatureBytes)) authFail()
  return undefined
}
