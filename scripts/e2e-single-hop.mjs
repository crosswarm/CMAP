/**
 * P0 出口验证：Claude → Codex 单跳闭环。
 *
 * 验证链路（每一步都必须真实通过，不接受表象）：
 *   1. 构造自洽的 TaskEnvelope，经 Schema 校验
 *   2. 派发给 codex-adapter，真实 spawn codex 进程
 *   3. 收取结果，经 TaskResult Schema 校验
 *   4. 校验证据产物真实存在且 sha256 与声明一致
 *   5. 逐条比对 criterion_results 是否覆盖信封声明的验收标准
 *
 * 刻意选一个极小的只读任务：链路本身的问题不会和任务复杂度混在一起。
 *
 * 用法：node scripts/e2e-single-hop.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { CodexAdapter } from '../adapters/codex-adapter/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const schemaDir = join(root, 'schemas')

// Surge 拦截 localhost 会造成静默挂起，显式排除
process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'

const ajv = new Ajv({ strict: true, allErrors: true })
addFormats(ajv)
const load = (n) => JSON.parse(readFileSync(join(schemaDir, n), 'utf8'))
const validateEnvelope = ajv.compile(load('task-envelope.v1.schema.json'))
const validateResult = ajv.compile(load('task-result.v1.schema.json'))

const step = (n, msg) => console.log(`\n[${n}] ${msg}`)
const ok = (msg) => console.log(`  ✓ ${msg}`)
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  process.exit(1)
}

// -------------------------------------------------- 1. 构造并校验信封

step(1, '构造 TaskEnvelope')

const workDir = await mkdtemp(join(tmpdir(), 'cmap-e2e-'))
const sampleDir = join(workDir, 'sample')
await mkdir(sampleDir, { recursive: true })
// 固定内容的样本，使验收标准可预期
for (const n of ['a.txt', 'b.txt', 'c.txt']) {
  await writeFile(join(sampleDir, n), `sample ${n}\n`, 'utf8')
}
ok(`样本目录已建：sample/ 下 3 个文件`)

const TASK_ID = 'tsk-e2e-filecount-001'

const envelope = {
  schema: 'cmap/task-envelope/v1',
  identity: {
    mission_id: 'mis-e2e-001',
    task_id: TASK_ID,
    parent_task_id: null,
    supersedes_task_id: null,
    correlation_id: 'corr-e2e-001',
    idempotency_key: `mis-e2e-001:filecount:${TASK_ID}`,
    revision: 1,
    lamport: 1,
    tenant: 'team-ycc',
    owner: 'crosswarm',
  },
  classification: {
    task_type: 'inspect.filecount',
    requested_capability: 'code.analyze',
    risk_level: 'read-meta',
    priority: 50,
    confidentiality: 'internal',
  },
  goal: {
    statement:
      '统计工作目录下 sample/ 子目录中的文件数量，并把结果写入证据文件 evidence/filecount.json。',
    success_definition: [
      {
        criterion_id: 'FILE-COUNT',
        metric: 'sample_file_count',
        operator: 'eq',
        expected: 3,
        hard_gate: true,
      },
    ],
  },
  inputs: {
    parameters: { target_dir: 'sample' },
    context_summary: '这是控制面链路的端到端连通性验证任务，刻意保持极小。',
  },
  environment: { locale: 'zh-CN' },
  execution_policy: {
    timeout_seconds: 300,
    max_attempts: 1,
  },
  permissions: {
    repository: { read: true, write: false },
    forbidden: ['production_access', 'network_write'],
  },
  evidence_requirements: {
    required_artifact_roles: ['filecount_report'],
  },
  output_contract: {
    schema_uri: 'https://cmap.local/schemas/task-result/v1',
    final_statuses: ['completed', 'failed'],
  },
}

if (!validateEnvelope(envelope)) {
  fail(`信封不符合 Schema：${JSON.stringify(validateEnvelope.errors, null, 2)}`)
}
ok('信封通过 task-envelope v1 校验')

// ------------------------------------------------------- 2. 派发执行

step(2, '派发给 codex-adapter（将真实调用 codex，耗时约 1-3 分钟）')

const adapter = new CodexAdapter({
  // 传给 codex 的是 OpenAI structured outputs 兼容子集，
  // 不是控制面用来校验账本的严格 schema
  outputSchemaPath: join(schemaDir, 'codex-output.v1.schema.json'),
})

const health = await adapter.health()
if (health.state !== 'healthy') fail(`codex 不可用：${health.detail}`)
ok(`codex 可用：${health.detail}`)

const started = Date.now()
const binding = await adapter.startTask(envelope, {
  token: 'local-dev-token',
  runner_id: 'local-dev',
  trace_id: 'trace-e2e-001',
  correlation_id: 'corr-e2e-001',
  worktree: workDir,
  deadline_at: new Date(Date.now() + 300_000).toISOString(),
})
ok(`已派发：${binding.remote_task_id}`)

// 幂等性：同一 idempotency_key 重复派发必须复用，不得重跑
const again = await adapter.startTask(envelope, {
  token: 'local-dev-token',
  runner_id: 'local-dev',
  trace_id: 'trace-e2e-001',
  correlation_id: 'corr-e2e-001',
  worktree: workDir,
  deadline_at: new Date(Date.now() + 300_000).toISOString(),
})
if (again.remote_task_id !== binding.remote_task_id) {
  fail('重复派发产生了新的 binding —— 幂等去重失效')
}
ok('重复派发复用同一 binding（幂等去重生效）')

let events = 0
await adapter.subscribe(binding, async (e) => {
  events += 1
  if (e.kind === 'tool_call' || e.kind === 'failed') {
    process.stdout.write(`  · ${e.kind}${e.message ? `: ${e.message}` : ''}\n`)
  }
})

// 轮询至终态。显式超时，宁可明确失败也不静默挂起。
const deadline = Date.now() + 300_000
let status
for (;;) {
  status = await adapter.getStatus(binding)
  if (status.terminal_observed) break
  if (Date.now() > deadline) fail('等待超时（300s），任务未达终态')
  await new Promise((r) => setTimeout(r, 2000))
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1)
ok(`达到终态 ${status.status}，耗时 ${elapsed}s，收到 ${events} 个事件`)

if (status.status !== 'completed') {
  fail(`codex 未成功完成：${status.detail}`)
}

// --------------------------------------------------- 3. 收取并校验结果

step(3, '收取结果并校验 Schema')

let result
try {
  result = await adapter.collectResult(binding)
} catch (e) {
  fail(`收取结果失败：${e?.name} ${e?.message}`)
}
ok('结果已收取')

if (!validateResult(result)) {
  fail(`结果不符合 Schema：${JSON.stringify(validateResult.errors, null, 2)}`)
}
ok('结果通过 task-result v1 校验')

if (result.task_id !== TASK_ID) fail(`task_id 不匹配：${result.task_id}`)
ok(`task_id 正确回填：${result.task_id}`)

// ------------------------------------------ 4. 证据必须真实存在且哈希一致

step(4, '校验证据产物（无证据即失败）')

const requiredRoles = envelope.evidence_requirements.required_artifact_roles
for (const role of requiredRoles) {
  const art = (result.artifacts ?? []).find((a) => a.role === role)
  if (!art) fail(`缺少证据角色 ${role}`)

  // uri 可能是相对路径或 file:// ，都解析到工作区
  const rel = art.uri.replace(/^file:\/\//, '')
  const path = isAbsolute(rel) ? rel : join(workDir, rel)
  if (!existsSync(path)) fail(`证据文件不存在：${art.uri}（解析为 ${path}）`)

  const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (actual.toLowerCase() !== art.sha256.toLowerCase()) {
    fail(`证据 ${role} 的 sha256 不符：声明 ${art.sha256}，实际 ${actual}`)
  }
  ok(`证据 ${role} 存在且 sha256 一致`)

  console.log(`    内容：${readFileSync(path, 'utf8').trim().slice(0, 200)}`)
}

// ------------------------------------------- 5. 验收标准必须被逐条回应

step(5, '校验验收标准覆盖')

for (const c of envelope.goal.success_definition) {
  const r = (result.criterion_results ?? []).find((x) => x.criterion_id === c.criterion_id)
  if (!r) fail(`验收标准 ${c.criterion_id} 未被回应`)
  ok(`${c.criterion_id}: actual=${JSON.stringify(r.actual)} passed=${r.passed}`)
  if (c.criterion_id === 'FILE-COUNT' && r.passed !== true) {
    fail(`硬门槛 ${c.criterion_id} 未通过（期望 3 个文件）`)
  }
}

await adapter.cleanup(binding)

console.log('\n════════════════════════════════════════')
console.log('P0 出口验证通过：Claude→Codex 单跳闭环打通')
console.log('════════════════════════════════════════')
console.log(`工作区：${workDir}`)
