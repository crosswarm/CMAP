// precommit-allow-secrets: synthetic override token verifies that runtime errors do not echo credentials.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  YonWorkRuntime,
  YonWorkRuntimeError,
} from '../../adapters/yonwork-adapter/src/runtime.ts'

// YonWork 桌面端的运行时关联只按 macOS 布局（~/Library/Application Support）查找；Linux 未支持，见 ADR-0010
const darwinOnly = { skip: process.platform !== 'darwin' && 'YonWork 运行时关联仅 macOS' }

const logFile = (dir: string): string => join(dir, 'calls.jsonl')

const createRuntimeAssociation = async (dir: string): Promise<string> => {
  const runtimeDir = join(dir, 'Library/Application Support/yonwork')
  await mkdir(runtimeDir, { recursive: true })
  await writeFile(join(runtimeDir, 'host-api-runtime.json'), JSON.stringify({
    port: 3211,
    token: 'synthetic-host-token',
    pid: process.pid,
    version: '1.0.9',
  }))
  await mkdir(join(runtimeDir, 'profiles/p1/userData/runtime/openclaw'), { recursive: true })
  await writeFile(join(runtimeDir, 'profiles/p1/userData/runtime/openclaw/openclaw.json'), JSON.stringify({
    gateway: { mode: 'local', auth: { mode: 'token', token: 'synthetic-gateway-token' } },
  }))
  return runtimeDir
}

const agentDirFor = (runtimeDir: string, agentId: string): string =>
  join(runtimeDir, 'profiles/p1/userData/runtime/openclaw/agents', agentId, 'agent')

const agentRecord = (runtimeDir: string, agentId: string, overrides: Record<string, unknown> = {}) => ({
  id: agentId,
  name: 'CMAP Audit',
  enabled: true,
  workspace: join(runtimeDir, 'profiles/p1/userData/workspaces', agentId),
  agentDir: agentDirFor(runtimeDir, agentId),
  ...overrides,
})

const fakeCli = async (
  dir: string,
  name: string,
  handlers: Record<string, string>,
  exactFile?: string,
): Promise<string> => {
  const file = exactFile ?? join(dir, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const log = process.env.CMAP_FAKE_LOG || (process.env.HOME ? '/calls.jsonl' : null)
const key = process.argv.slice(2).join(' ')
if (log) appendFileSync(log.startsWith('/') && process.env.CMAP_FAKE_LOG ? log : process.env.HOME + log, JSON.stringify({ bin: ${JSON.stringify(name)}, argv: process.argv.slice(2), env: {
  YONCLAW_USER_DATA_DIR: process.env.YONCLAW_USER_DATA_DIR || null,
  YONCLAW_HOST_API_URL: process.env.YONCLAW_HOST_API_URL || null,
  YONCLAW_HOST_API_TOKEN: process.env.YONCLAW_HOST_API_TOKEN || null,
  OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR || null,
  OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH || null,
  OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT || null,
  OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || null
}}) + '\\n')
const handlers = ${JSON.stringify(handlers)}
const body = handlers[key]
if (body === undefined) {
  console.error('unexpected argv:' + key)
  process.exit(9)
}
if (body === '__HANG__') setInterval(() => {}, 1000)
else if (body === '__READY_HANG__') {
  process.stdout.write(': connected\\n\\n')
  setInterval(() => {}, 1000)
}
else if (body === '__DELAY_READY__') {
  setTimeout(() => process.stdout.write(': connected\\n\\n'), 80)
  setTimeout(() => process.stdout.end(), 120)
}
else if (body === '__SPLIT_UTF8__') {
  const bytes = Buffer.from('yonworkctl 1.0.0 ✓\\n', 'utf8')
  process.stdout.write(bytes.subarray(0, bytes.length - 2))
  setTimeout(() => process.stdout.end(bytes.subarray(bytes.length - 2)), 10)
} else if (body.startsWith('__EXIT__:')) process.exit(Number(body.slice(9)))
else process.stdout.write(body)
`,
  )
  await chmod(file, 0o755)
  return file
}

const logLines = async (file: string): Promise<Array<{
  bin: string
  argv: string[]
  env: Record<string, string | null>
}>> =>
  (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      bin: string
      argv: string[]
      env: Record<string, string | null>
    })

const sameArgs = (a: readonly string[], b: readonly string[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

test('default OpenClaw binary resolves to yonworkctl sibling and never falls back to PATH', darwinOnly, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-yonwork-sibling-openclaw-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtimeDir = await createRuntimeAssociation(dir)
  const log = logFile(dir)
  const agentId = 'cmap-audit'
  const sessionKey = 'agent:cmap-audit:explicit:sibling'
  const binDir = join(dir, 'app-cli')
  const poisonDir = join(dir, 'poison-bin')
  const yonworkBin = await fakeCli(binDir, 'yonwork', {
    'gateway status': JSON.stringify({ state: 'running', port: 19001, pid: process.pid }),
    'agents list': JSON.stringify({ agents: [agentRecord(runtimeDir, agentId)] }),
  }, join(binDir, 'yonworkctl'))
  await fakeCli(binDir, 'openclaw', {
    [`gateway call tools.effective --json --params ${JSON.stringify({ agentId, sessionKey })} --timeout 5000`]:
      JSON.stringify({ result: { agentId, profile: 'minimal', groups: [] } }),
  }, join(binDir, 'openclaw'))
  await fakeCli(poisonDir, 'openclaw', {}, join(poisonDir, 'global-openclaw'))
  await symlink(join(poisonDir, 'global-openclaw'), join(poisonDir, 'openclaw'))
  const runtime = new YonWorkRuntime({
    yonworkBin,
    env: { PATH: `${poisonDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`, HOME: dir, CMAP_FAKE_LOG: log },
    timeoutMs: 5000,
  })

  const policy = await runtime.observeEffectivePolicy({ agentId, sessionKey })

  assert.deepEqual(policy.tools, [])
  const calls = await logLines(log)
  const gatewayCall = calls.find((call) => call.argv[0] === 'gateway' && call.argv[1] === 'call')
  assert.equal(gatewayCall?.bin, 'openclaw')
  assert.deepEqual(gatewayCall?.argv, ['gateway', 'call', 'tools.effective', '--json', '--params', JSON.stringify({ agentId, sessionKey }), '--timeout', '5000'])
})

test('default OpenClaw binary fails closed when yonworkctl sibling is absent', darwinOnly, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-yonwork-missing-sibling-openclaw-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtimeDir = await createRuntimeAssociation(dir)
  const agentId = 'cmap-audit'
  const sessionKey = 'agent:cmap-audit:explicit:missing-sibling'
  const binDir = join(dir, 'app-cli')
  const poisonDir = join(dir, 'poison-bin')
  const yonworkBin = await fakeCli(binDir, 'yonwork', {
    'gateway status': JSON.stringify({ state: 'running', port: 19001, pid: process.pid }),
    'agents list': JSON.stringify({ agents: [agentRecord(runtimeDir, agentId)] }),
  }, join(binDir, 'yonworkctl'))
  await fakeCli(poisonDir, 'openclaw', {
    [`gateway call tools.effective --json --params ${JSON.stringify({ agentId, sessionKey })} --timeout 5000`]:
      JSON.stringify({ result: { agentId, profile: 'poison', groups: [] } }),
  }, join(poisonDir, 'openclaw'))
  const runtime = new YonWorkRuntime({
    yonworkBin,
    env: { PATH: `${poisonDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`, HOME: dir },
    timeoutMs: 5000,
  })

  await assert.rejects(
    runtime.observeEffectivePolicy({ agentId, sessionKey }),
    (error: unknown) =>
      error instanceof YonWorkRuntimeError &&
      error.code === 'YONWORK_CLI_UNAVAILABLE' &&
      error.retryable,
  )
})

test('reads explicit cmap agent metadata and observes exact empty effective policy via gateway call', darwinOnly, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-yonwork-runtime-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtimeDir = await createRuntimeAssociation(dir)
  const log = logFile(dir)
  const agentId = 'cmap-audit'
  const sessionKey = 'agent:cmap-audit:explicit:abc123'
  const yonworkBin = await fakeCli(dir, 'yonwork', {
    '--version': 'yonworkctl 1.0.0\n',
    'agents list': JSON.stringify({ success: true, agents: [agentRecord(runtimeDir, agentId)] }),
    'gateway status': JSON.stringify({ state: 'running', port: 19001, pid: process.pid }),
  })
  const openclawBin = await fakeCli(dir, 'openclaw', {
    [`gateway call tools.effective --json --params ${JSON.stringify({ agentId, sessionKey })} --timeout 5000`]:
      JSON.stringify({ result: { agentId, profile: 'minimal', groups: [] } }),
  })
  const runtime = new YonWorkRuntime({
    yonworkBin,
    openclawBin,
    env: { PATH: process.env.PATH, HOME: dir },
    timeoutMs: 5000,
  })

  const metadata = await runtime.readAgentMetadata('yonwork:cmap-audit')
  const policy = await runtime.observeEffectivePolicy({ agentId, sessionKey })

  assert.equal(metadata.availability, 'available')
  assert.equal(metadata.agentId, agentId)
  assert.equal(metadata.cliVersion, '1.0.0')
  assert.equal(metadata.runtimeSource, 'yonwork')
  assert.equal(policy.agentId, agentId)
  assert.equal(policy.sessionKey, sessionKey)
  assert.deepEqual(policy.tools, [])
  assert.deepEqual(policy.notices, [])
  assert.match(policy.policySha256, /^[a-f0-9]{64}$/)
  const calls = await logLines(log)
  assert.deepEqual(calls.map((call) => call.argv), [
    ['--version'],
    ['agents', 'list'],
    ['gateway', 'status'],
    ['agents', 'list'],
    ['gateway', 'call', 'tools.effective', '--json', '--params', JSON.stringify({ agentId, sessionKey }), '--timeout', '5000'],
  ])
  assert.equal(calls.every((call) => call.env.YONCLAW_USER_DATA_DIR === runtimeDir), true)
  assert.equal(calls.every((call) => call.env.YONCLAW_HOST_API_TOKEN === null), true)
  const gatewayCall = calls.find((call) => call.bin === 'openclaw')
  assert.equal(gatewayCall?.env.OPENCLAW_STATE_DIR, join(runtimeDir, 'profiles/p1/userData/runtime/openclaw'))
  assert.equal(gatewayCall?.env.OPENCLAW_CONFIG_PATH, join(runtimeDir, 'profiles/p1/userData/runtime/openclaw/openclaw.json'))
  assert.equal(gatewayCall?.env.OPENCLAW_GATEWAY_PORT, '19001')
  assert.equal(gatewayCall?.env.OPENCLAW_GATEWAY_TOKEN, null)
})

test('policy hash ignores the per-attempt session key', darwinOnly, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-yonwork-policy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtimeDir = await createRuntimeAssociation(dir)
  const agentId = 'cmap-audit'
  const first = 'agent:cmap-audit:explicit:first'
  const second = 'agent:cmap-audit:explicit:second'
  const openclawBin = await fakeCli(dir, 'openclaw', {
    [`gateway call tools.effective --json --params ${JSON.stringify({ agentId, sessionKey: first })} --timeout 5000`]:
      JSON.stringify({ result: { agentId, profile: 'minimal', groups: [] } }),
    [`gateway call tools.effective --json --params ${JSON.stringify({ agentId, sessionKey: second })} --timeout 5000`]:
      JSON.stringify({ result: { agentId, profile: 'minimal', sessionKey: second, groups: [], notices: [] } }),
  })
  const runtime = new YonWorkRuntime({
    yonworkBin: await fakeCli(dir, 'yonwork', {
      'gateway status': JSON.stringify({ state: 'running', port: 19001, pid: process.pid }),
      'agents list': JSON.stringify({ agents: [agentRecord(runtimeDir, agentId)] }),
    }),
    openclawBin,
    env: { PATH: process.env.PATH, HOME: dir },
    timeoutMs: 5000,
  })

  const a = await runtime.observeEffectivePolicy({ agentId, sessionKey: first })
  const b = await runtime.observeEffectivePolicy({ agentId, sessionKey: second })

  assert.equal(a.policySha256, b.policySha256)
})

test('prepares empty session, streams chat, exposes event readiness, and aborts fixed own scope', darwinOnly, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-yonwork-chat-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtimeDir = await createRuntimeAssociation(dir)
  const log = logFile(dir)
  const sessionKey = 'agent:cmap-audit:explicit:run'
  const runId = 'run-123'
  const message = '{"goal":"validate"}'
  const openclawBin = await fakeCli(dir, 'openclaw', {
    [`gateway call sessions.patch --json --params ${JSON.stringify({ key: sessionKey })} --timeout 5000`]:
      JSON.stringify({ result: { ok: true } }),
  })
  const yonworkBin = await fakeCli(dir, 'yonwork', {
    'gateway status': JSON.stringify({ state: 'running', port: 19001, pid: process.pid }),
    'agents list': JSON.stringify({ agents: [agentRecord(runtimeDir, 'cmap-audit')] }),
    [`chat send --json ${JSON.stringify({ sessionKey, message, deliver: false, attachments: [], idempotencyKey: runId })}`]:
      ': connected\n\nevent: chat.run-id\ndata: {"runId":"run-123","sessionKey":"agent:cmap-audit:explicit:run"}\n\n',
    'events tail': '__READY_HANG__',
    [`api /api/chat/abort --method POST --json ${JSON.stringify({ sessionKey, runId })}`]:
      JSON.stringify({ ok: true }),
  })
  const runtime = new YonWorkRuntime({
    yonworkBin,
    openclawBin,
    env: { PATH: process.env.PATH, HOME: dir },
    timeoutMs: 5000,
  })
  const chunks: Buffer[] = []

  await runtime.prepareEmptySession({ sessionKey })
  const chat = await runtime.sendChat({
    sessionKey,
    message,
    idempotencyKey: runId,
    timeoutMs: 5000,
    onChunk: (chunk) => chunks.push(chunk),
  })
  await chat.ready
  const watcher = await runtime.watchEvents({ timeoutMs: 5000, onChunk: () => undefined })
  await watcher.ready
  await runtime.abortChat({ sessionKey, runId })
  await watcher.stop()
  await chat.finished

  assert.match(Buffer.concat(chunks).toString('utf8'), /chat.run-id/)
  const calls = await logLines(log)
  const argv = calls.map((call) => call.argv)
  assert.ok(argv.some((args) => sameArgs(args, ['gateway', 'status'])))
  assert.ok(argv.some((args) => sameArgs(args, [
    'gateway',
    'call',
    'sessions.patch',
    '--json',
    '--params',
    JSON.stringify({ key: sessionKey }),
    '--timeout',
    '5000',
  ])))
  assert.equal(calls.every((call) => call.env.YONCLAW_USER_DATA_DIR === runtimeDir), true)
  assert.ok(argv.some((args) => sameArgs(
    args,
    ['chat', 'send', '--json', JSON.stringify({ sessionKey, message, deliver: false, attachments: [], idempotencyKey: runId })],
  )))
  assert.ok(argv.some((args) => args.join(' ') === 'events tail'))
  assert.ok(argv.some((args) => sameArgs(
    args,
    ['api', '/api/chat/abort', '--method', 'POST', '--json', JSON.stringify({ sessionKey, runId })],
  )))
})

test('rejects Host API overrides before spawning and never echoes values', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-yonwork-override-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const secret = 'synthetic-host-token'
  const runtime = new YonWorkRuntime({
    yonworkBin: await fakeCli(dir, 'yonwork', { '--version': 'should not run' }),
    openclawBin: await fakeCli(dir, 'openclaw', {}),
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      YONCLAW_HOST_API_TOKEN: secret,
    },
    timeoutMs: 5000,
  })

  await assert.rejects(
    runtime.readAgentMetadata('yonwork:cmap-audit'),
    (error) => error instanceof YonWorkRuntimeError &&
      error.code === 'YONWORK_OVERRIDE_REJECTED' &&
      !String(error.message).includes(secret),
  )
})

test('fails closed when current Host runtime association is missing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-yonwork-no-runtime-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtime = new YonWorkRuntime({
    yonworkBin: await fakeCli(dir, 'yonwork', { '--version': 'should not run' }),
    openclawBin: await fakeCli(dir, 'openclaw', {}),
    env: { PATH: process.env.PATH, HOME: dir },
    timeoutMs: 5000,
  })

  await assert.rejects(
    runtime.readAgentMetadata('yonwork:cmap-audit'),
    (error) => error instanceof YonWorkRuntimeError &&
      error.code === 'YONWORK_RUNTIME_UNAVAILABLE',
  )
})

test('fails closed when Host agent metadata points outside the active runtime', darwinOnly, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-yonwork-agentdir-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtimeDir = await createRuntimeAssociation(dir)
  const agentId = 'cmap-audit'
  const runtime = new YonWorkRuntime({
    yonworkBin: await fakeCli(dir, 'yonwork', {
      '--version': 'yonworkctl 1.0.0\n',
      'agents list': JSON.stringify({
        agents: [agentRecord(runtimeDir, agentId, {
          agentDir: join(dir, 'other-profile/runtime/openclaw/agents/cmap-audit/agent'),
        })],
      }),
    }),
    openclawBin: await fakeCli(dir, 'openclaw', {}),
    env: { PATH: process.env.PATH, HOME: dir },
    timeoutMs: 5000,
  })

  await assert.rejects(
    runtime.readAgentMetadata('yonwork:cmap-audit'),
    (error) => error instanceof YonWorkRuntimeError &&
      error.code === 'YONWORK_RUNTIME_MISMATCH',
  )
})

test('fails closed when OpenClaw gateway association is missing', darwinOnly, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-yonwork-no-gateway-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await createRuntimeAssociation(dir)
  const runtime = new YonWorkRuntime({
    yonworkBin: await fakeCli(dir, 'yonwork', {
      'gateway status': JSON.stringify({ state: 'stopped', port: 19001 }),
    }),
    openclawBin: await fakeCli(dir, 'openclaw', {}),
    env: { PATH: process.env.PATH, HOME: dir },
    timeoutMs: 5000,
  })

  await assert.rejects(
    runtime.observeEffectivePolicy({ agentId: 'cmap-audit', sessionKey: 's1' }),
    (error) => error instanceof YonWorkRuntimeError &&
      error.code === 'YONWORK_GATEWAY_UNAVAILABLE',
  )
})

test('fails closed when same-profile OpenClaw config targets a remote gateway', darwinOnly, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-yonwork-remote-gateway-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtimeDir = await createRuntimeAssociation(dir)
  await writeFile(
    join(runtimeDir, 'profiles/p1/userData/runtime/openclaw/openclaw.json'),
    JSON.stringify({ gateway: { mode: 'remote', remote: { url: 'wss://gateway.example.test' } } }),
  )
  const runtime = new YonWorkRuntime({
    yonworkBin: await fakeCli(dir, 'yonwork', {
      'gateway status': JSON.stringify({ state: 'running', port: 19001, pid: process.pid }),
      'agents list': JSON.stringify({ agents: [agentRecord(runtimeDir, 'cmap-audit')] }),
    }),
    openclawBin: await fakeCli(dir, 'openclaw', {}),
    env: { PATH: process.env.PATH, HOME: dir },
    timeoutMs: 5000,
  })

  await assert.rejects(
    runtime.observeEffectivePolicy({ agentId: 'cmap-audit', sessionKey: 'agent:cmap-audit:explicit:s1' }),
    (error) => error instanceof YonWorkRuntimeError &&
      error.code === 'YONWORK_GATEWAY_UNAVAILABLE',
  )
})

test('bounds subprocess timeout and stdout size while preserving split UTF-8', darwinOnly, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-yonwork-bounds-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtimeDir = await createRuntimeAssociation(dir)
  const hanging = new YonWorkRuntime({
    yonworkBin: await fakeCli(dir, 'yonwork', { '--version': '__HANG__' }),
    openclawBin: await fakeCli(dir, 'openclaw', {}),
    env: { PATH: process.env.PATH, HOME: dir },
    timeoutMs: 50,
  })
  await assert.rejects(
    hanging.readAgentMetadata('yonwork:cmap-audit'),
    (error) => error instanceof YonWorkRuntimeError && error.code === 'YONWORK_CLI_TIMEOUT',
  )

  const noisy = new YonWorkRuntime({
    yonworkBin: await fakeCli(dir, 'yonwork', { '--version': 'x'.repeat(2048) }),
    openclawBin: await fakeCli(dir, 'openclaw', {}),
    env: { PATH: process.env.PATH, HOME: dir },
    timeoutMs: 5000,
    maxOutputBytes: 32,
  })
  await assert.rejects(
    noisy.readAgentMetadata('yonwork:cmap-audit'),
    (error) => error instanceof YonWorkRuntimeError && error.code === 'YONWORK_OUTPUT_LIMIT',
  )

  const agentId = 'cmap-audit'
  const utf8 = new YonWorkRuntime({
    yonworkBin: await fakeCli(dir, 'yonwork', {
      '--version': '__SPLIT_UTF8__',
      'agents list': JSON.stringify({ agents: [agentRecord(runtimeDir, agentId)] }),
    }),
    openclawBin: await fakeCli(dir, 'openclaw', {}),
    env: { PATH: process.env.PATH, HOME: dir },
    timeoutMs: 5000,
  })
  const metadata = await utf8.readAgentMetadata('yonwork:cmap-audit')
  assert.equal(metadata.cliVersion, '1.0.0')
})

test('stream readiness waits for real handshake and onChunk exceptions are sanitized', darwinOnly, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-yonwork-stream-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await createRuntimeAssociation(dir)
  const sessionKey = 'agent:cmap-audit:explicit:stream'
  const idempotencyKey = 'run-stream'
  const yonworkBin = await fakeCli(dir, 'yonwork', {
    [`chat send --json ${JSON.stringify({ sessionKey, message: 'hello', deliver: false, attachments: [], idempotencyKey })}`]:
      '__DELAY_READY__',
    [`chat send --json ${JSON.stringify({ sessionKey, message: 'throw', deliver: false, attachments: [], idempotencyKey: 'run-throw' })}`]:
      ': connected\n\n',
  })
  const runtime = new YonWorkRuntime({
    yonworkBin,
    openclawBin: await fakeCli(dir, 'openclaw', {}),
    env: { PATH: process.env.PATH, HOME: dir },
    timeoutMs: 5000,
  })

  const chat = await runtime.sendChat({
    sessionKey,
    message: 'hello',
    idempotencyKey,
    timeoutMs: 5000,
    onChunk: () => undefined,
  })
  const early = await Promise.race([
    chat.ready.then(() => 'ready'),
    new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 20)),
  ])
  assert.equal(early, 'waiting')
  await chat.ready
  await chat.finished

  const failing = await runtime.sendChat({
    sessionKey,
    message: 'throw',
    idempotencyKey: 'run-throw',
    timeoutMs: 5000,
    onChunk: () => {
      throw new Error('synthetic chunk failure')
    },
  })
  await assert.rejects(
    failing.finished,
    (error) => error instanceof YonWorkRuntimeError &&
      error.code === 'YONWORK_CHUNK_HANDLER_FAILED' &&
      !String(error.message).includes('synthetic'),
  )
})

test('fails closed on malformed, non-empty, or noticed effective policy', darwinOnly, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-yonwork-drift-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtimeDir = await createRuntimeAssociation(dir)
  const agentId = 'cmap-audit'
  const cases = [
    ['missing-agent', { result: { profile: 'minimal', groups: [] } }],
    ['missing-profile', { result: { agentId, groups: [] } }],
    ['empty-profile', { result: { agentId, profile: '   ', groups: [] } }],
    ['null-notices', { result: { agentId, profile: 'minimal', groups: [], notices: null } }],
    ['missing-groups', { result: { agentId, profile: 'minimal', tools: [] } }],
    ['non-empty-tools', { result: { agentId, profile: 'minimal', groups: [{ tools: [{ name: 'shell' }] }] } }],
    ['notice', { result: { agentId, profile: 'minimal', groups: [], notices: [{ message: 'missing MCP catalog' }] } }],
    ['wrong-agent', { result: { agentId: 'cmap-other', profile: 'minimal', groups: [] } }],
  ] as const
  const handlers = Object.fromEntries(cases.map(([, body], index) => [
    `gateway call tools.effective --json --params ${JSON.stringify({ agentId, sessionKey: `s${index + 1}` })} --timeout 5000`,
    JSON.stringify(body),
  ]))
  const runtime = new YonWorkRuntime({
    yonworkBin: await fakeCli(dir, 'yonwork', {
      'gateway status': JSON.stringify({ state: 'running', port: 19001, pid: process.pid }),
      'agents list': JSON.stringify({ agents: [agentRecord(runtimeDir, agentId)] }),
    }),
    openclawBin: await fakeCli(dir, 'openclaw', handlers),
    env: { PATH: process.env.PATH, HOME: dir },
    timeoutMs: 5000,
  })

  for (let index = 0; index < cases.length; index += 1) {
    await assert.rejects(
      runtime.observeEffectivePolicy({ agentId, sessionKey: `s${index + 1}` }),
      (error) => error instanceof YonWorkRuntimeError &&
        error.code === 'YONWORK_POLICY_UNAVAILABLE',
    )
  }
})
