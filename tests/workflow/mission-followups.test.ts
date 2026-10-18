import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { Client, Connection } from '@temporalio/client'
import { NativeConnection, Worker } from '@temporalio/worker'
import { ApplicationFailure, CancelledFailure } from '@temporalio/common'
import proto from '@temporalio/proto'

process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = process.env['NO_PROXY']

const address = process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233'
const taskQueue = `cmap-mission-followups-${process.pid}-${Date.now()}`

let connection: Connection
let native: NativeConnection
let worker: Worker
let running: Promise<void>
let client: Client

type ReviewOutcome = {
  readonly outcome: 'accept' | 'rework' | 'escalated'
  readonly followupTaskIds: readonly string[]
  readonly escalationReason?: string
}

type Harness = {
  readonly missionId: string
  readonly dispatched: string[]
  readonly canceled: Array<{ readonly taskIds: readonly string[]; readonly reason: string }>
  readonly reviews: Array<{ readonly taskId: string; readonly round: number; readonly previous: string | null }>
  readonly outcomes: Map<string, ReviewOutcome>
  readonly admissionDenied: Set<string>
  readonly dispatchFailures: Set<string>
  readonly uncertain: Set<string>
  readonly approvalRejected: Set<string>
  readonly states: string[]
  cleanupFailureReason: string | null
  finalizationFailure: boolean
  collectionGate?: { taskId: string; entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }
}

const runs = new Map<string, Harness>()

const harness = (missionId: string, outcomes?: Iterable<readonly [string, ReviewOutcome]>): Harness => {
  const state: Harness = {
    missionId,
    dispatched: [],
    canceled: [],
    reviews: [],
    outcomes: new Map(outcomes ?? [
      ['root', { outcome: 'rework', followupTaskIds: ['child-a', 'child-b'] }],
      ['child-a', { outcome: 'accept', followupTaskIds: [] }],
      ['child-b', { outcome: 'accept', followupTaskIds: [] }],
    ]),
    admissionDenied: new Set(),
    dispatchFailures: new Set(),
    uncertain: new Set(),
    approvalRejected: new Set(),
    states: [],
    cleanupFailureReason: null,
    finalizationFailure: false,
  }
  runs.set(missionId, state)
  return state
}

const current = (missionId: string): Harness => {
  const state = runs.get(missionId)
  if (!state) throw new Error(`missing harness for ${missionId}`)
  return state
}

const taskMission = (taskId: string): string => {
  const match = taskId.match(/^([^:]+):/)
  if (!match) throw new Error(`bad task id ${taskId}`)
  return match[1]!
}

before(async () => {
  connection = await Connection.connect({ address, connectTimeout: 15_000 })
  native = await NativeConnection.connect({ address })
  client = new Client({ connection, namespace: 'default' })
  worker = await Worker.create({
    connection: native,
    namespace: 'default',
    taskQueue,
    workflowsPath: resolve('workflows/mission.workflow.ts'),
    activities: {
      setMissionState: async ({missionId, state}: {missionId: string; state: string}) => {
        const run = current(missionId)
        if (state === 'COMPLETED' && run.finalizationFailure) {
          throw ApplicationFailure.nonRetryable('synthetic finalization failure')
        }
        run.states.push(state)
      },
      createTask: async ({ missionId }: { missionId: string }) => ({ taskId: `${missionId}:root` }),
      markReady: async () => {},
      requestApproval: async (taskId: string) => current(taskMission(taskId)).approvalRejected.has(taskId.split(':').at(-1)!)
        ? {required: true, approvalId: taskId + '-approval', scope: 'controlled'} : {required: false},
      waitForApproval: async () => ({decision: 'rejected', decidedBy: 'synthetic:test-operator'}),
      dispatchTask: async (taskId: string) => {
        const state = current(taskMission(taskId))
        const shortId = taskId.split(':').at(-1)!
        if (state.dispatchFailures.has(shortId)) throw new Error(`synthetic dispatch failure:${shortId}`)
        state.dispatched.push(taskId)
        if (state.admissionDenied.has(shortId)) {
          return { dispatched: false, admissionDenied: { phase: 'initial', code: 'OWNER_DENIED' } }
        }
        return { dispatched: true, remoteTaskId: `remote:${taskId}` }
      },
      collectTaskResult: async (taskId: string) => {
        const state = current(taskMission(taskId))
        if (state.collectionGate?.taskId === taskId) {
          state.collectionGate.entered.resolve()
          await state.collectionGate.release.promise
        }
        if (state.uncertain.has(taskId.split(':').at(-1)!)) {
          return {executionUncertain: {code: 'BINDING_NOT_FOUND', terminalObserved: false}}
        }
        return {status: 'completed', passed: true, failedCriteria: [], summary: `done:${taskId}`}
      },
      markVerifying: async () => {},
      evaluateHardGate: async ({ taskId, round }: { taskId: string; round: number }) => ({
        decision: {
          schema: 'cmap/review-decision/v1',
          mission_id: taskMission(taskId),
          review_round: round + 1,
          reviewed_task_ids: [taskId],
          decision: taskId.endsWith(':root') ? 'rework' : 'accept',
          hard_gate_summary: { total: 1, passed: taskId.endsWith(':root') ? 0 : 1, failed: taskId.endsWith(':root') ? 1 : 0 },
          review_confidence: { level: 'high', limitations: [] },
          ...(taskId.endsWith(':root') ? {
            failed_criteria: [{ criterion_id: 'C1', expected: 'ok', actual: 'bad', reason: 'synthetic', evidence: [] }],
            required_followups: [{ capability: 'code.analyze', focus: ['fix'] }],
            stop_conditions: { max_additional_cycles: 2 },
          } : {}),
        },
        progress: {
          patchHash: `hash:${taskId}`,
          failedCriteriaIds: taskId.endsWith(':root') ? ['C1'] : [],
          metricValue: round,
          errorFingerprint: null,
        },
      }),
      beginReview: async () => {},
      applyReviewDecision: async (input: {
        taskId: string
        round: number
        previousProgress?: { readonly patchHash: string }
      }) => {
        const state = current(taskMission(input.taskId))
        state.reviews.push({
          taskId: input.taskId,
          round: input.round,
          previous: input.previousProgress?.patchHash ?? null,
        })
        const shortId = input.taskId.split(':').at(-1)!
        const outcome = state.outcomes.get(shortId)
        if (!outcome) throw new Error(`missing outcome for ${input.taskId}`)
        return {
          ...outcome,
          followupTaskIds: outcome.followupTaskIds.map((id) => `${state.missionId}:${id}`),
        }
      },
      cancelPendingMissionTasks: async (input: { readonly taskIds: readonly string[]; readonly reason: string }) => {
        const state = current(taskMission(input.taskIds[0]!))
        if (state.cleanupFailureReason === input.reason) throw new Error(`cleanup failed:${input.reason}`)
        state.canceled.push(input)
      },
      // S5 旁路回写：本文件只验证多后继调度，回写由 mission-continuity 覆盖。
      proposeTaskKnowledge: async () => {},
      recordEscalationHandoff: async () => {},
    },
  })
  running = worker.run()
})

after(async () => {
  worker?.shutdown()
  await running?.catch(() => {})
  await connection?.close()
  await native?.close()
})

test('executes every followup in FIFO order before completing', async () => {
  const missionId = `mis-followups-${Date.now()}`
  const state = harness(missionId)

  const result = await client.workflow.execute('missionWorkflow', {
    workflowId: missionId,
    taskQueue,
    args: [{ missionId }],
  })

  assert.equal(result.state, 'COMPLETED')
  assert.deepEqual(state.dispatched, [
    `${missionId}:root`,
    `${missionId}:child-a`,
    `${missionId}:child-b`,
  ])
  assert.deepEqual(result.taskIds, state.dispatched)
  assert.equal(result.rounds, 1)
  assert.deepEqual(state.canceled, [])
  const history = await client.workflow.getHandle(missionId).fetchHistory()
  await Worker.runReplayHistory({workflowsPath: resolve('workflows/mission.workflow.ts')}, history)
})

test('keeps FIFO order and parent progress for nested branches', async () => {
  const missionId = `mis-nested-${Date.now()}`
  const state = harness(missionId, [
    ['root', { outcome: 'rework', followupTaskIds: ['child-a', 'child-b'] }],
    ['child-a', { outcome: 'rework', followupTaskIds: ['child-a1'] }],
    ['child-b', { outcome: 'accept', followupTaskIds: [] }],
    ['child-a1', { outcome: 'accept', followupTaskIds: [] }],
  ])

  const result = await client.workflow.execute('missionWorkflow', {
    workflowId: missionId,
    taskQueue,
    args: [{ missionId }],
  })

  assert.equal(result.state, 'COMPLETED')
  assert.deepEqual(state.dispatched, [
    `${missionId}:root`,
    `${missionId}:child-a`,
    `${missionId}:child-b`,
    `${missionId}:child-a1`,
  ])
  assert.deepEqual(
    state.reviews.map((review) => [review.taskId, review.round, review.previous]),
    [
      [`${missionId}:root`, 0, null],
      [`${missionId}:child-a`, 1, `hash:${missionId}:root`],
      [`${missionId}:child-b`, 1, `hash:${missionId}:root`],
      [`${missionId}:child-a1`, 2, `hash:${missionId}:child-a`],
    ],
  )
  assert.equal(result.rounds, 2)
})

test('cancels queued siblings when a branch escalates', async () => {
  const missionId = `mis-branch-stop-${Date.now()}`
  const state = harness(missionId, [
    ['root', { outcome: 'rework', followupTaskIds: ['child-a', 'child-b'] }],
    ['child-a', { outcome: 'escalated', followupTaskIds: [], escalationReason: 'synthetic escalation' }],
    ['child-b', { outcome: 'accept', followupTaskIds: [] }],
  ])

  const result = await client.workflow.execute('missionWorkflow', {
    workflowId: missionId,
    taskQueue,
    args: [{ missionId }],
  })

  assert.equal(result.state, 'ESCALATED')
  assert.deepEqual(state.dispatched, [`${missionId}:root`, `${missionId}:child-a`])
  assert.deepEqual(result.taskIds, [`${missionId}:root`, `${missionId}:child-a`, `${missionId}:child-b`])
  assert.deepEqual(state.canceled, [{
    missionId,
    taskIds: [`${missionId}:child-b`],
    reason: 'BRANCH_ESCALATED',
  }])
})

test('fanout limit cancels created children before successor dispatch', async () => {
  const missionId = `mis-fanout-limit-${Date.now()}`
  const children = Array.from({ length: 17 }, (_, i) => `child-${i}`)
  const state = harness(missionId, [
    ['root', { outcome: 'rework', followupTaskIds: children }],
  ])

  const result = await client.workflow.execute('missionWorkflow', {
    workflowId: missionId,
    taskQueue,
    args: [{ missionId }],
  })

  assert.equal(result.state, 'ESCALATED')
  assert.equal(result.escalationReason, 'MISSION_TASK_LIMIT')
  assert.deepEqual(state.dispatched, [`${missionId}:root`])
  assert.deepEqual(result.taskIds, [`${missionId}:root`, ...children.map((child) => `${missionId}:${child}`)])
  assert.deepEqual(state.canceled, [{
    missionId,
    taskIds: children.map((child) => `${missionId}:${child}`),
    reason: 'MISSION_TASK_LIMIT',
  }])
})

test('allows exact fanout limit of sixteen children', async () => {
  const missionId = `mis-fanout-exact-${Date.now()}`
  const children = Array.from({ length: 16 }, (_, i) => `child-${i}`)
  const state = harness(missionId, [
    ['root', { outcome: 'rework', followupTaskIds: children }],
    ...children.map((child) => [child, { outcome: 'accept', followupTaskIds: [] }] as const),
  ])

  const result = await client.workflow.execute('missionWorkflow', {
    workflowId: missionId,
    taskQueue,
    args: [{ missionId }],
  })

  assert.equal(result.state, 'COMPLETED')
  assert.deepEqual(state.dispatched, [`${missionId}:root`, ...children.map((child) => `${missionId}:${child}`)])
  assert.deepEqual(state.canceled, [])
})

test('executes all 128 tasks at the exact discovered limit', async () => {
  const missionId = `mis-total-exact-${Date.now()}`
  const rootChildren = Array.from({ length: 16 }, (_, i) => `child-${i}`)
  const batches = rootChildren.slice(0, 7).flatMap((parent, parentIndex) => {
    const count = parentIndex === 6 ? 15 : 16
    const children = Array.from({ length: count }, (_, i) => `${parent}-next-${i}`)
    return [
      [parent, { outcome: 'rework', followupTaskIds: children }] as const,
      ...children.map((child) => [child, { outcome: 'accept', followupTaskIds: [] }] as const),
    ]
  })
  const state = harness(missionId, [
    ['root', { outcome: 'rework', followupTaskIds: rootChildren }],
    ...batches,
    ...rootChildren.slice(7).map(child => [child, {outcome: 'accept', followupTaskIds: []}] as const),
  ])

  const result = await client.workflow.execute('missionWorkflow', {
    workflowId: missionId,
    taskQueue,
    args: [{ missionId }],
  })

  assert.equal(result.state, 'COMPLETED')
  assert.equal(result.taskIds.length, 128)
  assert.equal(state.dispatched.length, 128)
  assert.equal(new Set(state.dispatched).size, 128)
  assert.deepEqual(state.canceled, [])
})

test('total discovered limit cancels pending and new children at 129', async () => {
  const missionId = `mis-total-limit-${Date.now()}`
  const rootChildren = Array.from({ length: 16 }, (_, i) => `child-${i}`)
  const batches = rootChildren.slice(0, 7).flatMap((parent) => {
    const children = Array.from({ length: 16 }, (_, i) => `${parent}-next-${i}`)
    return [[parent, { outcome: 'rework', followupTaskIds: children }] as const]
  })
  const state = harness(missionId, [
    ['root', { outcome: 'rework', followupTaskIds: rootChildren }],
    ...batches,
  ])

  const result = await client.workflow.execute('missionWorkflow', {
    workflowId: missionId,
    taskQueue,
    args: [{ missionId }],
  })

  assert.equal(result.state, 'ESCALATED')
  assert.equal(result.escalationReason, 'MISSION_TASK_LIMIT')
  assert.equal(result.taskIds.length, 129)
  assert.equal(state.dispatched.at(-1), `${missionId}:child-6`)
  assert.equal(state.canceled[0]?.reason, 'MISSION_TASK_LIMIT')
  assert.ok(state.canceled[0]!.taskIds.includes(`${missionId}:child-7`), 'pending siblings are canceled')
  assert.ok(state.canceled[0]!.taskIds.includes(`${missionId}:child-6-next-15`), 'newly created children are canceled')
})

test('applyReviewDecision failure after branching propagates without cleanup', async () => {
  const missionId = `mis-review-fails-${Date.now()}`
  const state = harness(missionId, [
    ['root', { outcome: 'rework', followupTaskIds: ['child-a', 'child-b'] }],
    ['child-b', { outcome: 'accept', followupTaskIds: [] }],
  ])

  await assert.rejects(
    client.workflow.execute('missionWorkflow', {
      workflowId: missionId,
      taskQueue,
      args: [{ missionId }],
    }),
    (error) => {
      let cursor = error as { readonly cause?: unknown } | undefined
      while (cursor) {
        if (String(cursor).includes('missing outcome for')) return true
        cursor = cursor.cause as { readonly cause?: unknown } | undefined
      }
      return false
    },
  )

  assert.deepEqual(state.dispatched, [`${missionId}:root`, `${missionId}:child-a`])
  assert.deepEqual(state.canceled, [])
})

test('known queued activity failure cancels pending siblings', async () => {
  const missionId = `mis-activity-fails-${Date.now()}`
  const state = harness(missionId)
  state.dispatchFailures.add('child-a')

  const result = await client.workflow.execute('missionWorkflow', {
    workflowId: missionId,
    taskQueue,
    args: [{ missionId }],
  })

  assert.equal(result.state, 'ESCALATED')
  assert.equal(result.escalationReason, 'WORKFLOW_ACTIVITY_FAILED')
  assert.deepEqual(state.dispatched, [`${missionId}:root`])
  assert.deepEqual(state.canceled, [{
    missionId,
    taskIds: [`${missionId}:child-b`],
    reason: 'WORKFLOW_ACTIVITY_FAILED',
  }])
})

test('admission denial and execution uncertainty stop queued siblings', async () => {
  for (const mode of ['admission', 'uncertain'] as const) {
    const missionId = `mis-${mode}-stop-${Date.now()}`
    const state = harness(missionId)
    if (mode === 'admission') state.admissionDenied.add('child-a')
    else state.uncertain.add('child-a')

    const result = await client.workflow.execute('missionWorkflow', {
      workflowId: missionId,
      taskQueue,
      args: [{ missionId }],
    })

    assert.equal(result.state, 'ESCALATED')
    assert.deepEqual(state.dispatched, [`${missionId}:root`, `${missionId}:child-a`])
    assert.deepEqual(state.canceled, [{
      missionId,
      taskIds: [`${missionId}:child-b`],
      reason: mode === 'admission' ? 'ADMISSION_DENIED' : 'EXECUTION_UNCERTAIN',
    }])
  }
})

test('cleanup failure propagates instead of returning recovered success', async () => {
  const missionId = `mis-cleanup-fails-${Date.now()}`
  const state = harness(missionId, [
    ['root', { outcome: 'rework', followupTaskIds: ['child-a', 'child-b'] }],
    ['child-a', { outcome: 'escalated', followupTaskIds: [], escalationReason: 'synthetic escalation' }],
    ['child-b', { outcome: 'accept', followupTaskIds: [] }],
  ])
  state.cleanupFailureReason = 'BRANCH_ESCALATED'

  await assert.rejects(
    client.workflow.execute('missionWorkflow', {
      workflowId: missionId,
      taskQueue,
      args: [{ missionId }],
    }),
    (error) => {
      let cursor = error as { readonly cause?: unknown } | undefined
      while (cursor) {
        if (String(cursor).includes('cleanup failed:BRANCH_ESCALATED')) return true
        cursor = cursor.cause as { readonly cause?: unknown } | undefined
      }
      return false
    },
  )

  assert.deepEqual(state.canceled, [])
})

test('first fanout after a single-child prefix preserves both branches and depth', async () => {
  const missionId = `mis-late-fanout-${Date.now()}`
  const state = harness(missionId, [
    ['root', {outcome: 'rework', followupTaskIds: ['chain']}],
    ['chain', {outcome: 'rework', followupTaskIds: ['child-a', 'child-b']}],
    ['child-a', {outcome: 'accept', followupTaskIds: []}],
    ['child-b', {outcome: 'accept', followupTaskIds: []}],
  ])
  const result = await client.workflow.execute('missionWorkflow', {
    workflowId: missionId, taskQueue, args: [{missionId}],
  })
  assert.equal(result.state, 'COMPLETED')
  assert.equal(result.rounds, 2)
  assert.deepEqual(state.dispatched, ['root', 'chain', 'child-a', 'child-b'].map(id => `${missionId}:${id}`))
  assert.deepEqual(state.reviews.slice(2).map(r => [r.round, r.previous]), [
    [2, `hash:${missionId}:chain`], [2, `hash:${missionId}:chain`],
  ])
})

test('approval rejection cancels queued siblings without dispatching the rejected task', async () => {
  const missionId = `mis-rejected-${Date.now()}`
  const state = harness(missionId)
  state.approvalRejected.add('child-a')
  const result = await client.workflow.execute('missionWorkflow', {
    workflowId: missionId, taskQueue, args: [{missionId}],
  })
  assert.equal(result.state, 'FAILED')
  assert.deepEqual(state.dispatched, [`${missionId}:root`])
  assert.deepEqual(state.states, ['RUNNING', 'AWAITING_APPROVAL', 'FAILED'])
  assert.deepEqual(state.canceled, [{missionId, taskIds: [`${missionId}:child-b`], reason: 'APPROVAL_REJECTED'}])
})

test('completion state write failure propagates instead of being converted into escalation', async () => {
  const missionId = `mis-finalize-fails-${Date.now()}`
  const state = harness(missionId)
  state.finalizationFailure = true
  await assert.rejects(client.workflow.execute('missionWorkflow', {
    workflowId: missionId, taskQueue, args: [{missionId}],
  }), error => {
    let cause: unknown = error
    while (cause instanceof Error) {
      if (cause.message.includes('synthetic finalization failure')) return true
      cause = cause.cause
    }
    return false
  })
  assert.equal(state.dispatched.length, 3)
  assert.deepEqual(state.states, ['RUNNING'])
  assert.deepEqual(state.canceled, [])
})

test('external Workflow cancellation propagates without automatic escalation or sibling dispatch', async () => {
  const missionId = `mis-workflow-cancel-${Date.now()}`
  const state = harness(missionId)
  const gate = {taskId: `${missionId}:child-a`, entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>()}
  state.collectionGate = gate
  const handle = await client.workflow.start('missionWorkflow', {
    workflowId: missionId, taskQueue, args: [{missionId}],
  })
  try {
    await Promise.race([
      gate.entered.promise,
      delay(15_000, undefined, {ref: false}).then(() => { throw new Error('synthetic task never reached collection gate') }),
    ])
    await handle.cancel()
    await assert.rejects(handle.result(), error => error instanceof Error && error.cause instanceof CancelledFailure)
    assert.deepEqual(state.dispatched, [`${missionId}:root`, `${missionId}:child-a`])
    assert.deepEqual(state.states, ['RUNNING'])
    assert.deepEqual(state.canceled, [])
  } finally {
    gate.release.resolve()
    if ((await handle.describe()).status.name === 'RUNNING') await handle.terminate('synthetic test cleanup')
  }
})

test('pre-patch synthetic multiple-followup history still replays without its missing sibling being scheduled', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/mission-followups-legacy.json', import.meta.url), 'utf8'))
  const history = proto.temporal.api.history.v1.History.fromObject(fixture)
  assert.equal(history.events.length, 113)
  await Worker.runReplayHistory({workflowsPath: resolve('workflows/mission.workflow.ts')}, history)
})
