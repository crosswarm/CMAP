import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'

const validate = new Ajv({ strict: true }).compile(JSON.parse(readFileSync(new URL('../../schemas/mission-cancel.v1.schema.json', import.meta.url))))

test('取消契约只接受非空原因，不接受身份或范围自述', () => {
  assert.equal(validate({ reason: '需求变更，停止执行' }), true)
  for (const bad of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(501) }, { reason: 'ok', owner: 'forged' }, { reason: 'ok', task_ids: ['t'] }]) {
    assert.equal(validate(bad), false, JSON.stringify(bad).slice(0, 60))
  }
})
