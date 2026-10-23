/**
 * lap runner 守护进程（ADR-0006）：只接受 CrossMini 发起的 HTTP 请求，契约见 schemas/remote-runner.v1.schema.json。
 *
 * 请求认证（先于一切路由与读体）：每个请求（含 health）须带 CrossMini 签名头——方法、路径、体 sha256、时间戳（偏差 ≤ 2 秒）、
 * nonce（窗口内单次）、受众 runner_id；任何一项不过一律同一个无细节的 401，不执行任何动作。
 * 其余响应由本机密钥签名（绑定所答请求的 nonce），CrossMini 固定本机公钥验签。
 *
 * 派发顺序：协议校验 → 固定公钥验签（受众 runner_id + remote-runner-adapter，偏差 ≤ 2 秒）
 * → 本机准入白名单 → 落地并复核已冻结输入 → 复用 CodexAdapter（运行记录、绝不重跑）执行。
 * 不接入 Temporal / PostgreSQL，不持有签名私钥、Memross 令牌或数据库地址；不写账本。
 * 响应不含提供方 stderr、提示词或路径；错误只给 category/code/retryable。
 */
import type { KeyObject } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DispatchPermitError, RunnerAdmissionError, assertRunnerAdmission, verifyDispatchPermit,
  type QuotaSnapshotV1, type RemoteTaskBinding, type RunnerAdmissionSubject, type RunnerDescriptor, type TaskEnvelopeV1, type RemoteRunnerDispatchV1,
} from '#domain-model'
import { AdapterError } from '#adapter-sdk'
import { CodexAdapter } from '../../../adapters/codex-adapter/src/index.ts'
import { REMOTE_ADAPTER_ID, validateRemoteMessage } from '../../../adapters/remote-runner/src/index.ts'
import { readVerifiedArtifact } from '../../../packages/adapter-sdk/src/structured-output.ts'
import { existingChildDir, publishInput, safeChildDir, safeMkdir } from '../../../workflows/artifact-files.ts'
import { buildRunnerDescriptor } from '../../worker/src/runner-config.ts'
import {
  RUNNER_AUTH_HEADERS, RUNNER_AUTH_MAX_SKEW_MS, runnerBodySha256, signRunnerResponse, verifyRunnerRequest,
} from '../../../packages/domain-model/src/dispatch-permit.ts'

const SCHEMA = 'cmap/remote-runner/v1'
const MAX_BODY_BYTES = 64 * 1024 * 1024
const REMOTE_TASK_ID = /^codex:([A-Za-z0-9][A-Za-z0-9._:-]{0,127}):([1-9][0-9]{0,15})$/
/** 控制面专属配置出现在 runner 主机上即拒绝启动：lap 不得持有这些秘密或连接信息。 */
const FORBIDDEN_ENV = ['CMAP_DATABASE_URL', 'MEMROSS_URL', 'MEMROSS_TOKEN', 'CMAP_PERMIT_KEY_FILE', 'TEMPORAL_ADDRESS']
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '*'])

export const readRunnerDaemonConfig = (env: NodeJS.ProcessEnv) => {
  for (const key of FORBIDDEN_ENV) if (env[key]) throw new RangeError(`${key} must not be set on the runner host (ADR-0006)`)
  const required = (key: string): string => {
    const value = env[key]?.trim()
    if (!value) throw new RangeError(`${key} is required`)
    return value
  }
  const listenHost = required('CMAP_RUNNER_LISTEN_HOST')
  if (WILDCARD_HOSTS.has(listenHost)) throw new RangeError('CMAP_RUNNER_LISTEN_HOST must be the Tailscale address, not a wildcard')
  const port = Number(env['CMAP_RUNNER_PORT'] ?? 8790)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('CMAP_RUNNER_PORT is invalid')
  return {
    listenHost,
    port,
    publicKeyFile: required('CMAP_PERMIT_PUBLIC_KEY_FILE'),
    /** 本机响应签名私钥（首次启动生成 0600）；CrossMini 以 CMAP_REMOTE_RUNNER_PUBKEY_FILE 固定其公钥。 */
    signingKeyFile: required('CMAP_RUNNER_KEY_FILE'),
    issuer: env['CMAP_PERMIT_ISSUER']?.trim() || 'cmap:local-control-plane',
    codexModel: required('CMAP_CODEX_MODEL'),
    workRoot: env['CMAP_WORK_ROOT']?.trim() || undefined,
  }
}

class ProtocolFault extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}

const errorBody = (category: 'permit' | 'admission' | 'adapter' | 'protocol', code: string, retryable = false) =>
  ({ schema: SCHEMA, kind: 'error', category, code, retryable })

const toReply = (error: unknown): [number, object] => {
  if (error instanceof ProtocolFault) return [error.status, errorBody('protocol', error.code)]
  if (error instanceof DispatchPermitError) return [403, errorBody('permit', error.code)]
  if (error instanceof RunnerAdmissionError) return [403, errorBody('admission', error.code)]
  if (error instanceof AdapterError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) {
    return [error.code === 'BINDING_NOT_FOUND' ? 404 : 409, errorBody('adapter', error.code, error.retryable)]
  }
  return [500, errorBody('protocol', 'INTERNAL')]
}

/** 认证失败的唯一对外形态：固定 401、固定体、不签名，不区分是哪一项没过。 */
const UNAUTHORIZED_BODY = JSON.stringify(errorBody('protocol', 'UNAUTHORIZED'))
const sendUnauthorized = (res: ServerResponse): void => {
  res.writeHead(401, { 'content-type': 'application/json', connection: 'close' }).end(UNAUTHORIZED_BODY)
}

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new ProtocolFault(413, 'BODY_TOO_LARGE')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

const parseJson = (raw: Buffer): unknown => {
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new ProtocolFault(400, 'MALFORMED_REQUEST')
  }
}

/**
 * nonce 窗口缓存：时间戳只容忍 ±2 秒，所以一个已用过的 nonce 只需保留到窗口结束（2×偏差 + 余量）。
 * ponytail: 内存缓存，守护进程重启后窗口内（≤ 约 4 秒）理论上可重放一个已见过的请求；时间戳窗口限定了这个缺口。
 * 需要彻底消除再把 nonce 落盘。容量满时丢最旧项；只有通过验签的请求才会入缓存，未认证流量填不满它。
 */
const NONCE_RETENTION_MS = 2 * RUNNER_AUTH_MAX_SKEW_MS + 1000
const NONCE_CAPACITY = 4096
const createNonceCache = (now: () => number) => {
  const seen = new Map<string, number>()
  return (nonce: string): boolean => {
    const t = now()
    for (const [key, expires] of seen) {
      if (expires > t && seen.size < NONCE_CAPACITY) break
      seen.delete(key)
    }
    if (seen.has(nonce)) return false
    seen.set(nonce, t + NONCE_RETENTION_MS)
    return true
  }
}

/** 信封已由许可哈希绑定到控制面签发的版本，身份字段可作准入依据。缺 tenant/owner 即拒绝。 */
const admissionSubject = (e: TaskEnvelopeV1): RunnerAdmissionSubject => ({
  mission_id: e.identity.mission_id,
  task_id: e.identity.task_id,
  tenant: e.identity.tenant ?? '',
  owner: e.identity.owner ?? '',
  capability: e.classification.requested_capability,
  risk: e.classification.risk_level,
  ...(e.execution_policy.affinity?.host !== undefined ? { affinity_host: e.execution_policy.affinity.host } : {}),
})

/** 输入必须与信封声明逐一对应、哈希一致；落盘复用 publishInput（已存在且字节不同即拒绝）。 */
const stageInputs = async (child: string, envelope: TaskEnvelopeV1, inputs: RemoteRunnerDispatchV1['inputs']): Promise<void> => {
  const refs = (envelope.inputs?.artifact_refs ?? []).filter((ref) => ref.uri !== undefined)
  if (refs.length !== inputs.length) throw new RunnerAdmissionError('INPUT_INVALID')
  for (const ref of refs) {
    const input = inputs.find((candidate) => candidate.uri === ref.uri)
    if (!input || typeof ref.sha256 !== 'string' || input.sha256 !== ref.sha256.toLowerCase()) throw new RunnerAdmissionError('INPUT_INVALID')
    try {
      const [root, kind, bucket] = input.uri.split('/') as [string, string, string]
      await publishInput(await safeMkdir(child, [root, kind, bucket]), Buffer.from(input.content_base64, 'base64'))
      await readVerifiedArtifact(child, { uri: input.uri, role: ref.role, sha256: input.sha256 })
    } catch {
      throw new RunnerAdmissionError('INPUT_INVALID')
    }
  }
}

export interface RunnerDaemonOptions {
  readonly env: NodeJS.ProcessEnv
  /** 固定的 CrossMini 公钥（配置文件，不走网络发现）。 */
  readonly publicKey: KeyObject
  readonly issuer: string
  readonly workRoot: string
  /** 本机响应签名私钥（loadOrCreatePermitKey 生成的 Ed25519）；公钥由 CrossMini 固定。 */
  readonly signingKey: KeyObject
  /** 测试注入时钟偏差；生产用本机时钟。 */
  readonly nowMs?: () => number
  /** 本机 Codex 账号的额度快照来源（ADR-0009，带缓存的零额度探针）；设置后随 health 应答上报。 */
  readonly quota?: () => Promise<QuotaSnapshotV1>
}

export const createRunnerDaemon = async (opts: RunnerDaemonOptions): Promise<{ server: Server; adapter: CodexAdapter; runner: RunnerDescriptor }> => {
  const codexModel = opts.env['CMAP_CODEX_MODEL']?.trim()
  if (!codexModel) throw new RangeError('CMAP_CODEX_MODEL is required')
  const runnerId = opts.env['RUNNER_ID']?.trim() ?? ''
  const clock = opts.nowMs ?? Date.now
  const firstUse = createNonceCache(clock)
  /** 通过请求认证的响应才签名；签名绑定所答请求的 nonce，旧响应不能冒充新请求的答复。 */
  const requestNonce = new WeakMap<ServerResponse, string>()
  const send = (res: ServerResponse, status: number, body?: object): void => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    const nonce = requestNonce.get(res)
    const signature = nonce === undefined ? undefined : signRunnerResponse({ privateKey: opts.signingKey, audience: runnerId, requestNonce: nonce, status, ...(bytes ? { body: bytes } : {}) })
    res.writeHead(status, { ...(bytes ? { 'content-type': 'application/json' } : {}), ...(signature ? { [RUNNER_AUTH_HEADERS.signature]: signature } : {}) })
    res.end(bytes)
  }
  const verifyPermit = (token: string, envelope: TaskEnvelopeV1): undefined => verifyDispatchPermit(token, {
    publicKey: opts.publicKey, issuer: opts.issuer, runnerId, adapterId: REMOTE_ADAPTER_ID, envelope, clockSkewSeconds: 2,
    ...(opts.nowMs ? { nowMs: opts.nowMs() } : {}),
  })
  const codexBin = opts.env['CODEX_BIN']
  const adapter = new CodexAdapter({
    // 受众是远程 runner 协议而非本机 codex-adapter：同一张许可在准备前与启动前各验一次
    authorization: {
      mode: 'managed',
      verifier: (token, envelope, _adapterId, contextRunner) => {
        if (contextRunner !== runnerId) throw new DispatchPermitError('CLAIM_MISMATCH')
        return verifyPermit(token, envelope)
      },
    },
    ...(codexBin ? { bin: codexBin } : {}),
    outputSchemaPath: fileURLToPath(new URL('../../../schemas/codex-output.v1.schema.json', import.meta.url)),
    runsDir: join(opts.workRoot, '.runs'),
    defaultModel: codexModel,
    ...(opts.quota ? { quota: opts.quota } : {}),
  })
  const runner = buildRunnerDescriptor(opts.env, [await adapter.discover()])
  const bindings = new Map<string, RemoteTaskBinding>()

  /** 先验签再登记 nonce：只有通过验签的请求才占缓存。任何异常都按未认证处理（fail closed）。 */
  const authenticate = (req: IncomingMessage, url: URL): { nonce: string; contentSha256: string } | undefined => {
    try {
      const verified = verifyRunnerRequest({
        publicKey: opts.publicKey, method: req.method ?? '', target: url.pathname + url.search, audience: runnerId,
        headers: req.headers, nowMs: clock(),
      })
      return firstUse(verified.nonce) ? verified : undefined
    } catch {
      return undefined
    }
  }

  const bindingFor = (id: string): RemoteTaskBinding => {
    if (!REMOTE_TASK_ID.test(id)) throw new ProtocolFault(404, 'NOT_FOUND')
    // 守护进程重启后内存为空：CodexAdapter 只凭 remote_task_id 与运行记录恢复，记录缺失即 BINDING_NOT_FOUND。
    return bindings.get(id) ?? { adapter: adapter.adapterId, remote_task_id: id, protocol: 'codex-exec', protocol_version: '0.1.0', runner_id: runnerId }
  }

  const dispatch = async (raw: Buffer, res: ServerResponse): Promise<void> => {
    const msg = parseJson(raw)
    if (!validateRemoteMessage(msg) || msg.kind !== 'dispatch') throw new ProtocolFault(400, 'MALFORMED_REQUEST')
    if (msg.runner_id !== runnerId) throw new DispatchPermitError('CLAIM_MISMATCH')
    const envelope = msg.envelope as TaskEnvelopeV1
    verifyPermit(msg.permit, envelope)
    assertRunnerAdmission(runner, admissionSubject(envelope))
    const { child } = await safeChildDir(opts.workRoot, envelope.identity.task_id)
    await stageInputs(child, envelope, msg.inputs)
    const binding = await adapter.startTask(envelope, {
      token: msg.permit, runner_id: runnerId, trace_id: msg.trace_id, correlation_id: msg.correlation_id,
      worktree: child, deadline_at: msg.deadline_at,
      beforeSend: async () => assertRunnerAdmission(runner, admissionSubject(envelope)),
    })
    bindings.set(binding.remote_task_id, binding)
    send(res, 200, { schema: SCHEMA, kind: 'dispatch_accepted', runner_id: runnerId, remote_task_id: binding.remote_task_id })
  }

  const status = async (id: string, res: ServerResponse): Promise<void> => {
    const observed = await adapter.getStatus(bindingFor(id))
    send(res, 200, { schema: SCHEMA, kind: 'status', remote_task_id: id, status: observed.status, terminal_observed: observed.terminal_observed })
  }

  /** 产物由控制面拉取：这里只按 lap 侧工作区读出已复核的字节，哈希仍由 CrossMini 独立复算。 */
  const result = async (id: string, res: ServerResponse): Promise<void> => {
    const collected = await adapter.collectResult(bindingFor(id))
    const { child } = await existingChildDir(opts.workRoot, REMOTE_TASK_ID.exec(id)![1]!)
    const artifacts: { uri: string; content_base64: string }[] = []
    const described = []
    for (const art of collected.artifacts) {
      const { bytes } = await readVerifiedArtifact(child, art)
      const uri = relative(child, resolve(child, art.uri))
      artifacts.push({ uri, content_base64: bytes.toString('base64') })
      described.push({ ...art, uri })
    }
    send(res, 200, { schema: SCHEMA, kind: 'result', remote_task_id: id, result: { ...collected, artifacts: described }, artifacts })
  }

  const cancel = async (id: string, raw: Buffer, res: ServerResponse): Promise<void> => {
    const msg = parseJson(raw)
    if (!validateRemoteMessage(msg) || msg.kind !== 'cancel' || msg.remote_task_id !== id) throw new ProtocolFault(400, 'MALFORMED_REQUEST')
    await adapter.cancel(bindingFor(id), msg.reason)
    send(res, 204)
  }

  const health = async (res: ServerResponse): Promise<void> => {
    const observed = await adapter.health()
    // 公布本机准入白名单，CrossMini 派发前据此回落；派发时 assertRunnerAdmission 仍是最后一道闸。
    send(res, 200, { schema: SCHEMA, kind: 'health', runner_id: runnerId, state: observed.state, checked_at: observed.checked_at, admission: runner.admission, ...(observed.quota ? { quota: observed.quota } : {}) })
  }

  const server = createServer(async (req, res) => {
    // 认证先于路由与读体：签名、受众、时间窗、nonce 任何一项不过都是同一个 401，什么都不执行。
    const url = new URL(req.url ?? '/', 'http://runner')
    const auth = authenticate(req, url)
    if (!auth) return sendUnauthorized(res)
    const { nonce, contentSha256 } = auth
    requestNonce.set(res, nonce)
    try {
      const raw = await readBody(req)
      if (runnerBodySha256(raw) !== contentSha256) return sendUnauthorized(res)
      const path = url.pathname
      const task = /^\/v1\/tasks\/([^/]+)(\/result|\/cancel)?$/.exec(path)
      if (req.method === 'GET' && path === '/v1/health') return await health(res)
      if (req.method === 'POST' && path === '/v1/tasks') return await dispatch(raw, res)
      if (task) {
        const id = decodeURIComponent(task[1]!)
        if (req.method === 'GET' && !task[2]) return await status(id, res)
        if (req.method === 'GET' && task[2] === '/result') return await result(id, res)
        if (req.method === 'POST' && task[2] === '/cancel') return await cancel(id, raw, res)
      }
      throw new ProtocolFault(404, 'NOT_FOUND')
    } catch (error) {
      const [code, body] = toReply(error)
      if (!res.headersSent) send(res, code, body)
    }
  })
  return { server, adapter, runner }
}
