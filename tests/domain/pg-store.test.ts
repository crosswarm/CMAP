/**
 * PgStore 跑与 MemoryStore 完全相同的契约断言。
 *
 * 需要本地栈运行中：
 *   docker compose -f infra/docker-compose/docker-compose.yml up -d
 *
 * 本文件不在默认 `npm test` 内（`npm run test:pg` 单独跑），因为默认
 * 测试不应依赖外部服务。但它也不会在数据库不可用时"跳过并假装通过"——
 * 那等于用沉默替代真实验证。
 */
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'

import { runStoreContractTests } from './store-contract.ts'
import { PgStore } from '#domain-model'

// Surge 会拦截 localhost 并返回 HTTP 200 + HTML，导致连接看似成功却
// 永远等不到响应。必须显式排除。
process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'

const CONN =
  process.env['CMAP_DATABASE_URL'] ??
  'postgres://temporal:temporal@localhost:5433/cmap'

/** 测试专用 schema，与生产 public 隔离 */
const SCHEMA = 'cmap_test'

let shared: PgStore

before(async () => {
  shared = new PgStore({ connectionString: CONN, schema: SCHEMA })
  try {
    await shared.migrate()
  } catch (e) {
    throw new Error(
      `无法连接或初始化测试数据库（${CONN} schema=${SCHEMA}）。\n` +
        `请先启动本地栈：docker compose -f infra/docker-compose/docker-compose.yml up -d\n` +
        `原始错误：${String(e)}`,
    )
  }
})

after(async () => {
  await shared?.close()
})

/**
 * 每个用例前清空数据，保证互不干扰。
 * 同一文件内 node --test 顺序执行，故共用一个 schema 是安全的；
 * 若将来开启文件内并发，需要改为每个 store 独立 schema。
 */
runStoreContractTests('PgStore', async () => {
  await truncateAll()
  return shared
})

test('PgStore events 只追加：UPDATE 与 DELETE 被数据库拒绝；重复迁移幂等；TRUNCATE 清理不受影响', async () => {
  await truncateAll()
  await shared.migrate()
  await shared.createMission({
    mission: {
      id: 'mis-append-only', tenant: 'team-ycc', owner: 'crosswarm', type: 'inspect', goal: 'g', constraints: {},
      acceptance: [{ criterion_id: 'C', metric: 'm', operator: 'eq', expected: 1, hard_gate: true }],
      workflow_template: 'inspect/v1', state: 'DRAFT', revision: 1,
      created_at: '2026-10-23T00:00:00.000Z', updated_at: '2026-10-23T00:00:00.000Z',
    },
    actor: { type: 'system', id: 'pg-append-only-test' },
  })
  const pg = await import('pg')
  const c = new pg.default.Client({ connectionString: CONN })
  await c.connect()
  try {
    await c.query(`SET search_path TO ${SCHEMA}`)
    const before = (await c.query('SELECT * FROM events ORDER BY event_id')).rows
    assert.ok(before.length > 0)
    await assert.rejects(c.query(`UPDATE events SET payload = '{}'::jsonb`), /events 只允许追加/)
    await assert.rejects(c.query('UPDATE events SET delivered_at = now()'), /events 只允许追加/)
    await assert.rejects(c.query('DELETE FROM events'), /events 只允许追加/)
    assert.deepEqual((await c.query('SELECT * FROM events ORDER BY event_id')).rows, before)
  } finally {
    await c.end()
  }
  await truncateAll()
  assert.deepEqual(await shared.listEvents('mis-append-only'), [])
})

async function truncateAll(): Promise<void> {
  const pg = await import('pg')
  const c = new pg.default.Client({ connectionString: CONN })
  await c.connect()
  try {
    await c.query(`SET search_path TO ${SCHEMA}`)
    await c.query(
      'TRUNCATE enrollment_tokens, gateway_leases, gateway_runners, quota_snapshots, resource_locks, approvals, reviews, artifacts, events, tasks, missions CASCADE',
    )
  } finally {
    await c.end()
  }
}
