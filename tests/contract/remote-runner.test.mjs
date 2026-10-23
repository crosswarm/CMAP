import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import Ajv from 'ajv/dist/2020.js'

const schema = JSON.parse(readFileSync(new URL('../../schemas/remote-runner.v1.schema.json', import.meta.url), 'utf8'))
const quotaSchema = JSON.parse(readFileSync(new URL('../../schemas/quota-snapshot.v1.schema.json', import.meta.url), 'utf8'))
const withQuota = (ajv) => ajv.addSchema(quotaSchema, new URL('quota-snapshot.v1.schema.json', schema.$id).href)
const validate = withQuota(new Ajv({ strict: true, allErrors: true })).compile(schema)

const S = 'cmap/remote-runner/v1'
const H = 'a'.repeat(64)
const valid = {
  dispatch: {
    schema: S, kind: 'dispatch', runner_id: 'lap', permit: 'cmap1.eyJ.c2ln', envelope: { schema: 'cmap/task-envelope/v1' },
    trace_id: 'tsk-1', correlation_id: 'mis-1:tsk-1', deadline_at: '2026-10-18T00:00:00.000Z',
    // memory/review 冻结输入与 DAG 父节点产物（inputs/<node_id>/…）同一布局
    inputs: [{ uri: `inputs/memory/${H}/payload`, sha256: H, content_base64: 'b2s=' }, { uri: `inputs/left_1/${H}/payload`, sha256: H, content_base64: 'b2s=' }],
  },
  dispatch_accepted: { schema: S, kind: 'dispatch_accepted', runner_id: 'lap', remote_task_id: 'codex:tsk-1:1' },
  status: { schema: S, kind: 'status', remote_task_id: 'codex:tsk_ab:cd:2', status: 'running', terminal_observed: false },
  result: {
    schema: S, kind: 'result', remote_task_id: 'codex:tsk-1:1', result: { schema: 'cmap/task-result/v1' },
    artifacts: [{ uri: 'evidence/report.txt', content_base64: 'b2s=' }, { uri: '.cmap/a b.md', content_base64: '' }],
  },
  cancel: { schema: S, kind: 'cancel', remote_task_id: 'codex:tsk-1:1', reason: 'TIMEOUT' },
  health: {
    schema: S, kind: 'health', runner_id: 'lap', state: 'healthy', checked_at: '2026-10-18T00:00:00.000Z',
    admission: { allowed_tenants: ['team-ycc'], allowed_owners: ['crosswarm'], allowed_capabilities: ['code.analyze'], max_risk: 'read-meta' },
  },
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
      patch('dispatch', (v) => { v.inputs[0].uri = `inputs/.memory/${H}/payload` }),
      patch('dispatch', (v) => { v.inputs[0].uri = `inputs/1node/${H}/payload` }),
      patch('dispatch', (v) => { v.inputs[0].uri = `inputs/a/b/${H}/payload` }),
      patch('dispatch', (v) => { v.inputs[0].uri = `inputs/${'n'.repeat(65)}/${H}/payload` }),
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
      // 旧版 lap 不公布白名单：应答无效，按不可用回落本地，而不是退回静态能力声明
      patch('health', (v) => { delete v.admission }),
      patch('health', (v) => { v.admission.allowed_capabilities = ['*'] }),
      patch('health', (v) => { v.admission.allowed_owners = ['a', 'a'] }),
      patch('health', (v) => { v.admission.max_risk = 'root' }),
      patch('health', (v) => { delete v.admission.allowed_tenants }),
      patch('health', (v) => { v.admission.host = 'cross-m1mx' }),
      patch('health', (v) => { v.quota = { schema: 'cmap/quota-snapshot/v1', provider: 'codex', account_ref: 'raw-account-id', windows: [], ordinary_usage_allowed: null, observed_at: '2026-10-18T00:00:00.000Z', status: 'ok' } }),
      patch('error', (v) => { v.category = 'internal' }),
      patch('error', (v) => { v.code = 'lowercase' }),
      patch('error', (v) => { v.message = 'provider stderr' }),
    ]) assert.equal(validate(value), false, `${kind}: ${JSON.stringify(value)}`)
  })

  test('health 可选附带额度快照（ADR-0009），旧 runner 不带也有效', () => {
    const quota = { schema: 'cmap/quota-snapshot/v1', provider: 'codex', account_ref: H, windows: [{ kind: 'primary', used_percent: 84, window_minutes: 10080, resets_at: '2026-10-29T00:00:00.000Z' }], ordinary_usage_allowed: true, observed_at: '2026-10-18T00:00:00.000Z', status: 'ok' }
    assert.equal(validate({ ...valid.health, quota }), true, JSON.stringify(validate.errors))
    assert.equal(validate(valid.health), true)
  })

  test('error 允许无细节的 UNAUTHORIZED（401 体）', () => {
    assert.equal(validate({ schema: S, kind: 'error', category: 'protocol', code: 'UNAUTHORIZED', retryable: false }), true)
  })
})

describe('remote-runner 请求/响应认证头', () => {
  const ajv = withQuota(new Ajv({ strict: true, allErrors: true }))
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

describe('remote-runner 产物流式传输（M09）', () => {
  const ajv = withQuota(new Ajv({ strict: true, allErrors: true }))
  ajv.addSchema(schema)
  const def = (name) => ajv.getSchema(`${schema.$id}#/$defs/${name}`)
  const streamed = { uri: 'evidence/big.bin', sha256: H, size_bytes: 17 * 1024 * 1024 }

  test('result 只带元数据（sha256 + 长度）即有效；旧 runner 的内联产物仍有效', () => {
    const result = { ...valid.result, artifacts: [streamed, { uri: 'evidence/report.txt', content_base64: 'b2s=' }] }
    assert.equal(validate(result), true, JSON.stringify(validate.errors))
  })

  test('流式元数据缺哈希或长度、哈希畸形、长度非整数、混入内联字节或路径越界均无效', () => {
    for (const fn of [
      (a) => { delete a.sha256 },
      (a) => { delete a.size_bytes },
      (a) => { a.sha256 = 'A'.repeat(64) },
      (a) => { a.size_bytes = -1 },
      (a) => { a.size_bytes = 1.5 },
      (a) => { a.content_base64 = 'b2s=' },
      (a) => { a.uri = '../x' },
    ]) {
      const art = structuredClone(streamed)
      fn(art)
      assert.equal(validate({ ...valid.result, artifacts: [art] }), false, JSON.stringify(art))
    }
  })

  test('产物流应答头：必须带长度与签名', () => {
    const v = def('artifactStream')
    assert.equal(v({ 'content-length': '17825792', 'x-cmap-signature': 'A'.repeat(86) }), true)
    assert.equal(v({ 'x-cmap-signature': 'A'.repeat(86) }), false)
    assert.equal(v({ 'content-length': '-1', 'x-cmap-signature': 'A'.repeat(86) }), false)
    assert.equal(v({ 'content-length': '1' }), false)
  })
})
