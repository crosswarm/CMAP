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
import { before, after } from 'node:test'

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

async function truncateAll(): Promise<void> {
  const pg = await import('pg')
  const c = new pg.default.Client({ connectionString: CONN })
  await c.connect()
  try {
    await c.query(`SET search_path TO ${SCHEMA}`)
    await c.query(
      'TRUNCATE resource_locks, approvals, reviews, artifacts, events, tasks, missions CASCADE',
    )
  } finally {
    await c.end()
  }
}
