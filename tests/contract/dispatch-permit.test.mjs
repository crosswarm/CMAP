import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import Ajv from 'ajv/dist/2020.js'

const schema = JSON.parse(readFileSync(new URL('../../schemas/dispatch-permit.v1.schema.json', import.meta.url), 'utf8'))
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema)

const valid = {
  schema: 'cmap/dispatch-permit/v1',
  kid: 'a'.repeat(64),
  issuer: 'control-plane',
  audience: 'adapter-1',
  runner_id: 'runner-1',
  mission_id: 'mission-1',
  task_id: 'task-1',
  revision: 1,
  idempotency_key: 'mission-1:task-1',
  envelope_sha256: 'b'.repeat(64),
  issued_at: 1_800_000_000,
  not_before: 1_800_000_000,
  expires_at: 1_800_000_060,
  nonce: '12345678-1234-4234-9234-123456789abc',
}

const invalid = (patch) => {
  const value = structuredClone(valid)
  patch(value)
  return value
}

describe('dispatch-permit schema', () => {
  test('accepts the strict v1 claim set', () => {
    assert.equal(validate(valid), true, JSON.stringify(validate.errors))
  })

  test('rejects shape drift and wildcard-like identities', () => {
    for (const value of [
      invalid((v) => { v.schema = 'cmap/dispatch-permit/v2' }),
      invalid((v) => { v.kid = 'g'.repeat(64) }),
      invalid((v) => { v.issuer = 'control plane' }),
      invalid((v) => { v.audience = '*' }),
      invalid((v) => { v.runner_id = '' }),
      invalid((v) => { v.revision = 0 }),
      invalid((v) => { v.envelope_sha256 = 'b'.repeat(63) }),
      invalid((v) => { v.nonce = 'not-a-uuid' }),
      invalid((v) => { v.extra = true }),
    ]) assert.equal(validate(value), false, JSON.stringify(value))
  })
})
