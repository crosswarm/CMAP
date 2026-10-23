/**
 * M05 runner 注册与吊销（ADR-0008 §4，契约 runner-enrollment.v1）。OIDC 模式真实 HTTP：本地 JWKS + 现签 JWT。
 * admin 签发一次性令牌（tenant 取自 admin 的 claims，只存哈希）→ runner 持钥证明登记 → 网关逐请求验签 → admin 吊销后立即拒绝。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { MemoryStore, rawEd25519PublicKey, signEnrollmentProof, type EnrollmentToken, type RemoteRunnerDispatchV1 } from '#domain-model'
import { signRunnerRequest } from '../../packages/domain-model/src/dispatch-permit.ts'
import { createControlPlane } from '../../apps/control-plane-api/src/server.ts'
import { GatewayRunnerAdapter, gatewayLeaseId } from '../../adapters/runner-gateway/src/index.ts'

const ISSUER = 'http://idp.test/realms/cmap'
const AUDIENCE = 'cmap-api'
const S = 'cmap/runner-enrollment/v1'
const idp = generateKeyPairSync('rsa', { modulusLength: 2048 })
const gatewayKey = generateKeyPairSync('ed25519')
const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
const jwt = (over: Record<string, unknown>) => {
  const input = `${b64url({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64url({
    iss: ISSUER, aud: AUDIENCE, sub: 'sub-admin', exp: Math.floor(Date.now() / 1000) + 300, tenant: 'team-a', roles: ['admin'], ...over,
  })}`
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), idp.privateKey).toString('base64url')}`
}
const ADMIN = jwt({})
const OPERATOR = jwt({ sub: 'sub-op', roles: ['operator', 'viewer'] })
const ADMIN_B = jwt({ sub: 'sub-admin-b', tenant: 'team-b' })

class SpyStore extends MemoryStore {
  readonly issuedTokens: EnrollmentToken[] = []
  override async createEnrollmentToken(token: EnrollmentToken) {
    this.issuedTokens.push(structuredClone(token))
    return super.createEnrollmentToken(token)
  }
}

let store: SpyStore
let jwks: Server
let server: Awaited<ReturnType<typeof createControlPlane>>
let base: string

before(async () => {
  store = new SpyStore()
  const publicJwk = { ...idp.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
  jwks = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [publicJwk] })))
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve))
  server = await createControlPlane({
    store, tenant: 'config-tenant', owner: 'config-owner',
    oidc: { issuer: ISSUER, audience: AUDIENCE, jwksUrl: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/certs` },
    runnerGateway: { signingKey: gatewayKey.privateKey, pollIntervalMs: 20 },
  })
  await server.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(async () => {
  await server?.close()
  await new Promise<void>((resolve) => jwks?.close(() => resolve()))
})

const post = async (path: string, body: unknown, token?: string) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, text, body: text ? JSON.parse(text) : undefined }
}
const issue = (over: Record<string, unknown> = {}, token = ADMIN) => post('/v1/runner-enrollments', {
  schema: S, kind: 'issue', owner: 'sub-alice', allowed_capabilities: ['code.analyze'], max_risk: 'read-meta', ttl_seconds: 3600, ...over,
}, token)
const newKey = () => generateKeyPairSync('ed25519')
const enroll = (token: string, key: { privateKey: KeyObject; publicKey: KeyObject }, o: { host?: string; proofKey?: KeyObject; proofHost?: string } = {}) => {
  const public_key = rawEd25519PublicKey(key.publicKey)
  const host = o.host ?? 'alice-laptop'
  return post('/v1/runners/enroll', {
    schema: S, kind: 'enroll', token, public_key, host,
    proof: signEnrollmentProof({ privateKey: o.proofKey ?? key.privateKey, token, publicKey: public_key, host: o.proofHost ?? host }),
  })
}
const claim = async (runnerId: string, key: KeyObject) => {
  const body = JSON.stringify({ schema: 'cmap/runner-gateway/v1', kind: 'claim', runner_id: runnerId, wait_seconds: 1, held_leases: [] })
  const res = await fetch(`${base}/v1/gateway/claim`, { method: 'POST', body, headers: { 'content-type': 'application/json',
    ...signRunnerRequest({ privateKey: key, method: 'POST', target: '/v1/gateway/claim', audience: runnerId, body, scheme: 'gateway' }) } })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

test('admin 签发：令牌只出现在应答里一次，账本只存其 sha256；tenant 取自 admin 的 claims，issued_by 为其 sub', async () => {
  const res = await issue()
  assert.equal(res.status, 201)
  assert.match(res.body.token, /^cmapenr1\.[A-Za-z0-9_-]{43}$/)
  assert.deepEqual({ ...res.body, token: '<t>', token_id: '<id>', expires_at: '<e>' }, {
    schema: S, kind: 'issued', token: '<t>', token_id: '<id>', tenant: 'team-a', owner: 'sub-alice', allowed_capabilities: ['code.analyze'],
    max_risk: 'read-meta', issued_by: 'sub-admin', expires_at: '<e>', single_use: true,
  })
  const ttl = Date.parse(res.body.expires_at) - Date.now()
  assert.ok(ttl > 3500_000 && ttl <= 3600_000, '1 小时内过期')
  const stored = store.issuedTokens.at(-1)!
  assert.equal(stored.token_sha256, createHash('sha256').update(res.body.token).digest('hex'))
  assert.ok(!JSON.stringify(stored).includes(res.body.token.split('.')[1]), '账本不存令牌明文')
})

test('签发需要 admin 角色；请求体不能指定 tenant，ttl 不超过 1 小时', async () => {
  const forbidden = await issue({}, OPERATOR)
  assert.equal(forbidden.status, 403)
  assert.deepEqual(forbidden.body, { schema: S, kind: 'error', code: 'FORBIDDEN', retryable: false })
  assert.equal((await issue({ tenant: 'team-b' })).status, 400)
  assert.equal((await issue({ ttl_seconds: 3601 })).status, 400)
  assert.equal((await post('/v1/runner-enrollments', { schema: S, kind: 'issue' })).status, 401, '无 JWT 不能签发')
})

test('runner 持钥证明登记（不需要 OIDC）：身份与上限取自令牌，得到 runner_id 与控制面公钥，随后网关请求逐个验签通过', async () => {
  const issued = (await issue({ max_risk: 'controlled', allowed_capabilities: ['code.analyze', 'code.modify'] })).body
  const key = newKey()
  const res = await enroll(issued.token, key)
  assert.equal(res.status, 201, res.text)
  assert.equal(res.body.kind, 'enrolled')
  assert.deepEqual([res.body.tenant, res.body.owner, res.body.allowed_capabilities, res.body.max_risk],
    ['team-a', 'sub-alice', ['code.analyze', 'code.modify'], 'controlled'])
  assert.equal(res.body.control_plane_public_key, rawEd25519PublicKey(gatewayKey.publicKey))
  const runner = (await store.getGatewayRunner(res.body.runner_id))!
  assert.equal(runner.public_key, rawEd25519PublicKey(key.publicKey))
  assert.equal(runner.host, 'alice-laptop')
  assert.equal((await claim(res.body.runner_id, key.privateKey)).status, 200)
  assert.equal((await claim(res.body.runner_id, newKey().privateKey)).status, 401, '别的私钥签的请求不认')
})

test('登记拒绝一律同一个 ENROLLMENT_DENIED：重复使用、过期、错误持钥证明、证明与 host 不符、未知令牌、公钥已登记', async () => {
  const used = (await issue()).body.token
  const usedKey = newKey()
  assert.equal((await enroll(used, usedKey)).status, 201)
  const expiring = (await issue({ ttl_seconds: 1 })).body.token
  await new Promise((r) => setTimeout(r, 1100))
  const fresh = () => issue().then((r) => r.body.token as string)
  const cases = [
    await enroll(used, newKey()),
    await enroll(expiring, newKey()),
    await enroll(await fresh(), newKey(), { proofKey: newKey().privateKey }),
    await enroll(await fresh(), newKey(), { proofHost: 'other-host' }),
    await enroll(`cmapenr1.${'A'.repeat(43)}`, newKey()),
    await enroll(await fresh(), usedKey),
  ]
  for (const [i, c] of cases.entries()) {
    assert.equal(c.status, 403, `case ${i}: ${c.text}`)
    assert.equal(c.text, JSON.stringify({ schema: S, kind: 'error', code: 'ENROLLMENT_DENIED', retryable: false }), `case ${i}`)
  }
  // 错误证明不消耗令牌：同一令牌换正确证明仍可登记
  const token = await fresh()
  const key = newKey()
  assert.equal((await enroll(token, key, { proofKey: newKey().privateKey })).status, 403)
  assert.equal((await enroll(token, key)).status, 201)
})

test('吊销：admin 吊销后网关请求立即 401；在途租约按执行不确定处理；非 admin 403、他租户 404、重复吊销幂等', async () => {
  const key = newKey()
  const enrolled = (await enroll((await issue()).body.token, key)).body
  const runnerId = enrolled.runner_id as string
  const dispatch: RemoteRunnerDispatchV1 = {
    schema: 'cmap/remote-runner/v1', kind: 'dispatch', runner_id: runnerId, permit: 'cmap1.e30.c2ln', envelope: { schema: 'cmap/task-envelope/v1' },
    trace_id: 't', correlation_id: 'c', deadline_at: '2099-01-01T00:00:00.000Z', inputs: [],
  }
  const binding = { adapter: 'gateway-runner-adapter', remote_task_id: 'codex:tsk-rv:1', protocol: 'cmap-runner-gateway', protocol_version: '1', runner_id: runnerId }
  await store.enqueueGatewayLease({ lease_id: gatewayLeaseId(binding), runner_id: runnerId, task_id: 'tsk-rv', remote_task_id: 'codex:tsk-rv:1', dispatch, created_at: new Date().toISOString() })
  const claimed = await claim(runnerId, key.privateKey)
  assert.ok(claimed.body['assignment'], '吊销前正常领取')
  const adapter = new GatewayRunnerAdapter({ authorization: { mode: 'standalone' }, store, agentId: 'codex@gateway', workRoot: '/nonexistent', capabilities: ['code.analyze'] })
  assert.equal((await adapter.getStatus(binding)).status, 'running')

  assert.equal((await post(`/v1/runners/${runnerId}/revoke`, {}, OPERATOR)).status, 403)
  assert.equal((await post(`/v1/runners/${runnerId}/revoke`, {}, ADMIN_B)).status, 404, '他租户的 runner 不泄露存在性')
  assert.equal((await post('/v1/runners/ghost/revoke', {}, ADMIN)).status, 404)
  const revoked = await post(`/v1/runners/${runnerId}/revoke`, {}, ADMIN)
  assert.equal(revoked.status, 200)
  assert.deepEqual(Object.keys(revoked.body).sort(), ['kind', 'revoked_at', 'runner_id', 'schema'])
  assert.equal(revoked.body.kind, 'revoked')
  const again = await post(`/v1/runners/${runnerId}/revoke`, {}, ADMIN)
  assert.equal(again.body.revoked_at, revoked.body.revoked_at)

  const after = await claim(runnerId, key.privateKey)
  assert.equal(after.status, 401)
  assert.deepEqual(after.body, { schema: 'cmap/runner-gateway/v1', kind: 'error', code: 'UNAUTHORIZED', retryable: false })
  await assert.rejects(adapter.getStatus(binding), (e: { code?: string }) => e.code === 'BINDING_NOT_FOUND')
})

test('长轮询期间被吊销：这次领取立即结束且不下发派发', async () => {
  const key = newKey()
  const runnerId = (await enroll((await issue()).body.token, key)).body.runner_id as string
  const body = JSON.stringify({ schema: 'cmap/runner-gateway/v1', kind: 'claim', runner_id: runnerId, wait_seconds: 20, held_leases: [] })
  const started = Date.now()
  const pending = fetch(`${base}/v1/gateway/claim`, { method: 'POST', body, headers: { 'content-type': 'application/json',
    ...signRunnerRequest({ privateKey: key.privateKey, method: 'POST', target: '/v1/gateway/claim', audience: runnerId, body, scheme: 'gateway' }) } })
  await new Promise((r) => setTimeout(r, 200))
  assert.equal((await post(`/v1/runners/${runnerId}/revoke`, {}, ADMIN)).status, 200)
  await store.enqueueGatewayLease({ lease_id: 'lse-late', runner_id: runnerId, task_id: 'tsk-late', remote_task_id: 'codex:tsk-late:1', created_at: new Date().toISOString(),
    dispatch: { schema: 'cmap/remote-runner/v1', kind: 'dispatch', runner_id: runnerId, permit: 'cmap1.e30.c2ln', envelope: {}, trace_id: 't', correlation_id: 'c', deadline_at: '2099-01-01T00:00:00.000Z', inputs: [] } })
  const res = await pending
  const reply = await res.json() as { assignment: unknown }
  assert.ok(Date.now() - started < 5000, '吊销后不再等满 wait_seconds')
  assert.equal(reply.assignment, null)
  assert.equal((await store.getGatewayLease('lse-late'))!.state, 'queued')
})
