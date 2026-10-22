/**
 * Codex 重启安全（远程 Runner Stage 1 / S1）。
 *
 * 判据只认「启动次数」与账本可见的状态：每个假 codex 启动时往 launches 文件追加一行，
 * 重启（换一个全新的 CodexAdapter 实例，内存清空）前后行数必须保持 1。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { DispatchContext } from '#adapter-sdk'
import type { RemoteTaskBinding, TaskEnvelopeV1 } from '#domain-model'
import { CodexAdapter } from '../../adapters/codex-adapter/src/index.ts'

const SCHEMA = join(process.cwd(), 'schemas/codex-output.v1.schema.json')
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

const envelope = (taskId: string, statement = 'restart-safe'): TaskEnvelopeV1 => ({
  schema: 'cmap/task-envelope/v1',
  identity: { mission_id: 'mis-restart', task_id: taskId, revision: 1, idempotency_key: `mis-restart:${taskId}` },
  classification: { task_type: 'inspect', requested_capability: 'code.analyze', risk_level: 'read-meta' },
  goal: { statement, success_definition: [{ criterion_id: 'C1', metric: 'done', operator: 'eq', expected: true }] },
  environment: {}, execution_policy: { timeout_seconds: 30, max_attempts: 1 },
  permissions: { forbidden: [] }, evidence_requirements: { required_artifact_roles: ['report'] },
  output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
})

const context = (worktree: string): DispatchContext => ({
  token: 'test', runner_id: 'runner-test', trace_id: 'trace-test', correlation_id: 'correlation-test',
  worktree, deadline_at: new Date(Date.now() + 30_000).toISOString(),
})

interface Fixture {
  readonly root: string
  readonly runsDir: string
  readonly launches: string
  readonly bin: string
  readonly worktree: string
  readonly recordPath: string
}

/**
 * mode=ok        输出若干 JSONL 事件后写出完整结果；
 * mode=no-result 输出事件后退出，不写结果文件。
 */
const fixture = async (taskId: string, mode: 'ok' | 'no-result', durationMs: number): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-restart-'))
  const runsDir = join(root, '.runs')
  const launches = join(root, 'launches')
  const worktree = join(root, taskId)
  await mkdir(worktree, { recursive: true })
  const recordPath = join(runsDir, `${taskId}.json`)
  const bin = join(root, 'fake-codex.cjs')
  await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const workDir = args[args.indexOf('-C') + 1]
const out = args[args.indexOf('-o') + 1]
fs.appendFileSync(${JSON.stringify(launches)}, (fs.existsSync(${JSON.stringify(recordPath)}) ? 'record-present' : 'record-missing') + '\\n')
let n = 0
const timer = setInterval(() => {
  console.log(JSON.stringify({ type: 'item.started', session_id: 'sess-restart', n: ++n }))
  if (n * 50 < ${durationMs}) return
  clearInterval(timer)
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 5 } }))
  if (${JSON.stringify(mode)} === 'ok') {
    fs.mkdirSync(path.join(workDir, 'evidence'), { recursive: true })
    fs.writeFileSync(path.join(workDir, 'evidence/report.txt'), 'ok')
    fs.writeFileSync(out, JSON.stringify({
      status: 'completed', summary: 'ok',
      criterion_results: [{ criterion_id: 'C1', actual: 'true', passed: true, evidence_artifact_ids: ['a1'] }],
      artifacts: [{ artifact_id: 'a1', role: 'report', uri: 'evidence/report.txt', media_type: 'text/plain', size_bytes: 2, sha256: ${JSON.stringify(sha256('ok'))} }],
      findings: [], error: null
    }))
  }
  process.exit(0)
}, 50)
`)
  await chmod(bin, 0o755)
  return { root, runsDir, launches, bin, worktree, recordPath }
}

const adapterFor = (f: Fixture): CodexAdapter =>
  new CodexAdapter({ authorization: { mode: 'standalone' }, bin: f.bin, outputSchemaPath: SCHEMA, runsDir: f.runsDir })

const launchLines = async (f: Fixture): Promise<string[]> => {
  try {
    return (await readFile(f.launches, 'utf8')).trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

const untilTerminal = async (adapter: CodexAdapter, binding: RemoteTaskBinding, ms = 8000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!(await adapter.getStatus(binding)).terminal_observed) {
    assert.ok(Date.now() < deadline, '等待终态超时')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const untilLaunched = async (f: Fixture): Promise<void> => {
  const deadline = Date.now() + 5000
  while ((await launchLines(f)).length === 0) {
    assert.ok(Date.now() < deadline, '假 codex 没有启动')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('启动前独占创建运行记录，记录含恢复所需字段且不含提示词正文', async () => {
  const f = await fixture('tsk-rec-fields', 'ok', 100)
  const adapter = adapterFor(f)
  try {
    const binding = await adapter.startTask(envelope('tsk-rec-fields', 'SECRET-PROMPT-BODY'), context(f.worktree))
    await untilTerminal(adapter, binding)
    // 假 codex 启动那一刻记录已经在磁盘上
    assert.deepEqual(await launchLines(f), ['record-present'])
    const raw = await readFile(f.recordPath, 'utf8')
    const record = JSON.parse(raw)
    assert.equal(record.remote_task_id, 'codex:tsk-rec-fields:1')
    assert.equal(record.task_id, 'tsk-rec-fields')
    assert.ok(Number.isInteger(record.pid) && record.pid > 1)
    assert.match(record.args_sha256, /^[a-f0-9]{64}$/)
    assert.match(record.started_at, /^\d{4}-\d{2}-\d{2}T/)
    assert.ok(record.result_file.endsWith('.cmap-result-tsk-rec-fields.json'))
    assert.ok(!raw.includes('SECRET-PROMPT-BODY'))
    assert.equal((await stat(f.recordPath)).mode & 0o777, 0o600)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('standalone（无 runsDir）：结果文件在工作区外的独占临时目录，cleanup 后删除', async () => {
  const f = await fixture('tsk-standalone-out', 'ok', 100)
  const outLog = join(f.root, 'out-path')
  const wrapper = join(f.root, 'wrap.cjs')
  await writeFile(wrapper, `#!${process.execPath}
const a = process.argv.slice(2)
require('node:fs').writeFileSync(${JSON.stringify(outLog)}, a[a.indexOf('-o') + 1])
require(${JSON.stringify(f.bin)})
`)
  await chmod(wrapper, 0o755)
  const adapter = new CodexAdapter({ authorization: { mode: 'standalone' }, bin: wrapper, outputSchemaPath: SCHEMA })
  try {
    const binding = await adapter.startTask(envelope('tsk-standalone-out'), context(f.worktree))
    await untilTerminal(adapter, binding)
    assert.equal((await adapter.collectResult(binding)).status, 'completed')
    const resultFile = await readFile(outLog, 'utf8')
    const rel = relative(await realpath(f.worktree), resultFile)
    assert.ok(rel.startsWith('..'), `结果文件不得位于 Agent 可写的工作区内：${resultFile}`)
    await adapter.cleanup(binding)
    await assert.rejects(stat(dirname(resultFile)), { code: 'ENOENT' })
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('结果文件写在 runsDir：工作区里预置的同名符号链接不会把结果写到工作区外', async () => {
  const f = await fixture('tsk-res-link', 'ok', 100)
  const outside = join(f.root, 'outside.txt')
  await writeFile(outside, 'keep')
  await symlink(outside, join(f.worktree, '.cmap-result-tsk-res-link.json'))
  const adapter = adapterFor(f)
  try {
    const binding = await adapter.startTask(envelope('tsk-res-link'), context(f.worktree))
    await untilTerminal(adapter, binding)
    assert.equal((await adapter.collectResult(binding)).status, 'completed')
    assert.equal(await readFile(outside, 'utf8'), 'keep')
    assert.ok(JSON.parse(await readFile(f.recordPath, 'utf8')).result_file.startsWith(f.runsDir))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('记录已存在时，全新实例（模拟重启）不会再启动第二个进程', async () => {
  const f = await fixture('tsk-rec-once', 'ok', 100)
  const first = adapterFor(f)
  try {
    const binding = await first.startTask(envelope('tsk-rec-once'), context(f.worktree))
    await untilTerminal(first, binding)
    const fresh = adapterFor(f)
    const again = await fresh.startTask(envelope('tsk-rec-once'), context(f.worktree))
    assert.deepEqual(again, binding)
    assert.equal((await launchLines(f)).length, 1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('记录与本次启动参数不一致时拒绝启动（RUN_RECORD_CONFLICT），也不重跑', async () => {
  const f = await fixture('tsk-rec-conflict', 'ok', 100)
  const first = adapterFor(f)
  try {
    const binding = await first.startTask(envelope('tsk-rec-conflict', 'A'), context(f.worktree))
    await untilTerminal(first, binding)
    await assert.rejects(
      adapterFor(f).startTask(envelope('tsk-rec-conflict', 'B'), context(f.worktree)),
      { code: 'RUN_RECORD_CONFLICT' },
    )
    assert.equal((await launchLines(f)).length, 1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('重启时进程仍在运行：等待并收集结果，只执行一次', async () => {
  const f = await fixture('tsk-alive', 'ok', 1200)
  const first = adapterFor(f)
  try {
    const binding = await first.startTask(envelope('tsk-alive'), context(f.worktree))
    await untilLaunched(f)
    const fresh = adapterFor(f) // 内存清空的“新 Worker”
    assert.equal((await fresh.getStatus(binding)).status, 'running')
    await assert.rejects(fresh.collectResult(binding), { code: 'TASK_STILL_RUNNING' })
    await untilTerminal(fresh, binding)
    assert.equal((await fresh.getStatus(binding)).status, 'completed')
    const result = await fresh.collectResult(binding)
    assert.equal(result.status, 'completed')
    assert.equal(result.task_id, 'tsk-alive')
    assert.equal(result.artifacts[0]?.sha256, sha256('ok'))
    assert.equal(result.session?.provider_session_id, 'sess-restart')
    assert.equal(result.cost?.tokens, 12)
    assert.equal((await launchLines(f)).length, 1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('重启时进程已退出且结果文件完整：直接收集，不重跑', async () => {
  const f = await fixture('tsk-done', 'ok', 100)
  const first = adapterFor(f)
  try {
    const binding = await first.startTask(envelope('tsk-done'), context(f.worktree))
    await untilTerminal(first, binding)
    const fresh = adapterFor(f)
    assert.equal((await fresh.getStatus(binding)).status, 'completed')
    const result = await fresh.collectResult(binding)
    assert.equal(result.status, 'completed')
    assert.equal(result.mission_id, 'mis-restart')
    assert.equal(result.cost?.tokens, 12)
    assert.equal((await launchLines(f)).length, 1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('重启时进程已退出且无完整结果：执行不确定（BINDING_NOT_FOUND），绝不重跑', async () => {
  const f = await fixture('tsk-lost', 'no-result', 100)
  const first = adapterFor(f)
  try {
    const binding = await first.startTask(envelope('tsk-lost'), context(f.worktree))
    await untilTerminal(first, binding)
    const fresh = adapterFor(f)
    await assert.rejects(fresh.getStatus(binding), { code: 'BINDING_NOT_FOUND' })
    await assert.rejects(fresh.collectResult(binding), { code: 'BINDING_NOT_FOUND' })
    assert.deepEqual(await fresh.startTask(envelope('tsk-lost'), context(f.worktree)), binding)
    assert.equal((await launchLines(f)).length, 1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('结果文件写了一半（非完整 JSON）同样视为执行不确定', async () => {
  const f = await fixture('tsk-partial', 'no-result', 100)
  const first = adapterFor(f)
  try {
    const binding = await first.startTask(envelope('tsk-partial'), context(f.worktree))
    await untilTerminal(first, binding)
    const record = JSON.parse(await readFile(f.recordPath, 'utf8'))
    await writeFile(record.result_file, '{"status":"comp')
    await assert.rejects(adapterFor(f).getStatus(binding), { code: 'BINDING_NOT_FOUND' })
    assert.equal((await launchLines(f)).length, 1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('记录存在但 pid 未落盘（启动中途崩溃）：不确定，且不会补启动', async () => {
  const f = await fixture('tsk-nopid', 'ok', 100)
  try {
    await mkdir(f.runsDir, { recursive: true })
    await writeFile(f.recordPath, JSON.stringify({
      schema: 'cmap/codex-run/v1', remote_task_id: 'codex:tsk-nopid:1', task_id: 'tsk-nopid', runner_id: 'runner-test',
      pid: null, process_start: null, started_at: new Date().toISOString(), args_sha256: 'f'.repeat(64),
      work_dir: f.worktree, owns_work_dir: false, result_file: join(f.worktree, 'r.json'),
      stdout_file: join(f.runsDir, 'x.out'), stderr_file: join(f.runsDir, 'x.err'),
      envelope: envelope('tsk-nopid'),
    }), { flag: 'wx' })
    const adapter = adapterFor(f)
    const binding = adapter.prepareBinding(envelope('tsk-nopid'), context(f.worktree))
    await assert.rejects(adapter.getStatus(binding), { code: 'BINDING_NOT_FOUND' })
    await assert.rejects(adapter.startTask(envelope('tsk-nopid'), context(f.worktree)), { code: 'RUN_RECORD_CONFLICT' })
    assert.equal((await launchLines(f)).length, 0)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('真实任务 ID 形态（68 位 tsk_ 哈希、含冒号的 DAG 子任务）都能写记录并在重启后恢复', async () => {
  for (const taskId of [`tsk_${'a1b2'.repeat(16)}`, 'mis-dag:node_a:2']) {
    const f = await fixture(taskId, 'ok', 100)
    const first = adapterFor(f)
    try {
      const binding = await first.startTask(envelope(taskId), context(f.worktree))
      await untilTerminal(first, binding)
      const result = await adapterFor(f).collectResult(binding)
      assert.equal(result.task_id, taskId)
      assert.equal((await launchLines(f)).length, 1)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  }
})

test('不能作文件名的 taskId 被拒绝（RUN_RECORD_INVALID），不启动进程', async () => {
  const f = await fixture('tsk-evil', 'ok', 100)
  try {
    await assert.rejects(
      adapterFor(f).startTask(envelope('../escape'), context(f.worktree)),
      { code: 'RUN_RECORD_INVALID' },
    )
    assert.equal((await launchLines(f)).length, 0)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('Worker 进程被 SIGKILL 后 codex 继续运行（输出不走管道），新实例收集完成结果', async () => {
  const f = await fixture('tsk-sigkill', 'ok', 1200)
  const helper = join(f.root, 'helper.mjs')
  await writeFile(helper, `
const { CodexAdapter } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'adapters/codex-adapter/src/index.ts')).href)})
const adapter = new CodexAdapter({ authorization: { mode: 'standalone' }, bin: ${JSON.stringify(f.bin)}, outputSchemaPath: ${JSON.stringify(SCHEMA)}, runsDir: ${JSON.stringify(f.runsDir)} })
const binding = await adapter.startTask(${JSON.stringify(envelope('tsk-sigkill'))}, ${JSON.stringify(context(f.worktree))})
console.log('started ' + JSON.stringify(binding))
setInterval(() => {}, 1000)
`)
  const worker = spawn(process.execPath, [helper], { stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    const line: string = await new Promise((resolve, reject) => {
      let buf = ''
      worker.stdout.on('data', (c: Buffer) => { buf += c.toString(); if (buf.includes('\n')) resolve(buf) })
      worker.on('exit', () => reject(new Error('helper 提前退出')))
    })
    const binding = JSON.parse(line.slice('started '.length)) as RemoteTaskBinding
    await untilLaunched(f)
    worker.kill('SIGKILL') // 模拟 Worker 崩溃：codex 正在跑
    const fresh = adapterFor(f)
    await untilTerminal(fresh, binding)
    const result = await fresh.collectResult(binding)
    assert.equal(result.status, 'completed')
    assert.equal(result.artifacts[0]?.sha256, sha256('ok'))
    assert.equal((await launchLines(f)).length, 1)
  } finally {
    worker.kill('SIGKILL')
    await rm(f.root, { recursive: true, force: true })
  }
})
