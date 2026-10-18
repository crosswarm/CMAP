/**
 * 远程 runner 接入控制面派发链路（ADR-0006 Stage 3）：Activities + MemoryStore + 本机端口上的模拟 lap。
 * workflow 代码不变；这里验证路由、拒绝回执、证据复算与失联不确定在账本上的落点。
 */
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryStore, verifyDispatchPermit, type Mission, type TaskEnvelopeV1 } from '#domain-model'
import type { DispatchContext } from '#adapter-sdk'
import { RemoteRunnerAdapter } from '../../adapters/remote-runner/src/index.ts'
import { createActivities } from '../../workflows/activities.ts'
import { createDagAttemptRunner } from '../../workflows/dag-attempt.ts'
import { FakeAdapter, syntheticRunner } from './fake-adapter.ts'
import {
  ISSUER, close, deadUrl, envelope, trust, lapEnv, lines, makeFakeCodex, remoteAuthorization, remoteKeys, sha256, signer, startLap, startTamperProxy,
} from '../adapter/remote-runner-fixture.ts'

const ACTOR = { type: 'system', id: 'remote-runner-test' } as const

/** 记录远端拒绝的原始错误码，证明 lap 侧拒绝的具体原因。 */
class SpyRemote extends RemoteRunnerAdapter {
  readonly errors: string[] = []
  override async startTask(e: TaskEnvelopeV1, ctx: DispatchContext) {
    try {
      return await super.startTask(e, ctx)
    } catch (error) {
      this.errors.push((error as { code: string }).code)
      throw error
    }
  }
}

const localCodex = (): FakeAdapter => {
  const adapter = new FakeAdapter()
  Object.defineProperty(adapter, 'adapterId', { value: 'local-codex-adapter' })
  Object.defineProperty(adapter, 'agentId', { value: 'codex' })
  Object.defineProperty(adapter, 'authorization', { value: { mode: 'managed', verifier: (token: string, e: TaskEnvelopeV1, adapterId: string, runnerId: string) =>
    verifyDispatchPermit(token, { publicKey: trust.publicKey, issuer: ISSUER, runnerId, adapterId, envelope: e }) } })
  return adapter
}

const fixture = async (taskId: string, remoteUrl: (lapUrl: string) => Promise<string> | string = (u) => u, lapOverrides: Record<string, string> = {}, opts: { clockOffsetMs?: number; offlineGraceMs?: number; risk?: TaskEnvelopeV1['classification']['risk_level']; timeoutSeconds?: number } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-remote-wf-'))
  const codex = await makeFakeCodex(root)
  const cm = join(root, 'crossmini')
  await mkdir(cm)
  const lap = await startLap({ env: lapEnv('lap', codex.bin, lapOverrides), workRoot: join(root, 'lap'), ...(opts.clockOffsetMs ? { clockOffsetMs: opts.clockOffsetMs } : {}) })
  const remote = new SpyRemote({
    authorization: remoteAuthorization('lap'), ...remoteKeys, baseUrl: await remoteUrl(lap.url), runnerId: 'lap', agentId: 'codex@lap',
    workRoot: cm, capabilities: ['code.analyze'], ...(opts.offlineGraceMs ? { offlineGraceMs: opts.offlineGraceMs } : {}),
  })
  const local = localCodex()
  const store = new MemoryStore()
  const now = new Date().toISOString()
  const mission: Mission = { id: 'mis-remote', tenant: 'team-ycc', owner: 'crosswarm', type: 'inspect', goal: 'remote', constraints: {}, acceptance: [{ criterion_id: 'C1', metric: 'done', operator: 'eq', expected: true, hard_gate: true }], workflow_template: 'inspect/v1', state: 'RUNNING', revision: 1, created_at: now, updated_at: now }
  await store.createMission({ mission, actor: ACTOR })
  const base = envelope(taskId, { preferred_agent: 'codex@lap', fallback_agents: ['codex'], ...(opts.timeoutSeconds ? { timeout_seconds: opts.timeoutSeconds } : {}) })
  const risk = opts.risk ?? 'read-meta'
  const e: TaskEnvelopeV1 = { ...base, classification: { ...base.classification, risk_level: risk } }
  await store.createTask({ actor: ACTOR, task: { id: taskId, mission_id: mission.id, parent_task_id: null, supersedes_task_id: null, capability: 'code.analyze', risk, state: 'DRAFT', attempt: 1, max_attempts: 1, lamport: 0, envelope: e, result: null, binding: null, deps: [], created_at: now, updated_at: now } })
  const acts = createActivities({
    store, adapters: [remote, local], signDispatchPermit: signer, workRoot: cm, pollIntervalMs: 10,
    runner: syntheticRunner({ runner_id: 'crossmini', agents: ['codex@lap', 'codex'] }),
  })
  await acts.markReady(taskId)
  const cleanup = async () => {
    await close(lap.server)
    await rm(root, { recursive: true, force: true })
  }
  const runAttempt = createDagAttemptRunner({
    store, adapters: [remote, local], signDispatchPermit: signer, workRoot: cm, pollIntervalMs: 10,
    runner: syntheticRunner({ runner_id: 'crossmini', agents: ['codex@lap', 'codex'] }),
  })
  return { root, codex, cm, lap, remote, local, store, acts, runAttempt, cleanup }
}

const routing = async (store: MemoryStore) =>
  (await store.listEvents('mis-remote')).filter((e) => e.event_type === 'ROUTING_DECIDED').map((e) => e.payload as Record<string, any>)

test('首选 codex@lap：许可受众为 lap，lap 执行一次，结果与证据经 CrossMini 复算后入账', async () => {
  const f = await fixture('tsk-remote-ok')
  try {
    assert.deepEqual(await f.acts.dispatchTask('tsk-remote-ok'), { dispatched: true, remoteTaskId: 'codex:tsk-remote-ok:1' })
    const task = (await f.store.getTask('tsk-remote-ok'))!
    assert.equal(task.binding!.adapter, 'remote-runner-adapter')
    assert.equal(task.binding!.runner_id, 'lap')
    const [decision] = await routing(f.store)
    assert.equal(decision!.chosen_agent, 'codex@lap')
    assert.equal(decision!.fallback, false)

    const collected = await f.acts.collectTaskResult('tsk-remote-ok')
    assert.ok('passed' in collected && collected.passed)
    const [artifact, ...rest] = await f.store.listArtifacts('tsk-remote-ok')
    assert.equal(rest.length, 0)
    assert.equal(artifact!.sha256, sha256('ok'))
    assert.equal(artifact!.provenance['runner_id'], 'lap')
    await access(join(f.cm, 'tsk-remote-ok', artifact!.uri))
    assert.equal((await lines(f.codex.launches)).length, 1)
    assert.equal(f.local.startCalls.length, 0)
  } finally {
    await f.cleanup()
  }
})

test('lap 不在线：3 秒健康探测失败即回落本地 codex，ROUTING_DECIDED 记下原因', async () => {
  const f = await fixture('tsk-remote-offline', () => deadUrl())
  try {
    await f.acts.dispatchTask('tsk-remote-offline')
    assert.equal((await f.store.getTask('tsk-remote-offline'))!.binding!.adapter, 'local-codex-adapter')
    const [decision] = await routing(f.store)
    assert.equal(decision!.fallback, true)
    assert.deepEqual(decision!.candidates.map((c: any) => [c.agent_id, c.verdict, c.reason]), [
      ['codex@lap', 'skipped', 'unhealthy'],
      ['codex', 'selected', null],
    ])
    assert.equal(f.local.startCalls.length, 1)
    assert.equal((await lines(f.codex.launches)).length, 0)
  } finally {
    await f.cleanup()
  }
})

test('许可被投到另一台 runner（lap-2）重放 → 请求受众不符被拒，落 PERMIT_INVALID，执行 0 次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-remote-wf-other-'))
  const otherCodex = await makeFakeCodex(root)
  const other = await startLap({ env: lapEnv('lap-2', otherCodex.bin), workRoot: join(root, 'lap-2') })
  const f = await fixture('tsk-remote-replay', () => other.url)
  // 健康探测会核对 runner_id 并据此回落；这里模拟探测通过而派发请求落到了另一台 runner
  f.remote.health = async () => ({ state: 'healthy', checked_at: new Date().toISOString() })
  try {
    assert.deepEqual(await f.acts.dispatchTask('tsk-remote-replay'), { dispatched: false, admissionDenied: { phase: 'post-intent', code: 'PERMIT_INVALID' } })
    assert.deepEqual(f.remote.errors, ['BAD_SIGNATURE'])
    const task = (await f.store.getTask('tsk-remote-replay'))!
    assert.equal(task.state, 'FAILED_TERMINAL')
    assert.equal(task.binding!.runner_id, 'lap')
    assert.equal((await lines(otherCodex.launches)).length + (await lines(f.codex.launches)).length, 0)
  } finally {
    await close(other.server)
    await rm(root, { recursive: true, force: true })
    await f.cleanup()
  }
})

test('lap 时钟超出 2 秒偏差 → 健康探测请求时间戳超窗被 401，按 unhealthy 回落本地，lap 执行 0 次', async () => {
  const f = await fixture('tsk-remote-expired', undefined, {}, { clockOffsetMs: 63_000 })
  try {
    assert.equal((await f.acts.dispatchTask('tsk-remote-expired')).dispatched, true)
    assert.equal((await f.store.getTask('tsk-remote-expired'))!.binding!.adapter, 'local-codex-adapter')
    const [decision] = await routing(f.store)
    assert.deepEqual(decision!.candidates.map((c: any) => [c.agent_id, c.verdict, c.reason]), [
      ['codex@lap', 'skipped', 'unhealthy'],
      ['codex', 'selected', null],
    ])
    assert.deepEqual(f.remote.errors, [])
    assert.equal((await lines(f.codex.launches)).length, 0)
  } finally {
    await f.cleanup()
  }
})

test('lap 回传的产物字节被篡改 → EVIDENCE_HASH_MISMATCH，任务失败且不写 artifact 记录', async () => {
  let proxy: Awaited<ReturnType<typeof startTamperProxy>> | undefined
  const f = await fixture('tsk-remote-tamper', async (url) => (proxy = await startTamperProxy(url)).url)
  try {
    await f.acts.dispatchTask('tsk-remote-tamper')
    const collected = await f.acts.collectTaskResult('tsk-remote-tamper')
    assert.ok('passed' in collected && !collected.passed)
    const task = (await f.store.getTask('tsk-remote-tamper'))!
    assert.equal(task.result!.status, 'failed')
    assert.equal(task.result!.error!.code, 'EVIDENCE_HASH_MISMATCH')
    assert.deepEqual(await f.store.listArtifacts('tsk-remote-tamper'), [])
    await assert.rejects(access(join(f.cm, 'tsk-remote-tamper', 'evidence/report.txt')))
    assert.equal((await lines(f.codex.launches)).length, 1)
  } finally {
    if (proxy) await close(proxy.server)
    await f.cleanup()
  }
})

const candidates = async (store: MemoryStore) => (await routing(store)).map((d) => d.candidates.map((c: any) => [c.agent_id, c.verdict, c.reason]))

for (const [name, lapOverrides, risk, reason] of [
  ['能力', { RUNNER_ALLOWED_CAPABILITIES: '' }, undefined, 'capability_mismatch'],
  ['风险上限', {}, 'read-sensitive', 'risk_exceeded'],
  ['owner', { RUNNER_ALLOWED_OWNERS: 'someone-else' }, undefined, 'owner_mismatch'],
  ['租户', { RUNNER_ALLOWED_TENANTS: 'other-tenant' }, undefined, 'tenant_mismatch'],
] as const) test(`lap 公布的准入白名单不放行${name} → 路由跳过 codex@lap（${reason}）并回落本地，lap 0 次执行`, async () => {
  const f = await fixture(`tsk-remote-route-${reason}`, undefined, lapOverrides, risk ? { risk } : {})
  try {
    assert.equal((await f.acts.dispatchTask(`tsk-remote-route-${reason}`)).dispatched, true)
    const task = (await f.store.getTask(`tsk-remote-route-${reason}`))!
    assert.equal(task.binding!.adapter, 'local-codex-adapter')
    assert.deepEqual(await candidates(f.store), [[['codex@lap', 'skipped', reason], ['codex', 'selected', null]]])
    assert.equal((await routing(f.store))[0]!.fallback, true)
    assert.deepEqual(f.remote.errors, [])
    assert.equal(f.local.startCalls.length, 1)
    assert.equal((await lines(f.codex.launches)).length, 0)
  } finally {
    await f.cleanup()
  }
})

test('纵深防御：health 公布的白名单过时（探测后 lap 收紧 owner）→ lap 派发时仍拒绝 RUNNER_ADMISSION_REVOKED:OWNER_DENIED，执行 0 次', async () => {
  const f = await fixture('tsk-remote-owner', undefined, { RUNNER_ALLOWED_OWNERS: 'someone-else' })
  // 模拟探测时拿到的是收紧前的白名单
  f.remote.health = async () => ({ state: 'healthy', checked_at: new Date().toISOString(),
    admission: { allowed_tenants: ['team-ycc'], allowed_owners: ['crosswarm'], allowed_capabilities: ['code.analyze'], max_risk: 'read-meta' } })
  try {
    assert.deepEqual(await f.acts.dispatchTask('tsk-remote-owner'), { dispatched: false, admissionDenied: { phase: 'post-intent', code: 'OWNER_DENIED' } })
    const collected = await f.acts.collectTaskResult('tsk-remote-owner')
    assert.ok('summary' in collected)
    assert.equal(collected.summary, 'RUNNER_ADMISSION_REVOKED:OWNER_DENIED')
    assert.equal((await lines(f.codex.launches)).length, 0)
  } finally {
    await f.cleanup()
  }
})

test('执行中 lap 失联超过宽限 → 执行不确定，保留绑定，不改派、不二次执行', async () => {
  const f = await fixture('tsk-remote-lost', undefined, {}, { offlineGraceMs: 300 })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(f.codex.hold, '')
  try {
    await f.acts.dispatchTask('tsk-remote-lost')
    for (let i = 0; i < 200 && (await lines(f.codex.launches)).length === 0; i += 1) await new Promise((r) => setTimeout(r, 10))
    await close(f.lap.server) // lap 下线；codex 仍在 lap 上跑

    const started = Date.now()
    assert.deepEqual(await f.acts.collectTaskResult('tsk-remote-lost'), { executionUncertain: { code: 'BINDING_NOT_FOUND', terminalObserved: false } })
    assert.ok(Date.now() - started >= 300)
    const task = (await f.store.getTask('tsk-remote-lost'))!
    assert.equal(task.state, 'INPUT_REQUIRED')
    assert.equal(task.binding!.runner_id, 'lap')
    assert.deepEqual(await f.acts.collectTaskResult('tsk-remote-lost'), { executionUncertain: { code: 'BINDING_NOT_FOUND', terminalObserved: false } })
    assert.deepEqual(await f.acts.dispatchTask('tsk-remote-lost'), { dispatched: false, remoteTaskId: 'codex:tsk-remote-lost:1' })
    assert.equal((await lines(f.codex.launches)).length, 1)
    assert.equal(f.local.startCalls.length, 0)
  } finally {
    await f.lap.adapter.cancel(f.lap.adapter.prepareBinding(envelope('tsk-remote-lost'), { runner_id: 'lap' } as DispatchContext), 'test cleanup').catch(() => {})
    await rm(f.codex.hold, { force: true })
    await f.cleanup()
  }
})

/** 派发到 lap、等假 codex 真正启动后让 lap 下线（codex 仍在 lap 上跑）。 */
const goOfflineMidRun = async (f: Awaited<ReturnType<typeof fixture>>, dispatch: () => Promise<unknown>) => {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(f.codex.hold, '')
  const pending = dispatch()
  for (let i = 0; i < 300 && (await lines(f.codex.launches)).length === 0; i += 1) await new Promise((r) => setTimeout(r, 10))
  assert.equal((await lines(f.codex.launches)).length, 1)
  await close(f.lap.server)
  return pending
}

const cleanupOffline = async (f: Awaited<ReturnType<typeof fixture>>, taskId: string) => {
  await f.lap.adapter.cancel(f.lap.adapter.prepareBinding(envelope(taskId), { runner_id: 'lap' } as DispatchContext), 'test cleanup').catch(() => {})
  await rm(f.codex.hold, { force: true })
  await f.cleanup()
}

test('宽限先于超时：配置宽限 600 秒、任务超时 2 秒，执行中失联 → 收结果判执行不确定而不是超时，不改派、不二次执行', async () => {
  const f = await fixture('tsk-remote-grace-timeout', undefined, {}, { timeoutSeconds: 2 })
  try {
    await f.acts.dispatchTask('tsk-remote-grace-timeout')
    const started = Date.now()
    const collected = await goOfflineMidRun(f, () => f.acts.collectTaskResult('tsk-remote-grace-timeout'))
    assert.deepEqual(collected, { executionUncertain: { code: 'BINDING_NOT_FOUND', terminalObserved: false } })
    assert.ok(Date.now() - started < 2_000, '应在 2 秒任务超时之前判定')
    const task = (await f.store.getTask('tsk-remote-grace-timeout'))!
    assert.equal(task.state, 'INPUT_REQUIRED')
    assert.equal(task.binding!.runner_id, 'lap')
    assert.equal(f.remote.errors.length, 0)
    assert.equal(f.local.startCalls.length, 0)
    assert.equal((await lines(f.codex.launches)).length, 1)
  } finally {
    await cleanupOffline(f, 'tsk-remote-grace-timeout')
  }
})

test('宽限先于超时（dag/v1 attempt）：执行中失联 → EXECUTION_UNCERTAIN:BINDING_NOT_FOUND，而不是 TIMEOUT / CANCELLATION_UNCONFIRMED', async () => {
  const f = await fixture('tsk-remote-grace-dag', undefined, {}, { timeoutSeconds: 2 })
  try {
    const started = Date.now()
    const out = await goOfflineMidRun(f, () => f.runAttempt({ taskId: 'tsk-remote-grace-dag' }))
    assert.deepEqual(out, { outcome: 'escalated', taskId: 'tsk-remote-grace-dag', reason: 'EXECUTION_UNCERTAIN:BINDING_NOT_FOUND' })
    assert.ok(Date.now() - started < 2_500)
    const task = (await f.store.getTask('tsk-remote-grace-dag'))!
    assert.equal(task.state, 'INPUT_REQUIRED')
    assert.equal(task.binding!.runner_id, 'lap')
    const evs = await f.store.listEvents('mis-remote')
    assert.equal(evs.filter((e) => e.event_type === 'ROUTING_DECIDED').length, 1)
    assert.equal(evs.filter((e) => e.event_type === 'TASK_STARTED').length, 1)
    assert.equal(f.local.startCalls.length, 0)
    assert.equal((await lines(f.codex.launches)).length, 1)
  } finally {
    await cleanupOffline(f, 'tsk-remote-grace-dag')
  }
})
