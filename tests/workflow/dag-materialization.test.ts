import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryStore } from '#domain-model'
import type {
  AcceptanceCriterion,
  Artifact,
  EventActor,
  Mission,
  Review,
  Store,
  TaskRecord,
  TaskResultV1,
} from '#domain-model'
import type { MissionPlanV1 } from '../../packages/domain-model/src/generated/mission-plan.ts'
import {
  acceptedDagAttempt,
  dagTaskId,
  dagAttemptSatisfiesNode,
  getDagMission,
  materializeDagNode,
} from '../../workflows/dag-materialization.ts'

const ACTOR: EventActor = { type: 'system', id: 'dag-materialization-test' }
const T0 = '2026-09-21T00:00:00.000Z'

const acceptance: readonly AcceptanceCriterion[] = [
  { criterion_id: 'A', metric: 'ok_a', operator: 'eq', expected: true, hard_gate: true },
  { criterion_id: 'B', metric: 'ok_b', operator: 'eq', expected: true, hard_gate: true },
  { criterion_id: 'C', metric: 'ok_c', operator: 'eq', expected: true, hard_gate: true },
]

const plan: MissionPlanV1 = {
  schema: 'cmap/mission-plan/v1',
  concurrency: 2,
  nodes: [
    {
      node_id: 'rootA',
      goal: 'produce A',
      capability: 'code.analyze',
      deps: [],
      criterion_ids: ['A'],
      risk_level: 'read-meta',
      required_resource_locks: [{ resource: 'device-A', ttl_seconds: 60 }],
      preferred_agent: 'codex',
      fallback_agents: ['kimi'],
    },
    {
      node_id: 'rootB',
      goal: 'produce B',
      capability: 'code.analyze',
      deps: [],
      criterion_ids: ['B'],
      risk_level: 'read-sensitive',
    },
    {
      node_id: 'join',
      goal: 'join parents',
      capability: 'code.modify',
      deps: ['rootA', 'rootB'],
      criterion_ids: ['C'],
      risk_level: 'controlled',
      required_resource_locks: [{ resource: 'device-C', ttl_seconds: 120 }],
      preferred_agent: 'codex',
    },
  ],
}

const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')

const mission = (id: string, overrides: Partial<Mission> = {}): Mission => ({
  id,
  tenant: 'team-ycc',
  owner: 'crosswarm',
  type: 'inspect',
  goal: 'DAG mission',
  constraints: { risk_level: 'mutating', max_additional_cycles: 2, plan },
  acceptance,
  workflow_template: 'dag/v1',
  state: 'RUNNING',
  revision: 1,
  created_at: T0,
  updated_at: T0,
  ...overrides,
})

const result = (
  missionId: string,
  taskId: string,
  attempt: number,
  criterionId: string,
  artifactId = `${taskId}-artifact`,
  artifactSha = sha(`${taskId}-bytes`),
  sizeBytes = Buffer.byteLength(`${taskId}-bytes`),
): TaskResultV1 => ({
  schema: 'cmap/task-result/v1',
  mission_id: missionId,
  task_id: taskId,
  attempt,
  status: 'completed',
  summary: 'done',
  criterion_results: [
    { criterion_id: criterionId, actual: true, passed: true, evidence_artifact_ids: [artifactId] },
  ],
  artifacts: [
    { artifact_id: artifactId, role: 'report', uri: 'evidence/report.txt', sha256: artifactSha, size_bytes: sizeBytes },
  ],
})

const review = (missionId: string, taskId: string, decision: 'accept' | 'rework' = 'accept'): Review => ({
  id: `${taskId}-review`,
  mission_id: missionId,
  reviewed_task_ids: [taskId],
  round: 1,
  decision: {
    schema: 'cmap/review-decision/v1',
    mission_id: missionId,
    reviewed_task_ids: [taskId],
    decision,
    hard_gate_summary: { total: 1, passed: decision === 'accept' ? 1 : 0, failed: decision === 'accept' ? 0 : 1 },
    ...(decision === 'rework'
      ? {
          failed_criteria: [{ criterion_id: 'A', expected: 'true', actual: 'false', reason: 'not enough' }],
          required_followups: [{ capability: 'code.analyze', task_type: 'inspect' }],
          stop_conditions: { max_additional_cycles: 1 },
        }
      : {}),
    review_confidence: { level: 'high' },
  },
  created_at: T0,
})

const createAcceptedNode = async (
  store: Store,
  m: Mission,
  nodeId: string,
  attempt = 1,
  opts: {
    decision?: 'accept' | 'rework' | null
    supersedesTaskId?: string
    taskId?: string
    resultArtifactId?: string
    resultArtifactSha?: string
    resultArtifactSize?: number
    putLedgerArtifact?: boolean
    ledgerState?: Artifact['state']
    ledgerRole?: string
    ledgerSha?: string
    ledgerSize?: number
  } = {},
): Promise<TaskRecord> => {
  const node = plan.nodes.find((n) => n.node_id === nodeId)!
  const taskId = opts.taskId ?? dagTaskId(m.id, nodeId, attempt)
  await materializeDagNode({
    store,
    workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-root-')),
  }, {
    missionId: m.id,
    nodeId,
    attempt,
    ...(opts.supersedesTaskId ? { supersedesTaskId: opts.supersedesTaskId } : {}),
    acceptedDeps: {},
  })
  const task = (await store.getTask(taskId))!
  await store.transitionTask({ taskId, to: 'READY', actor: ACTOR, eventType: 'TASK_READY', idempotencyKey: `${taskId}:ready` })
  await store.transitionTask({ taskId, to: 'QUEUED', actor: ACTOR, eventType: 'TASK_ASSIGNED', idempotencyKey: `${taskId}:queued` })
  await store.transitionTask({ taskId, to: 'RUNNING', actor: ACTOR, eventType: 'TASK_STARTED', idempotencyKey: `${taskId}:running` })
  await store.transitionTask({ taskId, to: 'VERIFYING', actor: ACTOR, eventType: 'HARD_GATE_EVALUATED', idempotencyKey: `${taskId}:verifying` })
  await store.transitionTask({ taskId, to: 'REVIEWING', actor: ACTOR, eventType: 'REVIEW_STARTED', idempotencyKey: `${taskId}:reviewing` })
  const artifactId = opts.resultArtifactId ?? `${taskId}-artifact`
  const artifactSha = opts.resultArtifactSha ?? sha(`${taskId}-bytes`)
  const artifactSize = opts.resultArtifactSize ?? Buffer.byteLength(`${taskId}-bytes`)
  await store.setTaskResult(taskId, result(m.id, taskId, attempt, node.criterion_ids[0]!, artifactId, artifactSha, artifactSize))
  if (opts.putLedgerArtifact) {
    await store.putArtifact({
      ...artifact(m.id, taskId, artifactId, opts.ledgerSha ?? artifactSha, opts.ledgerSize ?? artifactSize),
      role: opts.ledgerRole ?? 'report',
      state: opts.ledgerState ?? 'AVAILABLE',
    })
  }
  const decision = opts.decision === undefined ? 'accept' : opts.decision
  if (decision) await store.putReview(review(m.id, taskId, decision))
  if (decision === 'rework') {
    await store.transitionTask({ taskId, to: 'REWORK', actor: ACTOR, eventType: 'REVIEW_REWORK_REQUESTED', idempotencyKey: `${taskId}:rework` })
  }
  await store.transitionTask({ taskId, to: 'COMPLETED', actor: ACTOR, eventType: 'TASK_COMPLETED', idempotencyKey: `${taskId}:completed` })
  return task
}

const driveNodeToReworkComplete = async (
  store: Store,
  m: Mission,
  nodeId: string,
  attempt: number,
) => {
  const node = plan.nodes.find((n) => n.node_id === nodeId)!
  const taskId = dagTaskId(m.id, nodeId, attempt)
  await store.transitionTask({ taskId, to: 'READY', actor: ACTOR, eventType: 'TASK_READY', idempotencyKey: `${taskId}:late-ready` })
  await store.transitionTask({ taskId, to: 'QUEUED', actor: ACTOR, eventType: 'TASK_ASSIGNED', idempotencyKey: `${taskId}:late-queued` })
  await store.transitionTask({ taskId, to: 'RUNNING', actor: ACTOR, eventType: 'TASK_STARTED', idempotencyKey: `${taskId}:late-running` })
  await store.transitionTask({ taskId, to: 'VERIFYING', actor: ACTOR, eventType: 'HARD_GATE_EVALUATED', idempotencyKey: `${taskId}:late-verifying` })
  await store.transitionTask({ taskId, to: 'REVIEWING', actor: ACTOR, eventType: 'REVIEW_STARTED', idempotencyKey: `${taskId}:late-reviewing` })
  await store.setTaskResult(taskId, result(m.id, taskId, attempt, node.criterion_ids[0]!))
  await store.putReview(review(m.id, taskId, 'rework'))
  await store.transitionTask({ taskId, to: 'REWORK', actor: ACTOR, eventType: 'REVIEW_REWORK_REQUESTED', idempotencyKey: `${taskId}:late-rework` })
  await store.transitionTask({ taskId, to: 'COMPLETED', actor: ACTOR, eventType: 'TASK_COMPLETED', idempotencyKey: `${taskId}:late-completed` })
}

describe('DAG materialization', () => {
  test('materializes frozen YonWork permission and policy without inventing approval', async () => {
    const store=new MemoryStore()
    const yonPlan={...plan,nodes:plan.nodes.map(n=>n.node_id==='rootA'?{...n,capability:'yonwork.validate',risk_level:'controlled' as const,preferred_agent:'yonwork:cmap-test',fallback_agents:[],required_resource_locks:[{resource:'yonwork:host',ttl_seconds:15}],yonwork:{chat_send:true as const,policy_sha256:'a'.repeat(64)}}:n)}
    const m=mission('mis-yonwork-materialize',{constraints:{risk_level:'mutating',max_additional_cycles:1,plan:yonPlan}})
    await store.createMission({mission:m,actor:ACTOR})
    const {taskId}=await materializeDagNode({store,workRoot:await mkdtemp(join(tmpdir(),'cmap-yon-'))},{missionId:m.id,nodeId:'rootA',attempt:1,acceptedDeps:{}})
    const task=(await store.getTask(taskId))!
    assert.equal(task.envelope.permissions.yonwork?.chat_send,true)
    assert.equal(task.envelope.inputs?.parameters?.['yonwork_policy_sha256'],'a'.repeat(64))
    assert.equal(task.state,'DRAFT')
    assert.equal((await store.listPendingApprovals(m.id)).length,0)
    const completed={...task,result:result(m.id,taskId,1,'A')}
    assert.equal(dagAttemptSatisfiesNode(m,yonPlan.nodes[0]!,completed),true)
    assert.equal(dagAttemptSatisfiesNode(m,yonPlan.nodes[0]!,{...completed,envelope:{...task.envelope,permissions:{forbidden:[]}}}),false)
    assert.equal(dagAttemptSatisfiesNode(m,yonPlan.nodes[0]!,{...completed,envelope:{...task.envelope,inputs:{parameters:{yonwork_policy_sha256:'b'.repeat(64)}}}}),false)
  })

  test('rejects a parent task directory redirected outside the work root', async () => {
    const store = new MemoryStore(), m = mission('mis-parent-symlink')
    await store.createMission({mission:m, actor:ACTOR})
    const workRoot = await mkdtemp(join(tmpdir(),'cmap-dag-'))
    const outside = await mkdtemp(join(tmpdir(),'cmap-dag-outside-'))
    const acceptedDeps: Record<string,string> = {}
    for (const nodeId of ['rootA','rootB']) {
      const id = dagTaskId(m.id,nodeId,1)
      acceptedDeps[nodeId] = id
      await createAcceptedNode(store,m,nodeId,1,{resultArtifactId:id+'-artifact', resultArtifactSha:sha('data'),resultArtifactSize:4,putLedgerArtifact:true})
      await seedParentArtifact(store,workRoot,m.id,id,id+'-artifact','data')
    }
    await rename(join(workRoot,acceptedDeps['rootA']!),join(outside,'redirected'))
    await symlink(join(outside,'redirected'),join(workRoot,acceptedDeps['rootA']!))
    await assert.rejects(()=>materializeDagNode({store,workRoot},{missionId:m.id,nodeId:'join',attempt:1,acceptedDeps}), /parent.*(?:symlink|unsafe|escape)/i)
  })

  test('loads a dag/v1 mission and materializes valid root and join nodes', async () => {
    const store = new MemoryStore()
    const m = mission('mis-dag-valid')
    await store.createMission({ mission: m, actor: ACTOR })
    const workRoot = await mkdtemp(join(tmpdir(), 'cmap-dag-'))

    const root = await materializeDagNode({ store, workRoot }, {
      missionId: m.id,
      nodeId: 'rootA',
      attempt: 1,
      acceptedDeps: {},
    })
    assert.equal(root.taskId, dagTaskId(m.id, 'rootA', 1))
    assert.deepEqual((await getDagMission(store, m.id)).plan.nodes.map((n) => n.node_id), ['rootA', 'rootB', 'join'])

    const parentA = dagTaskId(m.id, 'rootA', 1)
    const parentB = dagTaskId(m.id, 'rootB', 1)
    const bytesA = Buffer.from('rootA-bytes')
    const bytesB = Buffer.from('rootB-bytes')
    await createAcceptedNode(store, m, 'rootA', 1, {
      resultArtifactId: 'art-A',
      resultArtifactSha: sha(bytesA),
      resultArtifactSize: bytesA.byteLength,
      putLedgerArtifact: true,
    })
    await createAcceptedNode(store, m, 'rootB', 1, {
      resultArtifactId: 'art-B',
      resultArtifactSha: sha(bytesB),
      resultArtifactSize: bytesB.byteLength,
      putLedgerArtifact: true,
    })
    await mkdir(join(workRoot, parentA, 'evidence'), { recursive: true })
    await mkdir(join(workRoot, parentB, 'evidence'), { recursive: true })
    await writeFile(join(workRoot, parentA, 'evidence/report.txt'), bytesA)
    await writeFile(join(workRoot, parentB, 'evidence/report.txt'), bytesB)

    const joinNode = await materializeDagNode({ store, workRoot }, {
      missionId: m.id,
      nodeId: 'join',
      attempt: 1,
      acceptedDeps: { rootB: parentB, rootA: parentA },
    })
    const task = (await store.getTask(joinNode.taskId))!
    assert.deepEqual(task.deps, [parentA, parentB])
    assert.equal(task.envelope.identity.plan_node_id, 'join')
    assert.equal(task.envelope.classification.risk_level, 'controlled')
    assert.equal(task.envelope.execution_policy.preferred_agent, 'codex')
    assert.deepEqual(task.envelope.execution_policy.required_resource_locks, [{ resource: 'device-C', ttl_seconds: 120 }])
    assert.deepEqual(task.envelope.goal.success_definition.map((c) => c.criterion_id), ['C'])
    assert.deepEqual(task.envelope.inputs?.artifact_refs?.map((a) => [a.artifact_id, a.role, a.sha256]), [
      ['art-A', 'report', sha(bytesA)],
      ['art-B', 'report', sha(bytesB)],
    ])
    for (const ref of task.envelope.inputs?.artifact_refs ?? []) {
      assert.equal((await readFile(join(workRoot, joinNode.taskId, ref.uri!))).toString(), ref.artifact_id === 'art-A' ? 'rootA-bytes' : 'rootB-bytes')
    }
  })

  test('retry and concurrent materialization preserve one task and identical input bytes', async () => {
    const store = new MemoryStore()
    const m = mission('mis-dag-retry')
    await store.createMission({ mission: m, actor: ACTOR })
    const workRoot = await mkdtemp(join(tmpdir(), 'cmap-dag-'))
    const parentA = dagTaskId(m.id, 'rootA', 1)
    const parentB = dagTaskId(m.id, 'rootB', 1)
    await createAcceptedNode(store, m, 'rootA', 1, {
      resultArtifactId: 'art-A',
      resultArtifactSha: sha('same-A'),
      resultArtifactSize: Buffer.byteLength('same-A'),
      putLedgerArtifact: true,
    })
    await createAcceptedNode(store, m, 'rootB', 1, {
      resultArtifactId: 'art-B',
      resultArtifactSha: sha('same-B'),
      resultArtifactSize: Buffer.byteLength('same-B'),
      putLedgerArtifact: true,
    })
    await seedParentArtifact(store, workRoot, m.id, parentA, 'art-A', 'same-A')
    await seedParentArtifact(store, workRoot, m.id, parentB, 'art-B', 'same-B')

    const input = { missionId: m.id, nodeId: 'join', attempt: 1, acceptedDeps: { rootA: parentA, rootB: parentB } }
    const out = await Promise.all(Array.from({ length: 4 }, () => materializeDagNode({ store, workRoot }, input)))
    assert.deepEqual(out.map((o) => o.taskId), Array(4).fill(dagTaskId(m.id, 'join', 1)))
    assert.equal((await store.queryTasks({ missionId: m.id })).filter((t) => t.envelope.identity.plan_node_id === 'join').length, 1)

    const task = (await store.getTask(out[0]!.taskId))!
    await writeFile(join(workRoot, task.id, task.envelope.inputs!.artifact_refs![0]!.uri!), 'different')
    await assert.rejects(() => materializeDagNode({ store, workRoot }, input), /input conflict/i)
  })

  test('rejects parent completed without exact accept review', async () => {
    const store = new MemoryStore()
    const m = mission('mis-dag-no-accept')
    await store.createMission({ mission: m, actor: ACTOR })
    await createAcceptedNode(store, m, 'rootA', 1, { decision: null })

    assert.equal(await acceptedDagAttempt(store, m, plan.nodes[0]!, dagTaskId(m.id, 'rootA', 1)), false)
    await assert.rejects(
      () => materializeDagNode({ store, workRoot: tmpdir() }, {
        missionId: m.id,
        nodeId: 'join',
        attempt: 1,
        acceptedDeps: { rootA: dagTaskId(m.id, 'rootA', 1), rootB: 'missing' },
      }),
      /accepted dependency/i,
    )
  })

  test('accepted attempt requires available matching artifact registry rows', async () => {
    const store = new MemoryStore()

    const noLedger = mission('mis-dag-registry-missing')
    await store.createMission({ mission: noLedger, actor: ACTOR })
    await createAcceptedNode(store, noLedger, 'rootA')
    const noLedgerTask = (await store.getTask(dagTaskId(noLedger.id, 'rootA', 1)))!
    assert.equal(dagAttemptSatisfiesNode(noLedger, plan.nodes[0]!, noLedgerTask), true)
    assert.equal(await acceptedDagAttempt(store, noLedger, plan.nodes[0]!, noLedgerTask.id), false)

    const expired = mission('mis-dag-registry-expired')
    await store.createMission({ mission: expired, actor: ACTOR })
    await createAcceptedNode(store, expired, 'rootA', 1, {
      putLedgerArtifact: true,
      ledgerState: 'EXPIRED',
    })
    assert.equal(await acceptedDagAttempt(store, expired, plan.nodes[0]!, dagTaskId(expired.id, 'rootA', 1)), false)

    const mismatch = mission('mis-dag-registry-mismatch')
    await store.createMission({ mission: mismatch, actor: ACTOR })
    await createAcceptedNode(store, mismatch, 'rootA', 1, {
      putLedgerArtifact: true,
      ledgerSha: sha('different'),
    })
    assert.equal(await acceptedDagAttempt(store, mismatch, plan.nodes[0]!, dagTaskId(mismatch.id, 'rootA', 1)), false)

    const wrongRole = mission('mis-dag-registry-role')
    await store.createMission({ mission: wrongRole, actor: ACTOR })
    await createAcceptedNode(store, wrongRole, 'rootA', 1, {
      putLedgerArtifact: true,
      ledgerRole: 'trace',
    })
    assert.equal(await acceptedDagAttempt(store, wrongRole, plan.nodes[0]!, dagTaskId(wrongRole.id, 'rootA', 1)), false)
  })

  test('uses the reworked final parent and rejects the old completed attempt', async () => {
    const store = new MemoryStore()
    const m = mission('mis-dag-rework')
    await store.createMission({ mission: m, actor: ACTOR })
    await createAcceptedNode(store, m, 'rootA', 1, { decision: 'rework' })
    await createAcceptedNode(store, m, 'rootA', 2, {
      supersedesTaskId: dagTaskId(m.id, 'rootA', 1),
      putLedgerArtifact: true,
    })

    assert.equal(await acceptedDagAttempt(store, m, plan.nodes[0]!, dagTaskId(m.id, 'rootA', 1)), false)
    assert.equal(await acceptedDagAttempt(store, m, plan.nodes[0]!, dagTaskId(m.id, 'rootA', 2)), true)
  })

  test('successor attempt preserves node fields and requires the prior same-node attempt', async () => {
    const store = new MemoryStore()
    const m = mission('mis-dag-successor')
    await store.createMission({ mission: m, actor: ACTOR })

    await assert.rejects(
      () => materializeDagNode({ store, workRoot: tmpdir() }, {
        missionId: m.id,
        nodeId: 'rootA',
        attempt: 2,
        acceptedDeps: {},
      }),
      /supersedes/i,
    )

    await materializeDagNode({ store, workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-')) }, {
      missionId: m.id,
      nodeId: 'rootA',
      attempt: 1,
      acceptedDeps: {},
    })
    await assert.rejects(
      async () => materializeDagNode({ store, workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-')) }, {
        missionId: m.id,
        nodeId: 'rootA',
        attempt: 2,
        supersedesTaskId: dagTaskId(m.id, 'rootA', 1),
        acceptedDeps: {},
      }),
      /rework/i,
    )
    await driveNodeToReworkComplete(store, m, 'rootA', 1)
    const out = await materializeDagNode({ store, workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-')) }, {
      missionId: m.id,
      nodeId: 'rootA',
      attempt: 2,
      supersedesTaskId: dagTaskId(m.id, 'rootA', 1),
      acceptedDeps: {},
    })
    const task = (await store.getTask(out.taskId))!
    assert.equal(task.attempt, 2)
    assert.equal(task.supersedes_task_id, dagTaskId(m.id, 'rootA', 1))
    assert.equal(task.envelope.identity.revision, 2)
    assert.deepEqual(task.envelope.execution_policy.required_resource_locks, [{ resource: 'device-A', ttl_seconds: 60 }])
    assert.deepEqual(task.envelope.execution_policy.fallback_agents, ['kimi'])

    const budgeted = mission('mis-dag-budget', { constraints: { risk_level: 'mutating', max_additional_cycles: 0, plan } })
    await store.createMission({ mission: budgeted, actor: ACTOR })
    await assert.rejects(
      async () => materializeDagNode({ store, workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-')) }, {
        missionId: budgeted.id,
        nodeId: 'rootA',
        attempt: 2,
        supersedesTaskId: dagTaskId(budgeted.id, 'rootA', 1),
        acceptedDeps: {},
      }),
      /budget/i,
    )
  })

  test('rejects missing risk ceiling and strict accepted-attempt metadata mismatches', async () => {
    const store = new MemoryStore()
    const missingCeiling = mission('mis-dag-no-risk', { constraints: { max_additional_cycles: 2, plan } })
    await store.createMission({ mission: missingCeiling, actor: ACTOR })
    await assert.rejects(() => getDagMission(store, missingCeiling.id), /risk_level/i)

    const m = mission('mis-dag-metadata')
    await store.createMission({ mission: m, actor: ACTOR })
    await materializeDagNode({ store, workRoot: await mkdtemp(join(tmpdir(), 'cmap-dag-')) }, {
      missionId: m.id,
      nodeId: 'rootA',
      attempt: 1,
      acceptedDeps: {},
    })
    const taskId = dagTaskId(m.id, 'rootA', 1)
    const task = (await store.getTask(taskId))!
    const badTaskId = `${taskId}_bad`
    await store.createTask({
      task: {
        ...task,
        id: badTaskId,
        envelope: {
          ...task.envelope,
          identity: { ...task.envelope.identity, task_id: taskId, revision: 99 },
        },
        result: result(m.id, badTaskId, 1, 'A'),
      },
      actor: ACTOR,
    })
    await store.transitionTask({ taskId: badTaskId, to: 'READY', actor: ACTOR, eventType: 'TASK_READY', idempotencyKey: `${badTaskId}:ready` })
    await store.transitionTask({ taskId: badTaskId, to: 'QUEUED', actor: ACTOR, eventType: 'TASK_ASSIGNED', idempotencyKey: `${badTaskId}:queued` })
    await store.transitionTask({ taskId: badTaskId, to: 'RUNNING', actor: ACTOR, eventType: 'TASK_STARTED', idempotencyKey: `${badTaskId}:running` })
    await store.transitionTask({ taskId: badTaskId, to: 'VERIFYING', actor: ACTOR, eventType: 'HARD_GATE_EVALUATED', idempotencyKey: `${badTaskId}:verifying` })
    await store.transitionTask({ taskId: badTaskId, to: 'REVIEWING', actor: ACTOR, eventType: 'REVIEW_STARTED', idempotencyKey: `${badTaskId}:reviewing` })
    await store.putReview(review(m.id, badTaskId))
    await store.transitionTask({ taskId: badTaskId, to: 'COMPLETED', actor: ACTOR, eventType: 'TASK_COMPLETED', idempotencyKey: `${badTaskId}:completed` })

    assert.equal(await acceptedDagAttempt(store, m, plan.nodes[0]!, badTaskId), false)
  })

  test('rejects tampered source artifacts, target symlinks, and dependency key mismatches', async () => {
    const store = new MemoryStore()
    const m = mission('mis-dag-tamper')
    await store.createMission({ mission: m, actor: ACTOR })
    const workRoot = await mkdtemp(join(tmpdir(), 'cmap-dag-'))
    const parentA = dagTaskId(m.id, 'rootA', 1)
    const parentB = dagTaskId(m.id, 'rootB', 1)
    await createAcceptedNode(store, m, 'rootA', 1, {
      resultArtifactId: 'art-A',
      resultArtifactSha: sha('declared-A'),
      resultArtifactSize: Buffer.byteLength('actual-A'),
      putLedgerArtifact: true,
    })
    await createAcceptedNode(store, m, 'rootB', 1, {
      resultArtifactId: 'art-B',
      resultArtifactSha: sha('actual-B'),
      resultArtifactSize: Buffer.byteLength('actual-B'),
      putLedgerArtifact: true,
    })
    await seedParentArtifact(store, workRoot, m.id, parentA, 'art-A', 'actual-A', sha('declared-A'))
    await seedParentArtifact(store, workRoot, m.id, parentB, 'art-B', 'actual-B')

    await assert.rejects(
      () => materializeDagNode({ store, workRoot }, {
        missionId: m.id,
        nodeId: 'join',
        attempt: 1,
        acceptedDeps: { rootA: parentA, rootB: parentB },
      }),
      /HASH_MISMATCH|哈希不符/,
    )

    const symlinkStore = new MemoryStore()
    const symlinkMission = mission('mis-dag-symlink')
    await symlinkStore.createMission({ mission: symlinkMission, actor: ACTOR })
    const cleanRoot = await mkdtemp(join(tmpdir(), 'cmap-dag-'))
    const symlinkParentA = dagTaskId(symlinkMission.id, 'rootA', 1)
    const symlinkParentB = dagTaskId(symlinkMission.id, 'rootB', 1)
    await createAcceptedNode(symlinkStore, symlinkMission, 'rootA', 1, {
      resultArtifactId: 'art-A',
      resultArtifactSha: sha('actual-A'),
      resultArtifactSize: Buffer.byteLength('actual-A'),
      putLedgerArtifact: true,
    })
    await createAcceptedNode(symlinkStore, symlinkMission, 'rootB', 1, {
      resultArtifactId: 'art-B',
      resultArtifactSha: sha('actual-B'),
      resultArtifactSize: Buffer.byteLength('actual-B'),
      putLedgerArtifact: true,
    })
    await seedParentArtifact(symlinkStore, cleanRoot, symlinkMission.id, symlinkParentA, 'art-A', 'actual-A')
    await seedParentArtifact(symlinkStore, cleanRoot, symlinkMission.id, symlinkParentB, 'art-B', 'actual-B')
    const childId = dagTaskId(symlinkMission.id, 'join', 1)
    const targetDir = join(cleanRoot, childId, 'inputs', 'rootA', sha('art-A'))
    await mkdir(targetDir, { recursive: true })
    await symlink('/tmp/escape', join(targetDir, 'payload'))
    await assert.rejects(
      () => materializeDagNode({ store: symlinkStore, workRoot: cleanRoot }, {
        missionId: symlinkMission.id,
        nodeId: 'join',
        attempt: 1,
        acceptedDeps: { rootA: symlinkParentA, rootB: symlinkParentB },
      }),
      /symlink/i,
    )

    await assert.rejects(
      () => materializeDagNode({ store: symlinkStore, workRoot: cleanRoot }, {
        missionId: symlinkMission.id,
        nodeId: 'join',
        attempt: 1,
        acceptedDeps: { rootA: symlinkParentA },
      }),
      /dependency keys/i,
    )
  })
})

const artifact = (
  missionId: string,
  taskId: string,
  artifactId: string,
  contentSha: string,
  sizeBytes = 1,
): Artifact => ({
  artifact_id: artifactId,
  mission_id: missionId,
  task_id: taskId,
  role: 'report',
  uri: 'evidence/report.txt',
  media_type: 'text/plain',
  size_bytes: sizeBytes,
  sha256: contentSha,
  version: 1,
  state: 'AVAILABLE',
  producer: { agent_id: 'codex', adapter_version: 'test', execution_session_id: 'session' },
  provenance: {},
  retention: { retain_until: '2099-01-01T00:00:00.000Z', immutable: true },
  security: { classification: 'internal', contains_secrets: false, contains_pii: false, allowed_roles: [] },
  created_at: T0,
})

const seedParentArtifact = async (
  store: Store,
  workRoot: string,
  missionId: string,
  taskId: string,
  artifactId: string,
  content: string,
  declaredSha = sha(content),
) => {
  await mkdir(join(workRoot, taskId, 'evidence'), { recursive: true })
  await writeFile(join(workRoot, taskId, 'evidence/report.txt'), content)
  await store.putArtifact(artifact(missionId, taskId, artifactId, declaredSha, Buffer.byteLength(content)))
}
