/**
 * 本机 runner 守护进程（S16）：CrossMini 的 codex 也经 runner 守护进程执行，与 lap 同时注册两个 RemoteRunnerAdapter。
 * 两者 adapter_id 相同（remote-runner-adapter），只靠 binding.runner_id 区分；派发、收结果、取消与 Worker 重启恢复
 * 都必须落到 binding 所属的那台 runner。Activities + MemoryStore + 本机端口上的两个守护进程，不需要 Temporal。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryStore, type Mission } from '#domain-model'
import { Context } from '@temporalio/activity'
import { RemoteRunnerAdapter } from '../../adapters/remote-runner/src/index.ts'
import { createActivities } from '../../workflows/activities.ts'
import { createDagActivities } from '../../workflows/dag-activities.ts'
import { syntheticRunner } from './fake-adapter.ts'
import { close, envelope, lapEnv, lines, makeFakeCodex, remoteAuthorization, remoteKeys, sha256, signer, startLap } from '../adapter/remote-runner-fixture.ts'

const ACTOR = { type: 'system', id: 'local-runner-test' } as const
const LOCAL = 'crossmini-runner'

const setup = async (tasks: readonly (readonly [taskId: string, preferred: string])[]) => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-local-runner-'))
  const cm = join(root, 'crossmini')
  await mkdir(join(root, 'bin-local'), { recursive: true })
  await mkdir(join(root, 'bin-lap'), { recursive: true })
  await mkdir(cm)
  const localCodex = await makeFakeCodex(join(root, 'bin-local'))
  const lapCodex = await makeFakeCodex(join(root, 'bin-lap'))
  const localDaemon = await startLap({ env: lapEnv(LOCAL, localCodex.bin, { RUNNER_HOST: 'crossmini-host' }), workRoot: join(root, 'local-runner') })
  const lapDaemon = await startLap({ env: lapEnv('lap', lapCodex.bin), workRoot: join(root, 'lap') })
  const adapterFor = (runnerId: string, agentId: string, url: string) => new RemoteRunnerAdapter({
    authorization: remoteAuthorization(runnerId), ...remoteKeys, baseUrl: url, runnerId, agentId, workRoot: cm, capabilities: ['code.analyze'],
  })
  // 与 Worker 接线一致：本机 codex 先注册，lap 随后
  const adapters = () => [adapterFor(LOCAL, 'codex', localDaemon.url), adapterFor('lap', 'codex@lap', lapDaemon.url)]
  const runner = syntheticRunner({ runner_id: 'crossmini', agents: ['codex', 'codex@lap'] })
  const store = new MemoryStore()
  const now = new Date().toISOString()
  const mission: Mission = { id: 'mis-remote', tenant: 'team-ycc', owner: 'crosswarm', type: 'inspect', goal: 'local runner', constraints: {}, acceptance: [{ criterion_id: 'C1', metric: 'done', operator: 'eq', expected: true, hard_gate: true }], workflow_template: 'inspect/v1', state: 'RUNNING', revision: 1, created_at: now, updated_at: now }
  await store.createMission({ mission, actor: ACTOR })
  const deps = { store, signDispatchPermit: signer, workRoot: cm, pollIntervalMs: 10, runner }
  const cleanup = async () => {
    await rm(localCodex.hold, { force: true })
    await rm(lapCodex.hold, { force: true })
    await close(localDaemon.server)
    await close(lapDaemon.server)
    await rm(root, { recursive: true, force: true })
  }
  try {
    const acts = createActivities({ ...deps, adapters: adapters() })
    for (const [taskId, preferred] of tasks) {
      const e = envelope(taskId, { preferred_agent: preferred })
      await store.createTask({ actor: ACTOR, task: { id: taskId, mission_id: mission.id, parent_task_id: null, supersedes_task_id: null, capability: 'code.analyze', risk: 'read-meta', state: 'DRAFT', attempt: 1, max_attempts: 1, lamport: 0, envelope: e, result: null, binding: null, deps: [], created_at: now, updated_at: now } })
      await acts.markReady(taskId)
    }
    return { cm, store, acts, deps, adapters, localCodex, lapCodex, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

test('本机 runner 与 lap 同时注册：codex 走本机守护进程、codex@lap 走 lap，各执行一次，binding 与证据按 runner 区分', async () => {
  const f = await setup([['tsk-local-a', 'codex'], ['tsk-lap-b', 'codex@lap']])
  try {
    assert.deepEqual(await f.acts.dispatchTask('tsk-local-a'), { dispatched: true, remoteTaskId: 'codex:tsk-local-a:1' })
    assert.deepEqual(await f.acts.dispatchTask('tsk-lap-b'), { dispatched: true, remoteTaskId: 'codex:tsk-lap-b:1' })
    assert.deepEqual((await f.store.getTask('tsk-local-a'))!.binding, { adapter: 'remote-runner-adapter', remote_task_id: 'codex:tsk-local-a:1', protocol: 'cmap-remote-runner', protocol_version: '1', runner_id: LOCAL })
    assert.equal((await f.store.getTask('tsk-lap-b'))!.binding!.runner_id, 'lap')

    for (const [taskId, runnerId] of [['tsk-local-a', LOCAL], ['tsk-lap-b', 'lap']] as const) {
      const collected = await f.acts.collectTaskResult(taskId)
      assert.ok('passed' in collected && collected.passed, taskId)
      const [artifact] = await f.store.listArtifacts(taskId)
      assert.equal(artifact!.sha256, sha256('ok'))
      assert.equal(artifact!.provenance['runner_id'], runnerId)
    }
    assert.equal((await lines(f.localCodex.launches)).length, 1)
    assert.equal((await lines(f.lapCodex.launches)).length, 1)
  } finally {
    await f.cleanup()
  }
})

test('Worker 重启（dag/v1）：新 Worker 的适配器按 binding.runner_id 找回 lap，不落到同 adapter_id 的本机 runner，只执行 1 次', async () => {
  const f = await setup([['tsk-lap-restart', 'codex@lap']])
  try {
    assert.equal((await f.acts.dispatchTask('tsk-lap-restart')).dispatched, true)
    const dag = createDagActivities({ ...f.deps, adapters: f.adapters() })
    const current = mock.method(Context, 'current', () => ({ info: { attempt: 2 }, heartbeat: () => {} }) as unknown as ReturnType<typeof Context.current>)
    try {
      assert.deepEqual(await dag.runDagAttempt({ taskId: 'tsk-lap-restart' }), { outcome: 'collected', taskId: 'tsk-lap-restart' })
    } finally {
      current.mock.restore()
    }
    assert.equal((await f.store.getTask('tsk-lap-restart'))!.result!.status, 'completed')
    assert.equal((await lines(f.lapCodex.launches)).length, 1)
    assert.equal((await lines(f.localCodex.launches)).length, 0)
  } finally {
    await f.cleanup()
  }
})

test('取消 Mission：已绑定 lap 的任务由 lap 的适配器确认取消，不交给本机 runner', async () => {
  const f = await setup([['tsk-lap-cancel', 'codex@lap']])
  await writeFile(f.lapCodex.hold, '')
  try {
    assert.equal((await f.acts.dispatchTask('tsk-lap-cancel')).dispatched, true)
    for (let i = 0; i < 300 && (await lines(f.lapCodex.launches)).length === 0; i += 1) await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(await f.acts.cancelMissionTasks({ missionId: 'mis-remote', reason: 'test' }), { canceled: ['tsk-lap-cancel'], unconfirmed: [] })
  } finally {
    await f.cleanup()
  }
})

test('同一 runner 注册两次（adapter_id 与 runner_id 都相同）仍拒绝', async () => {
  const f = await setup([])
  try {
    const [local] = f.adapters()
    const again = new RemoteRunnerAdapter({ authorization: remoteAuthorization(LOCAL), ...remoteKeys, baseUrl: 'http://127.0.0.1:1', runnerId: LOCAL, agentId: 'codex@again', workRoot: f.cm, capabilities: ['code.analyze'] })
    assert.throws(() => createActivities({ ...f.deps, adapters: [local!, again] }), /Adapter \/ Agent ID 重复/)
  } finally {
    await f.cleanup()
  }
})
