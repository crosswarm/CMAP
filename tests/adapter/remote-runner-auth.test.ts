/**
 * 远程 runner 应用层请求/响应认证（ADR-0006 Stage 3）：未签名、错签、过期、重放、受众不符的请求在每个端点都被同一个
 * 无细节的 401 拒绝且不执行；lap 的应答被篡改、剥签或换序时 CrossMini 拒收。真实 HTTP + 假 codex。
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { type RemoteTaskBinding } from '#domain-model'
import type { DispatchContext } from '#adapter-sdk'
import { RemoteRunnerAdapter } from '../../adapters/remote-runner/src/index.ts'
import {
  RUNNER_AUTH_HEADERS, RunnerAuthError, signRunnerRequest, signRunnerResponse, verifyRunnerRequest, verifyRunnerResponse,
} from '../../packages/domain-model/src/dispatch-permit.ts'
import {
  REMOTE_ADAPTER_ID, close, envelope, lapEnv, lapTrust, lines, makeFakeCodex, remoteAuthorization, remoteKeys, signer,
  startLap, startTamperProxy, trust,
} from './remote-runner-fixture.ts'

const UNAUTHORIZED = { schema: 'cmap/remote-runner/v1', kind: 'error', category: 'protocol', code: 'UNAUTHORIZED', retryable: false }
const TASK = 'tsk-auth'
const REMOTE_ID = `codex:${TASK}:1`
const binding: RemoteTaskBinding = { adapter: REMOTE_ADAPTER_ID, remote_task_id: REMOTE_ID, protocol: 'cmap-remote-runner', protocol_version: '1', runner_id: 'lap' }

const adapterFor = (url: string, cm: string, extra: Partial<ConstructorParameters<typeof RemoteRunnerAdapter>[0]> = {}) =>
  new RemoteRunnerAdapter({
    authorization: remoteAuthorization('lap'), ...remoteKeys, baseUrl: url, runnerId: 'lap', agentId: 'codex@lap', workRoot: cm,
    capabilities: ['code.analyze'], ...extra,
  })

const ctxFor = async (cm: string, taskId: string, token: string): Promise<DispatchContext> => {
  const worktree = join(cm, taskId)
  await mkdir(worktree, { recursive: true })
  return { token, runner_id: 'lap', trace_id: taskId, correlation_id: taskId, worktree, deadline_at: new Date(Date.now() + 30_000).toISOString(), beforeSend: async () => {} }
}

const waitTerminal = async (adapter: RemoteRunnerAdapter, b: RemoteTaskBinding) => {
  for (let i = 0; i < 300; i += 1) {
    if ((await adapter.getStatus(b)).terminal_observed) return
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.fail('remote task never reached terminal state')
}

const rejectsWith = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => (error as { code?: string }).code === code)
}

/** 一个正在执行的任务（hold 住）+ 第二个任务的派发体：任何一个被执行都会让 launches 增加。 */
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-remote-auth-'))
  const codex = await makeFakeCodex(root)
  const cm = join(root, 'crossmini')
  await mkdir(cm)
  await writeFile(codex.hold, '')
  const lap = await startLap({ env: lapEnv('lap', codex.bin), workRoot: join(root, 'lap') })
  const adapter = adapterFor(lap.url, cm)
  const e = envelope(TASK)
  await adapter.startTask(e, await ctxFor(cm, TASK, signer(e, { runnerId: 'lap', adapterId: REMOTE_ADAPTER_ID })))
  for (let i = 0; i < 200 && (await lines(codex.launches)).length === 0; i += 1) await new Promise((r) => setTimeout(r, 10))
  const e2 = envelope('tsk-auth-2')
  const dispatch2 = {
    schema: 'cmap/remote-runner/v1', kind: 'dispatch', runner_id: 'lap', permit: signer(e2, { runnerId: 'lap', adapterId: REMOTE_ADAPTER_ID }),
    envelope: e2, trace_id: 't', correlation_id: 'c', deadline_at: new Date(Date.now() + 30_000).toISOString(), inputs: [],
  }
  return { root, codex, cm, lap, adapter, dispatch2, cleanup: async () => {
      await close(lap.server)
      await rm(codex.hold, { force: true }) // 放行仍挂着的假 codex，等它们写完再删目录
      await new Promise((r) => setTimeout(r, 300))
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
  }
}

type Endpoint = { name: string; method: 'GET' | 'POST'; path: string; body?: unknown }
const endpoints = (dispatch2: unknown): Endpoint[] => [
  { name: 'health', method: 'GET', path: '/v1/health' },
  { name: 'dispatch', method: 'POST', path: '/v1/tasks', body: dispatch2 },
  { name: 'status', method: 'GET', path: `/v1/tasks/${encodeURIComponent(REMOTE_ID)}` },
  { name: 'result', method: 'GET', path: `/v1/tasks/${encodeURIComponent(REMOTE_ID)}/result` },
  { name: 'cancel', method: 'POST', path: `/v1/tasks/${encodeURIComponent(REMOTE_ID)}/cancel`, body: { schema: 'cmap/remote-runner/v1', kind: 'cancel', remote_task_id: REMOTE_ID, reason: 'AUTH_TEST' } },
]

const raw = (url: string, ep: Endpoint, headers: Record<string, string>, body = ep.body === undefined ? undefined : JSON.stringify(ep.body)) =>
  fetch(new URL(ep.path, url), {
    method: ep.method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body }),
  })

const expectUnauthorized = async (res: Response, what: string) => {
  assert.equal(res.status, 401, what)
  assert.equal(res.headers.get('x-cmap-signature'), null, `${what}: 401 不签名`)
  assert.deepEqual(await res.json(), UNAUTHORIZED, what)
}

test('每个端点：未签名 / 错签 / 签名后改请求 / 过期 / 未来 / 受众不符 / 重放 均 401 且同一个无细节的体，不执行', async () => {
  const f = await setup()
  try {
    const stranger = generateKeyPairSync('ed25519')
    for (const ep of endpoints(f.dispatch2)) {
      const sign = (over: Partial<Parameters<typeof signRunnerRequest>[0]> = {}) => signRunnerRequest({
        privateKey: trust.privateKey, method: ep.method, target: ep.path, audience: 'lap',
        ...(ep.body === undefined ? {} : { body: JSON.stringify(ep.body) }), ...over,
      })
      const cases: [string, Response][] = [
        ['未签名', await raw(f.lap.url, ep, {})],
        ['别的密钥签名', await raw(f.lap.url, ep, sign({ privateKey: stranger.privateKey }))],
        ['lap 自己的密钥签名', await raw(f.lap.url, ep, sign({ privateKey: lapTrust.privateKey }))],
        ['签给另一条路径', await raw(f.lap.url, ep, sign({ target: `${ep.path}x` }))],
        ['签给另一个方法', await raw(f.lap.url, ep, sign({ method: ep.method === 'GET' ? 'POST' : 'GET' }))],
        ...(ep.method === 'POST' ? [['签名后体被改', await raw(f.lap.url, ep, sign(), JSON.stringify({ tampered: true }))] as [string, Response]] : [['签名后加查询串', await raw(f.lap.url, { ...ep, path: `${ep.path}?x=1` }, sign())] as [string, Response]]),
        ['过期 5 秒', await raw(f.lap.url, ep, sign({ nowMs: Date.now() - 5_000 }))],
        ['未来 5 秒', await raw(f.lap.url, ep, sign({ nowMs: Date.now() + 5_000 }))],
        ['受众是另一个 runner', await raw(f.lap.url, ep, sign({ audience: 'lap-2' }))],
        ['缺少签名头', await raw(f.lap.url, ep, Object.fromEntries(Object.entries(sign()).filter(([k]) => k !== 'x-cmap-signature')))],
        ['签名被截断', await raw(f.lap.url, ep, { ...sign(), 'x-cmap-signature': 'AAAA' })],
      ]
      for (const [what, res] of cases) await expectUnauthorized(res, `${ep.name}/${what}`)

      // 重放：同一份签名头第二次使用被拒（第一次通过认证，不论后续业务结果）
      const headers = sign()
      const first = await raw(f.lap.url, ep, headers)
      assert.notEqual(first.status, 401, `${ep.name}/首次`)
      assert.ok(first.headers.get('x-cmap-signature'), `${ep.name}: 通过认证的应答要签名`)
      await first.arrayBuffer()
      await expectUnauthorized(await raw(f.lap.url, ep, headers), `${ep.name}/重放`)
    }
    // 业务效果：只有「重放」用例的首次合法请求会产生副作用——dispatch(tsk-auth-2) 一次、cancel 一次。其余都没有执行。
    for (let i = 0; i < 200 && (await lines(f.codex.launches)).length < 2; i += 1) await new Promise((r) => setTimeout(r, 10))
    await new Promise((r) => setTimeout(r, 200)) // 给任何本不该发生的多余执行留出现身时间
    assert.equal((await lines(f.codex.launches)).length, 2, '被拒请求不执行；仅两个合法首次请求（原任务 + 合法 dispatch）')
  } finally {
    await f.cleanup()
  }
})

test('被拒的取消请求不取消任务；被拒的派发不启动任务；合法请求不受影响', async () => {
  const f = await setup()
  try {
    const [, dispatch, , , cancel] = endpoints(f.dispatch2) as [Endpoint, Endpoint, Endpoint, Endpoint, Endpoint]
    await expectUnauthorized(await raw(f.lap.url, cancel, {}), 'cancel 未签名')
    await expectUnauthorized(await raw(f.lap.url, dispatch, {}), 'dispatch 未签名')
    assert.equal((await f.adapter.getStatus(binding)).status, 'running')
    assert.equal((await lines(f.codex.launches)).length, 1)
    await rm(f.codex.hold)
    await waitTerminal(f.adapter, binding)
    assert.equal((await f.adapter.collectResult(binding)).status, 'completed') // 没被取消
    assert.equal((await f.adapter.health()).state, 'healthy')
  } finally {
    await f.cleanup()
  }
})

test('401 不泄露原因：所有失败形态的状态码、头与体逐字节一致', async () => {
  const f = await setup()
  try {
    const ep = endpoints(f.dispatch2)[2]!
    const good = (over: Partial<Parameters<typeof signRunnerRequest>[0]> = {}) => signRunnerRequest({ privateKey: trust.privateKey, method: 'GET', target: ep.path, audience: 'lap', ...over })
    const seen = new Set<string>()
    for (const headers of [{}, good({ nowMs: 1 }), good({ audience: 'x' }), good({ privateKey: lapTrust.privateKey }), { ...good(), 'x-cmap-nonce': 'short' }]) {
      const res = await raw(f.lap.url, ep, headers)
      seen.add(`${res.status}|${res.headers.get('content-type')}|${res.headers.get('x-cmap-signature')}|${await res.text()}`)
    }
    assert.equal(seen.size, 1)
  } finally {
    await f.cleanup()
  }
})

test('响应被篡改 / 剥签：CrossMini 拒收；结果端点按 EVIDENCE_HASH_MISMATCH 处理且不落盘', async () => {
  const f = await setup()
  const proxies: Awaited<ReturnType<typeof startTamperProxy>>[] = []
  const via = async (opts: Parameters<typeof startTamperProxy>[1]) => {
    const proxy = await startTamperProxy(f.lap.url, opts)
    proxies.push(proxy)
    return adapterFor(proxy.url, f.cm)
  }
  try {
    await rm(f.codex.hold)
    await waitTerminal(f.adapter, binding)

    // 改动 status 体（lap 签的是原体）→ 签名对不上
    const flipped = await via({ mutate: (path, text) => path.endsWith(REMOTE_ID.replace(/:/g, '%3A')) ? text.replace('"completed"', '"running"') : text })
    await rejectsWith(flipped.getStatus(binding), 'REMOTE_RESPONSE_SIGNATURE_INVALID')

    // 剥掉签名头：health 不可用，status 拒收
    const stripped = await via({ mutate: (_path, text) => text, dropSignature: true })
    const health = await stripped.health()
    assert.deepEqual([health.state, health.detail], ['unavailable', 'REMOTE_RESPONSE_SIGNATURE_INVALID'])
    await rejectsWith(stripped.getStatus(binding), 'REMOTE_RESPONSE_SIGNATURE_INVALID')

    // 结果里的产物字节被换（签名没重算）→ EVIDENCE_HASH_MISMATCH，CrossMini 工作区不出现产物
    const tampered = await via({})
    await rejectsWith(tampered.collectResult(binding), 'EVIDENCE_HASH_MISMATCH')
    await assert.rejects(readFile(join(f.cm, TASK, 'evidence/report.txt')))

    // 即便 lap 自己对错误字节重新签名，CrossMini 仍复算哈希：EVIDENCE_HASH_MISMATCH，落盘文件被删除
    const resigned = await via({ resign: true })
    await rejectsWith(resigned.collectResult(binding), 'EVIDENCE_HASH_MISMATCH')
    await assert.rejects(readFile(join(f.cm, TASK, 'evidence/report.txt')))

    // 未改动的直连通路不受影响
    assert.equal((await f.adapter.collectResult(binding)).artifacts.length, 1)
    assert.equal(await readFile(join(f.cm, TASK, 'evidence/report.txt'), 'utf8'), 'ok')
  } finally {
    for (const proxy of proxies) await close(proxy.server)
    await f.cleanup()
  }
})

test('固定的 lap 公钥不符 → 所有应答都不采信；请求认证被拒时状态走离线宽限而不是报错', async () => {
  const f = await setup()
  try {
    const wrongPin = adapterFor(f.lap.url, f.cm, { runnerPublicKey: generateKeyPairSync('ed25519').publicKey })
    assert.equal((await wrongPin.health()).detail, 'REMOTE_RESPONSE_SIGNATURE_INVALID')
    await rejectsWith(wrongPin.getStatus(binding), 'REMOTE_RESPONSE_SIGNATURE_INVALID')

    // CrossMini 用了别的签名私钥：lap 全部 401；状态查询按失联处理（宽限内仍视为执行中），不是协议错误
    let now = 1_000_000
    const wrongKey = adapterFor(f.lap.url, f.cm, { signingKey: generateKeyPairSync('ed25519').privateKey, offlineGraceMs: 600_000, now: () => now })
    assert.equal((await wrongKey.health()).detail, 'REMOTE_UNAUTHORIZED')
    assert.equal((await wrongKey.getStatus(binding)).status, 'running')
    now += 600_000
    await rejectsWith(wrongKey.getStatus(binding), 'BINDING_NOT_FOUND')
    assert.equal((await lines(f.codex.launches)).length, 1)
  } finally {
    await f.cleanup()
  }
})

test('应答绑定所答请求：旧应答的签名不能用在新请求上；签名域与许可互不通用', () => {
  const body = Buffer.from('{"a":1}')
  const signature = signRunnerResponse({ privateKey: lapTrust.privateKey, audience: 'lap', requestNonce: 'n'.repeat(24), status: 200, body })
  const check = (over: Partial<Parameters<typeof verifyRunnerResponse>[0]> = {}) => verifyRunnerResponse({
    publicKey: lapTrust.publicKey, audience: 'lap', requestNonce: 'n'.repeat(24), status: 200, body, signature, ...over,
  })
  assert.equal(check(), undefined)
  for (const over of [{ requestNonce: 'm'.repeat(24) }, { status: 409 }, { audience: 'lap-2' }, { body: Buffer.from('{"a":2}') }, { publicKey: trust.publicKey }, { signature: null }]) {
    assert.throws(() => check(over), RunnerAuthError, JSON.stringify(Object.keys(over)))
  }
  // 请求签名不能当应答签名，反之亦然
  const headers = signRunnerRequest({ privateKey: lapTrust.privateKey, method: 'GET', target: '/v1/health', audience: 'lap' })
  assert.throws(() => check({ signature: headers[RUNNER_AUTH_HEADERS.signature] }), RunnerAuthError)
  assert.throws(() => verifyRunnerRequest({ publicKey: lapTrust.publicKey, method: 'GET', target: '/v1/health', audience: 'lap', headers: { ...headers, 'x-cmap-signature': signature } }), RunnerAuthError)
  // 字段里带换行会让签名串歧义：拒绝签发
  assert.throws(() => signRunnerRequest({ privateKey: trust.privateKey, method: 'GET', target: '/v1/health\nPOST', audience: 'lap' }), RunnerAuthError)
})

test('适配器构造 fail closed：没有请求签名密钥或没有固定的 lap 公钥就拒绝', () => {
  const saved = { a: process.env['CMAP_PERMIT_KEY_FILE'], b: process.env['CMAP_REMOTE_RUNNER_PUBKEY_FILE'] }
  delete process.env['CMAP_PERMIT_KEY_FILE']
  delete process.env['CMAP_REMOTE_RUNNER_PUBKEY_FILE']
  try {
    const base = { authorization: remoteAuthorization('lap'), baseUrl: 'http://127.0.0.1:1', runnerId: 'lap', agentId: 'codex@lap', workRoot: '/x', capabilities: ['code.analyze'] }
    assert.throws(() => new RemoteRunnerAdapter(base), /CMAP_PERMIT_KEY_FILE is required/)
    assert.throws(() => new RemoteRunnerAdapter({ ...base, signingKey: trust.privateKey }), /CMAP_REMOTE_RUNNER_PUBKEY_FILE is required/)
    assert.doesNotThrow(() => new RemoteRunnerAdapter({ ...base, ...remoteKeys }))
  } finally {
    if (saved.a !== undefined) process.env['CMAP_PERMIT_KEY_FILE'] = saved.a
    if (saved.b !== undefined) process.env['CMAP_REMOTE_RUNNER_PUBKEY_FILE'] = saved.b
  }
})
