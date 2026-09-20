/** Real Kimi Code -> normalized result -> independently checked evidence. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { KimiAdapter } from '../adapters/kimi-adapter/src/index.ts'

const workDir = await mkdtemp(join(await realpath(tmpdir()), 'cmap-kimi-e2e-'))
const id = `kimi-${Date.now().toString(36)}`
const envelope = {
  schema: 'cmap/task-envelope/v1',
  identity: { mission_id: id, task_id: id, idempotency_key: id, revision: 1 },
  classification: {
    task_type: 'inspect',
    requested_capability: 'code.analyze',
    risk_level: 'read-meta',
  },
  goal: {
    statement:
      '在当前工作目录新建 sample 子目录并写入恰好 3 个文本文件。统计数量并写 evidence/report.json；报告中的 sample_file_count 应为实际数量。',
    success_definition: [
      {
        criterion_id: 'COUNT',
        metric: 'sample_file_count',
        operator: 'eq',
        expected: 3,
        hard_gate: true,
      },
    ],
  },
  environment: {},
  execution_policy: { timeout_seconds: 180, max_attempts: 1 },
  permissions: { forbidden: ['production_access'] },
  evidence_requirements: { required_artifact_roles: ['report'] },
  output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
}
const ajv = new Ajv2020({ allErrors: true })
addFormats(ajv)
const envCheck = ajv.compile(
  JSON.parse(
    await readFile(
      new URL('../schemas/task-envelope.v1.schema.json', import.meta.url),
      'utf8',
    ),
  ),
)
assert.ok(envCheck(envelope), JSON.stringify(envCheck.errors))
const adapter = new KimiAdapter()
assert.equal((await adapter.health()).state, 'healthy')
let binding
try {
  const ctx = {
    token: 'test-harness',
    runner_id: 'kimi-e2e',
    trace_id: id,
    correlation_id: id,
    worktree: workDir,
    deadline_at: new Date(Date.now() + 180000).toISOString(),
  }
  const [first, duplicate] = await Promise.all([
    adapter.startTask(envelope, ctx),
    adapter.startTask(envelope, ctx),
  ])
  binding = first
  assert.deepEqual(duplicate, first, 'concurrent duplicate must reuse binding')
  const deadline = Date.now() + 185000
  let status
  do {
    status = await adapter.getStatus(binding)
    if (status.terminal_observed) break
    assert.ok(Date.now() < deadline, 'Kimi terminal observation timed out')
    await new Promise((r) => setTimeout(r, 200))
  } while (true)
  const result = await adapter.collectResult(binding)
  const check = ajv.compile(
    JSON.parse(
      await readFile(
        new URL('../schemas/task-result.v1.schema.json', import.meta.url),
        'utf8',
      ),
    ),
  )
  assert.ok(check(result), JSON.stringify(check.errors))
  assert.equal(result.status, 'completed', result.error?.message)
  assert.equal(result.task_id, id)
  assert.equal((await readdir(join(workDir, 'sample'))).length, 3)
  assert.equal(
    result.criterion_results.find((c) => c.criterion_id === 'COUNT')?.actual,
    '3',
  )
  const report = result.artifacts.find((a) => a.role === 'report')
  assert.ok(report, 'missing report')
  const bytes = await readFile(resolve(workDir, report.uri))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), report.sha256)
  assert.equal(JSON.parse(bytes.toString()).sample_file_count, 3)
  console.log(
    JSON.stringify({
      verified: true,
      adapter: binding.adapter,
      status: result.status,
      file_count: 3,
      evidence_hash_matches: true,
      workDir,
    }),
  )
} finally {
  if (binding) {
    if (!(await adapter.getStatus(binding)).terminal_observed)
      await adapter.cancel(binding, 'e2e cleanup')
    await adapter.cleanup(binding)
  }
}
