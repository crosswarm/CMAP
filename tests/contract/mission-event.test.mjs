import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const ajv = new Ajv({ strict: true, allErrors: true })
addFormats(ajv)
const validate = ajv.compile(JSON.parse(readFileSync(new URL('../../schemas/mission-event.v1.schema.json', import.meta.url))))

test('SSE 元数据契约严格校验，不接受 payload 或身份正文', () => {
  const event = {
    schema: 'cmap/mission-event/v1', event_id: 'event-1', event_type: 'MISSION_CREATED',
    event_version: 1, occurred_at: '2026-09-20T00:00:00Z', mission_id: 'mission-1',
    task_id: null, lamport: 1,
  }
  assert.equal(validate(event), true)
  for (const invalid of [
    { ...event, payload: { text: 'synthetic prompt' } },
    { ...event, actor: { id: 'synthetic' } },
    { ...event, occurred_at: 'yesterday' },
    { ...event, lamport: -1 },
    { ...event, event_id: '' },
  ]) assert.equal(validate(invalid), false)
})
