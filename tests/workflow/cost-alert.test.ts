/**
 * Mission 级成本告警：累计 tokens 超过阈值时写一条 MISSION_COST_ALERT，只告警，不阻断执行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryStore } from '#domain-model'
import type { Mission, RemoteTaskBinding, TaskResultV1 } from '#domain-model'
import { createActivities } from '../../workflows/activities.ts'
import { FakeAdapter, syntheticActivityDeps, syntheticRunner } from './fake-adapter.ts'

const ACTOR = { type: 'system', id: 'test' } as const
const T0 = '2026-10-23T00:00:00.000Z'

class CostAdapter extends FakeAdapter {
  readonly tokens: number | undefined
  constructor(tokens: number | undefined) { super(); this.tokens = tokens }
  override async collectResult(binding: RemoteTaskBinding): Promise<TaskResultV1> {
    const result = await super.collectResult(binding)
    return { ...result, cost: this.tokens === undefined ? { duration_seconds: 1 } : { tokens: this.tokens, duration_seconds: 1 } }
  }
}

async function setup(tokens: number | undefined, threshold: number | undefined) {
  const store = new MemoryStore()
  const mission: Mission = {
    id: 'mis-cost', tenant: 'team-ycc', owner: 'crosswarm', type: 'inspect', goal: '统计 sample/ 下的文件数', constraints: {},
    acceptance: [{ criterion_id: 'FILE-COUNT', metric: 'sample_file_count', operator: 'eq', expected: 3, hard_gate: true }],
    workflow_template: 'inspect/v1', state: 'DRAFT', revision: 1, created_at: T0, updated_at: T0,
  }
  await store.createMission({ mission, actor: ACTOR })
  const acts = createActivities(syntheticActivityDeps({
    store, adapter: new CostAdapter(tokens), runner: syntheticRunner({ runner_id: 'runner-test' }), pollIntervalMs: 1,
    ...(threshold === undefined ? {} : { missionCostAlertTokens: threshold }),
  }))
  let n = 0
  const run = async () => {
    const { taskId } = await acts.createTask({ missionId: mission.id, capability: 'code.analyze', goal: '统计 sample/ 下的文件数', creationKey: `k${++n}` })
    await acts.markReady(taskId)
    await acts.dispatchTask(taskId)
    const out = await acts.collectTaskResult(taskId)
    assert.ok(!('executionUncertain' in out))
    return out
  }
  const alerts = async () => (await store.listEvents(mission.id)).filter((e) => e.event_type === 'MISSION_COST_ALERT')
  return { run, alerts }
}

test('Mission 累计 tokens 超过阈值：写一条告警，任务照常收结果；再超不重复告警', async () => {
  const { run, alerts } = await setup(80, 100)
  const first = await run()
  assert.equal(first.passed, true)
  assert.equal((await alerts()).length, 0, '80 未超过 100')

  const second = await run()
  assert.equal(second.passed, true, '告警不阻断执行')
  const [alert] = await alerts()
  assert.equal(alert?.payload['total_tokens'], 160)
  assert.equal(alert?.payload['threshold_tokens'], 100)

  await run()
  assert.equal((await alerts()).length, 1, '每个 Mission 至多一条')
})

test('未配置阈值，或任务没有 tokens 用量时不告警', async () => {
  const noThreshold = await setup(10_000, undefined)
  await noThreshold.run()
  assert.equal((await noThreshold.alerts()).length, 0)

  const noUsage = await setup(undefined, 1)
  await noUsage.run()
  assert.equal((await noUsage.alerts()).length, 0)
})
