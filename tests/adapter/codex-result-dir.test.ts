/**
 * standalone（无 runsDir）模式的结果文件目录：codex 的 -o 由沙箱外的 codex 进程写入并跟随符号链接，
 * 目录若在沙箱可写的 TMPDIR 下，Agent 可以抢先替换结果文件。必须落在沙箱不可写的 CMAP 自有目录。
 */
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { TaskEnvelopeV1 } from '#domain-model'
import { CodexAdapter } from '../../adapters/codex-adapter/src/index.ts'

const envelope: TaskEnvelopeV1 = {
  schema: 'cmap/task-envelope/v1',
  identity: { mission_id: 'mis-1', task_id: 'tsk-dir', idempotency_key: 'mis-1:tsk-dir', revision: 1 },
  classification: { task_type: 'inspect', requested_capability: 'code.analyze', risk_level: 'read-meta' },
  goal: { statement: '生成报告', success_definition: [{ criterion_id: 'C1', metric: 'ok', operator: 'eq', expected: true }] },
  environment: {},
  execution_policy: { timeout_seconds: 30, max_attempts: 1 },
  permissions: { forbidden: [] },
  evidence_requirements: { required_artifact_roles: ['report'] },
  output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
}

test('standalone 结果目录在 HOME 下的 CMAP 自有 0700 目录，不在沙箱可写的 TMPDIR，清理后删除', async (t) => {
  const base = await realpath(tmpdir())
  const fakeTmp = await mkdtemp(join(base, 'cmap-resdir-tmp-'))
  const fakeHome = await mkdtemp(join(base, 'cmap-resdir-home-'))
  const work = await mkdtemp(join(base, 'cmap-resdir-work-'))
  const oldTmp = process.env['TMPDIR']
  const oldHome = process.env['HOME']
  process.env['TMPDIR'] = fakeTmp
  process.env['HOME'] = fakeHome
  t.after(async () => {
    if (oldTmp === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = oldTmp
    if (oldHome === undefined) delete process.env['HOME']; else process.env['HOME'] = oldHome
    await Promise.all([fakeTmp, fakeHome, work].map((d) => rm(d, { recursive: true, force: true })))
  })

  const seen = join(work, 'result-path.txt')
  const bin = join(work, 'fake-codex')
  await writeFile(bin, `#!/usr/bin/env node
const args = process.argv.slice(2)
const out = args[args.indexOf('-o') + 1]
require('node:fs').writeFileSync(${JSON.stringify(seen)}, out)
require('node:fs').writeFileSync(out, JSON.stringify({ status: 'failed', summary: 's', criterion_results: [], artifacts: [], findings: [],
  error: { code: 'X', message: 'x', retryable: false } }))
`)
  await chmod(bin, 0o755)

  const adapter = new CodexAdapter({
    authorization: { mode: 'standalone' }, bin,
    outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'),
  })
  const binding = await adapter.startTask(envelope, {
    token: 'test', runner_id: 'test', trace_id: 'trace', correlation_id: 'corr',
    worktree: work, deadline_at: new Date(Date.now() + 30_000).toISOString(),
  })
  for (;;) {
    if ((await adapter.getStatus(binding)).terminal_observed) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  const resultFile = await readFile(seen, 'utf8')
  const resultDir = join(resultFile, '..')
  assert.ok(resultFile.startsWith(join(fakeHome, '.cmap') + '/'), `结果文件应在 ${fakeHome}/.cmap 下：${resultFile}`)
  assert.ok(!resultFile.startsWith(fakeTmp), '不得在沙箱可写的 TMPDIR 下')
  assert.equal((await stat(resultDir)).mode & 0o777, 0o700)
  assert.equal((await stat(join(fakeHome, '.cmap'))).mode & 0o777, 0o700)

  await adapter.collectResult(binding)
  await adapter.cleanup(binding)
  await assert.rejects(stat(resultDir), { code: 'ENOENT' })
})
