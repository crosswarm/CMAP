import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, lstat, readFile, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { terminateOwnedProcessGroup } from '../../../packages/adapter-sdk/src/process-group.ts'
import { yonWorkProfileFromRoute } from '#domain-model'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024
const CHAT_ABORT_PATH = '/api/chat/abort'

export class YonWorkRuntimeError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'YonWorkRuntimeError'
    this.code = code
    this.retryable = retryable
  }
}

export interface YonWorkRuntimeOptions {
  readonly bin?: string
  readonly yonworkBin?: string
  readonly openclawBin?: string
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
}

export interface YonWorkAgentMetadata {
  readonly availability: 'available' | 'unavailable'
  readonly agentId: string
  readonly cliVersion: string | null
  readonly runtimeSource: string
}

export interface YonWorkEffectivePolicy {
  readonly agentId: string
  readonly sessionKey: string
  readonly tools: readonly string[]
  readonly notices: readonly string[]
  readonly policySha256: string
}

export interface YonWorkProcessHandle {
  readonly pid?: number | null
  readonly ready: Promise<void>
  readonly finished: Promise<CliResult>
  stop(): Promise<void>
}

interface RuntimeSelection {
  readonly source: string
  readonly userDataDir: string | null
}

export interface CliResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
}

const clean = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

const strictSemver = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$/
const loopbackGatewayUrl = /^(?:ws|wss):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?(?:\/|$)/

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const privateEnv = (
  env: NodeJS.ProcessEnv,
  runtime: RuntimeSelection,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => {
  rejectHostOverrides(env)
  const child: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH',
    'HOME',
    'LANG',
    'TERM',
    'TZ',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]) {
    const value = env[key]
    if (value !== undefined) child[key] = value
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key.startsWith('LC_')) child[key] = value
  }
  if (runtime.userDataDir) child.YONCLAW_USER_DATA_DIR = runtime.userDataDir
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) child[key] = value
  }
  return child
}

const rejectHostOverrides = (env: NodeJS.ProcessEnv): void => {
  if (env.YONCLAW_HOST_API_URL || env.YONCLAW_HOST_API_TOKEN) {
    throw new YonWorkRuntimeError(
      'YONWORK_OVERRIDE_REJECTED',
      'YonWork Host API override env is not allowed for CMAP runtime selection',
    )
  }
}

const existingRuntime = async (file: string): Promise<{
  readonly userDataDir: string
} | null> => {
  try {
    const link = await lstat(file)
    const target = link.isSymbolicLink() ? await stat(file) : link
    if (!target.isFile()) return null
    const data = asRecord(JSON.parse(await readFile(file, 'utf8')))
    if (
      typeof data.port !== 'number' ||
      typeof data.token !== 'string' ||
      typeof data.pid !== 'number'
    ) {
      return null
    }
    return { userDataDir: dirname(file) }
  } catch {
    return null
  }
}

export const selectYonWorkRuntime = async (
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): Promise<RuntimeSelection> => {
  if (clean(env.YONCLAW_USER_DATA_DIR)) {
    const userDataDir = clean(env.YONCLAW_USER_DATA_DIR)
    const runtime = userDataDir
      ? await existingRuntime(join(userDataDir, 'host-api-runtime.json'))
      : null
    return {
      source: 'environment',
      userDataDir: runtime?.userDataDir ?? null,
    }
  }
  if (platform === 'darwin') {
    const home = env.HOME || homedir()
    const candidates: ReadonlyArray<readonly [string, string]> = [
      ['yonwork', join(home, 'Library/Application Support/yonwork/host-api-runtime.json')],
      ['yonwork', join(home, 'Library/Application Support/YonWork/host-api-runtime.json')],
      ['yonclaw', join(home, 'Library/Application Support/yonclaw/host-api-runtime.json')],
      ['yonclaw', join(home, 'Library/Application Support/YonClaw/host-api-runtime.json')],
    ]
    for (const [source, file] of candidates) {
      const runtime = await existingRuntime(file)
      if (runtime) return { source, ...runtime }
    }
  }
  return { source: 'platform_default', userDataDir: null }
}

const resolveSiblingBin = async (bin: string, sibling: string, env: NodeJS.ProcessEnv): Promise<string> => {
  const resolved = await resolveBin(bin, env)
  const candidate = join(dirname(resolved), sibling)
  try {
    await access(candidate, constants.X_OK)
    return await realpath(candidate)
  } catch {
    throw new YonWorkRuntimeError(
      'YONWORK_CLI_UNAVAILABLE',
      'YonWork sibling CLI is unavailable',
      true,
    )
  }
}

const resolveBin = async (bin: string, env: NodeJS.ProcessEnv): Promise<string> => {
  const candidates = isAbsolute(bin)
    ? [bin]
    : (env.PATH ?? '').split(delimiter).map((dir) => join(dir, bin))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return await realpath(candidate)
    } catch {
      /* try next PATH entry */
    }
  }
  throw new YonWorkRuntimeError(
    'YONWORK_CLI_UNAVAILABLE',
    'YonWork CLI is unavailable',
    true,
  )
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    throw new YonWorkRuntimeError(
      'YONWORK_INVALID_JSON',
      'YonWork CLI returned invalid JSON',
      true,
    )
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

const extractArray = (value: unknown, names: readonly string[]): readonly unknown[] => {
  const root = asRecord(value)
  for (const name of names) {
    const item = root[name]
    if (Array.isArray(item)) return item
  }
  const result = asRecord(root.result)
  for (const name of names) {
    const item = result[name]
    if (Array.isArray(item)) return item
  }
  return []
}

const resultObject = (value: unknown): Record<string, unknown> => {
  const root = asRecord(value)
  return asRecord(root.result && typeof root.result === 'object' ? root.result : root)
}

const agentIdOf = (value: unknown): string | null => {
  const item = asRecord(value)
  return clean(item.id) ?? clean(item.agentId) ?? clean(item.agent_id) ?? clean(item.key)
}

const agentEnabled = (value: unknown): boolean =>
  asRecord(value).enabled === true

const agentRuntimeAssociated = (
  value: unknown,
  runtime: RuntimeSelection,
): boolean => {
  const agentDir = clean(asRecord(value).agentDir)
  if (!agentDir || !runtime.userDataDir) return false
  const runtimeRoot = resolve(runtime.userDataDir)
  const resolvedAgentDir = resolve(agentDir)
  const rel = relative(runtimeRoot, resolvedAgentDir)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

const openClawRootFromAgentDir = (agentDir: string, agentId: string): string | null => {
  const marker = join('agents', agentId, 'agent')
  const resolved = resolve(agentDir)
  if (!resolved.endsWith(marker)) return null
  return resolved.slice(0, -marker.length).replace(/[\\/]$/, '')
}

const agentIdFromSessionKey = (sessionKey: unknown): string | null => {
  const value = clean(sessionKey)
  if (!value) return null
  const [prefix, agentId] = value.split(':')
  return prefix === 'agent' ? clean(agentId) : null
}

const assertLocalGatewayConfig = async (configPath: string): Promise<void> => {
  try {
    const data = asRecord(JSON.parse(await readFile(configPath, 'utf8')))
    const gateway = asRecord(data.gateway)
    const mode = clean(gateway.mode)
    const remote = asRecord(gateway.remote)
    if (mode === 'remote' && clean(remote.url)) {
      throw new YonWorkRuntimeError(
        'YONWORK_GATEWAY_UNAVAILABLE',
        'Current YonWork OpenClaw config targets a remote gateway',
        true,
      )
    }
  } catch (error) {
    if (error instanceof YonWorkRuntimeError) throw error
    throw new YonWorkRuntimeError(
      'YONWORK_GATEWAY_UNAVAILABLE',
      'Current YonWork OpenClaw config is unavailable',
      true,
    )
  }
}

const cliVersionOf = (value: string): string | null => {
  const version = clean(value)?.split(/\s+/).findLast((part) => strictSemver.test(part))
  return version ?? null
}

const toolName = (value: unknown): string | null => {
  if (typeof value === 'string') return clean(value)
  const item = asRecord(value)
  return clean(item.name) ?? clean(item.id) ?? clean(item.toolName)
}

const noticeText = (value: unknown): string | null => {
  if (typeof value === 'string') return clean(value)
  const item = asRecord(value)
  return clean(item.message) ?? clean(item.code) ?? clean(item.reason) ?? clean(item.type)
}

const parseEffectivePolicy = (
  value: unknown,
  expected: { readonly agentId: string; readonly sessionKey: string },
): Omit<YonWorkEffectivePolicy, 'policySha256'> => {
  const result = resultObject(value)
  const observedAgent = clean(result.agentId)
  const observedSession = clean(result.sessionKey) ?? clean(result.session_key)
  const profile = clean(result.profile)
  const groups = result.groups
  const notices = result.notices === undefined ? [] : result.notices
  if (
    observedAgent !== expected.agentId ||
    (observedSession !== null && observedSession !== expected.sessionKey) ||
    !profile ||
    !Array.isArray(groups) ||
    !Array.isArray(notices)
  ) {
    throw new YonWorkRuntimeError(
      'YONWORK_POLICY_UNAVAILABLE',
      'YonWork effective policy shape or identity is invalid',
      true,
    )
  }

  const tools: string[] = []
  for (const group of groups) {
    const groupTools = asRecord(group).tools
    if (!Array.isArray(groupTools)) {
      throw new YonWorkRuntimeError(
        'YONWORK_POLICY_UNAVAILABLE',
        'YonWork effective policy group is malformed',
        true,
      )
    }
    for (const tool of groupTools) {
      const name = toolName(tool)
      if (!name) {
        throw new YonWorkRuntimeError(
          'YONWORK_POLICY_UNAVAILABLE',
          'YonWork effective policy tool is malformed',
          true,
        )
      }
      tools.push(name)
    }
  }
  const noticeList = notices
    .map(noticeText)
    .filter((notice): notice is string => Boolean(notice))
    .sort()
  if (noticeList.length !== notices.length || tools.length !== 0 || noticeList.length !== 0) {
    throw new YonWorkRuntimeError(
      'YONWORK_POLICY_UNAVAILABLE',
      'YonWork effective policy is not empty',
      true,
    )
  }
  return {
    agentId: expected.agentId,
    sessionKey: expected.sessionKey,
    tools: [],
    notices: [],
  }
}

const sseReady = (text: string): boolean =>
  /(^|\n):\s*connected(?:\n|$)/.test(text) ||
  /(^|\n)event:\s*gateway:status(?:\n|$)/.test(text)

const waitForGroupExit = async (
  termination: { confirmAbsent(): boolean },
): Promise<void> => {
  for (let i = 0; i < 40; i += 1) {
    if (termination.confirmAbsent()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

export class YonWorkRuntime {
  readonly #yonworkBin: string
  readonly #openclawBin: string | null
  readonly #env: NodeJS.ProcessEnv
  readonly #timeoutMs: number
  readonly #maxOutputBytes: number

  constructor(opts: YonWorkRuntimeOptions = {}) {
    this.#yonworkBin = opts.yonworkBin ?? opts.bin ?? 'yonworkctl'
    this.#openclawBin = opts.openclawBin ?? null
    this.#env = opts.env ?? process.env
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  }

  async readAgentMetadata(route: string): Promise<YonWorkAgentMetadata> {
    const agentId = yonWorkProfileFromRoute(route)
    if (!agentId) {
      throw new YonWorkRuntimeError(
        'YONWORK_ROUTE_UNSUPPORTED',
        'YonWork route must be explicit yonwork:cmap-*',
      )
    }
    const runtime = await this.#requiredRuntime()
    const version = await this.#run(this.#yonworkBin, ['--version'])
    const cliVersion = cliVersionOf(version.stdout || version.stderr || '')
    if (!cliVersion) {
      throw new YonWorkRuntimeError(
        'YONWORK_CLI_UNAVAILABLE',
        'YonWork CLI version is not strict semver',
        true,
      )
    }
    const metadata = await this.#run(this.#yonworkBin, ['agents', 'list'])
    const agents = extractArray(parseJson(metadata.stdout), ['agents', 'items', 'data'])
    const matched = agents.find((agent) => agentIdOf(agent) === agentId && agentEnabled(agent))
    if (matched && !agentRuntimeAssociated(matched, runtime)) {
      throw new YonWorkRuntimeError(
        'YONWORK_RUNTIME_MISMATCH',
        'YonWork agent metadata is not associated with the current Host runtime',
        true,
      )
    }
    return {
      availability: matched ? 'available' : 'unavailable',
      agentId,
      cliVersion,
      runtimeSource: runtime.source,
    }
  }

  async observeEffectivePolicy(input: {
    readonly agentId: string
    readonly sessionKey: string
  }): Promise<YonWorkEffectivePolicy> {
    const payload = await this.#gatewayCall('tools.effective', {
      agentId: input.agentId,
      sessionKey: input.sessionKey,
    })
    const parsed = parseEffectivePolicy(payload, input)
    return {
      ...parsed,
      policySha256: sha256(canonicalJson({
        agentId: parsed.agentId,
        tools: parsed.tools,
        notices: parsed.notices,
      })),
    }
  }

  async prepareEmptySession(input: { readonly sessionKey: string }): Promise<void> {
    await this.#gatewayCall('sessions.patch', { key: input.sessionKey })
  }

  async sendChat(input: {
    readonly sessionKey: string
    readonly message: string
    readonly idempotencyKey: string
    readonly timeoutMs?: number
    readonly onChunk: (chunk: Buffer) => void
  }): Promise<YonWorkProcessHandle> {
    const body = {
      sessionKey: input.sessionKey,
      message: input.message,
      deliver: false,
      attachments: [],
      idempotencyKey: input.idempotencyKey,
    }
    return this.#stream(
      this.#yonworkBin,
      ['chat', 'send', '--json', JSON.stringify(body)],
      {
        timeoutMs: input.timeoutMs ?? this.#timeoutMs,
        onStdout: input.onChunk,
        readyWhen: sseReady,
      },
    )
  }

  async abortChat(input: {
    readonly sessionKey: string
    readonly runId: string
  }): Promise<void> {
    await this.#api(CHAT_ABORT_PATH, { sessionKey: input.sessionKey, runId: input.runId })
  }

  async watchEvents(input: {
    readonly timeoutMs?: number
    readonly onChunk: (chunk: Buffer) => void
  }): Promise<YonWorkProcessHandle> {
    return this.#stream(this.#yonworkBin, ['events', 'tail'], {
      timeoutMs: input.timeoutMs ?? this.#timeoutMs,
      onStdout: input.onChunk,
      readyWhen: sseReady,
    })
  }

  async #gatewayCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    const agentId = clean(params.agentId) ?? agentIdFromSessionKey(params.key)
    if (!agentId) {
      throw new YonWorkRuntimeError(
        'YONWORK_AGENT_UNAVAILABLE',
        'YonWork gateway call requires an associated agent identity',
        true,
      )
    }
    const openclawRuntime = await this.#requiredOpenClawRuntimeForAgent(agentId)
    const openclawBin = this.#openclawBin ?? await resolveSiblingBin(this.#yonworkBin, 'openclaw', this.#env)
    const result = await this.#run(openclawBin, [
      'gateway',
      'call',
      method,
      '--json',
      '--params',
      JSON.stringify(params),
      '--timeout',
      String(this.#timeoutMs),
    ], {
      OPENCLAW_STATE_DIR: openclawRuntime.stateDir,
      OPENCLAW_CONFIG_PATH: openclawRuntime.configPath,
      OPENCLAW_GATEWAY_PORT: String(openclawRuntime.gatewayPort),
    })
    return parseJson(result.stdout || '{}')
  }

  async #api(path: string, body: Record<string, unknown>): Promise<unknown> {
    const result = await this.#run(this.#yonworkBin, [
      'api',
      path,
      '--method',
      'POST',
      '--json',
      JSON.stringify(body),
    ])
    return parseJson(result.stdout || '{}')
  }

  async #requiredRuntime(): Promise<RuntimeSelection> {
    rejectHostOverrides(this.#env)
    const runtime = await selectYonWorkRuntime(this.#env)
    if (!runtime.userDataDir) {
      throw new YonWorkRuntimeError(
        'YONWORK_RUNTIME_UNAVAILABLE',
        'Current YonWork Host runtime association is unavailable',
        true,
      )
    }
    return runtime
  }

  async #requiredGatewayRuntime(): Promise<RuntimeSelection & { readonly gatewayPort: number }> {
    const runtime = await this.#requiredRuntime()
    const status = resultObject(parseJson((await this.#run(this.#yonworkBin, ['gateway', 'status'])).stdout))
    const state = clean(status.state)
    const port = status.port
    const gatewayUrl = typeof port === 'number' && Number.isInteger(port)
      ? `ws://127.0.0.1:${port}`
      : null
    if (
      state !== 'running' ||
      !gatewayUrl ||
      !loopbackGatewayUrl.test(gatewayUrl) ||
      typeof port !== 'number' ||
      !Number.isInteger(port)
    ) {
      throw new YonWorkRuntimeError(
        'YONWORK_GATEWAY_UNAVAILABLE',
        'Current YonWork Host OpenClaw gateway association is unavailable',
        true,
      )
    }
    return { ...runtime, gatewayPort: port }
  }

  async #requiredOpenClawRuntimeForAgent(agentId: string): Promise<{
    readonly stateDir: string
    readonly configPath: string
    readonly gatewayPort: number
  }> {
    const runtime = await this.#requiredGatewayRuntime()
    const metadata = await this.#run(this.#yonworkBin, ['agents', 'list'])
    const agents = extractArray(parseJson(metadata.stdout), ['agents', 'items', 'data'])
    const matched = agents.find((agent) => agentIdOf(agent) === agentId && agentEnabled(agent))
    if (!matched || !agentRuntimeAssociated(matched, runtime)) {
      throw new YonWorkRuntimeError(
        'YONWORK_AGENT_UNAVAILABLE',
        'YonWork agent metadata is unavailable for the current Host runtime',
        true,
      )
    }
    const agentDir = clean(asRecord(matched).agentDir)
    const stateDir = agentDir ? openClawRootFromAgentDir(agentDir, agentId) : null
    if (!stateDir) {
      throw new YonWorkRuntimeError(
        'YONWORK_RUNTIME_MISMATCH',
        'YonWork agent runtime does not expose an OpenClaw state directory',
        true,
      )
    }
    const configPath = join(stateDir, 'openclaw.json')
    try {
      await access(configPath, constants.R_OK)
    } catch {
      throw new YonWorkRuntimeError(
        'YONWORK_GATEWAY_UNAVAILABLE',
        'Current YonWork OpenClaw config is unavailable',
        true,
      )
    }
    await assertLocalGatewayConfig(configPath)
    return { stateDir, configPath, gatewayPort: runtime.gatewayPort }
  }

  async #run(
    bin: string,
    args: readonly string[],
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<CliResult> {
    const child = await this.#spawn(bin, args, extraEnv)
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let done = false
      const outDecoder = new StringDecoder('utf8')
      const errDecoder = new StringDecoder('utf8')
      const finish = (fn: () => void): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        fn()
      }
      const fail = (error: YonWorkRuntimeError): void => finish(() => reject(error))
      const timer = setTimeout(() => {
        terminateOwnedProcessGroup(child)
        fail(new YonWorkRuntimeError('YONWORK_CLI_TIMEOUT', 'YonWork CLI timed out', true))
      }, this.#timeoutMs)
      const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
        if (target === 'stdout') stdout += outDecoder.write(chunk)
        else stderr += errDecoder.write(chunk)
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > this.#maxOutputBytes) {
          terminateOwnedProcessGroup(child)
          fail(new YonWorkRuntimeError(
            'YONWORK_OUTPUT_LIMIT',
            'YonWork CLI output exceeded limit',
            true,
          ))
        }
      }
      child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk))
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk))
      child.on('close', (code) => {
        stdout += outDecoder.end()
        stderr += errDecoder.end()
        if (code !== 0) {
          fail(new YonWorkRuntimeError(
            'YONWORK_CLI_FAILED',
            `YonWork CLI exited ${code ?? 'unknown'}`,
            true,
          ))
          return
        }
        finish(() => resolve({ stdout, stderr, code }))
      })
      child.on('error', () => {
        fail(new YonWorkRuntimeError(
          'YONWORK_CLI_FAILED',
          'YonWork CLI failed to start',
          true,
        ))
      })
    })
  }

  async #stream(
    bin: string,
    args: readonly string[],
    handlers: {
      readonly timeoutMs: number
      readonly onStdout: (chunk: Buffer) => void
      readonly readyWhen: (text: string) => boolean
    },
  ): Promise<YonWorkProcessHandle> {
    const child = await this.#spawn(bin, args)
    let stdout = ''
    let stderr = ''
    let done = false
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    let ready = false
    let readyResolve!: () => void
    let readyReject!: (error: YonWorkRuntimeError) => void
    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    const finished = new Promise<CliResult>((resolve, reject) => {
      const finish = (fn: () => void): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        fn()
      }
      const fail = (error: YonWorkRuntimeError): void => finish(() => {
        if (!ready) readyReject(error)
        reject(error)
      })
      const timer = setTimeout(() => {
        terminateOwnedProcessGroup(child)
        fail(new YonWorkRuntimeError('YONWORK_CLI_TIMEOUT', 'YonWork CLI timed out', true))
      }, Math.max(1, handlers.timeoutMs))
      const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
        if (target === 'stdout') {
          stdout += outDecoder.write(chunk)
          try {
            handlers.onStdout(chunk)
          } catch {
            terminateOwnedProcessGroup(child)
            fail(new YonWorkRuntimeError(
              'YONWORK_CHUNK_HANDLER_FAILED',
              'YonWork stream chunk handler failed',
              false,
            ))
            return
          }
          if (!ready && handlers.readyWhen(stdout)) {
            ready = true
            readyResolve()
          }
        } else stderr += errDecoder.write(chunk)
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > this.#maxOutputBytes) {
          terminateOwnedProcessGroup(child)
          fail(new YonWorkRuntimeError(
            'YONWORK_OUTPUT_LIMIT',
            'YonWork CLI output exceeded limit',
            true,
          ))
        }
      }
      child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk))
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk))
      child.on('close', (code) => {
        stdout += outDecoder.end()
        stderr += errDecoder.end()
        if (!ready) {
          readyReject(new YonWorkRuntimeError(
            'YONWORK_STREAM_NOT_READY',
            'YonWork stream closed before readiness handshake',
            true,
          ))
        }
        if (code !== 0) {
          fail(new YonWorkRuntimeError(
            'YONWORK_CLI_FAILED',
            `YonWork CLI exited ${code ?? 'unknown'}`,
            true,
          ))
          return
        }
        finish(() => resolve({ stdout, stderr, code }))
      })
      child.on('error', () => {
        fail(new YonWorkRuntimeError(
          'YONWORK_CLI_FAILED',
          'YonWork CLI failed to start',
          true,
        ))
      })
    })
    readyPromise.catch(() => undefined)
    finished.catch(() => undefined)
    return {
      pid: child.pid ?? null,
      ready: readyPromise,
      finished,
      stop: async () => {
        const termination = terminateOwnedProcessGroup(child)
        await finished.catch(() => undefined)
        if (termination) await waitForGroupExit(termination)
      },
    }
  }

  async #spawn(
    bin: string,
    args: readonly string[],
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<ChildProcess> {
    const runtime = await this.#requiredRuntime()
    const executable = await resolveBin(bin, this.#env)
    return spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: privateEnv(this.#env, runtime, extraEnv),
    })
  }
}
