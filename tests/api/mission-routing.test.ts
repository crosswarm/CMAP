import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'

import { MemoryStore } from '#domain-model'
import type { Mission } from '#domain-model'
import { createControlPlane } from '../../apps/control-plane-api/src/server.ts'
import { missionFromRequest } from '../../apps/control-plane-api/src/mission-submission.ts'
import { workflowTypeForTemplate } from '../../apps/control-plane-api/src/workflow-routing.ts'

const legacyInput = {
  request_id: 'route-legacy',
  goal: 'Count synthetic files',
  risk_level: 'read-meta',
  acceptance: [{ criterion_id: 'files', metric: 'count', operator: 'eq', expected: 3 }],
}

const dagInput = {
  ...legacyInput,
  request_id: 'route-dag',
  plan: {
    schema: 'cmap/mission-plan/v1',
    nodes: [
      {
        node_id: 'count',
        goal: 'Count files',
        capability: 'code.analyze',
        deps: [],
        criterion_ids: ['files'],
        risk_level: 'read-meta',
      },
    ],
  },
}

const mission = (id: string, template: string): Mission => ({
  id,
  tenant: 'local',
  owner: 'configured-owner',
  type: 'inspect',
  goal: 'Recover existing mission',
  constraints: {},
  acceptance: [{ criterion_id: 'files', metric: 'count', operator: 'eq', expected: 3, hard_gate: true }],
  workflow_template: template,
  state: 'DRAFT',
  revision: 1,
  created_at: '2026-09-21T00:00:00.000Z',
  updated_at: '2026-09-21T00:00:00.000Z',
})

const setup = async (t: TestContext) => {
  const store = new MemoryStore()
  const starts: { missionId: string; workflowType: string }[] = []
  const server = await createControlPlane({
    store,
    tenant: 'local',
    owner: 'configured-owner',
    startMission: async (missionId) => {
      const saved = await store.getMission(missionId)
      if (!saved) throw new Error(`Mission missing: ${missionId}`)
      starts.push({ missionId, workflowType: workflowTypeForTemplate(saved.workflow_template) })
    },
  })
  await server.listen(0)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = async (body: unknown, path = '/v1/missions') => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  return { store, starts, post }
}

test('不带 plan 的创建合成单节点 mission-plan 并启动 dag/v1', async (t) => {
  const { store, starts, post } = await setup(t)
  const created = await post({ ...legacyInput, request_id: 'route-synth', max_additional_cycles: 1, memory: { project_id: 'prj_a', query: '刷新写回' } })
  assert.equal(created.status, 202)
  const id = created.body['mission_id'] as string
  assert.deepEqual(starts.at(-1), { missionId: id, workflowType: 'dagMissionWorkflow' })
  const saved = (await store.getMission(id))!
  assert.equal(saved.workflow_template, 'dag/v1')
  assert.equal(saved.type, 'inspect')
  assert.deepEqual(saved.constraints, {
    risk_level: 'read-meta',
    max_additional_cycles: 1,
    plan: {
      schema: 'cmap/mission-plan/v1',
      concurrency: 2,
      nodes: [{
        node_id: 'main', goal: legacyInput.goal, capability: 'code.analyze', deps: [], criterion_ids: ['files'],
        risk_level: 'read-meta', memory: { project_id: 'prj_a', query: '刷新写回', limit: 3 }, required_resource_locks: [],
      }],
    },
    memory: { project_id: 'prj_a', query: '刷新写回', limit: 3 },
  })
})

test('S01 之前存为 inspect/v1 的不带 plan 请求：原键重试沿用旧记录与旧 Workflow 类型，改语义仍 409', async (t) => {
  const { store, starts, post } = await setup(t)
  const current = missionFromRequest(legacyInput, 'local', 'configured-owner')
  const { plan: _plan, ...constraints } = current.constraints
  await store.createMission({ mission: { ...current, constraints, workflow_template: 'inspect/v1' }, actor: { type: 'system', id: 'test' } })
  const replay = await post(legacyInput)
  assert.equal(replay.status, 202)
  assert.deepEqual(starts.at(-1), { missionId: current.id, workflowType: 'missionWorkflow' })
  assert.equal((await store.getMission(current.id))!.workflow_template, 'inspect/v1')
  assert.equal((await post({ ...legacyInput, goal: 'changed goal' })).status, 409)
  assert.equal((await post({ ...legacyInput, plan: dagInput.plan })).status, 409)
  assert.equal(starts.length, 1)
})

test('stored workflow_template routes create and DRAFT resume to the matching Workflow type', async (t) => {
  const { store, starts, post } = await setup(t)

  const legacy = await post(legacyInput)
  assert.equal(legacy.status, 202)
  assert.equal(starts.at(-1)?.workflowType, 'dagMissionWorkflow')

  const dag = await post(dagInput)
  assert.equal(dag.status, 202)
  assert.equal(starts.at(-1)?.workflowType, 'dagMissionWorkflow')

  await store.createMission({ mission: mission('draft-dag', 'dag/v1'), actor: { type: 'system', id: 'test' } })
  const resumed = await post({}, '/v1/missions/draft-dag/start')
  assert.equal(resumed.status, 202)
  assert.deepEqual(starts.at(-1), { missionId: 'draft-dag', workflowType: 'dagMissionWorkflow' })

  // 已入账的 inspect/v1 历史记录仍按其模板启动，不改道。
  await store.createMission({ mission: mission('draft-inspect', 'inspect/v1'), actor: { type: 'system', id: 'test' } })
  assert.equal((await post({}, '/v1/missions/draft-inspect/start')).status, 202)
  assert.deepEqual(starts.at(-1), { missionId: 'draft-inspect', workflowType: 'missionWorkflow' })
})
