/**
 * 控制面 API 契约测试。
 *
 * 用真实 HTTP 请求打真实 server，不 mock request/response——
 * 那样测的是 mock 自己，路由拼错、状态码写错都发现不了。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'

import { MemoryStore } from '#domain-model'
import type { Mission, TaskRecord, Approval, Artifact, EventActor, Store } from '#domain-model'
import { createControlPlane } from '../../apps/control-plane-api/src/server.ts'

const ACTOR: EventActor = { type: 'system', id: 'test' }
const T0 = '2026-08-05T00:00:00.000Z'
const TENANT = 'team-ycc'

let store: Store
let server: Awaited<ReturnType<typeof createControlPlane>>
let base: string

const mission = (id: string, tenant = TENANT): Mission => ({
  id, tenant, owner: 'crosswarm', type: 'perf',
  goal: '首屏 P95 降到 1800ms', constraints: {},
  acceptance: [{ criterion_id: 'PERF-P95', metric: 'p95_ms', operator: 'lte', expected: 1800, hard_gate: true }],
  workflow_template: 'perf/v1', state: 'RUNNING', revision: 1,
  created_at: T0, updated_at: T0,
})

const task = (id: string, missionId: string): TaskRecord => ({
  id, mission_id: missionId, parent_task_id: null, supersedes_task_id: null,
  capability: 'code.analyze', risk: 'read-meta', state: 'RUNNING',
  attempt: 1, max_attempts: 1, lamport: 0,
  envelope: {} as TaskRecord['envelope'],
  result: null, binding: null, deps: [],
  created_at: T0, updated_at: T0,
})

const approval = (id: string, scope: 'controlled' | 'mutating'): Approval => ({
  id, mission_id: 'mis-1', task_id: 'tsk-1',
  action: scope === 'mutating' ? 'code.commit' : 'yonwork.chat_send',
  scope, requested_by: 'agent:codex', risk_level: scope,
  reason: '需要人工确认', evidence_artifact_ids: ['art-1'],
  decision: 'pending', decided_by: null, decided_at: null,
  expires_at: '2026-08-06T00:00:00.000Z', created_at: T0,
})

const artifact = (id: string, taskId: string, role: string): Artifact => ({
  artifact_id: id, mission_id: 'mis-1', task_id: taskId, role,
  uri: `artifact://mis-1/${taskId}/${role}.json`,
  media_type: 'application/json', size_bytes: 128, sha256: 'c'.repeat(64),
  version: 1, state: 'AVAILABLE',
  producer: { agent_id: 'codex', adapter_version: '0.1.0', execution_session_id: 's1' },
  provenance: {}, retention: { retain_until: '2027-01-01T00:00:00.000Z', immutable: true },
  security: { classification: 'internal', contains_secrets: false, contains_pii: false, allowed_roles: [] },
  created_at: T0,
})

const get = async (path: string) => {
  const res = await fetch(`${base}${path}`)
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()
  return { status: res.status, body }
}

const post = async (path: string, payload: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()
  return { status: res.status, body }
}

before(async () => {
  store = new MemoryStore()

  await store.createMission({ mission: mission('mis-1'), actor: ACTOR })
  await store.createMission({ mission: mission('mis-other', 'team-other'), actor: ACTOR })
  await store.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
  await store.createTask({ task: task('tsk-2', 'mis-1'), actor: ACTOR })
  await store.putArtifact(artifact('art-1', 'tsk-1', 'report'))
  await store.createApproval(approval('apr-ctl', 'controlled'))
  await store.createApproval(approval('apr-mut', 'mutating'))

  server = await createControlPlane({ store, tenant: TENANT })
  await server.listen(0)
  const addr = server.address() as AddressInfo
  base = `http://127.0.0.1:${addr.port}`
})

after(async () => { await server?.close() })

describe('健康检查', () => {
  test('GET /v1/health 报告存储可用性', async () => {
    const { status, body } = await get('/v1/health')
    assert.equal(status, 200)
    assert.equal((body as { ok: boolean }).ok, true)
  })
})

describe('Mission', () => {
  test('列表只返回本租户的 Mission', async () => {
    const { status, body } = await get('/v1/missions')
    assert.equal(status, 200)
    const items = (body as { items: Mission[] }).items
    assert.deepEqual(items.map((m) => m.id), ['mis-1'], '跨租户数据泄漏是 T12 明确要拒绝的')
  })

  test('详情含目标与机读验收标准', async () => {
    const { status, body } = await get('/v1/missions/mis-1')
    assert.equal(status, 200)
    const m = body as Mission
    assert.equal(m.goal, '首屏 P95 降到 1800ms')
    assert.equal(m.acceptance[0]?.criterion_id, 'PERF-P95')
  })

  test('不存在返回 404 而非空对象', async () => {
    const { status } = await get('/v1/missions/no-such')
    assert.equal(status, 404, '返回 200 加空对象会让前端把「不存在」显示成「无数据」')
  })

  test('他租户的 Mission 一律 404，不泄漏存在性', async () => {
    const { status } = await get('/v1/missions/mis-other')
    assert.equal(
      status, 404,
      '返回 403 会泄漏「该 id 确实存在」，404 才不给出任何信息',
    )
  })

  test('任务列表按 mission 归属', async () => {
    const { status, body } = await get('/v1/missions/mis-1/tasks')
    assert.equal(status, 200)
    const items = (body as { items: TaskRecord[] }).items
    assert.deepEqual(items.map((t) => t.id).sort(), ['tsk-1', 'tsk-2'])
  })
})

describe('审批闸口', () => {
  test('待审批列表区分 scope', async () => {
    const { status, body } = await get('/v1/approvals')
    assert.equal(status, 200)
    const items = (body as { items: Approval[] }).items
    assert.equal(items.length, 2)
    assert.deepEqual(items.map((a) => a.scope).sort(), ['controlled', 'mutating'])
  })

  test('批准需显式声明 scope，缺失则 400', async () => {
    const { status } = await post('/v1/approvals/apr-ctl/decision', {
      decision: 'approved', decided_by: 'user:crosswarm',
    })
    assert.equal(status, 400, 'scope 缺失时默许通过等于把两类授权合并了')
  })

  test('scope 与审批记录不符时拒绝', async () => {
    const { status } = await post('/v1/approvals/apr-ctl/decision', {
      decision: 'approved', scope: 'mutating', decided_by: 'user:crosswarm',
    })
    assert.equal(
      status, 409,
      '用 mutating 的意图去批一个 controlled 请求，说明调用方认知错位，必须拒绝',
    )
  })

  test('scope 相符时批准成功', async () => {
    const { status, body } = await post('/v1/approvals/apr-ctl/decision', {
      decision: 'approved', scope: 'controlled', decided_by: 'user:crosswarm',
    })
    assert.equal(status, 200)
    assert.equal((body as Approval).decision, 'approved')
    assert.equal((body as Approval).decided_by, 'user:crosswarm')
  })

  test('批准 controlled 不影响 mutating——两类授权互不蕴含', async () => {
    const { body } = await get('/v1/approvals')
    const items = (body as { items: Approval[] }).items
    assert.deepEqual(
      items.map((a) => a.id), ['apr-mut'],
      'controlled 的批准放行了 mutating 是威胁模型明确禁止的',
    )
  })

  test('decided_by 缺失则 400——审计流不能出现「不知谁批的」', async () => {
    const { status } = await post('/v1/approvals/apr-mut/decision', {
      decision: 'approved', scope: 'mutating',
    })
    assert.equal(status, 400)
  })

  test('对不存在的审批决策返回 404', async () => {
    const { status } = await post('/v1/approvals/ghost/decision', {
      decision: 'approved', scope: 'controlled', decided_by: 'user:x',
    })
    assert.equal(status, 404)
  })
})

describe('证据', () => {
  test('Evidence Pack 含任务与证据归属', async () => {
    const { status, body } = await get('/v1/missions/mis-1/evidence')
    assert.equal(status, 200)
    const pack = body as { missionId: string; tasks: { taskId: string; artifacts: unknown[] }[] }
    assert.equal(pack.missionId, 'mis-1')
    const t1 = pack.tasks.find((t) => t.taskId === 'tsk-1')
    assert.equal(t1?.artifacts.length, 1)
  })

  test('他租户的证据不可达', async () => {
    const { status } = await get('/v1/missions/mis-other/evidence')
    assert.equal(status, 404)
  })
})

describe('通用行为', () => {
  test('未知路径返回 404 JSON 而非 HTML', async () => {
    const { status, body } = await get('/v1/nope')
    assert.equal(status, 404)
    assert.ok(typeof body === 'object', '前端按 JSON 解析，返回 HTML 会导致解析异常而非清晰报错')
  })

  test('错误响应含可读的 error 字段', async () => {
    const { body } = await get('/v1/missions/no-such')
    assert.ok((body as { error?: string }).error, '错误响应必须能告诉前端发生了什么')
  })
})
