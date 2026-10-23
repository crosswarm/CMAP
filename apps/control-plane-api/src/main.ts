/**
 * 控制面 API 进程入口。
 *
 * server.ts 只导出 createControlPlane（测试据此拉起真实 HTTP），本文件负责
 * 接上 PgStore 与端口。监听固定在 127.0.0.1：鉴权要到 P4 才有，在那之前
 * 这个端口等于无认证的账本读写口，不能对外暴露。
 *
 * 未配置 OIDC 时 tenant/owner 来自环境变量（本机模式）；配置 CMAP_OIDC_* 后从令牌解析，见 docs/identity.md。
 */

// Surge 会拦截 localhost 并返回 HTTP 200 + HTML，导致连接看似成功却
// 永远等不到有效响应（静默挂起）。
process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'
process.env['grpc_proxy'] = ''

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PgStore, loadOrCreatePermitKey } from '#domain-model'
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client'

import { getApprovalAdviceFromJev } from './approval-advice.ts'
import { createControlPlane } from './server.ts'
import { workflowTypeForTemplate } from './workflow-routing.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const port = Number(process.env['CMAP_API_PORT'] ?? 8787)
const tenant = process.env['CMAP_TENANT'] ?? process.env['RUNNER_TENANT'] ?? 'team-ycc'
const owner = process.env['CMAP_OWNER'] ?? 'local-operator'
const workRoot = process.env['CMAP_WORK_ROOT'] ?? join(repoRoot, '.cmap-work')
const frontendDir = join(repoRoot, 'apps/web/dist')
const connectionString =
  process.env['CMAP_DATABASE_URL'] ?? 'postgres://temporal:temporal@localhost:5433/cmap'
const schema = process.env['CMAP_DB_SCHEMA'] ?? 'public'

// OIDC 三项要么全配要么全不配：只配一半时静默退回本机模式，等于以为开了认证其实没开。
const oidcEnv = ['CMAP_OIDC_ISSUER', 'CMAP_OIDC_AUDIENCE', 'CMAP_OIDC_JWKS_URL'].map((name) => process.env[name]?.trim() || undefined)
if (oidcEnv.some(Boolean) && !oidcEnv.every(Boolean)) {
  throw new Error('CMAP_OIDC_ISSUER、CMAP_OIDC_AUDIENCE、CMAP_OIDC_JWKS_URL 必须同时配置')
}
const [issuer, audience, jwksUrl] = oidcEnv
const oidc = issuer && audience && jwksUrl ? { issuer, audience, jwksUrl } : undefined
const publicOrigin = process.env['CMAP_PUBLIC_ORIGIN']?.trim() || undefined
if (publicOrigin && !oidc) throw new Error('CMAP_PUBLIC_ORIGIN 只能与 OIDC 一起配置：本机模式没有认证，不能经反向代理对外')
if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin) throw new Error('CMAP_PUBLIC_ORIGIN 必须是不带路径的 Origin，例如 https://cmap.spux.cn')

// runner 出站网关（ADR-0008 §3）：这把密钥只签网关应答，runner 登记时固定其公钥。不得是派发许可私钥——
// API 对外，若持有许可私钥，API 被攻破就等于能让所有 runner 执行任意信封。
const gatewayKeyFile = process.env['CMAP_GATEWAY_KEY_FILE']?.trim() || undefined
const permitKeyFile = process.env['CMAP_PERMIT_KEY_FILE']?.trim()
if (gatewayKeyFile && permitKeyFile && resolve(gatewayKeyFile) === resolve(permitKeyFile)) {
  throw new Error('CMAP_GATEWAY_KEY_FILE 不能是派发许可私钥 CMAP_PERMIT_KEY_FILE')
}
const runnerGateway = gatewayKeyFile ? { signingKey: loadOrCreatePermitKey(gatewayKeyFile).privateKey } : undefined

const store = new PgStore({ connectionString, schema })
// 幂等建表：与 Worker 用同一套 schema，谁先起都能把表建好。
await store.migrate()

let temporal: Promise<Connection> | undefined
const getTemporal = () => temporal ??= Connection.connect({
  address: process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233', connectTimeout: 5000,
}).catch((error: unknown) => { temporal = undefined; throw error })

const server = await createControlPlane({
  store, tenant, owner, workRoot, frontendDir, ...(oidc ? { oidc } : {}), ...(publicOrigin ? { publicOrigin } : {}),
  ...(runnerGateway ? { runnerGateway } : {}),
  getApprovalAdvice: (id) => getApprovalAdviceFromJev(id, { repoRoot, port }),
  startMission: async (missionId, workflowId) => {
    const connection = await getTemporal()
    const client = new Client({ connection, namespace: process.env['TEMPORAL_NAMESPACE'] ?? 'default' })
    const mission = await store.getMission(missionId)
    if (!mission) throw new Error(`Mission 不存在：${missionId}`)
    const workflowType = workflowTypeForTemplate(mission.workflow_template)
    try {
      await connection.withDeadline(Date.now() + 15_000, () => client.workflow.start(workflowType, {
        workflowId, taskQueue: process.env['TEMPORAL_TASK_QUEUE'] ?? 'cmap-main',
        args: [{ missionId }], workflowIdReusePolicy: 'REJECT_DUPLICATE', workflowIdConflictPolicy: 'USE_EXISTING',
      }))
    } catch (error) {
      // 同请求的关闭历史也不得启动新 run；网络/服务错误则由 API 返回 503 供原键重试。
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error
    }
  },
  cancelMission: async (_missionId, workflowId, reason) => {
    const connection = await getTemporal()
    const client = new Client({ connection, namespace: process.env['TEMPORAL_NAMESPACE'] ?? 'default' })
    await connection.withDeadline(Date.now() + 15_000, () => client.workflow.getHandle(workflowId).signal('cancelMission', { reason }))
  },
  notifyApprovalDecided: async (_missionId, workflowId) => {
    const connection = await getTemporal()
    const client = new Client({ connection, namespace: process.env['TEMPORAL_NAMESPACE'] ?? 'default' })
    await connection.withDeadline(Date.now() + 15_000, () => client.workflow.getHandle(workflowId).signal('approvalDecided'))
  },
  notifyRunnerReported: async (_missionId, workflowId) => {
    const connection = await getTemporal()
    const client = new Client({ connection, namespace: process.env['TEMPORAL_NAMESPACE'] ?? 'default' })
    await connection.withDeadline(Date.now() + 15_000, () => client.workflow.getHandle(workflowId).signal('runnerReported'))
  },
})
await server.listen(port)

// 租户打进日志：跨租户请求一律 404，配错时症状是「什么都查不到」，
// 不打出来会被当成数据没写进去。
console.log(oidc
  ? `控制面 API 就绪：http://127.0.0.1:${port}/v1/health auth=oidc issuer=${oidc.issuer} db.schema=${schema}`
  : `控制面 API 就绪：http://127.0.0.1:${port}/v1/health tenant=${tenant} db.schema=${schema}`)

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
