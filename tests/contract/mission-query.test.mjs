import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Ajv from 'ajv/dist/2020.js'

const here = dirname(fileURLToPath(import.meta.url))
const schemaDir = join(here, '../../schemas')
const schema = JSON.parse(readFileSync(join(schemaDir, 'mission-query.v1.schema.json'), 'utf8'))

const ajv = new Ajv({ strict: true, allErrors: true })
const validate = ajv.compile(schema)

describe('Mission Query Schema', () => {
  test('tenant 是最小必填查询条件', () => {
    assert.ok(validate({ tenant: 'team-ycc' }), JSON.stringify(validate.errors, null, 2))
  })

  test('缺少 tenant 时拒绝', () => {
    assert.equal(validate({}), false)
  })

  test('拒绝额外查询字段', () => {
    assert.equal(validate({ tenant: 'team-ycc', owner: 'crosswarm' }), false)
  })
})
