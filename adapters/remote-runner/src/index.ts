/**
 * Remote Runner Adapter — CrossMini 经 HTTP 把任务交给 lap 上的 runner 守护进程（ADR-0006 薄协议）。
 *
 * 契约：schemas/remote-runner.v1.schema.json。只由控制面发起请求；lap 不回连、不写账本。
 *
 * 五条不放松的规则：
 *  1. 派发许可受众绑定目标 runner_id；lap 用固定公钥验签，拒绝即不执行（PERMIT_INVALID / 准入拒绝）。
 *  2. 失联不改派：状态查询失败在离线宽限内视为仍在执行，超过则报 BINDING_NOT_FOUND，
 *     由控制面走执行不确定，绝不重跑、不换 runner。有效宽限 = min(配置宽限（默认 600 秒），
 *     首次失联时距调用方等待截止剩余时间的一半)，保证先判不确定、不先撞任务超时。
 *  3. 证据由控制面拉取并独立复算 sha256，不采信 lap 自报；对不上即失败。产物按结果里声明的 sha256 与长度单独流式拉取，
 *     边收边算写进内容寻址存储，再复制到任务目录复核（M09）；旧版 lap 的内联产物仍接受。
 *  4. 每个请求（含 health）由控制面的许可私钥签名，lap 的每个应答由 lap 自己的密钥签名并绑定所答请求；
 *     应答验签失败一律不采信：结果端点按 EVIDENCE_HASH_MISMATCH 处理（不落盘、不写 artifact 记录），其余端点按协议失败。
 *  5. 线上只有信封、许可与已冻结输入；不传凭据或控制面秘密，lap 不回传提供方 stderr，错误只带 category/code/retryable。
 */

import { constants, readFileSync } from 'node:fs'
import type { KeyObject } from 'node:crypto'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { Ajv2020 } from 'ajv/dist/2020.js'

import type { RemoteRunnerMessageV1, RemoteTaskBinding, RiskLevel, TaskEnvelopeV1, TaskResultV1, RunnerAdmissionErrorCode, DispatchPermitErrorCode } from '#domain-model'
import { DispatchPermitError, RUNNER_ADMISSION_CODES, RunnerAdmissionError, loadOrCreatePermitKey, loadPinnedPublicKey } from '#domain-model'
import type {
  AdapterAuthorization,
  AdapterDescriptor,
  AdapterHealth,
  AgentAdapter,
  AgentInput,
  DispatchContext,
  NormalizedAgentEvent,
  NormalizedAgentStatus,
  StatusObservation,
  SubscriptionHandle,
} from '#adapter-sdk'
import { AdapterError, assertAdapterAuthorization, snapshotAdapterAuthorization, snapshotDispatchContext } from '#adapter-sdk'
import { readVerifiedArtifact, verifyArtifactFile } from '../../../packages/adapter-sdk/src/structured-output.ts'
import { evidenceHashMismatch, putContent } from '../../../packages/adapter-sdk/src/content-store.ts'
import { hasKnownSecret } from '../../../packages/adapter-sdk/src/secret-patterns.ts'
import { RUNNER_AUTH_HEADERS, signRunnerRequest, verifyRunnerResponse } from '../../../packages/domain-model/src/dispatch-permit.ts'

export const REMOTE_ADAPTER_ID = 'remote-runner-adapter'
const SCHEMA = 'cmap/remote-runner/v1'
const REMOTE_TASK_ID = /^codex:([A-Za-z0-9][A-Za-z0-9._:-]{0,127}):([1-9][0-9]{0,15})$/
const INPUT_URI = /^inputs\/[A-Za-z][A-Za-z0-9_-]{0,63}\/[a-f0-9]{64}\/payload$/

const ajv = new Ajv2020({ strict: true })
const readSchema = (name: string): object =>
  JSON.parse(readFileSync(new URL(`../../../schemas/${name}`, import.meta.url), 'utf8'))
// health.quota 引用同目录的 quota-snapshot 契约（相对 remote-runner 的 $id 解析）
ajv.addSchema(readSchema('quota-snapshot.v1.schema.json'), 'https://cmap.local/schemas/remote-runner/quota-snapshot.v1.schema.json')
export const validateRemoteMessage = ajv.compile<RemoteRunnerMessageV1>(readSchema('remote-runner.v1.schema.json'))
const validateTaskResult = ajv.compile<TaskResultV1>(readSchema('task-result.v1.schema.json'))

type ErrorMessage = Extract<RemoteRunnerMessageV1, { kind: 'error' }>
type ResultMessage = Extract<RemoteRunnerMessageV1, { kind: 'result' }>
type StreamedArtifact = Extract<ResultMessage['artifacts'][number], { sha256: string }>
/** 按声明拉取一个流式产物并核验，返回控制面上已核验字节的文件路径（内容寻址存储或网关上传登记）。 */
export type StreamedArtifactSource = (artifact: StreamedArtifact, role: string) => Promise<string>
type Reply = { readonly status: number; readonly body: RemoteRunnerMessageV1 | undefined }

const unreachable = (): AdapterError =>
  new AdapterError('REMOTE_UNREACHABLE', '远程 runner 不可达', true, 'remote-unreachable')
const protocolInvalid = (): AdapterError =>
  new AdapterError('REMOTE_PROTOCOL_INVALID', '远程 runner 响应不符合 remote-runner.v1', false, 'remote-protocol-invalid')

const unauthorized = (): AdapterError =>
  new AdapterError('REMOTE_UNAUTHORIZED', '远程 runner 拒绝了请求认证（签名、受众、时钟或重放）', true, 'remote-unauthorized')
/** 结果响应验签失败与产物哈希对不上同等对待：不采信、不落盘、不写 artifact 记录。 */
const badResponseSignature = (path: string): AdapterError => path.endsWith('/result')
  ? new AdapterError('EVIDENCE_HASH_MISMATCH', '远程结果响应签名无效，证据不采信', false, 'evidence-hash-mismatch:response-signature')
  : new AdapterError('REMOTE_RESPONSE_SIGNATURE_INVALID', '远程 runner 响应签名无效', false, 'remote-response-signature-invalid')

/** 远端拒绝原样还原为本地错误类型，控制面据此落 PERMIT_INVALID / 准入拒绝等既有回执。 */
export const raiseRemoteError = (error: ErrorMessage): never => {
  if (error.category === 'permit') throw new DispatchPermitError(error.code as DispatchPermitErrorCode)
  if (error.category === 'admission' && (RUNNER_ADMISSION_CODES as readonly string[]).includes(error.code)) {
    throw new RunnerAdmissionError(error.code as RunnerAdmissionErrorCode)
  }
  throw new AdapterError(error.code, `远程 runner 拒绝：${error.category}:${error.code}`, error.retryable, `remote:${error.code}`)
}

const requiredEnv = (key: string): string => {
  const value = process.env[key]?.trim()
  if (!value) throw new RangeError(`${key} is required for the remote runner (ADR-0006)`)
  return value
}

/** 只发送控制面已冻结、已复核的输入文件；路径或哈希不合规即按输入无效拒绝。 */
export const readFrozenInputs = async (envelope: TaskEnvelopeV1, ctx: DispatchContext) => {
  const refs = (envelope.inputs?.artifact_refs ?? []).filter((ref) => ref.uri !== undefined)
  const inputs: { uri: string; sha256: string; content_base64: string }[] = []
  try {
    for (const ref of refs) {
      if (!ctx.worktree || !INPUT_URI.test(ref.uri!) || typeof ref.sha256 !== 'string') throw new Error('INPUT_INVALID')
      const verified = await readVerifiedArtifact(ctx.worktree, { uri: ref.uri!, role: ref.role, sha256: ref.sha256 })
      inputs.push({ uri: ref.uri!, sha256: verified.sha256, content_base64: verified.bytes.toString('base64') })
    }
  } catch {
    throw new RunnerAdmissionError('INPUT_INVALID')
  }
  return inputs
}

const evidenceMissing = (role: string): AdapterError =>
  new AdapterError('EVIDENCE_FILE_MISSING', `远程产物未随结果回传：${role}`, false, `evidence-missing:${role}`)

/**
 * 结果与产物落到控制面工作区后独立复算哈希（remote-runner.v1 的 result 应答；出站网关的 result 回报同一形状）。
 * 流式产物经 fetchStreamed 取得已核验的字节；内联产物（旧版 runner）同样先经内容寻址存储核验。
 * 随后复制到 `<workRoot>/<taskId>/<uri>`（既有读者照旧按任务目录读），在任务目录里再复核一次（路径不逃逸、哈希一致）。
 * 身份字段仍由 Activities 覆盖；这里只保证结果形状合法、产物字节与哈希一致。
 */
export const materializeRemoteResult = async (workRoot: string, id: string, body: ResultMessage, fetchStreamed?: StreamedArtifactSource): Promise<TaskResultV1> => {
  const result = body.result
  if (!validateTaskResult(result)) {
    throw new AdapterError('RESULT_INVALID', '远程结果不符合 task-result.v1', false, 'remote-result-invalid')
  }
  if (hasKnownSecret(JSON.stringify(result))) {
    throw new AdapterError('RESULT_SECRET_DETECTED', '结果命中已知凭据模式', false, 'result-secret-detected')
  }

  const dir = join(workRoot, REMOTE_TASK_ID.exec(id)![1]!)
  await mkdir(dir, { recursive: true })
  const artifacts: TaskResultV1['artifacts'] = []
  for (const art of result.artifacts) {
    const pulled = body.artifacts.filter((p) => p.uri === art.uri)
    if (pulled.length !== 1) throw evidenceMissing(art.role)
    const target = resolve(dir, art.uri)
    if (!target.startsWith(dir + sep)) throw protocolInvalid()
    const declared = art.sha256.toLowerCase()
    const p = pulled[0]!
    let source: string
    if ('content_base64' in p) {
      source = (await putContent(workRoot, Readable.from([Buffer.from(p.content_base64, 'base64')]), { sha256: declared, role: art.role })).path
    } else {
      if (p.sha256 !== declared) throw evidenceHashMismatch(art.role, declared, p.sha256)
      if (!fetchStreamed) throw evidenceMissing(art.role)
      source = await fetchStreamed(p, art.role)
    }
    await mkdir(dirname(target), { recursive: true })
    let created = false
    try {
      // APFS 上是写时复制克隆，不占第二份空间；不支持时退回普通复制。
      await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    try {
      const verified = await verifyArtifactFile(dir, { uri: art.uri, role: art.role, sha256: declared })
      artifacts.push({ ...art, size_bytes: verified.size_bytes, sha256: verified.sha256 })
    } catch (error) {
      if (created) await rm(target, { force: true })
      if (!created && error instanceof AdapterError && error.code === 'EVIDENCE_HASH_MISMATCH') {
        throw new AdapterError('EVIDENCE_CONFLICT', `产物路径已有不同内容：${art.role}`, false, `evidence-conflict:${art.role}`)
      }
      throw error
    }
  }
  return { ...result, artifacts }
}

export interface RemoteRunnerAdapterOptions {
  readonly authorization: AdapterAuthorization
  /** 请求签名私钥 = 控制面派发许可私钥。省略时从 CMAP_PERMIT_KEY_FILE 加载（与 Worker 同一文件）。 */
  readonly signingKey?: KeyObject
  /** 固定的 lap 响应验签公钥。省略时从 CMAP_REMOTE_RUNNER_PUBKEY_FILE 加载；两者都没有则拒绝构造（fail closed）。 */
  readonly runnerPublicKey?: KeyObject
  /** 例如 http://cross-m1mx:8790。只由控制面主动访问。 */
  readonly baseUrl: string
  /** 目标 runner_id（lap 守护进程的 RUNNER_ID）。 */
  readonly runnerId: string
  /** 路由用的 Agent ID，例如 `codex@lap`。 */
  readonly agentId: string
  /** 控制面工作区根：输入从 `<workRoot>/<taskId>` 读取，产物拉回到同一目录。 */
  readonly workRoot: string
  /** 静态描述（启动与路由不依赖 lap 在线）；应与 lap 上被包装的 Adapter 一致。 */
  readonly capabilities: readonly string[]
  readonly riskCeiling?: RiskLevel
  /** 健康探测与状态查询的超时（默认 3 秒）。状态查询挂起即计为失联，不能拖过调用方的观察窗口。 */
  readonly healthTimeoutMs?: number
  readonly requestTimeoutMs?: number
  /** 单个产物流式拉取的总超时（默认 10 分钟，按上限 256MiB 留余量）。 */
  readonly artifactTimeoutMs?: number
  /** 配置的离线宽限上限（默认 600 秒）；实际宽限还受调用方等待截止约束，见 getStatus。 */
  readonly offlineGraceMs?: number
  readonly now?: () => number
}

export class RemoteRunnerAdapter implements AgentAdapter {
  readonly adapterId = REMOTE_ADAPTER_ID
  /** lap 侧是 Codex 运行记录模式、binding 只含 remote_task_id：Worker 重启后据 binding 继续轮询即可，不会重发。 */
  readonly restartSafe = true
  readonly agentId: string
  readonly runnerId: string
  readonly authorizationMode: AdapterAuthorization['mode']

  readonly #authorization: AdapterAuthorization
  readonly #signingKey: KeyObject
  readonly #runnerPublicKey: KeyObject
  readonly #baseUrl: string
  readonly #workRoot: string
  readonly #capabilities: readonly string[]
  readonly #riskCeiling: RiskLevel
  readonly #healthTimeoutMs: number
  readonly #requestTimeoutMs: number
  readonly #artifactTimeoutMs: number
  readonly #offlineGraceMs: number
  readonly #now: () => number
  /**
   * 连续失联的任务何时判执行不确定（首次失联时算定，之后不再推迟）。
   * ponytail: 只在进程内；Worker 重启会让宽限重新计时（只会更晚判不确定，不会重跑）。需要精确宽限再落账本。
   */
  readonly #uncertainAt = new Map<string, number>()

  constructor(opts: RemoteRunnerAdapterOptions) {
    this.#authorization = snapshotAdapterAuthorization(opts.authorization)
    this.authorizationMode = this.#authorization.mode
    this.#signingKey = opts.signingKey ?? loadOrCreatePermitKey(requiredEnv('CMAP_PERMIT_KEY_FILE')).privateKey
    this.#runnerPublicKey = opts.runnerPublicKey ?? loadPinnedPublicKey(requiredEnv('CMAP_REMOTE_RUNNER_PUBKEY_FILE'))
    this.agentId = opts.agentId
    this.runnerId = opts.runnerId
    this.#baseUrl = opts.baseUrl
    this.#workRoot = opts.workRoot
    this.#capabilities = Object.freeze([...opts.capabilities])
    this.#riskCeiling = opts.riskCeiling ?? 'mutating'
    this.#healthTimeoutMs = opts.healthTimeoutMs ?? 3_000
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? 30_000
    this.#artifactTimeoutMs = opts.artifactTimeoutMs ?? 600_000
    this.#offlineGraceMs = opts.offlineGraceMs ?? 600_000
    this.#now = opts.now ?? Date.now
  }

  async discover(): Promise<AdapterDescriptor> {
    return {
      adapter_id: REMOTE_ADAPTER_ID,
      agent_id: this.agentId,
      provider: 'cmap-remote-runner',
      version: '1',
      capabilities: [...this.#capabilities],
      risk_ceiling: this.#riskCeiling,
      supports_session_resume: false,
      supports_worktree_isolation: true,
      // 远端是否具备 computer-use 未经核验，不冒充 A 级
      execution_level: 'B',
    }
  }

  prepareBinding(envelope: TaskEnvelopeV1, ctx: DispatchContext): RemoteTaskBinding {
    return {
      adapter: REMOTE_ADAPTER_ID,
      // 与 lap 上 CodexAdapter 的 remote_task_id 一致，守护进程重启后可据运行记录恢复
      remote_task_id: `codex:${envelope.identity.task_id}:${envelope.identity.revision}`,
      protocol: 'cmap-remote-runner',
      protocol_version: '1',
      runner_id: ctx.runner_id,
    }
  }

  async startTask(envelope: TaskEnvelopeV1, ctx: DispatchContext): Promise<RemoteTaskBinding> {
    const frozenEnvelope = structuredClone(envelope)
    const frozenCtx = snapshotDispatchContext(ctx)
    assertAdapterAuthorization(this.#authorization, frozenEnvelope, frozenCtx, REMOTE_ADAPTER_ID)
    if (frozenCtx.runner_id !== this.runnerId) throw new DispatchPermitError('CLAIM_MISMATCH')
    const binding = this.prepareBinding(frozenEnvelope, frozenCtx)

    const inputs = await readFrozenInputs(frozenEnvelope, frozenCtx)
    await frozenCtx.beforeSend?.(binding)
    assertAdapterAuthorization(this.#authorization, frozenEnvelope, frozenCtx, REMOTE_ADAPTER_ID)

    let reply: Reply
    try {
      reply = await this.#call('POST', '/v1/tasks', {
        schema: SCHEMA,
        kind: 'dispatch',
        runner_id: this.runnerId,
        permit: frozenCtx.token,
        envelope: frozenEnvelope,
        trace_id: frozenCtx.trace_id,
        correlation_id: frozenCtx.correlation_id,
        deadline_at: frozenCtx.deadline_at,
        inputs,
      })
    } catch (error) {
      // 请求认证被拒时 lap 什么都没执行；按许可无效落账（保留 binding、不重发），与许可被拒同一条路径。
      if (error instanceof AdapterError && error.code === 'REMOTE_UNAUTHORIZED') throw new DispatchPermitError('BAD_SIGNATURE')
      throw error
    }
    const body = this.#expect(reply, 'dispatch_accepted')
    if (body.remote_task_id !== binding.remote_task_id || body.runner_id !== this.runnerId) throw protocolInvalid()
    return binding
  }

  async sendInput(_binding: RemoteTaskBinding, input: AgentInput): Promise<void> {
    throw new AdapterError('INPUT_NOT_SUPPORTED', `远程 codex exec 为非交互模式（kind=${input.kind}）`, false, 'remote-no-stdin')
  }

  async getStatus(binding: RemoteTaskBinding, observation?: StatusObservation): Promise<NormalizedAgentStatus> {
    const id = this.#own(binding)
    let reply: Reply
    try {
      reply = await this.#call('GET', `/v1/tasks/${encodeURIComponent(id)}`, undefined, this.#healthTimeoutMs)
    } catch (error) {
      if (!(error instanceof AdapterError) || (error.code !== 'REMOTE_UNREACHABLE' && error.code !== 'REMOTE_UNAUTHORIZED')) throw error
      const now = this.#now()
      let at = this.#uncertainAt.get(id)
      if (at === undefined) {
        // 剩余时间的一半：首次失联后至少还有半个剩余窗口让调用方再轮询到不确定，而不是先到截止去取消一个联系不上的任务。
        const deadline = observation ? Date.parse(observation.deadline_at) : Number.NaN
        at = now + (Number.isFinite(deadline) ? Math.min(this.#offlineGraceMs, Math.max(0, (deadline - now) / 2)) : this.#offlineGraceMs)
        this.#uncertainAt.set(id, at)
      }
      if (now >= at) {
        throw new AdapterError('BINDING_NOT_FOUND', `远程 runner 失联超过宽限，执行不确定，不重跑：${id}`, false, 'remote-offline-grace-exceeded')
      }
      return { status: 'running', at: new Date(now).toISOString(), terminal_observed: false, detail: 'REMOTE_UNREACHABLE' }
    }
    this.#uncertainAt.delete(id)
    const body = this.#expect(reply, 'status')
    if (body.remote_task_id !== id) throw protocolInvalid()
    return { status: body.status, at: new Date().toISOString(), terminal_observed: body.terminal_observed }
  }

  async subscribe(binding: RemoteTaskBinding, _onEvent: (event: NormalizedAgentEvent) => Promise<void>): Promise<SubscriptionHandle> {
    // ponytail: 薄协议不传事件流；控制面靠轮询 getStatus。需要实时进度再加端点。
    this.#own(binding)
    return { unsubscribe: async () => {} }
  }

  async cancel(binding: RemoteTaskBinding, reason: string): Promise<void> {
    const id = this.#own(binding)
    const reply = await this.#call('POST', `/v1/tasks/${encodeURIComponent(id)}/cancel`, {
      schema: SCHEMA, kind: 'cancel', remote_task_id: id, reason: reason.slice(0, 256) || 'canceled',
    })
    if (reply.status !== 204) this.#expect(reply, 'status')
  }

  /**
   * 拉取结果与产物，在控制面工作区落盘后独立复算哈希。
   * 身份字段仍由 Activities 覆盖；这里只保证结果形状合法、产物字节与哈希一致。
   */
  async collectResult(binding: RemoteTaskBinding): Promise<TaskResultV1> {
    const id = this.#own(binding)
    const body = this.#expect(await this.#call('GET', `/v1/tasks/${encodeURIComponent(id)}/result`), 'result')
    if (body.remote_task_id !== id) throw protocolInvalid()
    return materializeRemoteResult(this.#workRoot, id, body, (art, role) => this.#download(id, art, role))
  }

  /**
   * 按结果里已签名的声明（sha256 + 长度）拉取产物字节：先按声明的 sha256 验应答签名，再边收边算写入内容寻址存储；
   * 签名、长度或哈希任何一项对不上都按 EVIDENCE_HASH_MISMATCH 处理，不落盘。
   */
  async #download(id: string, art: StreamedArtifact, role: string): Promise<string> {
    const path = `/v1/tasks/${encodeURIComponent(id)}/artifacts/${art.sha256}`
    const url = new URL(path, this.#baseUrl)
    const auth = signRunnerRequest({ privateKey: this.#signingKey, method: 'GET', target: url.pathname + url.search, audience: this.runnerId })
    const signal = AbortSignal.timeout(this.#artifactTimeoutMs)
    let res: Response
    try {
      res = await fetch(url, { headers: auth, signal })
    } catch {
      throw unreachable()
    }
    if (res.status === 401) throw unauthorized()
    const verify = (body: { body: Buffer } | { bodySha256: string }): void => verifyRunnerResponse({
      publicKey: this.#runnerPublicKey, audience: this.runnerId, requestNonce: auth[RUNNER_AUTH_HEADERS.nonce]!,
      status: res.status, signature: res.headers.get(RUNNER_AUTH_HEADERS.signature), ...body,
    })
    if (res.status !== 200) {
      let bytes: Buffer
      try { bytes = Buffer.from(await res.arrayBuffer()) } catch { throw unreachable() }
      try { verify({ body: bytes }) } catch { throw evidenceHashMismatch(role, art.sha256, 'response-signature') }
      let parsed: unknown
      try { parsed = JSON.parse(bytes.toString('utf8')) } catch { throw protocolInvalid() }
      if (validateRemoteMessage(parsed) && parsed.kind === 'error') raiseRemoteError(parsed)
      throw protocolInvalid()
    }
    const mismatch = (why: string): AdapterError => {
      void res.body?.cancel().catch(() => undefined)
      return evidenceHashMismatch(role, art.sha256, why)
    }
    try { verify({ bodySha256: art.sha256 }) } catch { throw mismatch('response-signature') }
    if (res.headers.get('content-length') !== String(art.size_bytes) || !res.body) throw mismatch('content-length')
    try {
      return (await putContent(this.#workRoot, Readable.fromWeb(res.body), { sha256: art.sha256, size_bytes: art.size_bytes, role })).path
    } catch (error) {
      if (error instanceof AdapterError) throw error
      throw unreachable()
    }
  }

  async health(): Promise<AdapterHealth> {
    const checked_at = new Date().toISOString()
    try {
      const body = this.#expect(await this.#call('GET', '/v1/health', undefined, this.#healthTimeoutMs), 'health')
      if (body.runner_id !== this.runnerId) return { state: 'unavailable', checked_at, detail: 'RUNNER_ID_MISMATCH' }
      return { state: body.state, checked_at, admission: body.admission, ...(body.quota ? { quota: body.quota } : {}) }
    } catch (error) {
      return { state: 'unavailable', checked_at, detail: error instanceof AdapterError ? error.code : 'REMOTE_HEALTH_FAILED' }
    }
  }


  #own(binding: RemoteTaskBinding): string {
    if (binding.adapter !== REMOTE_ADAPTER_ID || binding.runner_id !== this.runnerId || !REMOTE_TASK_ID.test(binding.remote_task_id)) {
      throw new AdapterError('BINDING_INVALID', `binding 不属于远程 runner ${this.runnerId}`, false, 'remote-binding-invalid')
    }
    return binding.remote_task_id
  }

  #expect<K extends RemoteRunnerMessageV1['kind']>(reply: Reply, kind: K): Extract<RemoteRunnerMessageV1, { kind: K }> {
    if (reply.body?.kind === 'error') raiseRemoteError(reply.body)
    if (reply.status !== 200 || reply.body?.kind !== kind) throw protocolInvalid()
    return reply.body as Extract<RemoteRunnerMessageV1, { kind: K }>
  }

  async #call(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = this.#requestTimeoutMs): Promise<Reply> {
    const url = new URL(path, this.#baseUrl)
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const auth = signRunnerRequest({ privateKey: this.#signingKey, method, target: url.pathname + url.search, audience: this.runnerId, ...(payload === undefined ? {} : { body: payload }) })
    let res: Response
    let bytes: Buffer
    try {
      res = await fetch(url, {
        method,
        headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...auth },
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      bytes = Buffer.from(await res.arrayBuffer())
    } catch {
      throw unreachable()
    }
    // 401 是 lap 唯一不签名的应答（认证失败，什么都没执行）；其余应答验签通过才解析。
    if (res.status === 401) throw unauthorized()
    try {
      verifyRunnerResponse({
        publicKey: this.#runnerPublicKey, audience: this.runnerId, requestNonce: auth[RUNNER_AUTH_HEADERS.nonce]!,
        status: res.status, body: bytes, signature: res.headers.get(RUNNER_AUTH_HEADERS.signature),
      })
    } catch {
      throw badResponseSignature(path)
    }
    const text = bytes.toString('utf8')
    if (res.status === 204 && text === '') return { status: 204, body: undefined }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw protocolInvalid()
    }
    if (!validateRemoteMessage(parsed)) throw protocolInvalid()
    return { status: res.status, body: parsed }
  }
}
