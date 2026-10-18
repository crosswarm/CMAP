import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'

import { RunnerAdmissionError } from '#domain-model'
import type { Artifact, Store, TaskRecord, ReviewDecisionV1, ReviewApplicationV1, TaskEnvelopeV1 } from '#domain-model'
import { INPUT_PAYLOAD, existingChildDir, existingInputFile, safeChildDir, safeMkdir, publishInput, verifiedArtifactBytes } from './artifact-files.ts'

export type ReviewInputMatrix = NonNullable<ReviewApplicationV1['followup_inputs']>

type ReviewInputRef = ReviewInputMatrix[number][number]
type EnvelopeArtifactRef = NonNullable<NonNullable<TaskEnvelopeV1['inputs']>['artifact_refs']>[number]
type NormalizedEnvelopeRef = EnvelopeArtifactRef & { source_task_id: string; uri: string; sha256: string }

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const lowerSha = (value: string): string => value.toLowerCase()

const inputInvalid = (message: string): RunnerAdmissionError => {
  const error = new RunnerAdmissionError('INPUT_INVALID')
  error.message = message
  return error
}

const deterministicInvalid = async <T>(reason: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof RunnerAdmissionError) throw error
    if (error instanceof Error) {
      const code = (error as NodeJS.ErrnoException).code
      if (
        ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(code ?? '') ||
        error.message.startsWith('DAG ') ||
        error.name === 'AdapterError'
      ) {
        throw inputInvalid(reason)
      }
    }
    throw error
  }
}

export const reviewArtifactUri = (artifactId: string): string => {
  return posix.join('inputs', 'review', hash(artifactId), INPUT_PAYLOAD)
}

const assertTaskScope = (mission: NonNullable<Awaited<ReturnType<Store['getMission']>>>, task: TaskRecord): void => {
  if (
    task.mission_id !== mission.id ||
    task.envelope.identity.mission_id !== mission.id ||
    task.envelope.identity.task_id !== task.id ||
    task.envelope.identity.tenant !== mission.tenant ||
    task.envelope.identity.owner !== mission.owner
  ) {
    throw inputInvalid('review input task scope mismatch')
  }
}

const artifactAllowed = (artifact: Artifact): boolean =>
  artifact.state === 'AVAILABLE' &&
  artifact.security &&
  (artifact.security.classification === 'public' || artifact.security.classification === 'internal') &&
  artifact.security.contains_secrets === false &&
  artifact.security.contains_pii === false &&
  Array.isArray(artifact.security.allowed_roles) &&
  artifact.security.allowed_roles.length === 0 &&
  artifact.provenance['content_assessment'] !== 'unassessed'

const resultArtifactMatches = (task: TaskRecord, artifact: Artifact): boolean => {
  const result = task.result
  if (
    !result ||
    result.schema !== 'cmap/task-result/v1' ||
    result.mission_id !== task.mission_id ||
    result.task_id !== task.id ||
    result.attempt !== task.attempt
  ) return false
  const matches = result.artifacts.filter((a) => a.artifact_id === artifact.artifact_id)
  if (matches.length !== 1) return false
  const match = matches[0]!
  return match.role === artifact.role && lowerSha(match.sha256) === lowerSha(artifact.sha256)
}

/** 控制面派发前冻结给本任务的输入（记忆快照、续作证据）：不在 Agent 结果里，以信封引用为证。 */
export const FROZEN_INPUT_PRODUCERS = ['memross', 'cmap-continuation'] as const

const frozenInputMatches = (task: TaskRecord, artifact: Artifact): boolean =>
  artifact.task_id === task.id &&
  (FROZEN_INPUT_PRODUCERS as readonly string[]).includes(artifact.producer.agent_id) &&
  (task.envelope.inputs?.artifact_refs ?? []).filter((ref) =>
    !Object.hasOwn(ref, 'source_task_id') &&
    ref.artifact_id === artifact.artifact_id &&
    ref.role === artifact.role &&
    typeof ref.sha256 === 'string' && lowerSha(ref.sha256) === lowerSha(artifact.sha256)
  ).length === 1

const FROZEN_INPUT_ROLES = ['memory_context', 'continuation_input', 'handoff']

/** 本任务收到的冻结输入（自己的或经 review input 继承的），返工后继原样继承，保证前后看到同一份记忆。 */
export const frozenInputArtifactIds = (task: TaskRecord): string[] => [...new Set(
  (task.envelope.inputs?.artifact_refs ?? [])
    .filter((ref) => FROZEN_INPUT_ROLES.includes(ref.role))
    .map((ref) => ref.artifact_id),
)]

const matchingArtifacts = async (
  store: Store,
  missionId: string,
  artifactId: string,
): Promise<readonly Artifact[]> => {
  const tasks = await store.queryTasks({ missionId })
  const found: Artifact[] = []
  for (const task of tasks) {
    found.push(...(await store.listArtifacts(task.id)).filter((artifact) =>
      artifact.artifact_id === artifactId && artifact.mission_id === missionId
    ))
  }
  return found
}

const resolveArtifact = async (
  store: Store,
  recipientMissionId: string,
  artifactId: string,
): Promise<{ task: TaskRecord; artifact: Artifact }> => {
  const mission = await store.getMission(recipientMissionId)
  if (!mission) throw inputInvalid('review input mission missing')
  const matches = await matchingArtifacts(store, mission.id, artifactId)
  if (matches.length !== 1) throw inputInvalid('review input artifact not uniquely available')
  const artifact = matches[0]!
  if (!artifactAllowed(artifact)) throw inputInvalid('review input artifact is not shareable')
  const task = await store.getTask(artifact.task_id)
  if (!task) throw inputInvalid('review input source task missing')
  assertTaskScope(mission, task)
  if (artifact.task_id !== task.id || artifact.mission_id !== mission.id) throw inputInvalid('review input artifact scope mismatch')
  if (!resultArtifactMatches(task, artifact) && !frozenInputMatches(task, artifact)) throw inputInvalid('review input result proof mismatch')
  return { task, artifact }
}

const descriptorFrom = (task: TaskRecord, artifact: Artifact): ReviewInputRef => ({
  artifact_id: artifact.artifact_id,
  source_task_id: task.id,
  role: artifact.role,
  sha256: lowerSha(artifact.sha256),
  uri: reviewArtifactUri(artifact.artifact_id),
})

/** 单个同 Mission 产物的 review input 描述；不可共享或证明不符时抛 INPUT_INVALID。 */
export const resolveReviewInputRef = async (store: Store, missionId: string, artifactId: string): Promise<ReviewInputRef> => {
  const { task, artifact } = await resolveArtifact(store, missionId, artifactId)
  return descriptorFrom(task, artifact)
}

export const resolveReviewInputs = async (
  store: Store,
  source: TaskRecord,
  decision: ReviewDecisionV1,
): Promise<ReviewInputMatrix> => {
  if (decision.mission_id !== source.mission_id) throw inputInvalid('review input decision mission mismatch')
  const mission = await store.getMission(source.mission_id)
  if (!mission) throw inputInvalid('review input mission missing')
  assertTaskScope(mission, source)

  const matrix: ReviewInputRef[][] = []
  for (const followup of decision.required_followups ?? []) {
    const refs = followup.inputs?.artifact_refs ?? []
    const row: ReviewInputRef[] = []
    for (const artifactId of refs) {
      const { task, artifact } = await resolveArtifact(store, source.mission_id, artifactId)
      row.push(descriptorFrom(task, artifact))
    }
    matrix.push(row)
  }
  return matrix
}

const newRefs = (task: TaskRecord): EnvelopeArtifactRef[] =>
  (task.envelope.inputs?.artifact_refs ?? []).filter((ref) =>
    ref && typeof ref === 'object' && Object.hasOwn(ref as Record<string, unknown>, 'source_task_id')
  )

const validId = (value: string): boolean =>
  value.trim() === value && value.length > 0 && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..'

const validSha = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value)

function normalizedRef(ref: EnvelopeArtifactRef): NormalizedEnvelopeRef {
  if (
    typeof ref.artifact_id !== 'string' ||
    typeof ref.source_task_id !== 'string' ||
    typeof ref.role !== 'string' ||
    typeof ref.uri !== 'string' ||
    typeof ref.sha256 !== 'string' ||
    ref.artifact_id.length === 0 ||
    !validId(ref.source_task_id) ||
    ref.role.length === 0 ||
    !validSha(ref.sha256) ||
    ref.uri !== reviewArtifactUri(ref.artifact_id)
  ) throw inputInvalid('review input ref shape invalid')
  return ref as NormalizedEnvelopeRef
}

const snapshotTask = (task: TaskRecord): TaskRecord => structuredClone(task) as TaskRecord

const assertRecipientScope = async (store: Store, task: TaskRecord): Promise<void> => {
  const mission = await store.getMission(task.mission_id)
  if (!mission) throw inputInvalid('review input mission missing')
  assertTaskScope(mission, task)
}

const currentArtifactForRef = async (store: Store, task: TaskRecord, ref: NormalizedEnvelopeRef): Promise<Artifact> => {
  const { task: sourceTask, artifact } = await resolveArtifact(store, task.mission_id, ref.artifact_id)
  if (
    sourceTask.id !== ref.source_task_id ||
    artifact.role !== ref.role ||
    lowerSha(artifact.sha256) !== ref.sha256
  ) throw inputInvalid('review input frozen metadata mismatch')
  return artifact
}

export const prepareReviewInputs = async (
  store: Store,
  task: TaskRecord,
  workRoot?: string,
): Promise<void> => {
  const snapshot = snapshotTask(task)
  const refs = newRefs(snapshot)
  if (refs.length === 0 || snapshot.binding) return
  if (!workRoot) throw inputInvalid('review input workRoot missing')
  await assertRecipientScope(store, snapshot)
  const { root, child } = await deterministicInvalid('review input workspace invalid', () => safeChildDir(workRoot, snapshot.id))
  for (const candidate of refs) {
    const ref = normalizedRef(candidate)
    const artifact = await currentArtifactForRef(store, snapshot, ref)
    const verified = await deterministicInvalid('review input source invalid', () => verifiedArtifactBytes(root, ref.source_task_id, artifact))
    if (verified.sha256 !== ref.sha256) throw inputInvalid('review input source hash mismatch')
    const dir = await deterministicInvalid('review input target invalid', () => safeMkdir(child, ['inputs', 'review', hash(ref.artifact_id)]))
    await deterministicInvalid('review input target invalid', () => publishInput(dir, verified.bytes))
  }
}

export const verifyReviewInputs = async (
  store: Store,
  task: TaskRecord,
  workRoot?: string,
): Promise<void> => {
  const snapshot = snapshotTask(task)
  const refs = newRefs(snapshot)
  if (refs.length === 0) return
  if (!workRoot) throw inputInvalid('review input workRoot missing')
  await assertRecipientScope(store, snapshot)
  const { child } = await deterministicInvalid('review input workspace invalid', () => existingChildDir(workRoot, snapshot.id))
  for (const candidate of refs) {
    const ref = normalizedRef(candidate)
    await currentArtifactForRef(store, snapshot, ref)
    const target = await deterministicInvalid('review input target invalid', () =>
      existingInputFile(child, ['inputs', 'review', hash(ref.artifact_id), INPUT_PAYLOAD]),
    )
    const bytes = await deterministicInvalid('review input target invalid', () => readFile(target))
    if (hash(bytes) !== ref.sha256) throw inputInvalid('review input target hash mismatch')
  }
}
