import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { setImmediate as waitImmediate } from 'node:timers/promises'

import pg from 'pg'

import { PgStore, type EventActor, type Mission } from '#domain-model'

process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'

const CONN =
  process.env['CMAP_DATABASE_URL'] ??
  'postgres://temporal:temporal@localhost:5433/cmap'

const ACTOR: EventActor = { type: 'system', id: 'pg-migration-test' }
const T0 = '2026-08-02T00:00:00.000Z'

const mission = (goal: string): Mission => ({
  id: 'mis-shared',
  tenant: 'team-ycc',
  owner: 'crosswarm',
  type: 'performance-optimization',
  goal,
  constraints: {},
  acceptance: [
    { criterion_id: 'GOAL', metric: 'goal', operator: 'eq', expected: goal, hard_gate: true },
  ],
  workflow_template: 'performance-optimization/v1',
  state: 'DRAFT',
  revision: 1,
  created_at: T0,
  updated_at: T0,
})

test('PgStore waits for session initialization before the first operation', async () => {
  const calls: string[] = []
  let finishInit: (() => void) | undefined
  let initDone = false

  await withMockPgClient(async (text) => {
    calls.push(text)
    if (text.startsWith('SET search_path')) {
      return new Promise((resolve) => {
        finishInit = () => {
          initDone = true
          resolve({ rows: [], rowCount: 0 })
        }
      })
    }
    assert.equal(initDone, true)
    return { rows: [], rowCount: 0 }
  }, async () => {
    const store = new PgStore({ connectionString: CONN, schema: 'cmap_mock' })
    const op = store.getMission('mis-1')
    try {
      await waitImmediate()
      assert.deepEqual(calls, ['SET search_path TO cmap_mock'])
      finishInit?.()
      assert.equal(await op, null)
      assert.deepEqual(calls, [
        'SET search_path TO cmap_mock',
        'SELECT * FROM missions WHERE id = $1',
      ])
    } finally {
      finishInit?.()
      await store.close()
    }
  })
})

test('PgStore rejects the first operation when session initialization fails', async () => {
  const initError = new Error('init failed')
  const calls: string[] = []

  await withMockPgClient(async (text) => {
    calls.push(text)
    if (text.startsWith('SET search_path')) {
      throw initError
    }
    throw new Error(`unexpected app query: ${text}`)
  }, async () => {
    const store = new PgStore({ connectionString: CONN, schema: 'cmap_mock' })
    try {
      await assert.rejects(store.getMission('mis-1'), initError)
      assert.deepEqual(calls, ['SET search_path TO cmap_mock'])
    } finally {
      await store.close()
    }
  })
})

test('PgStore.migrate serializes concurrent clients initializing a fresh schema', async () => {
  const schema = `cmap_migrate_${randomUUID().replaceAll('-', '')}`
  const stores = Array.from({ length: 4 }, () => new PgStore({ connectionString: CONN, schema }))
  const client = new pg.Client({ connectionString: CONN })
  let connected = false

  try {
    await Promise.all(stores.map((store) => store.migrate()))
    await client.connect()
    connected = true
    const { rows } = await client.query(
      `SELECT to_regclass($1) AS missions_table,
              to_regclass($2) AS events_table,
              to_regclass($3) AS lamport_seq`,
      [`${schema}.missions`, `${schema}.events`, `${schema}.lamport_seq`],
    )
    assert.deepEqual(rows[0], {
      missions_table: `${schema}.missions`,
      events_table: `${schema}.events`,
      lamport_seq: `${schema}.lamport_seq`,
    })
  } finally {
    await Promise.allSettled(stores.map((store) => store.close()))
    if (!connected) {
      await client.connect()
      connected = true
    }
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await client.end()
  }
})

test('PgStore keeps fresh connections isolated by schema search_path', async () => {
  const schemas = [
    `cmap_isolate_a_${randomUUID().replaceAll('-', '')}`,
    `cmap_isolate_b_${randomUUID().replaceAll('-', '')}`,
  ]
  let stores = schemas.map((schema) => new PgStore({ connectionString: CONN, schema }))
  const client = new pg.Client({ connectionString: CONN })

  try {
    await Promise.all(stores.map((store) => store.migrate()))
    await Promise.all([
      stores[0]!.createMission({ mission: mission('goal A'), actor: ACTOR }),
      stores[1]!.createMission({ mission: mission('goal B'), actor: ACTOR }),
    ])
    await Promise.all(stores.map((store) => store.close()))

    stores = schemas.map((schema) => new PgStore({ connectionString: CONN, schema }))
    const [a, b] = await Promise.all([
      stores[0]!.getMission('mis-shared'),
      stores[1]!.getMission('mis-shared'),
    ])
    assert.equal(a?.goal, 'goal A')
    assert.equal(b?.goal, 'goal B')
  } finally {
    await Promise.allSettled(stores.map((store) => store.close()))
    await client.connect()
    try {
      for (const schema of schemas) {
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      }
    } finally {
      await client.end()
    }
  }
})

type QueryResult = { rows: unknown[], rowCount: number }

async function withMockPgClient(
  query: (text: string) => Promise<QueryResult> | QueryResult,
  fn: () => Promise<void>,
): Promise<void> {
  const originalConnect = pg.Client.prototype.connect
  const originalQuery = pg.Client.prototype.query
  const originalEnd = pg.Client.prototype.end

  pg.Client.prototype.connect = function mockConnect(
    this: pg.Client,
    callback?: (err?: Error) => void,
  ) {
    ;(this as pg.Client & { _queryable: boolean })._queryable = true
    if (callback) {
      setImmediate(() => callback())
      return
    }
    return Promise.resolve()
  } as typeof pg.Client.prototype.connect

  pg.Client.prototype.query = function mockQuery(
    this: pg.Client,
    text: string,
    values?: unknown[] | ((err: Error | null, result?: QueryResult) => void),
    callback?: (err: Error | null, result?: QueryResult) => void,
  ) {
    const cb = typeof values === 'function' ? values : callback
    const run = Promise.resolve().then(() => query(text))
    if (cb) {
      run.then(
        (result) => cb(null, result),
        (err: Error) => cb(err),
      )
      return
    }
    return run
  } as typeof pg.Client.prototype.query

  pg.Client.prototype.end = function mockEnd(this: pg.Client, callback?: (err?: Error) => void) {
    ;(this as pg.Client & { _ending: boolean })._ending = true
    if (callback) {
      setImmediate(() => callback())
      return
    }
    return Promise.resolve()
  } as typeof pg.Client.prototype.end

  try {
    await fn()
  } finally {
    pg.Client.prototype.connect = originalConnect
    pg.Client.prototype.query = originalQuery
    pg.Client.prototype.end = originalEnd
  }
}
