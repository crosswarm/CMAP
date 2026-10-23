/**
 * runner 出站模式（ADR-0008 §3，契约 runner-gateway.v1）：runner 主动长轮询控制面领取任务、回报状态与结果。
 * 控制面从不连 runner，NAT 后的笔记本可直接用。执行核心与监听模式相同（createRunnerCore：验许可 → 准入 → 落地输入 → CodexAdapter）。
 *
 * 每个请求用登记的 Ed25519 私钥签名；每个应答用登记时固定的控制面公钥验签，验不过即不采信（不执行、不当作已送达）。
 * 控制面判过期的租约：停掉本机执行、不再回报。领取期间断网只会让租约过期，由控制面判执行不确定，绝不在这里重跑。
 */
import type { KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { validateEnrollmentMessage, validateGatewayMessage, type RunnerEnrollmentMessageV1, type RunnerGatewayMessageV1 } from '#domain-model'
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
  readonly signal?: AbortSignal
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

/** 一次网关请求：签名 → 发送 → 验应答签名 → 校验契约。401 与验签失败都抛错，调用方按未送达处理。 */
export const gatewayCall = async (opts: Pick<OutboundRunnerOptions, 'controlPlaneUrl' | 'signingKey' | 'controlPlanePublicKey'> & { runnerId: string },
  path: '/v1/gateway/claim' | '/v1/gateway/reports', body: object, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; message: RunnerGatewayMessageV1 }> => {
  const url = new URL(path, opts.controlPlaneUrl)
  const payload = JSON.stringify(body)
  const headers = signRunnerRequest({ privateKey: opts.signingKey, method: 'POST', target: url.pathname + url.search, audience: opts.runnerId, body: payload, scheme: 'gateway' })
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  })
  const bytes = Buffer.from(await res.arrayBuffer())
  if (res.status === 401) throw new GatewayRejectedError('UNAUTHORIZED')
  verifyRunnerResponse({
    publicKey: opts.controlPlanePublicKey, audience: opts.runnerId, requestNonce: headers['x-cmap-nonce']!,
    status: res.status, body: bytes, signature: res.headers.get('x-cmap-signature'), scheme: 'gateway',
  })
  const message: unknown = JSON.parse(bytes.toString('utf8'))
  if (!validateGatewayMessage(message)) throw new GatewayRejectedError('PROTOCOL_INVALID')
  return { status: res.status, message }
}

export const startOutboundRunner = (opts: OutboundRunnerOptions) => {
  const { core } = opts
  const runnerId = core.runner.runner_id
  const waitSeconds = opts.waitSeconds ?? 50
  const statusIntervalMs = opts.statusIntervalMs ?? 2_000
  const retryMs = opts.retryMs ?? 2_000
  const signal = opts.signal
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
      } catch {
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
