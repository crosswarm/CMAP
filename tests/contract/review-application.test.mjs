import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const ajv = new Ajv({ strict: false, allErrors: true })
addFormats(ajv)
const validate = ajv.compile(JSON.parse(readFileSync(new URL('../../schemas/review-application.v1.schema.json', import.meta.url))))

const base = {
  schema: 'cmap/review-application/v1',
  phase: 'complete',
  round: 1,
  input_sha256: 'a'.repeat(64),
  review_id: 'rev_1',
  output: { outcome: 'accept', followupTaskIds: [] },
}

test('review application receipt accepts only bounded recovery metadata', () => {
  assert.equal(validate(base), true, JSON.stringify(validate.errors, null, 2))
  for (const invalid of [
    { ...base, decision: { decision: 'accept' } },
    { ...base, progress: { patchHash: 'raw' } },
    { ...base, output: { ...base.output, prompt: 'raw prompt' } },
    { ...base, input_sha256: 'not-a-sha' },
    { ...base, output: { outcome: 'rework', followupTaskIds: [] } },
    { ...base, output: { outcome: 'escalated', followupTaskIds: [] } },
  ]) {
    assert.equal(validate(invalid), false, JSON.stringify(invalid))
  }
})

test('review application receipt enforces branch-specific output shape', () => {
  assert.equal(validate({
    ...base,
    output: { outcome: 'rework', followupTaskIds: ['tsk_1'] },
  }), true, JSON.stringify(validate.errors, null, 2))
  assert.equal(validate({
    ...base,
    output: { outcome: 'escalated', followupTaskIds: [], escalationReason: 'MAX_CYCLES' },
  }), true, JSON.stringify(validate.errors, null, 2))
})
