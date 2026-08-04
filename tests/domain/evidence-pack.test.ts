import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryStore, buildEvidencePack } from '#domain-model'
import type { Mission, TaskRecord, Artifact, EventActor, Store } from '#domain-model'

const ACTOR: EventActor = { type: 'system', id: 'test' }
const T0 = '2026-08-04T00:00:00.000Z'

const mission = (id: string): Mission => ({
  id, tenant: 'team-ycc', owner: 'crosswarm', type: 'perf',
  goal: '首屏优化', constraints: {},
  acceptance: [{ criterion_id: 'PERF', metric: 'p95', operator: 'lte', expected: 1800, hard_gate: true }],
  workflow_template: 'perf/v1', state: 'RUNNING', revision: 1,
  created_at: T0, updated_at: T0,
})

const task = (id: string, missionId: string): TaskRecord => ({
  id, mission_id: missionId, parent_task_id: null, supersedes_task_id: null,
  capability: 'code.analyze', risk: 'read-meta', state: 'DRAFT',
  attempt: 1, max_attempts: 1, lamport: 0,
  envelope: {} as TaskRecord['envelope'],
  result: null, binding: null, deps: [],
  created_at: T0, updated_at: T0,
})

const artifact = (id: string, taskId: string, role: string): Artifact => ({
  artifact_id: id, mission_id: 'mis-1', task_id: taskId, role,
  uri: `artifact://mis-1/${taskId}/${role}.json`,
  media_type: 'application/json', size_bytes: 64,
  sha256: 'b'.repeat(64), version: 1, state: 'AVAILABLE',
  producer: { agent_id: 'codex', adapter_version: '0.1.0', execution_session_id: 's1' },
  provenance: {}, retention: { retain_until: '2027-01-01T00:00:00.000Z', immutable: true },
  security: { classification: 'internal', contains_secrets: false, contains_pii: false, allowed_roles: [] },
  created_at: T0,
})

const seed = async (): Promise<Store> => {
  const s = new MemoryStore()
  await s.createMission({ mission: mission('mis-1'), actor: ACTOR })
  await s.createTask({ task: task('tsk-1', 'mis-1'), actor: ACTOR })
  await s.createTask({ task: task('tsk-2', 'mis-1'), actor: ACTOR })
  await s.putArtifact(artifact('art-before', 'tsk-1', 'measure_before'))
  await s.putArtifact(artifact('art-after', 'tsk-2', 'measure_after'))
  await s.putArtifact(artifact('art-diff', 'tsk-2', 'metric_diff'))
  return s
}

describe('Evidence Pack', () => {
  test('按 task 聚合证据，归属正确不串号', async () => {
    const s = await seed()
    const pack = await buildEvidencePack(s, 'mis-1')

    assert.equal(pack.missionId, 'mis-1')
    assert.equal(pack.tasks.length, 2)

    const t1 = pack.tasks.find((t) => t.taskId === 'tsk-1')!
    const t2 = pack.tasks.find((t) => t.taskId === 'tsk-2')!

    assert.deepEqual(t1.artifacts.map((a) => a.artifact_id), ['art-before'])
    assert.deepEqual(
      t2.artifacts.map((a) => a.artifact_id).sort(),
      ['art-after', 'art-diff'],
    )
  })

  test('包含血缘边，可追溯结论到原始证据', async () => {
    const s = await seed()
    await s.linkArtifacts({
      source_artifact_id: 'art-diff',
      target_artifact_id: 'art-before',
      relation: 'DERIVED_FROM',
    })
    await s.linkArtifacts({
      source_artifact_id: 'art-diff',
      target_artifact_id: 'art-after',
      relation: 'DERIVED_FROM',
    })

    const pack = await buildEvidencePack(s, 'mis-1')

    assert.equal(pack.edges.length, 2, '血缘边缺失会让「这个结论基于哪些证据」无法回答')
    assert.ok(pack.edges.every((e) => e.source_artifact_id === 'art-diff'))
  })

  test('无任何证据时返回空 tasks，不抛错', async () => {
    const s = new MemoryStore()
    await s.createMission({ mission: mission('mis-empty'), actor: ACTOR })

    const pack = await buildEvidencePack(s, 'mis-empty')
    assert.deepEqual(pack.tasks, [])
    assert.deepEqual(pack.edges, [])
  })

  test('携带任务的验收结论，供评审直接判定', async () => {
    const s = await seed()
    // 模拟 codex 回报的结果落库
    const t = await s.getTask('tsk-2')
    await s.setTaskBinding('tsk-2', {
      adapter: 'codex-adapter', remote_task_id: 'r1',
      protocol: 'codex-exec', protocol_version: '0.1.0', runner_id: 'runner-1',
    })
    assert.ok(t)

    const pack = await buildEvidencePack(s, 'mis-1')
    const t2 = pack.tasks.find((x) => x.taskId === 'tsk-2')!
    assert.ok(Array.isArray(t2.criterionResults), 'criterionResults 必须存在，无结果时为空数组')
  })

  test('不存在的 Mission 抛错而非返回空包', async () => {
    const s = new MemoryStore()
    await assert.rejects(
      () => buildEvidencePack(s, 'no-such'),
      '静默返回空包会让调用方以为「这个 Mission 没有证据」，而实际是 Mission 不存在',
    )
  })
})
