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
process.env['grpc_proxy'] = ''

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PgStore } from '#domain-model'
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client'

import { getApprovalAdviceFromJev } from './approval-advice.ts'
import { createControlPlane } from './server.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const port = Number(process.env['CMAP_API_PORT'] ?? 8787)
const tenant = process.env['CMAP_TENANT'] ?? process.env['RUNNER_TENANT'] ?? 'team-ycc'
const owner = process.env['CMAP_OWNER'] ?? 'local-operator'
const workRoot = process.env['CMAP_WORK_ROOT'] ?? join(repoRoot, '.cmap-work')
const frontendDir = join(repoRoot, 'apps/web/dist')
const connectionString =
  process.env['CMAP_DATABASE_URL'] ?? 'postgres://temporal:temporal@localhost:5433/cmap'
const schema = process.env['CMAP_DB_SCHEMA'] ?? 'public'

const store = new PgStore({ connectionString, schema })
// 幂等建表：与 Worker 用同一套 schema，谁先起都能把表建好。
await store.migrate()

let temporal: Promise<Connection> | undefined
const getTemporal = () => temporal ??= Connection.connect({
  address: process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233', connectTimeout: 5000,
}).catch((error: unknown) => { temporal = undefined; throw error })

const server = await createControlPlane({
  store, tenant, owner, workRoot, frontendDir,
  getApprovalAdvice: (id) => getApprovalAdviceFromJev(id, { repoRoot, port }),
  startMission: async (missionId, workflowId) => {
    const connection = await getTemporal()
    const client = new Client({ connection, namespace: process.env['TEMPORAL_NAMESPACE'] ?? 'default' })
    try {
      await connection.withDeadline(Date.now() + 15_000, () => client.workflow.start('missionWorkflow', {
        workflowId, taskQueue: process.env['TEMPORAL_TASK_QUEUE'] ?? 'cmap-main',
        args: [{ missionId }], workflowIdReusePolicy: 'REJECT_DUPLICATE', workflowIdConflictPolicy: 'USE_EXISTING',
      }))
    } catch (error) {
      // 同请求的关闭历史也不得启动新 run；网络/服务错误则由 API 返回 503 供原键重试。
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error
    }
  },
})
await server.listen(port)

// 租户打进日志：跨租户请求一律 404，配错时症状是「什么都查不到」，
// 不打出来会被当成数据没写进去。
console.log(`控制面 API 就绪：http://127.0.0.1:${port}/v1/health tenant=${tenant} db.schema=${schema}`)

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  void (async () => {
    await server.close()
    await temporal?.then((connection) => connection.close(), () => {})
    await store.close()
  })()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
