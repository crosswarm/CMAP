/**
 * 硬门槛判定产出的决策必须满足 review-decision v1。
 *
 * 类型检查通过不代表满足契约：条件必填（rework 必须带 failed_criteria）
 * 无法用结构类型表达，只有 ajv 校验能证明下游收得下这份决策。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { MemoryStore } from '#domain-model'
import { createActivities } from '../../workflows/activities.ts'
import { FakeAdapter, syntheticRunner, syntheticActivityDeps } from '../workflow/fake-adapter.ts'

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), '../../schemas')
const ajv = new Ajv({ strict: true, allErrors: true })
addFormats(ajv)
const validate = ajv.compile(
  JSON.parse(readFileSync(join(schemaDir, 'review-decision.v1.schema.json'), 'utf8')),
)

const ACTOR = { type: 'system', id: 'test' }
const T0 = '2026-08-25T00:00:00.000Z'

const setup = async (failNext) => {
  const store = new MemoryStore()
  const adapter = new FakeAdapter()
  adapter.failNext = failNext
  const acts = createActivities(syntheticActivityDeps({ store, adapter, runner:syntheticRunner(), pollIntervalMs: 1 }))

  await store.createMission({
    mission: {
      id: 'mis-1', tenant: 'team-ycc', owner: 'crosswarm', type: 'inspect',
      goal: '统计文件数', constraints: {},
      acceptance: [
        { criterion_id: 'FILE-COUNT', metric: 'count', operator: 'eq', expected: 3, hard_gate: true },
      ],
      workflow_template: 'inspect/v1', state: 'DRAFT', revision: 1,
      created_at: T0, updated_at: T0,
    },
    actor: ACTOR,
  })

  const { taskId } = await acts.createTask({ missionId: 'mis-1', capability: 'code.analyze' })
  await acts.markReady(taskId)
  await acts.dispatchTask(taskId)
  await acts.collectTaskResult(taskId)
  return acts.evaluateHardGate({ taskId, round: 0 })
}

describe('硬门槛决策的契约一致性', () => {
  test('accept 决策符合 review-decision v1', async () => {
    const { decision } = await setup(0)
    assert.equal(decision.decision, 'accept')
    assert.ok(validate(decision), `不符合契约：${JSON.stringify(validate.errors)}`)
  })

  test('rework 决策符合 review-decision v1，且带失败清单与后继任务', async () => {
    const { decision } = await setup(1)
    assert.equal(decision.decision, 'rework')
    assert.ok(validate(decision), `不符合契约：${JSON.stringify(validate.errors)}`)
    assert.ok(decision.failed_criteria?.length > 0, 'rework 必须说明哪条没过')
    assert.ok(decision.required_followups?.length > 0, 'rework 必须给出后继任务')
  })
})
