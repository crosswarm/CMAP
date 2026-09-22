import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { TaskEnvelopeV1 } from '#domain-model'
import { AdapterError } from '#adapter-sdk'
import { KimiAdapter } from '../../adapters/kimi-adapter/src/index.ts'

const envelope = (taskId: string, timeoutSeconds = 30): TaskEnvelopeV1 => ({
  schema: 'cmap/task-envelope/v1',
  identity: {
    mission_id: 'mis-kimi',
    task_id: taskId,
    idempotency_key: `mis-kimi:${taskId}`,
    revision: 3,
  },
  classification: {
    task_type: 'inspect',
    requested_capability: 'code.analyze',
    risk_level: 'read-meta',
  },
  goal: {
    statement: '生成报告',
    success_definition: [
      { criterion_id: 'C1', metric: 'ok', operator: 'eq', expected: true },
    ],
  },
  environment: {},
  execution_policy: { timeout_seconds: timeoutSeconds, max_attempts: 1 },
  permissions: { forbidden: [] },
  evidence_requirements: { required_artifact_roles: ['report'] },
  output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
})

const sha256 = (s: string): string =>
  createHash('sha256').update(s).digest('hex')

const writeExecutable = async (path: string, source: string): Promise<void> => {
  await writeFile(path, source)
  await chmod(path, 0o755)
}

const makeSandbox = async (dir: string): Promise<string> => {
  const bin = join(dir, 'fake-sandbox-exec')
  await writeExecutable(
    bin,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const args = process.argv.slice(2)
if (args[0] !== '-p' || !args[1] || !args[2]) process.exit(91)
process.env.FAKE_SANDBOX_PROFILE = args[1]
const child = spawn(args[2], args.slice(3), { stdio: 'inherit', env: process.env, detached: false })
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)))
child.on('error', () => process.exit(92))
`,
  )
  return bin
}

const makeKimi = async (dir: string, body: string): Promise<string> => {
  const bin = join(dir, 'fake-kimi')
  await writeExecutable(bin, `#!/usr/bin/env node\n${body}\n`)
  return bin
}

const makeCredentialHome = async (dir: string): Promise<string> => {
  await mkdir(join(dir, 'credentials'))
  await mkdir(join(dir, 'oauth'))
  await writeFile(join(dir, 'credentials/kimi-code.json'), '{}')
  return dir
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const kimiRuntimeDirs = async (): Promise<Set<string>> =>
  new Set(
    (await readdir(tmpdir(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('cmap-kimi-'))
      .map((entry) => entry.name),
  )

const adapter = (
  bin: string,
  sandboxBin: string,
  credentialHome: string,
): KimiAdapter => new KimiAdapter({ bin, sandboxBin, credentialHome })

const startAndWait = async (
  a: KimiAdapter,
  e: TaskEnvelopeV1,
  worktree: string,
) => {
  const binding = await a.startTask(e, {
    token: 'test',
    runner_id: 'runner-1',
    trace_id: 'trace-1',
    correlation_id: 'corr-1',
    worktree,
    deadline_at: new Date(Date.now() + 30_000).toISOString(),
  })
  for (;;) {
    const status = await a.getStatus(binding)
    if (status.terminal_observed) return binding
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('discover reports Kimi bounded capabilities', async () => {
  const a = new KimiAdapter({
    bin: '/bin/false',
    sandboxBin: '/bin/false',
    credentialHome: tmpdir(),
  })
  assert.deepEqual(await a.discover(), {
    adapter_id: 'kimi-adapter',
    agent_id: 'kimi',
    provider: 'moonshot-kimi',
    version: '0.1.0',
    capabilities: ['code.analyze', 'code.implement'],
    risk_ceiling: 'mutating',
    supports_session_resume: false,
    supports_worktree_isolation: true,
    execution_level: 'B',
  })
})

test('prepareBinding is deterministic and performs no runtime IO', async () => {
  const a = new KimiAdapter({
    bin: '/bin/false',
    sandboxBin: '/bin/false',
    credentialHome: tmpdir(),
  })
  const e = envelope('tsk-prepare')
  const ctx = {
    token: 'test',
    runner_id: 'runner-1',
    trace_id: 'trace-1',
    correlation_id: 'corr-1',
    worktree: tmpdir(),
    deadline_at: new Date(Date.now() + 30_000).toISOString(),
  }
  const before = await kimiRuntimeDirs()

  assert.deepEqual(a.prepareBinding(e, ctx), {
    adapter: 'kimi-adapter',
    remote_task_id: 'kimi:tsk-prepare:3',
    protocol: 'kimi-cli-stream-json',
    protocol_version: '0.1.0',
    runner_id: 'runner-1',
  })
  assert.deepEqual(a.prepareBinding(e, ctx), a.prepareBinding(e, ctx))
  assert.deepEqual(await kimiRuntimeDirs(), before)
})

test('exit 0 without valid final assistant JSON fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-invalid-'))
  await makeCredentialHome(root)
  const sandboxBin = await makeSandbox(root)
  const kimi = await makeKimi(
    root,
    `console.log(JSON.stringify({ role: 'assistant', content: 'not json' }))`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const binding = await startAndWait(a, envelope('tsk-invalid'), root)
  const status = await a.getStatus(binding)

  assert.equal(status.status, 'failed')
  await assert.rejects(
    a.collectResult(binding),
    (err) =>
      err instanceof AdapterError &&
      err.code === 'RESULT_UNPARSABLE' &&
      err.fingerprint === 'kimi-result-unparsable:non_json' &&
      err.message.includes(sha256('not json')),
  )
})

test('sets only runtime env needed by Kimi and does not leak host secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-env-'))
  await makeCredentialHome(root)
  const sandboxBin = await makeSandbox(root)
  const envFile = join(root, 'env.json')
  await writeFile(join(root, 'report.txt'), 'ok')
  const kimi = await makeKimi(
    root,
    `require('node:fs').writeFileSync('${envFile}', JSON.stringify({
  HOME: process.env.HOME,
  KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
  TMPDIR: process.env.TMPDIR,
  LEAK: process.env.CMAP_SHOULD_NOT_LEAK,
  MODEL_OVERRIDE: process.env.KIMI_MODEL_OVERRIDE
}))
console.log(JSON.stringify({ role: 'assistant', content: JSON.stringify({
  status: 'completed',
  summary: 'ok',
  criterion_results: [{ criterion_id: 'C1', actual: 'ok', passed: true, evidence_artifact_ids: ['a1'] }],
  artifacts: [{ artifact_id: 'a1', role: 'report', uri: 'report.txt', media_type: 'text/plain', size_bytes: 2, sha256: '${sha256('ok')}' }],
  findings: [],
  error: null
}) }))`,
  )
  process.env['CMAP_SHOULD_NOT_LEAK'] = 'SECRET_ENV'
  process.env['KIMI_MODEL_OVERRIDE'] = 'SECRET_MODEL'
  const a = adapter(kimi, sandboxBin, root)
  const binding = await startAndWait(a, envelope('tsk-env'), root)
  await a.collectResult(binding)
  delete process.env['CMAP_SHOULD_NOT_LEAK']
  delete process.env['KIMI_MODEL_OVERRIDE']

  const seen = JSON.parse(await readFile(envFile, 'utf8')) as Record<
    string,
    unknown
  >
  assert.equal(seen['HOME'], process.env['HOME'])
  assert.equal(typeof seen['KIMI_CODE_HOME'], 'string')
  assert.equal(typeof seen['TMPDIR'], 'string')
  assert.notEqual(seen['KIMI_CODE_HOME'], seen['HOME'])
  assert.match(String(seen['TMPDIR']), /cmap-kimi-/)
  assert.equal(seen['LEAK'], undefined)
  assert.equal(seen['MODEL_OVERRIDE'], undefined)
})

test('nonzero exit cannot return completed even when output is valid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-nonzero-'))
  await makeCredentialHome(root)
  const sandboxBin = await makeSandbox(root)
  await writeFile(join(root, 'report.txt'), 'ok')
  const kimi = await makeKimi(
    root,
    `console.log(JSON.stringify({ role: 'assistant', content: JSON.stringify({
  status: 'completed',
  summary: 'ok',
  criterion_results: [{ criterion_id: 'C1', actual: 'ok', passed: true, evidence_artifact_ids: ['a1'] }],
  artifacts: [{ artifact_id: 'a1', role: 'report', uri: 'report.txt', media_type: 'text/plain', size_bytes: 2, sha256: '${sha256('ok')}' }],
  findings: [],
  error: null
}) }))
process.exit(7)`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const binding = await startAndWait(a, envelope('tsk-nonzero'), root)

  await assert.rejects(
    a.collectResult(binding),
    (err) => err instanceof AdapterError && err.code === 'TASK_FAILED',
  )
})

test('normalizes identity from envelope and verifies real evidence files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-success-'))
  await makeCredentialHome(root)
  const sandboxBin = await makeSandbox(root)
  await writeFile(join(root, 'report.txt'), 'ok')
  const kimi = await makeKimi(
    root,
    `const args = process.argv.slice(2)
if (!args.includes('--agent-file') || !args.includes('--skills-dir') || !args.includes('-p')) process.exit(81)
if (args.includes('--auto')) process.exit(82)
if (!args.includes('--output-format') || args[args.indexOf('--output-format') + 1] !== 'stream-json') process.exit(83)
if (!args[args.indexOf('-p') + 1].includes('"required"')) process.exit(84)
console.log(JSON.stringify({ role: 'meta', content: 'Kimi 2.0.1' }))
console.log(JSON.stringify({ role: 'assistant', content: JSON.stringify({
  status: 'completed',
  summary: 'ok',
  criterion_results: [{ criterion_id: 'C1', actual: 'ok', passed: true, evidence_artifact_ids: ['a1'] }],
  artifacts: [{ artifact_id: 'a1', role: 'report', uri: 'report.txt', media_type: 'text/plain', size_bytes: 999, sha256: '${sha256('ok')}' }],
  findings: [],
  error: null
}) }))`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const binding = await startAndWait(a, envelope('tsk-success'), root)
  const result = await a.collectResult(binding)

  assert.equal(result.mission_id, 'mis-kimi')
  assert.equal(result.task_id, 'tsk-success')
  assert.equal(result.attempt, 3)
  assert.equal(result.status, 'completed')
  assert.equal(result.artifacts[0]?.size_bytes, 2)
  assert.equal(result.artifacts[0]?.sha256, sha256('ok'))
})

test('same idempotency key reuses one pending launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-idempotent-'))
  await makeCredentialHome(root)
  const sandboxBin = await makeSandbox(root)
  const countFile = join(root, 'count.txt')
  const kimi = await makeKimi(
    root,
    `const fs = require('node:fs')
const count = fs.existsSync('${countFile}') ? Number(fs.readFileSync('${countFile}', 'utf8')) : 0
fs.writeFileSync('${countFile}', String(count + 1))
setTimeout(() => console.log(JSON.stringify({ role: 'assistant', content: '{}' })), 100)`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const e = envelope('tsk-idempotent')
  const ctx = {
    token: 'test',
    runner_id: 'runner-1',
    trace_id: 'trace-1',
    correlation_id: 'corr-1',
    worktree: root,
    deadline_at: new Date(Date.now() + 30_000).toISOString(),
  }

  const [a1, a2] = await Promise.all([a.startTask(e, ctx), a.startTask(e, ctx)])
  assert.deepEqual(a1, a2)
  for (;;) {
    if ((await a.getStatus(a1)).terminal_observed) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(await readFile(countFile, 'utf8'), '1')
})

test('startTask reuses the prepared binding and guards before launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-binding-'))
  await makeCredentialHome(root)
  const sandboxBin = await makeSandbox(root)
  const marker = join(root, 'spawned.txt')
  const kimi = await makeKimi(
    root,
    `require('node:fs').writeFileSync('${marker}', 'spawned')
setTimeout(() => console.log(JSON.stringify({ role: 'assistant', content: '{}' })), 10)`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const e = envelope('tsk-binding')
  const ctx = {
    token: 'test',
    runner_id: 'runner-1',
    trace_id: 'trace-1',
    correlation_id: 'corr-1',
    worktree: root,
    deadline_at: new Date(Date.now() + 30_000).toISOString(),
    beforeSend: async (binding: ReturnType<KimiAdapter['prepareBinding']>) => {
      assert.deepEqual(binding, a.prepareBinding(e, ctx))
      assert.equal(await fileExists(marker), false)
    },
  }

  const binding = await a.startTask(e, ctx)
  assert.deepEqual(binding, a.prepareBinding(e, ctx))
  for (;;) {
    if ((await a.getStatus(binding)).terminal_observed) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(await fileExists(marker), true)
})

test('beforeSend rejection blocks Kimi launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-before-send-'))
  await makeCredentialHome(root)
  const sandboxBin = await makeSandbox(root)
  const marker = join(root, 'spawned.txt')
  const kimi = await makeKimi(
    root,
    `require('node:fs').writeFileSync('${marker}', 'spawned')`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const before = await kimiRuntimeDirs()

  await assert.rejects(
    a.startTask(envelope('tsk-before-send'), {
      token: 'test',
      runner_id: 'runner-1',
      trace_id: 'trace-1',
      correlation_id: 'corr-1',
      worktree: root,
      deadline_at: new Date(Date.now() + 30_000).toISOString(),
      beforeSend: async () => {
        throw new Error('blocked')
      },
    }),
    /blocked/,
  )
  assert.equal(await fileExists(marker), false)
  assert.equal(await fileExists(root), true)
  const leaked = [...(await kimiRuntimeDirs())].filter((name) => !before.has(name))
  assert.deepEqual(leaked, [])
})

test('beforeSend rejection cleans owned Kimi runtime without launching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-before-send-owned-'))
  await makeCredentialHome(root)
  const sandboxBin = await makeSandbox(root)
  const marker = join(root, 'spawned.txt')
  const kimi = await makeKimi(
    root,
    `require('node:fs').writeFileSync('${marker}', 'spawned')`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const before = await kimiRuntimeDirs()
  let runtimeDir = ''

  await assert.rejects(
    a.startTask(envelope('tsk-before-send-owned'), {
      token: 'test',
      runner_id: 'runner-1',
      trace_id: 'trace-1',
      correlation_id: 'corr-1',
      deadline_at: new Date(Date.now() + 30_000).toISOString(),
      beforeSend: async () => {
        const created = [...(await kimiRuntimeDirs())].filter(
          (name) => !before.has(name),
        )
        assert.equal(created.length, 1)
        runtimeDir = join(tmpdir(), created[0]!)
        assert.equal(await fileExists(join(runtimeDir, 'home/credentials')), true)
        assert.equal(await fileExists(join(runtimeDir, 'work')), true)
        throw new Error('blocked')
      },
    }),
    /blocked/,
  )
  assert.equal(await fileExists(marker), false)
  assert.equal(await fileExists(runtimeDir), false)
})

test('timeout cancels the process group and reports failed status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-timeout-'))
  await makeCredentialHome(root)
  const sandboxBin = await makeSandbox(root)
  const marker = join(root, 'terminated.txt')
  const kimi = await makeKimi(
    root,
    `process.on('SIGTERM', () => {
  require('node:fs').writeFileSync('${marker}', 'term')
  process.exit(0)
})
setInterval(() => {}, 1000)`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const binding = await startAndWait(a, envelope('tsk-timeout', 0.5), root)
  const status = await a.getStatus(binding)

  assert.equal(status.status, 'failed')
  assert.match(status.detail ?? '', /timeout/i)
  await assert.rejects(
    a.collectResult(binding),
    (err) => err instanceof AdapterError && err.code === 'TASK_FAILED',
  )
})

test('explicit cancel kills TERM-resistant process and reports canceled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-cancel-'))
  await makeCredentialHome(root)
  const sandboxBin = await makeSandbox(root)
  const kimi = await makeKimi(
    root,
    `process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const binding = await a.startTask(envelope('tsk-cancel'), {
    token: 'test',
    runner_id: 'runner-1',
    trace_id: 'trace-1',
    correlation_id: 'corr-1',
    worktree: root,
    deadline_at: new Date(Date.now() + 30_000).toISOString(),
  })
  await a.cancel(binding, 'test cancel')
  for (;;) {
    const status = await a.getStatus(binding)
    if (status.terminal_observed) {
      assert.equal(status.status, 'canceled')
      assert.match(status.detail ?? '', /canceled/i)
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
})

test('expired or invalid deadlines are rejected before spawning Kimi', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-deadline-'))
  await makeCredentialHome(root)
  const sandboxBin = await makeSandbox(root)
  const marker = join(root, 'spawned.txt')
  const kimi = await makeKimi(
    root,
    `require('node:fs').writeFileSync('${marker}', 'spawned')`,
  )
  const a = adapter(kimi, sandboxBin, root)

  await assert.rejects(
    a.startTask(envelope('tsk-expired'), {
      token: 'test',
      runner_id: 'runner-1',
      trace_id: 'trace-1',
      correlation_id: 'corr-1',
      worktree: root,
      deadline_at: new Date(Date.now() - 1000).toISOString(),
    }),
    (err) => err instanceof AdapterError && err.code === 'DEADLINE_EXPIRED',
  )
  assert.equal(await fileExists(marker), false)
})

test('parses final JSONL line even without trailing newline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-trailing-'))
  await makeCredentialHome(root)
  const sandboxBin = await makeSandbox(root)
  await writeFile(join(root, 'report.txt'), 'ok')
  const kimi = await makeKimi(
    root,
    `process.stdout.write(JSON.stringify({ role: 'assistant', content: JSON.stringify({
  status: 'completed',
  summary: 'ok',
  criterion_results: [{ criterion_id: 'C1', actual: 'ok', passed: true, evidence_artifact_ids: ['a1'] }],
  artifacts: [{ artifact_id: 'a1', role: 'report', uri: 'report.txt', media_type: 'text/plain', size_bytes: 2, sha256: '${sha256('ok')}' }],
  findings: [],
  error: null
}) }))`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const binding = await startAndWait(a, envelope('tsk-trailing'), root)
  const result = await a.collectResult(binding)

  assert.equal(result.status, 'completed')
})

test('failed status does not expose raw stderr', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-stderr-'))
  await makeCredentialHome(root)
  const sandboxBin = await makeSandbox(root)
  const kimi = await makeKimi(
    root,
    `process.stderr.write('SECRET_STDERR'.repeat(10000))
process.exit(9)`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const binding = await startAndWait(a, envelope('tsk-stderr'), root)
  const status = await a.getStatus(binding)

  assert.equal(status.status, 'failed')
  assert.doesNotMatch(status.detail ?? '', /SECRET_STDERR/)
  assert.ok((status.detail ?? '').length < 200)
})

test('subscribe emits sanitized events without raw assistant or tool bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-events-'))
  await makeCredentialHome(root)
  const sandboxBin = await makeSandbox(root)
  const kimi = await makeKimi(
    root,
    `console.log(JSON.stringify({ role: 'tool', content: 'SECRET_TOOL_OUTPUT', name: 'shell' }))
console.log(JSON.stringify({ role: 'assistant', content: JSON.stringify({ status: 'failed', summary: 'SECRET_FINAL', criterion_results: [], artifacts: [], findings: [], error: { code: 'X', message: 'bad', retryable: false } }) }))`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const binding = await a.startTask(envelope('tsk-events'), {
    token: 'test',
    runner_id: 'runner-1',
    trace_id: 'trace-1',
    correlation_id: 'corr-1',
    worktree: root,
    deadline_at: new Date(Date.now() + 30_000).toISOString(),
  })
  const events: unknown[] = []
  await a.subscribe(binding, async (event) => {
    events.push(event)
  })
  for (;;) {
    if ((await a.getStatus(binding)).terminal_observed) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  assert.doesNotMatch(JSON.stringify(events), /SECRET_/)
  assert.ok(events.some((e) => JSON.stringify(e).includes('tool_call')))
  assert.equal(JSON.stringify(events).includes('shell'), false)
})

test('health uses permissive sandbox probe and checks credential refs without creating runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-health-'))
  await makeCredentialHome(root)
  const sandboxBin = join(root, 'strict-sandbox')
  await writeExecutable(
    sandboxBin,
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args[1] === '(version 1)') process.exit(93)
const result = spawnSync(args[2], args.slice(3), { stdio: 'inherit' })
process.exit(result.status ?? 0)
`,
  )
  const kimi = await makeKimi(
    root,
    `if (process.argv.includes('--version')) { console.log('kimi 2.0.1'); process.exit(0) }
process.exit(99)`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const health = await a.health()

  assert.equal(health.state, 'healthy')
  assert.equal(health.detail, 'kimi 2.0.1')
  assert.match(health.checked_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(await fileExists(join(root, 'home')), false)
})

test('cleanup removes owned runtime but preserves caller worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-cleanup-'))
  await makeCredentialHome(root)
  const worktree = join(root, 'worktree')
  await mkdir(worktree)
  const sandboxBin = await makeSandbox(root)
  await writeFile(join(worktree, 'report.txt'), 'ok')
  const runtimeFile = join(root, 'runtime.txt')
  const kimi = await makeKimi(
    root,
    `require('node:fs').writeFileSync('${runtimeFile}', process.env.TMPDIR)
console.log(JSON.stringify({ role: 'assistant', content: JSON.stringify({
  status: 'completed',
  summary: 'ok',
  criterion_results: [{ criterion_id: 'C1', actual: 'ok', passed: true, evidence_artifact_ids: ['a1'] }],
  artifacts: [{ artifact_id: 'a1', role: 'report', uri: 'report.txt', media_type: 'text/plain', size_bytes: 2, sha256: '${sha256('ok')}' }],
  findings: [],
  error: null
}) }))`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const binding = await startAndWait(a, envelope('tsk-cleanup'), worktree)
  const runtimeDir = await readFile(runtimeFile, 'utf8')
  await (
    a as unknown as {
      cleanup(
        binding: Awaited<ReturnType<KimiAdapter['startTask']>>,
      ): Promise<void>
    }
  ).cleanup(binding)

  assert.equal(await fileExists(runtimeDir), false)
  assert.equal(await fileExists(worktree), true)
})

test('cleanup preserves idempotency so duplicate task does not spawn again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-cleanup-idempotency-'))
  await makeCredentialHome(root)
  const sandboxBin = await makeSandbox(root)
  const countFile = join(root, 'count.txt')
  await writeFile(join(root, 'report.txt'), 'ok')
  const kimi = await makeKimi(
    root,
    `const fs = require('node:fs')
const count = fs.existsSync('${countFile}') ? Number(fs.readFileSync('${countFile}', 'utf8')) : 0
fs.writeFileSync('${countFile}', String(count + 1))
console.log(JSON.stringify({ role: 'assistant', content: JSON.stringify({
  status: 'completed',
  summary: 'ok',
  criterion_results: [{ criterion_id: 'C1', actual: 'ok', passed: true, evidence_artifact_ids: ['a1'] }],
  artifacts: [{ artifact_id: 'a1', role: 'report', uri: 'report.txt', media_type: 'text/plain', size_bytes: 2, sha256: '${sha256('ok')}' }],
  findings: [],
  error: null
}) }))`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const e = envelope('tsk-cleanup-idem')
  const ctx = {
    token: 'test',
    runner_id: 'runner-1',
    trace_id: 'trace-1',
    correlation_id: 'corr-1',
    worktree: root,
    deadline_at: new Date(Date.now() + 30_000).toISOString(),
  }
  const binding = await startAndWait(a, e, root)
  await a.collectResult(binding)
  await (
    a as unknown as {
      cleanup(
        binding: Awaited<ReturnType<KimiAdapter['startTask']>>,
      ): Promise<void>
    }
  ).cleanup(binding)

  const again = await a.startTask(e, ctx)
  for (;;) {
    if ((await a.getStatus(again)).terminal_observed) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.deepEqual(again, binding)
  assert.equal(await readFile(countFile, 'utf8'), '1')
})

test('collectResult auto-cleans external runtime after success and keeps cached result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-auto-clean-'))
  await makeCredentialHome(root)
  const worktree = join(root, 'worktree')
  await mkdir(worktree)
  const sandboxBin = await makeSandbox(root)
  await writeFile(join(worktree, 'report.txt'), 'ok')
  const runtimeFile = join(root, 'runtime.txt')
  const kimi = await makeKimi(
    root,
    `require('node:fs').writeFileSync('${runtimeFile}', process.env.TMPDIR)
console.log(JSON.stringify({ role: 'assistant', content: JSON.stringify({
  status: 'completed',
  summary: 'ok',
  criterion_results: [{ criterion_id: 'C1', actual: 'ok', passed: true, evidence_artifact_ids: ['a1'] }],
  artifacts: [{ artifact_id: 'a1', role: 'report', uri: 'report.txt', media_type: 'text/plain', size_bytes: 2, sha256: '${sha256('ok')}' }],
  findings: [],
  error: null
}) }))`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const binding = await startAndWait(a, envelope('tsk-auto-clean'), worktree)
  const runtimeDir = await readFile(runtimeFile, 'utf8')

  const first = await a.collectResult(binding)
  const second = await a.collectResult(binding)

  assert.equal(first.status, 'completed')
  assert.equal(second.status, 'completed')
  assert.equal(await fileExists(runtimeDir), false)
  assert.equal(await fileExists(join(worktree, 'report.txt')), true)
})

test('collectResult auto-cleans external runtime after failed result collection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-auto-clean-failed-'))
  await makeCredentialHome(root)
  const worktree = join(root, 'worktree')
  await mkdir(worktree)
  const sandboxBin = await makeSandbox(root)
  const runtimeFile = join(root, 'runtime.txt')
  const kimi = await makeKimi(
    root,
    `require('node:fs').writeFileSync('${runtimeFile}', process.env.TMPDIR)
console.log(JSON.stringify({ role: 'assistant', content: 'not json' }))`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const binding = await startAndWait(
    a,
    envelope('tsk-auto-clean-failed'),
    worktree,
  )
  const runtimeDir = await readFile(runtimeFile, 'utf8')

  await assert.rejects(
    a.collectResult(binding),
    (err) => err instanceof AdapterError && err.code === 'RESULT_UNPARSABLE',
  )
  assert.equal(await fileExists(runtimeDir), false)
  assert.equal(await fileExists(worktree), true)
})

test('unknown risk level is rejected before spawning Kimi', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-risk-'))
  await makeCredentialHome(root)
  const sandboxBin = await makeSandbox(root)
  const marker = join(root, 'spawned.txt')
  const kimi = await makeKimi(
    root,
    `require('node:fs').writeFileSync('${marker}', 'spawned')`,
  )
  const a = adapter(kimi, sandboxBin, root)
  const bad = {
    ...envelope('tsk-bad-risk'),
    classification: {
      task_type: 'inspect',
      requested_capability: 'code.analyze',
      risk_level: 'unknown-risk',
    },
  } as unknown as TaskEnvelopeV1

  await assert.rejects(
    a.startTask(bad, {
      token: 'test',
      runner_id: 'runner-1',
      trace_id: 'trace-1',
      correlation_id: 'corr-1',
      worktree: root,
      deadline_at: new Date(Date.now() + 30_000).toISOString(),
    }),
    (err) =>
      err instanceof AdapterError && err.code === 'RISK_CEILING_EXCEEDED',
  )
  assert.equal(await fileExists(marker), false)
})

test('model policy is rejected explicitly', async () => {
  const a = new KimiAdapter({
    bin: '/bin/false',
    sandboxBin: '/bin/false',
    credentialHome: tmpdir(),
  })
  const e = {
    ...envelope('tsk-policy'),
    execution_policy: {
      timeout_seconds: 30,
      max_attempts: 1,
      model_policy: {
        model: 'kimi-k2',
        effort: 'high',
        source: 'task_override',
      },
    },
  } as TaskEnvelopeV1

  await assert.rejects(
    a.startTask(e, {
      token: 'test',
      runner_id: 'runner-1',
      trace_id: 'trace-1',
      correlation_id: 'corr-1',
      worktree: tmpdir(),
      deadline_at: new Date(Date.now() + 30_000).toISOString(),
    }),
    (err) =>
      err instanceof AdapterError && err.code === 'MODEL_POLICY_UNSUPPORTED',
  )
})
