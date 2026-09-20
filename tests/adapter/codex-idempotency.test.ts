import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DispatchContext } from '#adapter-sdk'
import type { TaskEnvelopeV1 } from '#domain-model'
import { CodexAdapter } from '../../adapters/codex-adapter/src/index.ts'

const envelope: TaskEnvelopeV1 = {
  schema: 'cmap/task-envelope/v1',
  identity: { mission_id: 'mis-idempotence', task_id: 'tsk-idempotence', revision: 1, idempotency_key: 'codex-idempotence' },
  classification: { task_type: 'inspect', requested_capability: 'code.analyze', risk_level: 'read-meta' },
  goal: { statement: 'check', success_definition: [{ criterion_id: 'C1', metric: 'done', operator: 'eq', expected: true }] },
  environment: {}, execution_policy: { timeout_seconds: 30, max_attempts: 1 },
  permissions: { forbidden: [] }, evidence_requirements: { required_artifact_roles: ['report'] },
  output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
}

const context = (worktree: string): DispatchContext => ({
  token: 'test', runner_id: 'runner-test', trace_id: 'trace-test', correlation_id: 'correlation-test',
  worktree, deadline_at: new Date(Date.now() + 30_000).toISOString(),
})

test('concurrent Codex starts launch once and cleanup preserves the binding tombstone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-idempotence-'))
  const launches = join(root, 'launches')
  const bin = join(root, 'fake-codex.cjs')
  await writeFile(bin, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(launches)}, String(process.pid) + '\\n')\n`)
  await chmod(bin, 0o755)
  const adapter = new CodexAdapter({ bin, outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json') })
  try {
    const bindings = await Promise.all(Array.from({ length: 8 }, () => adapter.startTask(envelope, context(root))))
    for (const binding of bindings) assert.deepEqual(binding, bindings[0])
    const binding = bindings[0]!
    const deadline = Date.now() + 5000
    while (!(await adapter.getStatus(binding)).terminal_observed) {
      assert.ok(Date.now() < deadline, 'fake CLI did not terminate')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal((await readFile(launches, 'utf8')).trim().split('\n').length, 1)
    await adapter.cleanup(binding)
    assert.deepEqual(await adapter.startTask(envelope, context(root)), binding)
    await assert.rejects(adapter.getStatus(binding), { code: 'BINDING_NOT_FOUND' })
    assert.equal((await readFile(launches, 'utf8')).trim().split('\n').length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex failed preparation clears pending launch so a corrected retry can start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-preparation-'))
  const worktree = join(root, 'work')
  const bin = join(root, 'fake-codex.cjs')
  await writeFile(bin, `#!${process.execPath}\nprocess.exit(0)\n`)
  await chmod(bin, 0o755)
  const adapter = new CodexAdapter({ bin, outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json') })
  try {
    await assert.rejects(adapter.startTask(envelope, context(worktree)), { code: 'ENOENT' })
    await mkdir(worktree)
    const binding = await adapter.startTask(envelope, context(worktree))
    const deadline = Date.now() + 5000
    while (!(await adapter.getStatus(binding)).terminal_observed) {
      assert.ok(Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await adapter.cleanup(binding)
  } finally { await rm(root, { recursive: true, force: true }) }
})
