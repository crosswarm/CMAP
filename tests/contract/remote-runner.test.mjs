import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import Ajv from 'ajv/dist/2020.js'

const schema = JSON.parse(readFileSync(new URL('../../schemas/remote-runner.v1.schema.json', import.meta.url), 'utf8'))
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema)

const S = 'cmap/remote-runner/v1'
const H = 'a'.repeat(64)
const valid = {
  dispatch: {
    schema: S, kind: 'dispatch', runner_id: 'lap', permit: 'cmap1.eyJ.c2ln', envelope: { schema: 'cmap/task-envelope/v1' },
    trace_id: 'tsk-1', correlation_id: 'mis-1:tsk-1', deadline_at: '2026-10-18T00:00:00.000Z',
    inputs: [{ uri: `inputs/memory/${H}/payload`, sha256: H, content_base64: 'b2s=' }],
  },
  dispatch_accepted: { schema: S, kind: 'dispatch_accepted', runner_id: 'lap', remote_task_id: 'codex:tsk-1:1' },
  status: { schema: S, kind: 'status', remote_task_id: 'codex:tsk_ab:cd:2', status: 'running', terminal_observed: false },
  result: {
    schema: S, kind: 'result', remote_task_id: 'codex:tsk-1:1', result: { schema: 'cmap/task-result/v1' },
    artifacts: [{ uri: 'evidence/report.txt', content_base64: 'b2s=' }, { uri: '.cmap/a b.md', content_base64: '' }],
  },
  cancel: { schema: S, kind: 'cancel', remote_task_id: 'codex:tsk-1:1', reason: 'TIMEOUT' },
  health: { schema: S, kind: 'health', runner_id: 'lap', state: 'healthy', checked_at: '2026-10-18T00:00:00.000Z' },
  error: { schema: S, kind: 'error', category: 'permit', code: 'CLAIM_MISMATCH', retryable: false },
}

const patch = (kind, fn) => {
  const value = structuredClone(valid[kind])
  fn(value)
  return [kind, value]
}

describe('remote-runner schema', () => {
  test('accepts every v1 message kind', () => {
    for (const [kind, value] of Object.entries(valid)) assert.equal(validate(value), true, `${kind}: ${JSON.stringify(validate.errors)}`)
  })

  test('rejects drift, traversal, wildcard runners and leaked detail', () => {
    for (const [kind, value] of [
      patch('dispatch', (v) => { v.schema = 'cmap/remote-runner/v2' }),
      patch('dispatch', (v) => { v.runner_id = '*' }),
      patch('dispatch', (v) => { v.permit = 'Bearer abc' }),
      patch('dispatch', (v) => { delete v.inputs }),
      patch('dispatch', (v) => { v.inputs[0].uri = '../inputs/memory/x/payload' }),
      patch('dispatch', (v) => { v.inputs[0].uri = `inputs/other/${H}/payload` }),
      patch('dispatch', (v) => { v.inputs[0].content_base64 = 'not base64!' }),
      patch('dispatch', (v) => { v.token = 'secretref://x' }),
      patch('dispatch_accepted', (v) => { v.remote_task_id = 'codex:../x:1' }),
      patch('dispatch_accepted', (v) => { v.remote_task_id = 'kimi:tsk-1:1' }),
      patch('status', (v) => { v.status = 'done' }),
      patch('status', (v) => { v.detail = 'stderr tail' }),
      patch('result', (v) => { v.artifacts[0].uri = '/etc/passwd' }),
      patch('result', (v) => { v.artifacts[0].uri = 'evidence/../../x' }),
      patch('result', (v) => { v.artifacts[0].uri = './x' }),
      patch('result', (v) => { v.artifacts[0].sha256 = H }),
      patch('cancel', (v) => { v.reason = '' }),
      patch('health', (v) => { v.state = 'up' }),
      patch('error', (v) => { v.category = 'internal' }),
      patch('error', (v) => { v.code = 'lowercase' }),
      patch('error', (v) => { v.message = 'provider stderr' }),
    ]) assert.equal(validate(value), false, `${kind}: ${JSON.stringify(value)}`)
  })

  test('error 允许无细节的 UNAUTHORIZED（401 体）', () => {
    assert.equal(validate({ schema: S, kind: 'error', category: 'protocol', code: 'UNAUTHORIZED', retryable: false }), true)
  })
})

describe('remote-runner 请求/响应认证头', () => {
  const ajv = new Ajv({ strict: true, allErrors: true })
  ajv.addSchema(schema)
  const headers = (name) => ajv.getSchema(`${schema.$id}#/$defs/${name}`)
  const SIG = 'A'.repeat(86)
  const request = {
    'x-cmap-timestamp': '1792281600000',
    'x-cmap-nonce': 'bm9uY2Utbm9uY2Utbm9uY2U',
    'x-cmap-audience': 'lap',
    'x-cmap-content-sha256': H,
    'x-cmap-signature': SIG,
  }

  test('接受完整的请求头与响应头', () => {
    assert.equal(headers('requestAuthHeaders')(request), true)
    assert.equal(headers('responseAuthHeaders')({ 'x-cmap-signature': SIG }), true)
  })

  test('拒绝缺头、通配受众、非 sha256、畸形时间戳/nonce/签名', () => {
    const v = headers('requestAuthHeaders')
    for (const name of Object.keys(request)) {
      const { [name]: _omit, ...rest } = request
      assert.equal(v(rest), false, `缺 ${name}`)
    }
    for (const patch of [
      { 'x-cmap-audience': '*' },
      { 'x-cmap-content-sha256': 'abc' },
      { 'x-cmap-timestamp': '17922816' },
      { 'x-cmap-timestamp': '1792281600.5' },
      { 'x-cmap-nonce': 'short' },
      { 'x-cmap-signature': 'A'.repeat(85) },
      { 'x-cmap-signature': `${'A'.repeat(85)}=` },
    ]) assert.equal(v({ ...request, ...patch }), false, JSON.stringify(patch))
    assert.equal(headers('responseAuthHeaders')({}), false)
    assert.equal(headers('responseAuthHeaders')({ 'x-cmap-signature': 'short' }), false)
  })
})
