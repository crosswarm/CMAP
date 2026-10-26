/**
 * runner 出站模式（ADR-0008 §3，契约 runner-gateway.v1）：runner 主动长轮询控制面领取任务、回报状态与结果。
 * 控制面从不连 runner，NAT 后的笔记本可直接用。执行核心与监听模式相同（createRunnerCore：验许可 → 准入 → 落地输入 → CodexAdapter）。
 *
 * 每个请求用登记的 Ed25519 私钥签名；每个应答用登记时固定的控制面公钥验签，验不过即不采信（不执行、不当作已送达）。
 * 控制面判过期的租约：停掉本机执行、不再回报。领取期间断网只会让租约过期，由控制面判执行不确定，绝不在这里重跑。
 */
import { createPublicKey, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'

import {
  rawEd25519PublicKey, signEnrollmentProof, validateEnrollmentMessage, validateGatewayMessage,
  type RunnerEnrollmentMessageV1, type RunnerGatewayMessageV1,
} from '#domain-model'
import { AdapterError } from '#adapter-sdk'
import { signRunnerRequest, verifyRunnerResponse } from '../../../packages/domain-model/src/dispatch-permit.ts'
import { FORBIDDEN_ENV, toRunnerError, type createRunnerCore } from './server.ts'

const SCHEMA = 'cmap/runner-gateway/v1'

type Core = Awaited<ReturnType<typeof createRunnerCore>>
type ClaimResult = Extract<RunnerGatewayMessageV1, { kind: 'claim_result' }>
type Assignment = NonNullable<ClaimResult['assignment']>
type ReportBody = Extract<RunnerGatewayMessageV1, { kind: 'report' }>['body']

export class GatewayRejectedError extends Error {}

export type RunnerEnrollment = Extract<RunnerEnrollmentMessageV1, { kind: 'enrolled' }>

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** 出站模式配置：设了 CMAP_CONTROL_PLANE_URL 即为出站模式，不监听任何端口。 */
export const readOutboundRunnerConfig = (env: NodeJS.ProcessEnv) => {
  for (const key of FORBIDDEN_ENV) if (env[key]) throw new RangeError(`${key} must not be set on the runner host (ADR-0008)`)
  const required = (key: string): string => {
    const value = env[key]?.trim()
    if (!value) throw new RangeError(`${key} is required`)
    return value
  }
  const controlPlaneUrl = new URL(required('CMAP_CONTROL_PLANE_URL'))
  // 注册令牌与固定的控制面公钥都经这条连接拿到：公网只认 https，http 只限本机回环。
  if (controlPlaneUrl.protocol !== 'https:' && !(controlPlaneUrl.protocol === 'http:' && LOOPBACK.has(controlPlaneUrl.hostname))) {
    throw new RangeError('CMAP_CONTROL_PLANE_URL must be https (http only for loopback)')
  }
  const signingKeyFile = required('CMAP_RUNNER_KEY_FILE')
  return {
    controlPlaneUrl: controlPlaneUrl.origin,
    publicKeyFile: required('CMAP_PERMIT_PUBLIC_KEY_FILE'),
    /** 登记的 runner 私钥（首次启动生成 0600，私钥不离开本机）。 */
    signingKeyFile,
    enrollmentFile: env['CMAP_RUNNER_ENROLLMENT_FILE']?.trim() || join(dirname(signingKeyFile), 'enrollment.json'),
    issuer: env['CMAP_PERMIT_ISSUER']?.trim() || 'cmap:local-control-plane',
    codexModel: required('CMAP_CODEX_MODEL'),
    workRoot: env['CMAP_WORK_ROOT']?.trim() || undefined,
  }
}

export const readEnrollment = (file: string): RunnerEnrollment => {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!validateEnrollmentMessage(value) || value.kind !== 'enrolled') throw new RangeError(`${file} is not a runner-enrollment.v1 enrolled record`)
  return value
}

/**
 * 首次启动用一次性注册令牌登记（ADR-0008 §4）：持钥证明 = 本机私钥对 token/公钥/host 的签名，私钥不离开本机。
 * 应答（runner_id、身份与上限、控制面网关公钥）写成 0600 的登记记录；之后启动只读这份记录，不再需要令牌。
 */
export const loadOrEnroll = async (input: {
  controlPlaneUrl: string
  enrollmentFile: string
  privateKey: KeyObject
  host: string
  token?: string | undefined
}): Promise<RunnerEnrollment> => {
  const origin = new URL(input.controlPlaneUrl).origin
  if (existsSync(input.enrollmentFile)) {
    const enrolled = readEnrollment(input.enrollmentFile)
    // 登记记录属于登记时的那套服务端：URL 配错时拒绝启动，而不是拿别家的私钥与公钥去撞这一家
    if (enrolled.control_plane_origin && enrolled.control_plane_origin !== origin) {
      throw new RangeError(`登记文件 ${input.enrollmentFile} 属于 ${enrolled.control_plane_origin}，但当前 CMAP_CONTROL_PLANE_URL 是 ${origin}；每套服务端须用各自的登记文件、密钥与工作目录`)
    }
    if (enrolled.control_plane_origin) return enrolled
    // 旧记录没有该字段：按当前 URL 补写（0600，原地替换）
    const bound = { ...enrolled, control_plane_origin: origin }
    writeFileSync(input.enrollmentFile, JSON.stringify(bound), { mode: 0o600 })
    return bound
  }
  const token = input.token?.trim()
  if (!token) throw new RangeError('首次启动需要 CMAP_RUNNER_ENROLL_TOKEN（admin 签发的一次性注册令牌）')
  const publicKey = rawEd25519PublicKey(createPublicKey(input.privateKey))
  const res = await fetch(new URL('/v1/runners/enroll', input.controlPlaneUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      schema: 'cmap/runner-enrollment/v1', kind: 'enroll', token, public_key: publicKey, host: input.host,
      proof: signEnrollmentProof({ privateKey: input.privateKey, token, publicKey, host: input.host }),
    }),
  })
  const reply: unknown = await res.json().catch(() => undefined)
  if (res.status !== 201 || !validateEnrollmentMessage(reply) || reply.kind !== 'enrolled') throw new GatewayRejectedError('ENROLLMENT_DENIED')
  const bound = { ...reply, control_plane_origin: origin }
  writeFileSync(input.enrollmentFile, JSON.stringify(bound), { flag: 'wx', mode: 0o600 })
  return bound
}

/** 出站模式的准入白名单只来自登记记录（tenant/owner/能力/风险上限），本机 RUNNER_* 环境变量不能放宽它。 */
export const enrolledRunnerEnv = (env: NodeJS.ProcessEnv, enrolled: RunnerEnrollment): NodeJS.ProcessEnv => ({
  ...env,
  RUNNER_ID: enrolled.runner_id,
  RUNNER_TENANT: enrolled.tenant,
  RUNNER_ALLOWED_TENANTS: enrolled.tenant,
  RUNNER_ALLOWED_OWNERS: enrolled.owner,
  RUNNER_ALLOWED_CAPABILITIES: enrolled.allowed_capabilities.join(','),
  RUNNER_MAX_RISK: enrolled.max_risk,
})

export interface OutboundRunnerOptions {
  readonly core: Core
  /** 例如 https://cmap.spux.cn；回环地址可用 http。 */
  readonly controlPlaneUrl: string
  /** 登记的 runner 私钥（Ed25519），签每个网关请求。 */
  readonly signingKey: KeyObject
  /** 登记时固定的控制面网关公钥，验每个网关应答。 */
  readonly controlPlanePublicKey: KeyObject
  /** 长轮询时长，默认 50 秒（契约上限）。 */
  readonly waitSeconds?: number
  /** 本机执行状态的检查间隔，默认 2 秒。 */
  readonly statusIntervalMs?: number
  /** 请求失败后的重试间隔，默认 2 秒。 */
  readonly retryMs?: number
  /** 领取失败的提示输出，默认 stderr。 */
  readonly log?: (line: string) => void
  /** 同类领取失败的重复提示间隔，默认 5 分钟（首次立即提示）。 */
  readonly logIntervalMs?: number
  readonly signal?: AbortSignal
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

type GatewayClient = Pick<OutboundRunnerOptions, 'controlPlaneUrl' | 'signingKey' | 'controlPlanePublicKey'> & { runnerId: string }

/** 一次网关请求：签名 → 发送 → 验应答签名 → 校验契约。401 与验签失败都抛错，调用方按未送达处理。 */
export const gatewayCall = async (opts: GatewayClient,
  path: '/v1/gateway/claim' | '/v1/gateway/reports', body: object, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; message: RunnerGatewayMessageV1 }> => {
  const url = new URL(path, opts.controlPlaneUrl)
  const payload = JSON.stringify(body)
  const headers = signRunnerRequest({ privateKey: opts.signingKey, method: 'POST', target: url.pathname + url.search, audience: opts.runnerId, body: payload, scheme: 'gateway' })
  return gatewayReply(opts, await send(url, { 'content-type': 'application/json', ...headers }, payload, timeoutMs, signal), headers)
}

/**
 * 流式上传一个产物（runner-gateway.v1 artifactUpload）：元数据（租约、sha256、长度）在签名覆盖的查询串里，
 * x-cmap-content-sha256 即产物 sha256，字节作请求体流出；控制面边收边算，不符即拒收不落盘。
 */
export const gatewayUpload = async (opts: GatewayClient, art: { lease_id: string; sha256: string; size_bytes: number },
  body: Readable, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; message: RunnerGatewayMessageV1 }> => {
  const query = new URLSearchParams({ lease_id: art.lease_id, sha256: art.sha256, size: String(art.size_bytes) })
  const url = new URL(`/v1/gateway/artifacts?${query}`, opts.controlPlaneUrl)
  const headers = signRunnerRequest({ privateKey: opts.signingKey, method: 'POST', target: url.pathname + url.search, audience: opts.runnerId, contentSha256: art.sha256, scheme: 'gateway' })
  return gatewayReply(opts, await send(url, { 'content-type': 'application/octet-stream', ...headers }, body, timeoutMs, signal), headers)
}

type RawReply = { status: number; signature: string | null; bytes: Buffer }

/**
 * 网关请求走 node:http/https（HTTP/1.1 keep-alive 全局 Agent），不用 fetch：Node 26 的 undici 8 对 https 默认协商 HTTP/2，
 * 长轮询 claim 在途时同一连接上的带体 POST 被排到 claim 返回之后才发出，签名过期被 401（2026-10-23 生产实测）。
 * HTTP/1.1 Agent 不把请求排在忙碌的连接上，claim 与其余请求各占一条连接，签名后即发出。
 */
const send = (url: URL, headers: Record<string, string>, body: string | Readable, timeoutMs: number, signal?: AbortSignal): Promise<RawReply> =>
  new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST', headers,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode!, signature: (res.headers['x-cmap-signature'] as string | undefined) ?? null, bytes: Buffer.concat(chunks) }))
      res.on('error', reject)
      res.on('close', () => { if (!res.complete) reject(new Error('response aborted')) })
    })
    req.on('error', reject)
    if (typeof body === 'string') req.end(body)
    else body.on('error', (error) => req.destroy(error)).pipe(req)
  })

const gatewayReply = (opts: GatewayClient, { status, signature, bytes }: RawReply, headers: Record<string, string>): { status: number; message: RunnerGatewayMessageV1 } => {
  if (status === 401) throw new GatewayRejectedError('UNAUTHORIZED')
  verifyRunnerResponse({
    publicKey: opts.controlPlanePublicKey, audience: opts.runnerId, requestNonce: headers['x-cmap-nonce']!,
    status, body: bytes, signature, scheme: 'gateway',
  })
  const message: unknown = JSON.parse(bytes.toString('utf8'))
  if (!validateGatewayMessage(message)) throw new GatewayRejectedError('PROTOCOL_INVALID')
  return { status, message }
}

export const startOutboundRunner = (opts: OutboundRunnerOptions) => {
  const { core } = opts
  const runnerId = core.runner.runner_id
  const waitSeconds = opts.waitSeconds ?? 50
  const statusIntervalMs = opts.statusIntervalMs ?? 2_000
  const retryMs = opts.retryMs ?? 2_000
  const signal = opts.signal
  const log = opts.log ?? ((line: string): void => console.error(line))
  const logIntervalMs = opts.logIntervalMs ?? 300_000
  const lastLogged = new Map<string, number>()
  /** 领取失败不再静默：同类错误首次提示，之后每隔 logIntervalMs 才再提示，避免每次重试刷屏。 */
  const logClaimFailure = (error: unknown): void => {
    if (signal?.aborted) return
    const rejected = error instanceof GatewayRejectedError ? error.message : undefined
    const text = rejected === 'UNAUTHORIZED'
      ? '领取任务被控制面拒绝（401 鉴权失败）：登记已吊销，或 CMAP_CONTROL_PLANE_URL / 登记文件 / 密钥不属于该服务端；请核对后重启'
      : `领取任务失败：${error instanceof Error ? error.message : String(error)}`
    const now = Date.now()
    if (now - (lastLogged.get(text) ?? -Infinity) < logIntervalMs) return
    lastLogged.set(text, now)
    log(`[${new Date(now).toISOString()}] ${opts.controlPlaneUrl} ${text}`)
  }
  const client = { ...opts, runnerId }
  /** 本机仍在执行、需要续租的租约 → remote_task_id（受理前为 null）。 */
  const held = new Map<string, string | null>()

  const drop = (leaseId: string, reason: string): void => {
    const remote = held.get(leaseId)
    held.delete(leaseId)
    if (remote) void core.cancel(remote, reason).catch(() => undefined)
  }

  /** 回报直到被控制面确认；租约已过期或不认这条租约就停掉本机执行、不再回报。返回 false 表示应停止跟踪。 */
  const report = async (leaseId: string, body: ReportBody): Promise<boolean> => {
    while (!signal?.aborted && held.has(leaseId)) {
      try {
        const { message } = await gatewayCall(client, '/v1/gateway/reports', { schema: SCHEMA, kind: 'report', runner_id: runnerId, lease_id: leaseId, body }, 120_000, signal)
        if (message.kind === 'report_ack') return message.lease !== null
        if (message.kind === 'error' && (message.code === 'LEASE_EXPIRED' || message.code === 'LEASE_UNKNOWN')) {
          drop(leaseId, message.code)
          return false
        }
      } catch {
        /* 未送达：租约仍由领取循环续着，稍后重报 */
      }
      await sleep(retryMs, signal)
    }
    return false
  }

  /**
   * 回报结果前逐个上传流式产物。返回 undefined 表示全部已被控制面核验接收；返回 error 体表示应改报该错误；
   * 返回 null 表示租约已不归本 runner，停止跟踪。网络失败有限次重试（上限可能两侧配置不一致，不能无限重传）。
   */
  const upload = async (leaseId: string, remoteTaskId: string, artifacts: ReportBody & { kind: 'result' }): Promise<ReportBody | null | undefined> => {
    for (const art of artifacts.artifacts) {
      if (!('sha256' in art)) continue
      for (let attempt = 1; ; attempt += 1) {
        if (signal?.aborted || !held.has(leaseId)) return null
        let stream: Readable | undefined
        try {
          stream = (await core.openArtifact(remoteTaskId, art.sha256)).stream
          const { message } = await gatewayUpload(client, { lease_id: leaseId, sha256: art.sha256, size_bytes: art.size_bytes }, stream, 600_000, signal)
          if (message.kind === 'upload_ack' && message.sha256 === art.sha256) break
          if (message.kind === 'error' && (message.code === 'LEASE_EXPIRED' || message.code === 'LEASE_UNKNOWN')) {
            drop(leaseId, message.code)
            return null
          }
          if (message.kind === 'error' && message.code.startsWith('EVIDENCE_')) return toRunnerError(new AdapterError(message.code, message.code, false, `gateway-upload:${message.code}`))[1] as ReportBody
        } catch (error) {
          if (error instanceof AdapterError) return toRunnerError(error)[1] as ReportBody
          /* 未送达：稍后重传 */
        } finally {
          stream?.destroy()
        }
        if (attempt >= 5) return toRunnerError(new AdapterError('EVIDENCE_UPLOAD_FAILED', 'EVIDENCE_UPLOAD_FAILED', true, 'gateway-upload-failed'))[1] as ReportBody
        await sleep(retryMs, signal)
      }
    }
    return undefined
  }

  const execute = async ({ lease, dispatch }: Assignment): Promise<void> => {
    const leaseId = lease.lease_id
    held.set(leaseId, null)
    let accepted
    try {
      accepted = await core.dispatch(dispatch)
    } catch (error) {
      // 执行前的拒绝（许可、准入、输入）：什么都没执行，回报后关闭租约。
      await report(leaseId, toRunnerError(error)[1] as ReportBody)
      held.delete(leaseId)
      return
    }
    held.set(leaseId, accepted.remote_task_id)
    if (!(await report(leaseId, accepted))) return
    let last: string | undefined
    while (!signal?.aborted && held.has(leaseId)) {
      let terminal = false
      try {
        const status = await core.status(accepted.remote_task_id)
        const key = `${status.status}:${status.terminal_observed}`
        if (key !== last && !(await report(leaseId, status))) return
        last = key
        terminal = status.terminal_observed
      } catch (error) {
        await report(leaseId, toRunnerError(error)[1] as ReportBody)
        held.delete(leaseId)
        return
      }
      if (terminal) {
        let outcome: ReportBody
        try { outcome = await core.result(accepted.remote_task_id) } catch (error) { outcome = toRunnerError(error)[1] as ReportBody }
        if (outcome.kind === 'result') {
          const failed = await upload(leaseId, accepted.remote_task_id, outcome)
          if (failed === null) return
          if (failed) outcome = failed
        }
        await report(leaseId, outcome)
        held.delete(leaseId)
        return
      }
      await sleep(statusIntervalMs, signal)
    }
  }

  const running = new Set<Promise<void>>()
  const loop = async (): Promise<void> => {
    while (!signal?.aborted) {
      let reply: ClaimResult
      try {
        const { message } = await gatewayCall(client, '/v1/gateway/claim', {
          schema: SCHEMA, kind: 'claim', runner_id: runnerId, wait_seconds: waitSeconds, held_leases: [...held.keys()],
        }, (waitSeconds + 15) * 1000, signal)
        if (message.kind !== 'claim_result' || message.runner_id !== runnerId) throw new GatewayRejectedError('PROTOCOL_INVALID')
        reply = message
      } catch (error) {
        logClaimFailure(error)
        await sleep(retryMs, signal)
        continue
      }
      for (const id of reply.expired) if (held.has(id)) drop(id, 'LEASE_EXPIRED')
      for (const { lease_id, cancel } of reply.cancels) {
        if (held.get(lease_id) === cancel.remote_task_id) void core.cancel(cancel.remote_task_id, cancel.reason).catch(() => undefined)
      }
      if (reply.assignment && !held.has(reply.assignment.lease.lease_id)) {
        const job = execute(reply.assignment).catch(() => undefined)
        running.add(job)
        void job.finally(() => running.delete(job))
      }
    }
    await Promise.all(running)
  }

  return { done: loop(), held: (): string[] => [...held.keys()] }
}
