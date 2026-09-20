import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const read = (name) => JSON.parse(readFileSync(new URL(`../../schemas/${name}.v1.schema.json`, import.meta.url)))
const ajv = new Ajv({ strict: true })
addFormats(ajv)
ajv.addSchema(read('task-envelope'), 'https://cmap.local/schemas/task-envelope.v1.schema.json')
const validatePlan = ajv.compile(read('mission-plan'))
const validateCreate = ajv.compile(read('mission-create'))

const plan = {
  schema: 'cmap/mission-plan/v1',
  nodes: [
    { node_id: 'A', goal: 'Collect A', capability: 'code.inspect', deps: [], criterion_ids: ['a'], risk_level: 'read-meta' },
    { node_id: 'Join', goal: 'Join evidence', capability: 'code.review', deps: ['A'], criterion_ids: ['b'], risk_level: 'read-sensitive',
      required_resource_locks: [{ resource: 'worktree:/path', ttl_seconds: 15 }] },
  ],
}

test('mission plan schema accepts declared DAG shape and mission-create remains backward compatible', () => {
  assert.equal(validatePlan(plan), true, JSON.stringify(validatePlan.errors, null, 2))
  assert.equal(validateCreate({
    request_id: 'synthetic-request',
    goal: 'old request',
    risk_level: 'read-meta',
    acceptance: [{ criterion_id: 'a', metric: 'done', operator: 'eq', expected: true }],
  }), true)
  assert.equal(validateCreate({
    request_id: 'synthetic-request',
    goal: 'new request',
    risk_level: 'read-sensitive',
    acceptance: [
      { criterion_id: 'a', metric: 'a', operator: 'eq', expected: true },
      { criterion_id: 'b', metric: 'b', operator: 'eq', expected: true },
    ],
    plan,
  }), true, JSON.stringify(validateCreate.errors, null, 2))
})

test('mission plan schema accepts real resource lock names from the envelope contract', () => {
  for (const resource of ['worktree:/path', 'yonwork:tenant']) {
    assert.equal(validatePlan({
      ...plan,
      nodes: [{ ...plan.nodes[0], required_resource_locks: [{ resource, ttl_seconds: 60 }] }],
    }), true, JSON.stringify(validatePlan.errors, null, 2))
  }
})

test('mission plan schema rejects unsafe ids, hidden control-plane fields, and TTL outside renewal bounds', () => {
  assert.equal(validatePlan({ ...plan, nodes: [{ ...plan.nodes[0], node_id: '1bad' }] }), false)
  assert.equal(validatePlan({ ...plan, nodes: [{ ...plan.nodes[0], owner: 'forged' }] }), false)
  assert.equal(validatePlan({
    ...plan,
    nodes: [{ ...plan.nodes[0], required_resource_locks: [{ resource: 'Device_1', ttl_seconds: 14 }] }],
  }), false)
  assert.equal(validatePlan({
    ...plan,
    nodes: [{ ...plan.nodes[0], required_resource_locks: [{ resource: 'Device_1', ttl_seconds: 3601 }] }],
  }), false)
})
