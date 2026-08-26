/**
 * 控制面 API 进程入口。
 *
 * server.ts 只导出 createControlPlane（测试据此拉起真实 HTTP），本文件负责
 * 接上 PgStore 与端口。监听固定在 127.0.0.1：鉴权要到 P4 才有，在那之前
 * 这个端口等于无认证的账本读写口，不能对外暴露。
 *
 * tenant 目前来自环境变量，P4 接入 OIDC 后改为从令牌解析。
 */

// Surge 会拦截 localhost 并返回 HTTP 200 + HTML，导致连接看似成功却
// 永远等不到有效响应（静默挂起）。
process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'

import { PgStore } from '#domain-model'

import { createControlPlane } from './server.ts'

const port = Number(process.env['CMAP_API_PORT'] ?? 8787)
const tenant = process.env['CMAP_TENANT'] ?? process.env['RUNNER_TENANT'] ?? 'team-ycc'
const connectionString =
  process.env['CMAP_DATABASE_URL'] ?? 'postgres://temporal:temporal@localhost:5433/cmap'
const schema = process.env['CMAP_DB_SCHEMA'] ?? 'public'

const store = new PgStore({ connectionString, schema })
// 幂等建表：与 Worker 用同一套 schema，谁先起都能把表建好。
await store.migrate()

const server = await createControlPlane({ store, tenant })
await server.listen(port)

// 租户打进日志：跨租户请求一律 404，配错时症状是「什么都查不到」，
// 不打出来会被当成数据没写进去。
console.log(`控制面 API 就绪：http://127.0.0.1:${port}/v1/health tenant=${tenant} db.schema=${schema}`)

const stop = (): void => {
  void (async () => {
    await server.close()
    await store.close()
  })()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
