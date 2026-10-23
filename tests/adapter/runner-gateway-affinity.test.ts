/**
 * M06 owner 亲和（ADR-0008 §5）：任务只派给 owner 本人登记的 runner（owner 与 tenant 都必须一致），跨人共享默认禁止。
 * 三道闸：路由只挑本人的 runner；派发前 Adapter 复核；runner 自己的准入白名单只放行登记的 owner。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'

import { MemoryStore, issueDispatchPermit, type RemoteRunnerDispatchV1, type TaskEnvelopeV1 } from '#domain-model'
import { GATEWAY_ADAPTER_ID, GatewayRunnerAdapter } from '../../adapters/runner-gateway/src/index.ts'
import { gatewayAuthorization, gatewayRunnerRecord, startGatewayFixture } from './runner-gateway-fixture.ts'
import { ISSUER, envelope, lines, signer, trust } from './remote-runner-fixture.ts'

const online = () => ({ last_seen_at: new Date().toISOString() })
const owned = (taskId: string, owner: string, tenant = 'team-ycc'): TaskEnvelopeV1 => {
  const e = envelope(taskId, { preferred_agent: 'codex@gateway' })
  return { ...e, identity: { ...e.identity, mission_id: `mis-${owner}`, owner, tenant } }
}
const until = async (ok: () => Promise<boolean>, label: string): Promise<void> => {
  for (const deadline = Date.now() + 10_000; !(await ok()); await new Promise((r) => setTimeout(r, 20))) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
  }
}

test('路由只挑 owner 本人的 runner：别人的 runner 再新、再空闲也不选；只有别人的就记 owner_mismatch', async () => {
  const store = new MemoryStore()
  const adapter = new GatewayRunnerAdapter({ authorization: gatewayAuthorization, store, agentId: 'codex@gateway', workRoot: '/nonexistent', capabilities: ['code.analyze'] })
  await store.registerGatewayRunner(gatewayRunnerRecord('bob-1', generateKeyPairSync('ed25519').publicKey, { owner: 'bob', ...online() }))
  assert.deepEqual(await adapter.runnerFor(owned('t1', 'alice')), { reason: 'owner_mismatch' })
  await store.registerGatewayRunner(gatewayRunnerRecord('alice-other-tenant', generateKeyPairSync('ed25519').publicKey, { owner: 'alice', tenant: 'team-other', ...online() }))
  assert.deepEqual(await adapter.runnerFor(owned('t1', 'alice')), { reason: 'owner_mismatch' }, '同名 owner 在别的租户也不算')
  await store.registerGatewayRunner(gatewayRunnerRecord('alice-1', generateKeyPairSync('ed25519').publicKey, { owner: 'alice', last_seen_at: new Date(Date.now() - 30_000).toISOString() }))
  assert.deepEqual(await adapter.runnerFor(owned('t1', 'alice')), { runnerId: 'alice-1' })
  assert.deepEqual(await adapter.runnerFor(owned('t2', 'bob')), { runnerId: 'bob-1' })
  assert.deepEqual(await adapter.runnerFor(owned('t3', 'carol')), { reason: 'owner_mismatch' })
})

test('派发链路：别人的 runner 在线时，test 的任务路由跳过它（Worker 本机准入放行 test，所以拒绝来自路由的 owner 亲和）并记 owner_mismatch，不入队', async () => {
  const f = await startGatewayFixture()
  try {
    const bob = await f.startRunner('bob-1', { owner: 'bob' })
    await until(async () => (await f.store.getGatewayRunner('bob-1'))!.last_seen_at !== null, 'bob 的 runner 上线')
    await f.addTask('tsk-alice', owned('tsk-alice', 'test'))
    await assert.rejects(f.acts.dispatchTask('tsk-alice'), /没有可用 Adapter/)
    const [decision] = (await f.store.listEvents('mis-test')).filter((e) => e.event_type === 'ROUTING_DECIDED').map((e) => e.payload as Record<string, any>)
    assert.deepEqual(decision!.candidates.map((c: any) => [c.agent_id, c.verdict, c.reason]), [['codex@gateway', 'skipped', 'owner_mismatch']])
    assert.equal((await f.store.getTask('tsk-alice'))!.binding, null)
    assert.deepEqual(bob.loop.held(), [])
    assert.equal((await lines(f.codex.launches)).length, 0)
  } finally {
    await f.cleanup()
  }
})

test('派发前复核：即使路由给出别人的 runner，Adapter 也以 OWNER_DENIED 拒绝且不入队', async () => {
  const store = new MemoryStore()
  const adapter = new GatewayRunnerAdapter({ authorization: gatewayAuthorization, store, agentId: 'codex@gateway', workRoot: '/nonexistent', capabilities: ['code.analyze'] })
  await store.registerGatewayRunner(gatewayRunnerRecord('bob-1', generateKeyPairSync('ed25519').publicKey, { owner: 'bob', ...online() }))
  const e = owned('tsk-x', 'alice')
  const token = signer(e, { runnerId: 'bob-1', adapterId: GATEWAY_ADAPTER_ID })
  await assert.rejects(adapter.startTask(e, {
    token, runner_id: 'bob-1', trace_id: 't', correlation_id: 'c', deadline_at: new Date(Date.now() + 60_000).toISOString(), beforeSend: async () => {},
  }), (err: { code?: string }) => err.code === 'OWNER_DENIED')
  assert.equal(await store.claimGatewayLease('bob-1', new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()), null)
})

test('runner 侧纵深：许可有效、受众正确，但信封 owner 不是登记的 owner，runner 执行前以 OWNER_DENIED 拒绝', async () => {
  const f = await startGatewayFixture()
  try {
    await f.startRunner('bob-1', { owner: 'bob' })
    const e = owned('tsk-y', 'alice')
    await f.addTask('tsk-y', e)
    const dispatch: RemoteRunnerDispatchV1 = {
      schema: 'cmap/remote-runner/v1', kind: 'dispatch', runner_id: 'bob-1',
      permit: issueDispatchPermit({ privateKey: trust.privateKey, issuer: ISSUER, runnerId: 'bob-1', adapterId: GATEWAY_ADAPTER_ID, envelope: e }),
      envelope: e, trace_id: 't', correlation_id: 'c', deadline_at: new Date(Date.now() + 60_000).toISOString(), inputs: [],
    }
    await f.store.enqueueGatewayLease({ lease_id: 'lse-y', runner_id: 'bob-1', task_id: 'tsk-y', remote_task_id: 'codex:tsk-y:1', dispatch, created_at: new Date().toISOString() })
    await until(async () => (await f.store.getGatewayLease('lse-y'))!.state === 'closed', 'runner 拒绝')
    assert.deepEqual((await f.store.getGatewayLease('lse-y'))!.accepted, { schema: 'cmap/remote-runner/v1', kind: 'error', category: 'admission', code: 'OWNER_DENIED', retryable: false })
    assert.equal((await lines(f.codex.launches)).length, 0)
  } finally {
    await f.cleanup()
  }
})
