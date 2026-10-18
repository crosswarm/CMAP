/**
 * P2 出口验证：一次 Mission 无人值守跑完，Agent 真的干活。
 *
 * 与 e2e-single-hop.mjs 的区别：那个直接调 Adapter，证明「能调起 codex」；
 * 这个走完整控制面——Temporal Workflow 派发 → Agent 真实执行 → 收结果 →
 * 落账本 → 逐条验收，证明「调度系统真的会去调注册的 Agent」。两头都在不等于线接上了。
 *
 * 两种场景：
 *   node scripts/e2e-mission.mjs            一次过（accept 路径）
 *   node scripts/e2e-mission.mjs --rework   验收标准故意够不着，验证返工与升级
 *   node scripts/e2e-mission.mjs --memory <project_id> [--memory-query <q>]
 *                                          派发前从 Memross 冻结记忆快照，验证它真的进了 Agent 上下文
 *                                          （Worker 需配置 MEMROSS_URL / MEMROSS_TOKEN）
 *   node scripts/e2e-mission.mjs --restart-worker
 *                                          重启安全（S1）：脚本自己拉起 Worker，Codex 执行期间 SIGKILL 它再拉起新的，
 *                                          判据只认账本状态与 Codex 执行次数（进程组计数 + 运行记录），不认退出码。
 *                                          此模式下不要另开 Worker；Codex 需要 TMPDIR=/private/tmp
 *
 * 前置：
 *   docker compose -f infra/docker-compose/docker-compose.yml up -d
 *   node scripts/verify-temporal.mjs
 *   npm run start:worker      # 另开一个终端，Worker 必须在跑
 *
 * 用法：node scripts/e2e-mission.mjs
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Surge 拦截 localhost 会造成静默挂起，显式排除
process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'
process.env['grpc_proxy'] = ''

const { PgStore } = await import('#domain-model')
const { Client, Connection } = await import('@temporalio/client')

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

const address = process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233'
const namespace = process.env['TEMPORAL_NAMESPACE'] ?? 'default'
const taskQueue = process.env['TEMPORAL_TASK_QUEUE'] ?? 'cmap-main'
const connectionString =
  process.env['CMAP_DATABASE_URL'] ?? 'postgres://temporal:temporal@localhost:5433/cmap'
const schema = process.env['CMAP_DB_SCHEMA'] ?? 'public'
const workRoot = process.env['CMAP_WORK_ROOT'] ?? join(repoRoot, '.cmap-work')

// 返工场景：任何有限数字都不能小于最小有限数，控制面比较必定拒绝。
// 要求 5 个会被补建文件满足，要求 -1 仍可能被 Agent 虚报满足；磁盘数量另行核验。
// 这样才能在真实链路上验证「返工 → 预算耗尽 → 升级给人」，而不是只验证顺利路径。
const reworkMode = process.argv.includes('--rework')
const argAfter = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined }
const memoryProject = argAfter('--memory')
const memoryQuery = argAfter('--memory-query')
if (reworkMode && memoryProject) throw new Error('--memory 与 --rework 不同时使用')
const restartWorker = process.argv.includes('--restart-worker')
if (restartWorker && (reworkMode || memoryProject)) throw new Error('--restart-worker 不与 --rework / --memory 同用')

const step = (n, msg) => console.log(`\n[${n}] ${msg}`)
const ok = (msg) => console.log(`  ✓ ${msg}`)
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  process.exit(1)
}

// ------------------------------------------- --restart-worker 的 Worker 管理

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const workers = []
process.on('exit', () => { for (const w of workers) { try { process.kill(w.pid, 'SIGKILL') } catch { /* 已退出 */ } } })

const startWorker = async () => {
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'apps/worker/src/main.ts'], {
    cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      // 本机 runner 准入默认值（与上面建的 Mission 匹配）；外部显式设置的同名变量优先
      RUNNER_ID: 'e2e-restart', RUNNER_TENANT: 'team-ycc', RUNNER_ALLOWED_TENANTS: 'team-ycc',
      RUNNER_ALLOWED_OWNERS: 'crosswarm', RUNNER_ALLOWED_CAPABILITIES: 'code.analyze', RUNNER_MAX_RISK: 'read-sensitive',
      ...process.env, TMPDIR: process.env['TMPDIR'] ?? '/private/tmp',
    },
  })
  workers.push(child)
  // 不回显 Worker 输出，只等就绪标志
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker 60 秒内未就绪')), 60_000)
    child.stdout.on('data', (c) => { if (c.toString().includes('Worker 就绪')) { clearTimeout(timer); resolve() } })
    child.stderr.resume()
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Worker 提前退出 code=${code}`)) })
  })
  return child
}

const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true } catch { return false } }

/** 当前所有执行该任务的 codex 进程组（按结果文件名识别，同组后代只算一个）。 */
const codexGroups = (taskId) => {
  const out = execFileSync('ps', ['-axo', 'pgid=,command='], { maxBuffer: 64 * 1024 * 1024 }).toString()
  const needle = `.cmap-result-${taskId}.json`
  const groups = new Set()
  for (const line of out.split('\n')) {
    if (!line.includes(needle) || !line.includes(' exec ')) continue
    groups.add(Number(line.trim().split(/\s+/)[0]))
  }
  return groups
}

// ------------------------------------------------------ 1. 建 Mission

step(1, '在账本里建一个 Mission')

const store = new PgStore({ connectionString, schema })
await store.migrate()

const missionId = `mis-e2e-${Date.now().toString(36)}`
const now = new Date().toISOString()

await store.createMission({
  mission: {
    id: missionId,
    tenant: 'team-ycc',
    owner: 'crosswarm',
    type: 'inspect',
    goal:
      '在当前工作目录下新建 sample/ 子目录，并在其中写入 3 个文本文件；' +
      '随后统计 sample/ 下的文件数量，把统计结果写入 evidence/report.json。' +
      (memoryProject
        ? '另外：输入证据里有 role=memory_context 的 Memross 记忆快照（Markdown，顶部有 JSON 清单）。' +
          '读取它，把清单 items 中第一条的 block_id 原样写入 evidence/report.json 的 memory_block_id 字段；没有条目则写 null。'
        : ''),
    constraints: reworkMode ? { max_additional_cycles: 1 }
      : memoryProject ? { memory: { project_id: memoryProject, ...(memoryQuery ? { query: memoryQuery } : {}), limit: 2 } } : {},
    // 机读验收标准：由确定性程序比对，不看 Agent 的措辞
    acceptance: [
      {
        criterion_id: 'FILE-COUNT',
        metric: 'sample_file_count',
        operator: reworkMode ? 'lt' : 'eq',
        expected: reworkMode ? -Number.MAX_VALUE : 3,
        hard_gate: true,
      },
    ],
    workflow_template: 'inspect/v1',
    state: 'DRAFT',
    revision: 1,
    created_at: now,
    updated_at: now,
  },
  actor: { type: 'system', id: 'e2e-mission' },
})
ok(`Mission ${missionId} 已入账本（schema=${schema}）`)

// -------------------------------------------- 2. 交给控制面无人值守跑

step(2, `启动 Workflow（队列 ${taskQueue}，Agent 真实执行，耗时约 1-3 分钟）`)

const conn = await Connection.connect({ address, connectTimeout: 15_000 })
const client = new Client({ connection: conn, namespace })

const started = Date.now()
let result
let chaos = null
try {
  if (restartWorker) {
    const stale = execFileSync('ps', ['-axo', 'command=']).toString().split('\n').filter((l) => l.includes('apps/worker/src/main.ts'))
    if (stale.length) fail('检测到已在运行的 Worker；--restart-worker 需要独占队列，请先停掉它')
    workers.length = 0
    await startWorker()
  }
  const handle = await client.workflow.start('missionWorkflow', {
    taskQueue,
    workflowId: `e2e-${missionId}`,
    args: [{ missionId }],
  })
  const chaosRun = restartWorker ? (async () => {
    // 等 Codex 真的在跑：运行记录里出现本 Mission 的 pid
    let record
    for (let i = 0; i < 600 && !record; i += 1) {
      await sleep(200)
      for (const name of await readdir(join(workRoot, '.runs')).catch(() => [])) {
        if (!name.endsWith('.json')) continue
        const r = JSON.parse(await readFile(join(workRoot, '.runs', name), 'utf8').catch(() => 'null') ?? 'null')
        if (r?.envelope?.identity?.mission_id === missionId && r.pid) record = r
      }
    }
    if (!record) fail('2 分钟内没有出现本 Mission 的 Codex 运行记录')
    const groups = new Set()
    const sampler = setInterval(() => { for (const g of codexGroups(record.task_id)) groups.add(g) }, 300)
    await sleep(5000)
    if (!groupAlive(record.pid)) fail('Codex 在 Worker 被杀之前就结束了，场景无效')
    const [first] = workers
    process.kill(first.pid, 'SIGKILL')
    await new Promise((resolve) => first.on('exit', resolve))
    const survived = groupAlive(record.pid)
    ok(`Worker ${first.pid} 已 SIGKILL；Codex 进程组 ${record.pid} 仍在运行：${survived}`)
    await startWorker()
    ok('新 Worker 已就绪，等待 Workflow 收尾')
    return { record, groups, sampler, survived }
  })() : Promise.resolve(null)
  result = await handle.result()
  chaos = await chaosRun
  if (chaos) clearInterval(chaos.sampler)
} catch (e) {
  fail(
    `Workflow 未完成：${String(e)}\n` +
      `  Worker 在跑吗？（npm run start:worker，且 CMAP_DB_SCHEMA 与本脚本一致）`,
  )
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1)

if (reworkMode) {
  // 期望：跑一轮不过 → 派生后继任务 → 再不过 → 预算耗尽 → 升级给人
  if (result.state !== 'ESCALATED') {
    fail(`预算耗尽后应升级给人，实际 ${result.state}（返工 ${result.rounds} 轮）`)
  }
  ok(`耗时 ${elapsed}s，返工 ${result.rounds} 轮后升级：${result.escalationReason}`)

  if (result.taskIds.length !== 2) fail(`预算 1 轮应产生 2 个任务，实际 ${result.taskIds.length}`)
  const [firstId, secondId] = result.taskIds
  const second = await store.getTask(secondId)
  if (second?.supersedes_task_id !== firstId) {
    fail('后继任务没有指向被返工的原任务——说不清第几轮卡在哪')
  }
  ok(`返工派生新任务 ${secondId}，supersedes ${firstId}`)

  for (const taskId of result.taskIds) {
    const task = await store.getTask(taskId)
    const count = (await readdir(join(workRoot, taskId, 'sample'), { withFileTypes: true }))
      .filter(entry => entry.isFile()).length
    if (count !== 3) fail(`任务 ${taskId} 没有完成原始目标：应创建 3 个文件，实际 ${count}`)
    const criterion = task?.result?.criterion_results.find(c => c.criterion_id === 'FILE-COUNT')
    if (!criterion || Number(criterion.actual) !== count || criterion.passed) {
      fail(`任务 ${taskId} 的失败标准必须与磁盘文件数 ${count} 一致`)
    }
    const artifacts = await store.listArtifacts(taskId)
    if (!artifacts.length) fail(`任务 ${taskId} 缺少真实证据`)
    for (const artifact of artifacts) {
      const path = isAbsolute(artifact.uri) ? artifact.uri : join(workRoot, taskId, artifact.uri)
      const hash = createHash('sha256').update(await readFile(path)).digest('hex')
      if (hash !== artifact.sha256.toLowerCase()) fail(`任务 ${taskId} 证据哈希不一致`)
    }
    ok(`任务 ${taskId}：磁盘数量 ${count} 与失败标准一致，证据哈希复算通过`)
  }

  const m = await store.getMission(missionId)
  if (m?.state !== 'ESCALATED') fail(`账本里的 Mission 状态是 ${m?.state}`)

  const kinds = (await store.listEvents(missionId)).map((e) => e.event_type)
  for (const need of ['REVIEW_REWORK_REQUESTED', 'MISSION_ESCALATED']) {
    if (!kinds.includes(need)) fail(`事件流缺少 ${need}`)
  }
  if (kinds.filter((kind) => kind === 'MISSION_ESCALATED').length !== 1) {
    fail('一次升级应只有一个 MISSION_ESCALATED，重复事件会让界面和通知重复报警')
  }
  ok(`返工与升级都已留痕：${kinds.join(' → ')}`)

  console.log(`\n✅ 返工闭环在真实链路上成立：够不着的标准会返工，预算耗尽即升级，不无限重试。`)
  await conn.close()
  await store.close()
  process.exit(0)
}

if (result.state !== 'COMPLETED') {
  fail(
    `Mission 未通过：${result.state}，未过标准 ${result.failedCriteria.join(', ')}，` +
      `${result.escalationReason ?? ''}摘要「${result.summary}」`,
  )
}
ok(`Mission 完成，耗时 ${elapsed}s，返工 ${result.rounds} 轮，Agent 摘要：${result.summary}`)

const taskId = result.taskIds[0]

// -------------------------------------------------- 3. 账本必须留下痕迹

step(3, '回读账本（Workflow 说完成不算，账本里有才算）')

const mission = await store.getMission(missionId)
if (mission?.state !== 'COMPLETED') fail(`账本里的 Mission 状态是 ${mission?.state}`)
ok('Mission 状态 COMPLETED')

const task = await store.getTask(taskId)
if (task?.state !== 'COMPLETED') fail(`任务状态是 ${task?.state}`)
if (!task.binding) fail('任务没有 binding —— 派发没落库')
if (process.env['CMAP_EXPECT_ADAPTER'] && task.binding.adapter !== process.env['CMAP_EXPECT_ADAPTER']) {
  fail('实际 Adapter 与 CMAP_EXPECT_ADAPTER 不一致：' + task.binding.adapter)
}
ok(`任务 ${taskId} 状态 COMPLETED，binding=${task.binding.remote_task_id}`)

if (!task.result) fail('任务没有结果 —— Agent 干了活但没落账')
if (task.result.task_id !== taskId) fail(`结果里的 task_id 是 ${task.result.task_id}`)
ok('结果已落账本，身份字段由控制面填充')

// ------------------------------------------ 4. 验收标准逐条被回应

step(4, '逐条核对验收标准')

for (const c of mission.acceptance) {
  const r = task.result.criterion_results.find((x) => x.criterion_id === c.criterion_id)
  if (!r) fail(`标准 ${c.criterion_id} 没有被回应 —— 沉默不算通过`)
  if (!r.passed) fail(`标准 ${c.criterion_id} 未通过：实测 ${JSON.stringify(r.actual)}`)
  ok(`${c.criterion_id}: 实测 ${JSON.stringify(r.actual)}，通过`)
}

// ------------------------------- 5. 证据必须真实存在且哈希对得上

step(5, '独立复算证据哈希（不采信 Agent 自报）')

const artifacts = await store.listArtifacts(taskId)
if (artifacts.length === 0) fail('账本里没有证据产物')

for (const a of artifacts) {
  const path = isAbsolute(a.uri) ? a.uri : join(workRoot, taskId, a.uri)
  let bytes
  try {
    bytes = await readFile(path)
  } catch {
    fail(`证据文件不存在：${path}（角色 ${a.role}）`)
  }
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== a.sha256.toLowerCase()) {
    fail(`证据 ${a.role} 哈希不符：账本 ${a.sha256}，实际 ${actual}`)
  }
  ok(`${a.role}: ${a.uri} 存在，sha256 一致（${bytes.byteLength} 字节）`)
}

if (memoryProject) {
  step('5b', '记忆快照：信封引用、工作区字节、账本记录与 Agent 实际读取一致')
  const ref = task.envelope.inputs?.artifact_refs?.find((r) => r.role === 'memory_context')
  if (!ref) fail('信封里没有 memory_context 引用')
  const record = artifacts.find((a) => a.artifact_id === ref.artifact_id)
  if (!record || record.sha256 !== ref.sha256) fail('账本里没有与信封一致的 memory_context 记录')
  const snapshot = (await readFile(join(workRoot, taskId, ref.uri))).toString('utf8')
  if (createHash('sha256').update(snapshot).digest('hex') !== ref.sha256) fail('工作区快照与信封散列不一致')
  const manifest = JSON.parse(snapshot.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? 'null')
  const expected = manifest?.items?.[0]?.block_id ?? null
  ok(`快照 ${ref.artifact_id}：${manifest?.items?.length ?? 0} 个块，索引 ${manifest?.index_version}，search ${manifest?.search_request_id}`)
  const report = artifacts.find((a) => a.role === 'report')
  if (!report) fail('缺少 report 证据，无法核对 Agent 是否读取了快照')
  const reported = JSON.parse(await readFile(isAbsolute(report.uri) ? report.uri : join(workRoot, taskId, report.uri), 'utf8'))
  if (reported.memory_block_id !== expected) fail(`Agent 写出的 memory_block_id=${reported.memory_block_id}，快照第一条是 ${expected}`)
  ok(`Agent 读取了快照：report.memory_block_id = ${expected}`)
}

// --------------------------------------------------------- 6. 事件流

step(6, '事件流可复现整个过程')

const events = await store.listEvents(missionId)
const kinds = events.map((e) => e.event_type)
for (const need of [
  'TASK_CREATED', 'TASK_ASSIGNED', 'TASK_STARTED',
  // 通过评审而结束的任务记 REVIEW_ACCEPTED——状态是 COMPLETED，
  // 事件类型说明的是「为什么结束」
  'HARD_GATE_EVALUATED', 'REVIEW_ACCEPTED', 'MISSION_COMPLETED',
]) {
  if (!kinds.includes(need)) fail(`事件流缺少 ${need}`)
}
if (kinds.includes('MISSION_ESCALATED')) {
  fail('顺利完成的 Mission 出现了「已升级」事件——界面会据此叫人来救')
}
ok(`共 ${events.length} 条事件：${kinds.join(' → ')}`)

if (restartWorker) {
  step('6b', '重启安全：只认账本状态与 Codex 执行次数')
  if (!chaos) fail('没有执行 Worker 重启场景')
  if (!chaos.survived) fail('Worker 被杀后 Codex 进程组没有存活——输出仍绑在管道上？')
  const groups = [...chaos.groups]
  if (groups.length !== 1 || groups[0] !== chaos.record.pid) {
    fail(`Codex 进程组计数异常：观察到 [${groups.join(', ')}]，运行记录里只应有 ${chaos.record.pid}`)
  }
  if (kinds.filter((k) => k === 'TASK_STARTED').length !== 1) fail('TASK_STARTED 不是恰好 1 条')
  for (const bad of ['INPUT_REQUIRED', 'MISSION_ESCALATED']) {
    if (kinds.includes(bad)) fail(`重启后出现 ${bad}：被判成了执行不确定`)
  }
  ok(`Codex 只执行 1 次（进程组 ${chaos.record.pid}，运行记录 ${chaos.record.task_id}），Mission 与任务均 COMPLETED`)
}

console.log(`\n✅ P2 出口达成：控制面无人值守跑完一次 Mission，Agent 真实执行并留下可复核的证据。`)

// --restart-worker 自己拉起的 Worker 要优雅收掉，否则子进程会让脚本挂着不退出
await Promise.all(workers.map((w) => new Promise((resolve) => {
  if (w.exitCode !== null || w.signalCode !== null) return resolve()
  w.once('exit', resolve)
  w.kill('SIGTERM')
})))
await conn.close()
await store.close()
