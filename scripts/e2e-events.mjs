/** 真实 PostgreSQL → HTTP SSE：跨连接写入、晚提交、重连与租户隔离。只使用独立合成测试 schema。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { PgStore } from '#domain-model'
import { createControlPlane } from '../apps/control-plane-api/src/server.ts'

const connectionString = process.env.CMAP_DATABASE_URL ?? 'postgres://temporal:temporal@localhost:5433/cmap'
const schema = `cmap_sse_${randomUUID().replaceAll('-', '')}`
const store = new PgStore({ connectionString, schema })
const writer = new PgStore({ connectionString, schema })
const late = new pg.Client({ connectionString })
const abort = new AbortController()
const timeout = setTimeout(() => abort.abort(), 20_000)
const ajv = new Ajv({ strict: true })
addFormats(ajv)
const validate = ajv.compile(JSON.parse(readFileSync(new URL('../schemas/mission-event.v1.schema.json', import.meta.url))))
let server
try {
  await store.migrate()
  await late.connect()
  const actor = { type: 'system', id: 'sse-e2e' }
  const now = new Date().toISOString()
  const mission = {
    id: 'synthetic-visible', tenant: 'sse-e2e', owner: 'test', type: 'inspect',
    goal: 'synthetic SSE verification', constraints: {}, acceptance: [],
    workflow_template: 'inspect/v1', state: 'DRAFT', revision: 1,
    created_at: now, updated_at: now,
  }
  await store.createMission({ mission, actor })
  await store.createMission({ mission: { ...mission, id: 'synthetic-hidden', tenant: 'other' }, actor })
  server = await createControlPlane({ store, tenant: 'sse-e2e' })
  await server.listen(0)
  const base = `http://127.0.0.1:${server.address().port}`
  const listing = await (await fetch(`${base}/v1/missions`, { signal: abort.signal })).json()
  assert.deepEqual(listing.items.map((m) => m.id), [mission.id])
  assert.equal((await fetch(`${base}/v1/missions/synthetic-hidden/events`, { signal: abort.signal })).status, 404)

  const open = async (cursor) => {
    const response = await fetch(`${base}/v1/missions/${mission.id}/events`, {
      headers: cursor ? { 'Last-Event-ID': cursor } : {}, signal: abort.signal,
    })
    assert.equal(response.status, 200)
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let text = ''
    return {
      close: () => reader.cancel(),
      async next() {
        for (;;) {
          const end = text.indexOf('\n\n')
          if (end >= 0) {
            const frame = text.slice(0, end)
            text = text.slice(end + 2)
            const data = frame.match(/^data: (.*)$/m)
            if (data) {
              const event = JSON.parse(data[1])
              assert.ok(validate(event), JSON.stringify(validate.errors))
              return event
            }
            continue
          }
          const part = await reader.read()
          assert.equal(part.done, false)
          text += part.value
        }
      },
    }
  }
  const stream = await open()
  const created = await stream.next()
  assert.equal(created.event_type, 'MISSION_CREATED')
  await late.query(`SET search_path TO ${schema}`)
  await late.query('BEGIN')
  // 先分配较小的 sequence 值但暂不提交，让另一连接先完成后来的事件。
  await late.query(`INSERT INTO events
    (event_id,event_type,event_version,occurred_at,mission_id,task_id,attempt,
     actor_type,actor_id,runner_id,causation_id,correlation_id,trace_id,lamport,idempotency_key,payload)
    SELECT 'late-event',event_type,event_version,occurred_at,mission_id,task_id,attempt,
     actor_type,actor_id,runner_id,causation_id,correlation_id,trace_id,nextval('lamport_seq'),'late-key',payload
    FROM events WHERE event_id=$1`, [created.event_id])
  await writer.setMissionState(mission.id, 'RUNNING', actor)
  const running = await stream.next()
  assert.equal(running.event_type, 'MISSION_STATE_CHANGED')
  await late.query('COMMIT')
  const delayed = await stream.next()
  assert.equal(delayed.event_id, 'late-event')
  assert.ok(delayed.lamport < running.lamport)
  assert.equal('payload' in delayed, false)
  await stream.close()
  await writer.setMissionState(mission.id, 'COMPLETED', actor)
  const resumed = await open(encodeURIComponent(running.event_id))
  const replay = []
  for (let i = 0; i < 4; i++) replay.push(await resumed.next())
  assert.equal(replay.at(-1).event_type, 'MISSION_COMPLETED')
  assert.equal(new Set(replay.map((e) => e.event_id)).size, 4)
  assert.ok(replay.some((e) => e.event_id === 'late-event'))
  await resumed.close()
  console.log('PASS: PostgreSQL SSE 历史/实时/晚提交/断线回放/租户隔离；无任务 Mission 可见。')
} finally {
  clearTimeout(timeout)
  abort.abort()
  await server?.close()
  await late.query('ROLLBACK').catch(() => {})
  await store.close()
  await writer.close()
  await late.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await late.end()
}
