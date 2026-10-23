import { spawn, type ChildProcess } from 'node:child_process'
import { terminateOwnedProcessGroup, type OwnedProcessGroupTermination } from '../../../packages/adapter-sdk/src/process-group.ts'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  RemoteTaskBinding,
  RiskLevel,
  TaskEnvelopeV1,
  TaskResultV1,
} from '#domain-model'
import type {
  AdapterAuthorization,
  AdapterDescriptor,
  AdapterHealth,
  AgentAdapter,
  AgentInput,
  DispatchContext,
  NormalizedAgentEvent,
  NormalizedAgentStatus,
  SubscriptionHandle,
} from '#adapter-sdk'
import {
  AdapterError,
  RiskCeilingExceededError,
  assertAdapterAuthorization,
  snapshotAdapterAuthorization,
  snapshotDispatchContext,
} from '#adapter-sdk'
import {
  normalizeAgentOutput,
  renderTaskPrompt,
} from '../../../packages/adapter-sdk/src/structured-output.ts'
import { providerBaseEnv } from '../../../packages/adapter-sdk/src/provider-env.ts'
import { prepareKimiRun, resolveKimiBin } from './runtime.ts'

const ADAPTER_ID = 'kimi-adapter'
const AGENT_ID = 'kimi'
const ADAPTER_VERSION = '0.1.0'
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_STDERR_BYTES = 16 * 1024
const RISK_ORDER: readonly RiskLevel[] = [
  'read-meta',
  'read-sensitive',
  'controlled',
  'mutating',
]


export interface KimiAdapterOptions {
  readonly authorization: AdapterAuthorization
  readonly bin?: string
  readonly sandboxBin?: string
  readonly credentialHome?: string
  readonly idempotencyStore?: Map<string, Promise<RemoteTaskBinding>>
}

interface RunState {
  readonly child: ChildProcess
  readonly envelope: TaskEnvelopeV1
  readonly workDir: string
  readonly runtimeDir: string
  readonly ownsWorkDir: boolean
  readonly events: NormalizedAgentEvent[]
  readonly listeners: Set<(event: NormalizedAgentEvent) => Promise<void>>
  readonly timeout: NodeJS.Timeout
  termination: OwnedProcessGroupTermination | null
  exitCode: number | null
  signal: NodeJS.Signals | null
  settled: boolean
  timedOut: boolean
  canceled: boolean
  outputBytes: number
  outputOverflow: boolean
  stderrBytes: number
  stderrOverflow: boolean
  /** stderr 与非 JSON 输出的前 MAX_STDERR_BYTES 字节，只用于识别额度耗尽，不外露。 */
  diagnostic: string
  lastAssistant: string | null
  terminalStatus: NormalizedAgentStatus['status'] | null
  terminalDetail: string | undefined
  result: TaskResultV1 | null
  resultError: AdapterError | null
  runtimeCleaned: boolean
  readonly startedAt: number
  settledAt: number | null
  /** 仅来自 goal.summary.tokensUsed；kimi 2.2.0 普通 -p stream-json 不输出用量，此时保持 null，不估算。 */
  tokens: number | null
}

export class KimiAdapter implements AgentAdapter {
  readonly adapterId = ADAPTER_ID
  readonly agentId = AGENT_ID

  readonly #bin: string
  readonly #sandboxBin: string
  readonly #credentialHome: string | undefined
  readonly #authorization: AdapterAuthorization
  readonly authorizationMode: AdapterAuthorization['mode']
  readonly #runs = new Map<string, RunState>()
  readonly #idempotency: Map<string, Promise<RemoteTaskBinding>>

  constructor(opts: KimiAdapterOptions) {
    this.#authorization = snapshotAdapterAuthorization(opts.authorization)
    this.authorizationMode = this.#authorization.mode
    this.#bin = opts.bin ?? process.env['KIMI_BIN'] ?? 'kimi'
    this.#sandboxBin = opts.sandboxBin ?? 'sandbox-exec'
    this.#credentialHome = opts.credentialHome
    this.#idempotency = opts.idempotencyStore ?? new Map()
  }

  async discover(): Promise<AdapterDescriptor> {
    return {
      adapter_id: ADAPTER_ID,
      agent_id: AGENT_ID,
      provider: 'moonshot-kimi',
      version: ADAPTER_VERSION,
      capabilities: ['code.analyze', 'code.implement'],
      risk_ceiling: 'mutating',
      supports_session_resume: false,
      supports_worktree_isolation: true,
      execution_level: 'B',
    }
  }

  async startTask(
    envelope: TaskEnvelopeV1,
    ctx: DispatchContext,
  ): Promise<RemoteTaskBinding> {
    const frozenEnvelope = structuredClone(envelope)
    const frozenCtx = snapshotDispatchContext(ctx)
    assertAdapterAuthorization(this.#authorization, frozenEnvelope, frozenCtx, ADAPTER_ID)
    const key = frozenEnvelope.identity.idempotency_key
    const existing = this.#idempotency.get(key)
    if (existing) return existing

    const pending = this.#start(frozenEnvelope, frozenCtx).catch((err) => {
      this.#idempotency.delete(key)
      throw err
    })
    this.#idempotency.set(key, pending)
    return pending
  }

  prepareBinding(envelope: TaskEnvelopeV1, ctx: DispatchContext): RemoteTaskBinding {
    return {
      adapter: ADAPTER_ID,
      remote_task_id: `kimi:${envelope.identity.task_id}:${envelope.identity.revision}`,
      protocol: 'kimi-cli-stream-json',
      protocol_version: ADAPTER_VERSION,
      runner_id: ctx.runner_id,
    }
  }

  async #start(
    envelope: TaskEnvelopeV1,
    ctx: DispatchContext,
  ): Promise<RemoteTaskBinding> {
    const risk = envelope.classification.risk_level as RiskLevel
    const ceiling: RiskLevel = 'mutating'
    if (!isRiskWithin(risk, ceiling)) {
      throw new RiskCeilingExceededError(risk, ceiling, ADAPTER_ID)
    }
    if (envelope.execution_policy.model_policy) {
      throw new AdapterError(
        'MODEL_POLICY_UNSUPPORTED',
        'Kimi adapter 尚不支持 model_policy；不能静默忽略模型或努力度要求',
        false,
        'kimi-model-policy-unsupported',
      )
    }
    if (process.platform !== 'darwin' && this.#sandboxBin === 'sandbox-exec') {
      throw new AdapterError(
        'SANDBOX_UNAVAILABLE',
        'Kimi production adapter requires macOS sandbox-exec',
        false,
        'kimi-sandbox-non-darwin',
      )
    }

    const deadlineMs = computeTimeoutMs(envelope, ctx)
    const runtime = await prepareKimiRun(
      ctx.worktree,
      this.#credentialHome,
      this.#bin,
    )
    const binding = this.prepareBinding(envelope, ctx)
    let child: ChildProcess
    try {
      const prompt = await renderPrompt(envelope)
      const args = [
        '-p',
        runtime.sandboxProfile,
        this.#bin,
        '--agent-file',
        runtime.agentFile,
        '--skills-dir',
        runtime.skillsDir,
        '-p',
        prompt,
        '--output-format',
        'stream-json',
      ]
      await ctx.beforeSend?.(binding)
      assertAdapterAuthorization(this.#authorization, envelope, ctx, ADAPTER_ID)
      child = spawn(this.#sandboxBin, args, {
        cwd: runtime.workDir,
        detached: true,
        env: childEnv(runtime, envelope, ctx),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      await rm(runtime.runtimeDir, { recursive: true, force: true })
      throw error
    }

    const state: RunState = {
      child,
      envelope,
      workDir: runtime.workDir,
      runtimeDir: runtime.runtimeDir,
      ownsWorkDir: runtime.ownsWorkDir,
      events: [],
      listeners: new Set(),
      timeout: setTimeout(() => {
        state.timedOut = true
        state.termination ??= terminateOwnedProcessGroup(child)
      }, deadlineMs),
      termination: null,
      exitCode: null,
      signal: null,
      settled: false,
      timedOut: false,
      canceled: false,
      outputBytes: 0,
      outputOverflow: false,
      stderrBytes: 0,
      stderrOverflow: false,
      diagnostic: '',
      lastAssistant: null,
      terminalStatus: null,
      terminalDetail: undefined,
      result: null,
      resultError: null,
      runtimeCleaned: false,
      startedAt: Date.now(),
      settledAt: null,
      tokens: null,
    }
    this.#wire(state)

    this.#runs.set(binding.remote_task_id, state)
    return binding
  }

  #wire(state: RunState): void {
    const emit = (event: NormalizedAgentEvent): void => {
      state.events.push(event)
      for (const listener of state.listeners) void listener(event)
    }

    emit({ kind: 'started', at: new Date().toISOString() })

    const decoder = new StringDecoder('utf8')
    let buffer = ''
    const consumeLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed) return
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        keepDiagnostic(state, trimmed)
        emit({ kind: 'progress', at: new Date().toISOString() })
        return
      }
      emit(normalizeKimiEvent(parsed, state))
    }

    state.child.stdout?.on('data', (chunk: Buffer) => {
      state.outputBytes += chunk.byteLength
      if (state.outputBytes > MAX_OUTPUT_BYTES) {
        state.outputOverflow = true
        state.termination ??= terminateOwnedProcessGroup(state.child)
        return
      }
      buffer += decoder.write(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) consumeLine(line)
    })

    state.child.stderr?.on('data', (chunk: Buffer) => {
      state.stderrBytes += chunk.byteLength
      if (state.stderrBytes > MAX_STDERR_BYTES) state.stderrOverflow = true
      keepDiagnostic(state, chunk.toString('utf8'))
    })

    state.child.on('close', (code, signal) => {
      // Wrapper exit does not prove its ignored-stdio descendants have exited.
      state.termination ??= terminateOwnedProcessGroup(state.child)
      clearTimeout(state.timeout)
      buffer += decoder.end()
      consumeLine(buffer)
      state.exitCode = code
      state.signal = signal
      void finalizeState(state).then((event) => {
        state.settledAt = Date.now()
        emit(event)
      })
    })

    state.child.on('error', () => {
      clearTimeout(state.timeout)
      state.exitCode = -1
      state.resultError = new AdapterError(
        'TASK_FAILED',
        'Kimi process failed to start',
        true,
        'kimi-process-error',
      )
      state.terminalStatus = 'failed'
      state.terminalDetail = 'process error'
      state.settled = true
      emit({
        kind: 'failed',
        at: new Date().toISOString(),
        message: 'process error',
      })
    })
  }

  async sendInput(
    _binding: RemoteTaskBinding,
    input: AgentInput,
  ): Promise<void> {
    throw new AdapterError(
      'INPUT_NOT_SUPPORTED',
      `kimi -p 为单轮非交互模式，补充上下文请创建新任务（kind=${input.kind}）`,
      false,
      'kimi-no-stdin',
    )
  }

  async getStatus(binding: RemoteTaskBinding): Promise<NormalizedAgentStatus> {
    const state = this.#require(binding)
    const at = new Date().toISOString()
    if (!state.settled || (state.termination && !state.termination.confirmAbsent()))
      return { status: 'running', at, terminal_observed: false }
    return {
      status: state.terminalStatus ?? 'failed',
      at,
      terminal_observed: true,
      ...(state.terminalDetail ? { detail: state.terminalDetail } : {}),
    }
  }

  async subscribe(
    binding: RemoteTaskBinding,
    onEvent: (event: NormalizedAgentEvent) => Promise<void>,
  ): Promise<SubscriptionHandle> {
    const state = this.#require(binding)
    for (const event of state.events) await onEvent(event)
    state.listeners.add(onEvent)
    return {
      unsubscribe: async () => {
        state.listeners.delete(onEvent)
      },
    }
  }

  async cancel(binding: RemoteTaskBinding, reason: string): Promise<void> {
    const state = this.#require(binding)
    if (state.settled) return
    state.canceled = true
    state.terminalDetail = `canceled: ${reason}`
    state.termination ??= terminateOwnedProcessGroup(state.child)
    state.events.push({
      kind: 'failed',
      at: new Date().toISOString(),
      message: 'canceled',
    })
  }

  async collectResult(binding: RemoteTaskBinding): Promise<TaskResultV1> {
    const state = this.#require(binding)
    if (!state.settled || (state.termination && !state.termination.confirmAbsent())) {
      throw new AdapterError(
        'TASK_STILL_RUNNING',
        '任务尚未结束',
        true,
        'still-running',
      )
    }
    try {
      if (state.resultError) throw state.resultError
      if (!state.result) {
        throw new AdapterError(
          'RESULT_MISSING',
          'Kimi did not produce a result',
          false,
          'kimi-result-missing',
        )
      }
      return {
        ...state.result,
        // 成本计量（威胁模型 T8）：耗时为进程启动到退出；tokens 只在输出带用量时才有。
        cost: {
          ...(state.tokens !== null ? { tokens: state.tokens } : {}),
          duration_seconds: Math.round(((state.settledAt ?? Date.now()) - state.startedAt) / 100) / 10,
        },
      }
    } finally {
      if (!state.ownsWorkDir) await cleanupRuntime(state)
    }
  }

  async health(): Promise<AdapterHealth> {
    const at = new Date().toISOString()
    if (process.platform !== 'darwin' && this.#sandboxBin === 'sandbox-exec') {
      return {
        state: 'unavailable',
        checked_at: at,
        detail: 'macOS sandbox-exec unavailable',
      }
    }
    try {
      const bin = await resolveKimiBin(this.#bin)
      await verifyCredentialRefs(this.#credentialHome)
      const sandbox = await probeCommand(this.#sandboxBin, [
        '-p',
        '(version 1)(allow default)',
        '/usr/bin/true',
      ])
      if (sandbox.code !== 0) {
        return { state: 'unavailable', checked_at: at, detail: sandbox.detail }
      }
      const version = await probeCommand(bin, ['--version'])
      return version.code === 0
        ? { state: 'healthy', checked_at: at, detail: version.detail }
        : { state: 'unavailable', checked_at: at, detail: version.detail }
    } catch (e) {
      return { state: 'unavailable', checked_at: at, detail: String(e) }
    }
  }

  async cleanup(binding: RemoteTaskBinding): Promise<void> {
    const state = this.#require(binding)
    if (!state.settled) {
      throw new AdapterError(
        'TASK_STILL_RUNNING',
        '任务尚未结束，不能清理运行时',
        true,
        'still-running',
      )
    }
    await cleanupRuntime(state)
  }

  #require(binding: RemoteTaskBinding): RunState {
    const state = this.#runs.get(binding.remote_task_id)
    if (!state) {
      throw new AdapterError(
        'BINDING_NOT_FOUND',
        `未知 binding：${binding.remote_task_id}`,
        false,
        'binding-not-found',
      )
    }
    return state
  }
}

const isRiskWithin = (required: RiskLevel, ceiling: RiskLevel): boolean =>
  RISK_ORDER.indexOf(required) >= 0 &&
  RISK_ORDER.indexOf(ceiling) >= 0 &&
  RISK_ORDER.indexOf(required) <= RISK_ORDER.indexOf(ceiling)

const cleanupRuntime = async (state: RunState): Promise<void> => {
  if (state.runtimeCleaned) return
  await rm(state.runtimeDir, { recursive: true, force: true })
  state.runtimeCleaned = true
}

const computeTimeoutMs = (
  envelope: TaskEnvelopeV1,
  ctx: DispatchContext,
): number => {
  const policyMs = Math.max(1, envelope.execution_policy.timeout_seconds * 1000)
  const deadlineMs = Date.parse(ctx.deadline_at) - Date.now()
  if (!Number.isFinite(deadlineMs)) {
    throw new AdapterError(
      'INVALID_DEADLINE',
      '派发截止时间不是合法 ISO 时间',
      false,
      'kimi-invalid-deadline',
    )
  }
  if (deadlineMs <= 0) {
    throw new AdapterError(
      'DEADLINE_EXPIRED',
      '派发截止时间已过期',
      false,
      'kimi-deadline-expired',
    )
  }
  return Math.min(policyMs, deadlineMs)
}

const childEnv = (
  runtime: { homeDir: string; runtimeDir: string },
  envelope: TaskEnvelopeV1,
  ctx: DispatchContext,
): NodeJS.ProcessEnv => {
  return providerBaseEnv(process.env, {
    KIMI_CODE_HOME: runtime.homeDir,
    TMPDIR: runtime.runtimeDir,
    CMAP_TASK_ID: envelope.identity.task_id,
    CMAP_TRACE_ID: ctx.trace_id,
  })
}

const probeCommand = async (
  command: string,
  args: readonly string[],
): Promise<{ code: number | null; detail: string }> =>
  new Promise((resolve) => {
    let done = false
    const finish = (result: { code: number | null; detail: string }): void => {
      if (done) return
      done = true
      resolve(result)
    }
    const child = spawn(command, args, {
      env: providerBaseEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ code: null, detail: `${command} probe timeout` })
    }, 2000)
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({
        code,
        detail: out.trim() || err.trim() || `${command} exit ${code}`,
      })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ code: null, detail: String(e) })
    })
  })

const verifyCredentialRefs = async (credentialHome?: string): Promise<void> => {
  const home =
    credentialHome ??
    process.env['KIMI_CODE_HOME'] ??
    join(homedir(), '.kimi-code')
  await access(join(home, 'credentials/kimi-code.json'), constants.R_OK)
  await access(join(home, 'oauth'), constants.R_OK)
}

const keepDiagnostic = (state: RunState, text: string): void => {
  if (state.diagnostic.length < MAX_STDERR_BYTES) state.diagnostic = (state.diagnostic + text + '\n').slice(0, MAX_STDERR_BYTES)
}

/** ADR-0009 §3：HTTP 429 且带额度码或额度文案才算额度耗尽；普通 429 限流不算。 */
const isKimiQuotaExhausted = (text: string): boolean =>
  /\b429\b/.test(text) && (/exceeded_current_quota_error/.test(text) || /exceeded your current (token )?quota/i.test(text))

const finalizeState = async (
  state: RunState,
): Promise<NormalizedAgentEvent> => {
  const at = new Date().toISOString()
  const fail = (error: AdapterError, detail: string): NormalizedAgentEvent => {
    state.resultError = error
    state.terminalStatus = state.canceled ? 'canceled' : 'failed'
    state.terminalDetail = state.canceled
      ? (state.terminalDetail ?? 'canceled')
      : detail
    state.settled = true
    return { kind: 'failed', at, message: state.terminalDetail }
  }

  if (state.canceled) {
    return fail(
      new AdapterError(
        'TASK_CANCELED',
        'Kimi task was canceled',
        false,
        'kimi-canceled',
      ),
      'canceled',
    )
  }
  if (state.timedOut) {
    return fail(
      new AdapterError('TASK_FAILED', 'Kimi timed out', false, 'kimi-timeout'),
      'timeout',
    )
  }
  if (state.outputOverflow) {
    return fail(
      new AdapterError(
        'TASK_FAILED',
        'Kimi output exceeded limit',
        false,
        'kimi-output-limit',
      ),
      'output limit exceeded',
    )
  }
  if (state.exitCode !== 0 && isKimiQuotaExhausted(state.diagnostic)) {
    return fail(
      new AdapterError('QUOTA_EXHAUSTED', 'Kimi 报告额度已耗尽', false, 'quota-exhausted:kimi'),
      'quota exhausted',
    )
  }
  if (state.exitCode !== 0) {
    return fail(
      new AdapterError(
        'TASK_FAILED',
        'Kimi exited nonzero',
        false,
        `kimi-exit:${state.exitCode ?? state.signal}`,
      ),
      `exit ${state.exitCode ?? state.signal}`,
    )
  }
  if (!state.lastAssistant) {
    return fail(
      new AdapterError(
        'RESULT_MISSING',
        'Kimi did not emit assistant JSON',
        false,
        'kimi-result-missing',
      ),
      'missing result',
    )
  }

  let raw: unknown
  try {
    raw = JSON.parse(state.lastAssistant)
  } catch {
    const format = state.lastAssistant.trimStart().startsWith('```')
      ? 'fenced'
      : state.lastAssistant.trimStart().startsWith('{')
        ? 'invalid_json'
        : 'non_json'
    const hash = createHash('sha256').update(state.lastAssistant).digest('hex')
    return fail(
      new AdapterError(
        'RESULT_UNPARSABLE',
        `Kimi assistant content is not valid JSON (format=${format}, sha256=${hash})`,
        false,
        `kimi-result-unparsable:${format}`,
      ),
      'invalid result',
    )
  }

  try {
    state.result = await normalizeAgentOutput(
      raw,
      state.envelope,
      state.workDir,
    )
  } catch (e) {
    return fail(
      e instanceof AdapterError
        ? e
        : new AdapterError(
            'RESULT_INVALID',
            'Kimi result validation failed',
            false,
            'kimi-result-invalid',
          ),
      'invalid result',
    )
  }
  state.terminalStatus =
    state.result.status === 'completed'
      ? 'completed'
      : state.result.status === 'input_required'
        ? 'input_required'
        : state.result.status === 'auth_required'
          ? 'auth_required'
          : 'failed'
  state.terminalDetail =
    state.result.status === 'completed'
      ? undefined
      : (state.result.error?.code ?? state.result.status)
  state.settled = true
  if (state.terminalStatus === 'completed') return { kind: 'completed', at }
  return state.terminalDetail
    ? { kind: 'failed', at, message: state.terminalDetail }
    : { kind: 'failed', at }
}

const normalizeKimiEvent = (
  raw: unknown,
  state: RunState,
): NormalizedAgentEvent => {
  const at = new Date().toISOString()
  if (typeof raw !== 'object' || raw === null) return { kind: 'progress', at }
  const obj = raw as Record<string, unknown>
  const role = typeof obj['role'] === 'string' ? obj['role'] : ''
  const type = typeof obj['type'] === 'string' ? obj['type'] : role

  const used = obj['tokensUsed']
  if (type === 'goal.summary' && typeof used === 'number' && Number.isInteger(used) && used >= 0) state.tokens = used

  if (role === 'assistant' && typeof obj['content'] === 'string') {
    state.lastAssistant = obj['content']
    return { kind: 'progress', at, message: 'assistant_message' }
  }
  if (role === 'tool' || type.includes('tool')) {
    return {
      kind: 'tool_call',
      at,
      payload: { role: 'tool' },
    }
  }
  if (role === 'meta') return { kind: 'progress', at, message: 'meta' }
  return { kind: 'progress', at }
}

const renderPrompt = async (envelope: TaskEnvelopeV1): Promise<string> => {
  const schema = await readFile(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../schemas/codex-output.v1.schema.json',
    ),
    'utf8',
  )
  return `${renderTaskPrompt(envelope)}

## Output Schema JSON

${schema}

最终消息只能包含一个符合上述 schema 的 JSON 对象，从 { 开始到 } 结束。
不要 Markdown 代码围栏、前言、结语或完成提示；不要在 JSON 之后追加文字。
如果不能完成任务，也只返回该 JSON 结构，status 为 failed 并说明 error。`
}
