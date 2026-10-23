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
import { generateKeyPairSync, type KeyObject } from 'node:crypto'

import { Worker, NativeConnection } from '@temporalio/worker'

import { PgStore, issueDispatchPermit, verifyDispatchPermit, DispatchPermitError, loadOrCreatePermitKey, loadPinnedPublicKey } from '#domain-model'
import type { AdapterAuthorization, AgentAdapter, DispatchPermitSigner } from '#adapter-sdk'
import { CodexAdapter, CODEX_CAPABILITIES } from '../../../adapters/codex-adapter/src/index.ts'
import { RemoteRunnerAdapter } from '../../../adapters/remote-runner/src/index.ts'
import { KimiAdapter } from '../../../adapters/kimi-adapter/src/index.ts'
import { YonWorkAdapter } from '../../../adapters/yonwork-adapter/src/index.ts'
import { cachedQuotaProbe, probeCodexQuota } from '../../../packages/adapter-sdk/src/quota-probe.ts'
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
// Mission 累计 tokens 超过该值时写 MISSION_COST_ALERT（只告警，不阻断）；不设置则不检查。
const missionCostAlertTokens = process.env['CMAP_MISSION_COST_ALERT_TOKENS']?.trim()
if (missionCostAlertTokens && !/^[1-9]\d*$/.test(missionCostAlertTokens)) throw new Error('CMAP_MISSION_COST_ALERT_TOKENS 须为正整数')

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../../..')
// 每个任务一个子目录，避免并发任务互相污染工作区。
const workRoot = process.env['CMAP_WORK_ROOT'] ?? join(repoRoot, '.cmap-work')
// 只读 actor 令牌只在 Worker 进程内用于调用 Memross；Agent 子进程的环境白名单不含它。
const memoryUrl = process.env['MEMROSS_URL'] ?? ''
const memoryToken = process.env['MEMROSS_TOKEN'] ?? ''
const memory = memoryUrl && memoryToken ? { url: memoryUrl, token: memoryToken } : undefined

// 未配置 CMAP_PERMIT_KEY_FILE 时沿用本机临时密钥（不是远程主机身份）；远程 runner 要求持久化密钥，
// lap 固定其公钥验签（ADR-0006）。私钥只在本进程内，不进日志、账本或子进程环境。
const permitKeyFile = process.env['CMAP_PERMIT_KEY_FILE']?.trim()
const {privateKey,publicKey}=permitKeyFile ? loadOrCreatePermitKey(permitKeyFile) : generateKeyPairSync('ed25519')
const issuer='cmap:local-control-plane'
const signDispatchPermit:DispatchPermitSigner=(envelope,{runnerId:audienceRunner,adapterId})=>
  issueDispatchPermit({privateKey,issuer,runnerId:audienceRunner,adapterId,envelope})
const authorization:AdapterAuthorization={mode:'managed',verifier:(token,envelope,adapterId,contextRunner)=>{
  if(contextRunner!==runnerId)throw new DispatchPermitError('CLAIM_MISMATCH')
  return verifyDispatchPermit(token,{publicKey,issuer,runnerId,adapterId,envelope})
}}

// 离线宽限上限；实际宽限另受任务等待截止约束（取剩余时间的一半），保证失联先判执行不确定、不先撞任务超时。
const graceSeconds = Number(process.env['CMAP_REMOTE_OFFLINE_GRACE_SECONDS'] ?? 600)
if (!Number.isInteger(graceSeconds) || graceSeconds < 1) throw new Error('CMAP_REMOTE_OFFLINE_GRACE_SECONDS 须为正整数秒')
const remoteRunner = (target: string, baseUrl: string, agentId: string, runnerPublicKey?: KeyObject): RemoteRunnerAdapter => {
  if (!permitKeyFile) throw new Error('runner 守护进程只认固定公钥：需要 CMAP_PERMIT_KEY_FILE')
  if (!target || target === runnerId) throw new Error('runner 守护进程的 RUNNER_ID 必填且不能与本机 Worker 的 RUNNER_ID 相同')
  return new RemoteRunnerAdapter({
    authorization:{mode:'managed',verifier:(token,envelope,adapterId,contextRunner)=>{
      if(contextRunner!==target)throw new DispatchPermitError('CLAIM_MISMATCH')
      return verifyDispatchPermit(token,{publicKey,issuer,runnerId:target,adapterId,envelope})
    }},
    ...(runnerPublicKey ? { runnerPublicKey } : {}),
    baseUrl,
    runnerId: target,
    agentId,
    workRoot,
    capabilities: CODEX_CAPABILITIES,
    offlineGraceMs: graceSeconds * 1000,
  })
}

// 本机 runner 守护进程（S16）：设置后本机 codex 经 127.0.0.1 上的守护进程执行，Worker 重启不影响执行中的 Codex；
// 守护进程不在线时 codex 健康探测失败，不回落进程内执行。Kimi / YonWork 仍在 Worker 进程内。
const localRunnerUrl = process.env['CMAP_LOCAL_RUNNER_URL']?.trim()
const localCodex = (): AgentAdapter => {
  if (!localRunnerUrl) return new CodexAdapter({
    authorization,
    outputSchemaPath: join(repoRoot, 'schemas/codex-output.v1.schema.json'),
    // 运行记录：Worker 重启后据此恢复对 Codex 子进程的观察，且绝不重跑（S1）。
    runsDir: join(workRoot, '.runs'),
    // 额度快照（ADR-0009）：零额度探针 + 5 分钟缓存，随 health 进入路由
    quota: cachedQuotaProbe('codex', () => probeCodexQuota()),
  })
  // 只接受回环地址：本机 runner 不是第二台机器，不得借此接入 ADR-0006 范围外的主机。
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(localRunnerUrl).hostname)) throw new Error('CMAP_LOCAL_RUNNER_URL 只能是回环地址')
  const pubkeyFile = process.env['CMAP_LOCAL_RUNNER_PUBKEY_FILE']?.trim()
  if (!pubkeyFile) throw new Error('CMAP_LOCAL_RUNNER_URL 需要 CMAP_LOCAL_RUNNER_PUBKEY_FILE')
  return remoteRunner(process.env['CMAP_LOCAL_RUNNER_ID']?.trim() ?? '', localRunnerUrl, 'codex', loadPinnedPublicKey(pubkeyFile))
}

const adapterNames = parseAdapterNames(process.env['CMAP_AGENTS'])
const adapters: AgentAdapter[] = adapterNames.map((name) =>
  name === 'kimi'
    ? new KimiAdapter({authorization})
    : name === 'yonwork'
      ? new YonWorkAdapter({profileId:process.env['CMAP_YONWORK_AGENT_ID'] ?? '',runnerId,authorization})
    : localCodex(),
)

// 远程 runner（ADR-0006）：只由本机主动访问 lap:8790；lap 不在线时路由按健康探测回落本地。
const remoteRunnerUrl = process.env['CMAP_REMOTE_RUNNER_URL']?.trim()
if (remoteRunnerUrl) {
  const remoteRunnerId = process.env['CMAP_REMOTE_RUNNER_ID']?.trim() ?? ''
  if (localRunnerUrl && remoteRunnerId === process.env['CMAP_LOCAL_RUNNER_ID']?.trim()) throw new Error('CMAP_REMOTE_RUNNER_ID 不能与 CMAP_LOCAL_RUNNER_ID 相同')
  // lap 响应验签公钥由适配器从 CMAP_REMOTE_RUNNER_PUBKEY_FILE 加载
  adapters.push(remoteRunner(remoteRunnerId, remoteRunnerUrl, `codex@${remoteRunnerId}`))
}

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
      ...(missionCostAlertTokens ? { missionCostAlertTokens: Number(missionCostAlertTokens) } : {}),
    }),
    ...createDagActivities({
      store,
      adapters,
      runner,
      signDispatchPermit,
      workRoot,
      ...(memory ? { memory } : {}),
      // ADR-0007 影子模式：未配置策略文件 = 不启用，完全不调用 Jev。
      ...(process.env['CMAP_DELEGATION_POLICY_FILE'] ? { jevShadow: { policyFile: process.env['CMAP_DELEGATION_POLICY_FILE'] } } : {}),
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
    `db.schema=${schema} runner=${runnerId} adapters=${adapters.map(a => a.agentId).join(',')} 工作区=${workRoot} memross=${memory ? memoryUrl : '未配置'}`,
)

await worker.run()

await connection.close()
await store.close()
