import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  normalizeMissionPlan,
  recomputeCriterionPassed,
  type AcceptanceCriterion,
  type Artifact,
  type Mission,
  type RiskLevel,
  type Store,
  type TaskRecord,
  type RunnerDescriptor,
  assertRunnerAdmission,
  admissionSubjectFromDagNode,
  RunnerAdmissionError,
} from '#domain-model'
import { preflightTaskAdmission, type AdmissionDenial } from './runner-admission.ts'
import type { TaskEnvelopeV1 } from '#domain-model'
import type { MissionPlanV1 } from '../packages/domain-model/src/generated/mission-plan.ts'
import { INPUT_PAYLOAD, safeChildDir, safeMkdir, publishInput, verifiedArtifactBytes } from './artifact-files.ts'

type DagNode = MissionPlanV1['nodes'][number]

const ACTOR = { type: 'system', id: 'dag-materializer' } as const
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

const sameKeys = (actual: readonly string[], expected: readonly string[]): boolean => {
  if (actual.length !== expected.length) return false
  const actualSet = new Set(actual)
  return expected.every((key) => actualSet.has(key))
}

const criterionFor = (mission: Mission, id: string): AcceptanceCriterion => {
  const criterion = mission.acceptance.find((c) => c.criterion_id === id)
  if (!criterion) throw new Error(`DAG criterion missing from Mission acceptance: ${id}`)
  return criterion
}

const envelopeCriterion = (criterion: AcceptanceCriterion) => ({
  criterion_id: criterion.criterion_id,
  metric: criterion.metric,
  operator: criterion.operator,
  expected: criterion.expected,
  ...(criterion.unit === undefined ? {} : { unit: criterion.unit }),
  hard_gate: criterion.hard_gate,
})

const planFromMission = (mission: Mission): MissionPlanV1 => {
  if (mission.workflow_template !== 'dag/v1') {
    throw new Error(`Mission ${mission.id} is not dag/v1`)
  }
  if (typeof mission.constraints['risk_level'] !== 'string') {
    throw new Error(`Mission ${mission.id} missing risk_level ceiling`)
  }
  return normalizeMissionPlan(
    mission.constraints['plan'],
    mission.acceptance,
    mission.constraints['risk_level'] as RiskLevel,
  )
}

export const getDagMission = async (
  store: Store,
  missionId: string,
): Promise<{ mission: Mission; plan: MissionPlanV1 }> => {
  const mission = await store.getMission(missionId)
  if (!mission) throw new Error(`Mission missing: ${missionId}`)
  return { mission, plan: planFromMission(mission) }
}

export const dagTaskId = (missionId: string, nodeId: string, attempt: number): string => {
  return `dag_${hash(JSON.stringify([missionId, nodeId, attempt])).slice(0, 40)}`
}

const nodeById = (plan: MissionPlanV1, nodeId: string): DagNode => {
  const node = plan.nodes.find((n) => n.node_id === nodeId)
  if (!node) throw new Error(`DAG node missing: ${nodeId}`)
  return node
}

const assertEnvelopeMatchesNode = (mission: Mission, node: DagNode, task: TaskRecord): boolean => {
  if (task.id !== dagTaskId(mission.id, node.node_id, task.attempt)) return false
  if (task.envelope.identity.plan_node_id !== node.node_id) return false
  if (task.envelope.identity.task_id !== task.id) return false
  if (task.envelope.identity.revision !== task.attempt) return false
  if (task.envelope.identity.tenant !== mission.tenant) return false
  if (task.envelope.identity.owner !== mission.owner) return false
  if (task.envelope.identity.mission_id !== mission.id || task.mission_id !== mission.id) return false
  if (task.capability !== node.capability || task.risk !== node.risk_level) return false
  if (task.envelope.classification.requested_capability !== node.capability) return false
  if (task.envelope.classification.risk_level !== node.risk_level) return false
  if (task.envelope.goal.statement !== node.goal) return false
  if (node.yonwork && (task.envelope.permissions.yonwork?.chat_send !== true ||
    task.envelope.execution_policy.preferred_agent !== node.preferred_agent ||
    task.envelope.inputs?.parameters?.['yonwork_policy_sha256'] !== node.yonwork.policy_sha256)) return false
  return isDeepStrictEqual(
    task.envelope.goal.success_definition,
    node.criterion_ids.map((id) => envelopeCriterion(criterionFor(mission, id))),
  )
}

const exactReview = (
  decision: 'accept' | 'rework',
  missionId: string,
  taskId: string,
  review: Awaited<ReturnType<Store['listReviews']>>[number],
): boolean =>
  review.decision.decision === decision &&
  review.mission_id === missionId &&
  review.reviewed_task_ids.length === 1 &&
  review.reviewed_task_ids[0] === taskId &&
  review.decision.mission_id === missionId &&
  review.decision.reviewed_task_ids.length === 1 &&
  review.decision.reviewed_task_ids[0] === taskId

export const dagAttemptSatisfiesNode = (
  mission: Mission,
  node: DagNode,
  task: TaskRecord,
): boolean => {
  if (!assertEnvelopeMatchesNode(mission, node, task)) return false
  const result = task.result
  if (
    !result ||
    result.schema !== 'cmap/task-result/v1' ||
    result.status !== 'completed' ||
    result.mission_id !== mission.id ||
    result.task_id !== task.id ||
    result.attempt !== task.attempt
  ) return false

  if (result.criterion_results.length !== node.criterion_ids.length) return false
  for (const criterionId of node.criterion_ids) {
    const matches = result.criterion_results.filter((r) => r.criterion_id === criterionId)
    if (matches.length !== 1) return false
    if (!recomputeCriterionPassed(criterionFor(mission, criterionId), matches[0])) return false
  }
  return true
}

export const acceptedDagAttempt = async (
  store: Store,
  mission: Mission,
  node: DagNode,
  taskId: string,
): Promise<boolean> => {
  const task = await store.getTask(taskId)
  if (!task || task.state !== 'COMPLETED') return false
  if (!dagAttemptSatisfiesNode(mission, node, task)) return false
  const result = task.result
  if (!result?.artifacts.some((a) => a.role === 'report')) return false
  const ledgerArtifacts = await store.listArtifacts(taskId)
  for (const artifact of result.artifacts) {
    if (artifact.size_bytes === undefined) return false
    if (!ledgerArtifacts.some((ledger) =>
      ledger.state === 'AVAILABLE' &&
      ledger.mission_id === mission.id &&
      ledger.task_id === taskId &&
      ledger.artifact_id === artifact.artifact_id &&
      ledger.sha256 === artifact.sha256 &&
      ledger.size_bytes === artifact.size_bytes &&
      ledger.role === artifact.role
    )) return false
  }

  const reviews = await store.listReviews(mission.id)
  if (!reviews.some((r) => exactReview('accept', mission.id, taskId, r))) return false
  return true
}

const reworkedDagAttempt = async (
  store: Store,
  mission: Mission,
  node: DagNode,
  taskId: string,
): Promise<boolean> => {
  const task = await store.getTask(taskId)
  if (!task || task.state !== 'COMPLETED') return false
  if (!assertEnvelopeMatchesNode(mission, node, task)) return false
  if (
    !task.result ||
    task.result.status !== 'completed' ||
    task.result.mission_id !== mission.id ||
    task.result.task_id !== taskId ||
    task.result.attempt !== task.attempt
  ) return false
  const reviews = await store.listReviews(mission.id)
  if (reviews.some((r) => exactReview('accept', mission.id, taskId, r))) return false
  if (!reviews.some((r) => exactReview('rework', mission.id, taskId, r))) return false
  return (await store.listEvents(mission.id)).some((e) =>
    e.task_id === taskId && e.event_type === 'REVIEW_REWORK_REQUESTED'
  )
}

const assertAttempt = async (
  store: Store,
  mission: Mission,
  node: DagNode,
  attempt: number,
  supersedesTaskId?: string,
): Promise<void> => {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('DAG attempt must be a positive integer')
  const budget = mission.constraints['max_additional_cycles']
  if (!Number.isInteger(budget) || (budget as number) < 0) {
    throw new Error(`DAG Mission ${mission.id} has invalid attempt budget`)
  }
  if (attempt > (budget as number) + 1) throw new Error('DAG attempt exceeds Mission budget')
  if (attempt === 1) {
    if (supersedesTaskId) throw new Error('DAG attempt 1 must not supersede another Task')
    return
  }
  const expectedPrior = dagTaskId(mission.id, node.node_id, attempt - 1)
  if (supersedesTaskId !== expectedPrior) {
    throw new Error(`DAG supersedes must reference prior same-node attempt: ${expectedPrior}`)
  }
  if (!(await reworkedDagAttempt(store, mission, node, expectedPrior))) {
    throw new Error(`DAG prior attempt must be a completed rework: ${expectedPrior}`)
  }
}

const assertDeps = async (
  store: Store,
  mission: Mission,
  plan: MissionPlanV1,
  node: DagNode,
  acceptedDeps: Readonly<Record<string, string>>,
): Promise<readonly string[]> => {
  const actualKeys = Object.keys(acceptedDeps)
  if (!sameKeys(actualKeys, node.deps)) {
    throw new Error(`DAG dependency keys must exactly match direct deps: ${node.deps.join(',')}`)
  }
  const taskIds: string[] = []
  for (const depNodeId of node.deps) {
    const taskId = acceptedDeps[depNodeId]!
    if (!(await acceptedDagAttempt(store, mission, nodeById(plan, depNodeId), taskId))) {
      throw new Error(`DAG accepted dependency not proven: ${depNodeId}:${taskId}`)
    }
    taskIds.push(taskId)
  }
  return taskIds
}

const assertArtifactOwned = (artifact: Artifact, parentTaskId: string): void => {
  if (artifact.task_id !== parentTaskId) {
    throw new Error(`DAG artifact ownership mismatch: ${artifact.artifact_id}`)
  }
}

const copyParentArtifacts = async (
  store: Store,
  missionId: string,
  workRoot: string,
  childTaskId: string,
  acceptedDeps: Readonly<Record<string, string>>,
  depNodeIds: readonly string[],
): Promise<NonNullable<TaskEnvelopeV1['inputs']>['artifact_refs']> => {
  const { root, child } = await safeChildDir(workRoot, childTaskId)
  const refs: NonNullable<TaskEnvelopeV1['inputs']>['artifact_refs'] = []
  for (const depNodeId of depNodeIds) {
    const parentTaskId = acceptedDeps[depNodeId]!
    const artifacts = (await store.listArtifacts(parentTaskId))
      .filter((a) => a.state === 'AVAILABLE')
      .toSorted((a, b) => a.artifact_id.localeCompare(b.artifact_id))
    for (const artifact of artifacts) {
      assertArtifactOwned(artifact, parentTaskId)
      if (artifact.mission_id !== missionId) throw new Error(`DAG artifact mission mismatch: ${artifact.artifact_id}`)
      const verified = await verifiedArtifactBytes(root, parentTaskId, artifact)
      const artifactBucket = hash(artifact.artifact_id)
      const dir = await safeMkdir(child, ['inputs', depNodeId, artifactBucket])
      await publishInput(dir, verified.bytes)
      refs.push({
        artifact_id: artifact.artifact_id,
        uri: join('inputs', depNodeId, artifactBucket, INPUT_PAYLOAD),
        role: artifact.role,
        sha256: verified.sha256,
      })
    }
  }
  return refs
}

const buildEnvelope = (
  mission: Mission,
  node: DagNode,
  taskId: string,
  attempt: number,
  deps: readonly string[],
  artifactRefs: NonNullable<TaskEnvelopeV1['inputs']>['artifact_refs'],
  supersedesTaskId?: string,
): TaskEnvelopeV1 => ({
  schema: 'cmap/task-envelope/v1',
  identity: {
    mission_id: mission.id,
    task_id: taskId,
    plan_node_id: node.node_id,
    ...(supersedesTaskId ? { supersedes_task_id: supersedesTaskId } : {}),
    idempotency_key: `${mission.id}:${node.node_id}:${attempt}`,
    revision: attempt,
    tenant: mission.tenant,
    owner: mission.owner,
  },
  classification: {
    task_type: mission.type,
    requested_capability: node.capability,
    risk_level: node.risk_level,
  },
  goal: {
    statement: node.goal,
    success_definition: node.criterion_ids.map((id) => envelopeCriterion(criterionFor(mission, id))) as TaskEnvelopeV1['goal']['success_definition'],
  },
  inputs: {
    ...(artifactRefs && artifactRefs.length > 0 ? { artifact_refs: artifactRefs } : {}),
    parameters: { dependency_task_ids: deps, ...(node.yonwork ? { yonwork_policy_sha256: node.yonwork.policy_sha256 } : {}) },
  },
  environment: { tenant: mission.tenant },
  execution_policy: {
    ...(node.preferred_agent ? { preferred_agent: node.preferred_agent } : {}),
    ...(node.fallback_agents ? { fallback_agents: node.fallback_agents } : {}),
    timeout_seconds: 300,
    max_attempts: 1,
    ...(node.required_resource_locks ? { required_resource_locks: node.required_resource_locks } : {}),
  },
  permissions: { forbidden: [], ...(node.yonwork ? { yonwork: {chat_send: true} } : {}) },
  evidence_requirements: { required_artifact_roles: ['report'] },
  output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
})

const createDagTask = async (
  store: Store,
  mission: Mission,
  node: DagNode,
  taskId: string,
  attempt: number,
  deps: readonly string[],
  artifactRefs: NonNullable<TaskEnvelopeV1['inputs']>['artifact_refs'],
  supersedesTaskId?: string,
): Promise<void> => {
  const now = new Date().toISOString()
  await store.createTask({
    task: {
      id: taskId,
      mission_id: mission.id,
      parent_task_id: null,
      supersedes_task_id: supersedesTaskId ?? null,
      capability: node.capability,
      risk: node.risk_level,
      state: 'DRAFT',
      attempt,
      max_attempts: 1,
      lamport: 0,
      envelope: buildEnvelope(mission, node, taskId, attempt, deps, artifactRefs, supersedesTaskId),
      result: null,
      binding: null,
      deps,
      created_at: now,
      updated_at: now,
    },
    actor: ACTOR,
  })
}

export const materializeDagNode = async (
  deps: { store: Store; workRoot: string; runner: RunnerDescriptor },
  input: {
    missionId: string
    nodeId: string
    attempt: number
    supersedesTaskId?: string
    acceptedDeps: Readonly<Record<string, string>>
  },
): Promise<{ taskId: string } | AdmissionDenial> => {
  const { mission, plan } = await getDagMission(deps.store, input.missionId)
  const node = nodeById(plan, input.nodeId)
  await assertAttempt(deps.store, mission, node, input.attempt, input.supersedesTaskId)
  const acceptedTaskIds = await assertDeps(deps.store, mission, plan, node, input.acceptedDeps)
  const taskId = dagTaskId(mission.id, node.node_id, input.attempt)
  const existing = await deps.store.getTask(taskId)
  if (existing) {
    const denied=await preflightTaskAdmission(deps.store,deps.runner,existing)
    if(denied)return denied
    if(existing.binding) {
      if(!assertEnvelopeMatchesNode(mission,node,existing)||!isDeepStrictEqual(existing.deps,acceptedTaskIds))throw new Error('DAG_BOUND_TASK_MISMATCH')
      return {taskId} // recovery never re-copies inputs into an owned active workspace
    }
  }
  try {assertRunnerAdmission(deps.runner,admissionSubjectFromDagNode(mission,node,taskId))}
  catch(error) {
    if(!(error instanceof RunnerAdmissionError))throw error
    return {admissionDenied:{phase:'initial',code:error.code}}
  }
  const artifactRefs = await copyParentArtifacts(
    deps.store,
    mission.id,
    deps.workRoot,
    taskId,
    input.acceptedDeps,
    node.deps,
  )
  await createDagTask(
    deps.store,
    mission,
    node,
    taskId,
    input.attempt,
    acceptedTaskIds,
    artifactRefs,
    input.supersedesTaskId,
  )
  return { taskId }
}
