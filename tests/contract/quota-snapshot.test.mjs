import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import Ajv from 'ajv/dist/2020.js'

const schema = JSON.parse(readFileSync(new URL('../../schemas/quota-snapshot.v1.schema.json', import.meta.url), 'utf8'))
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema)

const H = 'a'.repeat(64)
const valid = {
  schema: 'cmap/quota-snapshot/v1', provider: 'codex', account_ref: H,
  windows: [{ kind: 'primary', used_percent: 84, window_minutes: 10080, resets_at: '2026-10-29T00:00:00.000Z' }],
  ordinary_usage_allowed: true, observed_at: '2026-10-23T00:00:00.000Z', status: 'ok',
}

test('quota-snapshot 接受账号级快照与未知快照', () => {
  for (const value of [
    valid,
    { ...valid, provider: 'claude', ordinary_usage_allowed: null, windows: [
      { kind: 'five_hour', used_percent: 47, window_minutes: 300, resets_at: '2026-10-23T05:20:00.151415+00:00' },
      { kind: 'seven_day', used_percent: 92, window_minutes: 10080, resets_at: null },
    ] },
    { ...valid, provider: 'kimi', account_ref: null, windows: [], ordinary_usage_allowed: null, status: 'unknown' },
    { ...valid, windows: [], status: 'error' },
  ]) assert.equal(validate(value), true, JSON.stringify(validate.errors))
})

test('quota-snapshot 拒绝原始账号 id、额外字段与越界值', () => {
  for (const change of [
    { account_ref: 'user-1234@example.com' },
    { account_ref: H.toUpperCase() },
    { provider: 'openai' },
    { status: 'low' },
    { observed_at: 'yesterday' },
    { email: 'x' },
    { windows: [{ ...valid.windows[0], used_percent: -1 }] },
    { windows: [{ ...valid.windows[0], window_minutes: 0 }] },
    { windows: [{ ...valid.windows[0], kind: 'Primary' }] },
    { windows: [{ ...valid.windows[0], extra: 1 }] },
    { ordinary_usage_allowed: 'yes' },
  ]) assert.equal(validate({ ...valid, ...change }), false, JSON.stringify(change))
  const { status: _, ...missing } = valid
  assert.equal(validate(missing), false)
})
