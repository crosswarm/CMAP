import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const schema = JSON.parse(readFileSync(new URL('../../schemas/quota-handoff.v1.schema.json', import.meta.url), 'utf8'))
const ajv = new Ajv({ strict: true, allErrors: true })
addFormats(ajv)
const validate = ajv.compile(schema)

const readOnly = {
  schema: 'cmap/quota-handoff/v1', node_id: 'root', from_task_id: 'dag_a', to_task_id: 'dag_b', handoff_index: 1,
  from_agent: 'codex', excluded_agents: ['codex'], risk_level: 'read-meta', workspace: 'fresh', snapshot: null, exit_proof: null,
}
const write = {
  ...readOnly, risk_level: 'mutating', workspace: 'snapshot',
  snapshot: { artifact_id: 'art_qh_1', sha256: 'a'.repeat(64), size_bytes: 10, file_count: 1 },
  exit_proof: { result_recorded: true, terminal_observed: true, status: 'failed', observed_at: '2026-10-23T00:00:00.000Z' },
}

test('quota-handoff 接受只读新工作区与写副作用快照两类记录', () => {
  for (const value of [readOnly, { ...readOnly, risk_level: 'read-sensitive' }, write, { ...write, risk_level: 'controlled' }]) {
    assert.equal(validate(value), true, JSON.stringify(validate.errors))
  }
})

test('quota-handoff 拒绝写副作用缺退出证明或快照、只读带快照、空排除与额外字段', () => {
  for (const value of [
    { ...write, exit_proof: null },
    { ...write, snapshot: null },
    { ...write, workspace: 'fresh' },
    { ...readOnly, workspace: 'snapshot' },
    { ...readOnly, snapshot: write.snapshot },
    { ...readOnly, excluded_agents: [] },
    { ...readOnly, handoff_index: 0 },
    { ...readOnly, prompt: 'x' },
    { ...write, exit_proof: { ...write.exit_proof, terminal_observed: false } },
    { ...write, snapshot: { ...write.snapshot, sha256: 'A'.repeat(64) } },
  ]) assert.equal(validate(value), false, JSON.stringify(value))
})
