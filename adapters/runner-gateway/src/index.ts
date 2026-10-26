/**
 * Gateway Runner Adapter — Worker 经出站网关把任务交给已登记的 runner（ADR-0008 §3）。
 *
 * 与 RemoteRunnerAdapter 同等的安全语义，只换传输：派发写进网关队列（PostgreSQL，与 API 共用账本），
 * runner 主动长轮询领取、回报；本 Adapter 只读写账本，从不连 runner。
 *  1. 派发许可受众绑定所选 runner_id 与本 Adapter；runner 用固定的控制面许可公钥验签，拒绝即不执行。
 *  2. runner 的每个回报由 API 用其登记公钥验签后才落账（runner-gateway.v1 requestAuthHeaders）；
 *     这里只采信已落账的回报，产物仍落盘后独立复算 sha256（materializeRemoteResult），不采信自报哈希。
 *     流式产物（M09）只认在本租约下经 API 核验登记的上传：别处已有同哈希的内容不能被结果借用。
 *  3. 执行不确定不改派、不重跑：租约过期、runner 被吊销、租约丢失都报 BINDING_NOT_FOUND，由控制面走既有不确定路径。
 *  4. 入队后等受理超时：撤回（未领取的永不下发；已领取的转为取消）并报不可达，Activity 照旧按 DISPATCH_UNCERTAIN 升级。
 */
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'

import type { RemoteTaskBinding, RiskLevel, Store, TaskEnvelopeV1, TaskResultV1 } from '#domain-model'
import { RISK_LEVELS, RunnerAdmissionError, isLeaseExpired, type GatewayLease } from '#domain-model'
import type {
  AdapterAuthorization, AdapterDescriptor, AdapterHealth, AgentAdapter, AgentInput, DispatchContext,
  NormalizedAgentEvent, NormalizedAgentStatus, SubscriptionHandle,
} from '#adapter-sdk'
import { AdapterError, assertAdapterAuthorization, snapshotAdapterAuthorization, snapshotDispatchContext } from '#adapter-sdk'
import { materializeRemoteResult, raiseRemoteError, readFrozenInputs } from '../../remote-runner/src/index.ts'
import { leaseUploadPath } from '../../../packages/adapter-sdk/src/content-store.ts'

export const GATEWAY_ADAPTER_ID = 'gateway-runner-adapter'
const RR = 'cmap/remote-runner/v1'
const REMOTE_TASK_ID = /^codex:([A-Za-z0-9][A-Za-z0-9._:-]{0,127}):([1-9][0-9]{0,15})$/

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const unreachable = (): AdapterError =>
  new AdapterError('REMOTE_UNREACHABLE', '出站 runner 未在期限内受理派发', true, 'gateway-accept-timeout')
const protocolInvalid = (): AdapterError =>
  new AdapterError('REMOTE_PROTOCOL_INVALID', '出站 runner 回报与派发不符', false, 'remote-protocol-invalid')
const uncertain = (id: string, why: string): AdapterError =>
  new AdapterError('BINDING_NOT_FOUND', `出站 runner ${why}，执行不确定，不重跑：${id}`, false, `gateway-${why}`)

/** 一个 binding 只对应一条租约：同一任务修订、同一 runner 的派发重试落到同一 lease_id（入队幂等）。 */
export const gatewayLeaseId = (binding: Pick<RemoteTaskBinding, 'runner_id' | 'remote_task_id'>): string =>
  `lse_${createHash('sha256').update(`${binding.runner_id}\0${binding.remote_task_id}`).digest('hex').slice(0, 40)}`

export interface GatewayRunnerAdapterOptions {
  readonly authorization: AdapterAuthorization
  /** 与 API 共用的账本：网关队列、租约与 runner 登记记录。 */
  readonly store: Store
  /** 路由用的 Agent ID，例如 `codex@gateway`。 */
  readonly agentId: string
  /** 控制面工作区根：输入从 `<workRoot>/<taskId>` 读取，产物落到同一目录。 */
  readonly workRoot: string
  readonly capabilities: readonly string[]
  readonly riskCeiling?: RiskLevel
  /** runner 最近多久内通过过认证才算在线，默认 120 秒（长轮询 50 秒加余量）。 */
  readonly onlineWindowMs?: number
  /** 入队后等 runner 受理的上限，默认 60 秒（须长于一次长轮询）。 */
  readonly acceptTimeoutMs?: number
  readonly pollIntervalMs?: number
  readonly now?: () => number
}

export class GatewayRunnerAdapter implements AgentAdapter {
  readonly adapterId = GATEWAY_ADAPTER_ID
  /** binding 只含 remote_task_id 与 runner_id，状态全在账本：Worker 重启后据 binding 继续观察，绝不重发。 */
  readonly restartSafe = true
  readonly reportDriven = true
  readonly agentId: string
  readonly authorizationMode: AdapterAuthorization['mode']

  readonly #authorization: AdapterAuthorization
  readonly #store: Store
  readonly #workRoot: string
  readonly #capabilities: readonly string[]
  readonly #riskCeiling: RiskLevel
  readonly #onlineWindowMs: number
  readonly #acceptTimeoutMs: number
  readonly #pollIntervalMs: number
  readonly #now: () => number

  constructor(opts: GatewayRunnerAdapterOptions) {
    this.#authorization = snapshotAdapterAuthorization(opts.authorization)
    this.authorizationMode = this.#authorization.mode
    this.#store = opts.store
    this.agentId = opts.agentId
    this.#workRoot = opts.workRoot
    this.#capabilities = Object.freeze([...opts.capabilities])
    this.#riskCeiling = opts.riskCeiling ?? 'mutating'
    this.#onlineWindowMs = opts.onlineWindowMs ?? 120_000
    this.#acceptTimeoutMs = opts.acceptTimeoutMs ?? 60_000
    this.#pollIntervalMs = opts.pollIntervalMs ?? 250
    this.#now = opts.now ?? Date.now
  }

  async discover(): Promise<AdapterDescriptor> {
    return {
      adapter_id: GATEWAY_ADAPTER_ID, agent_id: this.agentId, provider: 'cmap-runner-gateway', version: '1',
      capabilities: [...this.#capabilities], risk_ceiling: this.#riskCeiling,
      supports_session_resume: false, supports_worktree_isolation: true, execution_level: 'B',
    }
  }

  /**
   * 从本租户已登记、未吊销、在线的 runner 里挑一个能承接的；挑不到给出第一个不满足的原因，路由据此回落。
   * owner 亲和（ADR-0008 §5）：只挑任务 owner 本人登记的 runner（本人的提供方账号）；跨人共享默认禁止，不在此开放。
   */
  async runnerFor(envelope: TaskEnvelopeV1): Promise<{ runnerId: string } | { reason: string }> {
    const now = this.#now()
    let pool = (await this.#store.listGatewayRunners(envelope.identity.tenant ?? '')).filter((r) => r.revoked_at === null)
    if (!pool.length) return { reason: 'no_runner' }
    const required = RISK_LEVELS.indexOf(envelope.classification.risk_level)
    for (const [reason, keep] of [
      ['owner_mismatch', (r: typeof pool[number]) => r.owner === envelope.identity.owner],
      ['capability_mismatch', (r: typeof pool[number]) => r.allowed_capabilities.includes(envelope.classification.requested_capability)],
      ['risk_exceeded', (r: typeof pool[number]) => required >= 0 && RISK_LEVELS.indexOf(r.max_risk) >= required],
      ['unhealthy', (r: typeof pool[number]) => r.last_seen_at !== null && now - Date.parse(r.last_seen_at) <= this.#onlineWindowMs],
    ] as const) {
      pool = pool.filter(keep)
      if (!pool.length) return { reason }
    }
    pool.sort((a, b) => Date.parse(b.last_seen_at!) - Date.parse(a.last_seen_at!))
    return { runnerId: pool[0]!.runner_id }
  }

  prepareBinding(envelope: TaskEnvelopeV1, ctx: DispatchContext): RemoteTaskBinding {
    return {
      adapter: GATEWAY_ADAPTER_ID,
      remote_task_id: `codex:${envelope.identity.task_id}:${envelope.identity.revision}`,
      protocol: 'cmap-runner-gateway',
      protocol_version: '1',
      runner_id: ctx.runner_id,
    }
  }

  async startTask(envelope: TaskEnvelopeV1, ctx: DispatchContext): Promise<RemoteTaskBinding> {
    const frozenEnvelope = structuredClone(envelope)
    const frozenCtx = snapshotDispatchContext(ctx)
    assertAdapterAuthorization(this.#authorization, frozenEnvelope, frozenCtx, GATEWAY_ADAPTER_ID)
    const binding = this.prepareBinding(frozenEnvelope, frozenCtx)
    const runner = await this.#store.getGatewayRunner(frozenCtx.runner_id)
    // 路由与派发之间 runner 可能被吊销：发送意图前的确定性拒绝，按准入拒绝落账、不重发。
    if (!runner || runner.revoked_at !== null) throw new RunnerAdmissionError('INVALID_RUNNER')
    if (runner.tenant !== frozenEnvelope.identity.tenant) throw new RunnerAdmissionError('TENANT_DENIED')
    if (runner.owner !== frozenEnvelope.identity.owner) throw new RunnerAdmissionError('OWNER_DENIED')
    const inputs = await readFrozenInputs(frozenEnvelope, frozenCtx)
    await frozenCtx.beforeSend?.(binding)
    assertAdapterAuthorization(this.#authorization, frozenEnvelope, frozenCtx, GATEWAY_ADAPTER_ID)

    const leaseId = gatewayLeaseId(binding)
    await this.#store.enqueueGatewayLease({
      lease_id: leaseId, runner_id: binding.runner_id, task_id: frozenEnvelope.identity.task_id, remote_task_id: binding.remote_task_id,
      created_at: new Date(this.#now()).toISOString(),
      dispatch: {
        schema: RR, kind: 'dispatch', runner_id: binding.runner_id, permit: frozenCtx.token, envelope: frozenEnvelope,
        trace_id: frozenCtx.trace_id, correlation_id: frozenCtx.correlation_id, deadline_at: frozenCtx.deadline_at, inputs,
      },
    })
    for (const until = this.#now() + this.#acceptTimeoutMs; ;) {
      const lease = await this.#store.getGatewayLease(leaseId)
      const accepted = lease?.accepted
      if (accepted?.kind === 'error') raiseRemoteError(accepted)
      if (accepted?.kind === 'dispatch_accepted') {
        if (accepted.remote_task_id !== binding.remote_task_id || accepted.runner_id !== binding.runner_id) throw protocolInvalid()
        return binding
      }
      if (!lease || lease.state === 'closed') throw unreachable()
      if (this.#now() >= until) {
        await this.#store.cancelGatewayLease(leaseId, this.#cancelMessage(binding, 'ACCEPT_TIMEOUT'), new Date(this.#now()).toISOString())
        throw unreachable()
      }
      await sleep(this.#pollIntervalMs)
    }
  }

  async sendInput(_binding: RemoteTaskBinding, input: AgentInput): Promise<void> {
    throw new AdapterError('INPUT_NOT_SUPPORTED', `出站 runner 上的 codex exec 为非交互模式（kind=${input.kind}）`, false, 'remote-no-stdin')
  }

  async getStatus(binding: RemoteTaskBinding): Promise<NormalizedAgentStatus> {
    const { id, lease } = await this.#lease(binding)
    const at = new Date(this.#now()).toISOString()
    if (lease.state === 'closed') {
      const status = lease.outcome?.kind === 'result'
        ? (lease.status?.kind === 'status' && lease.status.terminal_observed ? lease.status.status : 'completed')
        : lease.outcome ? 'failed' : 'canceled'
      return { status, at, terminal_observed: true }
    }
    // 在途租约：runner 被吊销或租约过期都按执行不确定处理，不等、不改派。
    const runner = await this.#store.getGatewayRunner(binding.runner_id)
    if (!runner || runner.revoked_at !== null) throw uncertain(id, 'runner-revoked')
    if (isLeaseExpired(lease, this.#now())) throw uncertain(id, 'lease-expired')
    if (lease.state === 'queued') return { status: 'queued', at, terminal_observed: false }
    return { status: lease.status?.kind === 'status' ? lease.status.status : 'running', at, terminal_observed: false }
  }

  async subscribe(binding: RemoteTaskBinding, _onEvent: (event: NormalizedAgentEvent) => Promise<void>): Promise<SubscriptionHandle> {
    this.#own(binding)
    return { unsubscribe: async () => {} }
  }

  async cancel(binding: RemoteTaskBinding, reason: string): Promise<void> {
    const id = this.#own(binding)
    const lease = await this.#store.cancelGatewayLease(gatewayLeaseId(binding), this.#cancelMessage(binding, reason), new Date(this.#now()).toISOString())
    if (!lease) throw uncertain(id, 'lease-missing')
  }

  async collectResult(binding: RemoteTaskBinding): Promise<TaskResultV1> {
    const { id, lease } = await this.#lease(binding)
    if (lease.state !== 'closed') throw new AdapterError('RESULT_NOT_READY', '出站 runner 尚未回报终态', true, 'gateway-result-not-ready')
    const outcome = lease.outcome
    if (outcome?.kind === 'result') {
      const leaseId = gatewayLeaseId(binding)
      return materializeRemoteResult(this.#workRoot, id, outcome, async (art, role) => {
        const file = leaseUploadPath(this.#workRoot, leaseId, art.sha256)
        // 字节一致性在复制进任务目录后由 materializeRemoteResult 再独立复算
        if (!(await lstat(file).catch(() => undefined))?.isFile()) {
          throw new AdapterError('EVIDENCE_FILE_MISSING', `远程产物未在本租约下经核验上传：${role}`, false, `evidence-missing:${role}`)
        }
        return file
      })
    }
    if (outcome?.kind === 'error') {
      throw new AdapterError(outcome.code, `出站 runner 报告：${outcome.category}:${outcome.code}`, outcome.retryable, `remote:${outcome.code}`)
    }
    throw new AdapterError('TASK_CANCELED', '派发在 runner 领取前已撤回', false, 'gateway-withdrawn')
  }

  async health(): Promise<AdapterHealth> {
    const checked = await this.#store.healthCheck()
    // 出站 runner 随领取上报的额度（ADR-0009）：取读到了的（ok）里最新的一份，没有就不带，路由按未知处理。
    // 池里多个 runner 共用一个 Agent 路由，这里不区分账号；同一账号的多 runner 本就是一个额度池。
    const quotas = await this.#store.listGatewayRunnerQuotas()
    const quota = [...quotas].sort((a, b) => Number(b.status === 'ok') - Number(a.status === 'ok') || Date.parse(b.observed_at) - Date.parse(a.observed_at))[0]
    return { state: checked.ok ? 'healthy' : 'unavailable', checked_at: new Date(this.#now()).toISOString(), ...(quota ? { quota } : {}) }
  }

  #cancelMessage(binding: RemoteTaskBinding, reason: string) {
    return { schema: RR, kind: 'cancel', remote_task_id: binding.remote_task_id, reason: reason.slice(0, 256) || 'canceled' } as const
  }

  async #lease(binding: RemoteTaskBinding): Promise<{ id: string; lease: GatewayLease }> {
    const id = this.#own(binding)
    const lease = await this.#store.getGatewayLease(gatewayLeaseId(binding))
    if (!lease || lease.runner_id !== binding.runner_id || lease.remote_task_id !== id) throw uncertain(id, 'lease-missing')
    return { id, lease }
  }

  #own(binding: RemoteTaskBinding): string {
    if (binding.adapter !== GATEWAY_ADAPTER_ID || !REMOTE_TASK_ID.test(binding.remote_task_id)) {
      throw new AdapterError('BINDING_INVALID', 'binding 不属于出站网关', false, 'gateway-binding-invalid')
    }
    return binding.remote_task_id
  }
}
