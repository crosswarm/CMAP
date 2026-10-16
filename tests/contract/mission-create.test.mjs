import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const read = (name) => JSON.parse(readFileSync(new URL(`../../schemas/${name}.v1.schema.json`, import.meta.url)))
const ajv = new Ajv({ strict: true })
addFormats(ajv)
ajv.addSchema(read('task-envelope'), 'https://cmap.local/schemas/task-envelope.v1.schema.json')
ajv.addSchema(read('mission-plan'), 'https://cmap.local/schemas/mission-plan.v1.schema.json')
const validate = ajv.compile(read('mission-create'))
const validateResponse = ajv.compile(read('mission-submission'))

test('创建契约复用派发验收定义、要求显式风险和请求键，不接受身份自述', () => {
  const valid = { request_id: 'synthetic-request', goal: 'Count files', risk_level: 'read-meta',
    acceptance: [{ criterion_id: 'files', metric: 'count', operator: 'eq', expected: 3 }] }
  assert.equal(validate(valid), true)
  for (const patch of [{ tenant: 'forged' }, { owner: 'forged' }, { request_id: 'bad' }, { goal: ' ' },
    { acceptance: [] }, { risk_level: undefined }, { max_additional_cycles: 11 }]) {
    assert.equal(validate({ ...valid, ...patch }), false)
  }
  assert.equal(validate({ ...valid, acceptance: [{ ...valid.acceptance[0], operator: 'guess' }] }), false)
  assert.equal(validateResponse({ accepted: true, mission_id: 'm1', workflow_id: 'mission-m1' }), true)
  assert.equal(validateResponse({ accepted: true, mission_id: 'm1' }), false)
})

test('memory 只接受规范的项目 ID 与受限的检索参数', () => {
  const valid = { request_id: 'synthetic-request', goal: 'Count files', risk_level: 'read-meta',
    acceptance: [{ criterion_id: 'files', metric: 'count', operator: 'eq', expected: 3 }] }
  assert.equal(validate({ ...valid, memory: { project_id: 'prj_aiworkbench_dev' } }), true)
  assert.equal(validate({ ...valid, memory: { project_id: 'prj_a', query: '刷新写回', limit: 5 } }), true)
  for (const memory of [{}, { project_id: 'repo_a' }, { project_id: 'prj_A' }, { project_id: 'prj_a', limit: 6 },
    { project_id: 'prj_a', query: ' ' }, { project_id: 'prj_a', query: 'x'.repeat(501) }, { project_id: 'prj_a', token: 'forged' }]) {
    assert.equal(validate({ ...valid, memory }), false, JSON.stringify(memory))
  }
})
