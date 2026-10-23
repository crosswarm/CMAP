import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const schema = JSON.parse(readFileSync(new URL('../../schemas/runner-enrollment.v1.schema.json', import.meta.url), 'utf8'))
const ajv = new Ajv({ strict: true, allErrors: true })
addFormats(ajv)
const validate = ajv.compile(schema)

const S = 'cmap/runner-enrollment/v1'
const KEY = 'A'.repeat(43)
const TOKEN = `cmapenr1.${'b'.repeat(43)}`
const valid = {
  issue: { schema: S, kind: 'issue', owner: 'crosswarm', allowed_capabilities: ['code.analyze'], max_risk: 'read-meta', ttl_seconds: 3600 },
  issued: {
    schema: S, kind: 'issued', token: TOKEN, token_id: 'enr_01', tenant: 'team-ycc', owner: 'crosswarm',
    allowed_capabilities: ['code.analyze'], max_risk: 'read-meta', issued_by: 'admin-sub', expires_at: '2026-10-23T01:00:00.000Z', single_use: true,
  },
  enroll: { schema: S, kind: 'enroll', token: TOKEN, public_key: KEY, host: 'cross-m1mx', proof: 's'.repeat(86) },
  enrolled: {
    schema: S, kind: 'enrolled', runner_id: 'rnr_01', tenant: 'team-ycc', owner: 'crosswarm',
    allowed_capabilities: ['code.analyze'], max_risk: 'read-meta', control_plane_public_key: KEY, enrolled_at: '2026-10-23T00:10:00.000Z',
  },
  revoked: { schema: S, kind: 'revoked', runner_id: 'rnr_01', revoked_at: '2026-10-23T02:00:00.000Z' },
  error: { schema: S, kind: 'error', code: 'ENROLLMENT_DENIED', retryable: false },
}

const patch = (name, fn) => {
  const value = structuredClone(valid[name])
  fn(value)
  return [name, value]
}

describe('runner-enrollment schema', () => {
  test('接受签发、登记与统一拒绝的每种消息', () => {
    for (const [name, value] of Object.entries(valid)) assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`)
  })

  test('令牌只能一次性、不超过 1 小时；租户不取自请求；公钥只是 Ed25519 公钥', () => {
    for (const [name, value] of [
      patch('issue', (v) => { v.ttl_seconds = 3601 }),
      patch('issue', (v) => { v.ttl_seconds = 0 }),
      patch('issue', (v) => { v.tenant = 'team-other' }),
      patch('issue', (v) => { v.allowed_capabilities = ['*'] }),
      patch('issue', (v) => { v.max_risk = 'root' }),
      patch('issue', (v) => { delete v.owner }),
      patch('issued', (v) => { v.single_use = false }),
      patch('issued', (v) => { v.token = 'secretref://x' }),
      patch('issued', (v) => { v.expires_at = 'later' }),
      patch('enroll', (v) => { v.token = 'cmapenr1.short' }),
      patch('enroll', (v) => { v.public_key = '-----BEGIN PUBLIC KEY-----' }),
      patch('enroll', (v) => { v.private_key = KEY }),
      patch('enroll', (v) => { delete v.proof }),
      patch('enroll', (v) => { v.owner = 'someone-else' }),
      patch('enrolled', (v) => { v.token = TOKEN }),
      patch('enrolled', (v) => { v.allowed_owners = ['*'] }),
      patch('revoked', (v) => { delete v.revoked_at }),
      patch('revoked', (v) => { v.runner_id = '*' }),
      patch('revoked', (v) => { v.reason = 'stolen laptop' }),
      patch('error', (v) => { v.code = 'TOKEN_EXPIRED' }),
      patch('error', (v) => { v.detail = 'token used at 10:00' }),
    ]) assert.equal(validate(value), false, `${name}: ${JSON.stringify(value)}`)
  })
})
