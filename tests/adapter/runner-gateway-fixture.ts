/**
 * 出站网关测试夹具（ADR-0008 §3）：同一进程内起控制面 API（含网关）、Worker 侧 GatewayRunnerAdapter 与出站模式 runner（假 codex）。
 * API 与 Adapter 共用一个 MemoryStore，对应生产中共用的 PostgreSQL 账本。
 * 本文件不以 .test.ts 结尾，避免被测试运行器当作独立用例执行。
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore, rawEd25519PublicKey, type GatewayRunner, type Mission, type Store, type TaskEnvelopeV1 } from '#domain-model'
import { DispatchPermitError, verifyDispatchPermit } from '#domain-model'
import type { AdapterAuthorization } from '#adapter-sdk'
import { createControlPlane } from '../../apps/control-plane-api/src/server.ts'
import { createRunnerCore } from '../../apps/runner/src/server.ts'
import { enrolledRunnerEnv, startOutboundRunner, type RunnerEnrollment } from '../../apps/runner/src/outbound.ts'
import { GATEWAY_ADAPTER_ID, GatewayRunnerAdapter } from '../../adapters/runner-gateway/src/index.ts'
import { createActivities } from '../../workflows/activities.ts'
import { createDagAttemptRunner } from '../../workflows/dag-attempt.ts'
import { syntheticRunner } from '../workflow/fake-adapter.ts'
import { ISSUER, envelope, lapEnv, makeFakeCodex, signer, trust } from './remote-runner-fixture.ts'

const ACTOR = { type: 'system', id: 'runner-gateway-test' } as const
export const controlPlaneKey = generateKeyPairSync('ed25519')

/** Worker 侧自检：许可受众必须是路由所选的 runner。 */
export const gatewayAuthorization: AdapterAuthorization = {
  mode: 'managed',
  verifier: (token, e, adapterId, contextRunner) => {
    if (!contextRunner) throw new DispatchPermitError('CLAIM_MISMATCH')
    return verifyDispatchPermit(token, { publicKey: trust.publicKey, issuer: ISSUER, runnerId: contextRunner, adapterId, envelope: e })
  },
}

export const enrolledRecord = (runner: GatewayRunner): RunnerEnrollment => ({
  schema: 'cmap/runner-enrollment/v1', kind: 'enrolled', runner_id: runner.runner_id, tenant: runner.tenant, owner: runner.owner,
  allowed_capabilities: [...runner.allowed_capabilities], max_risk: runner.max_risk,
  control_plane_public_key: rawEd25519PublicKey(controlPlaneKey.publicKey), enrolled_at: runner.enrolled_at,
})

export const gatewayRunnerRecord = (runner_id: string, key: KeyObject, overrides: Partial<GatewayRunner> = {}): GatewayRunner => ({
  runner_id, public_key: rawEd25519PublicKey(key), tenant: 'team-ycc', owner: 'crosswarm', allowed_capabilities: ['code.analyze'],
  max_risk: 'read-meta', host: 'lap', enrolled_at: new Date().toISOString(), revoked_at: null, last_seen_at: null, ...overrides,
})

export interface GatewayFixtureOptions {
  readonly leaseTtlMs?: number
  readonly acceptTimeoutMs?: number
  readonly store?: Store
  readonly notifyRunnerReported?: (missionId: string, workflowId: string) => Promise<void>
  /** 假 codex 产物长度（M09 大产物）；不设为 'ok'。 */
  readonly artifactBytes?: number
}

export const startGatewayFixture = async (opts: GatewayFixtureOptions = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-gateway-'))
  const codex = await makeFakeCodex(root, opts.artifactBytes === undefined ? {} : { artifactBytes: opts.artifactBytes })
  const cm = join(root, 'crossmini')
  await mkdir(cm)
  const store = opts.store ?? new MemoryStore()
  const api = await createControlPlane({
    // API 与 Worker 共用控制面工作区：网关上传的产物落在同一个内容寻址存储里
    store, tenant: 'team-ycc', owner: 'crosswarm', workRoot: cm,
    runnerGateway: { signingKey: controlPlaneKey.privateKey, pollIntervalMs: 20, leaseTtlMs: opts.leaseTtlMs ?? 120_000 },
    ...(opts.notifyRunnerReported ? { notifyRunnerReported: opts.notifyRunnerReported } : {}),
  })
  await api.listen(0)
  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
  const gateway = new GatewayRunnerAdapter({
    authorization: gatewayAuthorization, store, agentId: 'codex@gateway', workRoot: cm, capabilities: ['code.analyze'],
    pollIntervalMs: 20, acceptTimeoutMs: opts.acceptTimeoutMs ?? 10_000,
  })
  const runnerDeps = { store, adapters: [gateway], signDispatchPermit: signer, workRoot: cm, pollIntervalMs: 10,
    runner: syntheticRunner({ runner_id: 'crossmini', agents: ['codex@gateway'] }) }
  const acts = createActivities(runnerDeps)
  const runAttempt = createDagAttemptRunner(runnerDeps)
  const stops: AbortController[] = []

  /** 登记一个 runner 并以出站模式启动；stop() 模拟断网/进程退出（不再续租、不再回报）。 */
  const startRunner = async (runnerId: string, o: { owner?: string; key?: { privateKey: KeyObject; publicKey: KeyObject }; register?: boolean; overrides?: Partial<GatewayRunner>; log?: (line: string) => void; logIntervalMs?: number } = {}) => {
    const key = o.key ?? generateKeyPairSync('ed25519')
    const record = gatewayRunnerRecord(runnerId, key.publicKey, { ...(o.owner ? { owner: o.owner } : {}), ...o.overrides })
    if (o.register !== false) await store.registerGatewayRunner(record)
    const core = await createRunnerCore({
      env: enrolledRunnerEnv(lapEnv('ignored', codex.bin), enrolledRecord(record)), publicKey: trust.publicKey, issuer: ISSUER,
      workRoot: join(root, `runner-${runnerId}`), permitAdapterId: GATEWAY_ADAPTER_ID,
    })
    const stop = new AbortController()
    stops.push(stop)
    const loop = startOutboundRunner({
      core, controlPlaneUrl: apiUrl, signingKey: key.privateKey, controlPlanePublicKey: controlPlaneKey.publicKey,
      waitSeconds: 1, statusIntervalMs: 20, retryMs: 50, signal: stop.signal,
      ...(o.log ? { log: o.log } : {}), ...(o.logIntervalMs ? { logIntervalMs: o.logIntervalMs } : {}),
    })
    return { record, key, core, loop, stop: () => stop.abort() }
  }

  const addTask = async (taskId: string, e: TaskEnvelopeV1 = envelope(taskId, { preferred_agent: 'codex@gateway' })) => {
    if (!(await store.getMission(e.identity.mission_id))) {
      const now = new Date().toISOString()
      const mission: Mission = {
        id: e.identity.mission_id, tenant: e.identity.tenant ?? 'team-ycc', owner: e.identity.owner ?? 'crosswarm', type: 'inspect', goal: 'gateway',
        constraints: {}, acceptance: [{ criterion_id: 'C1', metric: 'done', operator: 'eq', expected: true, hard_gate: true }],
        workflow_template: 'dag/v1', state: 'RUNNING', revision: 1, created_at: now, updated_at: now,
      }
      await store.createMission({ mission, actor: ACTOR })
    }
    const now = new Date().toISOString()
    await store.createTask({ actor: ACTOR, task: {
      id: taskId, mission_id: e.identity.mission_id, parent_task_id: null, supersedes_task_id: null, capability: e.classification.requested_capability,
      risk: e.classification.risk_level, state: 'DRAFT', attempt: 1, max_attempts: 1, lamport: 0, envelope: e, result: null, binding: null,
      deps: [], created_at: now, updated_at: now,
    } })
    await acts.markReady(taskId)
  }

  const cleanup = async () => {
    for (const s of stops) s.abort()
    await api.close()
    await rm(root, { recursive: true, force: true })
  }
  return { root, codex, cm, store, apiUrl, gateway, acts, runAttempt, startRunner, addTask, cleanup }
}
