/**
 * ADR-0009 §3：Codex 明确的额度耗尽归一为 QUOTA_EXHAUSTED；识别不了的按普通失败。回归样例取自实测触顶文本。
 */
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { TaskEnvelopeV1 } from '#domain-model'
import { AdapterError } from '#adapter-sdk'
import { CodexAdapter } from '../../adapters/codex-adapter/src/index.ts'

const envelope = (taskId: string): TaskEnvelopeV1 => ({
  schema: 'cmap/task-envelope/v1',
  identity: { mission_id: 'mis-quota', task_id: taskId, idempotency_key: `mis-quota:${taskId}`, revision: 1 },
  classification: { task_type: 'inspect', requested_capability: 'code.analyze', risk_level: 'read-meta' },
  goal: { statement: 'quota', success_definition: [{ criterion_id: 'C1', metric: 'ok', operator: 'eq', expected: true }] },
  environment: {},
  execution_policy: { timeout_seconds: 30, max_attempts: 1 },
  permissions: { forbidden: [] },
  evidence_requirements: { required_artifact_roles: ['report'] },
  output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
})

/** 假 codex：stdout 打 JSONL 事件、stderr 打文本，然后按给定退出码结束（不写结果文件）。 */
const runFake = async (taskId: string, opts: { stdout?: object[]; stderr?: string; exit: number }) => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-codex-quota-'))
  const bin = join(dir, 'fake-codex.cjs')
  await writeFile(bin, `#!${process.execPath}
for (const e of ${JSON.stringify(opts.stdout ?? [])}) process.stdout.write(JSON.stringify(e) + '\\n')
process.stderr.write(${JSON.stringify(opts.stderr ?? '')})
process.exit(${opts.exit})
`)
  await chmod(bin, 0o755)
  const adapter = new CodexAdapter({ authorization: { mode: 'standalone' }, bin, outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json') })
  const binding = await adapter.startTask(envelope(taskId), {
    token: 't', runner_id: 'r', trace_id: taskId, correlation_id: taskId, worktree: dir, deadline_at: new Date(Date.now() + 30_000).toISOString(),
  })
  for (;;) {
    if ((await adapter.getStatus(binding)).terminal_observed) break
    await new Promise((r) => setTimeout(r, 10))
  }
  return adapter.collectResult(binding)
}

const rejectsWithCode = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (e: unknown) => e instanceof AdapterError && e.code === code && !e.retryable)

test('Codex：stderr 中的 “You’ve hit your usage limit”（弯撇号）归一为 QUOTA_EXHAUSTED', async () => {
  await rejectsWithCode(runFake('tsk-curly', { stderr: 'ERROR: You’ve hit your usage limit. Upgrade to Pro or try again in 3 days.\n', exit: 1 }), 'QUOTA_EXHAUSTED')
})

test('Codex：直撇号变体与 JSONL 错误事件同样识别', async () => {
  await rejectsWithCode(runFake('tsk-straight', { stdout: [{ type: 'error', message: "You've hit your usage limit. Try again later." }], exit: 1 }), 'QUOTA_EXHAUSTED')
})

test('Codex：“Quota exceeded” 识别为 QUOTA_EXHAUSTED（turn.failed 事件）', async () => {
  await rejectsWithCode(runFake('tsk-quota', { stdout: [{ type: 'turn.failed', error: { message: 'Quota exceeded. Check your plan and billing details.' } }], exit: 1 }), 'QUOTA_EXHAUSTED')
  await rejectsWithCode(runFake('tsk-item-error', { stdout: [{ type: 'item.completed', item: { type: 'error', message: 'You’ve hit your usage limit.' } }], exit: 1 }), 'QUOTA_EXHAUSTED')
})

test('Codex：未识别的失败文本按普通失败处理，不猜测为额度耗尽', async () => {
  await rejectsWithCode(runFake('tsk-other', { stderr: 'ERROR: stream disconnected before completion\n', exit: 1 }), 'RESULT_MISSING')
  // Agent 自己的消息里提到额度不算：只看 stderr 与错误事件
  await rejectsWithCode(runFake('tsk-agent-text', { stdout: [{ type: 'item.completed', item: { type: 'agent_message', text: 'log says: Quota exceeded' } }], exit: 1 }), 'RESULT_MISSING')
})
