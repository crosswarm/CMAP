/**
 * Q07 额度交接全链路真实验证（ADR-0009 验证计划）。
 *
 * 真实 PostgreSQL（独立 schema）+ 真实 Temporal（独占队列）+ 真实 Codex；控制面 API 用 createControlPlane 在本进程拉起，
 * Worker 也在本进程内装配（与 apps/worker 同一套 createActivities / createDagActivities），因为要把同一个
 * CodexAdapter 类注册成两个 Agent：
 *   codex-a  额度快照由本脚本注入；可执行文件是一层包装：limit 模式下写下半成品后输出 Codex 的触顶文本并以 1 退出，
 *            否则 exec 真实 codex。
 *   codex    真实 Codex，额度走真实零额度探针。
 * 三段：
 *   ① A 额度低（已用 95%）：新任务（首选 codex-a、替补 codex）派给 B，ROUTING_DECIDED 记 quota_low。
 *   ② A 额度读不到（首选不变）却在执行中触顶：mutating 任务以 QUOTA_EXHAUSTED 结束，派生同轮续接任务，
 *      重新审批后由 B 在新工作区（原工作区快照解包）完成；QUOTA_HANDOFF、快照哈希与半成品哈希可追溯。
 *   ③ A 重置时刻已过且重新探测显示允许用量（已用 3%）：新任务派回 A（真实 codex），记一次 QUOTA_RESTORED。
 * 判据只认账本状态、事件、哈希复算与 API 只读端点，不认退出码。审批由本脚本以 API owner 身份经 HTTP 决定（本机验收）。
 *
 * 用法：TMPDIR=/private/tmp node scripts/e2e-quota-handoff.mjs
 * 前置：本地栈就绪（node scripts/verify-temporal.mjs）；codex 已登录且额度可用。
 */
import { createHash, generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'
process.env['grpc_proxy'] = ''

const { PgStore, issueDispatchPermit, verifyDispatchPermit } = await import('#domain-model')
const { Client, Connection } = await import('@temporalio/client')
const { Worker, NativeConnection } = await import('@temporalio/worker')
const { CodexAdapter } = await import('../adapters/codex-adapter/src/index.ts')
const { cachedQuotaProbe, probeCodexQuota } = await import('../packages/adapter-sdk/src/quota-probe.ts')
const { buildRunnerDescriptor } = await import('../apps/worker/src/runner-config.ts')
const { createActivities } = await import('../workflows/activities.ts')
const { createDagActivities } = await import('../workflows/dag-activities.ts')
const { createControlPlane } = await import('../apps/control-plane-api/src/server.ts')
const { workflowTypeForTemplate } = await import('../apps/control-plane-api/src/workflow-routing.ts')

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const stamp = Date.now().toString(36)
const schema = process.env['CMAP_DB_SCHEMA'] ?? `e2e_quota_${stamp}`
const taskQueue = `cmap-e2e-quota-${stamp}`
const workRoot = resolve(process.env['CMAP_WORK_ROOT'] ?? join(repoRoot, '.cmap-work', `e2e-quota-${stamp}`))
const connectionString = process.env['CMAP_DATABASE_URL'] ?? 'postgres://temporal:temporal@localhost:5433/cmap'
const address = process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233'
const namespace = process.env['TEMPORAL_NAMESPACE'] ?? 'default'
const OWNER = 'crosswarm'
const TENANT = 'team-ycc'

const ok = (m) => console.log(`  ✓ ${m}`)
const step = (m) => console.log(`\n[${m}]`)
let cleanup = async () => {}
const fail = async (m) => { console.error(`  ✗ ${m}`); await cleanup().catch(() => {}); process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (b) => createHash('sha256').update(b).digest('hex')
const waitFor = async (read, ms, what) => {
  const deadline = Date.now() + ms
  for (;;) { const v = await read(); if (v) return v; if (Date.now() > deadline) await fail(`等待超时：${what}`); await sleep(500) }
}

// ------------------------------------------------------------ 假 CLI 包装

const realCodex = execFileSync('/bin/sh', ['-c', 'command -v codex']).toString().trim()
if (!realCodex) await fail('找不到 codex')
const binDir = join(workRoot, '.bin')
await mkdir(binDir, { recursive: true })
const modeFile = join(binDir, 'codex-a.mode')
const invocations = join(binDir, 'codex-a.limit-invocations')
const PARTIAL = 'partial by codex-a before hitting the usage limit'
const wrapper = join(binDir, 'codex-a')
await writeFile(modeFile, 'real')
await writeFile(wrapper, `#!/bin/sh
# Q07 测试包装：limit 模式模拟 Codex 0.159 执行中触顶（先留下半成品，再输出触顶文本，退出码 1）
if [ "$(cat '${modeFile}')" = limit ] && [ "$1" != "--version" ]; then
  dir=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "-C" ]; then dir="$arg"; fi
    prev="$arg"
  done
  mkdir -p "$dir/work"
  printf '%s' '${PARTIAL}' > "$dir/work/partial.txt"
  echo "$dir" >> '${invocations}'
  echo "ERROR: You’ve hit your usage limit. Upgrade to Pro or try again in 3 days." >&2
  exit 1
fi
exec '${realCodex}' "$@"
`)
await chmod(wrapper, 0o755)
const partialSha = sha(Buffer.from(PARTIAL))

// ------------------------------------------------------- 两个 Codex Agent

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const issuer = 'cmap:e2e-quota'
const runnerId = 'e2e-quota'
const signDispatchPermit = (envelope, { runnerId: audience, adapterId }) => issueDispatchPermit({ privateKey, issuer, runnerId: audience, adapterId, envelope })
const authorization = { mode: 'managed', verifier: (token, envelope, adapterId, contextRunner) =>
  verifyDispatchPermit(token, { publicKey, issuer, runnerId: contextRunner, adapterId, envelope }) }
const outputSchemaPath = join(repoRoot, 'schemas/codex-output.v1.schema.json')
const runsDir = join(workRoot, '.runs')

/** 同一个 Adapter 类注册成第二个 Agent：只换身份，执行逻辑与触顶分类完全相同。 */
class CodexA extends CodexAdapter {
  adapterId = 'codex-a-adapter'
  agentId = 'codex-a'
  async discover() { return { ...await super.discover(), adapter_id: this.adapterId, agent_id: this.agentId } }
  prepareBinding(envelope, ctx) { return { ...super.prepareBinding(envelope, ctx), adapter: this.adapterId } }
}

const ACCOUNT_A = sha('e2e-quota-codex-a')
let phaseQuota = () => { throw new Error('phase not set') }
const quotaA = []
const injected = async () => { const q = phaseQuota(); quotaA.push(q); return q }
const snapshotA = (used, resetsAt, overrides = {}) => ({
  schema: 'cmap/quota-snapshot/v1', provider: 'codex', account_ref: ACCOUNT_A,
  windows: [{ kind: 'primary', used_percent: used, window_minutes: 10080, resets_at: resetsAt }],
  ordinary_usage_allowed: true, observed_at: new Date().toISOString(), status: 'ok', ...overrides,
})
// CodexAdapter 内部按自己的常量 adapter_id 验签；第二身份的许可受众是 codex-a-adapter，验签时钉到这个身份。
const authorizationA = { mode: 'managed', verifier: (token, envelope, _adapterId, contextRunner) =>
  verifyDispatchPermit(token, { publicKey, issuer, runnerId: contextRunner, adapterId: 'codex-a-adapter', envelope }) }
const a = new CodexA({ authorization: authorizationA, outputSchemaPath, runsDir, bin: wrapper, quota: injected })
const b = new CodexAdapter({ authorization, outputSchemaPath, runsDir, quota: cachedQuotaProbe('codex', () => probeCodexQuota()) })
const adapters = [a, b]

// ------------------------------------------------------------ 基础设施

const store = new PgStore({ connectionString, schema })
await store.migrate()
const runner = buildRunnerDescriptor({
  RUNNER_ID: runnerId, RUNNER_TENANT: TENANT, RUNNER_ALLOWED_TENANTS: TENANT, RUNNER_ALLOWED_OWNERS: OWNER,
  RUNNER_ALLOWED_CAPABILITIES: 'code.analyze', RUNNER_MAX_RISK: 'mutating',
}, await Promise.all(adapters.map((x) => x.discover())))
const deps = { store, adapters, runner, signDispatchPermit, workRoot }
const native = await NativeConnection.connect({ address })
const worker = await Worker.create({
  connection: native, namespace, taskQueue, workflowsPath: join(repoRoot, 'workflows/index.ts'),
  activities: { ...createActivities(deps), ...createDagActivities(deps) },
})
const running = worker.run()
const connection = await Connection.connect({ address, connectTimeout: 15_000 })
const client = new Client({ connection, namespace })
const api = await createControlPlane({
  store, tenant: TENANT, owner: OWNER, workRoot,
  startMission: async (missionId, workflowId) => {
    const mission = await store.getMission(missionId)
    await client.workflow.start(workflowTypeForTemplate(mission.workflow_template), {
      workflowId, taskQueue, args: [{ missionId }], workflowIdReusePolicy: 'REJECT_DUPLICATE', workflowIdConflictPolicy: 'USE_EXISTING',
    })
  },
  notifyApprovalDecided: async (_missionId, workflowId) => client.workflow.getHandle(workflowId).signal('approvalDecided'),
})
await api.listen(0)
cleanup = async () => {
  worker.shutdown()
  await running.catch(() => {})
  await api.close()
  await connection.close()
  await native.close()
  await store.close()
}
const base = `http://127.0.0.1:${api.address().port}`
const http = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, body: await res.json() }
}
ok(`schema=${schema} queue=${taskQueue} workRoot=${workRoot}`)

const GOAL = '在当前工作目录下新建 sample/ 子目录，并在其中写入 3 个文本文件；随后统计 sample/ 下的文件数量，把统计结果写入 evidence/report.json。'
const COUNT = { criterion_id: 'FILE-COUNT', metric: 'sample_file_count', operator: 'eq', expected: 3 }
const createMission = async (tag, { goal = GOAL, acceptance = [COUNT], risk = 'read-meta' } = {}) => {
  const res = await http('POST', '/v1/missions', {
    request_id: `q07-${stamp}-${tag}`, goal, acceptance, risk_level: risk, max_additional_cycles: 0,
    plan: { schema: 'cmap/mission-plan/v1', nodes: [{ node_id: 'main', goal, capability: 'code.analyze', deps: [],
      criterion_ids: acceptance.map((c) => c.criterion_id), risk_level: risk, preferred_agent: 'codex-a', fallback_agents: ['codex'] }] },
  })
  if (res.status !== 202) await fail(`创建 Mission 失败：${res.status} ${JSON.stringify(res.body)}`)
  return res.body
}
const finish = async (created, ms = 900_000) => {
  let timer
  try {
    return await Promise.race([
      client.workflow.getHandle(created.workflow_id).result(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${ms / 1000}s 内未观测到终态`)), ms) }),
    ])
  } catch (error) { return fail(String(error)) } finally { clearTimeout(timer) }
}
const events = async (missionId, type) => (await store.listEvents(missionId)).filter((e) => e.event_type === type)
const routingOf = async (missionId, taskId) => (await events(missionId, 'ROUTING_DECIDED')).filter((e) => e.task_id === taskId).map((e) => e.payload)
const verdicts = (r) => r.candidates.map((c) => `${c.agent_id}:${c.verdict}${c.reason ? `(${c.reason})` : ''}`).join(' → ')
const fileSha = async (taskId, uri) => sha(await readFile(isAbsolute(uri) ? uri : join(workRoot, taskId, uri)))
const verifyArtifacts = async (taskId) => {
  const artifacts = await store.listArtifacts(taskId)
  if (!artifacts.some((x) => x.role === 'report')) await fail(`任务 ${taskId} 没有 report`)
  for (const x of artifacts) if (await fileSha(taskId, x.uri) !== x.sha256.toLowerCase()) await fail(`任务 ${taskId} 产物 ${x.role} 哈希复算不一致`)
  return artifacts
}
const approve = async (missionId, taskId) => {
  const approval = await waitFor(async () => (await store.listPendingApprovals(missionId)).find((x) => x.task_id === taskId), 120_000, `任务 ${taskId} 的审批`)
  const res = await http('POST', `/v1/approvals/${encodeURIComponent(approval.id)}/decision`, { decision: 'approved', scope: approval.scope, decided_by: OWNER })
  if (res.status !== 200) await fail(`审批失败：${res.status} ${JSON.stringify(res.body)}`)
  return approval.id
}

// ------------------------------------------------------------ ① A 额度低

step('① A 额度低（已用 95%）：新任务派给 B')
const resetsAt = new Date(Date.now() + 20_000).toISOString()
phaseQuota = () => snapshotA(95, resetsAt)
const m1 = await createMission('low')
const r1 = await finish(m1)
if (r1.state !== 'COMPLETED') await fail(`① Mission 未完成：${r1.state} ${JSON.stringify(r1.nodeOutcomes)}`)
const [t1] = await store.queryTasks({ missionId: m1.mission_id })
if (t1.binding?.adapter !== 'codex-adapter') await fail(`① 应派给 B（codex-adapter），实际 ${t1.binding?.adapter}`)
const [route1] = await routingOf(m1.mission_id, t1.id)
if (route1.candidates[0]?.reason !== 'quota_low' || route1.chosen_agent !== 'codex' || !route1.fallback) await fail(`① 路由不符：${verdicts(route1)}`)
await verifyArtifacts(t1.id)
ok(`ROUTING_DECIDED ${verdicts(route1)}；B 完成，产物哈希复算一致`)
const lowObserved = quotaA.filter((q) => q.windows[0]?.used_percent === 95).map((q) => q.observed_at)

// ---------------------------------------------- ② A 读不到额度，执行中触顶

step('② A 额度读不到（首选不变）却在执行中触顶：B 以原工作区快照续接完成')
phaseQuota = () => ({ ...snapshotA(0, null), account_ref: null, windows: [], ordinary_usage_allowed: null, status: 'unknown' })
await writeFile(modeFile, 'limit')
const PARTIAL_SHA = { criterion_id: 'PARTIAL-SHA', metric: 'partial_sha256', operator: 'eq', expected: partialSha }
const m2 = await createMission('handoff', {
  risk: 'mutating', acceptance: [COUNT, PARTIAL_SHA],
  goal: '工作区里的 work/partial.txt 是上一位 Agent 额度耗尽前留下的半成品，不要修改它。请：计算 work/partial.txt 的 sha256（十六进制小写）；' +
    '在当前工作目录下新建 sample/ 子目录并写入 3 个文本文件；把 sample/ 下的文件数量与上述 sha256 写入 evidence/report.json（字段 sample_file_count、partial_sha256）。',
})
const first = await waitFor(async () => (await store.queryTasks({ missionId: m2.mission_id }))[0], 60_000, '② 首个任务')
const apr1 = await approve(m2.mission_id, first.id)
const to = await waitFor(async () => (await store.queryTasks({ missionId: m2.mission_id })).find((t) => t.supersedes_task_id === first.id), 180_000, '② 续接任务')
await writeFile(modeFile, 'real')
const apr2 = await approve(m2.mission_id, to.id)
if (apr1 === apr2) await fail('② 续接任务复用了原审批')
const r2 = await finish(m2)
if (r2.state !== 'COMPLETED') await fail(`② Mission 未完成：${r2.state} ${JSON.stringify(r2.nodeOutcomes)}`)
const from = await store.getTask(first.id)
const done = await store.getTask(to.id)
if (from.state !== 'FAILED_TERMINAL' || from.result?.error?.code !== 'QUOTA_EXHAUSTED' || from.binding?.adapter !== 'codex-a-adapter') {
  await fail(`② 原任务应为 codex-a 的 QUOTA_EXHAUSTED/FAILED_TERMINAL，实际 ${from.state} ${from.result?.error?.code} ${from.binding?.adapter}`)
}
if (done.state !== 'COMPLETED' || done.binding?.adapter !== 'codex-adapter' || done.attempt !== from.attempt) await fail(`② 续接任务不符：${done.state} ${done.binding?.adapter} attempt=${done.attempt}`)
const limitRuns = (await readFile(invocations, 'utf8').catch(() => '')).split('\n').filter(Boolean)
if (limitRuns.length !== 1 || resolve(limitRuns[0]) !== resolve(workRoot, from.id)) await fail(`② 假 CLI 应只在原任务工作区触顶一次：${limitRuns.join(',')}`)
const handoffs = await events(m2.mission_id, 'QUOTA_HANDOFF')
const h = handoffs[0]?.payload
if (handoffs.length !== 1 || h.from_task_id !== from.id || h.to_task_id !== done.id || h.workspace !== 'snapshot' || h.exit_proof?.terminal_observed !== true ||
  JSON.stringify(h.excluded_agents) !== '["codex-a"]') await fail(`② QUOTA_HANDOFF 不符：${JSON.stringify(handoffs.map((e) => e.payload))}`)
const [route2] = await routingOf(m2.mission_id, done.id)
if (route2.candidates[0]?.reason !== 'quota_handoff_excluded' || route2.chosen_agent !== 'codex') await fail(`② 续接路由不符：${verdicts(route2)}`)
const snapshot = (await store.listArtifacts(done.id)).find((x) => x.role === 'workspace_snapshot')
if (!snapshot || snapshot.sha256 !== h.snapshot.sha256 || await fileSha(done.id, snapshot.uri) !== snapshot.sha256) await fail('② 快照登记、事件与工作区字节的散列不一致')
const bundle = JSON.parse(await readFile(join(workRoot, done.id, snapshot.uri), 'utf8'))
const inBundle = bundle.files.find((f) => f.path === 'work/partial.txt')
if (!inBundle || sha(Buffer.from(inBundle.content, inBundle.encoding)) !== partialSha) await fail('② 快照里没有原工作区的半成品')
if (sha(await readFile(join(workRoot, done.id, 'work/partial.txt'))) !== partialSha) await fail('② 新工作区里的半成品不是快照解包的那份')
await verifyArtifacts(done.id)
const partialCriterion = done.result.criterion_results.find((c) => c.criterion_id === 'PARTIAL-SHA')
if (!partialCriterion?.passed) await fail(`② B 没有读到交接的半成品：${JSON.stringify(partialCriterion)}`)
const chain = await http('GET', `/v1/missions/${encodeURIComponent(m2.mission_id)}/quota-handoffs`)
if (chain.status !== 200 || JSON.stringify(chain.body.items) !== JSON.stringify([h])) await fail(`② 交接链路端点不符：${chain.status}`)
ok(`原任务 ${from.id}（codex-a 触顶）→ 续接 ${done.id}（codex，同轮 attempt=${done.attempt}）；审批 ${apr1} / ${apr2}`)
ok(`QUOTA_HANDOFF：exit_proof=${h.exit_proof.status}@${h.exit_proof.observed_at}，快照 ${h.snapshot.artifact_id} sha256=${h.snapshot.sha256.slice(0, 16)}…（${h.snapshot.file_count} 个文件）`)
ok(`续接路由 ${verdicts(route2)}；半成品 sha256=${partialSha.slice(0, 16)}… 经快照到达 B 并通过 PARTIAL-SHA；产物哈希复算一致`)

// ------------------------------------------------------------ ③ A 恢复

step('③ A 重置时刻已过且重新探测允许用量：新任务派回 A，记 QUOTA_RESTORED')
await waitFor(async () => Date.now() > Date.parse(resetsAt), 60_000, '① 的重置时刻')
phaseQuota = () => snapshotA(3, new Date(Date.now() + 7 * 24 * 3600_000).toISOString())
const m3 = await createMission('restored')
const r3 = await finish(m3)
if (r3.state !== 'COMPLETED') await fail(`③ Mission 未完成：${r3.state} ${JSON.stringify(r3.nodeOutcomes)}`)
const [t3] = await store.queryTasks({ missionId: m3.mission_id })
if (t3.binding?.adapter !== 'codex-a-adapter') await fail(`③ 应派回 A（codex-a-adapter），实际 ${t3.binding?.adapter}`)
const [route3] = await routingOf(m3.mission_id, t3.id)
const restored = await events(m3.mission_id, 'QUOTA_RESTORED')
const rp = restored[0]?.payload
if (restored.length !== 1 || rp.account_ref !== ACCOUNT_A || !lowObserved.includes(rp.low_observed_at) || rp.resets_at !== resetsAt) {
  await fail(`③ QUOTA_RESTORED 不符：${JSON.stringify(restored.map((e) => e.payload))}`)
}
const others = [...await events(m1.mission_id, 'QUOTA_RESTORED'), ...await events(m2.mission_id, 'QUOTA_RESTORED')]
if (others.length) await fail('① ② 期间不应判定恢复')
await verifyArtifacts(t3.id)
const latest = await http('GET', '/v1/quota-snapshots')
const latestA = latest.body.items?.find((q) => q.account_ref === ACCOUNT_A)
if (latest.status !== 200 || latestA?.windows[0]?.used_percent !== 3) await fail(`③ 额度快照端点不符：${JSON.stringify(latestA)}`)
ok(`ROUTING_DECIDED ${verdicts(route3)}；QUOTA_RESTORED low=${rp.low_observed_at} resets=${rp.resets_at} restored=${rp.restored_observed_at}`)
ok(`GET /v1/quota-snapshots：${latest.body.items.length} 个账号，A 最新已用 3%`)

console.log(`\n✅ 额度交接全链路成立：额度低改派 → 触顶续接 → 恢复交回。schema=${schema}`)
await cleanup()
process.exit(0)
