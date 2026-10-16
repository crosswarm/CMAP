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
 * 默认 Codex；CMAP_AGENTS 可注册 Kimi，YonWork 另需显式 CMAP_YONWORK_AGENT_ID。
 * 想只验证编排而不真跑 Agent，用 tests/workflow 里的假 Adapter。
 */

// 本机 http_proxy 指向 Surge，若不排除 localhost，gRPC 会被代理拦截，
// 表现为连接看似建立却永远等不到响应（静默挂起）。
process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'
process.env['grpc_proxy'] = ''

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync } from 'node:crypto'

import { Worker, NativeConnection } from '@temporalio/worker'

import { PgStore, issueDispatchPermit, verifyDispatchPermit, DispatchPermitError } from '#domain-model'
import type { AdapterAuthorization, DispatchPermitSigner } from '#adapter-sdk'
import { CodexAdapter } from '../../../adapters/codex-adapter/src/index.ts'
import { KimiAdapter } from '../../../adapters/kimi-adapter/src/index.ts'
import { YonWorkAdapter } from '../../../adapters/yonwork-adapter/src/index.ts'
import { parseAdapterNames } from './adapter-config.ts'
import { buildRunnerDescriptor } from './runner-config.ts'
import { createActivities } from '../../../workflows/activities.ts'
import { createDagActivities } from '../../../workflows/dag-activities.ts'

const address = process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233'
const namespace = process.env['TEMPORAL_NAMESPACE'] ?? 'default'
const taskQueue = process.env['TEMPORAL_TASK_QUEUE'] ?? 'cmap-main'
const connectionString =
  process.env['CMAP_DATABASE_URL'] ??
  'postgres://temporal:temporal@localhost:5433/cmap'
const schema = process.env['CMAP_DB_SCHEMA'] ?? 'public'
const runnerId = process.env['RUNNER_ID'] ?? ''

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../../..')
// 每个任务一个子目录，避免并发任务互相污染工作区。
const workRoot = process.env['CMAP_WORK_ROOT'] ?? join(repoRoot, '.cmap-work')
// 只读 actor 令牌只在 Worker 进程内用于调用 Memross；Agent 子进程的环境白名单不含它。
const memoryUrl = process.env['MEMROSS_URL'] ?? ''
const memoryToken = process.env['MEMROSS_TOKEN'] ?? ''
const memory = memoryUrl && memoryToken ? { url: memoryUrl, token: memoryToken } : undefined

// Local ephemeral trust exercises the managed boundary; it is not remote host identity.
const {privateKey,publicKey}=generateKeyPairSync('ed25519')
const issuer='cmap:local-control-plane'
const signDispatchPermit:DispatchPermitSigner=(envelope,{runnerId:audienceRunner,adapterId})=>
  issueDispatchPermit({privateKey,issuer,runnerId:audienceRunner,adapterId,envelope})
const authorization:AdapterAuthorization={mode:'managed',verifier:(token,envelope,adapterId,contextRunner)=>{
  if(contextRunner!==runnerId)throw new DispatchPermitError('CLAIM_MISMATCH')
  return verifyDispatchPermit(token,{publicKey,issuer,runnerId,adapterId,envelope})
}}

const adapterNames = parseAdapterNames(process.env['CMAP_AGENTS'])
const adapters = adapterNames.map((name) =>
  name === 'kimi'
    ? new KimiAdapter({authorization})
    : name === 'yonwork'
      ? new YonWorkAdapter({profileId:process.env['CMAP_YONWORK_AGENT_ID'] ?? '',runnerId,authorization})
    : new CodexAdapter({
        authorization,
        outputSchemaPath: join(repoRoot, 'schemas/codex-output.v1.schema.json'),
      }),
)

const descriptors = await Promise.all(adapters.map(adapter => adapter.discover()))
for (const [index, descriptor] of descriptors.entries()) {
  if(descriptor.agent_id!==adapters[index]!.agentId || descriptor.adapter_id!==adapters[index]!.adapterId)throw new Error('RUNNER_ADAPTER_IDENTITY_MISMATCH')
}
const runner = buildRunnerDescriptor(process.env,descriptors)

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
  workflowsPath: join(repoRoot, 'workflows/index.ts'),
  activities: {
    ...createActivities({
      store,
      // 传给 codex 的是 OpenAI structured outputs 兼容子集，
      // 不是控制面校验账本用的严格 schema（见 ADR-0003）。
      adapters,
      runner,
      signDispatchPermit,
      workRoot,
      ...(memory ? { memory } : {}),
    }),
    ...createDagActivities({
      store,
      adapters,
      runner,
      signDispatchPermit,
      workRoot,
    }),
  },
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
    `db.schema=${schema} runner=${runnerId} adapters=${adapterNames.join(',')} 工作区=${workRoot} memross=${memory ? memoryUrl : '未配置'}`,
)

await worker.run()

await connection.close()
await store.close()
