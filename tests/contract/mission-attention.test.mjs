import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Ajv from 'ajv/dist/2020.js'

const here = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(readFileSync(join(here, '../../schemas/mission-attention.v1.schema.json'), 'utf8'))
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema)
const ok = { INPUT_REQUIRED: 0, AUTH_REQUIRED: 1, APPROVAL_REQUIRED: 2, FAILED_TERMINAL: 0 }

describe('Mission Attention Schema', () => {
  test('四类需要人处理的任务数齐全时通过', () => {
    assert.ok(validate(ok), JSON.stringify(validate.errors))
  })

  test('缺少任一类、负数、小数、额外字段都拒绝', () => {
    const { FAILED_TERMINAL: _omit, ...missing } = ok
    assert.equal(validate(missing), false)
    assert.equal(validate({ ...ok, INPUT_REQUIRED: -1 }), false)
    assert.equal(validate({ ...ok, INPUT_REQUIRED: 1.5 }), false)
    assert.equal(validate({ ...ok, RUNNING: 1 }), false)
  })
})
