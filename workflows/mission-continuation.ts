/**
 * 续作 Mission（实施计划 S5 续接，continues_mission_id）。只在 Activity 里调用。
 *
 * 新 Mission 首个任务收到来源 Mission 的三类冻结输入，写进本任务工作区并登记在本任务名下：
 *  - continuation_input：来源中验收通过（REVIEW_ACCEPTED）任务的可共享结果产物；
 *  - continuation_memory：来源各任务冻结过的 Memross 记忆快照（按内容去重）；
 *  - handoff：从来源账本推出的交接内容（与升级时写给 Memross 的同一构造）。
 * 不恢复 Agent 会话。来源必须同租户、同 owner、已终结，否则失败关闭。
 * 账本 artifacts 以 (task_id, role, version) 唯一，同角色多份以 version 序号区分。
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import type { Artifact, Mission, Store, TaskEnvelopeV1 } from '#domain-model'
import { INPUT_PAYLOAD, publishInput, safeChildDir, safeMkdir, verifiedArtifactBytes } from './artifact-files.ts'
import { MEMORY_ROLE } from './memory-context.ts'
import { buildHandoff } from './memross-writeback.ts'
import { artifactShareable } from './review-inputs.ts'
import { readVerifiedArtifact } from '../packages/adapter-sdk/src/structured-output.ts'

type Ref = NonNullable<NonNullable<TaskEnvelopeV1['inputs']>['artifact_refs']>[number]
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const TERMINAL = ['COMPLETED', 'FAILED', 'ESCALATED', 'CANCELED']
const RETENTION_MS = 365 * 24 * 3600 * 1000
export const CONTINUATION_PRODUCER = 'cmap-continuation'

interface Entry {
  readonly artifactId: string
  readonly role: 'continuation_input' | 'continuation_memory' | 'handoff'
  readonly version: number
  readonly source?: Artifact
}

const invalid = (): Error => new Error('CONTINUATION_INVALID')

export const continuationSource = async (store: Store, mission: Mission): Promise<Mission | null> => {
  const sourceId = mission.constraints['continues_mission_id']
  if (sourceId === undefined) return null
  const source = typeof sourceId === 'string' ? await store.getMission(sourceId) : null
  if (!source || source.id === mission.id || source.tenant !== mission.tenant || source.owner !== mission.owner ||
    !TERMINAL.includes(source.state)) throw invalid()
  return source
}

/** 只由来源账本决定，不读字节：重试时据此找回登记信息。 */
const plan = async (store: Store, source: Mission, taskId: string): Promise<Entry[]> => {
  const tasks = (await store.queryTasks({ missionId: source.id })).toSorted((a, b) => a.id.localeCompare(b.id))
  const accepted = new Set((await store.listEvents(source.id))
    .filter((e) => e.event_type === 'REVIEW_ACCEPTED' && e.task_id).map((e) => e.task_id!))
  const entries: Entry[] = []
  const memories = new Set<string>()
  let inputs = 0, memoryCount = 0
  for (const task of tasks) {
    const artifacts = (await store.listArtifacts(task.id)).toSorted((a, b) => a.artifact_id.localeCompare(b.artifact_id))
    for (const artifact of artifacts) {
      if (artifact.mission_id !== source.id || artifact.task_id !== task.id || !artifactShareable(artifact)) continue
      const inResult = task.result?.artifacts.some((r) => r.artifact_id === artifact.artifact_id && r.sha256.toLowerCase() === artifact.sha256.toLowerCase())
      if (accepted.has(task.id) && task.state === 'COMPLETED' && inResult) {
        entries.push({ artifactId: `art_cont_${hash(JSON.stringify([taskId, artifact.artifact_id])).slice(0, 32)}`, role: 'continuation_input', version: ++inputs, source: artifact })
      } else if (artifact.role === MEMORY_ROLE && artifact.producer.agent_id === 'memross' && !memories.has(artifact.sha256)) {
        memories.add(artifact.sha256)
        entries.push({ artifactId: `art_cont_${hash(JSON.stringify([taskId, artifact.artifact_id])).slice(0, 32)}`, role: 'continuation_memory', version: ++memoryCount, source: artifact })
      }
    }
  }
  entries.push({ artifactId: `art_cont_${hash(JSON.stringify([taskId, 'handoff'])).slice(0, 32)}`, role: 'handoff', version: 1 })
  return entries
}

const uriFor = (artifactId: string): string => join('inputs', 'continues', hash(artifactId), INPUT_PAYLOAD)

const register = async (store: Store, mission: Mission, source: Mission, taskId: string, entry: Entry, bytes: Buffer, sha256: string): Promise<void> => {
  if ((await store.listArtifacts(taskId)).some((a) => a.artifact_id === entry.artifactId)) return
  const now = new Date()
  await store.putArtifact({
    artifact_id: entry.artifactId, mission_id: mission.id, task_id: taskId, role: entry.role, uri: uriFor(entry.artifactId),
    media_type: entry.source?.media_type ?? 'application/json', size_bytes: bytes.length, sha256, version: entry.version, state: 'AVAILABLE',
    producer: { agent_id: CONTINUATION_PRODUCER, adapter_version: 'mission-continuation/v1', execution_session_id: source.id },
    provenance: entry.source
      ? { source: 'continuation', source_mission_id: source.id, source_task_id: entry.source.task_id, source_artifact_id: entry.source.artifact_id, source_role: entry.source.role }
      : { source: 'continuation', source_mission_id: source.id },
    retention: { retain_until: new Date(now.getTime() + RETENTION_MS).toISOString(), immutable: true },
    security: { classification: 'internal', contains_secrets: false, contains_pii: false, allowed_roles: [] },
    created_at: now.toISOString(),
  })
}

/** 首次创建：复制字节、返回信封引用。登记在任务入账后由 registerContinuationInputs 完成。 */
export async function freezeContinuationInputs(store: Store, workRoot: string, source: Mission, taskId: string): Promise<Ref[]> {
  const { root, child } = await safeChildDir(workRoot, taskId)
  const refs: Ref[] = []
  for (const entry of await plan(store, source, taskId)) {
    const bytes = entry.source
      ? (await verifiedArtifactBytes(root, entry.source.task_id, entry.source)).bytes
      : Buffer.from(JSON.stringify(await buildHandoff(store, source, `续作来源 Mission 终态 ${source.state}`, workRoot), null, 2))
    await publishInput(await safeMkdir(child, ['inputs', 'continues', hash(entry.artifactId)]), bytes)
    refs.push({ artifact_id: entry.artifactId, uri: uriFor(entry.artifactId), role: entry.role, sha256: hash(bytes) })
  }
  return refs
}

/** 按信封里冻结的引用登记（重试时也走这里）：字节以工作区副本为准并复核散列。 */
export async function registerContinuationInputs(store: Store, workRoot: string, mission: Mission, source: Mission, taskId: string, refs: readonly Ref[]): Promise<void> {
  const { child } = await safeChildDir(workRoot, taskId)
  const entries = new Map((await plan(store, source, taskId)).map((e) => [e.artifactId, e]))
  for (const ref of refs) {
    const entry = entries.get(ref.artifact_id)
    if (!entry || entry.role !== ref.role || !ref.uri || !ref.sha256) continue
    const verified = await readVerifiedArtifact(child, { uri: ref.uri, role: ref.role, sha256: ref.sha256 })
    await register(store, mission, source, taskId, entry, verified.bytes, verified.sha256)
  }
}
