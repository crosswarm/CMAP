import { chmod, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { TaskEnvelopeV1 } from '#domain-model'
import { CodexAdapter } from '../../adapters/codex-adapter/src/index.ts'

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

  const adapter = new CodexAdapter({
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
