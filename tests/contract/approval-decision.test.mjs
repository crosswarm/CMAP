import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const ajv = new Ajv({ strict: true })
addFormats(ajv)
const validate = ajv.compile(JSON.parse(readFileSync(new URL('../../schemas/approval-decision-input.v1.schema.json', import.meta.url))))

test('审批终态转换契约：不允许 pending、空白身份或无效时间', () => {
  const input = { decision: 'approved', decided_by: 'user:test', at: '2026-09-20T00:00:00Z' }
  assert.equal(validate(input), true)
  for (const patch of [{ decision: 'pending' }, { decided_by: '  ' }, { at: 'invalid' }, { extra: true }]) {
    assert.equal(validate({ ...input, ...patch }), false)
  }
})
