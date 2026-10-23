/**
 * runner 出站网关（ADR-0008 §3，契约 schemas/runner-gateway.v1.schema.json）。
 *
 * runner 发起全部请求，控制面从不连 runner：
 *  - POST /v1/gateway/claim   长轮询（≤ 50 秒）领取一条派发，同时续租 held_leases，并下发待取消
 *  - POST /v1/gateway/reports 回报一条 remote-runner.v1 应答（受理/状态/结果/错误），同时续租
 *
 * 认证先于读体与路由：按 x-cmap-runner-id 取登记记录（不存在或已吊销即拒），用登记公钥验签
 * （方法、路径、体 sha256、时间戳 ≤ 2 秒、nonce 单次）。任何一项不过都是同一个无签名 401，什么都不做。
 * 其余应答由控制面网关密钥签名，绑定所答请求的 nonce。身份（tenant/owner）只来自登记记录，不来自请求体。
 *
 * 结果先落账（租约关闭、结果入库）再向 Workflow 按门铃；门铃丢了 Workflow 靠超时回读兜底，所以发送失败只记录。
 */
import type { KeyObject } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { ed25519PublicKeyFromRaw, validateGatewayMessage, type GatewayLease, type Store, type RunnerGatewayMessageV1 } from '#domain-model'
import {
  GATEWAY_RUNNER_ID_HEADER, RUNNER_AUTH_HEADERS, RUNNER_AUTH_MAX_SKEW_MS, runnerBodySha256, signRunnerResponse, verifyRunnerRequest,
} from '../../../packages/domain-model/src/dispatch-permit.ts'

const SCHEMA = 'cmap/runner-gateway/v1'
const CLAIM_MAX_BYTES = 64 * 1024
/** 结果随回报内联产物字节（与 remote-runner.v1 同样的 base64 上限）。 */
const REPORT_MAX_BYTES = 64 * 1024 * 1024
const UNAUTHORIZED_BODY = JSON.stringify({ schema: SCHEMA, kind: 'error', code: 'UNAUTHORIZED', retryable: false })

export interface RunnerGatewayOptions {
  /** 控制面网关签名私钥（Ed25519）；runner 在登记时固定其公钥，用来验网关应答。 */
  readonly signingKey: KeyObject
  /** 租约期限，默认 120 秒：须长于一次长轮询（50 秒）加往返，runner 每次领取或回报都续租。 */
  readonly leaseTtlMs?: number
  /** 长轮询期间回读账本的间隔，默认 500 毫秒。 */
  readonly pollIntervalMs?: number
  readonly nowMs?: () => number
}

type Claim = Extract<RunnerGatewayMessageV1, { kind: 'claim' }>
type Report = Extract<RunnerGatewayMessageV1, { kind: 'report' }>

class Rejected extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}

/** 时间戳只容忍 ±2 秒，nonce 只需保留到窗口结束；只有通过验签的请求才入缓存。 */
const createNonceCache = (now: () => number) => {
  const seen = new Map<string, number>()
  return (key: string): boolean => {
    const t = now()
    for (const [k, expires] of seen) {
      if (expires > t && seen.size < 16_384) break
      seen.delete(k)
    }
    if (seen.has(key)) return false
    seen.set(key, t + 2 * RUNNER_AUTH_MAX_SKEW_MS + 1000)
    return true
  }
}

const readRaw = async (req: IncomingMessage, limit: number): Promise<Buffer | undefined> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) return undefined
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

const leaseView = (lease: GatewayLease) => ({ lease_id: lease.lease_id, expires_at: lease.expires_at! })

export const createRunnerGateway = (opts: RunnerGatewayOptions & {
  readonly store: Store
  readonly notifyRunnerReported?: (missionId: string, workflowId: string) => Promise<void>
}) => {
  const { store } = opts
  const now = opts.nowMs ?? Date.now
  const ttl = opts.leaseTtlMs ?? 120_000
  const pollMs = opts.pollIntervalMs ?? 500
  const firstUse = createNonceCache(now)

  const sendUnauthorized = (res: ServerResponse): void => {
    res.writeHead(401, { 'content-type': 'application/json', connection: 'close' }).end(UNAUTHORIZED_BODY)
  }

  const authenticate = async (req: IncomingMessage, target: string): Promise<{ runnerId: string; nonce: string; contentSha256: string } | undefined> => {
    try {
      const runnerId = req.headers[GATEWAY_RUNNER_ID_HEADER]
      if (typeof runnerId !== 'string') return undefined
      const runner = await store.getGatewayRunner(runnerId)
      if (!runner || runner.revoked_at !== null) return undefined
      const verified = verifyRunnerRequest({
        publicKey: ed25519PublicKeyFromRaw(runner.public_key), method: req.method ?? '', target, audience: runnerId,
        headers: req.headers, nowMs: now(), scheme: 'gateway',
      })
      return firstUse(`${runnerId}\n${verified.nonce}`) ? { runnerId, ...verified } : undefined
    } catch {
      return undefined
    }
  }

  const claim = async (msg: Claim, signal: AbortSignal) => {
    const at = now()
    const expiresAt = new Date(at + ttl).toISOString()
    const { renewed, expired } = await store.renewGatewayLeases(msg.runner_id, msg.held_leases, new Date(at).toISOString(), expiresAt)
    const held = renewed.map((lease) => lease.lease_id)
    const until = at + msg.wait_seconds * 1000
    for (;;) {
      // 连接已断就不再领取：领走却送不到的派发只能等租约过期判不确定。
      const assigned = signal.aborted ? null : await store.claimGatewayLease(msg.runner_id, new Date(now()).toISOString(), new Date(now() + ttl).toISOString())
      const cancels = []
      for (const id of held) {
        const lease = await store.getGatewayLease(id)
        if (lease?.state === 'leased' && lease.cancel) cancels.push({ lease_id: id, cancel: lease.cancel })
      }
      if (assigned || cancels.length || now() >= until || signal.aborted) {
        return {
          schema: SCHEMA, kind: 'claim_result', runner_id: msg.runner_id,
          renewed: renewed.map(leaseView), expired,
          assignment: assigned ? { lease: leaseView(assigned), dispatch: assigned.dispatch } : null,
          cancels,
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(pollMs, Math.max(0, until - now())))
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
    }
  }

  const report = async (msg: Report) => {
    const at = now()
    const out = await store.recordGatewayReport({
      runnerId: msg.runner_id, leaseId: msg.lease_id, body: msg.body,
      now: new Date(at).toISOString(), expiresAt: new Date(at + ttl).toISOString(),
    })
    if ('error' in out) throw new Rejected(out.error === 'INVALID_REQUEST' ? 400 : 409, out.error)
    const closed = out.lease.state === 'closed'
    if (closed && opts.notifyRunnerReported) {
      // 已落账：门铃丢了 Workflow 也会超时回读。
      try {
        const task = await store.getTask(out.lease.task_id)
        if (task) await opts.notifyRunnerReported(task.mission_id, `mission-${task.mission_id}`)
      } catch (error) {
        console.warn(`runnerReported 信号未送达 lease=${msg.lease_id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { schema: SCHEMA, kind: 'report_ack', lease_id: msg.lease_id, lease: closed ? null : leaseView(out.lease) }
  }

  return {
    handles: (path: string): boolean => path === '/v1/gateway/claim' || path === '/v1/gateway/reports',

    async handle(req: IncomingMessage, res: ServerResponse, url: URL, shutdown: AbortSignal): Promise<void> {
      const auth = await authenticate(req, url.pathname + url.search)
      if (!auth) return sendUnauthorized(res)
      const send = (status: number, body: object): void => {
        const bytes = Buffer.from(JSON.stringify(body), 'utf8')
        const signature = signRunnerResponse({ privateKey: opts.signingKey, audience: auth.runnerId, requestNonce: auth.nonce, status, body: bytes, scheme: 'gateway' })
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length, [RUNNER_AUTH_HEADERS.signature]: signature }).end(bytes)
      }
      const isClaim = url.pathname === '/v1/gateway/claim'
      try {
        const raw = await readRaw(req, isClaim ? CLAIM_MAX_BYTES : REPORT_MAX_BYTES)
        if (raw === undefined) throw new Rejected(413, 'INVALID_REQUEST')
        if (runnerBodySha256(raw) !== auth.contentSha256) return sendUnauthorized(res)
        let msg: unknown
        try { msg = JSON.parse(raw.toString('utf8')) } catch { throw new Rejected(400, 'INVALID_REQUEST') }
        if (req.method !== 'POST' || !validateGatewayMessage(msg) || msg.kind !== (isClaim ? 'claim' : 'report') ||
          (msg as Claim | Report).runner_id !== auth.runnerId) throw new Rejected(400, 'INVALID_REQUEST')
        await store.touchGatewayRunner(auth.runnerId, new Date(now()).toISOString())
        if (isClaim) {
          const gone = new AbortController()
          res.once('close', () => gone.abort())
          const reply = await claim(msg as Claim, AbortSignal.any([gone.signal, shutdown]))
          if (!res.destroyed) send(200, reply)
          return
        }
        send(200, await report(msg as Report))
      } catch (error) {
        if (res.headersSent || res.destroyed) return
        if (error instanceof Rejected) return send(error.status, { schema: SCHEMA, kind: 'error', code: error.code, retryable: false })
        send(500, { schema: SCHEMA, kind: 'error', code: 'INTERNAL', retryable: true })
      }
    },
  }
}
