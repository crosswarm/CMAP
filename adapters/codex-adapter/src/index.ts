/**
 * Codex Adapter — 把 codex CLI 归一化为 AgentAdapter。
 *
 * 依赖的三个实测能力：
 *   codex exec --output-schema <FILE>   强制最终响应符合 JSON Schema
 *   codex exec --json                   事件以 JSONL 输出，供 subscribe 消费
 *   codex exec resume --last            续跑上一会话，返工时不丢上下文
 *
 * 安全基线：本机 codex 默认 sandbox_mode=danger-full-access +
 * approval_policy=never。那是单机自用的设置，一旦接入多人总线等于把机器
 * 交给别人派发的任务。本 Adapter 一律显式传 -s，绝不继承默认档。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'

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
  ProviderSession,
} from '#adapter-sdk'
import {
  AdapterError,
  RiskCeilingExceededError,
  EvidenceMissingError,
} from '#adapter-sdk'

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

interface RunState {
  readonly child: ChildProcess
  readonly resultFile: string
  readonly workDir: string
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

/** codex 按 codex-output.v1 产出的原始结构。 */
interface CodexOutput {
  status: 'completed' | 'failed' | 'input_required' | 'auth_required'
  summary: string
  criterion_results: {
    criterion_id: string
    actual: string
    passed: boolean
    evidence_artifact_ids: string[]
  }[]
  artifacts: {
    artifact_id: string
    role: string
    uri: string
    media_type: string
    size_bytes: number
    sha256: string
  }[]
  findings: { severity: string; code: string; description: string }[]
  error: { code: string; message: string; retryable: boolean } | null
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
      supports_session_resume: true,
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

    const workDir = ctx.worktree ?? (await mkdtemp(join(tmpdir(), 'cmap-codex-')))
    const resultFile = join(workDir, `.cmap-result-${envelope.identity.task_id}.json`)
    const promptFile = join(workDir, `.cmap-prompt-${envelope.identity.task_id}.md`)

    await writeFile(promptFile, renderPrompt(envelope), 'utf8')

    const args = [
      'exec',
      '--json',
      '-s', chooseSandbox(envelope),
      '-C', workDir,
      '--skip-git-repo-check',
      '--output-schema', this.#outputSchemaPath,
      '-o', resultFile,
      await readFile(promptFile, 'utf8'),
    ]

    const child = spawn(this.#bin, args, {
      env: {
        ...process.env,
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
    // codex exec 是单轮非交互模式，补充输入须经 resumeSession 走新一轮
    throw new AdapterError(
      'INPUT_NOT_SUPPORTED',
      `codex exec 为非交互模式，补充输入请改用 resumeSession（kind=${input.kind}）`,
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

  async resumeSession(
    session: ProviderSession,
    envelope: TaskEnvelopeV1,
  ): Promise<RemoteTaskBinding> {
    const risk = envelope.classification.risk_level as RiskLevel
    const workDir = session.worktree ?? (await mkdtemp(join(tmpdir(), 'cmap-codex-')))
    const resultFile = join(workDir, `.cmap-result-${envelope.identity.task_id}.json`)

    const child = spawn(
      this.#bin,
      [
        'exec', 'resume', session.provider_session_id,
        '--json',
        '-s', chooseSandbox(envelope),
        '-C', workDir,
        '--skip-git-repo-check',
        '--output-schema', this.#outputSchemaPath,
        '-o', resultFile,
        renderPrompt(envelope),
      ],
      {
        env: {
          ...process.env,
          NO_PROXY: 'localhost,127.0.0.1,::1',
          no_proxy: 'localhost,127.0.0.1,::1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    const state: RunState = {
      child, resultFile, workDir, envelope,
      events: [], listeners: new Set(),
      sessionId: session.provider_session_id,
      exitCode: null, stderr: '', settled: false,
    }
    this.#wire(state)

    const binding: RemoteTaskBinding = {
      adapter: ADAPTER_ID,
      remote_task_id: `codex:${envelope.identity.task_id}:${envelope.identity.revision}:resume`,
      protocol: 'codex-exec-resume',
      protocol_version: ADAPTER_VERSION,
      provider_session_id: session.provider_session_id,
    }
    this.#runs.set(binding.remote_task_id, state)
    return binding
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

    let out: CodexOutput
    try {
      out = JSON.parse(raw) as CodexOutput
    } catch (e) {
      throw new AdapterError(
        'RESULT_UNPARSABLE',
        `结果文件不是合法 JSON：${String(e)}`,
        false,
        'result-unparsable',
      )
    }

    // 证据角色完整性
    const required = state.envelope.evidence_requirements.required_artifact_roles
    const produced = new Set((out.artifacts ?? []).map((a) => a.role))
    const missing = required.filter((r) => !produced.has(r))
    if (missing.length > 0) {
      throw new EvidenceMissingError(missing, state.envelope.identity.task_id)
    }

    // 证据真实性：文件必须存在，且哈希由控制面独立复算
    const artifacts: TaskResultV1['artifacts'] = []
    for (const a of out.artifacts ?? []) {
      const path = isAbsolute(a.uri) ? a.uri : join(state.workDir, a.uri)
      let bytes: Buffer
      try {
        bytes = await readFile(path)
      } catch {
        throw new AdapterError(
          'EVIDENCE_FILE_MISSING',
          `声明的证据文件不存在：${a.uri}（角色 ${a.role}）`,
          false,
          `evidence-file-missing:${a.role}`,
        )
      }
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (actual !== a.sha256.toLowerCase()) {
        throw new AdapterError(
          'EVIDENCE_HASH_MISMATCH',
          `证据 ${a.role} 哈希不符：Agent 声明 ${a.sha256}，实际 ${actual}`,
          false,
          `evidence-hash-mismatch:${a.role}`,
        )
      }
      artifacts.push({
        artifact_id: a.artifact_id,
        role: a.role,
        uri: a.uri,
        media_type: a.media_type,
        size_bytes: bytes.byteLength,
        sha256: actual,
      })
    }

    const result: TaskResultV1 = {
      schema: 'cmap/task-result/v1',
      mission_id: state.envelope.identity.mission_id,
      task_id: state.envelope.identity.task_id,
      attempt: state.envelope.identity.revision,
      status: out.status,
      summary: out.summary,
      criterion_results: (out.criterion_results ?? []).map((c) => ({
        criterion_id: c.criterion_id,
        actual: c.actual,
        passed: c.passed,
        evidence_artifact_ids: c.evidence_artifact_ids ?? [],
      })),
      artifacts,
      ...(out.findings?.length
        ? {
            findings: out.findings.map((f) => ({
              severity: f.severity as 'info' | 'low' | 'medium' | 'high' | 'critical',
              code: f.code,
              description: f.description,
            })),
          }
        : {}),
      ...(out.error
        ? {
            error: {
              code: out.error.code,
              message: out.error.message,
              retryable: out.error.retryable,
              fingerprint: `${out.error.code}:${state.envelope.classification.task_type}`,
            },
          }
        : {}),
      ...(state.sessionId ? { session: { provider_session_id: state.sessionId } } : {}),
    }

    return result
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
    if (state.workDir.startsWith(tmpdir())) {
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

/**
 * 信封 → 提示词。
 * 信封必须自洽：spawn 出的 codex 不继承任何上下文，读哪里、做什么、
 * 什么算通过、结果写回哪，全部要在这段文字里说清楚。
 */
const renderPrompt = (e: TaskEnvelopeV1): string => {
  const criteria = e.goal.success_definition
    .map((c) => `- ${c.criterion_id}：${c.metric} ${c.operator} ${JSON.stringify(c.expected)}${c.unit ? ` ${c.unit}` : ''}`)
    .join('\n')

  const evidence = e.evidence_requirements.required_artifact_roles
    .map((r) => `- ${r}`)
    .join('\n')

  const ctx = e.inputs?.context
  const contextBlock = ctx
    ? `\n## 代码上下文\n\n仓库 ${ctx.repo}\ncommit ${ctx.ref}\n${ctx.paths?.length ? `相关路径：\n${ctx.paths.map((p) => `- ${p}`).join('\n')}` : ''}\n`
    : ''

  const forbidden = e.permissions.forbidden.length
    ? `\n## 禁止事项\n\n${e.permissions.forbidden.map((f) => `- ${f}`).join('\n')}\n`
    : ''

  return `# 任务 ${e.identity.task_id}

${e.goal.statement}
${contextBlock}
## 验收标准（机读，逐条回应）

${criteria}

## 必须产出的证据

${evidence}

未产出上述证据的任务一律判定失败——不接受"执行成功但没有证据"。
${forbidden}
## 输出要求

最终响应必须是符合给定 Schema 的 JSON（身份字段由控制面填充，你不需要提供）：

- \`criterion_results\` 逐条对应上面每个 criterion_id，一条都不能少；
  \`actual\` 一律写成字符串，数值也用字符串表达
- \`artifacts\` 逐个声明证据产物：
  - **必须真正把文件写到磁盘**，路径用相对于当前工作目录的形式（如 \`evidence/report.json\`）
  - \`sha256\` 必须是该文件内容的真实哈希（可用 \`shasum -a 256 <file>\` 取得）
  - 控制面会独立复算哈希并比对，**编造哈希会被直接判定失败**
- \`findings\` 无内容时填空数组，\`error\` 在成功时填 null
- 无法完成时 \`status\` 填 failed 并在 \`error\` 中说明，不要伪造通过

任务风险级别：${e.classification.risk_level}
${e.inputs?.context_summary ? `\n## 背景\n\n${e.inputs.context_summary}\n` : ''}`
}
