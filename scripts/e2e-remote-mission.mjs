/**
 * 远程 runner 经 Temporal 全链路的真实验证（ADR-0006 Stage 4）。CrossMini 跑控制面，lap 跑守护进程。
 *
 *   node scripts/e2e-remote-mission.mjs <场景>...
 *
 *   remote          单节点 DAG，preferred codex@lap、fallback codex：binding 在 lap、ROUTING_DECIDED 未回落、COMPLETED
 *   dag             跨主机 DAG（C1）：CrossMini→lap 与 lap→CrossMini 两条父子链，输入哈希两边核验（lap 需 ≥ 9edbd69）
 *   dag-reverse     只跑 lap→CrossMini 一条链
 *   offline         lap 守护进程 bootout 后派发（C5）：回落本地，ROUTING_DECIDED 记 unhealthy，lap 0 次
 *   capability      lap 准入不放行的能力（code.implement）：lap 在 health 里公布白名单，路由记 capability_mismatch 回落本地完成，lap 0 次
 *   lap-restart     lap 执行中 kickstart -k 守护进程：COMPLETED 且 lap 执行 1 次
 *   worker-restart  dag/v1，lap 执行中 SIGKILL CrossMini Worker 再拉起：runDagAttempt 不重试，只核不改派、不重跑、lap 执行 1 次
 *   worker-restart-inspect  同上但 inspect/v1（测试专用 CODEX_BIN 让本机 codex 不健康，路由落到 codex@lap）：COMPLETED 且 lap 执行 1 次
 *   lap-offline     lap 执行中 bootout，生产默认配置（真实 Worker，宽限 600 秒、任务超时 300 秒）
 *   grace           同上，但用测试专用的进程内 Worker 把离线宽限缩到 30 秒：执行不确定、保留 binding、不二次执行
 *
 * 判据只认账本状态、事件回执、执行次数（lap 运行记录 + 进程组采样）与 sha256，不认退出码、端口 LISTEN。
 * 隔离：独立 schema（cmap_e2e_remote）、队列（cmap-e2e-remote）与工作区；Worker 不配置 Memross（不回写候选/交接）。
 * 需要：CMAP_REMOTE_RUNNER_URL / _ID / CMAP_PERMIT_KEY_FILE / CMAP_REMOTE_RUNNER_PUBKEY_FILE；ssh 别名 lap 可用；
 * 本机 Temporal 与 PostgreSQL 已就绪。脚本退出前总会把 lap 守护进程恢复为运行状态。
 * 不打印许可、密钥、提示词或运行记录正文。
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, access } from 'node:fs/promises'
import { isAbsolute, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env['NO_PROXY'] = process.env['no_proxy'] = 'localhost,127.0.0.1,::1'
process.env['grpc_proxy'] = ''

const { PgStore } = await import('#domain-model')
const { Client, Connection } = await import('@temporalio/client')
const { missionFromRequest } = await import('../apps/control-plane-api/src/mission-submission.ts')

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = 'cmap_e2e_remote'
const QUEUE = 'cmap-e2e-remote'
const LOCAL_RUNNER = 'crossmini-e2e'
const LAP_WORK = '/Users/cross/.local/share/cmap-runner/work'
const workRoot = process.env['CMAP_E2E_WORK_ROOT'] ?? join(repoRoot, '.cmap-work', 'e2e-remote')
const connectionString = process.env['CMAP_DATABASE_URL'] ?? 'postgres://temporal:temporal@localhost:5433/cmap'
const remoteId = process.env['CMAP_REMOTE_RUNNER_ID']
for (const k of ['CMAP_REMOTE_RUNNER_URL', 'CMAP_REMOTE_RUNNER_ID', 'CMAP_PERMIT_KEY_FILE', 'CMAP_REMOTE_RUNNER_PUBKEY_FILE']) {
  if (!process.env[k]) throw new Error(`需要 ${k}`)
}
const LAP_AGENT = `codex@${remoteId}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (b) => createHash('sha256').update(b).digest('hex')
const ok = (m) => console.log(`  ✓ ${m}`)
class Fail extends Error {}
const check = (cond, m) => { if (!cond) throw new Fail(m) }

// ------------------------------------------------------------------ lap（经 ssh，只读或启停守护进程）

const lap = (cmd) => execFileSync('ssh', ['-o', 'IdentityAgent=none', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'lap', cmd], { encoding: 'utf8' })
const LABEL = 'gui/$(id -u)/com.cmap.runner'
const daemonPid = () => {
  const line = lap('launchctl list | grep com.cmap.runner || true').trim()
  const pid = line.split(/\s+/)[0]
  return line ? (pid === '-' ? 'stopped' : Number(pid)) : 'unloaded'
}
const restoreLap = () => {
  const state = daemonPid()
  if (state === 'unloaded') lap('launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cmap.runner.plist')
  else if (state === 'stopped') lap(`launchctl kickstart ${LABEL}`)
}
const stopLap = () => lap(`launchctl bootout ${LABEL}`)
const lapRunRecords = (taskId) => Number(lap(`ls ${LAP_WORK}/.runs/ 2>/dev/null | grep -cx '${taskId}[.]json' || true`).trim())
const lapRecordPid = (taskId) => {
  const raw = lap(`cat ${LAP_WORK}/.runs/${taskId}.json 2>/dev/null || true`)
  try { return JSON.parse(raw).pid ?? null } catch { return null } // 记录正文含信封，只取 pid，不打印
}
const lapSha = (rel) => lap(`shasum -a 256 '${LAP_WORK}/${rel}' | cut -d' ' -f1`).trim()
/** lap 上执行该任务的 codex 进程组（按 -o 结果文件名识别；awk 程序文本自身不匹配 [.] 正则）。 */
const lapCodexGroups = (taskId) => new Set(lap(`ps -axo pgid=,command= | awk '/[.]cmap-result-${taskId}[.]json/ && / exec / {print $1}'`)
  .split('\n').map((s) => s.trim()).filter(Boolean).map(Number))

const sampler = (taskIds) => {
  const groups = new Map(taskIds.map((t) => [t, new Set()]))
  let stopped = false
  const loop = (async () => {
    while (!stopped) {
      for (const t of taskIds) { try { for (const g of lapCodexGroups(t)) groups.get(t).add(g) } catch { /* ssh 抖动，下一轮 */ } }
      await sleep(2_000)
    }
  })()
  return { groups, stop: async () => { stopped = true; await loop } }
}

// ------------------------------------------------------------------ CrossMini Worker

const workers = []
const killWorkers = () => { for (const w of workers) { try { w.kill('SIGKILL') } catch { /* 已退出 */ } } }
process.on('exit', () => { killWorkers(); try { restoreLap() } catch { /* 主流程 finally 已处理并报告 */ } })

const workerEnv = (extra = {}) => ({
  ...process.env,
  RUNNER_ID: LOCAL_RUNNER, RUNNER_TENANT: 'team-ycc', RUNNER_ALLOWED_TENANTS: 'team-ycc', RUNNER_ALLOWED_OWNERS: 'crosswarm',
  RUNNER_ALLOWED_CAPABILITIES: 'code.analyze', RUNNER_MAX_RISK: 'read-sensitive',
  TEMPORAL_TASK_QUEUE: QUEUE, CMAP_DB_SCHEMA: SCHEMA, CMAP_WORK_ROOT: workRoot,
  // 空串优先于 .env：本 e2e 不读写 Memross
  MEMROSS_URL: '', MEMROSS_TOKEN: '', CMAP_AGENTS: 'codex',
  TMPDIR: '/private/tmp', ...extra,
})

const startWorker = async (extra) => {
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'apps/worker/src/main.ts'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], env: workerEnv(extra) })
  workers.push(child)
  let errTail = ''
  child.stderr.on('data', (c) => { errTail = (errTail + c).slice(-800) })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker 60 秒内未就绪')), 60_000)
    child.stdout.on('data', (c) => { if (c.toString().includes('Worker 就绪')) { clearTimeout(timer); resolve() } })
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Worker 提前退出 code=${code}：${errTail}`)) })
  })
  return child
}
const stopWorkers = () => Promise.all(workers.splice(0).map((w) => new Promise((resolve) => {
  if (w.exitCode !== null || w.signalCode !== null) return resolve()
  w.once('exit', resolve)
  w.kill('SIGTERM')
})))

/** 测试专用：进程内 Worker，接线同 apps/worker/src/main.ts，只把远程离线宽限缩短。生产默认不变。 */
const startGraceWorker = async (offlineGraceMs) => {
  const env = workerEnv()
  const { Worker, NativeConnection } = await import('@temporalio/worker')
  const dm = await import('#domain-model')
  const { CodexAdapter } = await import('../adapters/codex-adapter/src/index.ts')
  const { RemoteRunnerAdapter } = await import('../adapters/remote-runner/src/index.ts')
  const { CODEX_CAPABILITIES } = await import('../adapters/codex-adapter/src/index.ts')
  const { buildRunnerDescriptor } = await import('../apps/worker/src/runner-config.ts')
  const { createActivities } = await import('../workflows/activities.ts')
  const { createDagActivities } = await import('../workflows/dag-activities.ts')
  const { privateKey, publicKey } = dm.loadOrCreatePermitKey(env['CMAP_PERMIT_KEY_FILE'])
  const issuer = 'cmap:local-control-plane'
  const verifierFor = (rid) => ({ mode: 'managed', verifier: (token, envelope, adapterId, ctxRunner) => {
    if (ctxRunner !== rid) throw new dm.DispatchPermitError('CLAIM_MISMATCH')
    return dm.verifyDispatchPermit(token, { publicKey, issuer, runnerId: rid, adapterId, envelope })
  } })
  const adapters = [
    new CodexAdapter({ authorization: verifierFor(LOCAL_RUNNER), outputSchemaPath: join(repoRoot, 'schemas/codex-output.v1.schema.json'), runsDir: join(workRoot, '.runs') }),
    new RemoteRunnerAdapter({ authorization: verifierFor(remoteId), baseUrl: env['CMAP_REMOTE_RUNNER_URL'], runnerId: remoteId, agentId: LAP_AGENT, workRoot, capabilities: CODEX_CAPABILITIES, offlineGraceMs }),
  ]
  const runner = buildRunnerDescriptor(env, await Promise.all(adapters.map((a) => a.discover())))
  const signDispatchPermit = (envelope, { runnerId, adapterId }) => dm.issueDispatchPermit({ privateKey, issuer, runnerId, adapterId, envelope })
  const store = new dm.PgStore({ connectionString, schema: SCHEMA })
  const connection = await NativeConnection.connect({ address: process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233' })
  const deps = { store, adapters, runner, signDispatchPermit, workRoot }
  const worker = await Worker.create({ connection, namespace: 'default', taskQueue: QUEUE, workflowsPath: join(repoRoot, 'workflows/index.ts'),
    activities: { ...createActivities(deps), ...createDagActivities(deps) } })
  const running = worker.run()
  return async () => { worker.shutdown(); await running; await connection.close(); await store.close() }
}

// ------------------------------------------------------------------ Mission

const store = new PgStore({ connectionString, schema: SCHEMA })
await store.migrate()
const conn = await Connection.connect({ address: process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233', connectTimeout: 15_000 })
const client = new Client({ connection: conn, namespace: 'default' })
await mkdir(workRoot, { recursive: true })

const route = (where) => where === 'lap' ? { preferred_agent: LAP_AGENT, fallback_agents: ['codex'] } : { preferred_agent: 'codex' }
const SLOW = 'First run the shell command `sleep 60` and wait for it to finish. Then '
const producer = (id, value, where, { slow = false, capability = 'code.analyze' } = {}) => ({
  node_id: id, capability, deps: [], criterion_ids: [id], risk_level: 'read-meta', ...route(where),
  goal: `${slow ? SLOW : ''}Write evidence/report.json containing exactly {"value":${value}}. Read it back and report the value as the actual value for criterion ${id}. Include this file as a report artifact.`,
})
const copier = (id, dep, where) => ({
  node_id: id, capability: 'code.analyze', deps: [dep], criterion_ids: [id], risk_level: 'read-meta', ...route(where),
  goal: `Read the report supplied in inputs.artifact_refs (the payload file contains JSON regardless of extension). Write evidence/report.json with {"value": the value field you read}. Report that value as the actual value for criterion ${id}. Include the report artifact. Do not assume the input; read the supplied file.`,
})
const crit = (id, expected) => ({ criterion_id: id, metric: id, operator: 'eq', expected, hard_gate: true })

/** nodes 为 DAG 节点（dag/v1）；传字符串则是 inspect/v1 单任务 Mission 的 goal（该模板不支持 preferred_agent）。 */
const startMission = async (scenario, nodes, acceptance) => {
  const requestId = `e2e-remote-${scenario}-${Date.now().toString(36)}`
  const dag = typeof nodes !== 'string'
  const mission = missionFromRequest({
    request_id: requestId, goal: dag ? `Remote runner e2e: ${scenario}` : nodes, risk_level: 'read-meta', max_additional_cycles: 0,
    acceptance, ...(dag ? { plan: { schema: 'cmap/mission-plan/v1', concurrency: 2, nodes } } : {}),
  }, 'team-ycc', 'crosswarm')
  await store.createMission({ mission, actor: { type: 'system', id: 'e2e-remote-mission' } })
  const handle = await client.workflow.start(dag ? 'dagMissionWorkflow' : 'missionWorkflow', { taskQueue: QUEUE, workflowId: requestId, args: [{ missionId: mission.id }] })
  ok(`Mission ${mission.id.slice(0, 16)}… 已启动（workflow ${requestId}）`)
  return { missionId: mission.id, handle }
}

const tasksOf = async (missionId) => {
  const tasks = await store.queryTasks({ missionId })
  return Object.fromEntries(tasks.map((t) => [t.envelope.identity.plan_node_id ?? 'solo', t]))
}
const waitTask = async (missionId, nodeId, pred, ms = 600_000) => {
  const until = Date.now() + ms
  for (;;) {
    const t = (await tasksOf(missionId))[nodeId]
    if (t && pred(t)) return t
    if (Date.now() > until) throw new Fail(`等待节点 ${nodeId} 超时`)
    await sleep(1_000)
  }
}
/** lap 上出现该任务的运行记录且 codex 进程组在跑。 */
const waitLapRunning = async (taskId) => {
  for (let i = 0; i < 120; i += 1) {
    const pid = lapRecordPid(taskId)
    if (pid && lapCodexGroups(taskId).size) return pid
    await sleep(2_000)
  }
  throw new Fail(`lap 上 4 分钟内没有 ${taskId} 的运行中 codex`)
}

const events = async (missionId) => store.listEvents(missionId)
const routingOf = (evs, taskId) => evs.filter((e) => e.event_type === 'ROUTING_DECIDED' && e.task_id === taskId).map((e) => e.payload)
const countOf = (evs, type, taskId) => evs.filter((e) => e.event_type === type && (!taskId || e.task_id === taskId)).length
const localRunRecord = (taskId) => access(join(workRoot, '.runs', `${taskId}.json`)).then(() => true, () => false)
const artifactPath = (taskId, a) => isAbsolute(a.uri) ? a.uri : join(workRoot, taskId, a.uri)

/** 节点在预期主机上完成：binding、路由、启动次数、产物哈希（CrossMini 复算 + lap 原件）、执行次数。 */
const verifyNode = async (missionId, t, where, groups) => {
  const evs = await events(missionId)
  const node = t.envelope.identity.plan_node_id ?? 'solo'
  check(t.state === 'COMPLETED', `${node} 状态 ${t.state}`)
  const routes = routingOf(evs, t.id)
  check(routes.length === 1, `${node} ROUTING_DECIDED ${routes.length} 条`)
  const [r] = routes
  check(countOf(evs, 'TASK_STARTED', t.id) === 1, `${node} TASK_STARTED 不是 1 条`)
  if (where === 'lap') {
    check(t.binding.adapter === 'remote-runner-adapter' && t.binding.runner_id === remoteId, `${node} binding ${t.binding.adapter}@${t.binding.runner_id}`)
    check(r.chosen_agent === LAP_AGENT && r.fallback === false, `${node} 路由 ${r.chosen_agent} fallback=${r.fallback}`)
  } else {
    check(t.binding.adapter === 'codex-adapter' && t.binding.runner_id === LOCAL_RUNNER, `${node} binding ${t.binding.adapter}@${t.binding.runner_id}`)
    check(r.chosen_agent === 'codex', `${node} 路由 ${r.chosen_agent}`)
  }
  const arts = await store.listArtifacts(t.id)
  check(arts.length > 0, `${node} 无产物`)
  for (const a of arts) {
    const local = sha256(await readFile(artifactPath(t.id, a)))
    check(local === a.sha256, `${node} 产物 ${a.role} CrossMini 复算不符`)
    if (where === 'lap') check(lapSha(`${t.id}/${a.uri}`) === a.sha256, `${node} 产物 ${a.role} 与 lap 原件哈希不符`)
  }
  const lapRuns = lapRunRecords(t.id)
  const localRun = await localRunRecord(t.id)
  if (where === 'lap') {
    check(lapRuns === 1 && !localRun, `${node} 运行记录 lap=${lapRuns} 本地=${localRun}`)
    if (groups) check(groups.size <= 1, `${node} lap codex 进程组 ${[...groups].join(',')}`)
  } else {
    check(lapRuns === 0 && localRun, `${node} 运行记录 lap=${lapRuns} 本地=${localRun}`)
  }
  ok(`${node}@${where}：COMPLETED，binding ${t.binding.adapter}@${t.binding.runner_id}，路由 ${r.chosen_agent}（fallback=${r.fallback}），` +
    `TASK_STARTED=1，${arts.length} 个产物哈希一致${where === 'lap' ? '（CrossMini 复算 = lap 原件）' : ''}，运行记录 lap=${lapRuns} 本地=${localRun ? 1 : 0}` +
    (groups ? `，lap 进程组采样 ${groups.size}` : ''))
}

const verifyCompletedMission = async (missionId, result) => {
  check(result.state === 'COMPLETED', `Mission ${result.state}：${JSON.stringify(result.nodeOutcomes?.map((o) => [o.nodeId, o.status, o.reason]) ?? result.escalationReason)}`)
  const m = await store.getMission(missionId)
  check(m.state === 'COMPLETED', `账本 Mission ${m.state}`)
  const evs = await events(missionId)
  check(countOf(evs, 'MISSION_COMPLETED') === 1 && countOf(evs, 'MISSION_ESCALATED') === 0, 'MISSION_COMPLETED/ESCALATED 计数不符')
  ok(`Mission COMPLETED（账本），MISSION_COMPLETED=1，事件 ${evs.length} 条：${evs.map((e) => e.event_type).join(' → ')}`)
}

/** 子节点的输入：信封 sha256 = 父产物 sha256 = CrossMini 子工作区字节；子节点在 lap 时再核 lap 落盘字节。 */
const verifyInputs = async (child, parent, where) => {
  const refs = child.envelope.inputs?.artifact_refs ?? []
  const parentArts = await store.listArtifacts(parent.id)
  check(refs.length === parentArts.length && refs.length > 0, `${child.envelope.identity.plan_node_id} 输入 ${refs.length} 个，父产物 ${parentArts.length} 个`)
  for (const ref of refs) {
    const pa = parentArts.find((a) => a.artifact_id === ref.artifact_id)
    check(pa && pa.sha256 === ref.sha256, '输入引用与父产物哈希不符')
    check(sha256(await readFile(join(workRoot, child.id, ref.uri))) === ref.sha256, 'CrossMini 子工作区输入字节哈希不符')
    if (where === 'lap') check(lapSha(`${child.id}/${ref.uri}`) === ref.sha256, 'lap 子工作区输入字节哈希不符')
  }
  ok(`${child.envelope.identity.plan_node_id} 输入 ${refs.length} 个：信封 = 父产物 = CrossMini 字节${where === 'lap' ? ' = lap 落盘字节' : ''}`)
}

// ------------------------------------------------------------------ 场景

const scenarios = {
  async remote() {
    await startWorker()
    const { missionId, handle } = await startMission('remote', [producer('solo', 7, 'lap')], [crit('solo', 7)])
    const result = await handle.result()
    await verifyCompletedMission(missionId, result)
    await verifyNode(missionId, (await tasksOf(missionId)).solo, 'lap')
  },

  dag: () => crossHostDag([['lp', 17, 'local', 'lc', 'lap'], ['rp', 25, 'lap', 'rc', 'local']]),
  /** 只跑 lap→CrossMini 一条链：lap 守护进程尚未部署 DAG 输入契约（9edbd69 之前）时用。 */
  'dag-reverse': () => crossHostDag([['rp', 25, 'lap', 'rc', 'local']]),

  async offline() {
    await startWorker()
    stopLap()
    check(daemonPid() === 'unloaded', 'lap 守护进程未停')
    ok('lap 守护进程已 bootout')
    try {
      const { missionId, handle } = await startMission('offline', [producer('solo', 7, 'lap')], [crit('solo', 7)])
      const result = await handle.result()
      await verifyCompletedMission(missionId, result)
      const t = (await tasksOf(missionId)).solo
      const [r] = routingOf(await events(missionId), t.id)
      check(r.fallback === true && JSON.stringify(r.candidates.map((c) => [c.agent_id, c.verdict, c.reason])) ===
        JSON.stringify([[LAP_AGENT, 'skipped', 'unhealthy'], ['codex', 'selected', null]]), `路由 ${JSON.stringify(r.candidates)}`)
      ok(`ROUTING_DECIDED：${LAP_AGENT} skipped(unhealthy) → codex selected，fallback=true`)
      await verifyNode(missionId, t, 'local')
    } finally {
      restoreLap()
    }
  },

  async capability() {
    await startWorker({ RUNNER_ALLOWED_CAPABILITIES: 'code.analyze,code.implement' })
    const { missionId, handle } = await startMission('capability', [producer('impl', 7, 'lap', { capability: 'code.implement' })], [crit('impl', 7)])
    const result = await handle.result()
    const t = (await tasksOf(missionId)).impl
    const evs = await events(missionId)
    const routes = routingOf(evs, t.id)
    const lapRuns = lapRunRecords(t.id)
    const localRun = await localRunRecord(t.id)
    const kinds = evs.filter((e) => e.task_id === t.id).map((e) => e.event_type)
    ok(`Mission ${result.state}，任务 ${t.state}，binding ${t.binding ? `${t.binding.adapter}@${t.binding.runner_id}` : '无'}`)
    ok(`ROUTING_DECIDED ${routes.length} 条：${JSON.stringify(routes.map((r) => r.candidates.map((c) => [c.agent_id, c.verdict, c.reason])))}`)
    ok(`任务事件：${kinds.join(' → ')}；${result.nodeOutcomes.map((o) => `${o.nodeId}:${o.status}:${o.reason ?? ''}`).join(',')}`)
    check(lapRuns === 0, `lap 上有 ${lapRuns} 条运行记录：能力不匹配的任务在 lap 上执行了`)
    check(routes.length === 1 && routes[0].fallback === true && JSON.stringify(routes[0].candidates.map((c) => [c.agent_id, c.verdict, c.reason])) ===
      JSON.stringify([[LAP_AGENT, 'skipped', 'capability_mismatch'], ['codex', 'selected', null]]), '路由未按 capability_mismatch 回落本地')
    await verifyCompletedMission(missionId, result)
    await verifyNode(missionId, t, 'local')
    ok(`lap 运行记录 0、本地运行记录 ${localRun ? 1 : 0}`)
  },

  async 'lap-restart'() {
    await startWorker()
    const { missionId, handle } = await startMission('lap-restart', [producer('solo', 7, 'lap', { slow: true })], [crit('solo', 7)])
    const t0 = await waitTask(missionId, 'solo', (t) => t.binding)
    const codexPid = await waitLapRunning(t0.id)
    const s = sampler([t0.id])
    await sleep(5_000)
    const before = daemonPid()
    lap(`launchctl kickstart -k ${LABEL}`)
    let after = daemonPid()
    for (let i = 0; i < 15 && (typeof after !== 'number' || after === before); i += 1) { await sleep(1_000); after = daemonPid() }
    check(typeof after === 'number' && after !== before, `守护进程未重启：${before} → ${after}`)
    ok(`lap 守护进程 kickstart -k：pid ${before} → ${after}；codex 进程组 ${codexPid} 仍在：${lapCodexGroups(t0.id).has(codexPid)}`)
    const result = await handle.result()
    await s.stop()
    await verifyCompletedMission(missionId, result)
    await verifyNode(missionId, (await tasksOf(missionId)).solo, 'lap', s.groups)
  },

  /** dag/v1：runDagAttempt 不重试（maximumAttempts 1），Worker 被杀即心跳超时升级——只核不重跑。 */
  async 'worker-restart'() {
    const { missionId, result, s } = await killWorkerDuringLapRun('worker-restart', [producer('solo', 7, 'lap', { slow: true })])
    const t = (await tasksOf(missionId)).solo
    const evs = await events(missionId)
    ok(`Mission ${result.state}：${result.nodeOutcomes.map((o) => `${o.nodeId}:${o.status}:${o.reason ?? ''}`).join(',')}，任务 ${t.state}`)
    check(t.binding?.runner_id === remoteId, 'binding 未保留在 lap')
    check(routingOf(evs, t.id).length === 1 && countOf(evs, 'TASK_STARTED', t.id) === 1, '出现改派或二次启动')
    check((await store.queryTasks({ missionId })).length === 1 && !(await localRunRecord(t.id)), '出现重跑')
    check(lapRunRecords(t.id) === 1 && s.groups.size <= 1, `lap 运行记录 ${lapRunRecords(t.id)}、进程组 ${s.groups.size}`)
    ok(`binding 保留 lap，ROUTING_DECIDED=1，TASK_STARTED=1，任务数 1，lap 运行记录 1、进程组采样 ${s.groups.size}，本地 0`)
  },

  /** inspect/v1：本机 codex 设为不健康（测试专用 CODEX_BIN），路由按注册顺序落到 codex@lap；Worker 重启后应完成。 */
  async 'worker-restart-inspect'() {
    const goal = `${SLOW}write evidence/report.json containing exactly {"value":7}. Read it back and report the value as the actual value for criterion solo. Include this file as a report artifact.`
    const { missionId, result, s } = await killWorkerDuringLapRun('worker-restart-inspect', goal, { CODEX_BIN: '/nonexistent/codex' })
    await verifyCompletedMission(missionId, result)
    const t = (await tasksOf(missionId)).solo
    const evs = await events(missionId)
    check(countOf(evs, 'INPUT_REQUIRED') === 0, '出现 INPUT_REQUIRED')
    ok(`ROUTING_DECIDED：${JSON.stringify(routingOf(evs, t.id)[0].candidates.map((c) => [c.agent_id, c.verdict, c.reason]))}`)
    await verifyNode(missionId, t, 'lap', s.groups)
  },

  async 'lap-offline'() { await offlineDuringRun('lap-offline') },
  async grace() { await offlineDuringRun('grace', 30_000) },
}

/** 每条链：父节点在 a、子节点在 b，子节点读取父产物。 */
const crossHostDag = async (chains) => {
  await startWorker()
  const { missionId, handle } = await startMission('dag', chains.flatMap(([p, v, a, c, b]) => [producer(p, v, a), copier(c, p, b)]),
    chains.flatMap(([p, v, , c]) => [crit(p, v), crit(c, v)]))
  const result = await handle.result()
  const t = await tasksOf(missionId)
  if (result.state !== 'COMPLETED') {
    for (const o of result.nodeOutcomes) ok(`节点 ${o.nodeId}：${o.status}:${o.reason ?? ''}，lap 运行记录 ${o.taskId ? lapRunRecords(o.taskId) : '-'}`)
  }
  await verifyCompletedMission(missionId, result)
  for (const [p, , a, c, b] of chains) {
    await verifyNode(missionId, t[p], a)
    await verifyNode(missionId, t[c], b)
    await verifyInputs(t[c], t[p], b)
  }
  const evs = await events(missionId)
  for (const [p, , , c] of chains) {
    const created = evs.findIndex((e) => e.event_type === 'TASK_CREATED' && e.task_id === t[c].id)
    const accepted = evs.findIndex((e) => e.event_type === 'REVIEW_ACCEPTED' && e.task_id === t[p].id)
    check(accepted >= 0 && accepted < created, `${c} 在 ${p} 验收前创建`)
  }
  ok('子节点均在父节点 REVIEW_ACCEPTED 之后创建')
}

const killWorkerDuringLapRun = async (scenario, nodes, workerExtra) => {
  const first = await startWorker(workerExtra)
  const { missionId, handle } = await startMission(scenario, nodes, [crit('solo', 7)])
  const t0 = await waitTask(missionId, 'solo', (t) => t.binding)
  check(t0.binding.runner_id === remoteId, `未派到 lap：${t0.binding.adapter}@${t0.binding.runner_id}`)
  await waitLapRunning(t0.id)
  const s = sampler([t0.id])
  await sleep(5_000)
  first.kill('SIGKILL')
  await new Promise((r) => first.once('exit', r))
  ok(`CrossMini Worker ${first.pid} 已 SIGKILL（lap 上 codex 在跑）`)
  await startWorker(workerExtra)
  ok('新 Worker 已就绪')
  const result = await handle.result()
  await s.stop()
  return { missionId, result, s }
}

/** 执行中 lap 离线：只认账本——不完成、不改派、不回落本地、binding 保留、只启动 1 次；lap 恢复后运行记录仍 1 条。 */
const offlineDuringRun = async (scenario, graceMs) => {
  const stopGrace = graceMs ? await startGraceWorker(graceMs) : (await startWorker(), null)
  try {
    const { missionId, handle } = await startMission(scenario, [producer('solo', 7, 'lap', { slow: true })], [crit('solo', 7)])
    const t0 = await waitTask(missionId, 'solo', (t) => t.binding)
    await waitLapRunning(t0.id)
    const offAt = Date.now()
    stopLap()
    ok(`lap 守护进程已 bootout（执行中）${graceMs ? `，测试宽限 ${graceMs / 1000}s` : '，生产默认配置'}`)
    let result
    try {
      result = await handle.result()
    } finally {
      restoreLap()
    }
    const waited = Math.round((Date.now() - offAt) / 1000)
    const t = (await tasksOf(missionId)).solo
    const evs = await events(missionId)
    const outcome = result.nodeOutcomes.find((o) => o.nodeId === 'solo')
    ok(`离线 ${waited}s 后 Workflow 返回：Mission ${result.state}，节点 ${outcome.status}:${outcome.reason}，任务 ${t.state}`)
    check(result.state !== 'COMPLETED', '离线后不应完成')
    check(t.binding?.runner_id === remoteId && t.binding.adapter === 'remote-runner-adapter', 'binding 未保留在 lap')
    check(routingOf(evs, t.id).length === 1, '出现第二次路由（改派）')
    check(countOf(evs, 'TASK_STARTED', t.id) === 1, 'TASK_STARTED 不是 1 条')
    check((await store.queryTasks({ missionId })).length === 1, '派生了新任务（重跑）')
    check(!(await localRunRecord(t.id)), '本地出现运行记录（回落本地重跑）')
    if (graceMs) check(outcome.reason?.startsWith('EXECUTION_UNCERTAIN') && t.state === 'INPUT_REQUIRED', `应为执行不确定：${outcome.reason} / ${t.state}`)
    ok(`binding ${t.binding.adapter}@${t.binding.runner_id} 保留，ROUTING_DECIDED=1，TASK_STARTED=1，任务数 1，本地运行记录 0`)
    ok(`任务事件：${evs.filter((e) => e.task_id === t.id).map((e) => e.event_type).join(' → ')}`)
    for (let i = 0; i < 30 && typeof daemonPid() !== 'number'; i += 1) await sleep(1_000)
    const runs = lapRunRecords(t.id)
    check(runs === 1, `lap 运行记录 ${runs} 条`)
    ok(`lap 恢复（pid ${daemonPid()}），该任务运行记录 ${runs} 条`)
  } finally {
    if (stopGrace) await stopGrace()
  }
}

// ------------------------------------------------------------------ 入口

const names = process.argv.slice(2)
if (!names.length || names.some((n) => !scenarios[n])) {
  console.error(`用法：node scripts/e2e-remote-mission.mjs <${Object.keys(scenarios).join('|')}>...`)
  process.exit(2)
}
try {
  if (lap(`readlink ~/.local/share/cmap-runner/current`).trim().split('/').pop()) ok(`lap 部署 ${lap('readlink ~/.local/share/cmap-runner/current').trim().split('/').pop()}，守护进程 pid ${daemonPid()}`)
  restoreLap()
  for (const name of names) {
    console.log(`\n[${name}]`)
    await scenarios[name]()
    await stopWorkers()
  }
  console.log(`\n✅ ${names.join(', ')} 通过`)
} catch (error) {
  console.error(`  ✗ ${error instanceof Fail ? error.message : error?.stack ?? error}`)
  process.exitCode = 1
} finally {
  await stopWorkers()
  try { restoreLap() } catch (e) { console.error(`  ✗ 恢复 lap 守护进程失败：${e.message}`); process.exitCode = 1 }
  for (let i = 0; i < 30 && typeof daemonPid() !== 'number'; i += 1) await sleep(1_000)
  console.log(`lap 守护进程最终状态：${daemonPid()}`)
  await conn.close()
  await store.close()
}
process.exit(process.exitCode ?? 0)
