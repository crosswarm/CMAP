import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { MemoryStore } from '#domain-model'
import type { Approval, Artifact, EventActor, Mission, TaskRecord } from '#domain-model'
import { getApprovalAdviceFromJev } from '../../apps/control-plane-api/src/approval-advice.ts'
import { createControlPlane } from '../../apps/control-plane-api/src/server.ts'

const T0 = '2026-09-21T00:00:00.000Z'
const ACTOR: EventActor = { type: 'system', id: 'webui-test' }

const mission = (id = 'mis-1', tenant = 'local'): Mission => ({
  id, tenant, owner: 'tester', type: 'inspect', goal: 'synthetic', constraints: {},
  acceptance: [], workflow_template: 'inspect/v1', state: 'RUNNING', revision: 1,
  created_at: T0, updated_at: T0,
})

const task = (id = 'tsk-1', missionId = 'mis-1'): TaskRecord => ({
  id, mission_id: missionId, parent_task_id: null, supersedes_task_id: null,
  capability: 'code.inspect', risk: 'read-meta', state: 'COMPLETED',
  attempt: 1, max_attempts: 1, lamport: 1, envelope: {} as TaskRecord['envelope'],
  result: null, binding: null, deps: [], created_at: T0, updated_at: T0,
})

const artifact = (
  id: string,
  taskId: string,
  path: string,
  bytes: Buffer,
  missionId = 'mis-1',
  uri = `artifact://${missionId}/${taskId}/${path}`,
): Artifact => ({
  // role 取 id：同一任务的多份夹具不得撞 (task_id, role, version) 唯一约束（PG 一直会拒）
  artifact_id: id, mission_id: missionId, task_id: taskId, role: id,
  uri,
  media_type: 'application/octet-stream', size_bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  version: 1, state: 'AVAILABLE',
  producer: { agent_id: 'codex', adapter_version: '0.1.0', execution_session_id: 's1' },
  provenance: {}, retention: { retain_until: '2027-01-01T00:00:00.000Z', immutable: true },
  security: { classification: 'internal', contains_secrets: false, contains_pii: false, allowed_roles: [] },
  created_at: T0,
})

const approval = (id: string, missionId = 'mis-1', decision: Approval['decision'] = 'pending'): Approval => ({
  id, mission_id: missionId, task_id: missionId === 'mis-1' ? 'tsk-1' : 'other-task',
  action: 'code.commit', scope: 'mutating', requested_by: 'agent:codex', risk_level: 'mutating',
  reason: '需要人工确认', evidence_artifact_ids: [], decision,
  decided_by: decision === 'pending' ? null : 'user:tester',
  decided_at: decision === 'pending' ? null : T0,
  expires_at: '2099-01-01T00:00:00.000Z', created_at: T0,
})

async function setup(
  t: TestContext,
  opts: Partial<Parameters<typeof createControlPlane>[0]> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'cmap-webui-'))
  const workRoot = join(root, 'work')
  const frontendDir = join(root, 'dist')
  await mkdir(join(workRoot, 'tsk-1'), { recursive: true })
  await mkdir(join(frontendDir, 'assets'), { recursive: true })
  await writeFile(join(frontendDir, 'index.html'), '<!doctype html><div id="root"></div>')
  await writeFile(join(frontendDir, 'assets', 'app.js'), 'console.log("ok")')

  const bytes = Buffer.from('artifact bytes')
  await writeFile(join(workRoot, 'tsk-1', 'report.bin'), bytes)

  const store = new MemoryStore()
  await store.createMission({ mission: mission(), actor: ACTOR })
  await store.createMission({ mission: mission('other-mission', 'other'), actor: ACTOR })
  await store.createTask({ task: task(), actor: ACTOR })
  await store.createTask({ task: task('other-task', 'other-mission'), actor: ACTOR })
  await store.putArtifact(artifact('art-1', 'tsk-1', 'report.bin', bytes))
  await store.createApproval(approval('apr-1'))
  await store.createApproval(approval('apr-done', 'mis-1', 'approved'))
  await store.createApproval(approval('apr-other', 'other-mission'))

  const server = await createControlPlane({ store, tenant: 'local', owner: 'tester', workRoot, frontendDir, ...opts })
  await server.listen(0)
  t.after(async () => {
    await server.close()
    await rm(root, { recursive: true, force: true })
  })
  return { store, workRoot, frontendDir, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const postJson = async (base: string, path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return {
    status: res.status,
    body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text(),
  }
}

test('GET /v1/context 返回本机 tenant/owner，authentication 固定 local', async (t) => {
  const { base } = await setup(t)
  const res = await fetch(`${base}/v1/context`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { tenant: 'local', owner: 'tester', authentication: 'local' })
})

test('同源托管 Vite dist：index no-cache，hash assets immutable，路径越界拒绝', async (t) => {
  const { base } = await setup(t)
  const index = await fetch(`${base}/`)
  assert.equal(index.status, 200)
  assert.match(index.headers.get('content-type')!, /^text\/html/)
  assert.equal(index.headers.get('cache-control'), 'no-cache')
  const csp = index.headers.get('content-security-policy') ?? ''
  assert.match(csp, /default-src 'self'/)
  assert.match(csp, /img-src 'self' blob:/)
  assert.match(csp, /object-src 'none'/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.equal(csp.includes('unsafe-inline'), false)

  const asset = await fetch(`${base}/assets/app.js`)
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type')!, /^text\/javascript/)
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(await asset.text(), 'console.log("ok")')

  assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404)
  const escape = await fetch(`${base}/assets/%2e%2e%2findex.html`)
  assert.equal(escape.status, 403)
})

test('dist 缺失时静态入口明确 503', async (t) => {
  const { base, frontendDir } = await setup(t)
  await rm(frontendDir, { recursive: true, force: true })
  assert.equal((await fetch(`${base}/`)).status, 503)
  assert.equal((await fetch(`${base}/assets/missing.js`)).status, 503)
})

test('Artifact 下载返回原始 bytes，并校验租户、Task 归属、sha256 与响应头', async (t) => {
  const { base } = await setup(t)
  const res = await fetch(`${base}/v1/missions/mis-1/artifacts/tsk-1/art-1`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/octet-stream')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.match(res.headers.get('content-disposition')!, /^attachment; filename="art-1"/)
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('utf8'), 'artifact bytes')
  assert.equal(
    res.headers.get('x-content-sha256'),
    createHash('sha256').update('artifact bytes').digest('hex'),
  )

  assert.equal((await fetch(`${base}/v1/missions/other-mission/artifacts/other-task/art-1`)).status, 404)
  assert.equal((await fetch(`${base}/v1/missions/mis-1/artifacts/other-task/art-1`)).status, 404)
})

test('Artifact 下载支持真实落账路径：相对 URI 与 Task 内绝对路径，拒绝 Task 外绝对路径', async (t) => {
  const { base, store, workRoot } = await setup(t)
  const relativeBytes = Buffer.from('relative report')
  await mkdir(join(workRoot, 'tsk-1', 'evidence'), { recursive: true })
  await writeFile(join(workRoot, 'tsk-1', 'evidence', 'report.json'), relativeBytes)
  await store.putArtifact(artifact(
    'art-relative', 'tsk-1', 'ignored', relativeBytes, 'mis-1',
    'evidence/report.json',
  ))

  const insideBytes = Buffer.from('absolute inside')
  const inside = join(workRoot, 'tsk-1', 'absolute.txt')
  await writeFile(inside, insideBytes)
  await store.putArtifact(artifact('art-absolute-inside', 'tsk-1', 'ignored', insideBytes, 'mis-1', inside))

  const outsideBytes = Buffer.from('absolute outside')
  const outside = join(workRoot, 'outside-absolute.txt')
  await writeFile(outside, outsideBytes)
  await store.putArtifact(artifact('art-absolute-outside', 'tsk-1', 'ignored', outsideBytes, 'mis-1', outside))

  let res = await fetch(`${base}/v1/missions/mis-1/artifacts/tsk-1/art-relative`)
  assert.equal(res.status, 200)
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('utf8'), 'relative report')

  res = await fetch(`${base}/v1/missions/mis-1/artifacts/tsk-1/art-absolute-inside`)
  assert.equal(res.status, 200)
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('utf8'), 'absolute inside')

  assert.equal((await fetch(`${base}/v1/missions/mis-1/artifacts/tsk-1/art-absolute-outside`)).status, 403)
})

test('Artifact 下载兼容 sha256 大小写，并安全化非 ASCII 或换行文件名', async (t) => {
  const { base, store, workRoot } = await setup(t)
  const bytes = Buffer.from('safe header')
  await writeFile(join(workRoot, 'tsk-1', 'safe.bin'), bytes)
  const unsafeId = 'art-\n-雪'
  await store.putArtifact({
    ...artifact(unsafeId, 'tsk-1', 'safe.bin', bytes),
    sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
  })

  const res = await fetch(`${base}/v1/missions/mis-1/artifacts/tsk-1/${encodeURIComponent(unsafeId)}`)
  assert.equal(res.status, 200)
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('utf8'), 'safe header')
  const disposition = res.headers.get('content-disposition') ?? ''
  assert.match(disposition, /^attachment; filename="[ -~]+"$/)
  assert.equal(disposition.includes('\n'), false)
  assert.equal(disposition.includes('雪'), false)
})

test('Artifact 下载拒绝目录穿越、symlink 逃逸、超大文件与账本 hash 不符', async (t) => {
  const { base, store, workRoot } = await setup(t)
  const small = Buffer.from('small')
  await writeFile(join(workRoot, 'outside.txt'), small)
  await symlink(join(workRoot, 'outside.txt'), join(workRoot, 'tsk-1', 'link.txt'))
  await writeFile(join(workRoot, 'tsk-1', 'changed.bin'), Buffer.from('changed'))
  await writeFile(join(workRoot, 'tsk-1', 'big.bin'), Buffer.alloc(2 * 1024 * 1024 + 1))
  await store.putArtifact(artifact('art-traversal', 'tsk-1', '../outside.txt', small))
  await store.putArtifact(artifact('art-link', 'tsk-1', 'link.txt', small))
  await store.putArtifact({ ...artifact('art-hash', 'tsk-1', 'changed.bin', Buffer.from('original')) })
  await store.putArtifact(artifact('art-big', 'tsk-1', 'big.bin', Buffer.alloc(2 * 1024 * 1024 + 1)))

  assert.equal((await fetch(`${base}/v1/missions/mis-1/artifacts/tsk-1/art-traversal`)).status, 403)
  assert.equal((await fetch(`${base}/v1/missions/mis-1/artifacts/tsk-1/art-link`)).status, 403)
  assert.equal((await fetch(`${base}/v1/missions/mis-1/artifacts/tsk-1/art-big`)).status, 413)
  assert.equal((await fetch(`${base}/v1/missions/mis-1/artifacts/tsk-1/art-hash`)).status, 409)
})

test('Approval advice 只查询 pending 本租户审批，返回建议但不写入 Approval', async (t) => {
  const calls: string[] = []
  const advice = {
    schema: 'cmap/approval-advice/v1', request_id: 'apr-1',
    recommendation: 'continue', can_continue: false,
    reason_code: 'within_existing_authorization',
    input_sha256: 'a'.repeat(64), model: 'jev-test', confidence: 0.8,
    elapsed_ms: 12, usage: { input_tokens: 1, output_tokens: 2 },
  } as const
  const { base, store } = await setup(t, {
    getApprovalAdvice: async (id: string) => {
      calls.push(id)
      return advice
    },
  })
  const res = await postJson(base, '/v1/approvals/apr-1/advice', {})
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, advice)
  assert.deepEqual(calls, ['apr-1'])
  assert.equal((await store.getApproval('apr-1'))?.decision, 'pending')
})

test('Approval advice 缺配置、helper失败和注入 body 都保守失败且不回显内部错误', async (t) => {
  const missing = await setup(t)
  assert.equal((await postJson(missing.base, '/v1/approvals/apr-1/advice', {})).status, 503)

  const failing = await setup(t, {
    getApprovalAdvice: async () => { throw new Error('secret stderr or timeout') },
  })
  const failed = await postJson(failing.base, '/v1/approvals/apr-1/advice', {})
  assert.equal(failed.status, 503)
  assert.equal(JSON.stringify(failed.body).includes('secret'), false)

  const calls: string[] = []
  const injected = await setup(t, {
    getApprovalAdvice: async (id: string) => {
      calls.push(id)
      throw new Error('should not be called')
    },
  })
  assert.equal((await postJson(injected.base, '/v1/approvals/apr-1/advice', { approval_id: 'apr-other' })).status, 400)
  assert.deepEqual(calls, [])
})

test('Approval advice 对跨租户、已处理或不存在审批返回 404 且不调用 provider', async (t) => {
  const calls: string[] = []
  const { base } = await setup(t, {
    getApprovalAdvice: async (id: string) => {
      calls.push(id)
      throw new Error('should not be called')
    },
  })
  assert.equal((await postJson(base, '/v1/approvals/apr-other/advice', {})).status, 404)
  assert.equal((await postJson(base, '/v1/approvals/apr-done/advice', {})).status, 404)
  assert.equal((await postJson(base, '/v1/approvals/missing/advice', {})).status, 404)
  assert.deepEqual(calls, [])
})

test('Approval advice helper 用 execFile stdout 做 schema 校验，合法 unavailable exit 2 可返回', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-advice-helper-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'schemas'), { recursive: true })
  await mkdir(join(root, 'scripts'), { recursive: true })
  await writeFile(
    join(root, 'schemas', 'approval-advice.v1.schema.json'),
    await readFile(new URL('../../schemas/approval-advice.v1.schema.json', import.meta.url), 'utf8'),
  )
  await writeFile(join(root, 'scripts', 'jev-approval.mjs'), `
const id = process.argv.at(-1)
const base = {
  schema: 'cmap/approval-advice/v1',
  request_id: id,
  recommendation: id === 'unavailable' ? 'insufficient' : 'review',
  can_continue: false,
  reason_code: id === 'unavailable' ? 'unavailable' : 'model_review',
  input_sha256: 'b'.repeat(64),
  model: process.env.CMAP_API_PORT === '32123' ? 'port-ok' : 'port-missing',
  confidence: 0.5,
  elapsed_ms: 1,
  usage: { input_tokens: 1, output_tokens: 1 },
}
if (id === 'bad') base.can_continue = true
console.log(JSON.stringify(base))
if (id === 'unavailable') process.exit(2)
`)

  const ok = await getApprovalAdviceFromJev('apr-helper', { repoRoot: root, port: 32123 })
  assert.equal(ok.request_id, 'apr-helper')
  assert.equal(ok.model, 'port-ok')

  const unavailable = await getApprovalAdviceFromJev('unavailable', { repoRoot: root, port: 32123 })
  assert.equal(unavailable.reason_code, 'unavailable')

  await assert.rejects(
    () => getApprovalAdviceFromJev('bad', { repoRoot: root, port: 32123 }),
    /approval advice unavailable/,
  )
})


test('畸形路径编码返回 400 而非服务器错误', async (t) => {
  const { base } = await setup(t)
  for (const path of ['/assets/%E0%A4%A', '/v1/missions/%E0%A4%A']) {
    const response = await fetch(`${base}${path}`)
    assert.equal(response.status, 400)
    assert.match(JSON.stringify(await response.json()), /路径编码无效/)
  }
})
