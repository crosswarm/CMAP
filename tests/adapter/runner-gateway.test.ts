/**
 * M04 出站网关端到端（同进程）：Worker 侧 GatewayRunnerAdapter + API 网关 + 出站模式 runner（假 codex）。
 * 判据只认账本状态、租约记录、假 codex 的执行次数与控制面复算的 sha256。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join } from 'node:path'

import { issueDispatchPermit, verifyDispatchPermit, type QuotaSnapshotV1, type RemoteRunnerDispatchV1, type TaskEnvelopeV1 } from '#domain-model'
import { gatewayCall, gatewayUpload } from '../../apps/runner/src/outbound.ts'
import { GATEWAY_ADAPTER_ID, gatewayLeaseId } from '../../adapters/runner-gateway/src/index.ts'
import { controlPlaneKey, gatewayRunnerRecord, startGatewayFixture } from './runner-gateway-fixture.ts'
import { ISSUER, bigArtifact, lines, sha256, trust } from './remote-runner-fixture.ts'

const issuePermitFor = (runnerId: string, envelope: TaskEnvelopeV1): string =>
  issueDispatchPermit({ privateKey: trust.privateKey, issuer: ISSUER, runnerId, adapterId: GATEWAY_ADAPTER_ID, envelope })

const until = async (ok: () => Promise<boolean>, label: string, ms = 10_000): Promise<void> => {
  for (const deadline = Date.now() + ms; !(await ok()); await new Promise((r) => setTimeout(r, 20))) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
  }
}

test('出站 runner 领取并完成：许可受众为所选 runner 与网关 Adapter，执行一次，产物由控制面复算后入账', async () => {
  const f = await startGatewayFixture()
  try {
    const lap = await f.startRunner('lap-gw')
    await until(async () => (await f.store.getGatewayRunner('lap-gw'))!.last_seen_at !== null, 'runner 上线')
    await f.addTask('tsk-gw-ok')
    assert.deepEqual(await f.acts.dispatchTask('tsk-gw-ok'), { dispatched: true, remoteTaskId: 'codex:tsk-gw-ok:1' })
    const task = (await f.store.getTask('tsk-gw-ok'))!
    assert.deepEqual([task.binding!.adapter, task.binding!.runner_id], [GATEWAY_ADAPTER_ID, 'lap-gw'])
    // 路由记录网关实际选中的 runner，不只是 Worker 自己的 runner_id
    const [routing] = (await f.store.listEvents(task.mission_id)).filter((e) => e.event_type === 'ROUTING_DECIDED').map((e) => e.payload as Record<string, unknown>)
    assert.deepEqual([routing!.runner_id, routing!.target_runner_id], ['crossmini', 'lap-gw'])
    const lease = (await f.store.getGatewayLease(gatewayLeaseId(task.binding!)))!
    // 许可绑定所选 runner 与网关 Adapter：换任一受众都验不过
    verifyDispatchPermit(lease.dispatch.permit, { publicKey: trust.publicKey, issuer: ISSUER, runnerId: 'lap-gw', adapterId: GATEWAY_ADAPTER_ID, envelope: task.envelope })
    assert.throws(() => verifyDispatchPermit(lease.dispatch.permit, { publicKey: trust.publicKey, issuer: ISSUER, runnerId: 'other', adapterId: GATEWAY_ADAPTER_ID, envelope: task.envelope }))

    const collected = await f.acts.collectTaskResult('tsk-gw-ok')
    assert.ok('passed' in collected && collected.passed, JSON.stringify(collected))
    const [artifact, ...rest] = await f.store.listArtifacts('tsk-gw-ok')
    assert.equal(rest.length, 0)
    assert.equal(artifact!.sha256, sha256('ok'))
    assert.equal(artifact!.provenance['runner_id'], 'lap-gw')
    await access(join(f.cm, 'tsk-gw-ok', artifact!.uri))
    assert.equal((await lines(f.codex.launches)).length, 1)
    assert.equal((await f.store.getGatewayLease(lease.lease_id))!.state, 'closed')
    lap.stop()
  } finally {
    await f.cleanup()
  }
})

test('dag/v1 attempt：派发后不在 Activity 里等（awaiting_report 带截止），回报落账后再进来即收取', async () => {
  const f = await startGatewayFixture()
  try {
    await f.startRunner('lap-gw')
    await until(async () => (await f.store.getGatewayRunner('lap-gw'))!.last_seen_at !== null, 'runner 上线')
    await writeFile(f.codex.hold, '')
    await f.addTask('tsk-gw-dag')
    const first = await f.runAttempt({ taskId: 'tsk-gw-dag' })
    assert.equal(first.outcome, 'awaiting_report')
    assert.ok(first.deadlineAt && Date.parse(first.deadlineAt) > Date.now())
    const again = await f.runAttempt({ taskId: 'tsk-gw-dag', deadlineAt: first.deadlineAt! })
    assert.equal(again.outcome, 'awaiting_report', '仍在执行：再进来也只回读一次就返回')
    await import('node:fs/promises').then((fs) => fs.rm(f.codex.hold))
    const binding = (await f.store.getTask('tsk-gw-dag'))!.binding!
    await until(async () => (await f.store.getGatewayLease(gatewayLeaseId(binding)))!.state === 'closed', '终态回报落账')
    assert.deepEqual(await f.runAttempt({ taskId: 'tsk-gw-dag', deadlineAt: first.deadlineAt! }), { outcome: 'collected', taskId: 'tsk-gw-dag' })
    assert.equal((await lines(f.codex.launches)).length, 1)
  } finally {
    await f.cleanup()
  }
})

test('执行中断开：租约过期判执行不确定（INPUT_REQUIRED、binding 保留），不改派不重跑，重连的 runner 也领不到它', async () => {
  const f = await startGatewayFixture({ leaseTtlMs: 300 })
  try {
    const lap = await f.startRunner('lap-gw')
    await until(async () => (await f.store.getGatewayRunner('lap-gw'))!.last_seen_at !== null, 'runner 上线')
    await writeFile(f.codex.hold, '')
    await f.addTask('tsk-gw-lost')
    await f.acts.dispatchTask('tsk-gw-lost')
    await until(async () => (await lines(f.codex.launches)).length === 1, 'codex 启动')
    lap.stop()
    await new Promise((r) => setTimeout(r, 600))
    const out = await f.acts.collectTaskResult('tsk-gw-lost')
    assert.deepEqual(out, { executionUncertain: { code: 'BINDING_NOT_FOUND', terminalObserved: false } })
    const task = (await f.store.getTask('tsk-gw-lost'))!
    assert.equal(task.state, 'INPUT_REQUIRED')
    assert.equal(task.binding!.runner_id, 'lap-gw')

    // 同一身份重新上线：过期租约不在队列里，不会被重新领取
    const back = await f.startRunner('lap-gw', { key: lap.key, register: false })
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(back.loop.held(), [])
    await import('node:fs/promises').then((fs) => fs.rm(f.codex.hold))
    await new Promise((r) => setTimeout(r, 200))
    assert.equal((await lines(f.codex.launches)).length, 1, '只执行一次')
    assert.deepEqual(await f.acts.collectTaskResult('tsk-gw-lost'), { executionUncertain: { code: 'BINDING_NOT_FOUND', terminalObserved: false } })
  } finally {
    await f.cleanup()
  }
})

test('许可受众不是本 runner：runner 执行前拒绝并回报 permit 错误，租约关闭，什么都不执行', async () => {
  const f = await startGatewayFixture()
  try {
    await f.startRunner('lap-gw')
    await f.addTask('tsk-gw-permit')
    const task = (await f.store.getTask('tsk-gw-permit'))!
    const dispatch: RemoteRunnerDispatchV1 = {
      schema: 'cmap/remote-runner/v1', kind: 'dispatch', runner_id: 'lap-gw', permit: issuePermitFor('someone-else', task.envelope),
      envelope: task.envelope, trace_id: 't', correlation_id: 'c', deadline_at: new Date(Date.now() + 60_000).toISOString(), inputs: [],
    }
    await f.store.enqueueGatewayLease({ lease_id: 'lse-permit', runner_id: 'lap-gw', task_id: task.id, remote_task_id: 'codex:tsk-gw-permit:1', dispatch, created_at: new Date().toISOString() })
    await until(async () => (await f.store.getGatewayLease('lse-permit'))!.state === 'closed', 'runner 回报拒绝')
    const lease = (await f.store.getGatewayLease('lse-permit'))!
    assert.deepEqual(lease.accepted, { schema: 'cmap/remote-runner/v1', kind: 'error', category: 'permit', code: 'CLAIM_MISMATCH', retryable: false })
    assert.equal((await lines(f.codex.launches)).length, 0)
  } finally {
    await f.cleanup()
  }
})

test('旧版 runner 内联产物仍被接受，但字节与哈希不符时控制面复算拒收（EVIDENCE_HASH_MISMATCH），不写 artifact 记录', async () => {
  const f = await startGatewayFixture()
  try {
    // 不起真实 runner：用已登记的身份手工回报一份「哈希写的是 ok、字节却是 tampered」的结果
    const { generateKeyPairSync } = await import('node:crypto')
    const key = generateKeyPairSync('ed25519')
    const { gatewayRunnerRecord } = await import('./runner-gateway-fixture.ts')
    await f.store.registerGatewayRunner(gatewayRunnerRecord('liar', key.publicKey, { last_seen_at: new Date().toISOString() }))
    await f.addTask('tsk-gw-liar')
    const client = { controlPlaneUrl: f.apiUrl, signingKey: key.privateKey, controlPlanePublicKey: controlPlaneKey.publicKey, runnerId: 'liar' }
    const dispatching = f.acts.dispatchTask('tsk-gw-liar')
    let claimed
    for (;;) {
      const { message } = await gatewayCall(client, '/v1/gateway/claim', { schema: 'cmap/runner-gateway/v1', kind: 'claim', runner_id: 'liar', wait_seconds: 1, held_leases: [] }, 5000)
      if (message.kind === 'claim_result' && message.assignment) { claimed = message.assignment; break }
    }
    const report = (body: object) => gatewayCall(client, '/v1/gateway/reports', { schema: 'cmap/runner-gateway/v1', kind: 'report', runner_id: 'liar', lease_id: claimed.lease.lease_id, body }, 5000)
    await report({ schema: 'cmap/remote-runner/v1', kind: 'dispatch_accepted', runner_id: 'liar', remote_task_id: 'codex:tsk-gw-liar:1' })
    await dispatching
    await report({ schema: 'cmap/remote-runner/v1', kind: 'status', remote_task_id: 'codex:tsk-gw-liar:1', status: 'completed', terminal_observed: true })
    await report({
      schema: 'cmap/remote-runner/v1', kind: 'result', remote_task_id: 'codex:tsk-gw-liar:1',
      result: {
        schema: 'cmap/task-result/v1', mission_id: 'mis-remote', task_id: 'tsk-gw-liar', attempt: 1, status: 'completed', summary: 'ok',
        criterion_results: [{ criterion_id: 'C1', actual: 'true', passed: true, evidence_artifact_ids: ['a1'] }],
        artifacts: [{ artifact_id: 'a1', role: 'report', uri: 'evidence/report.txt', media_type: 'text/plain', size_bytes: 2, sha256: sha256('ok') }],
      },
      artifacts: [{ uri: 'evidence/report.txt', content_base64: Buffer.from('tampered').toString('base64') }],
    })
    const collected = await f.acts.collectTaskResult('tsk-gw-liar')
    assert.ok('passed' in collected && !collected.passed)
    assert.match(collected.summary, /EVIDENCE_HASH_MISMATCH/)
    assert.deepEqual(await f.store.listArtifacts('tsk-gw-liar'), [])
  } finally {
    await f.cleanup()
  }
})

test('M09 大于 16MiB 的产物经出站网关流式上传：API 边收边算落内容寻址存储，回报只带元数据，Worker 复算后入账', async () => {
  const size = 17 * 1024 * 1024 + 3
  const big = bigArtifact(size)
  const f = await startGatewayFixture({ artifactBytes: size })
  try {
    await f.startRunner('lap-gw')
    await until(async () => (await f.store.getGatewayRunner('lap-gw'))!.last_seen_at !== null, 'runner 上线')
    await f.addTask('tsk-gw-big')
    await f.acts.dispatchTask('tsk-gw-big')
    const collected = await f.acts.collectTaskResult('tsk-gw-big')
    assert.ok('passed' in collected && collected.passed, JSON.stringify(collected))
    const [artifact] = await f.store.listArtifacts('tsk-gw-big')
    assert.deepEqual([artifact!.sha256, artifact!.size_bytes], [sha256(big), size])
    assert.equal(sha256(await readFile(join(f.cm, 'tsk-gw-big', artifact!.uri))), sha256(big))
    const h = sha256(big)
    const cas = join(f.cm, '.cas', 'sha256', h.slice(0, 2), h.slice(2, 4), h)
    assert.equal((await stat(cas)).mode & 0o777, 0o600)
    assert.equal(sha256(await readFile(cas)), h)
    // 账本里的结果回报不再夹带产物字节
    const lease = (await f.store.getGatewayLease(gatewayLeaseId((await f.store.getTask('tsk-gw-big'))!.binding!)))!
    assert.deepEqual((lease.outcome as { artifacts: unknown[] }).artifacts, [{ uri: 'evidence/report.txt', sha256: h, size_bytes: size }])
    assert.equal((await lines(f.codex.launches)).length, 1)
  } finally {
    await f.cleanup()
  }
})

test('M09 上传字节与声明的 sha256 不符：API 422 EVIDENCE_HASH_MISMATCH 且不落盘；他人的租约不能上传；结果引用未经核验上传的产物 → EVIDENCE_FILE_MISSING', async () => {
  const f = await startGatewayFixture()
  try {
    const { generateKeyPairSync } = await import('node:crypto')
    const { gatewayRunnerRecord } = await import('./runner-gateway-fixture.ts')
    const key = generateKeyPairSync('ed25519')
    const otherKey = generateKeyPairSync('ed25519')
    await f.store.registerGatewayRunner(gatewayRunnerRecord('liar', key.publicKey, { last_seen_at: new Date().toISOString() }))
    await f.store.registerGatewayRunner(gatewayRunnerRecord('other', otherKey.publicKey, { owner: 'someone-else' }))
    await f.addTask('tsk-gw-upload')
    const client = { controlPlaneUrl: f.apiUrl, signingKey: key.privateKey, controlPlanePublicKey: controlPlaneKey.publicKey, runnerId: 'liar' }
    const dispatching = f.acts.dispatchTask('tsk-gw-upload')
    let claimed
    for (;;) {
      const { message } = await gatewayCall(client, '/v1/gateway/claim', { schema: 'cmap/runner-gateway/v1', kind: 'claim', runner_id: 'liar', wait_seconds: 1, held_leases: [] }, 5000)
      if (message.kind === 'claim_result' && message.assignment) { claimed = message.assignment; break }
    }
    const leaseId = claimed.lease.lease_id
    const report = (body: object) => gatewayCall(client, '/v1/gateway/reports', { schema: 'cmap/runner-gateway/v1', kind: 'report', runner_id: 'liar', lease_id: leaseId, body }, 5000)
    await report({ schema: 'cmap/remote-runner/v1', kind: 'dispatch_accepted', runner_id: 'liar', remote_task_id: 'codex:tsk-gw-upload:1' })
    await dispatching

    const declared = { lease_id: leaseId, sha256: sha256('ok'), size_bytes: 2 }
    const tampered = await gatewayUpload(client, declared, Readable.from([Buffer.from('xx')]), 5000)
    assert.equal(tampered.status, 422)
    assert.deepEqual(tampered.message, { schema: 'cmap/runner-gateway/v1', kind: 'error', code: 'EVIDENCE_HASH_MISMATCH', retryable: false })
    const casFiles = async () => (await readdir(join(f.cm, '.cas'), { recursive: true, withFileTypes: true }).catch(() => []))
      .filter((d) => d.isFile()).map((d) => d.name)
    assert.deepEqual(await casFiles(), [])

    // 别的 runner 不能往这条租约里上传（即使字节正确）
    const foreign = await gatewayUpload({ ...client, signingKey: otherKey.privateKey, runnerId: 'other' }, declared, Readable.from([Buffer.from('ok')]), 5000)
    assert.deepEqual([foreign.status, (foreign.message as { code?: string }).code], [409, 'LEASE_UNKNOWN'])
    assert.deepEqual(await casFiles(), [])

    await report({ schema: 'cmap/remote-runner/v1', kind: 'status', remote_task_id: 'codex:tsk-gw-upload:1', status: 'completed', terminal_observed: true })
    await report({
      schema: 'cmap/remote-runner/v1', kind: 'result', remote_task_id: 'codex:tsk-gw-upload:1',
      result: {
        schema: 'cmap/task-result/v1', mission_id: 'mis-remote', task_id: 'tsk-gw-upload', attempt: 1, status: 'completed', summary: 'ok',
        criterion_results: [{ criterion_id: 'C1', actual: 'true', passed: true, evidence_artifact_ids: ['a1'] }],
        artifacts: [{ artifact_id: 'a1', role: 'report', uri: 'evidence/report.txt', media_type: 'text/plain', size_bytes: 2, sha256: sha256('ok') }],
      },
      artifacts: [{ uri: 'evidence/report.txt', sha256: sha256('ok'), size_bytes: 2 }],
    })
    const collected = await f.acts.collectTaskResult('tsk-gw-upload')
    assert.ok('passed' in collected && !collected.passed)
    assert.match(collected.summary, /EVIDENCE_FILE_MISSING/)
    assert.deepEqual(await f.store.listArtifacts('tsk-gw-upload'), [])
    await assert.rejects(access(join(f.cm, 'tsk-gw-upload', 'evidence/report.txt')))
  } finally {
    await f.cleanup()
  }
})

test('出站模式配置：公网只认 https（http 限回环）；控制面秘密出现在 runner 主机即拒绝启动；准入只取自登记记录', async () => {
  const { readOutboundRunnerConfig, enrolledRunnerEnv } = await import('../../apps/runner/src/outbound.ts')
  const base = { CMAP_RUNNER_KEY_FILE: '/x/runner.key', CMAP_PERMIT_PUBLIC_KEY_FILE: '/x/permit.pub', CMAP_CODEX_MODEL: 'm', CMAP_WORK_ROOT: '/x/work' }
  assert.equal(readOutboundRunnerConfig({ ...base, CMAP_CONTROL_PLANE_URL: 'https://cmap.spux.cn/' }).controlPlaneUrl, 'https://cmap.spux.cn')
  assert.equal(readOutboundRunnerConfig({ ...base, CMAP_CONTROL_PLANE_URL: 'http://127.0.0.1:8787' }).enrollmentFile, '/x/enrollment.json')
  assert.throws(() => readOutboundRunnerConfig({ ...base, CMAP_CONTROL_PLANE_URL: 'http://cmap.spux.cn' }), /https/)
  assert.throws(() => readOutboundRunnerConfig({ ...base, CMAP_CONTROL_PLANE_URL: 'https://cmap.spux.cn', CMAP_PERMIT_KEY_FILE: '/k' }), /CMAP_PERMIT_KEY_FILE/)
  assert.throws(() => readOutboundRunnerConfig({ ...base, CMAP_CONTROL_PLANE_URL: 'https://cmap.spux.cn', CMAP_DATABASE_URL: 'postgres://x' }), /CMAP_DATABASE_URL/)
  const { enrolledRecord, gatewayRunnerRecord } = await import('./runner-gateway-fixture.ts')
  const { generateKeyPairSync } = await import('node:crypto')
  const env = enrolledRunnerEnv({ RUNNER_ALLOWED_OWNERS: 'everyone', RUNNER_MAX_RISK: 'mutating' },
    enrolledRecord(gatewayRunnerRecord('lap-gw', generateKeyPairSync('ed25519').publicKey)))
  assert.deepEqual([env['RUNNER_ID'], env['RUNNER_ALLOWED_OWNERS'], env['RUNNER_MAX_RISK'], env['RUNNER_ALLOWED_TENANTS']], ['lap-gw', 'crosswarm', 'read-meta', 'team-ycc'])
})

test('M05 首次启动：runner 用一次性令牌持钥登记、写下登记记录（0600），之后只读记录；以登记身份领取并完成任务', async () => {
  const { loadOrEnroll } = await import('../../apps/runner/src/outbound.ts')
  const { stat } = await import('node:fs/promises')
  const { generateKeyPairSync } = await import('node:crypto')
  const { rawEd25519PublicKey } = await import('#domain-model')
  const f = await startGatewayFixture()
  try {
    const issued = await fetch(`${f.apiUrl}/v1/runner-enrollments`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: 'cmap/runner-enrollment/v1', kind: 'issue', owner: 'crosswarm', allowed_capabilities: ['code.analyze'], max_risk: 'read-meta', ttl_seconds: 600 }) })
    assert.equal(issued.status, 201)
    const { token } = await issued.json() as { token: string }
    const key = generateKeyPairSync('ed25519')
    const file = join(f.root, 'enrollment.json')
    const enrolled = await loadOrEnroll({ controlPlaneUrl: f.apiUrl, enrollmentFile: file, privateKey: key.privateKey, host: 'lap-host', token })
    assert.equal(enrolled.owner, 'crosswarm')
    assert.equal(enrolled.control_plane_public_key, rawEd25519PublicKey(controlPlaneKey.publicKey))
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.deepEqual(await loadOrEnroll({ controlPlaneUrl: f.apiUrl, enrollmentFile: file, privateKey: key.privateKey, host: 'lap-host' }), enrolled, '已登记就不再联网')
    await assert.rejects(loadOrEnroll({ controlPlaneUrl: f.apiUrl, enrollmentFile: join(f.root, 'again.json'), privateKey: generateKeyPairSync('ed25519').privateKey, host: 'x', token }), /ENROLLMENT_DENIED/, '令牌只能用一次')
    await assert.rejects(loadOrEnroll({ controlPlaneUrl: f.apiUrl, enrollmentFile: join(f.root, 'none.json'), privateKey: key.privateKey, host: 'x' }), /CMAP_RUNNER_ENROLL_TOKEN/)

    const runner = (await f.store.getGatewayRunner(enrolled.runner_id))!
    await f.startRunner(enrolled.runner_id, { key, register: false, overrides: runner })
    await until(async () => (await f.store.getGatewayRunner(enrolled.runner_id))!.last_seen_at !== null, 'runner 上线')
    await f.addTask('tsk-gw-enrolled')
    await f.acts.dispatchTask('tsk-gw-enrolled')
    assert.equal((await f.store.getTask('tsk-gw-enrolled'))!.binding!.runner_id, enrolled.runner_id)
    const collected = await f.acts.collectTaskResult('tsk-gw-enrolled')
    assert.ok('passed' in collected && collected.passed)
  } finally {
    await f.cleanup()
  }
})

test('登记记录绑定服务端 origin：登记时写入；换了 CMAP_CONTROL_PLANE_URL 即拒绝启动（指明两个 origin 与登记文件）；旧记录按当前 URL 补写', async () => {
  const { loadOrEnroll } = await import('../../apps/runner/src/outbound.ts')
  const { generateKeyPairSync } = await import('node:crypto')
  const f = await startGatewayFixture()
  try {
    const issued = await fetch(`${f.apiUrl}/v1/runner-enrollments`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: 'cmap/runner-enrollment/v1', kind: 'issue', owner: 'crosswarm', allowed_capabilities: ['code.analyze'], max_risk: 'read-meta', ttl_seconds: 600 }) })
    const { token } = await issued.json() as { token: string }
    const key = generateKeyPairSync('ed25519')
    const file = join(f.root, 'enrollment.json')
    const origin = new URL(f.apiUrl).origin
    const enrolled = await loadOrEnroll({ controlPlaneUrl: f.apiUrl, enrollmentFile: file, privateKey: key.privateKey, host: 'lap-host', token })
    assert.equal(enrolled.control_plane_origin, origin)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).control_plane_origin, origin)

    const other = 'https://other.example.test'
    await assert.rejects(
      loadOrEnroll({ controlPlaneUrl: `${other}/`, enrollmentFile: file, privateKey: key.privateKey, host: 'lap-host' }),
      (error: Error) => error.message.includes(origin) && error.message.includes(other) && error.message.includes(file) && /登记/.test(error.message),
    )

    // 旧记录（无该字段）：按当前 URL 补写，之后再换服务端同样拒绝
    const { control_plane_origin: _drop, ...legacy } = enrolled
    await writeFile(file, JSON.stringify(legacy), { mode: 0o600 })
    assert.equal((await loadOrEnroll({ controlPlaneUrl: f.apiUrl, enrollmentFile: file, privateKey: key.privateKey, host: 'lap-host' })).control_plane_origin, origin)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).control_plane_origin, origin)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    await assert.rejects(loadOrEnroll({ controlPlaneUrl: other, enrollmentFile: file, privateKey: key.privateKey, host: 'lap-host' }), /登记/)
  } finally {
    await f.cleanup()
  }
})

test('领取循环遇到 401 不再静默：打印明确的鉴权失败，同类错误只在首次与间隔后打印', async () => {
  const f = await startGatewayFixture()
  try {
    const logs: string[] = []
    // 未在控制面登记的 runner：每次领取都是同一个无签名 401
    const lap = await f.startRunner('lap-unknown', { register: false, log: (line) => logs.push(line), logIntervalMs: 3_600_000 })
    await until(async () => logs.length > 0, '打印鉴权失败')
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(logs.length, 1, `retryMs=50 下 400ms 内应只打印一次，实际：${JSON.stringify(logs)}`)
    assert.match(logs[0]!, /401/)
    assert.match(logs[0]!, /CMAP_CONTROL_PLANE_URL/)
    lap.stop()
  } finally {
    await f.cleanup()
  }
})

test('出站模式必须显式设置 CMAP_WORK_ROOT；工作目录标记所属服务端 origin，换服务端共用同一目录即拒绝启动', async () => {
  const { readOutboundRunnerConfig, claimWorkRoot } = await import('../../apps/runner/src/outbound.ts')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const base = { CMAP_CONTROL_PLANE_URL: 'https://a.example.test', CMAP_RUNNER_KEY_FILE: '/x/runner.key', CMAP_PERMIT_PUBLIC_KEY_FILE: '/x/permit.pub', CMAP_CODEX_MODEL: 'm' }
  assert.throws(() => readOutboundRunnerConfig(base), /CMAP_WORK_ROOT/)
  assert.throws(() => readOutboundRunnerConfig({ ...base, CMAP_WORK_ROOT: '  ' }), /CMAP_WORK_ROOT/)
  assert.equal(readOutboundRunnerConfig({ ...base, CMAP_WORK_ROOT: '/x/work' }).workRoot, '/x/work')

  const root = await mkdtemp(join(tmpdir(), 'cmap-workroot-'))
  try {
    const work = join(root, 'new', 'work')
    claimWorkRoot(work, 'https://a.example.test')
    assert.equal((await readFile(join(work, '.cmap-server-origin'), 'utf8')).trim(), 'https://a.example.test')
    claimWorkRoot(work, 'https://a.example.test')
    assert.throws(() => claimWorkRoot(work, 'https://b.example.test'),
      (error: Error) => error.message.includes('https://a.example.test') && error.message.includes('https://b.example.test') && error.message.includes(work))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('出站 runner 随领取上报额度：GatewayRunnerAdapter.health 返回在线 runner 的最新快照；读不到就是未知，不报错', async () => {
  const { generateKeyPairSync } = await import('node:crypto')
  const f = await startGatewayFixture()
  try {
    assert.equal((await f.gateway.health()).quota, undefined, '没有 runner 上报过：未知')
    const snapshot: QuotaSnapshotV1 = {
      schema: 'cmap/quota-snapshot/v1', provider: 'codex', account_ref: 'b'.repeat(64), ordinary_usage_allowed: true,
      observed_at: new Date().toISOString(), status: 'ok',
      windows: [{ kind: 'primary', used_percent: 12, window_minutes: 10080, resets_at: null }],
    }
    // 探针失败的 runner 照常领取，只是不上报
    const quiet = await f.startRunner('quiet-gw', { quota: () => Promise.reject(new Error('probe failed')) })
    await until(async () => (await f.store.getGatewayRunner('quiet-gw'))!.last_seen_at !== null, 'quiet 上线')
    assert.equal((await f.gateway.health()).quota, undefined)
    quiet.stop()

    await f.startRunner('lap-gw', { quota: async () => snapshot })
    await until(async () => (await f.gateway.health()).quota !== undefined, 'health 看到 runner 上报的额度')
    const health = await f.gateway.health()
    assert.deepEqual(health.quota, snapshot)
    assert.equal(health.state, 'healthy')

    // 同时有多份：优先取读到了的（ok）快照，未知的快照不遮住它
    const unknown: QuotaSnapshotV1 = { ...snapshot, account_ref: null, windows: [], ordinary_usage_allowed: null, status: 'unknown', observed_at: new Date(Date.now() + 5_000).toISOString() }
    await f.store.registerGatewayRunner(gatewayRunnerRecord('other-gw', generateKeyPairSync('ed25519').publicKey))
    await f.store.putGatewayRunnerQuota('other-gw', unknown)
    assert.deepEqual((await f.gateway.health()).quota, snapshot)
  } finally {
    await f.cleanup()
  }
})
