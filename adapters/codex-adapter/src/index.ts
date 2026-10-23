/**
 * Codex Adapter — 把 codex CLI 归一化为 AgentAdapter。
 *
 * 依赖的两个实测能力：
 *   codex exec --output-schema <FILE>   强制最终响应符合 JSON Schema
 *   codex exec --json                   事件以 JSONL 输出，供 subscribe 消费
 *
 * 安全基线：本机 codex 默认 sandbox_mode=danger-full-access +
 * approval_policy=never。那是单机自用的设置，一旦接入多人总线等于把机器
 * 交给别人派发的任务。本 Adapter 一律显式传 -s，绝不继承默认档。
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { terminateOwnedProcessGroup, type OwnedProcessGroupTermination } from '../../../packages/adapter-sdk/src/process-group.ts'
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type {
  TaskEnvelopeV1,
  TaskResultV1,
  RemoteTaskBinding,
  RiskLevel,
  QuotaSnapshotV1,
} from '#domain-model'
import type {
  AgentAdapter,
  AdapterAuthorization,
  AdapterDescriptor,
  AdapterHealth,
  DispatchContext,
  AgentInput,
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
import { codexProviderEnv } from '../../../packages/adapter-sdk/src/provider-env.ts'

const ADAPTER_ID = 'codex-adapter'
const AGENT_ID = 'codex'
const ADAPTER_VERSION = '0.1.0'
/** 远程 runner（lap 上同一个 CodexAdapter）的静态描述复用这份清单。 */
export const CODEX_CAPABILITIES = [
  'code.implement',
  'code.analyze',
  'performance.root_cause',
  'yonwork.debug',
  'realdevice-validation',
] as const

/** codex 沙箱档位。绝不使用 danger-full-access。 */
type CodexSandbox = 'read-only' | 'workspace-write'

/**
 * 沙箱档位的选择依据是「是否需要写工作区」，与风险级别正交。
 *
 * 容易混淆的一点：低风险不等于只读沙箱。任何任务只要声明了证据产物，
 * 就必须能写文件——result 里的 artifact 需要真实 sha256，read-only
 * 沙箱下根本产不出证据。
 *
 * 两个维度各司其职：
 *   risk    → 是否需要人工审批、能访问哪些外部资源（permissions/forbidden）
 *   sandbox → 能否写自己的工作区
 *
 * 真正的隔离来自工作区位置（低风险用临时目录，mutating 用专用 worktree）
 * 与 permissions.forbidden，而非禁止写入。审批闸口在控制面，
 * Adapter 只负责不越权执行。
 */
const chooseSandbox = (envelope: TaskEnvelopeV1): CodexSandbox =>
  envelope.evidence_requirements.required_artifact_roles.length > 0
    ? 'workspace-write'
    : 'read-only'

/** 契约允许的四档。codex 恰好原生支持全部，无需降级映射。 */
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])


/**
 * 努力度档位非法。
 *
 * 实测：codex 收到 `-c model_reasoning_effort=bogus` 既不报错也不退出，
 * 直接用默认档位把任务跑完。因此这里必须拦住而不是透传——
 * 否则任务会以错误的档位产出结果，且没有任何信号说明发生过降级。
 */
export class InvalidEffortError extends AdapterError {
  constructor(effort: string) {
    super(
      'INVALID_EFFORT',
      `努力度档位 ${effort} 不在 low/medium/high/xhigh 之内；codex 对非法值静默套用默认档位，不能透传`,
      false,
      `invalid-effort:${effort}`,
    )
    this.name = 'InvalidEffortError'
  }
}

export interface CodexArgsOptions {
  readonly workDir: string
  readonly resultFile: string
  readonly outputSchemaPath: string
  readonly prompt: string
  /** runner 侧默认模型（lap 上 codex 内置默认不可用）。仅在信封无 model_policy 时以 -m 显式传入。 */
  readonly defaultModel?: string
}

/**
 * 构造 codex exec 的命令行参数。
 *
 * 独立成纯函数是为了能直接断言参数形状——这里的分支（沙箱档位、
 * model_policy 有无）出错时不会让进程失败，只会让任务用错误的配置跑完。
 */
export const buildCodexArgs = (
  envelope: TaskEnvelopeV1,
  opts: CodexArgsOptions,
): string[] => {
  const args = [
    'exec',
    '--ignore-user-config',
    '--ephemeral',
    '--json',
    '-s', chooseSandbox(envelope),
    '-C', opts.workDir,
    '--skip-git-repo-check',
    '--output-schema', opts.outputSchemaPath,
    '-o', opts.resultFile,
  ]

  // 没有 model_policy 就什么都不传：凭空造一个默认档位会悄悄覆盖
  // 用户在 config.toml 里的设置，而信封并未要求这么做。
  const policy = envelope.execution_policy.model_policy
  if (policy) {
    if (!EFFORTS.has(policy.effort)) throw new InvalidEffortError(policy.effort)
    // -c 的值按 TOML 解析，字符串必须带引号
    //
    // ⚠️ effort 的实际生效性未经证实。实测 codex v0.144.6 + chatgpt-http +
    // gpt-5.6-sol：low 与 xhigh 跑同一道需要推理的题，token 消耗分别是
    // 22,024 与 21,997——差异在噪声内。而且 codex 连 `-c 'k="unclosed'`
    // 这种 TOML 语法错误都不报错，所以「命令成功」不能证明配置被采纳。
    //
    // -m 是确证生效的（传 fake-model-xyz 时启动横幅如实显示该名字）。
    // 在拿到 effort 的生效证据前，UI 不得把它呈现为「已生效」，
    // 否则就是又造了一个假信号。
    args.push('-m', policy.model, '-c', `model_reasoning_effort="${policy.effort}"`)
  } else if (opts.defaultModel) {
    args.push('-m', opts.defaultModel)
  }

  args.push(opts.prompt)
  return args
}

/**
 * 运行记录：`<runsDir>/<taskId>.json`，启动 codex 前以独占方式（wx）创建。
 *
 * 记录先于进程存在——崩溃发生在“记录已写、pid 未落盘”之间时，我们无法知道进程是否已被拉起，
 * 只能判为执行不确定，而不是补启动。记录只含恢复所需的指针与信封的非正文子集，
 * 不含提示词正文（goal 等）。
 */
interface RunRecord {
  readonly schema: 'cmap/codex-run/v1'
  readonly remote_task_id: string
  readonly task_id: string
  readonly runner_id: string
  readonly pid: number | null
  /** `ps -o lstart=` 的值，用于排除 pid 复用；取不到则为 null。 */
  readonly process_start: string | null
  readonly started_at: string
  /** codex 命令行参数（含提示词）的 sha256，仅用于识别“同一 taskId 的不同启动意图”。 */
  readonly args_sha256: string
  readonly work_dir: string
  readonly owns_work_dir: boolean
  readonly result_file: string
  readonly stdout_file: string
  readonly stderr_file: string
  readonly envelope: ResultEnvelope
}

/** normalizeAgentOutput 实际用到的信封子集。 */
type ResultEnvelope = Pick<TaskEnvelopeV1, 'identity' | 'classification' | 'evidence_requirements'>

interface RunState {
  /** 本进程拉起的子进程；Worker 重启后从运行记录恢复的状态没有它。 */
  readonly child: ChildProcess | null
  readonly pid: number | null
  readonly processStart: string | null
  /** 从运行记录恢复（无子进程句柄、退出码未知）。 */
  readonly recovered: boolean
  /** 恢复态：进程退出后结果文件是否为完整 JSON。 */
  resultComplete: boolean
  /** 输出重定向到文件时的路径（运行记录模式）；为 null 则走管道。 */
  readonly stdoutFile: string | null
  readonly stderrFile: string | null
  readonly resultFile: string
  readonly workDir: string
  readonly ownsWorkDir: boolean
  readonly envelope: ResultEnvelope
  readonly events: NormalizedAgentEvent[]
  readonly listeners: Set<(e: NormalizedAgentEvent) => Promise<void>>
  sessionId: string | null
  /** turn.completed 的 usage 累加（input + output）；reasoning 与缓存细分不另计，避免重复计数。 */
  tokens: number | null
  readonly startedAt: number
  settledAt: number | null
  exitCode: number | null
  stderr: string
  settled: boolean
  canceled: boolean
  terminalDetail: string | undefined
  termination: OwnedProcessGroupTermination | null
}

export interface CodexAdapterOptions {
  readonly authorization: AdapterAuthorization
  readonly bin?: string
  /**
   * 传给 codex --output-schema 的 schema 路径。
   *
   * 必须是 codex-output.v1（OpenAI structured outputs 兼容子集），
   * 不能直接用 task-result.v1——后者含裸 const、pattern、可选字段，
   * 会被 OpenAI 拒绝：「schema must have a 'type' key」。
   */
  readonly outputSchemaPath: string
  /** 同一 idempotency_key 只执行一次，重复派发直接复用已有 binding。 */
  readonly idempotencyStore?: Map<string, RemoteTaskBinding>
  /**
   * 运行记录目录（建议 `<workRoot>/.runs`）。设置后：启动前独占创建记录，codex 的 stdout/stderr
   * 重定向到该目录下的文件（不走管道，Worker 崩溃不会让 codex 因 SIGPIPE 死掉），
   * Worker 重启后可据记录判断进程是否仍在、结果是否已完整。不设置则保持进程内存模式。
   */
  readonly runsDir?: string
  /** 见 CodexArgsOptions.defaultModel。 */
  readonly defaultModel?: string
  /** 额度快照来源（ADR-0009，通常是带缓存的零额度探针）；设置后 health 附带快照。 */
  readonly quota?: () => Promise<QuotaSnapshotV1>
}

export class CodexAdapter implements AgentAdapter {
  readonly adapterId = ADAPTER_ID
  readonly agentId = AGENT_ID
  /** 只有运行记录模式能在 Worker 重启后据记录恢复；进程内存模式重启即丢失观察。 */
  readonly restartSafe: boolean

  readonly #bin: string
  readonly #outputSchemaPath: string
  readonly #authorization: AdapterAuthorization
  readonly authorizationMode: AdapterAuthorization['mode']
  readonly #runs = new Map<string, RunState>()
  readonly #idempotency: Map<string, RemoteTaskBinding>
  readonly #runsDir: string | undefined
  readonly #defaultModel: string | undefined
  readonly #quota: (() => Promise<QuotaSnapshotV1>) | undefined
  readonly #pending = new Map<string, Promise<RemoteTaskBinding>>()

  constructor(opts: CodexAdapterOptions) {
    this.#authorization = snapshotAdapterAuthorization(opts.authorization)
    this.authorizationMode = this.#authorization.mode
    this.#bin = opts.bin ?? process.env['CODEX_BIN'] ?? 'codex'
    this.#outputSchemaPath = opts.outputSchemaPath
    this.#idempotency = opts.idempotencyStore ?? new Map()
    this.#runsDir = opts.runsDir
    this.restartSafe = opts.runsDir !== undefined
    this.#defaultModel = opts.defaultModel
    this.#quota = opts.quota
  }

  async discover(): Promise<AdapterDescriptor> {
    return {
      adapter_id: ADAPTER_ID,
      agent_id: AGENT_ID,
      provider: 'openai-codex',
      version: ADAPTER_VERSION,
      capabilities: [...CODEX_CAPABILITIES],
      risk_ceiling: 'mutating',
      // codex exec resume 本身可用，但控制面不走续跑路线：返工一律派生
      // 新 Task 以保留证据历史，因此此处如实报告为不支持。
      supports_session_resume: false,
      supports_worktree_isolation: true,
      // computer-use 插件在本机可用，故为 A 级；不可用时须降级并如实标注
      execution_level: 'A',
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

    // 外部副作用去重：即使引擎声称 exactly-once，超时后也无法确认
    // 副作用是否已发生，因此重复派发必须复用而非重跑。
    const existing = this.#idempotency.get(key)
    if (existing) return existing
    const inFlight = this.#pending.get(key)
    if (inFlight) return inFlight

    const pending = this.#start(frozenEnvelope, frozenCtx).finally(() => this.#pending.delete(key))
    this.#pending.set(key, pending)
    return pending
  }

  prepareBinding(envelope: TaskEnvelopeV1, ctx: DispatchContext): RemoteTaskBinding {
    return {
      adapter: ADAPTER_ID,
      remote_task_id: `codex:${envelope.identity.task_id}:${envelope.identity.revision}`,
      protocol: 'codex-exec',
      protocol_version: ADAPTER_VERSION,
      runner_id: ctx.runner_id,
    }
  }

  async #start(envelope: TaskEnvelopeV1, ctx: DispatchContext): Promise<RemoteTaskBinding> {
    const key = envelope.identity.idempotency_key

    const risk = envelope.classification.risk_level as RiskLevel
    const ceiling: RiskLevel = 'mutating'
    if (!isRiskWithin(risk, ceiling)) {
      throw new RiskCeilingExceededError(risk, ceiling, ADAPTER_ID)
    }

    const ownsWorkDir = ctx.worktree === undefined
    const workDir = ctx.worktree ?? (await mkdtemp(join(tmpdir(), 'cmap-codex-')))
    // TMPDIR 与 -C 都可能含 macOS 卷别名；沙箱可写根必须是物理路径。
    const physicalWorkDir = await realpath(workDir)
    // -o 由沙箱外的 codex 进程写入且会跟随符号链接：结果文件不能放在 Agent 可写的工作区。
    // 无 runsDir（standalone）时用本进程独有的临时目录（0700），cleanup 时删除。
    const physicalTmpDir = await realpath(tmpdir())
    const resultDir = this.#runsDir ?? (await mkdtemp(join(physicalTmpDir, 'cmap-codex-result-')))
    const resultFile = join(resultDir, `.cmap-result-${envelope.identity.task_id}.json`)
    const prompt = renderTaskPrompt(envelope)
    const binding = this.prepareBinding(envelope, ctx)

    const args = buildCodexArgs(envelope, {
      workDir: physicalWorkDir,
      resultFile,
      outputSchemaPath: this.#outputSchemaPath,
      prompt,
      ...(this.#defaultModel ? { defaultModel: this.#defaultModel } : {}),
    })

    try {
      await ctx.beforeSend?.(binding)
      assertAdapterAuthorization(this.#authorization, envelope, ctx, ADAPTER_ID)
    } catch (cause) {
      if (!this.#runsDir) await rm(resultDir, { recursive: true, force: true })
      if (ownsWorkDir) {
        await rm(workDir, { recursive: true, force: true })
      }
      throw cause
    }

    // 运行记录先于进程：独占创建成功才允许启动；已存在则绝不再启动第二个进程。
    const taskId = envelope.identity.task_id
    let record: RunRecord | null = null
    if (this.#runsDir) {
      const runsDir = this.#runsDir
      record = {
        schema: 'cmap/codex-run/v1',
        remote_task_id: binding.remote_task_id,
        task_id: taskId,
        runner_id: ctx.runner_id,
        pid: null,
        process_start: null,
        started_at: new Date().toISOString(),
        args_sha256: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
        work_dir: workDir,
        owns_work_dir: ownsWorkDir,
        result_file: resultFile,
        stdout_file: join(runsDir, `${taskId}.out`),
        stderr_file: join(runsDir, `${taskId}.err`),
        envelope: {
          identity: envelope.identity,
          classification: envelope.classification,
          evidence_requirements: envelope.evidence_requirements,
        },
      }
      let created = false
      try {
        created = await createRunRecord(runsDir, record)
      } catch (cause) {
        if (ownsWorkDir) await rm(workDir, { recursive: true, force: true })
        throw cause
      }
      if (!created) {
        if (ownsWorkDir) await rm(workDir, { recursive: true, force: true })
        const existing = await readRecord(runsDir, taskId)
        if (existing?.remote_task_id !== binding.remote_task_id || existing.args_sha256 !== record.args_sha256) {
          throw new AdapterError('RUN_RECORD_CONFLICT', `运行记录已存在且与本次启动不一致：${taskId}`, false, 'run-record-conflict')
        }
        this.#idempotency.set(key, binding)
        return binding
      }
    }

    // 记录模式下输出写文件而非管道：管道在 Worker 崩溃时断开，codex 写 stdout 会因 EPIPE 异常退出。
    const outHandle = record ? await open(record.stdout_file, 'a', 0o600) : null
    const errHandle = record ? await open(record.stderr_file, 'a', 0o600) : null
    let child: ChildProcess
    try {
      child = spawn(this.#bin, args, {
        env: codexProviderEnv(process.env, {
          // macOS 上 TMPDIR 可能经 /Volumes/<disk> 符号链接指回 /Users。
          // Codex workspace-write 拒绝带符号链接的 writable root，传物理路径即可。
          TMPDIR: physicalTmpDir,
          // 隔离本机代理：Surge 会拦截 localhost 并返回 HTTP 200 + HTML，
          // 导致连接看似成功却永远等不到有效响应（静默挂起）。
          NO_PROXY: 'localhost,127.0.0.1,::1',
          no_proxy: 'localhost,127.0.0.1,::1',
          CMAP_TASK_ID: envelope.identity.task_id,
          CMAP_TRACE_ID: ctx.trace_id,
        }),
        detached: true,
        stdio: outHandle && errHandle ? ['ignore', outHandle.fd, errHandle.fd] : ['ignore', 'pipe', 'pipe'],
      })
    } finally {
      await outHandle?.close()
      await errHandle?.close()
    }

    const state: RunState = {
      child,
      pid: child.pid ?? null,
      processStart: null,
      recovered: false,
      resultComplete: false,
      stdoutFile: record?.stdout_file ?? null,
      stderrFile: record?.stderr_file ?? null,
      resultFile,
      workDir,
      ownsWorkDir,
      envelope,
      events: [],
      listeners: new Set(),
      sessionId: null,
      tokens: null,
      startedAt: Date.now(),
      settledAt: null,
      exitCode: null,
      stderr: '',
      settled: false,
      canceled: false,
      terminalDetail: undefined,
      termination: null,
    }

    this.#wire(state)

    this.#runs.set(binding.remote_task_id, state)
    this.#idempotency.set(key, binding)

    if (record) {
      // spawn 同步失败（如 bin 不存在）说明进程从未存在，不留阻断重试的记录；
      // 否则把 pid 落盘。落盘前崩溃 = 记录有、pid 无 = 恢复时判不确定，不会补启动。
      if (child.pid === undefined) await rm(join(this.#runsDir!, `${taskId}.json`), { force: true })
      else await persistRecord(this.#runsDir!, { ...record, pid: child.pid, process_start: processStartOf(child.pid) })
    }
    return binding
  }

  #emit(state: RunState, e: NormalizedAgentEvent): void {
    state.events.push(e)
    for (const fn of state.listeners) void fn(e)
  }

  /** 把 JSONL 文本逐行归一化为事件。 */
  #feed(state: RunState, text: string): void {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        // 非 JSON 行（codex 偶有纯文本输出）不是错误，忽略即可
        continue
      }
      this.#emit(state, normalizeCodexEvent(parsed, state))
    }
  }

  /**
   * 文件模式：进程结束后一次性读入 stdout/stderr。
   * ponytail: 事件在进程结束时批量产生而非实时；当前无生产订阅者，需要实时流再改为轮询 tail。
   */
  async #ingestFiles(state: RunState): Promise<void> {
    if (state.stdoutFile) this.#feed(state, await readFile(state.stdoutFile, 'utf8').catch(() => ''))
    if (state.stderrFile) state.stderr += await readFile(state.stderrFile, 'utf8').catch(() => '')
  }

  /** 解析 codex 的 JSONL 事件流并归一化。 */
  #wire(state: RunState): void {
    const child = state.child!
    this.#emit(state, { kind: 'started', at: new Date().toISOString() })

    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      this.#feed(state, lines.join('\n'))
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      state.stderr += chunk.toString('utf8')
    })

    child.on('close', async (code) => {
      // Wrapper exit does not prove its ignored-stdio descendants have exited.
      state.termination ??= terminateOwnedProcessGroup(child)
      if (state.stdoutFile) await this.#ingestFiles(state)
      state.exitCode = code
      state.settled = true
      state.settledAt = Date.now()
      const at = new Date().toISOString()
      this.#emit(
        state,
        code === 0
          ? { kind: 'completed', at }
          : { kind: 'failed', at, message: `codex 退出码 ${code}` },
      )
    })

    child.on('error', (err) => {
      state.exitCode = -1
      state.settled = true
      state.settledAt = Date.now()
      state.stderr += String(err)
      this.#emit(state, { kind: 'failed', at: new Date().toISOString(), message: String(err) })
    })
  }

  async sendInput(binding: RemoteTaskBinding, input: AgentInput): Promise<void> {
    const state = await this.#require(binding)
    if (state.settled) {
      throw new AdapterError('TASK_ALREADY_SETTLED', '任务已结束，无法补充输入', false, 'settled')
    }
    // codex exec 是单轮非交互模式。需要补充上下文时应创建新任务，
    // 而非向已结束的会话追加——这也与「返工派生新 Task」的设计一致。
    throw new AdapterError(
      'INPUT_NOT_SUPPORTED',
      `codex exec 为非交互模式，补充上下文请创建新任务（kind=${input.kind}）`,
      false,
      'codex-exec-no-stdin',
    )
  }

  async getStatus(binding: RemoteTaskBinding): Promise<NormalizedAgentStatus> {
    const state = await this.#require(binding)
    await this.#refresh(state)
    const at = new Date().toISOString()

    if (!state.settled) {
      return { status: 'running', at, terminal_observed: false }
    }
    if (state.termination && !state.termination.confirmAbsent()) {
      return { status: 'running', at, terminal_observed: false }
    }
    if (state.canceled) {
      return {
        status: 'canceled',
        at,
        terminal_observed: true,
        detail: state.terminalDetail ?? 'canceled',
      }
    }
    if (state.recovered) {
      // 退出码已随 Worker 丢失；只认“完整结果文件”，否则是执行不确定，由上层走升级路径。
      if (!state.resultComplete) throw uncertainRun(binding)
      return { status: 'completed', at, terminal_observed: true }
    }
    if (state.exitCode === 0) {
      return { status: 'completed', at, terminal_observed: true }
    }
    return {
      status: 'failed',
      at,
      terminal_observed: true,
      detail: state.stderr.slice(-2000) || `退出码 ${state.exitCode}`,
    }
  }

  async subscribe(
    binding: RemoteTaskBinding,
    onEvent: (event: NormalizedAgentEvent) => Promise<void>,
  ): Promise<SubscriptionHandle> {
    const state = await this.#require(binding)
    // 补发已发生的事件，避免订阅者错过启动阶段
    for (const e of state.events) await onEvent(e)
    state.listeners.add(onEvent)
    return {
      unsubscribe: async () => {
        state.listeners.delete(onEvent)
      },
    }
  }

  async cancel(binding: RemoteTaskBinding, reason: string): Promise<void> {
    const state = await this.#require(binding)
    await this.#refresh(state)
    if (state.settled) return
    state.canceled = true
    state.terminalDetail = `已取消：${reason}`
    state.termination ??= terminateOwnedProcessGroup(
      state.child ?? { pid: state.pid ?? undefined, kill: (signal) => signalProcess(state.pid!, signal) },
    )
    state.events.push({
      kind: 'failed',
      at: new Date().toISOString(),
      message: state.terminalDetail,
    })
  }


  /**
   * 收取 codex 输出，合成完整 TaskResultV1。
   *
   * 三条不可放松的规则：
   *  1. 不得凭 rc=0 判定成功——evidence_requirements 声明的 artifact role
   *     缺失即 failed，这是「无证据即失败」的落点。
   *  2. 不采信 Agent 自报的 sha256——独立复算文件哈希，对不上即失败。
   *     Agent 可能在没真正写文件的情况下编出一个哈希。
   *  3. 身份字段由控制面填充，不取 Agent 自述——账本归控制面所有。
   */
  async collectResult(binding: RemoteTaskBinding): Promise<TaskResultV1> {
    const state = await this.#require(binding)
    await this.#refresh(state)

    if (!state.settled || (state.termination && !state.termination.confirmAbsent())) {
      throw new AdapterError('TASK_STILL_RUNNING', '任务尚未结束', true, 'still-running')
    }
    if (state.canceled) {
      throw new AdapterError('TASK_CANCELED', 'Codex task was canceled', false, 'codex-canceled')
    }
    if (state.recovered && !state.resultComplete) throw uncertainRun(binding)
    // 明确的额度耗尽（ADR-0009 §3）：Agent 已自行停止，可安全交接；识别不了的照旧按普通失败
    if (!state.recovered && state.exitCode !== 0 && CODEX_QUOTA_EXHAUSTED.test(codexErrorText(state))) {
      throw new AdapterError('QUOTA_EXHAUSTED', 'Codex 报告额度已耗尽', false, 'quota-exhausted:codex')
    }

    let raw: string
    try {
      raw = await readFile(state.resultFile, 'utf8')
    } catch {
      throw new AdapterError(
        'RESULT_MISSING',
        `codex 未产出结果文件（退出码 ${state.exitCode}）：${state.stderr.slice(-1000)}`,
        false,
        `result-missing:${state.exitCode}`,
      )
    }

    let out: unknown
    try {
      out = JSON.parse(raw)
    } catch (e) {
      throw new AdapterError(
        'RESULT_UNPARSABLE',
        `结果文件不是合法 JSON：${String(e)}`,
        false,
        'result-unparsable',
      )
    }

    const result = await normalizeAgentOutput(out, state.envelope, state.workDir, state.sessionId ?? undefined)
    // 成本计量（威胁模型 T8）：用量来自 codex 事件流，耗时为进程从启动到退出。
    return {
      ...result,
      cost: {
        ...(state.tokens !== null ? { tokens: state.tokens } : {}),
        duration_seconds: Math.round(((state.settledAt ?? Date.now()) - state.startedAt) / 100) / 10,
      },
    }
  }

  async health(): Promise<AdapterHealth> {
    const [health, quota] = await Promise.all([this.#versionHealth(), this.#quota?.()])
    return quota ? { ...health, quota } : health
  }

  async #versionHealth(): Promise<AdapterHealth> {
    const at = new Date().toISOString()
    return await new Promise((resolve) => {
      const probe = spawn(this.#bin, ['--version'], {
        env: codexProviderEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      probe.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8') })
      probe.on('close', (code) => {
        resolve(
          code === 0
            ? { state: 'healthy', checked_at: at, detail: out.trim() }
            : { state: 'unavailable', checked_at: at, detail: `codex --version 退出码 ${code}` },
        )
      })
      probe.on('error', (err) => {
        resolve({ state: 'unavailable', checked_at: at, detail: String(err) })
      })
    })
  }

  /** 清理临时工作区。ctx.worktree 由调用方提供时不删。 */
  async cleanup(binding: RemoteTaskBinding): Promise<void> {
    const state = this.#runs.get(binding.remote_task_id)
    if (!state) return
    if (!this.#runsDir) await rm(dirname(state.resultFile), { recursive: true, force: true })
    if (state.ownsWorkDir) {
      await rm(state.workDir, { recursive: true, force: true })
    }
    this.#runs.delete(binding.remote_task_id)
  }

  /** 内存里有就用；没有（Worker 重启）则按运行记录恢复，记录缺失或 pid 未落盘即视为未知 binding。 */
  async #require(binding: RemoteTaskBinding): Promise<RunState> {
    const known = this.#runs.get(binding.remote_task_id)
    if (known) return known
    const recovered = await this.#recover(binding)
    if (!recovered) throw uncertainRun(binding)
    this.#runs.set(binding.remote_task_id, recovered)
    return recovered
  }

  async #recover(binding: RemoteTaskBinding): Promise<RunState | null> {
    const taskId = /^codex:(.+):\d+$/.exec(binding.remote_task_id)?.[1]
    if (!this.#runsDir || !taskId || !TASK_ID.test(taskId)) return null
    const record = await readRecord(this.#runsDir, taskId)
    if (!record || record.remote_task_id !== binding.remote_task_id || record.pid === null) return null
    return {
      child: null,
      pid: record.pid,
      processStart: record.process_start,
      recovered: true,
      resultComplete: false,
      stdoutFile: record.stdout_file,
      stderrFile: record.stderr_file,
      resultFile: record.result_file,
      workDir: record.work_dir,
      ownsWorkDir: record.owns_work_dir,
      envelope: record.envelope,
      events: [],
      listeners: new Set(),
      sessionId: null,
      tokens: null,
      startedAt: Date.parse(record.started_at),
      settledAt: null,
      exitCode: null,
      stderr: '',
      settled: false,
      canceled: false,
      terminalDetail: undefined,
      termination: null,
    }
  }

  /** 恢复态没有 close 事件：每次查询时看进程组是否还在，退出了就补做收尾（读输出、验结果文件）。 */
  async #refresh(state: RunState): Promise<void> {
    if (!state.recovered || state.settled || runGroupAlive(state.pid!, state.processStart)) return
    await this.#ingestFiles(state)
    state.resultComplete = await readResultJson(state.resultFile) !== undefined
    state.settledAt = (await stat(state.resultFile).catch(() => null))?.mtimeMs ?? Date.now()
    state.settled = true
  }
}

// ------------------------------------------------------------------ 辅助

/**
 * task_id 在契约里只是非空字符串（实际有 `tsk_<64 位十六进制>` 与含冒号的 DAG 子任务 ID），
 * 这里收紧到可安全作文件名：首字符字母数字，不含路径分隔符，长度留足 `.json/.out/.err` 后缀余量。
 */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** 实测触顶文本（codex 0.159）：弯撇号与直撇号两种写法，以及 “Quota exceeded”。 */
const CODEX_QUOTA_EXHAUSTED = /You[’']ve hit your usage limit|Quota exceeded/
/** 只看 stderr 与错误事件，不看 Agent 自己的消息——后者可能只是在复述日志里的文字。 */
const codexErrorText = (state: RunState): string => [
  state.stderr,
  ...state.events.map((e) => e.kind === 'failed' ? e.message ?? ''
    : e.payload?.['type'] === 'turn.failed' ? JSON.stringify(e.payload['error'] ?? '')
    : (e.payload?.['item'] as { type?: unknown } | undefined)?.type === 'error' ? JSON.stringify(e.payload!['item']) : ''),
].join('\n')

/** 进程已退出且没有完整结果，或根本没有可用的运行记录：不知道 codex 到底做了什么。 */
const uncertainRun = (binding: RemoteTaskBinding): AdapterError =>
  new AdapterError(
    'BINDING_NOT_FOUND',
    `无法确认执行结果，不重跑：${binding.remote_task_id}`,
    false,
    'binding-not-found',
  )

const readRecord = async (runsDir: string, taskId: string): Promise<RunRecord | null> => {
  try {
    const parsed = JSON.parse(await readFile(join(runsDir, `${taskId}.json`), 'utf8')) as RunRecord
    return parsed.schema === 'cmap/codex-run/v1' ? parsed : null
  } catch {
    return null
  }
}

/** 独占创建（wx）。已存在返回 false，其余错误原样抛出。 */
const createRunRecord = async (runsDir: string, record: RunRecord): Promise<boolean> => {
  if (!TASK_ID.test(record.task_id)) {
    throw new AdapterError('RUN_RECORD_INVALID', `taskId 不能作为运行记录文件名：${record.task_id}`, false, 'run-record-invalid')
  }
  await mkdir(runsDir, { recursive: true, mode: 0o700 })
  try {
    await writeFile(join(runsDir, `${record.task_id}.json`), JSON.stringify(record), { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/** 覆盖更新记录（写临时文件再 rename，读者不会看到半截 JSON）。 */
const persistRecord = async (runsDir: string, record: RunRecord): Promise<void> => {
  const path = join(runsDir, `${record.task_id}.json`)
  await writeFile(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 })
  await rename(`${path}.tmp`, path)
}

/** 结果文件是完整 JSON 才返回内容；不存在或写了一半返回 undefined。 */
const readResultJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

const processStartOf = (pid: number): string | null => {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    return out || null
  } catch {
    return null
  }
}

const signalProcess = (pid: number, signal: NodeJS.Signals | number | undefined): boolean => {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

/**
 * 记录里的进程组是否仍有成员。组长还在时核对启动时间，排除 pid 被无关进程复用；
 * 组长已退出但组内还有后代，仍算我们的。取不到启动时间时偏保守（当作还在）。
 */
const runGroupAlive = (pid: number, recordedStart: string | null): boolean => {
  try {
    process.kill(-pid, 0)
  } catch {
    return false
  }
  const current = processStartOf(pid)
  return current === null || recordedStart === null || current === recordedStart
}

const RISK_ORDER: readonly RiskLevel[] = ['read-meta', 'read-sensitive', 'controlled', 'mutating']

const isRiskWithin = (required: RiskLevel, ceiling: RiskLevel): boolean =>
  RISK_ORDER.indexOf(required) <= RISK_ORDER.indexOf(ceiling)

/** codex 事件 → 归一化事件。未知事件降级为 progress，不丢弃。 */
const normalizeCodexEvent = (raw: unknown, state: RunState): NormalizedAgentEvent => {
  const at = new Date().toISOString()
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'progress', at }
  }
  const obj = raw as Record<string, unknown>
  const type = typeof obj['type'] === 'string' ? obj['type'] : ''

  if (typeof obj['session_id'] === 'string') state.sessionId = obj['session_id']
  const usage = obj['usage']
  if (type === 'turn.completed' && typeof usage === 'object' && usage !== null) {
    const u = usage as Record<string, unknown>
    const count = (key: string): number => (Number.isSafeInteger(u[key]) && (u[key] as number) >= 0 ? (u[key] as number) : 0)
    state.tokens = (state.tokens ?? 0) + count('input_tokens') + count('output_tokens')
  }

  if (type.includes('tool') || type.includes('command')) {
    return { kind: 'tool_call', at, payload: obj }
  }
  if (type.includes('error')) {
    return { kind: 'failed', at, message: String(obj['message'] ?? type), payload: obj }
  }
  return { kind: 'progress', at, payload: obj }
}
