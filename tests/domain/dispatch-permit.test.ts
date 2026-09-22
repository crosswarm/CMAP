import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { describe, test } from 'node:test'

import type { TaskEnvelopeV1 } from '#domain-model'
import { DispatchPermitError, issueDispatchPermit, verifyDispatchPermit } from '../../packages/domain-model/src/dispatch-permit.ts'

const nowMs = 1_800_000_000_000

const envelope = (overrides: Partial<TaskEnvelopeV1> = {}): TaskEnvelopeV1 => ({
  schema: 'cmap/task-envelope/v1',
  identity: {
    mission_id: 'mission-1',
    task_id: 'task-1',
    idempotency_key: 'idem-1',
    revision: 1,
    tenant: 'tenant-a',
    owner: 'owner-a',
  },
  classification: {
    task_type: 'test',
    requested_capability: 'code.inspect',
    risk_level: 'controlled',
  },
  goal: {
    statement: 'inspect',
    success_definition: [{ criterion_id: 'c1', metric: 'done', operator: 'eq', expected: true }],
  },
  environment: {},
  execution_policy: {
    timeout_seconds: 60,
    max_attempts: 1,
  },
  permissions: {
    forbidden: [],
  },
  evidence_requirements: {
    required_artifact_roles: ['report'],
  },
  output_contract: {
    schema_uri: 'https://cmap.local/schemas/task-result/v1',
  },
  ...overrides,
})

const keys = (): { privateKey: KeyObject; publicKey: KeyObject } => {
  const pair = generateKeyPairSync('ed25519')
  return { privateKey: pair.privateKey, publicKey: pair.publicKey }
}

const input = (privateKey: KeyObject, e = envelope()) => ({
  privateKey,
  issuer: 'control-plane',
  runnerId: 'runner-1',
  adapterId: 'adapter-1',
  envelope: e,
  nowMs,
})

const verifyInput = (publicKey: KeyObject, e = envelope()) => ({
  publicKey,
  issuer: 'control-plane',
  runnerId: 'runner-1',
  adapterId: 'adapter-1',
  envelope: e,
  nowMs,
})

const b64url = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString('base64url')

const publicKeyId = (publicKey: KeyObject): string =>
  createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')

const envelopeSha = (e: TaskEnvelopeV1): string =>
  createHash('sha256').update(JSON.stringify(e), 'utf8').digest('hex')

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof DispatchPermitError)
    assert.equal(error.message, error.code)
    return error.code
  }
  assert.fail('expected DispatchPermitError')
}

const parts = (token: string): [string, string, string] => {
  const split = token.split('.')
  assert.equal(split.length, 3)
  return split as [string, string, string]
}

const tokenWithPayload = (token: string, mutate: (payload: Record<string, unknown>) => void): string => {
  const [prefix, payloadPart, sigPart] = parts(token)
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>
  mutate(payload)
  return `${prefix}.${b64url(JSON.stringify(payload))}.${sigPart}`
}

const manualToken = (privateKey: KeyObject, payloadText: string): string => {
  const payload = Buffer.from(payloadText, 'utf8')
  const signature = sign(null, Buffer.concat([Buffer.from('cmap1.', 'ascii'), payload]), privateKey)
  return `cmap1.${b64url(payload)}.${b64url(signature)}`
}

describe('dispatch permit native crypto core', () => {
  test('issues and verifies an Ed25519 permit bound to expected claims', () => {
    const { privateKey, publicKey } = keys()
    const token = issueDispatchPermit(input(privateKey))
    assert.match(token, /^cmap1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    assert.equal(verifyDispatchPermit(token, verifyInput(publicKey)), undefined)

    const [, payloadPart, sigPart] = parts(token)
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>
    assert.equal(sigPart.length, 86)
    assert.equal(payload.schema, 'cmap/dispatch-permit/v1')
    assert.equal(payload.issuer, 'control-plane')
    assert.equal(payload.audience, 'adapter-1')
    assert.equal(payload.runner_id, 'runner-1')
    assert.equal(payload.mission_id, 'mission-1')
    assert.equal(payload.task_id, 'task-1')
    assert.equal(payload.revision, 1)
    assert.equal(payload.idempotency_key, 'idem-1')
    assert.equal(payload.kid, publicKeyId(publicKey))
    assert.equal(payload.envelope_sha256, envelopeSha(envelope()))
    assert.equal(payload.issued_at, Math.floor(nowMs / 1000))
    assert.equal(payload.not_before, Math.floor(nowMs / 1000))
    assert.equal(payload.expires_at, Math.floor(nowMs / 1000) + 60)
  })

  test('rejects wrong key type and unknown key id distinctly', () => {
    const { privateKey, publicKey } = keys()
    const other = keys()
    const token = issueDispatchPermit(input(privateKey))
    assert.equal(codeOf(() => issueDispatchPermit({ ...input(publicKey), privateKey: publicKey })), 'UNKNOWN_KEY')
    assert.equal(codeOf(() => verifyDispatchPermit(token, verifyInput(privateKey))), 'UNKNOWN_KEY')
    assert.equal(codeOf(() => verifyDispatchPermit(token, verifyInput(other.publicKey))), 'UNKNOWN_KEY')
  })

  test('rejects tampered signature bytes before claim checks', () => {
    const { privateKey, publicKey } = keys()
    const [prefix, payloadPart, sigPart] = parts(issueDispatchPermit(input(privateKey)))
    const signature = Buffer.from(sigPart, 'base64url')
    signature[0] = (signature[0] ?? 0) ^ 1
    assert.equal(codeOf(() => verifyDispatchPermit(`${prefix}.${payloadPart}.${b64url(signature)}`, verifyInput(publicKey))), 'BAD_SIGNATURE')
  })

  test('rejects signed claim mismatches and unknown signed kid', () => {
    const { privateKey, publicKey } = keys()
    const base = issueDispatchPermit(input(privateKey))
    const claimToken = manualToken(privateKey, JSON.stringify({
      ...JSON.parse(Buffer.from(parts(base)[1], 'base64url').toString('utf8')),
      runner_id: 'runner-2',
    }))
    const kidToken = manualToken(privateKey, JSON.stringify({
      ...JSON.parse(Buffer.from(parts(base)[1], 'base64url').toString('utf8')),
      kid: '0'.repeat(64),
    }))
    assert.equal(codeOf(() => verifyDispatchPermit(claimToken, verifyInput(publicKey))), 'CLAIM_MISMATCH')
    assert.equal(codeOf(() => verifyDispatchPermit(kidToken, verifyInput(publicKey))), 'UNKNOWN_KEY')
    assert.equal(codeOf(() => verifyDispatchPermit(base, verifyInput(publicKey, envelope({ identity: { ...envelope().identity, task_id: 'task-2' } })))), 'CLAIM_MISMATCH')
  })

  test('enforces signer ttl and verifier clock bounds with no skew', () => {
    const { privateKey, publicKey } = keys()
    assert.equal(codeOf(() => issueDispatchPermit({ ...input(privateKey), ttlSeconds: 0 })), 'INVALID_LIFETIME')
    assert.equal(codeOf(() => issueDispatchPermit({ ...input(privateKey), ttlSeconds: 61 })), 'INVALID_LIFETIME')

    const token = issueDispatchPermit({ ...input(privateKey), ttlSeconds: 1 })
    assert.equal(codeOf(() => verifyDispatchPermit(token, { ...verifyInput(publicKey), nowMs: nowMs - 1000 })), 'NOT_YET_VALID')
    assert.equal(codeOf(() => verifyDispatchPermit(token, { ...verifyInput(publicKey), nowMs: nowMs + 1000 })), 'EXPIRED')

    const longLife = manualToken(privateKey, JSON.stringify({
      ...JSON.parse(Buffer.from(parts(token)[1], 'base64url').toString('utf8')),
      expires_at: Math.floor(nowMs / 1000) + 61,
    }))
    assert.equal(codeOf(() => verifyDispatchPermit(longLife, verifyInput(publicKey))), 'INVALID_LIFETIME')

    const delayedNbf = manualToken(privateKey, JSON.stringify({
      ...JSON.parse(Buffer.from(parts(token)[1], 'base64url').toString('utf8')),
      issued_at: Math.floor(nowMs / 1000) - 120,
      not_before: Math.floor(nowMs / 1000),
      expires_at: Math.floor(nowMs / 1000) + 30,
    }))
    assert.equal(codeOf(() => verifyDispatchPermit(delayedNbf, verifyInput(publicKey))), 'INVALID_LIFETIME')
    assert.equal(codeOf(() => verifyDispatchPermit(token, { ...verifyInput(publicKey), nowMs: Number.NaN })), 'INVALID_LIFETIME')
  })

  test('strictly rejects malformed encoding, fatal utf8, decoded sizes and schema shape', () => {
    const { privateKey, publicKey } = keys()
    const token = issueDispatchPermit(input(privateKey))
    const [prefix, payloadPart, sigPart] = parts(token)

    assert.equal(codeOf(() => verifyDispatchPermit(`${prefix}.${payloadPart}=.${sigPart}`, verifyInput(publicKey))), 'MALFORMED')
    assert.equal(codeOf(() => verifyDispatchPermit(`${prefix}.${b64url(Buffer.from([0xff]))}.${sigPart}`, verifyInput(publicKey))), 'MALFORMED')
    assert.equal(codeOf(() => verifyDispatchPermit(`${prefix}.${b64url('x'.repeat(4097))}.${sigPart}`, verifyInput(publicKey))), 'MALFORMED')
    assert.equal(codeOf(() => verifyDispatchPermit(`cmap1.${payloadPart}.${b64url(Buffer.alloc(65))}`, verifyInput(publicKey))), 'MALFORMED')
    assert.equal(codeOf(() => verifyDispatchPermit(`cmap1.${'A'.repeat(8190)}.AA`, verifyInput(publicKey))), 'MALFORMED')
    assert.equal(codeOf(() => verifyDispatchPermit(tokenWithPayload(token, (payload) => { payload.extra = true }), verifyInput(publicKey))), 'MALFORMED')
    assert.equal(codeOf(() => verifyDispatchPermit(undefined as unknown as string, verifyInput(publicKey))), 'MALFORMED')
  })

  test('verifies the original payload bytes across a child process using stdin', () => {
    const { privateKey, publicKey } = keys()
    const e = envelope()
    const t = Math.floor(nowMs / 1000)
    const payloadText = JSON.stringify({
      nonce: '12345678-1234-4234-9234-123456789abc',
      expires_at: t + 60,
      not_before: t,
      issued_at: t,
      envelope_sha256: envelopeSha(e),
      idempotency_key: e.identity.idempotency_key,
      revision: e.identity.revision,
      task_id: e.identity.task_id,
      mission_id: e.identity.mission_id,
      runner_id: 'runner-1',
      audience: 'adapter-1',
      issuer: 'control-plane',
      kid: publicKeyId(publicKey),
      schema: 'cmap/dispatch-permit/v1',
    }, null, 2)
    const token = manualToken(privateKey, payloadText)
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import { createPublicKey } from 'node:crypto'
      import { verifyDispatchPermit } from './packages/domain-model/src/dispatch-permit.ts'
      let stdin = ''
      for await (const chunk of process.stdin) stdin += chunk
      const input = JSON.parse(stdin)
      verifyDispatchPermit(input.token, {
        publicKey: createPublicKey(input.publicKeyPem),
        issuer: 'control-plane',
        runnerId: 'runner-1',
        adapterId: 'adapter-1',
        envelope: input.envelope,
        nowMs: input.nowMs,
      })
    `], {
      cwd: process.cwd(),
      input: JSON.stringify({
        token,
        publicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }),
        envelope: e,
        nowMs,
      }),
      encoding: 'utf8',
    })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(child.stdout, '')
  })
})
