/**
 * OIDC 模式（ADR-0008 §2，docs/identity.md）。
 *
 * 真实 HTTP：一个本地 JWKS 服务 + 真实 API；令牌由测试用 RSA 私钥现签，
 * 不 mock 校验逻辑。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync, sign, createHmac, type KeyObject } from 'node:crypto'

import { MemoryStore } from '#domain-model'
import type { Mission, EventActor, Store } from '#domain-model'
import { createControlPlane } from '../../apps/control-plane-api/src/server.ts'

const ISSUER = 'http://idp.test/realms/cmap'
const AUDIENCE = 'cmap-api'
const ACTOR: EventActor = { type: 'system', id: 'test' }
const T0 = '2026-10-23T00:00:00.000Z'

const keyPair = () => generateKeyPairSync('rsa', { modulusLength: 2048 })
const idp = keyPair()
const attacker = keyPair()

const b64url = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
const now = () => Math.floor(Date.now() / 1000)

const jwt = (claims: Record<string, unknown>, opts: { key?: KeyObject; kid?: string; alg?: string } = {}) => {
  const header = { alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid ?? 'k1' }
  const input = `${b64url(header)}.${b64url(claims)}`
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), opts.key ?? idp.privateKey).toString('base64url')}`
}

const claims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER, aud: AUDIENCE, sub: 'sub-alice', exp: now() + 300, iat: now(),
  tenant: 'team-a', roles: ['viewer'], ...over,
})

const mission = (id: string, tenant: string): Mission => ({
  id, tenant, owner: 'sub-alice', type: 'inspect', goal: 'g', constraints: {},
  acceptance: [{ criterion_id: 'C', metric: 'm', operator: 'eq', expected: 1, hard_gate: true }],
  workflow_template: 'dag/v1', state: 'RUNNING', revision: 1, created_at: T0, updated_at: T0,
})

let store: Store
let jwks: Server
let jwksHits = 0
let server: Awaited<ReturnType<typeof createControlPlane>>
let base: string
let port: number
const started: string[] = []

const call = async (path: string, init: { token?: string; method?: string; body?: unknown } = {}) => {
  const headers: Record<string, string> = {}
  if (init.token) headers['authorization'] = `Bearer ${init.token}`
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text }
}

before(async () => {
  store = new MemoryStore()
  await store.createMission({ mission: mission('mis-a', 'team-a'), actor: ACTOR })
  await store.createMission({ mission: mission('mis-b', 'team-b'), actor: ACTOR })
  const publicJwk = { ...idp.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
  jwks = createServer((_req, res) => {
    jwksHits++
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [publicJwk] }))
  })
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve))
  server = await createControlPlane({
    store, tenant: 'config-tenant', owner: 'config-owner',
    oidc: { issuer: ISSUER, audience: AUDIENCE, jwksUrl: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/certs` },
    startMission: async (missionId) => { started.push(missionId) },
  })
  await server.listen(0)
  port = (server.address() as AddressInfo).port
  base = `http://127.0.0.1:${port}`
})

after(async () => {
  await server?.close()
  await new Promise<void>((resolve) => jwks?.close(() => resolve()))
})

describe('OIDC 认证：401', () => {
  test('无 token 访问 /v1/context 与 /v1/missions 返回 401 且带 WWW-Authenticate', async () => {
    for (const path of ['/v1/context', '/v1/missions', '/v1/approvals', '/v1/events']) {
      const res = await call(path)
      assert.equal(res.status, 401, path)
      assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer/)
    }
  })

  test('错误 aud、错误 iss、过期、未生效、签名不符、篡改、alg 降级都返回 401', async () => {
    const valid = jwt(claims())
    const [h, p] = valid.split('.')
    const tampered = `${h}.${b64url({ ...claims(), tenant: 'team-b' })}.${valid.split('.')[2]}`
    const hsHeader = b64url({ alg: 'HS256', typ: 'JWT', kid: 'k1' })
    const hs = `${hsHeader}.${p}.${createHmac('sha256', 'guess').update(`${hsHeader}.${p}`).digest('base64url')}`
    const none = `${b64url({ alg: 'none', typ: 'JWT', kid: 'k1' })}.${p}.`
    for (const [name, token] of [
      ['aud', jwt(claims({ aud: 'account' }))],
      ['aud 数组不含受众', jwt(claims({ aud: ['account', 'other'] }))],
      ['iss', jwt(claims({ iss: 'http://evil.test/realms/cmap' }))],
      ['过期', jwt(claims({ exp: now() - 120 }))],
      ['无 exp', jwt(claims({ exp: undefined }))],
      ['nbf 未到', jwt(claims({ nbf: now() + 600 }))],
      ['无 sub', jwt(claims({ sub: undefined }))],
      ['别的私钥签', jwt(claims(), { key: attacker.privateKey })],
      ['未知 kid', jwt(claims(), { kid: 'k-unknown' })],
      ['篡改 payload', tampered],
      ['HS256', hs],
      ['alg none', none],
      ['不是 JWT', 'not-a-jwt'],
    ] as const) {
      assert.equal((await call('/v1/context', { token })).status, 401, name)
    }
  })

  test('aud 为数组且包含受众时接受', async () => {
    assert.equal((await call('/v1/context', { token: jwt(claims({ aud: ['account', AUDIENCE] })) })).status, 200)
  })
})

describe('OIDC 认证：claims 决定身份', () => {
  test('/v1/context 返回 token 的 tenant 与 sub，authentication=oidc，不用进程配置', async () => {
    const res = await call('/v1/context', { token: jwt(claims()) })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { tenant: 'team-a', owner: 'sub-alice', authentication: 'oidc' })
  })

  test('/v1/missions 只返回 token 租户的 Mission；跨租户详情 404', async () => {
    const a = await call('/v1/missions', { token: jwt(claims()) })
    assert.deepEqual((a.body as { items: Mission[] }).items.map((m) => m.id), ['mis-a'])
    const b = await call('/v1/missions', { token: jwt(claims({ tenant: 'team-b', sub: 'sub-bob' })) })
    assert.deepEqual((b.body as { items: Mission[] }).items.map((m) => m.id), ['mis-b'])
    assert.equal((await call('/v1/missions/mis-b', { token: jwt(claims()) })).status, 404)
  })

  test('创建 Mission 的 tenant/owner 取自 claims', async () => {
    const res = await call('/v1/missions', {
      token: jwt(claims({ tenant: 'team-c', sub: 'sub-carol', roles: ['operator'] })),
      body: { request_id: 'oidc-create-001', goal: 'Count files', risk_level: 'read-meta',
        acceptance: [{ criterion_id: 'files', metric: 'count', operator: 'eq', expected: 3 }] },
    })
    assert.equal(res.status, 202, JSON.stringify(res.body))
    const saved = await store.getMission((res.body as { mission_id: string }).mission_id)
    assert.equal(saved?.tenant, 'team-c')
    assert.equal(saved?.owner, 'sub-carol')
  })

  test('配置 OIDC 后本机 Host 限制关闭：反向代理转发的公网 Host 可用', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port, path: '/v1/context', headers: { host: 'cmap.example.com', authorization: `Bearer ${jwt(claims())}` } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0) }).on('error', reject).end()
    })
    assert.equal(status, 200)
  })

  test('/v1/health 不要求 token', async () => {
    assert.equal((await call('/v1/health')).status, 200)
  })

  test('JWKS 被缓存：多次请求不重复拉取', async () => {
    const before = jwksHits
    for (let i = 0; i < 3; i++) await call('/v1/context', { token: jwt(claims()) })
    assert.equal(jwksHits, before)
  })
})

describe('OIDC 认证：403', () => {
  test('没有任何 CMAP 角色返回 403', async () => {
    for (const roles of [[], ['offline_access', 'uma_authorization'], undefined]) {
      assert.equal((await call('/v1/missions', { token: jwt(claims({ roles })) })).status, 403, JSON.stringify(roles))
    }
  })

  test('缺 tenant claim 返回 403', async () => {
    assert.equal((await call('/v1/context', { token: jwt(claims({ tenant: undefined })) })).status, 403)
  })
})
