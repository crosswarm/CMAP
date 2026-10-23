import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const read = (name) => JSON.parse(readFileSync(new URL(`../../schemas/${name}.v1.schema.json`, import.meta.url), 'utf8'))
const ajv = new Ajv({ strict: true, allErrors: true })
addFormats(ajv)
ajv.addSchema(read('remote-runner'), 'https://cmap.local/schemas/remote-runner.v1.schema.json')
// remote-runner 的 health.quota 以相对路径引用额度快照，按其 $id 解析后的地址登记
ajv.addSchema(read('quota-snapshot'), new URL('quota-snapshot.v1.schema.json', read('remote-runner').$id).href)
const validate = ajv.compile(read('runner-gateway'))

const S = 'cmap/runner-gateway/v1'
const R = 'cmap/remote-runner/v1'
const H = 'a'.repeat(64)
const lease = { lease_id: 'lse_01', expires_at: '2026-10-23T00:01:00.000Z' }
const dispatch = {
  schema: R, kind: 'dispatch', runner_id: 'lap', permit: 'cmap1.eyJ.c2ln', envelope: { schema: 'cmap/task-envelope/v1' },
  trace_id: 'tsk-1', correlation_id: 'mis-1:tsk-1', deadline_at: '2026-10-23T00:10:00.000Z',
  inputs: [{ uri: `inputs/memory/${H}/payload`, sha256: H, content_base64: 'b2s=' }],
}
const valid = {
  claim: { schema: S, kind: 'claim', runner_id: 'lap', wait_seconds: 50, held_leases: ['lse_01'] },
  claimIdle: { schema: S, kind: 'claim_result', runner_id: 'lap', renewed: [lease], expired: [], assignment: null, cancels: [] },
  claimAssigned: {
    schema: S, kind: 'claim_result', runner_id: 'lap', renewed: [], expired: ['lse_00'],
    assignment: { lease, dispatch },
    cancels: [{ lease_id: 'lse_02', cancel: { schema: R, kind: 'cancel', remote_task_id: 'codex:tsk-2:1', reason: 'MISSION_CANCELED' } }],
  },
  reportAccepted: { schema: S, kind: 'report', runner_id: 'lap', lease_id: 'lse_01', body: { schema: R, kind: 'dispatch_accepted', runner_id: 'lap', remote_task_id: 'codex:tsk-1:1' } },
  reportStatus: { schema: S, kind: 'report', runner_id: 'lap', lease_id: 'lse_01', body: { schema: R, kind: 'status', remote_task_id: 'codex:tsk-1:1', status: 'running', terminal_observed: false } },
  reportResult: {
    schema: S, kind: 'report', runner_id: 'lap', lease_id: 'lse_01',
    body: { schema: R, kind: 'result', remote_task_id: 'codex:tsk-1:1', result: { schema: 'cmap/task-result/v1' }, artifacts: [{ uri: 'evidence/report.txt', content_base64: 'b2s=' }] },
  },
  reportError: { schema: S, kind: 'report', runner_id: 'lap', lease_id: 'lse_01', body: { schema: R, kind: 'error', category: 'permit', code: 'EXPIRED', retryable: false } },
  ackLive: { schema: S, kind: 'report_ack', lease_id: 'lse_01', lease },
  ackClosed: { schema: S, kind: 'report_ack', lease_id: 'lse_01', lease: null },
  error: { schema: S, kind: 'error', code: 'LEASE_EXPIRED', retryable: false },
}

const patch = (name, fn) => {
  const value = structuredClone(valid[name])
  fn(value)
  return [name, value]
}

describe('runner-gateway schema', () => {
  test('接受出站领取、回报、续租与错误的每种消息', () => {
    for (const [name, value] of Object.entries(valid)) assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`)
  })

  test('拒绝超长轮询、改语义的消息体、泄漏细节与通配 runner', () => {
    for (const [name, value] of [
      patch('claim', (v) => { v.schema = 'cmap/runner-gateway/v2' }),
      patch('claim', (v) => { v.wait_seconds = 51 }),
      patch('claim', (v) => { v.wait_seconds = 0 }),
      patch('claim', (v) => { v.runner_id = '*' }),
      patch('claim', (v) => { v.held_leases = ['lse_01', 'lse_01'] }),
      patch('claim', (v) => { delete v.held_leases }),
      patch('claim', (v) => { v.tenant = 'team-ycc' }),
      patch('claimIdle', (v) => { delete v.assignment }),
      patch('claimIdle', (v) => { v.renewed[0].expires_at = 'tomorrow' }),
      patch('claimAssigned', (v) => { v.assignment.dispatch.permit = 'Bearer abc' }),
      patch('claimAssigned', (v) => { v.assignment.dispatch.schema = 'cmap/remote-runner/v2' }),
      patch('claimAssigned', (v) => { delete v.assignment.lease }),
      patch('claimAssigned', (v) => { v.cancels[0].cancel.reason = '' }),
      patch('claimAssigned', (v) => { v.assignment.dispatch.inputs[0].uri = '../x' }),
      // 回报体只能是 remote-runner.v1 的应答语义，不能夹带派发或取消
      patch('reportAccepted', (v) => { v.body = dispatch }),
      patch('reportStatus', (v) => { v.body.status = 'done' }),
      patch('reportStatus', (v) => { v.body.detail = 'stderr tail' }),
      patch('reportResult', (v) => { v.body.artifacts[0].sha256 = H }),
      patch('reportResult', (v) => { v.body.artifacts[0].uri = '/etc/passwd' }),
      patch('reportError', (v) => { v.body.message = 'provider stderr' }),
      patch('reportStatus', (v) => { delete v.lease_id }),
      patch('ackLive', (v) => { delete v.lease }),
      patch('error', (v) => { v.code = 'lowercase' }),
      patch('error', (v) => { v.detail = 'no such lease' }),
    ]) assert.equal(validate(value), false, `${name}: ${JSON.stringify(value)}`)
  })
})

describe('runner-gateway 产物流式上传（M09）', () => {
  const def = (name) => ajv.getSchema(`${read('runner-gateway').$id}#/$defs/${name}`)

  test('结果回报只带产物元数据；上传应答有效', () => {
    const report = structuredClone(valid.reportResult)
    report.body.artifacts = [{ uri: 'evidence/big.bin', sha256: H, size_bytes: 17 * 1024 * 1024 }]
    assert.equal(validate(report), true, JSON.stringify(validate.errors))
    assert.equal(validate({ schema: S, kind: 'upload_ack', lease_id: 'lse_01', sha256: H, size_bytes: 3 }), true, JSON.stringify(validate.errors))
    assert.equal(validate({ schema: S, kind: 'upload_ack', lease_id: 'lse_01', sha256: H }), false)
    assert.equal(validate({ schema: S, kind: 'error', code: 'EVIDENCE_HASH_MISMATCH', retryable: false }), true)
  })

  test('上传查询：租约、sha256、十进制长度都必填，别的字段与畸形值无效', () => {
    const v = def('artifactUpload')
    const q = { lease_id: 'lse_01', sha256: H, size: '17825792' }
    assert.equal(v(q), true, JSON.stringify(v.errors))
    for (const p of [{ size: '-1' }, { size: '01' }, { size: '1.5' }, { sha256: 'abc' }, { lease_id: '../x' }, { tenant: 't' }]) {
      assert.equal(v({ ...q, ...p }), false, JSON.stringify(p))
    }
    for (const k of Object.keys(q)) {
      const { [k]: _omit, ...rest } = q
      assert.equal(v(rest), false, `缺 ${k}`)
    }
  })
})
