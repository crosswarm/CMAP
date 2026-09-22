import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, mock } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@temporalio/activity'

import { MemoryStore, PgStore } from '#domain-model'
import type {
  EventActor,
  Mission,
  RemoteTaskBinding,
  Store,
  TaskEnvelopeV1,
  TaskRecord,
} from '#domain-model'
import { AdapterError, type DispatchContext, type NormalizedAgentStatus } from '#adapter-sdk'
import { FakeAdapter, syntheticRunner, syntheticActivityDeps } from './fake-adapter.ts'
import { createDagAttemptRunner } from '../../workflows/dag-attempt.ts'

const ACTOR: EventActor = { type: 'system', id: 'dag-attempt-test' }
const T0 = '2026-09-21T00:00:00.000Z'

const mission = (id: string): Mission => ({
  id,
  tenant: 'team-ycc',
  owner: 'crosswarm',
  type: 'inspect',
  goal: 'DAG attempt',
  constraints: {},
  acceptance: [
    { criterion_id: 'DONE', metric: 'done', operator: 'eq', expected: true, hard_gate: true },
  ],
  workflow_template: 'dag/v1',
  state: 'RUNNING',
  revision: 1,
  created_at: T0,
  updated_at: T0,
})

const envelope = (
  missionId: string,
  taskId: string,
  locks: readonly { resource: string; ttl_seconds: number }[] = [],
  timeoutSeconds = 30,
): TaskEnvelopeV1 => ({
  schema: 'cmap/task-envelope/v1',
  identity: {
    mission_id: missionId,
    task_id: taskId,
    idempotency_key: `${missionId}:${taskId}`,
    revision: 1,
    tenant: 'team-ycc',
    owner: 'crosswarm',
  },
  classification: {
    task_type: 'inspect',
    requested_capability: 'code.analyze',
    risk_level: 'read-meta',
  },
  goal: {
    statement: 'DAG attempt',
    success_definition: [
      { criterion_id: 'DONE', metric: 'done', operator: 'eq', expected: true, hard_gate: true },
    ],
  },
  environment: { tenant: 'team-ycc' },
  execution_policy: {
    timeout_seconds: timeoutSeconds,
    max_attempts: 1,
    ...(locks.length ? { required_resource_locks: [...locks] } : {}),
  },
  permissions: { forbidden: [] },
  evidence_requirements: { required_artifact_roles: ['report'] },
  output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
})

const createTask = async (
  store: Store,
  taskId: string,
  locks: readonly { resource: string; ttl_seconds: number }[] = [],
  timeoutSeconds = 30,
): Promise<TaskRecord> => {
  const missionId = `mis-${taskId}`
  await store.createMission({ mission: mission(missionId), actor: ACTOR })
  await store.createTask({
    task: {
      id: taskId,
      mission_id: missionId,
      parent_task_id: null,
      supersedes_task_id: null,
      capability: 'code.analyze',
      risk: 'read-meta',
      state: 'DRAFT',
      attempt: 1,
      max_attempts: 1,
      lamport: 0,
      envelope: envelope(missionId, taskId, locks, timeoutSeconds),
      result: null,
      binding: null,
      deps: [],
      created_at: T0,
      updated_at: T0,
    },
    actor: ACTOR,
  })
  await store.transitionTask({
    taskId,
    to: 'READY',
    actor: ACTOR,
    eventType: 'TASK_READY',
    idempotencyKey: `ready:${taskId}`,
  })
  return (await store.getTask(taskId))!
}

const waitUntil = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('condition did not become true')
}

class ControlledAdapter extends FakeAdapter {
  active = 0
  maxActive = 0
  terminalOnCancel = true
  throwOnStatus = false
  throwStatusAfterCancel = false
  throwOnCancel = false
  throwOnCollect = false
  readonly completed = new Set<string>()
  readonly canceled = new Set<string>()

  override async startTask(envelope: TaskEnvelopeV1, ctx: DispatchContext): Promise<RemoteTaskBinding> {
    const binding = await super.startTask(envelope, ctx)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    return binding
  }

  complete(taskId: string): void {
    this.completed.add(`fake:${taskId}`)
  }

  override async getStatus(binding?: RemoteTaskBinding): Promise<NormalizedAgentStatus> {
    if (!binding) throw new Error('binding required')
    if (this.throwStatusAfterCancel && this.canceled.has(binding.remote_task_id)) {
      throw new Error('status unavailable after cancel')
    }
    if (this.throwOnStatus) throw new Error('status unavailable')
    const at = new Date().toISOString()
    if (this.completed.has(binding.remote_task_id)) {
      return { status: 'completed', at, terminal_observed: true }
    }
    if (this.canceled.has(binding.remote_task_id) && this.terminalOnCancel) {
      return { status: 'canceled', at, terminal_observed: true }
    }
    return { status: 'running', at, terminal_observed: false }
  }

  override async cancel(binding: RemoteTaskBinding): Promise<void> {
    if (this.throwOnCancel) throw new Error('cancel unavailable')
    await super.cancel(binding)
    this.canceled.add(binding.remote_task_id)
  }

  override async collectResult(binding: RemoteTaskBinding) {
    if (this.throwOnCollect) throw new Error('collector leaked provider body')
    const result = await super.collectResult(binding)
    this.active -= 1
    return result
  }
}


class BackdatedRenewStore extends MemoryStore {
  readonly renewCalls: readonly [string, string][] = []

  override async acquireLock(lock: Parameters<MemoryStore['acquireLock']>[0]) {
    const acquired = await super.acquireLock(lock)
    return {
      ...acquired,
      acquired_at: new Date(Date.now() - 6_000).toISOString(),
    }
  }

  override async renewLock(lockId: string, newExpiresAt: string): Promise<boolean> {
    ;(this.renewCalls as [string, string][]).push([lockId, newExpiresAt])
    return super.renewLock(lockId, newExpiresAt)
  }
}


class RenewFalseBackdatedStore extends BackdatedRenewStore {
  override async renewLock(lockId: string, newExpiresAt: string): Promise<boolean> {
    ;(this.renewCalls as [string, string][]).push([lockId, newExpiresAt])
    return false
  }
}


class DelayedStartAdapter extends ControlledAdapter {
  readonly delayMs: number

  constructor(delayMs: number) {
    super()
    this.delayMs = delayMs
  }

  override async startTask(envelope: TaskEnvelopeV1, ctx: DispatchContext): Promise<RemoteTaskBinding> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    return super.startTask(envelope, ctx)
  }
}


class RunningTransitionFailStore extends MemoryStore {
  override async transitionTask(input: Parameters<MemoryStore['transitionTask']>[0]): ReturnType<MemoryStore['transitionTask']> {
    if (input.to === 'RUNNING') throw new Error('running transition failed')
    return super.transitionTask(input)
  }
}

class BindingReadFailureStore extends MemoryStore {
  bindingReads = 0

  override async getTask(taskId: string): Promise<TaskRecord | null> {
    const task = await super.getTask(taskId)
    if (task?.binding) {
      this.bindingReads += 1
      if (this.bindingReads === 2) throw new Error('ledger read failed')
    }
    return task
  }
}

class HungStartAdapter extends ControlledAdapter {
  override async startTask(): Promise<RemoteTaskBinding> {
    return new Promise<RemoteTaskBinding>(() => {})
  }
}

class WaitForRenewStartAdapter extends ControlledAdapter {
  readonly renewStore: BackdatedRenewStore

  constructor(renewStore: BackdatedRenewStore) {
    super()
    this.renewStore = renewStore
  }

  override async startTask(envelope: TaskEnvelopeV1, ctx: DispatchContext): Promise<RemoteTaskBinding> {
    await waitUntil(() => this.renewStore.renewCalls.length > 0)
    return super.startTask(envelope, ctx)
  }
}

class ResultAfterLostLockAdapter extends ControlledAdapter {
  readonly resultStore: Store

  constructor(resultStore: Store) {
    super()
    this.resultStore = resultStore
  }

  override async startTask(envelope: TaskEnvelopeV1, ctx: DispatchContext): Promise<RemoteTaskBinding> {
    const active = await this.resultStore.listActiveLocks(new Date().toISOString())
    for (const lock of active) {
      if (lock.task_id === envelope.identity.task_id) {
        await this.resultStore.releaseLock(lock.lock_id, new Date().toISOString())
      }
    }
    await this.resultStore.setTaskResult(envelope.identity.task_id, {
      schema: 'cmap/task-result/v1',
      mission_id: envelope.identity.mission_id,
      task_id: envelope.identity.task_id,
      attempt: 1,
      status: 'completed',
      summary: 'completed after lease loss',
      criterion_results: [{ criterion_id: 'DONE', actual: true, passed: true }],
      artifacts: [],
    })
    this.complete(envelope.identity.task_id)
    return super.startTask(envelope, ctx)
  }
}

class RenewThrowStore extends MemoryStore {
  override async renewLock(): Promise<boolean> {
    throw new Error('renew failed')
  }
}

class AcquireThrowStore extends MemoryStore {
  override async acquireLock(lock: Parameters<MemoryStore['acquireLock']>[0]) {
    if (lock.resource === 'res:b') throw new Error('metadata store failed')
    return super.acquireLock(lock)
  }
}

class StartErrorAdapter extends FakeAdapter {
  override async startTask(): Promise<RemoteTaskBinding> {
    throw new Error('provider body with secrets')
  }
}

class BindingLostDuringCollectAdapter extends ControlledAdapter {
  statusCalls = 0

  override async getStatus(_binding?: RemoteTaskBinding): Promise<NormalizedAgentStatus> {
    this.statusCalls += 1
    if (this.statusCalls === 1) {
      return { status: 'completed', at: new Date().toISOString(), terminal_observed: true }
    }
    throw new AdapterError(
      'BINDING_NOT_FOUND',
      'fresh CLI adapter cannot observe the prior binding',
      true,
      'binding-not-found',
    )
  }
}

class FreshCliBindingMissingAdapter extends ControlledAdapter {
  override async getStatus(_binding?: RemoteTaskBinding): Promise<NormalizedAgentStatus> {
    throw new AdapterError(
      'BINDING_NOT_FOUND',
      'fresh CLI adapter cannot observe the prior binding',
      true,
      'binding-not-found',
    )
  }
}

const pgConnectionString = process.env['CMAP_DATABASE_URL'] ??
  'postgres://temporal:temporal@localhost:5433/cmap'

const withPgStore = async (fn: (store: PgStore) => Promise<void>): Promise<void> => {
  process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
  process.env['no_proxy'] = 'localhost,127.0.0.1,::1'
  const schema = `cmap_dag_attempt_${process.pid}_${Date.now()}`
  const store = new PgStore({ connectionString: pgConnectionString, schema })
  await store.migrate()
  try {
    await fn(store)
  } finally {
    await store.close()
  }
}

describe('DAG attempt runner', () => {
  for (const rejectAfterBinding of [false, true]) test(`cancels dispatch settling after the grace window, rejection=${rejectAfterBinding}`, {timeout:8000}, async () => {
    const store = rejectAfterBinding ? new RunningTransitionFailStore() : new MemoryStore()
    const adapter = new ControlledAdapter()
    let resume!: () => void
    const gate = new Promise<void>(resolve => {resume=resolve})
    const start = adapter.startTask.bind(adapter)
    adapter.startTask = async (envelope,ctx) => {await gate; return start(envelope,ctx)}
    const taskId = `tsk-after-grace-${rejectAfterBinding}`
    await createTask(store,taskId,[{resource:taskId,ttl_seconds:15}])
    const result = await createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),store,adapter,workRoot:await mkdtemp(join(tmpdir(),'cmap-dag-attempt-')),pollIntervalMs:5,waitTimeoutMs:20}))({taskId})
    assert.equal(result.reason,'TIMEOUT')
    assert.equal(adapter.cancelCalls.length,1)
    assert.equal((await store.listActiveLocks(new Date().toISOString())).length,0)
    resume()
    await waitUntil(()=>adapter.cancelCalls.length===1)
    await waitUntil(async ()=>(await store.listActiveLocks(new Date().toISOString())).length===0)
  })

  test('poll failure cancels owned execution before releasing a proven terminal lease', async () => {
    const store = new MemoryStore()
    const adapter = new ControlledAdapter()
    const status = adapter.getStatus.bind(adapter)
    adapter.getStatus = async (binding) => {
      if (!adapter.cancelCalls.length) throw new Error('transient status error')
      return status(binding)
    }
    await createTask(store, 'tsk-poll-failure', [{ resource: 'poll:resource', ttl_seconds: 15 }])
    const result = await createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),store, adapter, workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')), pollIntervalMs: 5}))({taskId:'tsk-poll-failure'})
    assert.equal(result.reason, 'STATUS_UNAVAILABLE')
    assert.equal(adapter.cancelCalls.length, 1)
    assert.equal((await store.listActiveLocks(new Date().toISOString())).length, 0)
  })

  for (const hang of ['cancel', 'status'] as const) test(`cancellation grace bounds a hung ${hang} call and retains leases`, {timeout:8000}, async () => {
    const store = new MemoryStore()
    const adapter = new ControlledAdapter()
    if (hang === 'cancel') adapter.cancel = async () => new Promise<void>(() => {})
    else adapter.getStatus = async () => new Promise<NormalizedAgentStatus>(() => {})
    await createTask(store, `tsk-hung-${hang}`, [{resource:`hung:${hang}`, ttl_seconds:15}])
    const started = Date.now()
    const result = await createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),store, adapter, workRoot:await mkdtemp(join(tmpdir(),'cmap-dag-attempt-')), pollIntervalMs:5, waitTimeoutMs:20}))({taskId:`tsk-hung-${hang}`})
    assert.equal(result.reason, 'CANCELLATION_UNCONFIRMED')
    assert.ok(Date.now() - started < 6500)
    assert.equal((await store.listActiveLocks(new Date().toISOString())).length,1)
  })

  test('serializes concurrent attempts for the same declared resource', async () => {
    const store = new MemoryStore()
    const adapter = new ControlledAdapter()
    adapter.throwStatusAfterCancel = true
    await createTask(store, 'tsk-a', [{ resource: 'device:one', ttl_seconds: 15 }])
    await createTask(store, 'tsk-b', [{ resource: 'device:one', ttl_seconds: 15 }])
    const workRoot = await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-'))
    const run = createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(), store, adapter, workRoot, pollIntervalMs: 5 }))

    const first = run({ taskId: 'tsk-a' })
    await waitUntil(() => adapter.active === 1)
    const second = await run({ taskId: 'tsk-b' })
    assert.equal(second.outcome, 'waiting_resource')
    assert.equal(adapter.maxActive, 1)

    adapter.complete('tsk-a')
    assert.equal((await first).outcome, 'collected')

    const retry = run({ taskId: 'tsk-b' })
    await waitUntil(() => adapter.active === 1)
    adapter.complete('tsk-b')
    assert.equal((await retry).outcome, 'collected')
    assert.equal(adapter.maxActive, 1)
  })

  test('honors declared lock TTL and renews from that value', async () => {
    const store = new MemoryStore()
    const adapter = new ControlledAdapter()
    await createTask(store, 'tsk-ttl', [{ resource: 'device:ttl', ttl_seconds: 15 }])
    const run = createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))

    const pending = run({ taskId: 'tsk-ttl' })
    await waitUntil(async () => (await store.listActiveLocks(new Date().toISOString())).length === 1)
    const [lock] = await store.listActiveLocks(new Date().toISOString())
    assert.ok(lock)
    assert.equal(Date.parse(lock.expires_at) - Date.parse(lock.acquired_at), 15_000)

    adapter.complete('tsk-ttl')
    assert.equal((await pending).outcome, 'collected')
  })




  test('cancels a dispatch that completes just after the attempt timeout', async () => {
    const store = new MemoryStore()
    const adapter = new DelayedStartAdapter(30)
    await createTask(store, 'tsk-late-dispatch-timeout', [{ resource: 'res:late-timeout', ttl_seconds: 15 }])

    const out = await createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
      waitTimeoutMs: 20,
    }))({ taskId: 'tsk-late-dispatch-timeout' })

    assert.equal(out.outcome, 'escalated')
    assert.equal(out.reason, 'TIMEOUT')
    assert.equal(adapter.cancelCalls.length, 1)
    assert.equal((await store.listActiveLocks(new Date().toISOString())).length, 0)
  })


  for (const delayMs of [0,30]) test(`cancels dispatch rejecting after recording a binding, delay=${delayMs}`, async () => {
    const store = new RunningTransitionFailStore()
    const adapter = new DelayedStartAdapter(delayMs)
    await createTask(store, 'tsk-late-dispatch-rejects-after-binding', [{ resource: 'res:late-reject', ttl_seconds: 15 }])

    const out = await createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
      waitTimeoutMs: 20,
    }))({ taskId: 'tsk-late-dispatch-rejects-after-binding' })

    assert.equal(out.outcome, 'escalated')
    assert.equal(out.reason, 'TIMEOUT')
    assert.equal(adapter.cancelCalls.length, 1)
    assert.equal((await store.listActiveLocks(new Date().toISOString())).length, 0)
  })

  test('cancels the known binding when ledger reads fail during polling', async () => {
    const store = new BindingReadFailureStore()
    const adapter = new ControlledAdapter()
    await createTask(store, 'tsk-ledger-read-failure', [{ resource: 'res:ledger-read', ttl_seconds: 15 }])

    const out = await createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))({ taskId: 'tsk-ledger-read-failure' })

    assert.equal(out.outcome, 'escalated')
    assert.equal(out.reason, 'DISPATCH_UNCERTAIN')
    assert.equal((await store.listActiveLocks(new Date().toISOString())).length, 0)
  })

  test('bounds a hung dispatch after lease loss and keeps leases for manual recovery', { timeout: 8_000 }, async () => {
    const store = new RenewFalseBackdatedStore()
    const adapter = new HungStartAdapter()
    await createTask(store, 'tsk-hung-dispatch-lock-loss', [{ resource: 'res:hung-dispatch', ttl_seconds: 15 }])

    const started = Date.now()
    const out = await createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))({ taskId: 'tsk-hung-dispatch-lock-loss' })

    assert.equal(out.outcome, 'escalated')
    assert.equal(out.reason, 'LOCK_LOST')
    assert.ok(Date.now() - started < 6_500)
    assert.equal(adapter.cancelCalls.length, 1)
    assert.equal((await store.listActiveLocks(new Date().toISOString())).length, 0)
  })

  test('bounds a hung dispatch even while leases keep renewing', { timeout: 8_000 }, async () => {
    const store = new BackdatedRenewStore()
    const adapter = new HungStartAdapter()
    await createTask(store, 'tsk-hung-dispatch-timeout', [{ resource: 'res:hung-timeout', ttl_seconds: 15 }], 1)

    const started = Date.now()
    const out = await createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))({ taskId: 'tsk-hung-dispatch-timeout' })

    assert.equal(out.outcome, 'escalated')
    assert.equal(out.reason, 'TIMEOUT')
    assert.ok(Date.now() - started < 6_500)
    assert.equal(adapter.cancelCalls.length, 1)
    assert.equal((await store.listActiveLocks(new Date().toISOString())).length, 0)
    assert.ok(store.renewCalls.length >= 1)
  })

  test('renews due leases while dispatch is still starting the adapter', async () => {
    const store = new BackdatedRenewStore()
    const adapter = new WaitForRenewStartAdapter(store)
    await createTask(store, 'tsk-renew-during-dispatch', [{ resource: 'res:dispatch-renew', ttl_seconds: 15 }])

    const pending = createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))({ taskId: 'tsk-renew-during-dispatch' })

    await waitUntil(() => adapter.active === 1)
    adapter.complete('tsk-renew-during-dispatch')
    assert.equal((await pending).outcome, 'collected')
    assert.ok(store.renewCalls.length >= 1)
  })

  test('does not accept a dispatch result after the owned lease is no longer active', async () => {
    const store = new MemoryStore()
    const adapter = new ResultAfterLostLockAdapter(store)
    await createTask(store, 'tsk-result-after-lock-loss', [{ resource: 'res:result-loss', ttl_seconds: 15 }])

    const out = await createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))({ taskId: 'tsk-result-after-lock-loss' })

    assert.equal(out.outcome, 'escalated')
    assert.equal(out.reason, 'DISPATCH_UNCERTAIN')
  })

  test('acquires locks in stable order and releases partial acquisitions on contention', async () => {
    const store = new MemoryStore()
    const adapter = new ControlledAdapter()
    await createTask(store, 'tsk-partial', [
      { resource: 'res:b', ttl_seconds: 15 },
      { resource: 'res:a', ttl_seconds: 15 },
    ])
    await store.acquireLock({
      lock_id: 'held-b',
      resource: 'res:b',
      task_id: 'holder',
      mission_id: 'holder-mis',
      holder_runner_id: 'other',
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      released_at: null,
    })

    const out = await createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))({ taskId: 'tsk-partial' })

    assert.equal(out.outcome, 'waiting_resource')
    const active = await store.listActiveLocks(new Date().toISOString())
    assert.deepEqual(active.map((l) => l.resource), ['res:b'])
    assert.equal(adapter.startCalls.length, 0)
    assert.equal((await store.getTask('tsk-partial'))?.state, 'WAITING_RESOURCE')
  })

  test('lock loss cancels the owned adapter and confirmed terminal releases leases', async () => {
    const store = new MemoryStore()
    const adapter = new ControlledAdapter()
    await createTask(store, 'tsk-loss', [{ resource: 'res:loss', ttl_seconds: 15 }])
    const run = createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))

    const pending = run({ taskId: 'tsk-loss' })
    await waitUntil(async () => (await store.listActiveLocks(new Date().toISOString())).length === 1)
    const [lock] = await store.listActiveLocks(new Date().toISOString())
    await store.releaseLock(lock!.lock_id, new Date().toISOString())

    const out = await pending
    assert.equal(out.outcome, 'escalated')
    assert.equal(out.reason, 'LOCK_LOST')
    assert.equal(adapter.cancelCalls.length, 1)
    assert.equal((await store.listActiveLocks(new Date().toISOString())).length, 0)
  })

  test('unconfirmed cancellation retains remaining leases until TTL expiry', async () => {
    const store = new MemoryStore()
    const adapter = new ControlledAdapter()
    adapter.terminalOnCancel = false
    await createTask(store, 'tsk-unconfirmed', [
      { resource: 'res:first', ttl_seconds: 15 },
      { resource: 'res:second', ttl_seconds: 15 },
    ])
    const run = createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))

    const pending = run({ taskId: 'tsk-unconfirmed' })
    await waitUntil(async () => (await store.listActiveLocks(new Date().toISOString())).length === 2)
    const first = (await store.listActiveLocks(new Date().toISOString()))
      .find((l) => l.resource === 'res:first')!
    await store.releaseLock(first.lock_id, new Date().toISOString())

    const out = await pending
    assert.equal(out.outcome, 'escalated')
    assert.equal(out.reason, 'CANCELLATION_UNCONFIRMED')
    assert.deepEqual(
      (await store.listActiveLocks(new Date().toISOString())).map((l) => l.resource),
      ['res:second'],
    )
  })

  test('returns collected for an already stored result without new side effects', async () => {
    const store = new MemoryStore()
    const adapter = new ControlledAdapter()
    const task = await createTask(store, 'tsk-done', [{ resource: 'res:done', ttl_seconds: 15 }])
    await store.setTaskResult('tsk-done', {
      schema: 'cmap/task-result/v1',
      mission_id: task.mission_id,
      task_id: 'tsk-done',
      attempt: 1,
      status: 'completed',
      summary: 'done already',
      criterion_results: [{ criterion_id: 'DONE', actual: true, passed: true }],
      artifacts: [],
    })

    const out = await createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))({ taskId: 'tsk-done' })

    assert.equal(out.outcome, 'collected')
    assert.equal(adapter.startCalls.length, 0)
    assert.equal((await store.listActiveLocks(new Date().toISOString())).length, 0)
  })

  test('dispatch can resume from WAITING_RESOURCE after contention clears', async () => {
    const store = new MemoryStore()
    const adapter = new ControlledAdapter()
    await createTask(store, 'tsk-waiting', [{ resource: 'res:compat', ttl_seconds: 15 }])
    await store.acquireLock({
      lock_id: 'held-compat',
      resource: 'res:compat',
      task_id: 'holder',
      mission_id: 'holder-mis',
      holder_runner_id: 'other',
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      released_at: null,
    })
    const run = createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))

    assert.equal((await run({ taskId: 'tsk-waiting' })).outcome, 'waiting_resource')
    await store.releaseLock('held-compat', new Date().toISOString())
    const retry = run({ taskId: 'tsk-waiting' })
    await waitUntil(() => adapter.active === 1)
    adapter.complete('tsk-waiting')
    assert.equal((await retry).outcome, 'collected')
  })

  test('PG can reacquire after partial release without reusing the old lock primary key', async () => {
    await withPgStore(async (store) => {
      const adapter = new ControlledAdapter()
      await createTask(store, 'tsk-pg-reacquire', [
        { resource: 'res:a', ttl_seconds: 15 },
        { resource: 'res:b', ttl_seconds: 15 },
      ])
      await store.acquireLock({
        lock_id: 'held-pg-b',
        resource: 'res:b',
        task_id: 'holder',
        mission_id: 'holder-mis',
        holder_runner_id: 'other',
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        released_at: null,
      })
      const run = createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
        store,
        adapter,
        workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
        pollIntervalMs: 5,
      }))

      assert.equal((await run({ taskId: 'tsk-pg-reacquire' })).outcome, 'waiting_resource')
      await store.releaseLock('held-pg-b', new Date().toISOString())

      const retry = run({ taskId: 'tsk-pg-reacquire' })
      await waitUntil(() => adapter.active === 1)
      adapter.complete('tsk-pg-reacquire')
      assert.equal((await retry).outcome, 'collected')
    })
  })

  test('heartbeats while polling before terminal collection', async () => {
    const store = new MemoryStore()
    const adapter = new ControlledAdapter()
    await createTask(store, 'tsk-heartbeat')
    let beats = 0
    const current = mock.method(Context, 'current', () => ({
      heartbeat: () => {
        beats += 1
      },
    }) as ReturnType<typeof Context.current>)
    try {
      const pending = createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
        store,
        adapter,
        workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
        pollIntervalMs: 5,
      }))({ taskId: 'tsk-heartbeat' })
      await waitUntil(() => beats >= 2)
      adapter.complete('tsk-heartbeat')
      assert.equal((await pending).outcome, 'collected')
    } finally {
      current.mock.restore()
    }
  })

  test('renew errors are treated as lock loss and cancel confirmed releases leases', async () => {
    const store = new RenewThrowStore()
    const adapter = new ControlledAdapter()
    await createTask(store, 'tsk-renew-error', [{ resource: 'res:renew-error', ttl_seconds: 15 }])
    const pending = createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))({ taskId: 'tsk-renew-error' })
    await waitUntil(async () => (await store.listActiveLocks(new Date().toISOString())).length === 1)

    const out = await pending
    assert.equal(out.outcome, 'escalated')
    assert.equal(out.reason, 'LOCK_LOST')
    assert.equal(adapter.cancelCalls.length, 1)
    assert.equal((await store.listActiveLocks(new Date().toISOString())).length, 0)
  })

  test('cancel errors keep remaining leases and report unconfirmed cancellation', async () => {
    const store = new MemoryStore()
    const adapter = new ControlledAdapter()
    adapter.throwOnCancel = true
    await createTask(store, 'tsk-cancel-error', [
      { resource: 'res:first', ttl_seconds: 15 },
      { resource: 'res:second', ttl_seconds: 15 },
    ])
    const pending = createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))({ taskId: 'tsk-cancel-error' })
    await waitUntil(async () => (await store.listActiveLocks(new Date().toISOString())).length === 2)
    const first = (await store.listActiveLocks(new Date().toISOString()))
      .find((l) => l.resource === 'res:first')!
    await store.releaseLock(first.lock_id, new Date().toISOString())

    const out = await pending
    assert.equal(out.outcome, 'escalated')
    assert.equal(out.reason, 'CANCELLATION_UNCONFIRMED')
    assert.deepEqual(
      (await store.listActiveLocks(new Date().toISOString())).map((l) => l.resource),
      ['res:second'],
    )
  })

  test('status errors during cancellation observation keep leases unconfirmed', async () => {
    const store = new MemoryStore()
    const adapter = new ControlledAdapter()
    adapter.throwStatusAfterCancel = true
    await createTask(store, 'tsk-status-error', [
      { resource: 'res:first', ttl_seconds: 15 },
      { resource: 'res:second', ttl_seconds: 15 },
    ])
    const pending = createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))({ taskId: 'tsk-status-error' })
    await waitUntil(async () => (await store.listActiveLocks(new Date().toISOString())).length === 2)
    const first = (await store.listActiveLocks(new Date().toISOString()))
      .find((l) => l.resource === 'res:first')!
    await store.releaseLock(first.lock_id, new Date().toISOString())

    const out = await pending
    assert.equal(out.outcome, 'escalated')
    assert.equal(out.reason, 'CANCELLATION_UNCONFIRMED')
    assert.deepEqual(
      (await store.listActiveLocks(new Date().toISOString())).map((l) => l.resource),
      ['res:second'],
    )
  })

  test('terminal collect failures still release leases because terminal was proven', async () => {
    const store = new MemoryStore()
    const adapter = new ControlledAdapter()
    adapter.throwOnCollect = true
    await createTask(store, 'tsk-collect-error', [{ resource: 'res:collect', ttl_seconds: 15 }])
    const pending = createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))({ taskId: 'tsk-collect-error' })
    await waitUntil(async () => (await store.listActiveLocks(new Date().toISOString())).length === 1)
    adapter.complete('tsk-collect-error')

    const out = await pending
    assert.equal(out.outcome, 'escalated')
    assert.equal(out.reason, 'COLLECT_FAILED')
    assert.equal((await store.listActiveLocks(new Date().toISOString())).length, 0)
  })

  test('execution uncertainty after terminal observation escalates instead of collecting', async () => {
    const store = new MemoryStore()
    const adapter = new BindingLostDuringCollectAdapter()
    Object.defineProperty(adapter, 'adapterId', { value: 'codex-adapter' })
    await createTask(store, 'tsk-binding-lost-collect', [{ resource: 'res:binding-lost', ttl_seconds: 15 }])

    const out = await createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))({ taskId: 'tsk-binding-lost-collect' })

    assert.equal(out.outcome, 'escalated')
    assert.equal(out.reason, 'EXECUTION_UNCERTAIN:BINDING_NOT_FOUND')
    assert.equal((await store.listActiveLocks(new Date().toISOString())).length, 0)
    assert.equal(adapter.startCalls.length, 1)
  })

  for (const adapterId of ['codex-adapter', 'kimi-adapter'] as const) {
    test(`fresh ${adapterId} status miss records INPUT_REQUIRED and keeps leases`, async () => {
      const store = new MemoryStore()
      const adapter = new FreshCliBindingMissingAdapter()
      Object.defineProperty(adapter, 'adapterId', { value: adapterId })
      const taskId = `tsk-fresh-${adapterId}`
      await createTask(store, taskId, [{ resource: `res:${adapterId}`, ttl_seconds: 15 }])
      await store.transitionTask({
        taskId,
        to: 'QUEUED',
        actor: ACTOR,
        eventType: 'TASK_ASSIGNED',
        idempotencyKey: `${taskId}:queued`,
      })
      await store.claimTaskBinding({
        taskId,
        binding: {
          adapter: adapterId,
          remote_task_id: `${adapterId}:${taskId}:1`,
          protocol: 'cli',
          protocol_version: '0.1.0',
          runner_id: 'runner-test',
        },
        actor: ACTOR,
      })

      const out = await createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
        store,
        adapter,
        workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
        pollIntervalMs: 5,
      }))({ taskId })

      const task = await store.getTask(taskId)
      const events = await store.listEvents(task!.mission_id)
      assert.equal(out.outcome, 'escalated')
      assert.equal(out.reason, 'EXECUTION_UNCERTAIN:BINDING_NOT_FOUND')
      assert.equal(task?.state, 'INPUT_REQUIRED')
      assert.equal(task?.result, null)
      assert.equal(events.filter((event) => event.event_type === 'INPUT_REQUIRED').length, 1)
      assert.equal((await store.listActiveLocks(new Date().toISOString())).length, 1)
      assert.equal(adapter.startCalls.length, 0)
      assert.equal(adapter.cancelCalls.length, 0)
    })
  }

  test('unexpected acquisition errors release partial known locks before dispatch', async () => {
    const store = new AcquireThrowStore()
    const adapter = new ControlledAdapter()
    await createTask(store, 'tsk-acquire-error', [
      { resource: 'res:a', ttl_seconds: 15 },
      { resource: 'res:b', ttl_seconds: 15 },
    ])

    await assert.rejects(
      async () => createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
        store,
        adapter,
        workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
        pollIntervalMs: 5,
      }))({ taskId: 'tsk-acquire-error' }),
      /metadata store failed/,
    )
    assert.equal(adapter.startCalls.length, 0)
    assert.equal((await store.listActiveLocks(new Date().toISOString())).length, 0)
  })

  test('dispatch uncertainty uses a generic reason and retains leases', async () => {
    const store = new MemoryStore()
    const adapter = new StartErrorAdapter()
    await createTask(store, 'tsk-dispatch-error', [{ resource: 'res:dispatch', ttl_seconds: 15 }])

    const out = await createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapter,
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))({ taskId: 'tsk-dispatch-error' })

    assert.equal(out.outcome, 'escalated')
    assert.equal(out.reason, 'DISPATCH_UNCERTAIN')
    assert.equal(adapter.cancelCalls.length, 1)
    assert.equal((await store.listActiveLocks(new Date().toISOString())).length, 0)
  })

  test('missing adapter for an existing binding is uncertain and does not release locks', async () => {
    const store = new MemoryStore()
    await createTask(store, 'tsk-missing-adapter', [{ resource: 'res:missing-adapter', ttl_seconds: 15 }])
    await store.setTaskBinding('tsk-missing-adapter', {
      adapter: 'missing',
      remote_task_id: 'remote-missing',
      protocol: 'fake-exec',
      protocol_version: '0.0.1',
      runner_id: 'runner-test',
    })

    const out = await createDagAttemptRunner(syntheticActivityDeps({ runner: syntheticRunner(),
      store,
      adapters: [],
      workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-attempt-')),
      pollIntervalMs: 5,
    }))({ taskId: 'tsk-missing-adapter' })

    assert.equal(out.outcome, 'escalated')
    assert.equal(out.reason, 'ADAPTER_UNAVAILABLE')
    assert.equal((await store.listActiveLocks(new Date().toISOString())).length, 1)
  })
})
