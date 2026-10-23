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
import { INPUT_PAYLOAD, existingChildDir, safeChildDir, safeMkdir, publishInput, verifiedArtifactBytes } from './artifact-files.ts'
import { WORKSPACE_SNAPSHOT_ROLE, packWorkspace, unpackWorkspace } from './workspace-snapshot.ts'
import { MEMORY_ROLE, freezeMemoryInput, registerMemoryArtifact, type FrozenInputRef, type MemoryDeps } from './memory-context.ts'
import { artifactShareable, resolveReviewInputRef } from './review-inputs.ts'
import { continuationSource, freezeContinuationInputs, registerContinuationInputs } from './mission-continuation.ts'
import { readVerifiedArtifact } from '../packages/adapter-sdk/src/structured-output.ts'

type DagNode = MissionPlanV1['nodes'][number]
type ArtifactRefs = NonNullable<NonNullable<TaskEnvelopeV1['inputs']>['artifact_refs']>
type PreviousAttempt = NonNullable<NonNullable<TaskEnvelopeV1['inputs']>['previous_attempt']>

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

/** handoff>0 为额度续接任务（ADR-0009 §3）：与原任务同轮，按节点内续接序号另取 ID；0 保持原有 ID 不变。 */
export const dagTaskId = (missionId: string, nodeId: string, attempt: number, handoff = 0): string => {
  return `dag_${hash(JSON.stringify(handoff ? [missionId, nodeId, attempt, 'quota-handoff', handoff] : [missionId, nodeId, attempt])).slice(0, 40)}`
}

const idempotencyKey = (missionId: string, nodeId: string, attempt: number, handoff = 0): string =>
  `${missionId}:${nodeId}:${attempt}${handoff ? `:quota-handoff:${handoff}` : ''}`

/** 信封幂等键里的续接序号：0 为普通轮次任务，null 为不认识的键。 */
const handoffIndexOf = (mission: Mission, node: DagNode, task: TaskRecord): number | null => {
  const base = idempotencyKey(mission.id, node.node_id, task.attempt)
  const key = task.envelope.identity.idempotency_key
  if (key === base) return 0
  const index = key.startsWith(`${base}:quota-handoff:`) ? Number(key.slice(base.length + ':quota-handoff:'.length)) : NaN
  return Number.isSafeInteger(index) && index >= 1 && key === idempotencyKey(mission.id, node.node_id, task.attempt, index) ? index : null
}

const nodeById = (plan: MissionPlanV1, nodeId: string): DagNode => {
  const node = plan.nodes.find((n) => n.node_id === nodeId)
  if (!node) throw new Error(`DAG node missing: ${nodeId}`)
  return node
}

const assertEnvelopeMatchesNode = (mission: Mission, node: DagNode, task: TaskRecord): boolean => {
  const handoff = handoffIndexOf(mission, node, task)
  if (handoff === null || task.id !== dagTaskId(mission.id, node.node_id, task.attempt, handoff)) return false
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
  // 结果状态不限：硬门槛对 Agent 自报 failed 等结果同样判返工，证明靠下面的返工评审与事件。
  if (
    !task.result ||
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
  // 上一轮也可能由额度续接任务收尾：它与原任务同轮，ID 另取（返工证明仍由 reworkedDagAttempt 判定）
  const prior = supersedesTaskId && supersedesTaskId !== expectedPrior ? await store.getTask(supersedesTaskId) : null
  const handoffPrior = prior?.attempt === attempt - 1 && (handoffIndexOf(mission, node, prior) ?? 0) > 0
  if (supersedesTaskId !== expectedPrior && !handoffPrior) {
    throw new Error(`DAG supersedes must reference prior same-node attempt: ${expectedPrior}`)
  }
  if (!(await reworkedDagAttempt(store, mission, node, supersedesTaskId!))) {
    throw new Error(`DAG prior attempt must be a completed rework: ${supersedesTaskId}`)
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
      .filter(artifactShareable)
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
  previousAttempt?: PreviousAttempt,
  handoff = 0,
): TaskEnvelopeV1 => ({
  schema: 'cmap/task-envelope/v1',
  identity: {
    mission_id: mission.id,
    task_id: taskId,
    plan_node_id: node.node_id,
    ...(supersedesTaskId ? { supersedes_task_id: supersedesTaskId } : {}),
    idempotency_key: idempotencyKey(mission.id, node.node_id, attempt, handoff),
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
    parameters: { dependency_task_ids: deps, ...(node.yonwork ? { yonwork_policy_sha256: node.yonwork.policy_sha256 } : {}),
      ...(continues(mission, node, attempt) ? { continues_mission_id: mission.constraints['continues_mission_id'] as string } : {}) },
    ...(previousAttempt ? { previous_attempt: previousAttempt } : {}),
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
  previousAttempt?: PreviousAttempt,
  handoff = 0,
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
      envelope: buildEnvelope(mission, node, taskId, attempt, deps, artifactRefs, supersedesTaskId, previousAttempt, handoff),
      result: null,
      binding: null,
      deps,
      created_at: now,
      updated_at: now,
    },
    actor: ACTOR,
  })
}

/** 续作（continues_mission_id）只接在根节点首轮：控制面只为不带 plan 的请求合成的单节点计划写入该约束。 */
const continues = (mission: Mission, node: DagNode, attempt: number): boolean =>
  attempt === 1 && node.deps.length === 0 && mission.constraints['continues_mission_id'] !== undefined

/** YonWork 等无任务工作区的 Adapter 收不到工作区文件，不附记忆快照与返工产物。 */
const usesWorkspace = (node: DagNode): boolean => node.capability !== 'yonwork.validate'

/**
 * 节点首轮记忆快照：节点 memory 优先，缺省继承 Mission 的 memory 并以节点 goal 作查询。
 * 只在首轮检索；重试沿用已入账信封里的冻结引用，只复核字节。返工轮经 review input 继承首轮快照。
 */
const nodeMemoryInput = async (
  deps: { workRoot: string; memory?: MemoryDeps },
  mission: Mission,
  node: DagNode,
  taskId: string,
  attempt: number,
  existing: TaskRecord | null,
): Promise<{ ref: FrozenInputRef; projectId: string; sizeBytes: number } | undefined> => {
  if (attempt !== 1 || !usesWorkspace(node)) return undefined
  const inherited = mission.constraints['memory'] as { project_id: string; limit?: number } | undefined
  const config = node.memory ?? (inherited ? { project_id: inherited.project_id, ...(inherited.limit ? { limit: inherited.limit } : {}) } : undefined)
  if (!config) return undefined
  const { child } = await safeChildDir(deps.workRoot, taskId)
  let ref = existing?.envelope.inputs?.artifact_refs?.find((r) => r.role === MEMORY_ROLE && !Object.hasOwn(r, 'source_task_id')) as FrozenInputRef | undefined
  ref ??= await freezeMemoryInput(deps.memory, child, {
    projectId: config.project_id, query: (config.query ?? node.goal).slice(0, 500), limit: config.limit ?? 3,
  }, (digest) => `art_mem_${hash(JSON.stringify([taskId, digest])).slice(0, 32)}`)
  const verified = await readVerifiedArtifact(child, { uri: ref.uri, role: ref.role, sha256: ref.sha256 })
  return { ref, projectId: config.project_id, sizeBytes: verified.bytes.length }
}

/** 返工轮输入：上一轮未通过的标准与 focus，上一轮产物与冻结输入经 review input 交付（不可共享的跳过）。 */
const reworkInputs = async (
  store: Store,
  mission: Mission,
  node: DagNode,
  priorTaskId: string,
): Promise<{ refs: ArtifactRefs; previousAttempt?: PreviousAttempt }> => {
  const review = (await store.listReviews(mission.id)).find((r) => exactReview('rework', mission.id, priorTaskId, r))
  if (!review) throw new Error(`DAG prior attempt must be a completed rework: ${priorTaskId}`)
  const decision = review.decision
  const followup = decision.required_followups?.[0]
  const failed = decision.failed_criteria ?? []
  const refs: ArtifactRefs = []
  if (usesWorkspace(node)) {
    for (const artifactId of followup?.inputs?.artifact_refs ?? []) {
      try { refs.push(await resolveReviewInputRef(store, mission.id, artifactId)) }
      catch (error) { if (!(error instanceof RunnerAdmissionError)) throw error }
    }
  }
  const [firstFailed, ...restFailed] = failed.map(({ criterion_id, expected, actual, reason }) => ({ criterion_id, expected, actual, reason }))
  return {
    refs,
    ...(firstFailed ? { previousAttempt: {
      supersedes_task_id: priorTaskId,
      review_round: decision.review_round ?? review.round + 1,
      failed_criteria: [firstFailed, ...restFailed],
      ...(followup?.focus?.length ? { focus: [...followup.focus] } : {}),
    } } : {}),
  }
}

export const materializeDagNode = async (
  deps: { store: Store; workRoot: string; runner: RunnerDescriptor; memory?: MemoryDeps },
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
  const memory = await nodeMemoryInput(deps, mission, node, taskId, input.attempt, existing)
  // 续作冻结输入：重试沿用已入账信封里的引用，只复核字节，不重新复制。
  const source = continues(mission, node, input.attempt) ? await continuationSource(deps.store, mission) : null
  const frozen = existing?.envelope.inputs?.artifact_refs?.filter((r) => ['continuation_input', 'continuation_memory', 'handoff'].includes(r.role))
  const continuation = !source ? [] : frozen?.length ? frozen : await freezeContinuationInputs(deps.store, deps.workRoot, source, taskId)
  const rework = input.attempt > 1 ? await reworkInputs(deps.store, mission, node, input.supersedesTaskId!) : undefined
  await createDagTask(
    deps.store,
    mission,
    node,
    taskId,
    input.attempt,
    acceptedTaskIds,
    // 依赖产物已按父节点复制过的（含父节点快照），不再经 review input 重复交付。
    [...(artifactRefs ?? []), ...continuation, ...(memory ? [memory.ref] : []),
      ...(rework?.refs ?? []).filter((ref) => !(artifactRefs ?? []).some((copied) => copied.artifact_id === ref.artifact_id))],
    input.supersedesTaskId,
    rework?.previousAttempt,
  )
  if (memory) await registerMemoryArtifact(deps.store, { missionId: mission.id, taskId, ref: memory.ref, projectId: memory.projectId, sizeBytes: memory.sizeBytes })
  if (source) await registerContinuationInputs(deps.store, deps.workRoot, mission, source, taskId, continuation)
  return { taskId }
}

const QUOTA_HANDOFF_PRODUCER = 'cmap-quota-handoff'
const RETENTION_MS = 365 * 24 * 3600 * 1000

export interface WorkspaceSnapshotRecord {
  readonly artifact_id: string
  readonly sha256: string
  readonly size_bytes: number
  readonly file_count: number
}

/** 原工作区打包为冻结输入并在新工作区解包；重试时同一工作区打包出同一份字节。 */
const freezeWorkspaceSnapshot = async (workRoot: string, fromTaskId: string, taskId: string): Promise<ArtifactRefs[number]> => {
  const { child: source } = await existingChildDir(workRoot, fromTaskId)
  const { child } = await safeChildDir(workRoot, taskId)
  const { bytes } = await packWorkspace(source)
  const artifactId = `art_qh_${hash(JSON.stringify([taskId, WORKSPACE_SNAPSHOT_ROLE])).slice(0, 32)}`
  await publishInput(await safeMkdir(child, ['inputs', 'quota-handoff', hash(artifactId)]), bytes)
  await unpackWorkspace(child, bytes)
  return { artifact_id: artifactId, uri: join('inputs', 'quota-handoff', hash(artifactId), INPUT_PAYLOAD), role: WORKSPACE_SNAPSHOT_ROLE, sha256: hash(bytes) }
}

/**
 * 额度续接任务（ADR-0009 §3）：与原任务同轮、supersedes 指向原任务，不消耗返工预算。
 * 依赖产物重新复制；原任务已复核的结果产物与收到的其他冻结输入经 review input 交付（不可共享的跳过）；
 * previous_attempt 记录 QUOTA_EXHAUSTED 失败原因并保留原任务自身的返工事实。
 * snapshot 为真（写副作用级）时以原工作区快照为冻结输入，不共享可写工作区。重试沿用已入账信封里的引用。
 */
export const materializeQuotaHandoff = async (
  deps: { store: Store; workRoot: string },
  input: { from: TaskRecord; handoff: number; reason: string; snapshot: boolean },
): Promise<{ taskId: string; snapshot: WorkspaceSnapshotRecord | null }> => {
  const { from } = input
  const { mission, plan } = await getDagMission(deps.store, from.mission_id)
  const node = nodeById(plan, from.envelope.identity.plan_node_id ?? '')
  if (!assertEnvelopeMatchesNode(mission, node, from) || !Number.isSafeInteger(input.handoff) || input.handoff < 1) {
    throw new Error('DAG quota handoff source does not match node')
  }
  const taskId = dagTaskId(mission.id, node.node_id, from.attempt, input.handoff)
  const existing = await deps.store.getTask(taskId)
  if (existing && (existing.supersedes_task_id !== from.id || !assertEnvelopeMatchesNode(mission, node, existing))) {
    throw new Error('DAG quota handoff task mismatch')
  }
  let refs: ArtifactRefs = [...(existing?.envelope.inputs?.artifact_refs ?? [])]
  if (!existing) {
    const acceptedDeps = Object.fromEntries(node.deps.map((dep, i) => [dep, from.deps[i]!]))
    const copied = (await copyParentArtifacts(deps.store, mission.id, deps.workRoot, taskId, acceptedDeps, node.deps)) ?? []
    refs = [...copied]
    if (usesWorkspace(node)) {
      const ids = new Set([...(from.result?.artifacts ?? []).map((a) => a.artifact_id), ...(from.envelope.inputs?.artifact_refs ?? []).map((r) => r.artifact_id)])
      for (const id of ids) {
        if (copied.some((c) => c.artifact_id === id)) continue
        try { refs.push(await resolveReviewInputRef(deps.store, mission.id, id)) }
        catch (error) { if (!(error instanceof RunnerAdmissionError)) throw error }
      }
      if (input.snapshot) refs.push(await freezeWorkspaceSnapshot(deps.workRoot, from.id, taskId))
    }
  }
  const snapshotRef = refs.find((r) => r.role === WORKSPACE_SNAPSHOT_ROLE && !Object.hasOwn(r, 'source_task_id'))
  if (input.snapshot && !snapshotRef) throw new Error('DAG quota handoff snapshot missing')
  const { child } = await safeChildDir(deps.workRoot, taskId)
  // 与 Agent 侧同一道复核：路径不越界、散列一致、不含已知凭据模式。先于入账，坏快照不产生任务。
  const verified = snapshotRef ? await readVerifiedArtifact(child, { uri: snapshotRef.uri!, role: snapshotRef.role, sha256: snapshotRef.sha256! }) : undefined
  if (!existing) {
    const prior = from.envelope.inputs?.previous_attempt
    await createDagTask(deps.store, mission, node, taskId, from.attempt, from.deps, refs, from.id, {
      supersedes_task_id: from.id,
      kind: 'quota_handoff',
      ...(prior?.review_round ? { review_round: prior.review_round } : {}),
      failed_criteria: [{ criterion_id: 'TASK-STATUS', expected: 'status = completed', actual: 'status = failed', reason: input.reason }, ...(prior?.failed_criteria ?? [])],
      ...(prior?.focus?.length ? { focus: [...prior.focus] } : {}),
    }, input.handoff)
  }
  if (!snapshotRef || !verified) return { taskId, snapshot: null }
  if (!(await deps.store.listArtifacts(taskId)).some((a) => a.artifact_id === snapshotRef.artifact_id)) {
    const now = new Date()
    await deps.store.putArtifact({
      artifact_id: snapshotRef.artifact_id, mission_id: mission.id, task_id: taskId, role: WORKSPACE_SNAPSHOT_ROLE, uri: snapshotRef.uri!,
      media_type: 'application/json', size_bytes: verified.bytes.length, sha256: verified.sha256, version: 1, state: 'AVAILABLE',
      producer: { agent_id: QUOTA_HANDOFF_PRODUCER, adapter_version: 'quota-handoff/v1', execution_session_id: from.id },
      provenance: { source: 'quota_handoff', source_task_id: from.id },
      retention: { retain_until: new Date(now.getTime() + RETENTION_MS).toISOString(), immutable: true },
      security: { classification: 'internal', contains_secrets: false, contains_pii: false, allowed_roles: [] },
      created_at: now.toISOString(),
    })
  }
  const fileCount = (JSON.parse(verified.bytes.toString('utf8')) as { files: unknown[] }).files.length
  return { taskId, snapshot: { artifact_id: snapshotRef.artifact_id, sha256: verified.sha256, size_bytes: verified.bytes.length, file_count: fileCount } }
}
