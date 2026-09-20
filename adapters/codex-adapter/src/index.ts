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

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  TaskEnvelopeV1,
  TaskResultV1,
  RemoteTaskBinding,
  RiskLevel,
} from '#domain-model'
import type {
  AgentAdapter,
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
} from '#adapter-sdk'
import {
  normalizeAgentOutput,
  renderTaskPrompt,
} from '../../../packages/adapter-sdk/src/structured-output.ts'

const ADAPTER_ID = 'codex-adapter'
const AGENT_ID = 'codex'
const ADAPTER_VERSION = '0.1.0'

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
  }

  args.push(opts.prompt)
  return args
}

interface RunState {
  readonly child: ChildProcess
  readonly resultFile: string
  readonly workDir: string
  readonly ownsWorkDir: boolean
  readonly envelope: TaskEnvelopeV1
  readonly events: NormalizedAgentEvent[]
  readonly listeners: Set<(e: NormalizedAgentEvent) => Promise<void>>
  sessionId: string | null
  exitCode: number | null
  stderr: string
  settled: boolean
}

export interface CodexAdapterOptions {
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
}

export class CodexAdapter implements AgentAdapter {
  readonly adapterId = ADAPTER_ID
  readonly agentId = AGENT_ID

  readonly #bin: string
  readonly #outputSchemaPath: string
  readonly #runs = new Map<string, RunState>()
  readonly #idempotency: Map<string, RemoteTaskBinding>

  constructor(opts: CodexAdapterOptions) {
    this.#bin = opts.bin ?? process.env['CODEX_BIN'] ?? 'codex'
    this.#outputSchemaPath = opts.outputSchemaPath
    this.#idempotency = opts.idempotencyStore ?? new Map()
  }

  async discover(): Promise<AdapterDescriptor> {
    return {
      adapter_id: ADAPTER_ID,
      agent_id: AGENT_ID,
      provider: 'openai-codex',
      version: ADAPTER_VERSION,
      capabilities: [
        'code.implement',
        'code.analyze',
        'performance.root_cause',
        'yonwork.debug',
        'realdevice-validation',
      ],
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
    const key = envelope.identity.idempotency_key

    // 外部副作用去重：即使引擎声称 exactly-once，超时后也无法确认
    // 副作用是否已发生，因此重复派发必须复用而非重跑。
    const existing = this.#idempotency.get(key)
    if (existing) return existing

    const risk = envelope.classification.risk_level as RiskLevel
    const ceiling: RiskLevel = 'mutating'
    if (!isRiskWithin(risk, ceiling)) {
      throw new RiskCeilingExceededError(risk, ceiling, ADAPTER_ID)
    }

    const ownsWorkDir = ctx.worktree === undefined
    const workDir = ctx.worktree ?? (await mkdtemp(join(tmpdir(), 'cmap-codex-')))
    // TMPDIR 与 -C 都可能含 macOS 卷别名；沙箱可写根必须是物理路径。
    const physicalWorkDir = await realpath(workDir)
    const resultFile = join(physicalWorkDir, `.cmap-result-${envelope.identity.task_id}.json`)
    const promptFile = join(physicalWorkDir, `.cmap-prompt-${envelope.identity.task_id}.md`)

    await writeFile(promptFile, renderTaskPrompt(envelope), 'utf8')

    const args = buildCodexArgs(envelope, {
      workDir: physicalWorkDir,
      resultFile,
      outputSchemaPath: this.#outputSchemaPath,
      prompt: await readFile(promptFile, 'utf8'),
    })

    const child = spawn(this.#bin, args, {
      env: {
        ...process.env,
        // macOS 上 TMPDIR 可能经 /Volumes/<disk> 符号链接指回 /Users。
        // Codex workspace-write 拒绝带符号链接的 writable root，传物理路径即可。
        TMPDIR: await realpath(tmpdir()),
        // 隔离本机代理：Surge 会拦截 localhost 并返回 HTTP 200 + HTML，
        // 导致连接看似成功却永远等不到有效响应（静默挂起）。
        NO_PROXY: 'localhost,127.0.0.1,::1',
        no_proxy: 'localhost,127.0.0.1,::1',
        CMAP_TASK_ID: envelope.identity.task_id,
        CMAP_TRACE_ID: ctx.trace_id,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const state: RunState = {
      child,
      resultFile,
      workDir,
      ownsWorkDir,
      envelope,
      events: [],
      listeners: new Set(),
      sessionId: null,
      exitCode: null,
      stderr: '',
      settled: false,
    }

    this.#wire(state)

    const binding: RemoteTaskBinding = {
      adapter: ADAPTER_ID,
      remote_task_id: `codex:${envelope.identity.task_id}:${envelope.identity.revision}`,
      protocol: 'codex-exec',
      protocol_version: ADAPTER_VERSION,
      runner_id: ctx.runner_id,
    }

    this.#runs.set(binding.remote_task_id, state)
    this.#idempotency.set(key, binding)
    return binding
  }

  /** 解析 codex 的 JSONL 事件流并归一化。 */
  #wire(state: RunState): void {
    const emit = (e: NormalizedAgentEvent): void => {
      state.events.push(e)
      for (const fn of state.listeners) void fn(e)
    }

    emit({ kind: 'started', at: new Date().toISOString() })

    let buffer = ''
    state.child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          // 非 JSON 行（codex 偶有纯文本输出）不是错误，忽略即可
          continue
        }
        emit(normalizeCodexEvent(parsed, state))
      }
    })

    state.child.stderr?.on('data', (chunk: Buffer) => {
      state.stderr += chunk.toString('utf8')
    })

    state.child.on('close', (code) => {
      state.exitCode = code
      state.settled = true
      const at = new Date().toISOString()
      emit(
        code === 0
          ? { kind: 'completed', at }
          : { kind: 'failed', at, message: `codex 退出码 ${code}` },
      )
    })

    state.child.on('error', (err) => {
      state.exitCode = -1
      state.settled = true
      state.stderr += String(err)
      emit({ kind: 'failed', at: new Date().toISOString(), message: String(err) })
    })
  }

  async sendInput(binding: RemoteTaskBinding, input: AgentInput): Promise<void> {
    const state = this.#require(binding)
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
    const state = this.#require(binding)
    const at = new Date().toISOString()

    if (!state.settled) {
      return { status: 'running', at, terminal_observed: false }
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
    const state = this.#require(binding)
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
    const state = this.#require(binding)
    if (state.settled) return
    state.child.kill('SIGTERM')
    state.events.push({
      kind: 'failed',
      at: new Date().toISOString(),
      message: `已取消：${reason}`,
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
    const state = this.#require(binding)

    if (!state.settled) {
      throw new AdapterError('TASK_STILL_RUNNING', '任务尚未结束', true, 'still-running')
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

    return normalizeAgentOutput(out, state.envelope, state.workDir, state.sessionId ?? undefined)
  }

  async health(): Promise<AdapterHealth> {
    const at = new Date().toISOString()
    return await new Promise((resolve) => {
      const probe = spawn(this.#bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
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
    if (state.ownsWorkDir) {
      await rm(state.workDir, { recursive: true, force: true })
    }
    this.#runs.delete(binding.remote_task_id)
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

// ------------------------------------------------------------------ 辅助

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

  if (type.includes('tool') || type.includes('command')) {
    return { kind: 'tool_call', at, payload: obj }
  }
  if (type.includes('error')) {
    return { kind: 'failed', at, message: String(obj['message'] ?? type), payload: obj }
  }
  return { kind: 'progress', at, payload: obj }
}
