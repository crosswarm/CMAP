/**
 * Temporal Worker 进程入口。
 *
 * 与 tests/workflow/mission.test.ts 的装配只差两处：Store 换成 PgStore、
 * 生命周期由信号控制。编排逻辑不在这里，本文件只负责接线——那样才能保证
 * 「测试里跑通的」和「进程里跑的」是同一套 Workflow 与 Activity。
 *
 * 启动前先确认 Temporal 真的可用：node scripts/verify-temporal.mjs。
 * 容器 Up、端口 LISTEN 都不作数。
 *
 * 这里注入真实 Adapter：默认 Codex，CMAP_AGENTS 可显式注册 Kimi。
 * 想只验证编排而不真跑 Agent，用 tests/workflow 里的假 Adapter。
 */

// 本机 http_proxy 指向 Surge，若不排除 localhost，gRPC 会被代理拦截，
// 表现为连接看似建立却永远等不到响应（静默挂起）。
process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'
process.env['grpc_proxy'] = ''

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Worker, NativeConnection } from '@temporalio/worker'

import { PgStore } from '#domain-model'
import { CodexAdapter } from '../../../adapters/codex-adapter/src/index.ts'
import { KimiAdapter } from '../../../adapters/kimi-adapter/src/index.ts'
import { parseAdapterNames } from './adapter-config.ts'
import { createActivities } from '../../../workflows/activities.ts'

const address = process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233'
const namespace = process.env['TEMPORAL_NAMESPACE'] ?? 'default'
const taskQueue = process.env['TEMPORAL_TASK_QUEUE'] ?? 'cmap-main'
const connectionString =
  process.env['CMAP_DATABASE_URL'] ??
  'postgres://temporal:temporal@localhost:5433/cmap'
const schema = process.env['CMAP_DB_SCHEMA'] ?? 'public'
const runnerId = process.env['RUNNER_ID'] ?? 'local-dev'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../../..')
// 每个任务一个子目录，避免并发任务互相污染工作区。
const workRoot = process.env['CMAP_WORK_ROOT'] ?? join(repoRoot, '.cmap-work')

const adapterNames = parseAdapterNames(process.env['CMAP_AGENTS'])
const adapters = adapterNames.map((name) =>
  name === 'kimi'
    ? new KimiAdapter()
    : new CodexAdapter({
        outputSchemaPath: join(repoRoot, 'schemas/codex-output.v1.schema.json'),
      }),
)

const store = new PgStore({ connectionString, schema })
// 幂等建表：空库首次启动即可用，不需要额外的迁移步骤。
await store.migrate()

let connection: NativeConnection
try {
  connection = await NativeConnection.connect({ address })
} catch (e) {
  await store.close()
  throw new Error(
    `无法连接 Temporal（${address}）。请先启动本地栈：\n` +
      `  docker compose -f infra/docker-compose/docker-compose.yml up -d\n` +
      `  node scripts/verify-temporal.mjs\n原始错误：${String(e)}`,
  )
}

const worker = await Worker.create({
  connection,
  namespace,
  taskQueue,
  workflowsPath: join(repoRoot, 'workflows/mission.workflow.ts'),
  activities: createActivities({
    store,
    // 传给 codex 的是 OpenAI structured outputs 兼容子集，
    // 不是控制面校验账本用的严格 schema（见 ADR-0003）。
    adapters,
    runnerId,
    workRoot,
  }),
})

// shutdown 让 worker.run() 正常返回，正在执行的 Activity 得以收尾；
// 直接 process.exit 会把它们截断成需要重试的孤儿。
let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  worker.shutdown()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

console.log(
  `Worker 就绪：temporal=${address} ns=${namespace} queue=${taskQueue} ` +
    `db.schema=${schema} runner=${runnerId} adapters=${adapterNames.join(',')} 工作区=${workRoot}`,
)

await worker.run()

await connection.close()
await store.close()
