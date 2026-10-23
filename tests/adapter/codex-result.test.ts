import { chmod, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { TaskEnvelopeV1 } from '#domain-model'
import { CodexAdapter } from '../../adapters/codex-adapter/src/index.ts'
import './isolated-home.ts'

const envelope: TaskEnvelopeV1 = {
  schema: 'cmap/task-envelope/v1',
  identity: {
    mission_id: 'mis-1', task_id: 'tsk-1', idempotency_key: 'mis-1:tsk-1', revision: 1,
  },
  classification: {
    task_type: 'inspect', requested_capability: 'code.analyze', risk_level: 'read-meta',
  },
  goal: {
    statement: '生成报告',
    success_definition: [
      { criterion_id: 'C1', metric: 'ok', operator: 'eq', expected: true },
    ],
  },
  environment: {},
  execution_policy: { timeout_seconds: 30, max_attempts: 1 },
  permissions: { forbidden: [] },
  evidence_requirements: { required_artifact_roles: ['report'] },
  output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
}

test('Agent 缺必需证据时返回 failed 结果，而不是抛异常炸掉 Workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-result-'))
  const dir = join(root, 'workspace-alias')
  await symlink(await realpath(root), dir)
  const bin = join(dir, 'fake-codex')
  await writeFile(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
const out = args[args.indexOf('-o') + 1]
require('node:fs').writeFileSync(out, JSON.stringify({
  status: 'failed', summary: process.env.TMPDIR,
  criterion_results: [{ criterion_id: 'C1', actual: args[args.indexOf('-C') + 1], passed: false, evidence_artifact_ids: [] }],
  artifacts: [], findings: [],
  error: { code: 'FILESYSTEM_BLOCKED', message: '不能写文件', retryable: true }
}))
`,
  )
  await chmod(bin, 0o755)

  const adapter = new CodexAdapter({ authorization: { mode: 'standalone' },
    bin,
    outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'),
  })
  const binding = await adapter.startTask(envelope, {
    token: 'test', runner_id: 'test', trace_id: 'trace', correlation_id: 'corr',
    worktree: dir, deadline_at: new Date(Date.now() + 30_000).toISOString(),
  })

  for (;;) {
    const status = await adapter.getStatus(binding)
    if (status.terminal_observed) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  const result = await adapter.collectResult(binding)
  assert.equal(result.summary, await realpath(tmpdir()), '传给 Codex 的 TMPDIR 必须是无符号链接的物理路径')
  assert.equal(result.criterion_results[0]?.actual, await realpath(dir), 'Codex 的工作目录也必须使用物理路径')
  assert.equal(result.status, 'failed')
  assert.equal(result.error?.code, 'EVIDENCE_MISSING')
  assert.match(result.error?.message ?? '', /report/)
  assert.deepEqual(result.artifacts, [])
})

// 成本计量（实施计划 S0.4 / 威胁模型 T8）：codex exec --json 的 turn.completed 带 usage，累加后填进 task-result.cost。
test('Codex 结果带上累计用量与耗时', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-usage-'))
  const bin = join(root, 'fake-codex')
  await writeFile(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
const out = args[args.indexOf('-o') + 1]
const usage = (i, o) => ({ input_tokens: i, cached_input_tokens: 5, cache_write_input_tokens: 0, output_tokens: o, reasoning_output_tokens: 7 })
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'th-1' }))
console.log(JSON.stringify({ type: 'turn.completed', usage: usage(100, 20) }))
console.log(JSON.stringify({ type: 'turn.completed', usage: usage(30, 4) }))
require('node:fs').writeFileSync(out, JSON.stringify({
  status: 'completed', summary: 'ok',
  criterion_results: [{ criterion_id: 'C1', actual: 'true', passed: true, evidence_artifact_ids: [] }],
  artifacts: [], findings: [], error: null
}))
`,
  )
  await chmod(bin, 0o755)
  const adapter = new CodexAdapter({ authorization: { mode: 'standalone' }, bin, outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json') })
  const binding = await adapter.startTask(envelope, {
    token: 'test', runner_id: 'test', trace_id: 'trace', correlation_id: 'corr',
    worktree: root, deadline_at: new Date(Date.now() + 30_000).toISOString(),
  })
  for (;;) {
    if ((await adapter.getStatus(binding)).terminal_observed) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const result = await adapter.collectResult(binding)
  assert.equal(result.status, 'failed', '附加 cost 不得丢失原结果字段（缺 report 证据应判失败）')
  assert.equal(result.summary, 'ok')
  assert.equal(result.cost?.tokens, 154, '两轮 input+output 之和；reasoning 与缓存细分不另计，避免重复计数')
  assert.equal(typeof result.cost?.duration_seconds, 'number')
  assert.ok(result.cost!.duration_seconds! >= 0)
})
