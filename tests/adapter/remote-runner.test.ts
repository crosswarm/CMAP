/**
 * 远程 runner 薄协议单测（ADR-0006）：真实 HTTP、两个本机端口模拟 lap 与另一台 runner，假 codex 计数。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
  ISSUER, REMOTE_ADAPTER_ID, bigArtifact, close, deadUrl, envelope, lapEnv, lines, makeFakeCodex, remoteAuthorization, remoteKeys, sha256, signedFetch, signer, startLap, startTamperProxy, trust,
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
    const health = await adapter.health()
    assert.equal(health.state, 'healthy')
    // lap 在已签名的 health 应答里公布自己的准入白名单，供派发前路由判断
    assert.deepEqual(health.admission, { allowed_tenants: ['team-ycc'], allowed_owners: ['crosswarm'], allowed_capabilities: ['code.analyze'], max_risk: 'read-meta' })
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

test('M09 大于 16MiB 的产物：结果只带元数据，CrossMini 流式拉取、边收边算落内容寻址存储，再复算入任务目录', async () => {
  const size = 17 * 1024 * 1024 + 3
  const big = bigArtifact(size)
  const root = await mkdtemp(join(tmpdir(), 'cmap-remote-big-'))
  const codex = await makeFakeCodex(root, { artifactBytes: size })
  const cm = join(root, 'crossmini')
  await mkdir(cm)
  const lap = await startLap({ env: lapEnv('lap', codex.bin), workRoot: join(root, 'lap') })
  try {
    const adapter = adapterFor(lap.url, cm)
    const e = envelope('tsk-unit-big')
    const binding = await adapter.startTask(e, await ctxFor(cm, 'tsk-unit-big', signer(e, { runnerId: 'lap', adapterId: REMOTE_ADAPTER_ID })))
    await waitTerminal(adapter, binding)

    // 结果应答本身不再内联产物字节
    const raw = await signedFetch(lap.url, { path: `/v1/tasks/${encodeURIComponent(binding.remote_task_id)}/result`, audience: 'lap' })
    const body = await raw.json() as { artifacts: Record<string, unknown>[] }
    assert.deepEqual(body.artifacts, [{ uri: 'evidence/report.txt', sha256: sha256(big), size_bytes: size }])

    const result = await adapter.collectResult(binding)
    assert.deepEqual([result.artifacts[0]!.sha256, result.artifacts[0]!.size_bytes], [sha256(big), size])
    assert.equal(sha256(await readFile(join(cm, 'tsk-unit-big', 'evidence/report.txt'))), sha256(big))
    const h = sha256(big)
    const cas = join(cm, '.cas', 'sha256', h.slice(0, 2), h.slice(2, 4), h)
    assert.equal(sha256(await readFile(cas)), h)
    assert.equal((await stat(cas)).mode & 0o777, 0o600)
    assert.deepEqual(await readdir(join(cm, '.cas', 'tmp')), [])
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

test('lap 在已签名 health 里附带额度快照（ADR-0009），CrossMini 原样取得；不带快照的旧 lap 仍健康', async () => {
  const { root, codex, cm } = await setup()
  const quota = {
    schema: 'cmap/quota-snapshot/v1', provider: 'codex', account_ref: 'e'.repeat(64),
    windows: [{ kind: 'primary', used_percent: 84, window_minutes: 10080, resets_at: '2026-10-29T00:00:00.000Z' }],
    ordinary_usage_allowed: true, observed_at: '2026-10-23T00:00:00.000Z', status: 'ok',
  } as const
  const lap = await startLap({ env: lapEnv('lap', codex.bin), workRoot: join(root, 'lap'), quota: async () => structuredClone(quota) as any })
  const old = await startLap({ env: lapEnv('lap', codex.bin), workRoot: join(root, 'old') })
  const garbled = await startTamperProxy(lap.url, { resign: true, mutate: (path, text) => path === '/v1/health' ? JSON.stringify({ ...JSON.parse(text), quota: { ...quota, account_ref: 'raw-id' } }) : text })
  try {
    const health = await adapterFor(lap.url, cm).health()
    assert.equal(health.state, 'healthy')
    assert.deepEqual(health.quota, quota)
    const legacy = await adapterFor(old.url, cm).health()
    assert.equal(legacy.state, 'healthy')
    assert.equal(legacy.quota, undefined)
    // 快照不合契约（例如带原始账号 id）：整条应答不合 remote-runner.v1，按不可用处理
    assert.equal((await adapterFor(garbled.url, cm).health()).state, 'unavailable')
  } finally {
    await close(garbled.server)
    await close(lap.server)
    await close(old.server)
    await rm(root, { recursive: true, force: true })
  }
})

test('lap 上 Codex 触顶：QUOTA_EXHAUSTED 经协议原样回到 CrossMini（ADR-0009 §3），不带 stderr', async () => {
  const { root, cm } = await setup()
  const bin = join(root, 'quota-codex.cjs')
  await writeFile(bin, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('fake'); process.exit(0) }
process.stderr.write('ERROR: You’ve hit your usage limit. Try again in 3 days.\\n')
process.exit(1)
`, { mode: 0o755 })
  const lap = await startLap({ env: lapEnv('lap', bin), workRoot: join(root, 'lap') })
  try {
    const adapter = adapterFor(lap.url, cm)
    const e = envelope('tsk-unit-quota')
    const binding = await adapter.startTask(e, await ctxFor(cm, 'tsk-unit-quota', signer(e, { runnerId: 'lap', adapterId: REMOTE_ADAPTER_ID })))
    await waitTerminal(adapter, binding)
    await assert.rejects(adapter.collectResult(binding), (error: unknown) =>
      error instanceof AdapterError && error.code === 'QUOTA_EXHAUSTED' && !error.retryable && !error.message.includes('usage limit'))
  } finally {
    await close(lap.server)
    await rm(root, { recursive: true, force: true })
  }
})

test('health 应答缺准入白名单（旧版 lap）即使 lap 自己签名也判 unavailable，不退回静态能力声明', async () => {
  const { root, codex, cm } = await setup()
  const lap = await startLap({ env: lapEnv('lap', codex.bin), workRoot: join(root, 'lap') })
  const stripAdmission = (path: string, text: string): string => {
    if (path !== '/v1/health') return text
    const { admission: _drop, ...rest } = JSON.parse(text)
    return JSON.stringify(rest)
  }
  const proxy = await startTamperProxy(lap.url, { mutate: stripAdmission, resign: true })
  try {
    const health = await adapterFor(proxy.url, cm).health()
    assert.equal(health.state, 'unavailable')
    assert.equal(health.admission, undefined)
  } finally {
    await close(proxy.server)
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

test('有效宽限 = min(配置宽限, 首次失联时距等待截止剩余时间的一半)：先于任务超时判执行不确定，判定后保持', async () => {
  const cm = await mkdtemp(join(tmpdir(), 'cmap-remote-grace-deadline-'))
  try {
    let now = 1_000_000
    const adapter = adapterFor(await deadUrl(), cm, { offlineGraceMs: 600_000, now: () => now })
    const binding: RemoteTaskBinding = { adapter: REMOTE_ADAPTER_ID, remote_task_id: 'codex:tsk-grace-deadline:1', protocol: 'cmap-remote-runner', protocol_version: '1', runner_id: 'lap' }
    // dag/v1 固定 300 秒任务超时：配置的 600 秒宽限到不了，有效宽限取剩余 300 秒的一半
    const observation = { deadline_at: new Date(now + 300_000).toISOString() }
    assert.equal((await adapter.getStatus(binding, observation)).status, 'running')
    now += 149_999
    assert.equal((await adapter.getStatus(binding, observation)).status, 'running')
    now += 1
    await rejectsWith(adapter.getStatus(binding, observation), AdapterError, 'BINDING_NOT_FOUND')
    // 判定后保持：之后换了更晚截止的观察者（例如收结果 Activity）也不会退回“执行中”
    await rejectsWith(adapter.getStatus(binding, { deadline_at: new Date(now + 3_600_000).toISOString() }), AdapterError, 'BINDING_NOT_FOUND')
    await rejectsWith(adapter.getStatus(binding), AdapterError, 'BINDING_NOT_FOUND')

    // 配置宽限更短时仍以配置为准
    const short = adapterFor(await deadUrl(), cm, { offlineGraceMs: 30_000, now: () => now })
    const other = { ...binding, remote_task_id: 'codex:tsk-grace-short:1' }
    assert.equal((await short.getStatus(other, { deadline_at: new Date(now + 300_000).toISOString() })).status, 'running')
    now += 30_000
    await rejectsWith(short.getStatus(other, { deadline_at: new Date(now + 270_000).toISOString() }), AdapterError, 'BINDING_NOT_FOUND')
  } finally {
    await rm(cm, { recursive: true, force: true })
  }
})

test('状态查询挂起（网络分区、lap 休眠）按探测超时计为失联，不等 30 秒请求超时', async () => {
  const cm = await mkdtemp(join(tmpdir(), 'cmap-remote-status-hang-'))
  const hang = createServer(() => { /* 永不响应 */ })
  await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r))
  try {
    const adapter = adapterFor(`http://127.0.0.1:${(hang.address() as AddressInfo).port}`, cm, { healthTimeoutMs: 100 })
    const binding: RemoteTaskBinding = { adapter: REMOTE_ADAPTER_ID, remote_task_id: 'codex:tsk-status-hang:1', protocol: 'cmap-remote-runner', protocol_version: '1', runner_id: 'lap' }
    const started = Date.now()
    const status = await adapter.getStatus(binding)
    assert.deepEqual([status.status, status.detail], ['running', 'REMOTE_UNREACHABLE'])
    assert.ok(Date.now() - started < 2_000)
  } finally {
    await close(hang)
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
