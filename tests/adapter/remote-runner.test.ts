/**
 * 远程 runner 薄协议单测（ADR-0006）：真实 HTTP、两个本机端口模拟 lap 与另一台 runner，假 codex 计数。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DispatchPermitError, RunnerAdmissionError, issueDispatchPermit, type RemoteTaskBinding } from '#domain-model'
import { AdapterError, type DispatchContext } from '#adapter-sdk'
import { RemoteRunnerAdapter } from '../../adapters/remote-runner/src/index.ts'
import { readRunnerDaemonConfig } from '../../apps/runner/src/server.ts'
import {
  ISSUER, REMOTE_ADAPTER_ID, close, deadUrl, envelope, lapEnv, lines, makeFakeCodex, remoteAuthorization, remoteKeys, sha256, signedFetch, signer, startLap, trust,
} from './remote-runner-fixture.ts'

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-remote-unit-'))
  const codex = await makeFakeCodex(root)
  const cm = join(root, 'crossmini')
  await mkdir(cm)
  return { root, codex, cm }
}

const adapterFor = (url: string, cm: string, extra: Partial<ConstructorParameters<typeof RemoteRunnerAdapter>[0]> = {}) =>
  new RemoteRunnerAdapter({
    authorization: remoteAuthorization(extra.runnerId ?? 'lap'), ...remoteKeys,
    baseUrl: url, runnerId: 'lap', agentId: 'codex@lap', workRoot: cm, capabilities: ['code.analyze'],
    ...extra,
  })

const ctxFor = async (cm: string, taskId: string, token: string): Promise<DispatchContext> => {
  const worktree = join(cm, taskId)
  await mkdir(worktree, { recursive: true })
  return {
    token, runner_id: 'lap', trace_id: taskId, correlation_id: taskId, worktree,
    deadline_at: new Date(Date.now() + 30_000).toISOString(), beforeSend: async () => {},
  }
}

const waitTerminal = async (adapter: RemoteRunnerAdapter, binding: RemoteTaskBinding) => {
  for (let i = 0; i < 300; i += 1) {
    if ((await adapter.getStatus(binding)).terminal_observed) return
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.fail('remote task never reached terminal state')
}

const rejectsWith = async (promise: Promise<unknown>, type: new (...a: never[]) => Error, code: string) => {
  await assert.rejects(promise, (error: unknown) => error instanceof type && (error as { code?: string }).code === code)
}

test('lap 验签后执行一次，显式 -m；CrossMini 拉回产物并独立复算哈希；同 runner 重放不二次执行', async () => {
  const { root, codex, cm } = await setup()
  const lap = await startLap({ env: lapEnv('lap', codex.bin), workRoot: join(root, 'lap') })
  try {
    const adapter = adapterFor(lap.url, cm)
    assert.equal((await adapter.health()).state, 'healthy')
    const e = envelope('tsk-unit-ok')
    const token = signer(e, { runnerId: 'lap', adapterId: REMOTE_ADAPTER_ID })
    const binding = await adapter.startTask(e, await ctxFor(cm, 'tsk-unit-ok', token))
    assert.deepEqual(binding, { adapter: REMOTE_ADAPTER_ID, remote_task_id: 'codex:tsk-unit-ok:1', protocol: 'cmap-remote-runner', protocol_version: '1', runner_id: 'lap' })
    await waitTerminal(adapter, binding)
    const result = await adapter.collectResult(binding)
    assert.equal(result.status, 'completed')
    assert.equal(result.artifacts[0]!.sha256, sha256('ok'))
    assert.equal(await readFile(join(cm, 'tsk-unit-ok', 'evidence/report.txt'), 'utf8'), 'ok')
    assert.deepEqual(await lines(codex.models), ['gpt-test-lap'])

    assert.deepEqual(await adapter.startTask(e, await ctxFor(cm, 'tsk-unit-ok', token)), binding)
    assert.equal((await lines(codex.launches)).length, 1)
  } finally {
    await close(lap.server)
    await rm(root, { recursive: true, force: true })
  }
})

test('许可拿到别的 runner 重放 → 请求受众不符先被拒；许可自身受众不符 → CLAIM_MISMATCH；过期 → EXPIRED；时钟超窗 → 请求被拒；均执行 0 次', async () => {
  const { root, codex, cm } = await setup()
  const other = await startLap({ env: lapEnv('lap-2', codex.bin), workRoot: join(root, 'lap-2') })
  const skewed = await startLap({ env: lapEnv('lap', codex.bin), workRoot: join(root, 'lap'), clockOffsetMs: 63_000 })
  try {
    const e = envelope('tsk-unit-deny')
    const token = signer(e, { runnerId: 'lap', adapterId: REMOTE_ADAPTER_ID })
    assert.equal((await adapterFor(other.url, cm).health()).state, 'unavailable') // 请求受众是 lap，lap-2 拒绝
    // 受众为 lap 的请求被投到 lap-2：请求认证先拒绝（落 PERMIT_INVALID 同一路径），什么都不执行
    await rejectsWith(adapterFor(other.url, cm).startTask(e, await ctxFor(cm, 'tsk-unit-deny', token)), DispatchPermitError, 'BAD_SIGNATURE')
    // lap 时钟比请求时间戳快 63 秒：超出 2 秒窗口，请求被拒
    await rejectsWith(adapterFor(skewed.url, cm).startTask(e, await ctxFor(cm, 'tsk-unit-deny', token)), DispatchPermitError, 'BAD_SIGNATURE')

    // 请求签名正确（受众 lap-2）时，才轮到许可自己的检查：已过期的许可 → EXPIRED
    const expired = issueDispatchPermit({ privateKey: trust.privateKey, issuer: ISSUER, runnerId: 'lap-2', adapterId: REMOTE_ADAPTER_ID, envelope: e, nowMs: Date.now() - 120_000 })
    const dispatch = (permit: string) => ({ schema: 'cmap/remote-runner/v1', kind: 'dispatch', runner_id: 'lap-2', permit, envelope: e, trace_id: 't', correlation_id: 'c', deadline_at: 'd', inputs: [] })
    const res = await signedFetch(other.url, { method: 'POST', path: '/v1/tasks', body: dispatch(expired), audience: 'lap-2' })
    assert.equal(res.status, 403)
    assert.deepEqual(await res.json(), { schema: 'cmap/remote-runner/v1', kind: 'error', category: 'permit', code: 'EXPIRED', retryable: false })
    // 许可本身的受众是 lap：改写消息里的 runner_id 也没用
    const relabeled = await signedFetch(other.url, { method: 'POST', path: '/v1/tasks', body: dispatch(token), audience: 'lap-2' })
    assert.equal(((await relabeled.json()) as { code: string }).code, 'CLAIM_MISMATCH')
    assert.equal((await lines(codex.launches)).length, 0)
  } finally {
    await close(other.server)
    await close(skewed.server)
    await rm(root, { recursive: true, force: true })
  }
})

test('冻结输入（Memross 快照）随派发下发并在 lap 复核；本地被改动的输入按 INPUT_INVALID 拒绝且不发送', async () => {
  const { root, codex, cm } = await setup()
  const lap = await startLap({ env: lapEnv('lap', codex.bin), workRoot: join(root, 'lap') })
  try {
    const bucket = 'b'.repeat(64)
    const uri = `inputs/memory/${bucket}/payload`
    const withInput = (taskId: string) => ({
      ...envelope(taskId),
      inputs: { artifact_refs: [{ artifact_id: 'art_mem_1', role: 'memory_context', uri, sha256: sha256('memo') }] },
    })
    const ok = withInput('tsk-unit-input')
    const ctx = await ctxFor(cm, 'tsk-unit-input', signer(ok, { runnerId: 'lap', adapterId: REMOTE_ADAPTER_ID }))
    await mkdir(join(ctx.worktree!, 'inputs/memory', bucket), { recursive: true })
    await writeFile(join(ctx.worktree!, uri), 'memo')
    await adapterFor(lap.url, cm).startTask(ok, ctx)
    assert.equal(await readFile(join(root, 'lap', 'tsk-unit-input', uri), 'utf8'), 'memo')

    const bad = withInput('tsk-unit-input-bad')
    const badCtx = await ctxFor(cm, 'tsk-unit-input-bad', signer(bad, { runnerId: 'lap', adapterId: REMOTE_ADAPTER_ID }))
    await mkdir(join(badCtx.worktree!, 'inputs/memory', bucket), { recursive: true })
    await writeFile(join(badCtx.worktree!, uri), 'changed')
    let sent = false
    await rejectsWith(adapterFor(lap.url, cm).startTask(bad, { ...badCtx, beforeSend: async () => { sent = true } }), RunnerAdmissionError, 'INPUT_INVALID')
    assert.equal(sent, false)
    await waitTerminal(adapterFor(lap.url, cm), { adapter: REMOTE_ADAPTER_ID, remote_task_id: 'codex:tsk-unit-input:1', protocol: 'cmap-remote-runner', protocol_version: '1', runner_id: 'lap' })
    assert.equal((await lines(codex.launches)).length, 1)
  } finally {
    await close(lap.server)
    await rm(root, { recursive: true, force: true })
  }
})

test('DAG 父节点产物（inputs/<node_id>/…）随派发下发并在 lap 原路径落盘复核（C1 子节点在 lap）', async () => {
  const { root, codex, cm } = await setup()
  const lap = await startLap({ env: lapEnv('lap', codex.bin), workRoot: join(root, 'lap') })
  try {
    const bucket = 'c'.repeat(64)
    const uri = `inputs/left/${bucket}/payload`
    const e = { ...envelope('tsk-unit-dag-input'), inputs: { artifact_refs: [{ artifact_id: 'art_left_report', role: 'report', uri, sha256: sha256('{"value":17}') }] } }
    const ctx = await ctxFor(cm, 'tsk-unit-dag-input', signer(e, { runnerId: 'lap', adapterId: REMOTE_ADAPTER_ID }))
    await mkdir(join(ctx.worktree!, 'inputs/left', bucket), { recursive: true })
    await writeFile(join(ctx.worktree!, uri), '{"value":17}')
    await adapterFor(lap.url, cm).startTask(e, ctx)
    assert.equal(await readFile(join(root, 'lap', 'tsk-unit-dag-input', uri), 'utf8'), '{"value":17}')
    await waitTerminal(adapterFor(lap.url, cm), { adapter: REMOTE_ADAPTER_ID, remote_task_id: 'codex:tsk-unit-dag-input:1', protocol: 'cmap-remote-runner', protocol_version: '1', runner_id: 'lap' })
    assert.equal((await lines(codex.launches)).length, 1)
  } finally {
    await close(lap.server)
    await rm(root, { recursive: true, force: true })
  }
})

test('lap 自有准入白名单拒绝 owner → OWNER_DENIED，执行 0 次', async () => {
  const { root, codex, cm } = await setup()
  const lap = await startLap({ env: lapEnv('lap', codex.bin, { RUNNER_ALLOWED_OWNERS: 'someone-else' }), workRoot: join(root, 'lap') })
  try {
    const e = envelope('tsk-unit-owner')
    const token = signer(e, { runnerId: 'lap', adapterId: REMOTE_ADAPTER_ID })
    await rejectsWith(adapterFor(lap.url, cm).startTask(e, await ctxFor(cm, 'tsk-unit-owner', token)), RunnerAdmissionError, 'OWNER_DENIED')
    assert.equal((await lines(codex.launches)).length, 0)
  } finally {
    await close(lap.server)
    await rm(root, { recursive: true, force: true })
  }
})

test('健康探测：不在线或超时都判 unavailable，不抛错', async () => {
  const cm = await mkdtemp(join(tmpdir(), 'cmap-remote-health-'))
  const hang = createServer(() => { /* 永不响应 */ })
  await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r))
  try {
    assert.equal((await adapterFor(await deadUrl(), cm).health()).state, 'unavailable')
    const started = Date.now()
    const slow = adapterFor(`http://127.0.0.1:${(hang.address() as AddressInfo).port}`, cm, { healthTimeoutMs: 100 })
    assert.equal((await slow.health()).state, 'unavailable')
    assert.ok(Date.now() - started < 2_000)
  } finally {
    await close(hang)
    await rm(cm, { recursive: true, force: true })
  }
})

test('失联在宽限内仍视为执行中，超过宽限报 BINDING_NOT_FOUND（执行不确定），不重跑', async () => {
  const cm = await mkdtemp(join(tmpdir(), 'cmap-remote-grace-'))
  try {
    let now = 1_000_000
    const adapter = adapterFor(await deadUrl(), cm, { offlineGraceMs: 600_000, now: () => now })
    const binding: RemoteTaskBinding = { adapter: REMOTE_ADAPTER_ID, remote_task_id: 'codex:tsk-grace:1', protocol: 'cmap-remote-runner', protocol_version: '1', runner_id: 'lap' }
    assert.equal((await adapter.getStatus(binding)).terminal_observed, false)
    now += 599_999
    assert.equal((await adapter.getStatus(binding)).status, 'running')
    now += 1
    await rejectsWith(adapter.getStatus(binding), AdapterError, 'BINDING_NOT_FOUND')
    await rejectsWith(adapter.getStatus({ ...binding, runner_id: 'lap-2' }), AdapterError, 'BINDING_INVALID')
  } finally {
    await rm(cm, { recursive: true, force: true })
  }
})

test('守护进程配置：必须显式非通配监听地址、显式模型、固定公钥；拒绝持有控制面秘密', () => {
  const base = { CMAP_RUNNER_LISTEN_HOST: '100.64.0.2', CMAP_PERMIT_PUBLIC_KEY_FILE: '/k.pub', CMAP_RUNNER_KEY_FILE: '/runner.key', CMAP_CODEX_MODEL: 'gpt-x' }
  const config = readRunnerDaemonConfig(base)
  assert.equal(config.port, 8790)
  assert.equal(config.listenHost, '100.64.0.2')
  assert.equal(config.codexModel, 'gpt-x')
  for (const bad of [
    { ...base, CMAP_RUNNER_LISTEN_HOST: '0.0.0.0' },
    { ...base, CMAP_RUNNER_LISTEN_HOST: '::' },
    { ...base, CMAP_RUNNER_LISTEN_HOST: '' },
    { ...base, CMAP_CODEX_MODEL: '' },
    { ...base, CMAP_PERMIT_PUBLIC_KEY_FILE: undefined },
    { ...base, CMAP_RUNNER_KEY_FILE: undefined },
    { ...base, CMAP_DATABASE_URL: 'postgres://x' },
    { ...base, MEMROSS_TOKEN: 'x' },
    { ...base, CMAP_PERMIT_KEY_FILE: '/k' },
    { ...base, CMAP_RUNNER_PORT: '99999' },
  ]) assert.throws(() => readRunnerDaemonConfig(bad), RangeError, JSON.stringify(bad))
})
