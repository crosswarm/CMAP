import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto'
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
