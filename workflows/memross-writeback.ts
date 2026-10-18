/**
 * Mission 结论回写 Memross（实施计划 S5 协作 / 交接）。
 *
 * 只在 Activity 里调用。两类写入都是旁路：Memross 拒绝或不可达时记一条失败事件，
 * 绝不影响 Mission 结果。令牌只进 Authorization 头；事件只存 ID、状态与错误类别，
 * 不存结论正文（正文已在任务结果里）。
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { recomputeCriterionPassed, type Mission, type Store, type TaskRecord } from '#domain-model'
import { readVerifiedArtifact } from '../packages/adapter-sdk/src/structured-output.ts'
import { MEMORY_ROLE, memoryManifest, type MemoryDeps } from './memory-context.ts'

const ACTOR = { type: 'system', id: 'memross-writeback' } as const
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const MAX_PROPOSALS_PER_TASK = 5
const MAX_EVIDENCE = 20
const SAFE_SEGMENT = /[^A-Za-z0-9._-]/g

/** Memross 只接受 cmap-artifact:<段>/<段>，段为 [A-Za-z0-9._-]{1,128}；账本 artifact_id 含冒号，按位替换。 */
export const cmapArtifactUri = (taskId: string, artifactId: string): string =>
  `cmap-artifact:${taskId.replace(SAFE_SEGMENT, '.').slice(0, 128)}/${artifactId.replace(SAFE_SEGMENT, '.').slice(0, 128)}`

/**
 * 逻辑键是 missionId:taskId:i；Memross 限 128 字符而两段 ID 各 68 字符，
 * 所以对前两段取散列（确定性，同一结论重试得到同一键）。
 */
export const knowledgeIdempotencyKey = (missionId: string, taskId: string, index: number): string =>
  `cmap:${sha256(`${missionId}:${taskId}`).slice(0, 40)}:${index}`

type PostResult = { ok: true; data: any } | { ok: false; code: string }

async function post(deps: MemoryDeps, op: 'propose' | 'handoff', body: unknown): Promise<PostResult> {
  let response: Response
  try {
    response = await (deps.fetch ?? fetch)(`${deps.url.replace(/\/+$/, '')}/api/memory/v1/${op}`, {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${deps.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    })
  } catch {
    return { ok: false, code: 'MEMORY_UNAVAILABLE' }
  }
  const data: any = await response.json().catch(() => null)
  if (response.ok && data && typeof data === 'object') return { ok: true, data }
  const code = typeof data?.code === 'string' && /^[A-Z_]{1,40}$/.test(data.code) ? data.code : `HTTP_${response.status}`
  return { ok: false, code }
}

const event = async (store: Store, task: { mission_id: string; id: string | null; attempt: number | null },
  type: 'KNOWLEDGE_PROPOSED' | 'KNOWLEDGE_PROPOSAL_FAILED' | 'HANDOFF_RECORDED' | 'HANDOFF_FAILED',
  key: string, payload: Record<string, unknown>): Promise<void> => {
  await store.appendEvent({ event: {
    event_type: type, event_version: 1, occurred_at: new Date().toISOString(),
    mission_id: task.mission_id, task_id: task.id, attempt: task.attempt, actor: ACTOR,
    causation_id: null, correlation_id: task.mission_id, trace_id: task.id, idempotency_key: key, payload,
  } })
}

/** 任务所属 Memross 项目：DAG 节点 memory 优先，其次 Mission memory；都没有则不回写。 */
export const memoryProjectFor = (mission: Mission, task?: TaskRecord): string | null => {
  const plan = mission.constraints['plan'] as { nodes?: { node_id: string; memory?: { project_id: string } }[] } | undefined
  const nodeId = task?.envelope.identity.plan_node_id
  const node = nodeId ? plan?.nodes?.find((n) => n.node_id === nodeId) : undefined
  const missionMemory = mission.constraints['memory'] as { project_id?: string } | undefined
  return node?.memory?.project_id ?? missionMemory?.project_id ?? plan?.nodes?.find((n) => n.memory)?.memory?.project_id ?? null
}

/** 任务用到的记忆块（来自其冻结快照的清单），仅限同一项目。读不到快照时返回空，不阻断回写。 */
export const usedMemoryBlocks = async (workRoot: string | undefined, task: TaskRecord, projectId: string) => {
  if (!workRoot) return []
  const blocks: { document_id: string; revision_id: string; block_id: string; body_sha256: string }[] = []
  for (const ref of task.envelope.inputs?.artifact_refs ?? []) {
    // 自己冻结的快照，或续作继承的来源快照。经 review input 继承的副本在 inputs/review 下同样可读。
    if ((ref.role !== MEMORY_ROLE && ref.role !== 'continuation_memory') || !ref.uri || !ref.sha256) continue
    try {
      const { bytes } = await readVerifiedArtifact(join(workRoot, task.id), { uri: ref.uri, role: ref.role, sha256: ref.sha256 })
      const manifest = memoryManifest(bytes)
      if (manifest?.project_id === projectId) blocks.push(...(manifest.items ?? []))
    } catch { /* 快照不可读：只少带一类证据 */ }
  }
  return blocks
}

export async function proposeTaskKnowledge(
  deps: { store: Store; workRoot?: string; memory?: MemoryDeps },
  input: { missionId: string; taskId: string },
): Promise<void> {
  const { store } = deps
  const [mission, task] = await Promise.all([store.getMission(input.missionId), store.getTask(input.taskId)])
  if (!mission || !task || task.mission_id !== mission.id || task.state !== 'COMPLETED' || !task.result) return
  if (task.result.status !== 'completed') return
  const events = await store.listEvents(mission.id)
  // 只回写验收通过的结论；返工轮落 COMPLETED 的任务不算。
  if (!events.some((e) => e.task_id === task.id && e.event_type === 'REVIEW_ACCEPTED')) return
  const projectId = memoryProjectFor(mission, task)
  if (!projectId || !deps.memory) return

  const items = [
    ...(task.result.findings ?? []).filter((f) => f.severity !== 'info')
      .map((f) => ({ kind: 'pitfall' as const, title: `[${f.code}] ${f.description}`, text: f.description, detail: `严重度：${f.severity}` })),
    ...(task.result.recommended_followups ?? [])
      .map((r) => ({ kind: 'procedure' as const, title: r.reason, text: r.reason, detail: `适用能力：${r.capability}` })),
  ].slice(0, MAX_PROPOSALS_PER_TASK)
  if (items.length === 0) return

  const artifacts = (await store.listArtifacts(task.id)).filter((a) => a.state === 'AVAILABLE' &&
    task.result!.artifacts.some((r) => r.artifact_id === a.artifact_id && r.sha256.toLowerCase() === a.sha256.toLowerCase()))
  const artifactEvidence = artifacts.map((a) => ({ uri: cmapArtifactUri(task.id, a.artifact_id), sha256: a.sha256.toLowerCase() }))
  const blockEvidence = (await usedMemoryBlocks(deps.workRoot, task, projectId))
    .map((b) => ({ uri: `memross-block:${b.document_id}/${b.revision_id}/${b.block_id}`, sha256: b.body_sha256 }))
  if (artifactEvidence.length === 0 && blockEvidence.length === 0) return

  for (const [index, item] of items.entries()) {
    const receiptKey = `knowledge-proposed:${task.id}:${index}`
    if (events.some((e) => e.idempotency_key === receiptKey)) continue
    const body = (evidence: { uri: string; sha256: string }[]) => ({
      scope: { project_id: projectId },
      idempotency_key: knowledgeIdempotencyKey(mission.id, task.id, index),
      kind: item.kind,
      title: item.title.slice(0, 200),
      body: `${item.text}\n\n${item.detail}\n\n来源：CMAP Mission ${mission.id} 任务 ${task.id}（${task.capability}）经硬门槛验收通过后由 Agent 给出的结论，尚未经人工复核。`,
      applicability: `CMAP ${task.capability} 任务；依据见证据所列产物与记忆块。`,
      evidence: evidence.slice(0, MAX_EVIDENCE),
    })
    let result = await post(deps.memory, 'propose', body([...artifactEvidence, ...blockEvidence]))
    // 快照里的块可能已被新版本取代：退回只带 CMAP 产物证据，仍进入 intake 待核验。
    if (!result.ok && result.code === 'EVIDENCE_REJECTED' && blockEvidence.length > 0 && artifactEvidence.length > 0) {
      result = await post(deps.memory, 'propose', body(artifactEvidence))
    }
    if (result.ok) {
      await event(store, task, 'KNOWLEDGE_PROPOSED', receiptKey, {
        index, kind: item.kind, project_id: projectId,
        proposal_id: String(result.data.proposal_id ?? ''), status: String(result.data.status ?? ''),
        evidence_status: String(result.data.evidence_status ?? ''), duplicate_of: result.data.duplicate_of ?? null,
      })
    } else {
      await event(store, task, 'KNOWLEDGE_PROPOSAL_FAILED', `knowledge-proposal-failed:${task.id}:${index}:${result.code}`, { index, code: result.code })
    }
  }
}

/**
 * 交接内容只从账本推出：失败标准、证据链接（artifact URI + 散列）、绑定状态。
 * 不含目标原文以外的提示词或 Agent 自然语言；续作 Mission 复用同一份。
 */
export async function buildHandoff(store: Store, mission: Mission, reason: string, workRoot?: string) {
  const tasks = (await store.queryTasks({ missionId: mission.id })).toSorted((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  const reviews = await store.listReviews(mission.id)
  const done: string[] = [], failed: string[] = [], evidence: string[] = [], bindings: string[] = []
  const blockIds = new Set<string>()
  const projectId = memoryProjectFor(mission)
  for (const task of tasks) {
    const accepted = reviews.some((r) => r.reviewed_task_ids.includes(task.id) && r.decision.decision === 'accept')
    if (accepted && task.state === 'COMPLETED') done.push(`${task.id}（${task.capability}）已通过验收`)
    // 失败标准由控制面按信封标准重新判定，不取 Agent 的 passed 自述；无评审的升级（执行不确定等）同样适用。
    if (task.result && !accepted) {
      const answered = new Map(task.result.criterion_results.map((c) => [c.criterion_id, c]))
      for (const c of task.envelope.goal.success_definition) {
        if (recomputeCriterionPassed(c, answered.get(c.criterion_id))) continue
        const got = answered.get(c.criterion_id)
        failed.push(`${task.id} ${c.criterion_id}：期望 ${c.metric} ${c.operator} ${JSON.stringify(c.expected)}，实测 ${got ? JSON.stringify(got.actual).slice(0, 200) : '未回应'}`)
      }
      if (task.result.status !== 'completed') failed.push(`${task.id}：status=${task.result.status}${task.result.error?.code ? ` code=${task.result.error.code}` : ''}`)
    }
    for (const art of await store.listArtifacts(task.id)) {
      if (art.state === 'AVAILABLE') evidence.push(`${cmapArtifactUri(task.id, art.artifact_id)} role=${art.role} sha256=${art.sha256}`)
    }
    bindings.push(`${task.id}: state=${task.state} binding=${task.binding ? `${task.binding.adapter}@${task.binding.runner_id}` : 'none'} result=${task.result?.status ?? 'none'}`)
    if (projectId) for (const block of await usedMemoryBlocks(workRoot, task, projectId)) blockIds.add(block.block_id)
  }
  const handoffId = (await store.listEvents(mission.id)).find((e) => e.event_type === 'HANDOFF_RECORDED')?.payload['handoff_id']
  return {
    goal: mission.goal,
    state: `CMAP Mission ${mission.id} 终态 ${mission.state}：${reason}\n${bindings.join('\n')}`,
    done,
    todo: mission.state === 'COMPLETED' ? [] : ['人工复核失败标准与证据，决定是否续作'],
    failed_attempts: failed,
    next_steps: [`以 continues_mission_id=${mission.id} 创建续作 Mission；新 Mission 首任务会收到本 Mission 已接受的产物、本交接内容与记忆快照`],
    verification: evidence.join('\n'),
    refs: { mission_ids: [mission.id], block_ids: [...blockIds] },
    ...(typeof handoffId === 'string' ? { handoff_id: handoffId } : {}),
  }
}

export async function recordEscalationHandoff(
  deps: { store: Store; workRoot?: string; memory?: MemoryDeps },
  input: { missionId: string; reason: string },
): Promise<void> {
  const mission = await deps.store.getMission(input.missionId)
  if (!mission) return
  const ref = { mission_id: mission.id, id: null, attempt: null }
  const key = `handoff-recorded:${mission.id}`
  if ((await deps.store.listEvents(mission.id)).some((e) => e.idempotency_key === key)) return
  const projectId = memoryProjectFor(mission)
  if (!projectId || !deps.memory) {
    await event(deps.store, ref, 'HANDOFF_FAILED', `handoff-failed:${mission.id}:NO_PROJECT_SCOPE`, { code: deps.memory ? 'NO_PROJECT_SCOPE' : 'MEMORY_NOT_CONFIGURED' })
    return
  }
  const { handoff_id: _ignored, ...handoff } = await buildHandoff(deps.store, mission, input.reason.slice(0, 1000), deps.workRoot)
  const result = await post(deps.memory, 'handoff', { op: 'put', scope: { project_id: projectId }, ...handoff })
  if (result.ok && typeof result.data.handoff_id === 'string') {
    await event(deps.store, ref, 'HANDOFF_RECORDED', key, { handoff_id: result.data.handoff_id, project_id: projectId })
  } else {
    await event(deps.store, ref, 'HANDOFF_FAILED', `handoff-failed:${mission.id}:${result.ok ? 'BAD_RESPONSE' : result.code}`, { code: result.ok ? 'BAD_RESPONSE' : result.code })
  }
}
