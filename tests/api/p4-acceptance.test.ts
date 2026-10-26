/**
 * 威胁模型「P4 安全验收清单」自动化（docs/threat-model.md）：12 项拒绝用例 + 2 项零命中检查，外加 T12 越权套件。
 *
 * 每项在它真实的执行点上触发一次拒绝（OIDC 模式的真实 HTTP API、runner 准入、派发许可、证据复算、网关租约），
 * 并在用例名后注明更深入的既有测试。当前没有强制执行点的项用 test.todo 如实标记，不伪造通过。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import {
  MemoryStore, RunnerAdmissionError, assertRunnerAdmission, issueDispatchPermit, verifyDispatchPermit, DispatchPermitError,
} from '#domain-model'
import type { Approval, Artifact, EventActor, Mission, Store, TaskEnvelopeV1, TaskRecord, GatewayLease, GatewayReportBody } from '#domain-model'
import { AdapterError } from '#adapter-sdk'
import { createControlPlane, routes } from '../../apps/control-plane-api/src/server.ts'
import { normalizeAgentOutput, readVerifiedArtifact, renderTaskPrompt } from '../../packages/adapter-sdk/src/structured-output.ts'
import { applyGatewayReport } from '../../packages/domain-model/src/runner-gateway.ts'
import { RunnerAuthError, signRunnerRequest, verifyRunnerRequest } from '../../packages/domain-model/src/dispatch-permit.ts'
import { assertCurrentTaskApproval } from '../../workflows/runner-admission.ts'
import { createActivities } from '../../workflows/activities.ts'
import { FileFakeAdapter, syntheticActivityDeps, syntheticRunner } from '../workflow/fake-adapter.ts'
import { scanZeroHit } from '../../scripts/p4-zero-hit.ts'
import { buildCodexArgs, codexBinRoot, homeReadDenials, homeToolchainRoots } from '../../adapters/codex-adapter/src/index.ts'
import { GIT_HOOKS_DIR, pushGuardEnv } from '../../packages/adapter-sdk/src/push-guard.ts'
import { buildKimiSandbox } from '../../adapters/kimi-adapter/src/runtime.ts'

const execFileP = promisify(execFile)

const ISSUER = 'http://idp.test/realms/cmap'
const AUDIENCE = 'cmap-api'
const ACTOR: EventActor = { type: 'system', id: 'p4-test' }
const T0 = '2026-10-23T00:00:00.000Z'
const ALL_ROLES = ['viewer', 'operator', 'approver-controlled', 'approver-mutating', 'admin']
// 合成凭据形状（不是真凭据），拆开写避免源码本身命中扫描
const SYNTHETIC_SECRET = ['AKIA', '1234567890ABCDEF'].join('')

const idp = generateKeyPairSync('rsa', { modulusLength: 2048 })
const b64url = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')
const nowS = () => Math.floor(Date.now() / 1000)
const jwt = (over: Record<string, unknown> = {}, key: KeyObject = idp.privateKey) => {
  const claims = { iss: ISSUER, aud: AUDIENCE, sub: 'sub-alice', exp: nowS() + 300, iat: nowS(), tenant: 'team-a', roles: ALL_ROLES, ...over }
  const input = `${b64url({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64url(claims)}`
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`
}

const mission = (id: string, tenant: string, over: Partial<Mission> = {}): Mission => ({
  id, tenant, owner: 'sub-alice', type: 'inspect', goal: 'g', constraints: {},
  acceptance: [{ criterion_id: 'C', metric: 'm', operator: 'eq', expected: 1, hard_gate: true }],
  workflow_template: 'dag/v1', state: 'RUNNING', revision: 1, created_at: T0, updated_at: T0, ...over,
})
const task = (id: string, missionId: string, risk: TaskRecord['risk'] = 'read-meta'): TaskRecord => ({
  id, mission_id: missionId, parent_task_id: null, supersedes_task_id: null, capability: 'code.analyze', risk,
  state: 'DRAFT', attempt: 1, max_attempts: 1, lamport: 0, result: null, binding: null, deps: [], created_at: T0, updated_at: T0,
  envelope: {
    schema: 'cmap/task-envelope/v1',
    identity: { mission_id: missionId, task_id: id, idempotency_key: `${missionId}:${id}`, revision: 1 },
    classification: { task_type: 'inspect', requested_capability: 'code.analyze', risk_level: risk },
    goal: { statement: 't', success_definition: [{ criterion_id: 'C', metric: 'm', operator: 'eq', expected: 1 }] },
    environment: {}, execution_policy: { timeout_seconds: 60, max_attempts: 1 }, permissions: { forbidden: [] },
    evidence_requirements: { required_artifact_roles: ['report'] }, output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
  } as TaskRecord['envelope'],
})
const approval = (id: string, missionId: string, taskId: string, scope: Approval['scope']): Approval => ({
  id, mission_id: missionId, task_id: taskId, action: 'code.analyze', scope, requested_by: 'system:runner', risk_level: scope,
  reason: 'p4', evidence_artifact_ids: [], decision: 'pending', decided_by: null, decided_at: null,
  expires_at: new Date(Date.now() + 3600_000).toISOString(), created_at: new Date(Date.now() - 1000).toISOString(),
})
const event = (missionId: string, type: string, key: string, payload: Record<string, unknown> = {}) => ({ event: {
  event_type: type as never, event_version: 1, occurred_at: T0, mission_id: missionId, task_id: null, attempt: null, actor: ACTOR,
  causation_id: null, correlation_id: missionId, trace_id: null, idempotency_key: key, payload,
} })

let store: Store
let jwks: Server
let server: Awaited<ReturnType<typeof createControlPlane>>
let base: string
let workRoot: string
const adviceCalls: string[] = []

const call = async (path: string, init: { token?: string | null; body?: unknown } = {}) => {
  const headers: Record<string, string> = {}
  const token = init.token === undefined ? jwt() : init.token
  if (token) headers['authorization'] = `Bearer ${token}`
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${base}${path}`, {
    method: init.body === undefined ? 'GET' : 'POST', headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const text = await res.text()
  return { status: res.status, text, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text }
}

/** 读 SSE：收到首个事件后再等一小段静默，断开。 */
const sse = async (path: string): Promise<{ status: number; text: string }> => {
  const ac = new AbortController()
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${jwt()}` }, signal: ac.signal })
  if (res.status !== 200) { ac.abort(); return { status: res.status, text: await res.text().catch(() => '') } }
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + 2000
  let quietUntil = Infinity
  try {
    while (Date.now() < Math.min(deadline, quietUntil)) {
      const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 100))])
      if (chunk === null) continue
      if (chunk.done) break
      text += decoder.decode(chunk.value)
      if (text.includes('mission-event') && quietUntil === Infinity) quietUntil = Date.now() + 300
    }
  } finally { ac.abort() }
  return { status: res.status, text }
}

before(async () => {
  store = new MemoryStore()
  workRoot = await mkdtemp(join(tmpdir(), 'cmap-p4-'))
  // 本租户 team-a
  await store.createMission({ mission: mission('mis-a', 'team-a'), actor: ACTOR })
  await store.createTask({ task: task('t-a', 'mis-a'), actor: ACTOR })
  // 他租户 team-b：owner 与本租户 token 的 sub 相同，证明 owner 相等不能绕过租户
  await store.createMission({ mission: mission('mis-b', 'team-b', { state: 'COMPLETED' }), actor: ACTOR })
  await store.createTask({ task: task('t-b', 'mis-b', 'controlled'), actor: ACTOR })
  await store.createApproval(approval('apr-b', 'mis-b', 't-b', 'controlled'))
  await store.appendEvent(event('mis-b', 'JEV_DECIDED', 'jev-decided:apr-b', { route: 'human' }))
  await store.appendEvent(event('mis-b', 'QUOTA_HANDOFF', 'quota-handoff:t-b', { from: 'x' }))
  const bytes = Buffer.from('{"b":1}')
  await mkdir(join(workRoot, 't-b', 'evidence'), { recursive: true })
  await writeFile(join(workRoot, 't-b', 'evidence', 'b.json'), bytes)
  const art: Artifact = {
    artifact_id: 'art-b', mission_id: 'mis-b', task_id: 't-b', role: 'report', uri: 'evidence/b.json', media_type: 'application/json',
    size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, state: 'AVAILABLE',
    producer: { agent_id: 'codex', adapter_version: '0', execution_session_id: 's' }, provenance: {},
    retention: { retain_until: '2027-01-01T00:00:00.000Z', immutable: true },
    security: { classification: 'internal', contains_secrets: false, contains_pii: false, allowed_roles: ['engineer'] }, created_at: T0,
  }
  await store.putArtifact(art)
  await store.putReview({ id: 'rev-b', mission_id: 'mis-b', reviewed_task_ids: ['t-b'], round: 1, created_at: T0, decision: {
    schema: 'cmap/review-decision/v1', mission_id: 'mis-b', reviewed_task_ids: ['t-b'], decision: 'accept',
    hard_gate_summary: { total: 1, passed: 1, failed: 0 }, review_confidence: { level: 'high' },
  } as never })
  await store.acquireLock({ lock_id: 'lock-b', resource: 'device-b', task_id: 't-b', mission_id: 'mis-b', holder_runner_id: 'r',
    acquired_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(), released_at: null })
  await store.registerGatewayRunner({ runner_id: 'rnr-b', public_key: 'B'.repeat(43), tenant: 'team-b', owner: 'sub-alice',
    allowed_capabilities: ['code.analyze'], max_risk: 'read-meta', host: 'h', enrolled_at: T0, revoked_at: null, last_seen_at: null })

  const publicJwk = { ...idp.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
  jwks = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [publicJwk] })))
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve))
  server = await createControlPlane({
    store, tenant: 'config-tenant', owner: 'config-owner', workRoot,
    oidc: { issuer: ISSUER, audience: AUDIENCE, jwksUrl: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/certs` },
    startMission: async () => {}, cancelMission: async () => {},
    getApprovalAdvice: async (id) => { adviceCalls.push(id); throw new Error('不应被调用') },
  })
  await server.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await server?.close()
  await new Promise<void>((resolve) => jwks?.close(() => resolve()))
  await rm(workRoot, { recursive: true, force: true })
})

// ------------------------------------------------------------------ T12

describe('T12 越权套件：每个 API 路由对他租户资源一律当作不存在', () => {
  const leaks = (text: string) => ['mis-b', 't-b', 'apr-b', 'art-b', 'rev-b', 'lock-b', 'rnr-b', 'team-b'].filter((id) => text.includes(id))
  const notFound = async (path: string, body?: unknown) => {
    const res = await call(path, body === undefined ? {} : { body })
    assert.equal(res.status, 404, `${path} → ${res.status} ${res.text}`)
  }
  const noLeak = async (path: string) => {
    const res = await call(path)
    assert.equal(res.status, 200, `${path} → ${res.status} ${res.text}`)
    assert.deepEqual(leaks(res.text), [], `${path} 泄漏了他租户数据`)
  }
  /** 键必须与 server.ts 的路由表逐一对应：新增路由不补越权用例，本套件即失败。 */
  const cases: Record<string, () => Promise<void>> = {
    'GET /v1/context': () => noLeak('/v1/context'),
    'GET /v1/events': async () => {
      const { status, text } = await sse('/v1/events')
      assert.equal(status, 200)
      assert.ok(text.includes('mis-a'), '本租户事件应可见')
      assert.deepEqual(leaks(text), [])
    },
    'POST /v1/missions': async () => {
      const res = await call('/v1/missions', { body: { request_id: 'p4-continue', goal: 'g', risk_level: 'read-meta', continues_mission_id: 'mis-b',
        acceptance: [{ criterion_id: 'C', metric: 'm', operator: 'eq', expected: 1 }] } })
      assert.equal(res.status, 400, '续作他租户 Mission 与续作不存在的 Mission 同一应答')
    },
    'POST /v1/missions/:id/start': () => notFound('/v1/missions/mis-b/start', {}),
    'POST /v1/missions/:id/cancel': () => notFound('/v1/missions/mis-b/cancel', { reason: '越权取消' }),
    'GET /v1/missions/:id/events': async () => assert.equal((await sse('/v1/missions/mis-b/events')).status, 404),
    'GET /v1/missions/:id/artifacts/:taskId/:artifactId': async () => {
      await notFound('/v1/missions/mis-b/artifacts/t-b/art-b')
      await notFound('/v1/missions/mis-a/artifacts/t-b/art-b') // 本租户 Mission + 他租户 Task 也不行
    },
    'GET /v1/health': () => noLeak('/v1/health'),
    'GET /v1/missions': () => noLeak('/v1/missions'),
    'GET /v1/missions/:id': () => notFound('/v1/missions/mis-b'),
    'GET /v1/missions/:id/tasks': () => notFound('/v1/missions/mis-b/tasks'),
    'GET /v1/missions/:id/evidence': () => notFound('/v1/missions/mis-b/evidence'),
    'GET /v1/missions/:id/reviews': () => notFound('/v1/missions/mis-b/reviews'),
    'GET /v1/missions/:id/quota-handoffs': () => notFound('/v1/missions/mis-b/quota-handoffs'),
    // 账号级额度快照不分租户（ADR-0009 §5），只含 provider 与账号摘要，不含 Mission/任务/证据
    'GET /v1/quota-snapshots': () => noLeak('/v1/quota-snapshots'),
    'GET /v1/approvals': () => noLeak('/v1/approvals'),
    'POST /v1/approvals/:id/advice': async () => {
      await notFound('/v1/approvals/apr-b/advice', {})
      assert.deepEqual(adviceCalls, [], '他租户审批不得送去取建议')
    },
    'GET /v1/approvals/:id/jev-decision': () => notFound('/v1/approvals/apr-b/jev-decision'),
    'POST /v1/approvals/:id/decision': async () => {
      await notFound('/v1/approvals/apr-b/decision', { decision: 'approved', scope: 'controlled' })
      assert.equal((await store.getApproval('apr-b'))?.decision, 'pending')
    },
    'POST /v1/runner-enrollments': async () => {
      const res = await call('/v1/runner-enrollments', { body: { schema: 'cmap/runner-enrollment/v1', kind: 'issue', tenant: 'team-b',
        owner: 'sub-alice', allowed_capabilities: ['code.analyze'], max_risk: 'read-meta', ttl_seconds: 60 } })
      assert.equal(res.status, 400, '请求体不能指定 tenant')
    },
    'POST /v1/runners/:id/revoke': async () => {
      await notFound('/v1/runners/rnr-b/revoke', {})
      assert.equal((await store.getGatewayRunner('rnr-b'))?.revoked_at, null)
    },
    'GET /v1/locks': () => noLeak('/v1/locks'),
  }

  test('用例覆盖路由表中的每一条路由', () => {
    assert.deepEqual(Object.keys(cases).sort(), routes.map((r) => `${r.method} ${r.pattern}`).sort())
  })
  for (const [name, run] of Object.entries(cases)) test(name, run)
})

// ------------------------------------------------------------------ P4 清单

const runner = (over: Partial<Parameters<typeof assertRunnerAdmission>[0]['admission']> = {}) => syntheticRunner({
  runner_id: 'rnr-a', tenant: 'team-a',
  admission: { allowed_tenants: ['team-a'], allowed_owners: ['sub-alice'], allowed_capabilities: ['code.analyze'], max_risk: 'mutating', ...over },
})
const subject = (over: Partial<Parameters<typeof assertRunnerAdmission>[1]> = {}) => ({
  mission_id: 'm', task_id: 't', tenant: 'team-a', owner: 'sub-alice', capability: 'code.analyze', risk: 'read-meta' as const, ...over,
})
const admissionCode = (fn: () => void): string => {
  try { fn() } catch (e) { if (e instanceof RunnerAdmissionError) return e.code; throw e }
  return 'ALLOWED'
}
const permitCode = (fn: () => void): string => {
  try { fn() } catch (e) { if (e instanceof DispatchPermitError) return e.code; throw e }
  return 'ACCEPTED'
}
const adapterCode = async (p: Promise<unknown>): Promise<string> => {
  try { await p } catch (e) { if (e instanceof AdapterError) return e.code; throw e }
  return 'ACCEPTED'
}
const approvalCode = async (s: Store, t: TaskRecord): Promise<string> => {
  try { await assertCurrentTaskApproval(s, t) } catch (e) { if (e instanceof RunnerAdmissionError) return e.code; throw e }
  return 'APPROVED'
}

const trust = generateKeyPairSync('ed25519')
const permitEnvelope = task('t-a', 'mis-a').envelope
const issue = (nowMs?: number) => issueDispatchPermit({ privateKey: trust.privateKey, issuer: 'cmap-cp', runnerId: 'rnr-a', adapterId: 'codex-adapter', envelope: permitEnvelope, ...(nowMs === undefined ? {} : { nowMs }) })
const verify = (token: string, over: { runnerId?: string; adapterId?: string; envelope?: TaskEnvelopeV1 } = {}) => () => verifyDispatchPermit(token, {
  publicKey: trust.publicKey, issuer: 'cmap-cp', runnerId: 'rnr-a', adapterId: 'codex-adapter', envelope: permitEnvelope, ...over,
})

describe('P4 安全验收清单：12 项拒绝用例', () => {
  test('P4-01 非授权 tenant 提交任务（既有：oidc.test「缺 tenant claim 返回 403」「创建 Mission 的 tenant/owner 取自 claims」、domain/runner-admission.test）', async () => {
    const body = { request_id: 'p4-01', goal: 'g', risk_level: 'read-meta', acceptance: [{ criterion_id: 'C', metric: 'm', operator: 'eq', expected: 1 }] }
    assert.equal((await call('/v1/missions', { token: jwt({ tenant: undefined }), body })).status, 403, 'token 不带 tenant')
    assert.equal((await call('/v1/missions', { token: null, body })).status, 401, '无 token')
    assert.equal((await call('/v1/missions', { body: { ...body, tenant: 'team-b' } })).status, 400, '请求体不能自报 tenant')
    assert.deepEqual((await store.queryMissions({ tenant: 'team-b', terminal_limit: 500 })).map((m) => m.id), ['mis-b'], '他租户名下没有多出 Mission')
    assert.equal(admissionCode(() => assertRunnerAdmission(runner(), subject({ tenant: 'team-b' }))), 'TENANT_DENIED', 'runner 侧默认拒绝白名单外租户')
  })

  test('P4-02 runner 收到白名单外 owner 的任务（既有：workflow/runner-admission.test、adapter/runner-gateway-affinity.test「runner 侧纵深」）', () => {
    assert.equal(admissionCode(() => assertRunnerAdmission(runner(), subject({ owner: 'sub-bob' }))), 'OWNER_DENIED')
    assert.equal(admissionCode(() => assertRunnerAdmission(runner({ allowed_owners: [] }), subject())), 'OWNER_DENIED', '空白名单拒绝所有')
    assert.equal(admissionCode(() => assertRunnerAdmission(runner(), subject())), 'ALLOWED', '对照：白名单内放行')
  })

  test('P4-03 Agent 尝试自批授权：经 API 与直连账本（既有：control-plane.test「decided_by 不等于服务端 owner」、workflow/prepared-dispatch.test「self-issued approvals cannot dispatch」、adapter/kimi-runtime.test）', async () => {
    const s = new MemoryStore()
    await s.createMission({ mission: mission('mis-self', 'team-a'), actor: ACTOR })
    await store.createApproval(approval('apr-api', 'mis-a', 't-a', 'controlled'))
    // 经 API：Agent 没有 OIDC token → 401；冒用 agent 身份填 decided_by → 403；均不落账
    assert.equal((await call('/v1/approvals/apr-api/decision', { token: null, body: { decision: 'approved', scope: 'controlled' } })).status, 401)
    assert.equal((await call('/v1/approvals/apr-api/decision', { body: { decision: 'approved', scope: 'controlled', decided_by: 'agent:codex' } })).status, 403)
    assert.equal((await store.getApproval('apr-api'))?.decision, 'pending')
    // 直连账本：即使 Agent 把 agent:/system: 身份或申请人自己写成批准人，派发前复核一律拒绝
    for (const who of ['agent:codex', 'system:jev', 'system:runner']) {
      const t = task(`t-self-${who.replace(':', '-')}`, 'mis-self', 'controlled')
      await s.createTask({ task: t, actor: ACTOR })
      const id = `apr:${t.id}:controlled`
      await s.createApproval({ ...approval(id, 'mis-self', t.id, 'controlled') })
      await s.decideApproval(id, 'approved', who, new Date().toISOString())
      assert.equal(await approvalCode(s, t), 'APPROVAL_INVALID', who)
    }
  })

  test('P4-04 controlled 的批准不放行同批次 mutating 任务（既有：control-plane.test「批准 controlled 不影响 mutating」、oidc.test 角色互不蕴含）', async () => {
    const s = new MemoryStore()
    await s.createMission({ mission: mission('mis-batch', 'team-a'), actor: ACTOR })
    const ctl = task('t-ctl', 'mis-batch', 'controlled')
    const mut = task('t-mut', 'mis-batch', 'mutating')
    for (const t of [ctl, mut]) await s.createTask({ task: t, actor: ACTOR })
    await s.createApproval(approval('apr:t-ctl:controlled', 'mis-batch', 't-ctl', 'controlled'))
    await s.decideApproval('apr:t-ctl:controlled', 'approved', 'sub-alice', new Date().toISOString())
    assert.equal(await approvalCode(s, ctl), 'APPROVED', '对照：controlled 任务放行')
    assert.equal(await approvalCode(s, mut), 'APPROVAL_INVALID', '同批 mutating 无自身审批')
    // 记录 id 冒充 mutating、scope 仍是 controlled 的批准也不算
    await s.createApproval(approval('apr:t-mut:mutating', 'mis-batch', 't-mut', 'controlled'))
    await s.decideApproval('apr:t-mut:mutating', 'approved', 'sub-alice', new Date().toISOString())
    assert.equal(await approvalCode(s, mut), 'APPROVAL_INVALID')
  })

  test('P4-05a context.paths 声明绝对路径或 .. 逃逸在契约层被拒（既有：contract/schemas.test「paths 含 .. 逃逸时拒绝」）', () => {
    const load = (n: string) => JSON.parse(readFileSync(new URL(`../../schemas/${n}`, import.meta.url), 'utf8'))
    const ajv = new Ajv2020({ strict: true })
    addFormats.default(ajv)
    const validate = ajv.compile(load('task-envelope.v1.schema.json'))
    const env = (paths: string[]) => ({ ...task('t', 'm').envelope, inputs: { context: { repo: 'r', ref: 'a'.repeat(40), paths } } })
    assert.ok(validate(env(['docs/a.md'])), JSON.stringify(validate.errors))
    for (const p of ['/Users/x/.ssh/id_rsa', '../../.ssh/id_rsa', 'docs/../../x']) assert.equal(validate(env([p])), false, p)
  })
  test('P4-05b 任务运行时读取 HOME 下工作区外的路径被沙箱拒绝，工作区仍可读（Codex 权限档 + Kimi seatbelt；既有：adapter/codex-args.test「读取范围」、adapter/kimi-runtime.test）', async (t) => {
    const base = await realpath(tmpdir())
    const home = await mkdtemp(join(base, 'p4-05b-home-'))
    const runtime = await mkdtemp(join(base, 'p4-05b-rt-'))
    t.after(() => Promise.all([home, runtime].map((d) => rm(d, { recursive: true, force: true }))))
    const work = join(home, 'work')
    await mkdir(join(home, '.ssh'), { recursive: true })
    await mkdir(work)
    await writeFile(join(home, '.ssh', 'id_probe'), 'not-a-key')
    await writeFile(join(work, 'in.txt'), 'ok')
    await mkdir(join(work, 'sub'))
    // sh 的 cd 与 node 的 realpathSync 需要祖先目录元数据：工作区在 HOME 下时不能整个拒绝 ~（生产 CMAP_WORK_ROOT 即如此）
    const probe = `ls '${home}/.ssh' >/dev/null 2>&1 && echo OUTSIDE_READABLE || echo OUTSIDE_DENIED; ` +
      `cat in.txt >/dev/null 2>&1 && echo WORKSPACE_READABLE || echo WORKSPACE_DENIED; ` +
      `(cd sub && '${process.execPath}' -e 'require("fs").realpathSync(".")') >/dev/null 2>&1 && echo WORKSPACE_CD_OK || echo WORKSPACE_CD_FAIL`
    const expected = ['OUTSIDE_DENIED', 'WORKSPACE_READABLE', 'WORKSPACE_CD_OK']
    const lines = (out: string) => out.split('\n').filter((l) => /^(OUTSIDE|WORKSPACE)_/.test(l))

    // 参数级（任何平台）：两档都不传 -s（会退回可读全盘的旧设置），都拒绝 HOME 下工作区以外的条目
    const homeDenials = await homeReadDenials(home, [work])
    assert.deepEqual(homeDenials, [join(home, '.ssh')])
    const envFor = (roles: string[]) => ({ ...task('t-05b', 'mis-05b').envelope, evidence_requirements: { required_artifact_roles: roles } }) as TaskEnvelopeV1
    const argSets = [['report'], []].map((roles) => buildCodexArgs(envFor(roles), { workDir: work, resultFile: '/r', outputSchemaPath: '/s', prompt: 'p', homeDenials }))
    for (const args of argSets) {
      assert.equal(args.includes('-s'), false)
      assert.ok(args.some((a) => a.startsWith(`permissions.cmap.filesystem={${JSON.stringify(join(home, '.ssh'))}="deny"`)), JSON.stringify(args))
    }
    // Kimi：真实 sandbox-exec 跑 buildKimiSandbox 生成的 profile（不调用 Kimi）；seatbelt 仅 macOS，Kimi 在其他平台拒绝运行
    if (process.platform === 'darwin') {
      const cred = join(runtime, 'cred')
      const oauth = join(runtime, 'oauth')
      await mkdir(cred)
      await mkdir(oauth)
      const profile = buildKimiSandbox({ workDir: work, runtimeDir: runtime, credentialDir: cred, oauthDir: oauth, userHome: home, bin: '/bin/sh' }, [])
      const kimi = await execFileP('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', probe], { cwd: work })
      assert.deepEqual(lines(kimi.stdout), expected, 'Kimi')
    } else t.diagnostic('非 macOS：跳过 Kimi seatbelt')

    // Codex：真实 `codex sandbox` 套用 buildCodexArgs 给出的同一权限档（不调用模型）；本机无 codex 则跳过
    try { await execFileP('codex', ['--version']) } catch { return t.diagnostic('无 codex CLI：Codex 只做参数级断言') }
    for (const args of argSets) {
      const perms = args.filter((a, i) => args[i - 1] === '-c' && a.startsWith('permissions.cmap.')).flatMap((a) => ['-c', a])
      const out = await execFileP('codex', ['sandbox', ...perms, '-P', 'cmap', '-C', work, '--', '/bin/sh', '-c', probe],
        { cwd: work, env: { ...process.env, HOME: home, TMPDIR: base } })
      assert.deepEqual(lines(out.stdout), expected, `Codex ${perms.join(' ')}`)
    }
  })

  test('P4-06 Agent 推送 main 或 release/* 被 CMAP pre-push hook 拒绝，允许的分支照常（本地 bare 远端；既有：adapter/push-guard.test）', async (t) => {
    const base = await realpath(tmpdir())
    const ws = await mkdtemp(join(base, 'p4-06-'))
    const probeFile = join(GIT_HOOKS_DIR, '.p4-06-probe')
    t.after(() => Promise.all([rm(ws, { recursive: true, force: true }), rm(probeFile, { force: true })]))
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }
    const git = (cwd: string, ...args: string[]) => execFileP('git', args, { cwd, env: gitEnv })
    // 远端放在工作区内：沙箱允许写它，被拒只能是 hook 所致（工作区外的远端两种沙箱本就写不了）
    const setup = async () => {
      await rm(join(ws, 'repo'), { recursive: true, force: true })
      await rm(join(ws, 'remote.git'), { recursive: true, force: true })
      await git(ws, 'init', '-q', '--bare', 'remote.git')
      await git(ws, 'init', '-q', '-b', 'main', 'repo')
      await git(join(ws, 'repo'), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
      await git(join(ws, 'repo'), 'remote', 'add', 'origin', join(ws, 'remote.git'))
    }
    const probe = `cd repo; for r in main release/1.0 feat/x; do git push -q origin HEAD:$r 2>&1 | grep -q 'cmap: 拒绝推送' && echo "REJECTED $r" || echo "PUSHED $r"; done; ` +
      `(: > '${probeFile}') 2>/dev/null && echo HOOK_DIR_WRITABLE || echo HOOK_DIR_READONLY`
    const lines = (out: string) => out.split('\n').filter((l) => /^(REJECTED|PUSHED|HOOK_DIR)/.test(l))
    const envFor = (repository: Record<string, unknown>) => ({ ...task('t-06', 'mis-06').envelope, permissions: { forbidden: [], repository } }) as TaskEnvelopeV1
    const guard = pushGuardEnv(envFor({ allow_push_branches: ['feat/*'] }))

    // 无沙箱：信封未允许推送（缺省）时三者全拒；允许 feat/* 时只放行 feat/x
    await setup()
    assert.deepEqual(lines((await execFileP('/bin/sh', ['-c', probe], { cwd: ws, env: { ...gitEnv, ...pushGuardEnv(envFor({})) } })).stdout).slice(0, 3),
      ['REJECTED main', 'REJECTED release/1.0', 'REJECTED feat/x'])
    await rm(probeFile, { force: true })
    const sandboxed = ['REJECTED main', 'REJECTED release/1.0', 'PUSHED feat/x', 'HOOK_DIR_READONLY']
    // Kimi：真实 sandbox-exec 跑 buildKimiSandbox 生成的 profile（hook 目录只读放行）；仅 macOS
    if (process.platform === 'darwin') {
      await setup()
      const rt = join(ws, 'rt')
      await mkdir(rt)
      const profile = buildKimiSandbox({ workDir: ws, runtimeDir: rt, credentialDir: rt, oauthDir: rt, userHome: await realpath(homedir()), bin: '/bin/sh' }, [], [GIT_HOOKS_DIR])
      const kimi = await execFileP('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', probe], { cwd: ws, env: { ...gitEnv, ...guard, PATH: '/usr/bin:/bin' } })
      assert.deepEqual(lines(kimi.stdout), sandboxed, 'Kimi')
    } else t.diagnostic('非 macOS：跳过 Kimi seatbelt')

    // Codex：真实 `codex sandbox` 套用 Adapter 的权限档与 shell 环境（hook 规则只经参数注入，不靠进程环境）；本机无 codex 则跳过
    try { await execFileP('codex', ['--version']) } catch { return t.diagnostic('无 codex CLI：跳过 Codex 沙箱') }
    await setup()
    const home = await realpath(homedir())
    const args = buildCodexArgs(envFor({ allow_push_branches: ['feat/*'] }), { workDir: ws, resultFile: '/r', outputSchemaPath: '/s', prompt: 'p',
      homeDenials: await homeReadDenials(home, [ws, base, GIT_HOOKS_DIR, ...(await homeToolchainRoots(home, process.env['PATH'])),
        ...[await codexBinRoot(home, 'codex', process.env['PATH'])].filter((r): r is string => r !== null)]) })
    const perms = args.filter((a, i) => args[i - 1] === '-c' && /^(permissions\.cmap\.|shell_environment_policy\.)/.test(a)).flatMap((a) => ['-c', a])
    const codex = await execFileP('codex', ['sandbox', ...perms, '-P', 'cmap', '-C', ws, '--', '/bin/sh', '-c', probe],
      { cwd: ws, env: { ...process.env, TMPDIR: base } })
    assert.deepEqual(lines(codex.stdout), sandboxed, 'Codex')
  })

  test('P4-07 结果中的 task_id 与派发信封不符（既有：contract/codex-output.test「不含身份字段」、workflow/dispatch.test「身份字段由控制面填充」、remote-runner.test）', async () => {
    const env = { identity: { mission_id: 'mis-a', task_id: 't-a', idempotency_key: 'k', revision: 1 },
      classification: { task_type: 'inspect', requested_capability: 'code.analyze', risk_level: 'read-meta' },
      evidence_requirements: { required_artifact_roles: [] } } as unknown as TaskEnvelopeV1
    const raw = { status: 'completed', summary: 's', criterion_results: [], artifacts: [], findings: [], error: null }
    assert.equal((await normalizeAgentOutput(raw, env, workRoot)).task_id, 't-a', '对照：身份取自信封')
    for (const spoof of [{ task_id: 't-b' }, { mission_id: 'mis-b' }]) {
      assert.equal(await adapterCode(normalizeAgentOutput({ ...raw, ...spoof }, env, workRoot)), 'RESULT_INVALID', JSON.stringify(spoof))
    }
    // 出站网关：回报的 remote_task_id 不是该租约的任务 → 拒收；别的 runner 回报 → 当作不存在
    const lease = { lease_id: 'l', runner_id: 'r1', task_id: 't-a', remote_task_id: 'codex:t-a:1', state: 'leased', expires_at: new Date(Date.now() + 60_000).toISOString(),
      accepted: { schema: 'cmap/remote-runner/v1', kind: 'dispatch_accepted', runner_id: 'r1', remote_task_id: 'codex:t-a:1' }, status: null, outcome: null, cancel: null } as unknown as GatewayLease
    const result = (remote: string) => ({ schema: 'cmap/remote-runner/v1', kind: 'result', remote_task_id: remote, result: {}, artifacts: [] }) as unknown as GatewayReportBody
    const exp = new Date(Date.now() + 90_000).toISOString()
    assert.deepEqual(applyGatewayReport(lease, 'r1', result('codex:t-b:1'), Date.now(), exp), { error: 'INVALID_REQUEST' })
    assert.deepEqual(applyGatewayReport(lease, 'r2', result('codex:t-a:1'), Date.now(), exp), { error: 'LEASE_UNKNOWN' })
  })

  test('P4-08 Agent 自报哈希与文件实际内容不符（既有：adapter/structured-output.test、workflow/remote-runner.test「EVIDENCE_HASH_MISMATCH」、adapter/runner-gateway.test）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cmap-p4-ev-'))
    try {
      await writeFile(join(dir, 'r.json'), '{"ok":true}')
      const real = createHash('sha256').update('{"ok":true}').digest('hex')
      assert.equal((await readVerifiedArtifact(dir, { uri: 'r.json', role: 'report', sha256: real })).sha256, real, '对照：真实哈希通过')
      assert.equal(await adapterCode(readVerifiedArtifact(dir, { uri: 'r.json', role: 'report', sha256: 'f'.repeat(64) })), 'EVIDENCE_HASH_MISMATCH')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test('P4-09 声明的证据文件不存在不得判定成功（既有：adapter/structured-output.test、adapter/codex-evidence-boundary.test）', async () => {
    const env = { identity: { mission_id: 'm', task_id: 't', idempotency_key: 'k', revision: 1 },
      classification: { task_type: 'inspect', requested_capability: 'code.analyze', risk_level: 'read-meta' },
      evidence_requirements: { required_artifact_roles: ['report'] } } as unknown as TaskEnvelopeV1
    const declared = { status: 'completed', summary: 's', findings: [], error: null,
      criterion_results: [{ criterion_id: 'C', actual: '1', passed: true, evidence_artifact_ids: ['r'] }],
      artifacts: [{ artifact_id: 'r', role: 'report', uri: 'missing.json', media_type: 'application/json', size_bytes: 1, sha256: 'a'.repeat(64) }] }
    assert.equal(await adapterCode(normalizeAgentOutput(declared, env, workRoot)), 'EVIDENCE_FILE_MISSING')
    // 根本不声明必需证据：结果被改判 failed，不凭 completed 自述
    const out = await normalizeAgentOutput({ ...declared, criterion_results: [], artifacts: [] }, env, workRoot)
    assert.equal(out.status, 'failed')
    assert.equal(out.error?.code, 'EVIDENCE_MISSING')
  })

  test('P4-10 令牌用于非签发受众（既有：domain/dispatch-permit.test、adapter/remote-runner.test「CLAIM_MISMATCH」、oidc.test 错误 aud、adapter/remote-runner-auth.test 受众不符）', async () => {
    const token = issue()
    assert.equal(permitCode(verify(token)), 'ACCEPTED', '对照：签发受众通过')
    assert.equal(permitCode(verify(token, { runnerId: 'rnr-b' })), 'CLAIM_MISMATCH', '另一台 runner')
    assert.equal(permitCode(verify(token, { adapterId: 'kimi-adapter' })), 'CLAIM_MISMATCH', '另一个 Adapter')
    assert.equal(permitCode(verify(token, { envelope: task('t-other', 'mis-a').envelope })), 'CLAIM_MISMATCH', '另一个任务')
    assert.equal((await call('/v1/context', { token: jwt({ aud: 'account' }) })).status, 401, 'OIDC：别的受众')
    const runnerKey = generateKeyPairSync('ed25519')
    const headers = signRunnerRequest({ privateKey: runnerKey.privateKey, method: 'POST', target: '/v1/dispatch', body: '{}', audience: 'rnr-a' })
    assert.throws(() => verifyRunnerRequest({ publicKey: runnerKey.publicKey, method: 'POST', target: '/v1/dispatch', audience: 'rnr-b', headers }), RunnerAuthError, 'runner 请求签名：受众不符')
  })

  test('P4-11 过期令牌不被接受（既有：domain/dispatch-permit.test、oidc.test「过期」、api/runner-enrollment.test「过期」、api/runner-gateway.test「过期时间戳」）', async () => {
    const stale = issue(Date.now() - 120_000)
    assert.equal(permitCode(verify(stale)), 'EXPIRED', '派发许可（60 秒）')
    assert.equal((await call('/v1/context', { token: jwt({ exp: nowS() - 120 }) })).status, 401, 'OIDC access token')
    const s = new MemoryStore()
    const raw = 'cmapenr1.' + 'x'.repeat(43)
    await s.createEnrollmentToken({ token_id: 'enr-old', token_sha256: createHash('sha256').update(raw).digest('hex'), tenant: 'team-a', owner: 'sub-alice',
      allowed_capabilities: ['code.analyze'], max_risk: 'read-meta', issued_by: 'sub-admin', expires_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date(Date.now() - 3600_000).toISOString(), used_at: null, runner_id: null })
    assert.equal(await s.enrollGatewayRunner({ token_sha256: createHash('sha256').update(raw).digest('hex'), runner_id: 'rnr-x', public_key: 'C'.repeat(43), host: 'h', now: new Date().toISOString() }), null, '注册令牌')
    const runnerKey = generateKeyPairSync('ed25519')
    const headers = signRunnerRequest({ privateKey: runnerKey.privateKey, method: 'POST', target: '/v1/gateway/claim', body: '{}', audience: 'rnr-a', nowMs: Date.now() - 5000, scheme: 'gateway' })
    assert.throws(() => verifyRunnerRequest({ publicKey: runnerKey.publicKey, method: 'POST', target: '/v1/gateway/claim', audience: 'rnr-a', headers, scheme: 'gateway' }), RunnerAuthError, '网关请求签名超窗')
  })

  test('P4-12 重复回调不产生重复 Artifact 或重复 Task（既有：workflow/dispatch.test「重复收取不重复写证据」「重复派发不重复调用 Adapter」、store-contract 幂等用例）', async () => {
    const { s, adapter, acts, taskId } = await flow()
    await acts.dispatchTask(taskId)
    await acts.collectTaskResult(taskId)
    assert.equal(adapter.startCalls.length, 1)
    assert.equal((await s.listArtifacts(taskId)).length, 1)
    assert.equal((await s.queryTasks({ missionId: 'mis-flow' })).length, 1)
    // 出站网关：同一终态结果第二次回报 → 租约已关闭，拒收，不改已落账的结果
    const gw = new MemoryStore()
    const RT = 'cmap/remote-runner/v1' as const
    await gw.enqueueGatewayLease({ lease_id: 'l1', runner_id: 'r1', task_id: 't', remote_task_id: 'codex:t:1', created_at: T0,
      dispatch: { schema: RT, kind: 'dispatch', runner_id: 'r1', permit: 'cmap1.e30.c2ln', envelope: { schema: 'cmap/task-envelope/v1' }, trace_id: 't', correlation_id: 'c', deadline_at: '2099-01-01T00:00:00.000Z', inputs: [] } as never })
    const at = (ms: number) => new Date(ms).toISOString()
    await gw.claimGatewayLease('r1', at(Date.now()), at(Date.now() + 60_000))
    const report = (body: GatewayReportBody) => gw.recordGatewayReport({ runnerId: 'r1', leaseId: 'l1', body, now: at(Date.now()), expiresAt: at(Date.now() + 60_000) })
    await report({ schema: RT, kind: 'dispatch_accepted', runner_id: 'r1', remote_task_id: 'codex:t:1' })
    const result = { schema: RT, kind: 'result', remote_task_id: 'codex:t:1', result: { schema: 'cmap/task-result/v1' }, artifacts: [] } as unknown as GatewayReportBody
    assert.ok('lease' in await report(result))
    const closed = await gw.getGatewayLease('l1')
    assert.deepEqual(await report(result), { error: 'LEASE_UNKNOWN' })
    assert.deepEqual(await gw.getGatewayLease('l1'), closed)
  })
})

/** 真实控制面接线（假 Adapter 写真实证据字节）：派发 → 收结果 → 重复收取。 */
const flow = async () => {
  const s = new MemoryStore()
  const root = await mkdtemp(join(tmpdir(), 'cmap-p4-flow-'))
  const adapter = new FileFakeAdapter()
  const acts = createActivities(syntheticActivityDeps({ store: s, adapter, runner: syntheticRunner(), pollIntervalMs: 1, workRoot: root }))
  await s.createMission({ mission: mission('mis-flow', 'team-ycc', { owner: 'crosswarm', state: 'DRAFT', workflow_template: 'inspect/v1', goal: 'P4 零命中：统计 sample 文件数' }), actor: ACTOR })
  const { taskId } = await acts.createTask({ missionId: 'mis-flow', capability: 'code.analyze', goal: 'P4 零命中：统计 sample 文件数' })
  await acts.markReady(taskId)
  await acts.dispatchTask(taskId)
  await acts.collectTaskResult(taskId)
  return { s, root, adapter, acts, taskId }
}

describe('P4 安全验收清单：2 项零命中检查（scripts/p4-zero-hit.ts）', () => {
  test('扫描器本身能命中：凭据、派发许可、提示词正文（防止空跑通过）', () => {
    const prompt = renderTaskPrompt(task('t-a', 'mis-a').envelope)
    const hits = scanZeroHit({
      events: [{ event_id: 'e1', payload: { reason: `key ${SYNTHETIC_SECRET}` } } as never],
      artifacts: [{ artifact_id: 'a1', bytes: prompt }, { artifact_id: 'a2', bytes: issue() }],
    })
    assert.deepEqual(hits.map((h) => `${h.source}:${h.id}:${h.label}`).sort(),
      ['artifact:a1:提示词数据区块', 'artifact:a1:提示词说明', 'artifact:a2:派发许可', 'event:e1:AWS Access Key'])
  })

  test('Z1 审计流零命中凭据模式：控制面不把用户填写的凭据写进事件（取消原因）', async () => {
    const res = await call('/v1/missions/mis-a/cancel', { token: jwt({ roles: ['operator'] }), body: { reason: `临时口令 ${SYNTHETIC_SECRET}` } })
    assert.equal(res.status, 400, `含凭据的取消原因应拒收：${res.status} ${res.text}`)
    const { s, root } = await flow()
    try {
      const events = [...await store.listTenantEvents('team-a'), ...await store.listTenantEvents('team-b'), ...await s.listTenantEvents('team-ycc')]
      assert.ok(events.length > 0)
      assert.deepEqual(scanZeroHit({ events }), [])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('Z2 Artifact 零命中提示词正文与 token：派发后落账的证据不含提示词与派发许可', async () => {
    const { s, root, adapter, taskId } = await flow()
    try {
      const artifacts = await Promise.all((await s.listArtifacts(taskId)).map(async (a) => ({ artifact_id: a.artifact_id, bytes: await readFile(join(root, taskId, a.uri)) })))
      assert.ok(artifacts.length > 0)
      assert.deepEqual(scanZeroHit({ artifacts }), [])
      const permit = adapter.contexts[0]!.token
      const prompt = renderTaskPrompt(adapter.startCalls[0]!)
      for (const a of artifacts) {
        assert.ok(!a.bytes.toString('utf8').includes(permit), '证据不含派发许可原文')
        assert.ok(!a.bytes.toString('utf8').includes(prompt.slice(0, 200)), '证据不含提示词原文')
      }
      assert.ok(!JSON.stringify(await s.listTenantEvents('team-ycc')).includes(permit), '审计流也不含派发许可')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
