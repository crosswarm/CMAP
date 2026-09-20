import { chmod, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { TaskEnvelopeV1 } from '#domain-model'
import { CodexAdapter } from '../../adapters/codex-adapter/src/index.ts'

const envelope = (taskId: string): TaskEnvelopeV1 => ({
  schema: 'cmap/task-envelope/v1',
  identity: {
    mission_id: 'mis-1',
    task_id: taskId,
    idempotency_key: `mis-1:${taskId}`,
    revision: 1,
  },
  classification: {
    task_type: 'inspect',
    requested_capability: 'code.analyze',
    risk_level: 'read-meta',
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
})

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

const makeCodex = async (dir: string, result: unknown): Promise<string> => {
  const bin = join(dir, 'fake-codex')
  await writeFile(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
const out = args[args.indexOf('-o') + 1]
require('node:fs').writeFileSync(out, ${JSON.stringify(JSON.stringify(result))})
`,
  )
  await chmod(bin, 0o755)
  return bin
}

const completedResult = (uri: string, hash: string) => ({
  status: 'completed',
  summary: 'ok',
  criterion_results: [
    { criterion_id: 'C1', actual: 'ok', passed: true, evidence_artifact_ids: ['a1'] },
  ],
  artifacts: [
    {
      artifact_id: 'a1',
      role: 'report',
      uri,
      media_type: 'text/plain',
      size_bytes: 2,
      sha256: hash,
    },
  ],
  findings: [],
  error: null,
})

const startSettled = async (
  taskId: string,
  worktree: string,
  result: unknown,
): Promise<{ adapter: CodexAdapter; binding: Awaited<ReturnType<CodexAdapter['startTask']>> }> => {
  const bin = await makeCodex(worktree, result)
  const adapter = new CodexAdapter({
    bin,
    outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'),
  })
  const binding = await adapter.startTask(envelope(taskId), {
    token: 'test',
    runner_id: 'test',
    trace_id: 'trace',
    correlation_id: 'corr',
    worktree,
    deadline_at: new Date(Date.now() + 30_000).toISOString(),
  })

  for (;;) {
    const status = await adapter.getStatus(binding)
    if (status.terminal_observed) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  return { adapter, binding }
}

test('拒绝用相对路径穿出工作区读取证据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-codex-boundary-'))
  const outside = join(dirname(dir), 'outside-report.txt')
  await writeFile(outside, 'ok')

  const { adapter, binding } = await startSettled(
    'tsk-evidence-traversal',
    dir,
    completedResult('../outside-report.txt', sha256('ok')),
  )

  await assert.rejects(
    adapter.collectResult(binding),
    /证据文件不在任务工作区内/,
  )
})

test('保留工作区内相对路径和绝对路径证据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-codex-boundary-'))
  const relativeArtifact = 'report.txt'
  const absoluteArtifact = join(dir, 'absolute-report.txt')
  await writeFile(join(dir, relativeArtifact), 'ok')
  await writeFile(absoluteArtifact, 'abs')

  const result = completedResult(relativeArtifact, sha256('ok'))
  result.artifacts.push({
    artifact_id: 'a2',
    role: 'log',
    uri: absoluteArtifact,
    media_type: 'text/plain',
    size_bytes: 3,
    sha256: sha256('abs'),
  })

  const { adapter, binding } = await startSettled(
    'tsk-evidence-contained',
    dir,
    result,
  )

  const collected = await adapter.collectResult(binding)
  assert.equal(collected.status, 'completed')
  assert.deepEqual(collected.artifacts.map((a) => a.artifact_id), ['a1', 'a2'])
})

test('拒绝通过工作区内符号链接读取外部证据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-codex-boundary-'))
  const outside = join(dirname(dir), 'outside-symlink-report.txt')
  const link = join(dir, 'report.txt')
  await writeFile(outside, 'ok')
  await symlink(outside, link)

  const { adapter, binding } = await startSettled(
    'tsk-evidence-symlink',
    dir,
    completedResult('report.txt', sha256('ok')),
  )

  await assert.rejects(
    adapter.collectResult(binding),
    /证据文件不在任务工作区内/,
  )
})

test('cleanup 不删除调用方传入的工作区', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-codex-owned-by-caller-'))
  const marker = join(dir, 'caller-owned.txt')
  await writeFile(marker, 'keep')

  const { adapter, binding } = await startSettled(
    'tsk-cleanup-caller-owned',
    dir,
    {
      status: 'failed',
      summary: 'no evidence',
      criterion_results: [],
      artifacts: [],
      findings: [],
      error: null,
    },
  )

  await adapter.cleanup(binding)
  assert.equal(await readFile(marker, 'utf8'), 'keep')
})
