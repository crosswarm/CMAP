import { createHash } from 'node:crypto'

import { Context } from '@temporalio/activity'

import type { RemoteTaskBinding, ResourceLock, Store, TaskEnvelopeV1, TaskRecord } from '#domain-model'
import { LockUnavailableError, snapshotRunnerDescriptor } from '#domain-model'
import { AdapterError, type AgentAdapter, type NormalizedAgentStatus } from '#adapter-sdk'
import { createActivities, type ActivityDeps } from './activities.ts'
import { preflightTaskDispatch, readAdmissionDenial, admissionDenialReason } from './runner-admission.ts'

export type DagAttemptOutcome = {
  readonly outcome: 'collected' | 'waiting_resource' | 'escalated'
  readonly taskId: string
  readonly reason?: string
}

const ACTOR = { type: 'system', id: 'dag-attempt' } as const
const CANCEL_GRACE_MS = 5_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const beforeDeadline = async <T>(operation: Promise<T>, deadline: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Adapter observation deadline')), Math.max(0, deadline - Date.now()))
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const executionUncertainReason = (code: string): string => `EXECUTION_UNCERTAIN:${code}`
const isCliBindingNotFound = (error: unknown, binding: RemoteTaskBinding): error is AdapterError =>
  error instanceof AdapterError &&
  error.code === 'BINDING_NOT_FOUND' &&
  (binding.adapter === 'codex-adapter' || binding.adapter === 'kimi-adapter' || binding.adapter === 'remote-runner-adapter')

const heartbeat = (): void => {
  try {
    Context.current().heartbeat()
  } catch {
    /* direct unit calls have no Activity context */
  }
}

const lockPrefix = (taskId: string, resource: string): string =>
  `daglk_${createHash('sha256').update(`${taskId}\0${resource}`).digest('hex').slice(0, 24)}`

const lockPolicy = (envelope: TaskEnvelopeV1) =>
  [...(envelope.execution_policy.required_resource_locks ?? [])]
    .sort((a, b) => (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0))

const assertTtl = (ttlSeconds: number, resource: string): void => {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 15 || ttlSeconds > 3600) {
    throw new Error(`资源锁 ${resource} 的 ttl_seconds 必须在 15..3600 秒内`)
  }
}

const adapterRegistry = (deps: ActivityDeps): readonly AgentAdapter[] => {
  if (deps.adapter && deps.adapters) throw new Error('adapter 与 adapters 不能同时配置')
  return deps.adapters ?? (deps.adapter ? [deps.adapter] : [])
}

const findAdapter = (adapters: readonly AgentAdapter[], binding: RemoteTaskBinding): AgentAdapter => {
  const adapter = adapters.find((a) => a.adapterId === binding.adapter)
  if (!adapter) throw new Error(`已绑定 Adapter 不可用：${binding.adapter}`)
  return adapter
}

const transitionToWaiting = async (store: Store, taskId: string, resource: string): Promise<void> => {
  let task = await store.getTask(taskId)
  if (!task) throw new Error(`任务不存在：${taskId}`)
  if (task.state === 'READY') {
    task = await store.transitionTask({
      taskId,
      to: 'QUEUED',
      actor: ACTOR,
      eventType: 'TASK_ASSIGNED',
      idempotencyKey: `dag-attempt:queued-for-lock:${taskId}`,
    })
  }
  if (task.state === 'QUEUED') {
    await store.transitionTask({
      taskId,
      to: 'WAITING_RESOURCE',
      actor: ACTOR,
      eventType: 'RESOURCE_LOCK_REQUESTED',
      idempotencyKey: `dag-attempt:waiting:${taskId}:${resource}`,
      payload: { resource },
    })
  }
}

const ownedActiveLock = async (
  store: Store,
  taskId: string,
  runnerId: string,
  resource: string,
): Promise<ResourceLock | null> => {
  const active = await store.listActiveLocks(new Date().toISOString())
  return active.find(
    (l) =>
      l.task_id === taskId &&
      l.holder_runner_id === runnerId &&
      l.resource === resource,
  ) ?? null
}

const releaseAll = async (store: Store, locks: readonly ResourceLock[]): Promise<void> => {
  const at = new Date().toISOString()
  for (const lock of locks) {
    await store.releaseLock(lock.lock_id, at)
  }
}

const observeCancellation = async (
  adapter: AgentAdapter,
  binding: RemoteTaskBinding,
  pollIntervalMs: number,
  deadline: number,
): Promise<NormalizedAgentStatus | null> => {
  while (Date.now() <= deadline) {
    let status: NormalizedAgentStatus
    try {
      status = await beforeDeadline(adapter.getStatus(binding), deadline)
    } catch {
      return null
    }
    if (status.terminal_observed) return status
    heartbeat()
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())))
  }
  return null
}

export const createDagAttemptRunner = (
  deps: ActivityDeps & { readonly workRoot: string },
): ((input: { taskId: string }) => Promise<DagAttemptOutcome>) => {
  const { store } = deps
  const runner = snapshotRunnerDescriptor(deps.runner)
  const runnerId = runner.runner_id
  const pollIntervalMs = deps.pollIntervalMs ?? 2_000
  const activities = createActivities(deps)
  const adapters = adapterRegistry(deps)
  let lockSeq = 0

  const nextLockId = (taskId: string, resource: string): string => {
    lockSeq += 1
    return `${lockPrefix(taskId, resource)}_${Date.now().toString(36)}_${String(lockSeq).padStart(4, '0')}`
  }

  const handleLockLoss = async (
    adapter: AgentAdapter,
    binding: RemoteTaskBinding,
    owned: readonly ResourceLock[],
    reason: string,
  ): Promise<DagAttemptOutcome> => {
    const deadline = Date.now() + CANCEL_GRACE_MS
    try {
      await beforeDeadline(adapter.cancel(binding, reason), deadline)
    } catch {
      return { outcome: 'escalated', taskId: binding.remote_task_id, reason: 'CANCELLATION_UNCONFIRMED' }
    }

    const terminal = await observeCancellation(adapter, binding, pollIntervalMs, deadline)
    if (!terminal) {
      return { outcome: 'escalated', taskId: binding.remote_task_id, reason: 'CANCELLATION_UNCONFIRMED' }
    }
    await releaseAll(store, owned)
    return { outcome: 'escalated', taskId: binding.remote_task_id, reason: 'LOCK_LOST' }
  }

  return async ({ taskId }) => {
    const initial = await store.getTask(taskId)
    if (!initial) throw new Error(`任务不存在：${taskId}`)
    if (initial.result) {
      const collected=await activities.collectTaskResult(taskId)
      if('executionUncertain' in collected)return {outcome:'escalated',taskId,reason:executionUncertainReason(collected.executionUncertain.code)}
      if(collected.admissionDenied)return {outcome:'escalated',taskId,reason:admissionDenialReason({admissionDenied:collected.admissionDenied})}
      return { outcome: 'collected', taskId }
    }
    const denied=await preflightTaskDispatch(store,runner,initial)
    if(denied)return {outcome:'escalated',taskId,reason:admissionDenialReason(denied)}

    const envelope = initial.envelope as TaskEnvelopeV1
    const policies = lockPolicy(envelope)
    const owned: ResourceLock[] = []
    const policyByLockId = new Map<string, (typeof policies)[number]>()

    for (const policy of policies) {
      assertTtl(policy.ttl_seconds, policy.resource)
      const existing = await ownedActiveLock(store, taskId, runnerId, policy.resource)
      if (existing) {
        owned.push(existing)
        policyByLockId.set(existing.lock_id, policy)
        continue
      }

      const now = new Date()
      const lock: ResourceLock = {
        lock_id: nextLockId(taskId, policy.resource),
        resource: policy.resource,
        task_id: taskId,
        mission_id: initial.mission_id,
        holder_runner_id: runnerId,
        acquired_at: now.toISOString(),
        expires_at: new Date(now.getTime() + policy.ttl_seconds * 1000).toISOString(),
        released_at: null,
      }
      try {
        const acquired = await store.acquireLock(lock)
        owned.push(acquired)
        policyByLockId.set(acquired.lock_id, policy)
      } catch (error) {
        await releaseAll(store, owned)
        if (!(error instanceof LockUnavailableError)) throw error
        await transitionToWaiting(store, taskId, policy.resource)
        return { outcome: 'waiting_resource', taskId, reason: `RESOURCE_BUSY:${policy.resource}` }
      }
    }

    const lockTtlMs = (lock: ResourceLock): number => {
      const policy = policyByLockId.get(lock.lock_id)
      if (!policy) throw new Error(`资源锁 ${lock.lock_id} 缺少续租策略`)
      return policy.ttl_seconds * 1000
    }

    const renewEveryMs = (lock: ResourceLock): number => Math.max(1, Math.floor(lockTtlMs(lock) / 3))

    const nextRenewAt = new Map(owned.map((lock) => [
      lock.lock_id,
      Date.parse(lock.acquired_at) + renewEveryMs(lock),
    ]))

    const renewDueLocks = async (): Promise<ResourceLock | null> => {
      const now = Date.now()
      for (const lock of owned) {
        const due = nextRenewAt.get(lock.lock_id) ?? now
        if (now < due) continue

        const ttlMs = lockTtlMs(lock)
        let renewed = false
        try {
          renewed = await store.renewLock(
            lock.lock_id,
            new Date(Date.now() + ttlMs).toISOString(),
          )
        } catch {
          renewed = false
        }
        if (!renewed) return lock
        nextRenewAt.set(lock.lock_id, Date.now() + renewEveryMs(lock))
      }
      heartbeat()
      return null
    }

    const inactiveOwnedLock = async (): Promise<ResourceLock | null> => {
      const active = await store.listActiveLocks(new Date().toISOString())
      for (const lock of owned) {
        const stillHeld = active.some(
          (candidate) =>
            candidate.lock_id === lock.lock_id &&
            candidate.task_id === taskId &&
            candidate.holder_runner_id === runnerId &&
            candidate.resource === lock.resource,
        )
        if (!stillHeld) return lock
      }
      return null
    }

    const waitForNextLockCheck = async (deadline: number): Promise<void> => {
      const now = Date.now()
      const timeLeft = deadline - now
      if (timeLeft <= 0) return
      if (!owned.length) {
        await sleep(Math.min(pollIntervalMs, timeLeft))
        return
      }
      const next = Math.min(...owned.map((lock) => nextRenewAt.get(lock.lock_id) ?? now))
      await sleep(Math.min(pollIntervalMs, timeLeft, Math.max(1, next - now)))
    }

    const awaitWithLockMaintenance = async <T>(operation: Promise<T>, deadline: number): Promise<
      | { readonly status: 'fulfilled'; readonly value: T }
      | { readonly status: 'rejected'; readonly reason: unknown }
      | { readonly status: 'lock_lost'; readonly lock: ResourceLock }
      | { readonly status: 'lock_lost_unconfirmed'; readonly lock: ResourceLock }
      | { readonly status: 'timeout_observed' }
      | { readonly status: 'timeout_unconfirmed' }
    > => {
      let settled: undefined | ({ readonly status: 'fulfilled'; readonly value: T } | { readonly status: 'rejected'; readonly reason: unknown })
      operation.then(
        (value) => { settled = { status: 'fulfilled', value } },
        (reason: unknown) => { settled = { status: 'rejected', reason } },
      )
      await Promise.resolve()
      while (!settled) {
        if (Date.now() >= deadline) {
          try {
            await beforeDeadline(operation, Date.now() + CANCEL_GRACE_MS)
          } catch {
            return { status: 'timeout_unconfirmed' }
          }
          return { status: 'timeout_observed' }
        }
        const lost = await renewDueLocks()
        if (lost) {
          try {
            await beforeDeadline(operation, Date.now() + CANCEL_GRACE_MS)
          } catch {
            return { status: 'lock_lost_unconfirmed', lock: lost }
          }
          return { status: 'lock_lost', lock: lost }
        }
        await waitForNextLockCheck(deadline)
      }
      return settled
    }

    const findBoundAdapter = async (): Promise<{ binding: RemoteTaskBinding; adapter: AgentAdapter } | null> => {
      const latest = await store.getTask(taskId)
      if (!latest?.binding) return null
      return { binding: latest.binding, adapter: findAdapter(adapters, latest.binding) }
    }

    const taskOutcome = (out: DagAttemptOutcome, reason = out.reason): DagAttemptOutcome => (
      reason ? { outcome: out.outcome, taskId, reason } : { outcome: out.outcome, taskId }
    )

    const handleKnownBindingFailure = async (
      binding: RemoteTaskBinding,
      reason: string,
      reportedReason: string,
    ): Promise<DagAttemptOutcome> => {
      let boundAdapter: AgentAdapter
      try {
        boundAdapter = findAdapter(adapters, binding)
      } catch {
        return { outcome: 'escalated', taskId, reason: 'ADAPTER_UNAVAILABLE' }
      }
      const out = await handleLockLoss(boundAdapter, binding, owned, reason)
      return taskOutcome(out, out.reason === 'LOCK_LOST' ? reportedReason : out.reason)
    }

    const handleOwnedLockLoss = async (lock: ResourceLock, reason: string): Promise<DagAttemptOutcome> => {
      let bound: { binding: RemoteTaskBinding; adapter: AgentAdapter } | null
      try {
        bound = await findBoundAdapter()
      } catch {
        return { outcome: 'escalated', taskId, reason: 'ADAPTER_UNAVAILABLE' }
      }
      if (!bound) return { outcome: 'escalated', taskId, reason: 'DISPATCH_UNCERTAIN' }
      return taskOutcome(await handleLockLoss(bound.adapter, bound.binding, owned, `${reason}：${lock.resource}`))
    }

    const handleDispatchTimeoutAfterObserved = async (): Promise<DagAttemptOutcome> => {
      let bound: { binding: RemoteTaskBinding; adapter: AgentAdapter } | null
      try {
        bound = await findBoundAdapter()
      } catch {
        return { outcome: 'escalated', taskId, reason: 'ADAPTER_UNAVAILABLE' }
      }
      if (!bound) return { outcome: 'escalated', taskId, reason: 'DISPATCH_UNCERTAIN' }
      const out = await handleLockLoss(bound.adapter, bound.binding, owned, '派发等待超时')
      return taskOutcome(out, out.reason === 'LOCK_LOST' ? 'TIMEOUT' : out.reason)
    }

    const handleUnconfirmedLateDispatch = async (confirmedReason: 'LOCK_LOST' | 'TIMEOUT' | 'DISPATCH_UNCERTAIN'): Promise<DagAttemptOutcome> => {
      let bound: { binding: RemoteTaskBinding; adapter: AgentAdapter } | null
      try {
        bound = await findBoundAdapter()
      } catch {
        return { outcome: 'escalated', taskId, reason: 'CANCELLATION_UNCONFIRMED' }
      }
      if (!bound) return { outcome: 'escalated', taskId, reason: 'CANCELLATION_UNCONFIRMED' }
      const out = await handleLockLoss(bound.adapter, bound.binding, owned, '派发结束状态不确定')
      return taskOutcome(out, out.reason === 'LOCK_LOST' ? confirmedReason : out.reason)
    }

    const deadline = Date.now() + (deps.waitTimeoutMs ?? envelope.execution_policy.timeout_seconds * 1000)
    const dispatchOperation = activities.dispatchTask(taskId)
    const dispatch = await awaitWithLockMaintenance(dispatchOperation, deadline)
    if (dispatch.status === 'rejected') {
      // A failed ledger transition does not undo an already-started Agent.
      await handleUnconfirmedLateDispatch('DISPATCH_UNCERTAIN')
      return { outcome: 'escalated', taskId, reason: 'DISPATCH_UNCERTAIN' }
    }
    if (dispatch.status === 'timeout_observed') {
      return handleDispatchTimeoutAfterObserved()
    }
    if (dispatch.status === 'lock_lost_unconfirmed' || dispatch.status === 'timeout_unconfirmed') {
      const reason = dispatch.status === 'lock_lost_unconfirmed' ? 'LOCK_LOST' : 'TIMEOUT'
      const cancelLate = () => handleUnconfirmedLateDispatch(reason)
      const outcome = await cancelLate()
      if (outcome.reason === 'CANCELLATION_UNCONFIRMED') {
        // startTask may publish its binding after the observation grace. Rejection
        // may also mean binding persisted but the RUNNING transition failed.
        void dispatchOperation.then(cancelLate, cancelLate).catch(() => undefined)
      }
      return outcome
    }
    if (dispatch.status === 'lock_lost') {
      return handleOwnedLockLoss(dispatch.lock, '派发期间资源锁失效')
    }

    if ('admissionDenied' in dispatch.value) {
      await releaseAll(store,owned)
      return {outcome:'escalated',taskId,reason:admissionDenialReason(dispatch.value)}
    }

    let task: TaskRecord | null
    try {
      task = await store.getTask(taskId)
    } catch {
      return { outcome: 'escalated', taskId, reason: 'DISPATCH_UNCERTAIN' }
    }
    if (!task) throw new Error(`任务不存在：${taskId}`)
    let lostAfterDispatch: ResourceLock | null
    try {
      lostAfterDispatch = await inactiveOwnedLock()
    } catch {
      if (task.binding) return handleKnownBindingFailure(task.binding, '账本锁读取失败', 'STATUS_UNAVAILABLE')
      return { outcome: 'escalated', taskId, reason: 'DISPATCH_UNCERTAIN' }
    }
    if (lostAfterDispatch) {
      return handleOwnedLockLoss(lostAfterDispatch, '派发完成后资源锁失效')
    }
    if (task.result) {
      try {
        const collected=await activities.collectTaskResult(taskId)
        if('executionUncertain' in collected)return {outcome:'escalated',taskId,reason:executionUncertainReason(collected.executionUncertain.code)}
        if(collected.admissionDenied)return {outcome:'escalated',taskId,reason:admissionDenialReason({admissionDenied:collected.admissionDenied})}
      } finally {
        await releaseAll(store, owned)
      }
      return { outcome: 'collected', taskId }
    }
    if (!task.binding) throw new Error(`任务 ${taskId} 尚未派发，无结果可收`)

    let adapter: AgentAdapter
    try {
      adapter = findAdapter(adapters, task.binding)
    } catch {
      return { outcome: 'escalated', taskId, reason: 'ADAPTER_UNAVAILABLE' }
    }
    const binding = task.binding

    for (;;) {
      let revoked
      try {
        const current=await store.getTask(taskId)
        if(!current)throw new Error('TASK_NOT_FOUND')
        revoked=await readAdmissionDenial(store,current)
      } catch {
        return handleKnownBindingFailure(binding,'准入账本读取失败','STATUS_UNAVAILABLE')
      }
      if(revoked) {
        await releaseAll(store,owned)
        return {outcome:'escalated',taskId,reason:admissionDenialReason(revoked)}
      }
      const lost = await renewDueLocks()
      if (lost) {
        return handleOwnedLockLoss(lost, '资源锁失效')
      }

      heartbeat()
      let status: NormalizedAgentStatus
      try {
        status = await beforeDeadline(adapter.getStatus(binding, { deadline_at: new Date(deadline).toISOString() }), Math.min(deadline, Date.now() + CANCEL_GRACE_MS))
      } catch (error) {
        if (isCliBindingNotFound(error, binding)) {
          try {
            const collected = await activities.collectTaskResult(taskId)
            if ('executionUncertain' in collected) {
              return { outcome: 'escalated', taskId, reason: executionUncertainReason(collected.executionUncertain.code) }
            }
            if (collected.admissionDenied) {
              await releaseAll(store, owned)
              return { outcome: 'escalated', taskId, reason: admissionDenialReason({ admissionDenied: collected.admissionDenied }) }
            }
            const collectedTask = await store.getTask(taskId)
            if (collectedTask?.result) {
              await releaseAll(store, owned)
              return { outcome: 'collected', taskId }
            }
            return { outcome: 'escalated', taskId, reason: 'STATUS_UNAVAILABLE' }
          } catch {
            return { outcome: 'escalated', taskId, reason: 'STATUS_UNAVAILABLE' }
          }
        }
        const out = await handleLockLoss(adapter, binding, owned, '状态观测失败')
        return taskOutcome(out, out.reason === 'LOCK_LOST' ? 'STATUS_UNAVAILABLE' : out.reason)
      }
      if (status.terminal_observed) {
        let lostBeforeCollect: ResourceLock | null
        try {
          lostBeforeCollect = await inactiveOwnedLock()
        } catch {
          return handleKnownBindingFailure(binding, '账本锁读取失败', 'STATUS_UNAVAILABLE')
        }
        if (lostBeforeCollect) {
          return handleOwnedLockLoss(lostBeforeCollect, '终态采纳前资源锁失效')
        }
        try {
          const collected=await activities.collectTaskResult(taskId)
          if('executionUncertain' in collected)return {outcome:'escalated',taskId,reason:executionUncertainReason(collected.executionUncertain.code)}
          if(collected.admissionDenied)return {outcome:'escalated',taskId,reason:admissionDenialReason({admissionDenied:collected.admissionDenied})}
          return { outcome: 'collected', taskId }
        } catch {
          return { outcome: 'escalated', taskId, reason: 'COLLECT_FAILED' }
        } finally {
          await releaseAll(store, owned)
        }
      }
      if (Date.now() > deadline) {
        const out = await handleLockLoss(adapter, binding, owned, '等待终态超时')
        if (out.reason === 'LOCK_LOST') return { outcome: 'escalated', taskId, reason: 'TIMEOUT' }
        return taskOutcome(out)
      }

      try {
        task = await store.getTask(taskId)
      } catch {
        return handleKnownBindingFailure(binding, '账本读取失败', 'STATUS_UNAVAILABLE')
      }
      if (task?.result) {
        let lostBeforeCollect: ResourceLock | null
        try {
          lostBeforeCollect = await inactiveOwnedLock()
        } catch {
          return handleKnownBindingFailure(binding, '账本锁读取失败', 'STATUS_UNAVAILABLE')
        }
        if (lostBeforeCollect) {
          return handleOwnedLockLoss(lostBeforeCollect, '结果采纳前资源锁失效')
        }
        try {
          const collected=await activities.collectTaskResult(taskId)
          if('executionUncertain' in collected)return {outcome:'escalated',taskId,reason:executionUncertainReason(collected.executionUncertain.code)}
          if(collected.admissionDenied)return {outcome:'escalated',taskId,reason:admissionDenialReason({admissionDenied:collected.admissionDenied})}
        } finally {
          await releaseAll(store, owned)
        }
        return { outcome: 'collected', taskId }
      }
      await sleep(pollIntervalMs)
    }
  }
}
