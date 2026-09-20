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
 *
 * 前置：
 *   docker compose -f infra/docker-compose/docker-compose.yml up -d
 *   node scripts/verify-temporal.mjs
 *   npm run start:worker      # 另开一个终端，Worker 必须在跑
 *
 * 用法：node scripts/e2e-mission.mjs
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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

// 返工场景：目标只建 3 个文件，验收却要求 5 个——Agent 无论怎么努力都够不着。
// 这样才能在真实链路上验证「返工 → 预算耗尽 → 升级给人」，而不是只验证顺利路径。
const reworkMode = process.argv.includes('--rework')

const step = (n, msg) => console.log(`\n[${n}] ${msg}`)
const ok = (msg) => console.log(`  ✓ ${msg}`)
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  process.exit(1)
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
      '随后统计 sample/ 下的文件数量，把统计结果写入 evidence/report.json。',
    constraints: reworkMode ? { max_additional_cycles: 1 } : {},
    // 机读验收标准：由确定性程序比对，不看 Agent 的措辞
    acceptance: [
      {
        criterion_id: 'FILE-COUNT',
        metric: 'sample_file_count',
        operator: 'eq',
        expected: reworkMode ? 5 : 3,
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
try {
  result = await client.workflow.execute('missionWorkflow', {
    taskQueue,
    workflowId: `e2e-${missionId}`,
    args: [{ missionId }],
  })
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

console.log(`\n✅ P2 出口达成：控制面无人值守跑完一次 Mission，Agent 真实执行并留下可复核的证据。`)

await conn.close()
await store.close()
