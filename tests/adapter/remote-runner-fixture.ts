/**
 * 远程 runner 测试夹具：本机用独立端口模拟 lap 守护进程（ADR-0006），假 codex 只记执行次数与 -m 值。
 * 本文件不以 .test.ts 结尾，避免被测试运行器当作独立用例执行。
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { issueDispatchPermit, verifyDispatchPermit, DispatchPermitError, type TaskEnvelopeV1 } from '#domain-model'
import type { AdapterAuthorization, DispatchPermitSigner } from '#adapter-sdk'
import { REMOTE_ADAPTER_ID } from '../../adapters/remote-runner/src/index.ts'
import { signRunnerRequest, signRunnerResponse } from '../../packages/domain-model/src/dispatch-permit.ts'
import { createRunnerDaemon } from '../../apps/runner/src/server.ts'

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')

export const trust = generateKeyPairSync('ed25519')
/** lap 的响应签名密钥；CrossMini 侧固定其公钥。 */
export const lapTrust = generateKeyPairSync('ed25519')
/** RemoteRunnerAdapter 的两把密钥：请求签名用控制面许可私钥，响应验签用固定的 lap 公钥。 */
export const remoteKeys = { signingKey: trust.privateKey, runnerPublicKey: lapTrust.publicKey }
export const ISSUER = 'cmap:local-control-plane'

export const signer: DispatchPermitSigner = (envelope, { runnerId, adapterId }) =>
  issueDispatchPermit({ privateKey: trust.privateKey, issuer: ISSUER, runnerId, adapterId, envelope })

/** 控制面侧自检：与 Worker 一致，只接受受众为目标远程 runner 的许可。 */
export const remoteAuthorization = (runnerId: string): AdapterAuthorization => ({
  mode: 'managed',
  verifier: (token, envelope, adapterId, contextRunner) => {
    if (contextRunner !== runnerId) throw new DispatchPermitError('CLAIM_MISMATCH')
    return verifyDispatchPermit(token, { publicKey: trust.publicKey, issuer: ISSUER, runnerId, adapterId, envelope })
  },
})

export const envelope = (taskId: string, policy: Partial<TaskEnvelopeV1['execution_policy']> = {}): TaskEnvelopeV1 => ({
  schema: 'cmap/task-envelope/v1',
  identity: { mission_id: 'mis-remote', task_id: taskId, idempotency_key: `mis-remote:${taskId}`, revision: 1, tenant: 'team-ycc', owner: 'crosswarm' },
  classification: { task_type: 'inspect', requested_capability: 'code.analyze', risk_level: 'read-meta' },
  goal: { statement: 'remote fixture', success_definition: [{ criterion_id: 'C1', metric: 'done', operator: 'eq', expected: true }] },
  environment: {},
  execution_policy: { timeout_seconds: 30, max_attempts: 1, ...policy },
  permissions: { forbidden: [] },
  evidence_requirements: { required_artifact_roles: ['report'] },
  output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
})

/** 假 codex：hold 文件存在时一直挂着（模拟长任务），每次真正执行追加一行 pid，-m 的值写入 models。 */
export const makeFakeCodex = async (dir: string): Promise<{ bin: string; launches: string; models: string; hold: string }> => {
  const bin = join(dir, 'fake-codex.cjs')
  const launches = join(dir, 'launches')
  const models = join(dir, 'models')
  const hold = join(dir, 'hold')
  await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
if (process.argv.includes('--version')) { console.log('fake-codex 0.0.0'); process.exit(0) }
if (!process.env.CMAP_TASK_ID) process.exit(0)
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(launches)}, String(process.pid) + '\\n')
fs.appendFileSync(${JSON.stringify(models)}, String(args[args.indexOf('-m') + 1]) + '\\n')
const workDir = args[args.indexOf('-C') + 1]
const out = args[args.indexOf('-o') + 1]
const finish = () => {
  fs.mkdirSync(path.join(workDir, 'evidence'), { recursive: true })
  fs.writeFileSync(path.join(workDir, 'evidence/report.txt'), 'ok')
  fs.writeFileSync(out, JSON.stringify({
    status: 'completed', summary: 'ok',
    criterion_results: [{ criterion_id: 'C1', actual: 'true', passed: true, evidence_artifact_ids: ['a1'] }],
    artifacts: [{ artifact_id: 'a1', role: 'report', uri: 'evidence/report.txt', media_type: 'text/plain', size_bytes: 2, sha256: ${JSON.stringify(sha256('ok'))} }],
    findings: [], error: null,
  }))
}
const wait = () => fs.existsSync(${JSON.stringify(hold)}) ? setTimeout(wait, 20) : finish()
wait()
`)
  await chmod(bin, 0o755)
  return { bin, launches, models, hold }
}

export const lines = async (path: string): Promise<string[]> => {
  try {
    await stat(path)
  } catch {
    return []
  }
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean)
}

export const lapEnv = (runnerId: string, bin: string, overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  RUNNER_ID: runnerId,
  RUNNER_TENANT: 'team-ycc',
  RUNNER_HOST: 'lap-host',
  RUNNER_ALLOWED_TENANTS: 'team-ycc',
  RUNNER_ALLOWED_OWNERS: 'crosswarm',
  RUNNER_ALLOWED_CAPABILITIES: 'code.analyze',
  RUNNER_MAX_RISK: 'read-meta',
  CMAP_CODEX_MODEL: 'gpt-test-lap',
  CODEX_BIN: bin,
  ...overrides,
})

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

export const close = async (server: Server): Promise<void> => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

/** 本机端口上的模拟 lap。clockOffsetMs 模拟两机时钟偏差。 */
export const startLap = async (opts: { env: NodeJS.ProcessEnv; workRoot: string; clockOffsetMs?: number }) => {
  const daemon = await createRunnerDaemon({
    env: opts.env,
    publicKey: trust.publicKey,
    signingKey: lapTrust.privateKey,
    issuer: ISSUER,
    workRoot: opts.workRoot,
    ...(opts.clockOffsetMs ? { nowMs: () => Date.now() + opts.clockOffsetMs! } : {}),
  })
  const url = await listen(daemon.server)
  return { ...daemon, url }
}

/** 已关闭端口：连接立即被拒，模拟 lap 不在线。 */
export const deadUrl = async (): Promise<string> => {
  const server = createServer()
  const url = await listen(server)
  await close(server)
  return url
}

/** 直接对守护进程发一个带（可被篡改的）请求签名的原始请求：测试认证与许可各自的拒绝路径。 */
export const signedFetch = (url: string, init: {
  method?: 'GET' | 'POST'
  path: string
  body?: unknown
  audience: string
  privateKey?: KeyObject
  nowMs?: number
}): Promise<Response> => {
  const method = init.method ?? 'GET'
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body)
  const auth = signRunnerRequest({
    privateKey: init.privateKey ?? trust.privateKey, method, target: init.path, audience: init.audience,
    ...(payload === undefined ? {} : { body: payload }), ...(init.nowMs === undefined ? {} : { nowMs: init.nowMs }),
  })
  return fetch(new URL(init.path, url), {
    method,
    headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...auth },
    ...(payload === undefined ? {} : { body: payload }),
  })
}

const tamperArtifacts = (path: string, text: string): string => {
  if (!path.endsWith('/result')) return text
  const body = JSON.parse(text)
  for (const art of body.artifacts ?? []) art.content_base64 = Buffer.from('tampered').toString('base64')
  return JSON.stringify(body)
}

/**
 * 中间人：默认把结果里的产物字节换掉、保留 lap 自报哈希。请求头（含 CrossMini 的请求签名）原样转发；
 * 应答的 lap 签名默认原样带回——于是被改动的应答签名对不上。resign 模拟「lap 自己签了一份错误字节」，
 * dropSignature 模拟签名被剥掉。
 */
export const startTamperProxy = async (
  target: string,
  opts: { mutate?: (path: string, text: string) => string; resign?: boolean; dropSignature?: boolean } = {},
): Promise<{ url: string; server: Server }> => {
  const mutate = opts.mutate ?? tamperArtifacts
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const forwarded = Object.fromEntries(Object.entries(req.headers).filter(([k, v]) => k.startsWith('x-cmap-') && typeof v === 'string')) as Record<string, string>
    const upstream = await fetch(new URL(req.url!, target), {
      method: req.method!,
      headers: { ...(req.method === 'POST' ? { 'content-type': 'application/json' } : {}), ...forwarded },
      ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
    })
    const original = await upstream.text()
    const text = upstream.status === 200 ? mutate(req.url!, original) : original
    let signature = upstream.headers.get('x-cmap-signature')
    if (opts.resign) {
      signature = signRunnerResponse({
        privateKey: lapTrust.privateKey, audience: forwarded['x-cmap-audience']!, requestNonce: forwarded['x-cmap-nonce']!,
        status: upstream.status, body: Buffer.from(text, 'utf8'),
      })
    }
    res.writeHead(upstream.status, { 'content-type': 'application/json', ...(signature && !opts.dropSignature ? { 'x-cmap-signature': signature } : {}) }).end(text)
  })
  return { url: await listen(server), server }
}

export { REMOTE_ADAPTER_ID }
