import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

import pg from 'pg'

import { PgStore } from '#domain-model'

process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'

const CONN =
  process.env['CMAP_DATABASE_URL'] ??
  'postgres://temporal:temporal@localhost:5433/cmap'

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
