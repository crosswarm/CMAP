import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

import type { AgentAdapter } from '#adapter-sdk'
import type { TaskEnvelopeV1 } from '#domain-model'
import { CodexAdapter } from '../../adapters/codex-adapter/src/index.ts'
import { KimiAdapter } from '../../adapters/kimi-adapter/src/index.ts'

const envelope = (taskId: string): TaskEnvelopeV1 => ({
  schema: 'cmap/task-envelope/v1',
  identity: {
    mission_id: 'mis-cancel',
    task_id: taskId,
    idempotency_key: `mis-cancel:${taskId}`,
    revision: 1,
  },
  classification: {
    task_type: 'inspect',
    requested_capability: 'code.analyze',
    risk_level: 'read-meta',
  },
  goal: {
    statement: 'wait',
    success_definition: [
      { criterion_id: 'C1', metric: 'done', operator: 'eq', expected: true },
    ],
  },
  environment: {},
  execution_policy: { timeout_seconds: 30, max_attempts: 1 },
  permissions: { forbidden: [] },
  evidence_requirements: { required_artifact_roles: ['report'] },
  output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
})

const writeExecutable = async (path: string, source: string): Promise<void> => {
  await writeFile(path, source)
  await chmod(path, 0o755)
}

const makeCredentialHome = async (dir: string): Promise<void> => {
  await mkdir(join(dir, 'credentials'))
  await mkdir(join(dir, 'oauth'))
  await writeFile(join(dir, 'credentials/kimi-code.json'), '{}')
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const pidExecuting = (pid: number): boolean => {
  if (!pidAlive(pid)) return false
  try {
    // Killed macOS orphans can retain a zombie PID briefly; they cannot execute.
    const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim()
    return state.length > 0 && !state.startsWith('Z')
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false
    throw error
  }
}

const readPids = async (
  path: string,
  adapter: AgentAdapter,
  binding: Awaited<ReturnType<AgentAdapter['startTask']>>,
): Promise<{ parent: number; child: number }> => {
  // Parallel suites can delay both wrapper and CLI startup; cancellation still gets 5s below.
  const deadline = Date.now() + 10_000
  try {
    for (;;) {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as { parent: number; child: number }
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const status = await adapter.getStatus(binding)
        if (status.terminal_observed || Date.now() > deadline) {
          const diagnostic = { status: status.status, terminal_observed: status.terminal_observed }
          throw new Error(`fixture PID readiness failed: ${JSON.stringify(diagnostic)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
  } catch (error) {
    await adapter.cancel(binding, 'fixture readiness failed')
    const cleanupDeadline = Date.now() + 5000
    while (!(await adapter.getStatus(binding)).terminal_observed && Date.now() < cleanupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw error
  }
}

const waitTerminalAfterChildrenGone = async (
  adapter: AgentAdapter,
  binding: Awaited<ReturnType<AgentAdapter['startTask']>>,
  pids: { parent: number; child: number },
): Promise<void> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const status = await adapter.getStatus(binding)
    const alive = status.terminal_observed && (pidExecuting(pids.parent) || pidExecuting(pids.child))
    assert.equal(
      status.terminal_observed && alive,
      false,
      `reported terminal while process tree was alive: ${JSON.stringify(status)}`,
    )
    if (status.terminal_observed) {
      assert.equal(status.status === 'canceled' || status.status === 'failed', true)
      return
    }
    if (Date.now() > deadline) throw new Error('cancel did not reach terminal status')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const makeTermResistantCli = async (dir: string, pidFile: string): Promise<string> => {
  const bin = join(dir, 'term-resistant-cli')
  await writeExecutable(
    bin,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const fs = require('node:fs')
process.on('SIGTERM', () => {})
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], {
  detached: false,
  stdio: 'ignore',
})
child.unref()
fs.writeFileSync('${pidFile}', JSON.stringify({ parent: process.pid, child: child.pid }))
setInterval(() => {}, 1000)
`,
  )
  return bin
}

const makeSandboxWrapper = async (dir: string): Promise<string> => {
  const bin = join(dir, 'fake-sandbox-exec')
  await writeExecutable(
    bin,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const args = process.argv.slice(2)
if (args[0] !== '-p' || !args[1] || !args[2]) process.exit(91)
const child = spawn(args[2], args.slice(3), {
  detached: false,
  stdio: 'ignore',
  env: { ...process.env, FAKE_SANDBOX_PROFILE: args[1] },
})
child.unref()
setInterval(() => {}, 1000)
`,
  )
  return bin
}

test('Codex cancel waits for its owned process group before reporting terminal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-pg-cancel-'))
  const pidFile = join(root, 'pids.json')
  const bin = await makeTermResistantCli(root, pidFile)
  const adapter = new CodexAdapter({
    bin,
    outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'),
  })
  const binding = await adapter.startTask(envelope('tsk-codex-cancel'), {
    token: 'test',
    runner_id: 'runner-1',
    trace_id: 'trace-1',
    correlation_id: 'corr-1',
    worktree: root,
    deadline_at: new Date(Date.now() + 30_000).toISOString(),
  })
  const pids = await readPids(pidFile, adapter, binding)

  await adapter.cancel(binding, 'test cancel')
  await waitTerminalAfterChildrenGone(adapter, binding, pids)
})

test('Kimi cancel waits for sandbox descendants with ignored stdio before reporting terminal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-pg-cancel-'))
  await makeCredentialHome(root)
  const pidFile = join(root, 'pids.json')
  const sandboxBin = await makeSandboxWrapper(root)
  const bin = await makeTermResistantCli(root, pidFile)
  const adapter = new KimiAdapter({ bin, sandboxBin, credentialHome: root })
  const binding = await adapter.startTask(envelope('tsk-kimi-cancel'), {
    token: 'test',
    runner_id: 'runner-1',
    trace_id: 'trace-1',
    correlation_id: 'corr-1',
    worktree: root,
    deadline_at: new Date(Date.now() + 30_000).toISOString(),
  })
  const pids = await readPids(pidFile, adapter, binding)

  await adapter.cancel(binding, 'test cancel')
  await waitTerminalAfterChildrenGone(adapter, binding, pids)
})

test('cancel cleanup does not leave delayed kills after the group is gone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-kimi-pg-normal-'))
  await makeCredentialHome(root)
  const sandboxBin = await makeSandboxWrapper(root)
  const bin = join(root, 'short-kimi')
  await writeExecutable(bin, '#!/usr/bin/env node\nprocess.exit(0)\n')
  const adapter = new KimiAdapter({ bin, sandboxBin, credentialHome: root })
  const binding = await adapter.startTask(envelope('tsk-kimi-normal'), {
    token: 'test',
    runner_id: 'runner-1',
    trace_id: 'trace-1',
    correlation_id: 'corr-1',
    worktree: root,
    deadline_at: new Date(Date.now() + 30_000).toISOString(),
  })

  await adapter.cancel(binding, 'cleanup')
  for (;;) {
    const status = await adapter.getStatus(binding)
    if (status.terminal_observed) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  await new Promise((resolve) => setTimeout(resolve, 700))
  await stat(root)
})

for (const kind of ['Codex', 'Kimi'] as const) {
  test(`${kind} natural wrapper exit cannot report terminal with a live descendant`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmap-natural-exit-'))
    await makeCredentialHome(root)
    const pidFile = join(root, 'pids.json')
    const bin = join(root, 'natural-exit.cjs')
    await writeExecutable(bin, `#!${process.execPath}
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000); require("node:fs").writeFileSync(${JSON.stringify(pidFile + '.ready')}, "ready")'], { stdio: 'ignore' })
child.unref()
fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }))
const ready = setInterval(() => { if (fs.existsSync(${JSON.stringify(pidFile + '.ready')})) { clearInterval(ready); process.exit(0) } }, 10)
`)
    const adapter: AgentAdapter = kind === 'Codex'
      ? new CodexAdapter({ bin, outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json') })
      : new KimiAdapter({ bin, sandboxBin: bin, credentialHome: root })
    const binding = await adapter.startTask(envelope(`tsk-natural-${kind}`), {
      token: 'test', runner_id: 'runner-1', trace_id: 'trace-1', correlation_id: 'corr-1',
      worktree: root, deadline_at: new Date(Date.now() + 30_000).toISOString(),
    })
    const pids = await readPids(pidFile, adapter, binding)
    try {
      const deadline = Date.now() + 5000
      while (pidAlive(pids.parent)) {
        assert.ok(Date.now() < deadline, 'wrapper failed to exit')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(pidAlive(pids.child), true, 'TERM-resistant descendant must outlive wrapper')
      assert.equal((await adapter.getStatus(binding)).terminal_observed, false)
      await assert.rejects(adapter.collectResult(binding), { code: 'TASK_STILL_RUNNING' })
      for (;;) {
        const status = await adapter.getStatus(binding)
        assert.equal(status.terminal_observed && pidExecuting(pids.child), false)
        if (status.terminal_observed) break
        assert.ok(Date.now() < deadline, 'natural exit failed to clean descendants')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    } finally {
      for (const pid of [pids.parent, pids.child]) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already reaped */ }
      }
    }
  })
}
