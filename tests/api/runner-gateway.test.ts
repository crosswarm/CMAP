/**
 * M04 runner 出站网关（ADR-0008 §3，契约 runner-gateway.v1）：API 进程内的长轮询领取、续租、回报与取消下发。
 * MemoryStore + 真实 HTTP；runner 一侧用登记的 Ed25519 私钥直接签请求。
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { MemoryStore, rawEd25519PublicKey, type GatewayRunner, type RemoteRunnerDispatchV1, type Mission, type TaskRecord } from '#domain-model'
import { signRunnerRequest, verifyRunnerResponse } from '../../packages/domain-model/src/dispatch-permit.ts'
import { createControlPlane } from '../../apps/control-plane-api/src/server.ts'

const S = 'cmap/runner-gateway/v1'
const R = 'cmap/remote-runner/v1'
const T0 = '2026-10-23T00:00:00.000Z'
const actor = { type: 'system', id: 'test' } as const
const controlPlane = generateKeyPairSync('ed25519')

const runnerRecord = (runner_id: string, key: KeyObject, overrides: Partial<GatewayRunner> = {}): GatewayRunner => ({
  runner_id, public_key: rawEd25519PublicKey(key), tenant: 'team-ycc', owner: 'crosswarm', allowed_capabilities: ['code.analyze'],
  max_risk: 'read-meta', host: 'lap', enrolled_at: T0, revoked_at: null, last_seen_at: null, ...overrides,
})

const dispatch = (runner_id: string, taskId: string): RemoteRunnerDispatchV1 => ({
  schema: R, kind: 'dispatch', runner_id, permit: 'cmap1.e30.c2ln', envelope: { schema: 'cmap/task-envelope/v1' },
  trace_id: taskId, correlation_id: 'c', deadline_at: '2099-01-01T00:00:00.000Z', inputs: [],
})

type Tamper = (h: Record<string, string>, b: string) => [Record<string, string>, string]
type CallOpts = { key?: KeyObject; runnerId?: string; nowMs?: number; tamper?: Tamper }

async function setup(t: TestContext, opts: { leaseTtlMs?: number; notify?: (missionId: string, workflowId: string) => Promise<void> } = {}) {
  const store = new MemoryStore()
  const server = await createControlPlane({
    store, tenant: 'team-ycc', owner: 'crosswarm',
    runnerGateway: { signingKey: controlPlane.privateKey, pollIntervalMs: 20, ...(opts.leaseTtlMs ? { leaseTtlMs: opts.leaseTtlMs } : {}) },
    ...(opts.notify ? { notifyRunnerReported: opts.notify } : {}),
  })
  await server.listen(0)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const key = generateKeyPairSync('ed25519')
  await store.registerGatewayRunner(runnerRecord('lap', key.publicKey))
  const now = new Date().toISOString()
  const mission: Mission = {
    id: 'mis-gw', tenant: 'team-ycc', owner: 'crosswarm', type: 'inspect', goal: 'gw', constraints: {},
    acceptance: [{ criterion_id: 'c', metric: 'm', operator: 'eq', expected: 1, hard_gate: true }],
    workflow_template: 'dag/v1', state: 'RUNNING', revision: 1, created_at: now, updated_at: now,
  }
  await store.createMission({ mission, actor })
  const enqueue = async (leaseId: string, taskId: string) => {
    await store.createTask({ actor, task: {
      id: taskId, mission_id: 'mis-gw', parent_task_id: null, supersedes_task_id: null, capability: 'code.analyze', risk: 'read-meta',
      state: 'DRAFT', attempt: 1, max_attempts: 1, lamport: 0, envelope: { schema: 'cmap/task-envelope/v1' } as TaskRecord['envelope'],
      result: null, binding: null, deps: [], created_at: now, updated_at: now,
    } })
    return store.enqueueGatewayLease({ lease_id: leaseId, runner_id: 'lap', task_id: taskId, remote_task_id: `codex:${taskId}:1`, dispatch: dispatch('lap', taskId), created_at: new Date().toISOString() })
  }
  /** 以 runner 身份发一个签名请求；tamper 在签名之后改动请求，用来验证每一项都被签名覆盖。 */
  const call = async (path: string, body: unknown, o: CallOpts = {}) => {
    let payload = JSON.stringify(body)
    let headers = signRunnerRequest({ privateKey: o.key ?? key.privateKey, method: 'POST', target: path, audience: o.runnerId ?? 'lap', body: payload, scheme: 'gateway', ...(o.nowMs ? { nowMs: o.nowMs } : {}) })
    if (o.tamper) [headers, payload] = o.tamper(headers, payload)
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload })
    const bytes = Buffer.from(await res.arrayBuffer())
    return { status: res.status, bytes, body: JSON.parse(bytes.toString('utf8')), signature: res.headers.get('x-cmap-signature'), nonce: headers['x-cmap-nonce']! }
  }
  const claim = (held: string[] = [], wait = 1, o: CallOpts = {}) => call('/v1/gateway/claim', { schema: S, kind: 'claim', runner_id: 'lap', wait_seconds: wait, held_leases: held }, o)
  const report = (leaseId: string, reportBody: unknown, o: CallOpts = {}) => call('/v1/gateway/reports', { schema: S, kind: 'report', runner_id: 'lap', lease_id: leaseId, body: reportBody }, o)
  const verified = (r: { status: number; bytes: Buffer; signature: string | null; nonce: string }) =>
    verifyRunnerResponse({ publicKey: controlPlane.publicKey, audience: 'lap', requestNonce: r.nonce, status: r.status, body: r.bytes, signature: r.signature, scheme: 'gateway' })
  return { store, key, base, enqueue, call, claim, report, verified }
}

test('领取：空闲时等满 wait_seconds 返回空闲应答；等待期间入队的派发立即下发并授予租约；应答带控制面签名', async (t) => {
  const g = await setup(t)
  const started = Date.now()
  const idle = await g.claim([], 1)
  assert.equal(idle.status, 200)
  assert.ok(Date.now() - started >= 900, '长轮询应等满 wait_seconds')
  assert.deepEqual(idle.body, { schema: S, kind: 'claim_result', runner_id: 'lap', renewed: [], expired: [], assignment: null, cancels: [] })
  g.verified(idle)
  assert.ok((await g.store.getGatewayRunner('lap'))!.last_seen_at, '通过认证的请求刷新在线时间')

  const pending = g.claim([], 10)
  await new Promise((r) => setTimeout(r, 200))
  await g.enqueue('lse-1', 'tsk-1')
  const got = await pending
  g.verified(got)
  assert.equal(got.body.assignment.lease.lease_id, 'lse-1')
  assert.deepEqual(got.body.assignment.dispatch, dispatch('lap', 'tsk-1'))
  assert.ok(Date.parse(got.body.assignment.lease.expires_at) > Date.now())
  assert.equal((await g.store.getGatewayLease('lse-1'))!.state, 'leased')
})

test('回报：受理、状态、结果依次落账；结果关闭租约后才向 Workflow 按门铃，应答 lease 为 null', async (t) => {
  const rung: string[] = []
  const g = await setup(t, { notify: async (missionId, workflowId) => {
    assert.equal((await g.store.getGatewayLease('lse-1'))!.state, 'closed', '门铃必须在结果落账之后')
    rung.push(`${missionId}|${workflowId}`)
  } })
  await g.enqueue('lse-1', 'tsk-1')
  await g.claim([], 1)
  const acc = await g.report('lse-1', { schema: R, kind: 'dispatch_accepted', runner_id: 'lap', remote_task_id: 'codex:tsk-1:1' })
  assert.equal(acc.status, 200)
  g.verified(acc)
  assert.equal(acc.body.kind, 'report_ack')
  assert.ok(acc.body.lease.expires_at)
  await g.report('lse-1', { schema: R, kind: 'status', remote_task_id: 'codex:tsk-1:1', status: 'running', terminal_observed: false })
  assert.deepEqual(rung, [], '非终态回报不按门铃')
  const done = await g.report('lse-1', { schema: R, kind: 'result', remote_task_id: 'codex:tsk-1:1', result: { schema: 'cmap/task-result/v1' }, artifacts: [] })
  assert.equal(done.status, 200)
  assert.deepEqual(done.body, { schema: S, kind: 'report_ack', lease_id: 'lse-1', lease: null })
  assert.deepEqual(rung, ['mis-gw|mission-mis-gw'])
  const again = await g.report('lse-1', { schema: R, kind: 'status', remote_task_id: 'codex:tsk-1:1', status: 'running', terminal_observed: false })
  assert.equal(again.status, 409)
  assert.deepEqual(again.body, { schema: S, kind: 'error', code: 'LEASE_UNKNOWN', retryable: false })
  g.verified(again)
})

test('租约过期：回报 LEASE_EXPIRED 且不落账；领取时列入 expired、不续回来、不改派', async (t) => {
  const g = await setup(t, { leaseTtlMs: 150 })
  await g.enqueue('lse-1', 'tsk-1')
  await g.claim([], 1)
  await new Promise((r) => setTimeout(r, 300))
  const late = await g.report('lse-1', { schema: R, kind: 'dispatch_accepted', runner_id: 'lap', remote_task_id: 'codex:tsk-1:1' })
  assert.equal(late.status, 409)
  assert.equal(late.body.code, 'LEASE_EXPIRED')
  assert.equal((await g.store.getGatewayLease('lse-1'))!.accepted, null)
  const next = await g.claim(['lse-1'], 1)
  assert.deepEqual(next.body.expired, ['lse-1'])
  assert.equal(next.body.assignment, null, '过期租约不会被重新派出')
})

test('取消：已领取租约的取消随下一次领取下发', async (t) => {
  const g = await setup(t)
  await g.enqueue('lse-1', 'tsk-1')
  await g.claim([], 1)
  await g.store.cancelGatewayLease('lse-1', { schema: R, kind: 'cancel', remote_task_id: 'codex:tsk-1:1', reason: 'MISSION_CANCELED' }, new Date().toISOString())
  const started = Date.now()
  const next = await g.claim(['lse-1'], 10)
  assert.ok(Date.now() - started < 2000, '有待下发的取消就立即应答')
  assert.deepEqual(next.body.cancels, [{ lease_id: 'lse-1', cancel: { schema: R, kind: 'cancel', remote_task_id: 'codex:tsk-1:1', reason: 'MISSION_CANCELED' } }])
  assert.equal(next.body.renewed[0].lease_id, 'lse-1')
})

test('认证失败一律同一个无签名 401，什么都不执行：未知 runner、错钥、改体、改路径、过期时间戳、重放、已吊销', async (t) => {
  const g = await setup(t)
  await g.enqueue('lse-1', 'tsk-1')
  const other = generateKeyPairSync('ed25519')
  const cases = [
    await g.claim([], 1, { runnerId: 'ghost' }),
    await g.claim([], 1, { key: other.privateKey }),
    await g.claim([], 1, { tamper: (h, b) => [h, b.replace('"wait_seconds":1', '"wait_seconds":2')] }),
    await g.claim([], 1, { nowMs: Date.now() - 10_000 }),
    await g.claim([], 1, { tamper: (h, b) => [{ ...h, 'x-cmap-signature': 'A'.repeat(86) }, b] }),
    await g.claim([], 1, { tamper: (h, b) => { const { ['x-cmap-nonce']: _n, ...rest } = h; return [rest, b] } }),
  ]
  // 签的是 /v1/gateway/reports，发到 /v1/gateway/claim
  {
    const body = JSON.stringify({ schema: S, kind: 'claim', runner_id: 'lap', wait_seconds: 1, held_leases: [] })
    const h = signRunnerRequest({ privateKey: g.key.privateKey, method: 'POST', target: '/v1/gateway/reports', audience: 'lap', body, scheme: 'gateway' })
    const r = await fetch(`${g.base}/v1/gateway/claim`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body })
    const bytes = Buffer.from(await r.arrayBuffer())
    cases.push({ status: r.status, bytes, body: JSON.parse(bytes.toString()), signature: r.headers.get('x-cmap-signature'), nonce: h['x-cmap-nonce']! })
  }
  // 同一组头与体原样重发：首次通过认证（体不合契约，签名的 400），第二次 nonce 已用过
  const sig = signRunnerRequest({ privateKey: g.key.privateKey, method: 'POST', target: '/v1/gateway/claim', audience: 'lap', body: '{}', scheme: 'gateway' })
  for (const expectStatus of [400, 401]) {
    const r = await fetch(`${g.base}/v1/gateway/claim`, { method: 'POST', headers: { 'content-type': 'application/json', ...sig }, body: '{}' })
    const bytes = Buffer.from(await r.arrayBuffer())
    assert.equal(r.status, expectStatus)
    if (expectStatus === 401) cases.push({ status: r.status, bytes, body: JSON.parse(bytes.toString()), signature: r.headers.get('x-cmap-signature'), nonce: sig['x-cmap-nonce']! })
  }
  await g.store.registerGatewayRunner(runnerRecord('revoked', other.publicKey, { revoked_at: T0 }))
  cases.push(await g.claim([], 1, { runnerId: 'revoked', key: other.privateKey }))

  const expected = cases[0]!.bytes.toString()
  assert.deepEqual(JSON.parse(expected), { schema: S, kind: 'error', code: 'UNAUTHORIZED', retryable: false })
  for (const [i, c] of cases.entries()) {
    assert.equal(c.status, 401, `case ${i}`)
    assert.equal(c.bytes.toString(), expected, `case ${i} 体逐字节一致`)
    assert.equal(c.signature, null, `case ${i} 不签名`)
  }
  assert.equal((await g.store.getGatewayLease('lse-1'))!.state, 'queued', '未认证请求不得领走派发')
})

test('runner_id 与签名身份不一致、或消息不合契约：签名的 400 INVALID_REQUEST，不领取', async (t) => {
  const g = await setup(t)
  await g.enqueue('lse-1', 'tsk-1')
  const mismatch = await g.call('/v1/gateway/claim', { schema: S, kind: 'claim', runner_id: 'someone-else', wait_seconds: 1, held_leases: [] })
  assert.equal(mismatch.status, 400)
  assert.equal(mismatch.body.code, 'INVALID_REQUEST')
  g.verified(mismatch)
  const tooLong = await g.call('/v1/gateway/claim', { schema: S, kind: 'claim', runner_id: 'lap', wait_seconds: 51, held_leases: [] })
  assert.equal(tooLong.status, 400)
  assert.equal((await g.store.getGatewayLease('lse-1'))!.state, 'queued')
})

test('领取附带的额度快照由网关按 runner 保存（只留最新）；不带或被篡改的快照不影响领取', async (t) => {
  const g = await setup(t)
  const quota = (observed_at: string, used: number) => ({
    schema: 'cmap/quota-snapshot/v1', provider: 'codex', account_ref: 'a'.repeat(64), ordinary_usage_allowed: true, observed_at, status: 'ok',
    windows: [{ kind: 'primary', used_percent: used, window_minutes: 10080, resets_at: null }],
  })
  const claimWith = (q?: unknown) => g.call('/v1/gateway/claim', { schema: S, kind: 'claim', runner_id: 'lap', wait_seconds: 1, held_leases: [], ...(q ? { quota: q } : {}) })
  assert.equal((await claimWith()).status, 200)
  assert.deepEqual(await g.store.listGatewayRunnerQuotas(), [])
  assert.equal((await claimWith(quota('2026-10-26T00:00:10.000Z', 40))).status, 200)
  assert.equal((await claimWith(quota('2026-10-26T00:00:00.000Z', 90))).status, 200)
  assert.deepEqual(await g.store.listGatewayRunnerQuotas(), [quota('2026-10-26T00:00:10.000Z', 40)])
  assert.equal((await claimWith({ ...quota('2026-10-26T00:00:20.000Z', 1), account_ref: 'raw-account-id' })).status, 400, '账号不是哈希摘要即不合契约')
  assert.equal((await g.store.listGatewayRunnerQuotas()).length, 1)
})
