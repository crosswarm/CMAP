import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryStore } from '#domain-model'
import type { Mission, RemoteTaskBinding, TaskEnvelopeV1, TaskRecord } from '#domain-model'
import type { DispatchContext } from '#adapter-sdk'
import { CodexAdapter } from '../../adapters/codex-adapter/src/index.ts'
import { KimiAdapter } from '../../adapters/kimi-adapter/src/index.ts'
import { createActivities } from '../../workflows/activities.ts'
import { syntheticRunner, syntheticActivityDeps, syntheticAdapterAuthorization } from './fake-adapter.ts'

const ACTOR = { type: 'system', id: 'cli-prepared-test' } as const
const NODE = '/Users/cfone/.nvm/versions/node/v24.13.0/bin/node'

const mission = (id = 'mis-cli'): Mission => ({
  id,
  tenant: 'team-ycc',
  owner: 'crosswarm',
  type: 'inspect',
  goal: 'CLI prepared dispatch fixture',
  constraints: {},
  acceptance: [{ criterion_id: 'C1', metric: 'done', operator: 'eq', expected: true, hard_gate: true }],
  workflow_template: 'inspect/v1',
  state: 'RUNNING',
  revision: 1,
  created_at: '2026-09-22T00:00:00.000Z',
  updated_at: '2026-09-22T00:00:00.000Z',
})

const envelope = (
  taskId: string,
  overrides: Partial<TaskEnvelopeV1> = {},
): TaskEnvelopeV1 => ({
  schema: 'cmap/task-envelope/v1',
  identity: {
    mission_id: 'mis-cli',
    task_id: taskId,
    idempotency_key: `mis-cli:${taskId}`,
    revision: 1,
    tenant: 'team-ycc',
    owner: 'crosswarm',
  },
  classification: { task_type: 'inspect', requested_capability: 'code.analyze', risk_level: 'read-meta' },
  goal: {
    statement: 'produce fixture output',
    success_definition: [{ criterion_id: 'C1', metric: 'done', operator: 'eq', expected: true }],
  },
  environment: {},
  execution_policy: { timeout_seconds: 30, max_attempts: 1 },
  permissions: { forbidden: [] },
  evidence_requirements: { required_artifact_roles: ['report'] },
  output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
  ...overrides,
})

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

const writeExecutable = async (path: string, source: string): Promise<void> => {
  await writeFile(path, source)
  await chmod(path, 0o755)
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const launchCount = async (path: string): Promise<number> => {
  if (!(await fileExists(path))) return 0
  const text = await readFile(path, 'utf8')
  return text.trim() ? text.trim().split('\n').length : 0
}

const waitForLaunches = async (path: string, expected: number): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (await launchCount(path) !== expected) {
    assert.ok(Date.now() < deadline, `expected ${expected} launches, saw ${await launchCount(path)}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const eventCount = async (store: MemoryStore, eventType: string): Promise<number> =>
  (await store.listEvents('mis-cli')).filter((event) => event.event_type === eventType).length

const cleanupStoredBinding = async (
  adapter: { cleanup?: (binding: RemoteTaskBinding) => Promise<void>; cancel?: (binding: RemoteTaskBinding, reason: string) => Promise<void> } | undefined,
  store: MemoryStore | undefined,
  taskId: string,
): Promise<void> => {
  const binding = (await store?.getTask(taskId))?.binding
  if (!adapter?.cleanup || !binding) return
  try {
    await adapter.cleanup(binding)
  } catch {
    try {
      await adapter.cancel?.(binding, 'test cleanup')
    } catch {
      return
    }
    for (let i = 0; i < 50; i += 1) {
      try {
        await adapter.cleanup(binding)
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
  }
}

const makeStoreTask = async (
  taskId: string,
  e: TaskEnvelopeV1 = envelope(taskId),
  seed: Partial<TaskRecord> = {},
): Promise<MemoryStore> => {
  const store = new MemoryStore()
  await store.createMission({ mission: mission(e.identity.mission_id), actor: ACTOR })
  await store.createTask({
    actor: ACTOR,
    task: {
      id: taskId,
      mission_id: e.identity.mission_id,
      parent_task_id: null,
      supersedes_task_id: null,
      capability: e.classification.requested_capability,
      risk: e.classification.risk_level,
      state: 'DRAFT',
      attempt: e.identity.revision,
      max_attempts: e.execution_policy.max_attempts,
      lamport: 0,
      envelope: e,
      result: null,
      binding: null,
      deps: [],
      created_at: '2026-09-22T00:00:00.000Z',
      updated_at: '2026-09-22T00:00:00.000Z',
      ...seed,
    },
  })
  if (!seed.state) {
    await store.transitionTask({
      taskId,
      to: 'READY',
      actor: ACTOR,
      eventType: 'TASK_READY',
      idempotencyKey: `${taskId}:ready`,
    })
  }
  return store
}

const makeCodex = async (dir: string, launches = join(dir, 'codex-launches')): Promise<string> => {
  const bin = join(dir, 'fake-codex.cjs')
  await writeExecutable(
    bin,
    `#!${NODE}
const fs = require('node:fs')
const path = require('node:path')
if (process.argv.includes('--version')) {
  console.log('fake-codex 0.0.0')
  process.exit(0)
}
if (!process.env.CMAP_TASK_ID) process.exit(0)
const args = process.argv.slice(2)
const workDir = args[args.indexOf('-C') + 1] || process.cwd()
if (workDir === ${JSON.stringify(process.cwd())}) process.exit(0)
fs.appendFileSync(${JSON.stringify(launches)}, String(process.pid) + '\\n')
const out = args[args.indexOf('-o') + 1]
if (!out) process.exit(0)
fs.mkdirSync(path.join(workDir, 'evidence'), { recursive: true })
fs.writeFileSync(path.join(workDir, 'evidence/report.txt'), 'ok')
fs.writeFileSync(out, JSON.stringify({
  status: 'completed',
  summary: 'ok',
  criterion_results: [{ criterion_id: 'C1', actual: 'true', passed: true, evidence_artifact_ids: ['a1'] }],
  artifacts: [{ artifact_id: 'a1', role: 'report', uri: 'evidence/report.txt', media_type: 'text/plain', size_bytes: 2, sha256: ${JSON.stringify(sha256('ok'))} }],
  findings: [],
  error: null
}))
`,
  )
  return bin
}

const makeSandbox = async (dir: string): Promise<string> => {
  const bin = join(dir, 'fake-sandbox.cjs')
  await writeExecutable(
    bin,
    `#!${NODE}
const { spawn } = require('node:child_process')
const args = process.argv.slice(2)
const child = spawn(args[2], args.slice(3), { stdio: 'inherit', env: process.env })
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)))
child.on('error', () => process.exit(92))
`,
  )
  return bin
}

const makeKimi = async (dir: string, launches = join(dir, 'kimi-launches')): Promise<string> => {
  const bin = join(dir, 'fake-kimi.cjs')
  await writeExecutable(
    bin,
    `#!${NODE}
const fs = require('node:fs')
const path = require('node:path')
if (process.argv.includes('--version')) {
  console.log('fake-kimi 0.0.0')
  process.exit(0)
}
if (!process.env.CMAP_TASK_ID) process.exit(0)
if (process.cwd() === ${JSON.stringify(process.cwd())}) process.exit(0)
fs.appendFileSync(${JSON.stringify(launches)}, String(process.pid) + '\\n')
fs.mkdirSync(path.join(process.cwd(), 'evidence'), { recursive: true })
fs.writeFileSync(path.join(process.cwd(), 'evidence/report.txt'), 'ok')
console.log(JSON.stringify({ role: 'assistant', content: JSON.stringify({
  status: 'input_required',
  summary: 'need more input',
  criterion_results: [{ criterion_id: 'C1', actual: 'missing input', passed: false, evidence_artifact_ids: ['a1'] }],
  artifacts: [{ artifact_id: 'a1', role: 'report', uri: 'evidence/report.txt', media_type: 'text/plain', size_bytes: 2, sha256: ${JSON.stringify(sha256('ok'))} }],
  findings: [],
  error: { code: 'NEED_INPUT', message: 'need more input', retryable: true }
}) }))
`,
  )
  return bin
}

const makeKimiHome = async (dir: string): Promise<void> => {
  await mkdir(join(dir, 'credentials'))
  await mkdir(join(dir, 'oauth'))
  await writeFile(join(dir, 'credentials/kimi-code.json'), '{}')
}

class ObservedCodexAdapter extends CodexAdapter {
  observations: Array<{ state: string | undefined; bound: boolean; intents: number; launches: number }> = []
  readonly store: MemoryStore
  readonly launches: string

  constructor(
    opts: ConstructorParameters<typeof CodexAdapter>[0],
    store: MemoryStore,
    launches: string,
  ) {
    super(opts)
    this.store = store
    this.launches = launches
  }

  override async startTask(envelope: TaskEnvelopeV1, ctx: DispatchContext): Promise<RemoteTaskBinding> {
    assert.ok(ctx.beforeSend, 'prepared CLI dispatch must pass beforeSend to the adapter')
    return super.startTask(envelope, {
      ...ctx,
      beforeSend: async (binding, policy) => {
        const task = await this.store.getTask(envelope.identity.task_id)
        this.observations.push({
          state: task?.state,
          bound: !!task?.binding,
          intents: await eventCount(this.store, 'TASK_DISPATCH_INTENT'),
          launches: await launchCount(this.launches),
        })
        await ctx.beforeSend!(binding, policy)
      },
    })
  }
}

class LostReturnCodexAdapter extends ObservedCodexAdapter {
  override async startTask(envelope: TaskEnvelopeV1, ctx: DispatchContext): Promise<RemoteTaskBinding> {
    await super.startTask(envelope, ctx)
    throw new Error('lost codex start return')
  }
}

class PreparedKimiAdapter extends KimiAdapter {
  observations: Array<{ state: string | undefined; bound: boolean; intents: number; launches: number }> = []
  readonly store: MemoryStore
  readonly launches: string

  constructor(
    opts: ConstructorParameters<typeof KimiAdapter>[0],
    store: MemoryStore,
    launches: string,
  ) {
    super(opts)
    this.store = store
    this.launches = launches
  }

  override async startTask(envelope: TaskEnvelopeV1, ctx: DispatchContext): Promise<RemoteTaskBinding> {
    assert.ok(ctx.beforeSend, 'prepared CLI dispatch must pass beforeSend to the adapter')
    return super.startTask(envelope, {
      ...ctx,
      beforeSend: async (binding, policy) => {
        const task = await this.store.getTask(envelope.identity.task_id)
        this.observations.push({
          state: task?.state,
          bound: !!task?.binding,
          intents: await eventCount(this.store, 'TASK_DISPATCH_INTENT'),
          launches: await launchCount(this.launches),
        })
        await ctx.beforeSend!(binding, policy)
      },
    })
  }
}

test('Codex prepared dispatch records intent before process launch and one started event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-cli-codex-dispatch-'))
  let store: MemoryStore | undefined
  let adapter: ObservedCodexAdapter | undefined
  try {
    const launches = join(root, 'launches')
    store = await makeStoreTask('tsk-codex')
    adapter = new ObservedCodexAdapter({
      bin: await makeCodex(root, launches),
      outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'),
      authorization: syntheticAdapterAuthorization({ runnerId: 'runner-test' }),
    }, store, launches)
    const acts = createActivities(syntheticActivityDeps({ store, adapter, runner: syntheticRunner({ runner_id: 'runner-test' }), workRoot: root }))

    assert.deepEqual(await acts.dispatchTask('tsk-codex'), { dispatched: true, remoteTaskId: 'codex:tsk-codex:1' })

    assert.deepEqual(adapter.observations, [{ state: 'RUNNING', bound: true, intents: 1, launches: 0 }])
    await waitForLaunches(launches, 1)
    assert.equal(await eventCount(store, 'TASK_DISPATCH_INTENT'), 1)
    assert.equal(await eventCount(store, 'TASK_STARTED'), 1)
  } finally {
    await cleanupStoredBinding(adapter, store, 'tsk-codex')
    await rm(root, { recursive: true, force: true })
  }
})

test('lost Codex start return is not retried by a fresh adapter and does not invent a start receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-cli-codex-lost-'))
  let store: MemoryStore | undefined
  let first: LostReturnCodexAdapter | undefined
  try {
    const launches = join(root, 'launches')
    store = await makeStoreTask('tsk-lost')
    const bin = await makeCodex(root, launches)
    first = new LostReturnCodexAdapter({
      bin,
      outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'),
      authorization: syntheticAdapterAuthorization({ runnerId: 'runner-test' }),
    }, store, launches)
    const acts = createActivities(syntheticActivityDeps({ store, adapter: first, runner: syntheticRunner({ runner_id: 'runner-test' }), workRoot: root }))

    await assert.rejects(acts.dispatchTask('tsk-lost'), /lost codex start return/)

    const fresh = new ObservedCodexAdapter({
      bin,
      outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'),
      authorization: syntheticAdapterAuthorization({ runnerId: 'runner-test' }),
    }, store, launches)
    const retry = createActivities(syntheticActivityDeps({ store, adapter: fresh, runner: syntheticRunner({ runner_id: 'runner-test' }), workRoot: root }))

    assert.deepEqual(await retry.dispatchTask('tsk-lost'), { dispatched: false, remoteTaskId: 'codex:tsk-lost:1' })
    await waitForLaunches(launches, 1)
    assert.equal(fresh.observations.length, 0)
    assert.equal(await eventCount(store, 'TASK_STARTED'), 0)
  } finally {
    await cleanupStoredBinding(first, store, 'tsk-lost')
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent Codex prepared dispatch claims once and spawns once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-cli-codex-concurrent-'))
  let store: MemoryStore | undefined
  let adapter: ObservedCodexAdapter | undefined
  try {
    const launches = join(root, 'launches')
    store = await makeStoreTask('tsk-concurrent')
    adapter = new ObservedCodexAdapter({
      bin: await makeCodex(root, launches),
      outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'),
      authorization: syntheticAdapterAuthorization({ runnerId: 'runner-test' }),
    }, store, launches)
    const acts = createActivities(syntheticActivityDeps({ store, adapter, runner: syntheticRunner({ runner_id: 'runner-test' }), workRoot: root }))

    const results = await Promise.allSettled([acts.dispatchTask('tsk-concurrent'), acts.dispatchTask('tsk-concurrent')])

    assert.equal(results.filter((result) => result.status === 'fulfilled' && result.value.dispatched).length, 1)
    await waitForLaunches(launches, 1)
    assert.equal(await eventCount(store, 'TASK_DISPATCH_INTENT'), 1)
    assert.equal(await eventCount(store, 'TASK_STARTED'), 1)
  } finally {
    await cleanupStoredBinding(adapter, store, 'tsk-concurrent')
    await rm(root, { recursive: true, force: true })
  }
})

test('fresh Codex runtime reports uncertain collection instead of retrying a prepared binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-cli-codex-uncertain-'))
  let store: MemoryStore | undefined
  let adapter: ObservedCodexAdapter | undefined
  try {
    const launches = join(root, 'launches')
    store = await makeStoreTask('tsk-uncertain')
    const bin = await makeCodex(root, launches)
    adapter = new ObservedCodexAdapter({
      bin,
      outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'),
      authorization: syntheticAdapterAuthorization({ runnerId: 'runner-test' }),
    }, store, launches)
    const acts = createActivities(syntheticActivityDeps({ store, adapter, runner: syntheticRunner({ runner_id: 'runner-test' }), workRoot: root }))
    await acts.dispatchTask('tsk-uncertain')

    const fresh = new CodexAdapter({ bin, outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'), authorization: syntheticAdapterAuthorization({ runnerId: 'runner-test' }) })
    const retry = createActivities(syntheticActivityDeps({ store, adapter: fresh, runner: syntheticRunner({ runner_id: 'runner-test' }), workRoot: root, pollIntervalMs: 1 }))

    assert.deepEqual(await retry.collectTaskResult('tsk-uncertain'), {
      executionUncertain: { code: 'BINDING_NOT_FOUND', terminalObserved: false },
    })
    assert.equal((await store.getTask('tsk-uncertain'))?.result, null)
  } finally {
    await cleanupStoredBinding(adapter, store, 'tsk-uncertain')
    await rm(root, { recursive: true, force: true })
  }
})

test('Worker 重启（全新 Codex 适配器 + 运行记录）：收集已有结果，Codex 只执行 1 次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-cli-codex-restart-'))
  let store: MemoryStore | undefined
  let adapter: ObservedCodexAdapter | undefined
  try {
    const launches = join(root, 'launches')
    store = await makeStoreTask('tsk-restart')
    const bin = await makeCodex(root, launches)
    const runsDir = join(root, '.runs')
    adapter = new ObservedCodexAdapter({
      bin, runsDir,
      outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'),
      authorization: syntheticAdapterAuthorization({ runnerId: 'runner-test' }),
    }, store, launches)
    const acts = createActivities(syntheticActivityDeps({ store, adapter, runner: syntheticRunner({ runner_id: 'runner-test' }), workRoot: root }))
    await acts.dispatchTask('tsk-restart')
    await waitForLaunches(launches, 1)

    const fresh = new CodexAdapter({ bin, runsDir, outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'), authorization: syntheticAdapterAuthorization({ runnerId: 'runner-test' }) })
    const retry = createActivities(syntheticActivityDeps({ store, adapter: fresh, runner: syntheticRunner({ runner_id: 'runner-test' }), workRoot: root, pollIntervalMs: 5 }))

    assert.deepEqual(await retry.dispatchTask('tsk-restart'), { dispatched: false, remoteTaskId: 'codex:tsk-restart:1' })
    assert.deepEqual(await retry.collectTaskResult('tsk-restart'), { status: 'completed', passed: true, failedCriteria: [], summary: 'ok' })
    assert.equal((await store.getTask('tsk-restart'))?.result?.task_id, 'tsk-restart')
    assert.equal(await launchCount(launches), 1)
    assert.equal(await eventCount(store, 'INPUT_REQUIRED'), 0)
  } finally {
    await cleanupStoredBinding(adapter, store, 'tsk-restart')
    await rm(root, { recursive: true, force: true })
  }
})

test('Worker 重启后进程已退出但结果文件缺失：走执行不确定升级路径，不重跑', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-cli-codex-restart-lost-'))
  let store: MemoryStore | undefined
  let adapter: ObservedCodexAdapter | undefined
  try {
    const launches = join(root, 'launches')
    store = await makeStoreTask('tsk-restart-lost')
    const bin = await makeCodex(root, launches)
    const runsDir = join(root, '.runs')
    adapter = new ObservedCodexAdapter({
      bin, runsDir,
      outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'),
      authorization: syntheticAdapterAuthorization({ runnerId: 'runner-test' }),
    }, store, launches)
    const acts = createActivities(syntheticActivityDeps({ store, adapter, runner: syntheticRunner({ runner_id: 'runner-test' }), workRoot: root }))
    await acts.dispatchTask('tsk-restart-lost')
    await waitForLaunches(launches, 1)
    const record = JSON.parse(await readFile(join(runsDir, 'tsk-restart-lost.json'), 'utf8'))
    for (let i = 0; i < 200 && !(await fileExists(record.result_file)); i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    await rm(record.result_file) // 进程已写完并退出，但结果文件不在了

    const fresh = new CodexAdapter({ bin, runsDir, outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'), authorization: syntheticAdapterAuthorization({ runnerId: 'runner-test' }) })
    const retry = createActivities(syntheticActivityDeps({ store, adapter: fresh, runner: syntheticRunner({ runner_id: 'runner-test' }), workRoot: root, pollIntervalMs: 5 }))

    assert.deepEqual(await retry.collectTaskResult('tsk-restart-lost'), {
      executionUncertain: { code: 'BINDING_NOT_FOUND', terminalObserved: false },
    })
    assert.equal((await store.getTask('tsk-restart-lost'))?.result, null)
    assert.equal(await launchCount(launches), 1)
    assert.equal(await eventCount(store, 'INPUT_REQUIRED'), 1)
  } finally {
    await cleanupStoredBinding(adapter, store, 'tsk-restart-lost')
    await rm(root, { recursive: true, force: true })
  }
})

test('fresh Kimi runtime BINDING_NOT_FOUND records one input-required wait without a result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-cli-kimi-uncertain-'))
  let store: MemoryStore | undefined
  let adapter: PreparedKimiAdapter | undefined
  try {
    await makeKimiHome(root)
    const launches = join(root, 'launches')
    store = await makeStoreTask('tsk-kimi-uncertain')
    const bin = await makeKimi(root, launches)
    const sandboxBin = await makeSandbox(root)
    adapter = new PreparedKimiAdapter({
      bin,
      sandboxBin,
      credentialHome: root,
      authorization: syntheticAdapterAuthorization({ runnerId: 'runner-test' }),
    }, store, launches)
    const acts = createActivities(syntheticActivityDeps({ store, adapter, runner: syntheticRunner({ runner_id: 'runner-test' }), workRoot: root, pollIntervalMs: 1 }))

    await acts.dispatchTask('tsk-kimi-uncertain')
    await waitForLaunches(launches, 1)

    const fresh = new KimiAdapter({ bin, sandboxBin, credentialHome: root, authorization: syntheticAdapterAuthorization({ runnerId: 'runner-test' }) })
    const retry = createActivities(syntheticActivityDeps({ store, adapter: fresh, runner: syntheticRunner({ runner_id: 'runner-test' }), workRoot: root, pollIntervalMs: 1 }))

    const expected = {
      executionUncertain: { code: 'BINDING_NOT_FOUND', terminalObserved: false },
    }
    assert.deepEqual(await retry.collectTaskResult('tsk-kimi-uncertain'), expected)
    assert.deepEqual(await retry.collectTaskResult('tsk-kimi-uncertain'), expected)
    const task = await store.getTask('tsk-kimi-uncertain')
    assert.equal(task?.state, 'INPUT_REQUIRED')
    assert.equal(task?.result, null)
    assert.equal(await eventCount(store, 'INPUT_REQUIRED'), 1)
  } finally {
    await cleanupStoredBinding(adapter, store, 'tsk-kimi-uncertain')
    await rm(root, { recursive: true, force: true })
  }
})

test('historical queued task with binding keeps its state and never relaunches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-cli-queued-bound-'))
  try {
    const launches = join(root, 'launches')
    const store = await makeStoreTask('tsk-historical', envelope('tsk-historical'), {
      state: 'QUEUED',
      binding: {
        adapter: 'codex-adapter',
        remote_task_id: 'codex:tsk-historical:1',
        protocol: 'codex-exec',
        protocol_version: '0.1.0',
        runner_id: 'runner-test',
      },
    })
    const adapter = new ObservedCodexAdapter({
      bin: await makeCodex(root, launches),
      outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'),
      authorization: syntheticAdapterAuthorization({ runnerId: 'runner-test' }),
    }, store, launches)
    const acts = createActivities(syntheticActivityDeps({ store, adapter, runner: syntheticRunner({ runner_id: 'runner-test' }), workRoot: root }))

    assert.deepEqual(await acts.dispatchTask('tsk-historical'), { dispatched: false, remoteTaskId: 'codex:tsk-historical:1' })
    assert.equal((await store.getTask('tsk-historical'))?.state, 'QUEUED')
    assert.equal(await launchCount(launches), 0)
    assert.equal(await eventCount(store, 'TASK_STARTED'), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
