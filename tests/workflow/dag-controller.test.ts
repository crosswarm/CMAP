import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryStore } from '#domain-model'
import type {
  AcceptanceCriterion,
  Artifact,
  EventActor,
  Mission,
  ProgressSnapshot,
  ReviewDecisionV1,
  Store,
  TaskRecord,
  TaskResultV1,
} from '#domain-model'
import type { MissionPlanV1 } from '../../packages/domain-model/src/generated/mission-plan.ts'
import { createDagActivities } from '../../workflows/dag-activities.ts'

const ACTOR: EventActor = { type: 'system', id: 'dag-controller-test' }
const T0 = '2026-09-21T00:00:00.000Z'

const acceptance: readonly AcceptanceCriterion[] = [
  { criterion_id: 'A', metric: 'ok_a', operator: 'eq', expected: true, hard_gate: true },
  { criterion_id: 'B', metric: 'ok_b', operator: 'eq', expected: true, hard_gate: true },
]

const plan = (risk: 'read-meta' | 'controlled' = 'read-meta'): MissionPlanV1 => ({
  schema: 'cmap/mission-plan/v1',
  concurrency: 2,
  nodes: [
    {
      node_id: 'rootA',
      goal: 'produce A',
      capability: 'code.analyze',
      deps: [],
      criterion_ids: ['A'],
      risk_level: risk,
    },
    {
      node_id: 'rootB',
      goal: 'produce B',
      capability: 'code.analyze',
      deps: [],
      criterion_ids: ['B'],
      risk_level: 'read-meta',
    },
  ],
})

const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')

const mission = (
  id: string,
  opts: {
    maxAdditionalCycles?: number
    rootRisk?: 'read-meta' | 'controlled'
    state?: Mission['state']
    plan?: MissionPlanV1
    acceptance?: readonly AcceptanceCriterion[]
  } = {},
): Mission => ({
  id,
  tenant: 'team-ycc',
  owner: 'crosswarm',
  type: 'inspect',
  goal: 'DAG mission',
  constraints: {
    risk_level: 'controlled',
    max_additional_cycles: opts.maxAdditionalCycles ?? 2,
    plan: opts.plan ?? plan(opts.rootRisk ?? 'read-meta'),
  },
  acceptance: opts.acceptance ?? acceptance,
  workflow_template: 'dag/v1',
  state: opts.state ?? 'DRAFT',
  revision: 1,
  created_at: T0,
  updated_at: T0,
})

const artifact = (missionId: string, taskId: string, artifactId: string, bytes: string): Artifact => ({
  artifact_id: artifactId,
  mission_id: missionId,
  task_id: taskId,
  role: 'report',
  uri: 'evidence/report.txt',
  media_type: 'text/plain',
  size_bytes: Buffer.byteLength(bytes),
  sha256: sha(bytes),
  version: 1,
  state: 'AVAILABLE',
  producer: { agent_id: 'fake', adapter_version: 'v1', execution_session_id: taskId },
  provenance: {},
  retention: { retain_until: '2027-09-21T00:00:00.000Z', immutable: true },
  security: { classification: 'internal', contains_secrets: false, contains_pii: false, allowed_roles: [] },
  created_at: T0,
})

const result = (
  missionId: string,
  taskId: string,
  attempt: number,
  criterionId: string,
  passed = true,
  bytes = `${taskId}-bytes`,
): TaskResultV1 => {
  const artifactId = `${taskId}-artifact`
  return {
    schema: 'cmap/task-result/v1',
    mission_id: missionId,
    task_id: taskId,
    attempt,
    status: passed ? 'completed' : 'failed',
    summary: passed ? 'done' : 'failed',
    criterion_results: [
      { criterion_id: criterionId, actual: passed, passed, evidence_artifact_ids: [artifactId] },
    ],
    artifacts: [
      { artifact_id: artifactId, role: 'report', uri: 'evidence/report.txt', sha256: sha(bytes), size_bytes: Buffer.byteLength(bytes) },
    ],
    ...(passed ? {} : { error: { code: 'FAILED', message: 'failed', retryable: false, fingerprint: 'same-error' } }),
  }
}

const make = async (m: Mission) => {
  const store = new MemoryStore()
  await store.createMission({ mission: m, actor: ACTOR })
  const workRoot = await mkdtemp(join(tmpdir(), 'cmap-dag-controller-'))
  return { store, workRoot, acts: createDagActivities({ store, workRoot, pollIntervalMs: 1, approvalWaitTimeoutMs: 1 }) }
}

const toRunning = async (store: Store, taskId: string): Promise<void> => {
  await store.transitionTask({ taskId, to: 'READY', actor: ACTOR, eventType: 'TASK_READY', idempotencyKey: `${taskId}:ready` })
  await store.transitionTask({ taskId, to: 'QUEUED', actor: ACTOR, eventType: 'TASK_ASSIGNED', idempotencyKey: `${taskId}:queued` })
  await store.transitionTask({ taskId, to: 'RUNNING', actor: ACTOR, eventType: 'TASK_STARTED', idempotencyKey: `${taskId}:running` })
}

const completeNode = async (
  store: Store,
  task: TaskRecord,
  criterionId: string,
  passed = true,
): Promise<void> => {
  const r = result(task.mission_id, task.id, task.attempt, criterionId, passed)
  await store.setTaskResult(task.id, r)
  for (const art of r.artifacts) {
    await store.putArtifact(artifact(task.mission_id, task.id, art.artifact_id, `${task.id}-bytes`))
  }
}

const explicitRework = (missionId: string, taskId: string, followups = 1): ReviewDecisionV1 => ({
  schema: 'cmap/review-decision/v1',
  mission_id: missionId,
  reviewed_task_ids: [taskId],
  decision: 'rework',
  hard_gate_summary: { total: 1, passed: 0, failed: 1 },
  failed_criteria: [{ criterion_id: 'A', expected: 'true', actual: 'false', reason: 'not done' }],
  required_followups: Array.from({ length: followups }, () => ({ capability: 'code.analyze', task_type: 'inspect' })),
  stop_conditions: { max_additional_cycles: 2 },
  review_confidence: { level: 'high' },
})

describe('DAG controller activities', () => {
  test('loadDagSchedule validates plan and does not reopen terminal mission', async () => {
    const { store, acts } = await make(mission('mis-schedule', { state: 'COMPLETED' }))
    const out = await acts.loadDagSchedule('mis-schedule')
    assert.equal(out.state, 'COMPLETED')
    assert.equal((await store.getMission('mis-schedule'))?.state, 'COMPLETED')
    assert.deepEqual(out.nodes, [{ node_id: 'rootA', deps: [] }, { node_id: 'rootB', deps: [] }])
  })

  test('loadDagSchedule validates attempt budget before mutating Mission to RUNNING', async () => {
    const m = mission('mis-bad-budget', { maxAdditionalCycles: -1 })
    const { store, acts } = await make(m)

    await assert.rejects(() => acts.loadDagSchedule(m.id), /invalid attempt budget/)
    assert.equal((await store.getMission(m.id))?.state, 'DRAFT')
  })

  test('early finalize refuses while another planned node lacks proof', async () => {
    const m = mission('mis-early')
    const { store, acts } = await make(m)
    const { taskId } = await acts.materializeDagNode({ missionId: m.id, nodeId: 'rootA', attempt: 1, acceptedDeps: {} })
    await toRunning(store, taskId)
    await completeNode(store, (await store.getTask(taskId))!, 'A')
    assert.equal((await acts.reviewDagAttempt({ taskId })).status, 'accepted')

    await assert.rejects(() => acts.finalizeDagMission(m.id), /missing terminal proof/)
  })

  test('fatal node blocks every unstarted node, including independent work after global stop', async () => {
    const m = mission('mis-fatal-global')
    const { acts } = await make(m)

    await acts.finishDagNode({ missionId: m.id, nodeId: 'rootA', status: 'failed', reason: 'NODE_FAILED' })
    const out = await acts.finalizeDagMission(m.id)

    assert.equal(out.state, 'FAILED')
    assert.deepEqual(out.blockedNodeIds, ['rootB'])
    assert.deepEqual(
      out.nodeOutcomes.map((o) => [o.nodeId, o.status, o.reason ?? null]),
      [['rootA', 'failed', 'NODE_FAILED'], ['rootB', 'failed', 'GLOBAL_STOP']],
    )
  })

  test('blocked propagation is independent of plan order', async () => {
    const reversedPlan: MissionPlanV1 = {
      schema: 'cmap/mission-plan/v1',
      concurrency: 2,
      nodes: [
        {
          node_id: 'grandchild',
          goal: 'grandchild',
          capability: 'code.analyze',
          deps: ['child'],
          criterion_ids: ['C'],
          risk_level: 'read-meta',
        },
        {
          node_id: 'child',
          goal: 'child',
          capability: 'code.analyze',
          deps: ['parent'],
          criterion_ids: ['B'],
          risk_level: 'read-meta',
        },
        {
          node_id: 'parent',
          goal: 'parent',
          capability: 'code.analyze',
          deps: [],
          criterion_ids: ['A'],
          risk_level: 'read-meta',
        },
      ],
    }
    const m = mission('mis-order-independent', {
      plan: reversedPlan,
      acceptance: [...acceptance, { criterion_id: 'C', metric: 'ok_c', operator: 'eq', expected: true, hard_gate: true }],
    })
    const { acts } = await make(m)

    await acts.finishDagNode({ missionId: m.id, nodeId: 'parent', status: 'failed', reason: 'NODE_FAILED' })
    const out = await acts.finalizeDagMission(m.id)

    assert.equal(out.state, 'FAILED')
    assert.deepEqual(out.blockedNodeIds, ['grandchild', 'child'])
    assert.deepEqual(
      out.nodeOutcomes.map((o) => [o.nodeId, o.status, o.reason ?? null]),
      [['parent', 'failed', 'NODE_FAILED'], ['grandchild', 'failed', 'UPSTREAM_TERMINAL'], ['child', 'failed', 'UPSTREAM_TERMINAL']],
    )
  })

  test('accepted proof finalizes only from stored review, artifact, and receipt evidence', async () => {
    const m = mission('mis-success')
    const { store, acts } = await make(m)
    for (const [nodeId, criterionId] of [['rootA', 'A'], ['rootB', 'B']] as const) {
      const { taskId } = await acts.materializeDagNode({ missionId: m.id, nodeId, attempt: 1, acceptedDeps: {} })
      await toRunning(store, taskId)
      await completeNode(store, (await store.getTask(taskId))!, criterionId)
      assert.equal((await acts.reviewDagAttempt({ taskId })).status, 'accepted')
    }

    const out = await acts.finalizeDagMission(m.id)
    assert.equal(out.state, 'COMPLETED')
    assert.equal((await store.getMission(m.id))?.state, 'COMPLETED')
    assert.deepEqual(out.nodeOutcomes.map((o) => o.status), ['accepted', 'accepted'])
  })

  test('node review never writes a global terminal mission state', async () => {
    const m = mission('mis-node-local')
    const { store, acts } = await make(m)
    await acts.loadDagSchedule(m.id)
    const { taskId } = await acts.materializeDagNode({ missionId: m.id, nodeId: 'rootA', attempt: 1, acceptedDeps: {} })
    await toRunning(store, taskId)
    await completeNode(store, (await store.getTask(taskId))!, 'A')

    await acts.reviewDagAttempt({ taskId })
    assert.equal((await store.getMission(m.id))?.state, 'RUNNING')
  })

  test('budget zero and no-progress rework escalate the node only', async () => {
    const budget = mission('mis-budget-zero', { maxAdditionalCycles: 0 })
    const a = await make(budget)
    const first = await a.acts.materializeDagNode({ missionId: budget.id, nodeId: 'rootA', attempt: 1, acceptedDeps: {} })
    await toRunning(a.store, first.taskId)
    await completeNode(a.store, (await a.store.getTask(first.taskId))!, 'A', false)
    assert.deepEqual(
      await a.acts.reviewDagAttempt({ taskId: first.taskId }),
      {
        status: 'escalated',
        nodeId: 'rootA',
        taskId: first.taskId,
        attempt: 1,
        progress: {
          patchHash: sha(sha(`${first.taskId}-bytes`)),
          failedCriteriaIds: ['A'],
          metricValue: 0,
          errorFingerprint: 'same-error',
        },
        reason: 'BUDGET_EXHAUSTED',
      },
    )
    assert.equal((await a.store.getMission(budget.id))?.state, 'DRAFT')

    const noProgress = mission('mis-no-progress')
    const b = await make(noProgress)
    const second = await b.acts.materializeDagNode({ missionId: noProgress.id, nodeId: 'rootA', attempt: 1, acceptedDeps: {} })
    await toRunning(b.store, second.taskId)
    await completeNode(b.store, (await b.store.getTask(second.taskId))!, 'A', false)
    const prev: ProgressSnapshot = {
      patchHash: sha(sha(`${second.taskId}-bytes`)),
      failedCriteriaIds: ['A'],
      metricValue: 0,
      errorFingerprint: 'same-error',
    }
    assert.equal((await b.acts.reviewDagAttempt({ taskId: second.taskId, previousProgress: prev })).reason, 'NO_PROGRESS')
  })

  test('multi-followup rework is rejected before successor task creation', async () => {
    const m = mission('mis-followups')
    const { store, acts } = await make(m)
    const { taskId } = await acts.materializeDagNode({ missionId: m.id, nodeId: 'rootA', attempt: 1, acceptedDeps: {} })
    await toRunning(store, taskId)
    await completeNode(store, (await store.getTask(taskId))!, 'A', false)

    await assert.rejects(
      () => acts.reviewDagAttempt({ taskId, decision: explicitRework(m.id, taskId, 2) }),
      /exactly one required_followup/,
    )
    assert.equal((await store.queryTasks({ missionId: m.id })).length, 1)
  })

  test('review replay is idempotent', async () => {
    const m = mission('mis-replay')
    const { store, acts } = await make(m)
    const { taskId } = await acts.materializeDagNode({ missionId: m.id, nodeId: 'rootA', attempt: 1, acceptedDeps: {} })
    await toRunning(store, taskId)
    await completeNode(store, (await store.getTask(taskId))!, 'A')

    assert.equal((await acts.reviewDagAttempt({ taskId })).status, 'accepted')
    assert.equal((await acts.reviewDagAttempt({ taskId })).status, 'accepted')
    assert.equal((await store.listReviews(m.id)).length, 1)
    assert.equal((await store.listEvents(m.id)).filter((e) => e.event_type === 'DAG_NODE_FINISHED').length, 1)
  })

  test('rework review retry repairs task transitions and preserves recomputed progress', async () => {
    const m = mission('mis-rework-retry')
    const { store, acts } = await make(m)
    const { taskId } = await acts.materializeDagNode({ missionId: m.id, nodeId: 'rootA', attempt: 1, acceptedDeps: {} })
    await toRunning(store, taskId)
    await completeNode(store, (await store.getTask(taskId))!, 'A', false)
    await store.transitionTask({
      taskId,
      to: 'VERIFYING',
      actor: ACTOR,
      eventType: 'HARD_GATE_EVALUATED',
      idempotencyKey: `${taskId}:verifying-for-retry`,
    })
    await store.putReview({
      id: `dagrev:${taskId}:0`,
      mission_id: m.id,
      reviewed_task_ids: [taskId],
      round: 0,
      decision: explicitRework(m.id, taskId),
      created_at: T0,
    })

    const out = await acts.reviewDagAttempt({ taskId })

    assert.equal(out.status, 'rework')
    assert.equal((await store.getTask(taskId))?.state, 'COMPLETED')
    assert.deepEqual(out.progress, {
      patchHash: sha(sha(`${taskId}-bytes`)),
      failedCriteriaIds: ['A'],
      metricValue: 0,
      errorFingerprint: 'same-error',
    })
  })


  test('rework review retry still applies budget escalation when receipt is missing', async () => {
    const m = mission('mis-rework-budget-retry', { maxAdditionalCycles: 0 })
    const { store, acts } = await make(m)
    const { taskId } = await acts.materializeDagNode({ missionId: m.id, nodeId: 'rootA', attempt: 1, acceptedDeps: {} })
    await toRunning(store, taskId)
    await completeNode(store, (await store.getTask(taskId))!, 'A', false)
    await store.transitionTask({
      taskId,
      to: 'VERIFYING',
      actor: ACTOR,
      eventType: 'HARD_GATE_EVALUATED',
      idempotencyKey: `${taskId}:verifying-for-budget-retry`,
    })
    await store.putReview({
      id: `dagrev:${taskId}:0`,
      mission_id: m.id,
      reviewed_task_ids: [taskId],
      round: 0,
      decision: explicitRework(m.id, taskId),
      created_at: T0,
    })

    const out = await acts.reviewDagAttempt({ taskId })

    assert.equal(out.status, 'escalated')
    assert.equal(out.reason, 'BUDGET_EXHAUSTED')
    assert.equal((await store.getTask(taskId))?.state, 'FAILED_TERMINAL')
  })

  test('terminal node receipt is replayed before hard-gate evaluation', async () => {
    const m = mission('mis-terminal-first')
    const { acts } = await make(m)
    const { taskId } = await acts.materializeDagNode({ missionId: m.id, nodeId: 'rootA', attempt: 1, acceptedDeps: {} })

    await acts.finishDagNode({ missionId: m.id, nodeId: 'rootA', taskId, status: 'failed', reason: 'STOPPED' })
    assert.deepEqual(await acts.reviewDagAttempt({ taskId }), {
      status: 'failed',
      nodeId: 'rootA',
      taskId,
      reason: 'STOPPED',
    })
  })

  test('pending approval check returns immediately and stopped pending approval expires without grant', async () => {
    const m = mission('mis-approval', { rootRisk: 'controlled' })
    const { store, acts } = await make(m)
    const { taskId } = await acts.materializeDagNode({ missionId: m.id, nodeId: 'rootA', attempt: 1, acceptedDeps: {} })

    assert.deepEqual(await acts.checkDagApproval(taskId), { decision: 'pending' })
    const approval = (await store.listPendingApprovals(m.id))[0]!
    assert.equal((await store.getTask(taskId))?.state, 'APPROVAL_REQUIRED')

    await acts.finishDagNode({ missionId: m.id, nodeId: 'rootA', taskId, status: 'failed', reason: 'STOPPED' })
    const stopped = await store.getApproval(approval.id)
    assert.equal(stopped?.decision, 'expired')
    assert.equal(stopped?.decided_by, 'system:dag-stopped')
    assert.equal((await store.getTask(taskId))?.state, 'CANCELED')
  })

  test('caller-provided accept cannot manufacture success', async () => {
    const m = mission('mis-no-fake-success')
    const { store, acts } = await make(m)
    const { taskId } = await acts.materializeDagNode({ missionId: m.id, nodeId: 'rootA', attempt: 1, acceptedDeps: {} })
    await toRunning(store, taskId)
    await completeNode(store, (await store.getTask(taskId))!, 'A', false)
    const fakeAccept: ReviewDecisionV1 = {
      schema: 'cmap/review-decision/v1',
      mission_id: m.id,
      reviewed_task_ids: [taskId],
      decision: 'accept',
      hard_gate_summary: { total: 1, passed: 1, failed: 0 },
      review_confidence: { level: 'high' },
    }

    await assert.rejects(() => acts.reviewDagAttempt({ taskId, decision: fakeAccept }), /cannot override failed hard metrics/)
  })
})
