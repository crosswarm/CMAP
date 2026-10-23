/**
 * M09 内容寻址存储：按 sha256 寻址、0600、临时文件边写边算 + 原子重命名，不一致即丢弃；
 * 旧版 runner 的内联产物经同一入口落盘。
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AdapterError } from '#adapter-sdk'
import { casPath, putContent } from '../../packages/adapter-sdk/src/content-store.ts'
import { materializeRemoteResult } from '../../adapters/remote-runner/src/index.ts'

const sha256 = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex')
const code = (c: string) => (err: unknown) => err instanceof AdapterError && err.code === c

const files = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])).filter((d) => d.isFile()).map((d) => d.name)

test('putContent 落在 .cas/sha256/ab/cd/<hash>，0600，临时文件不残留；同一内容重复写入复用同一对象', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-cas-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from('hello cas')
  const h = sha256(bytes)
  const put = await putContent(root, Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]), { sha256: h, size_bytes: bytes.length, role: 'report' })
  assert.equal(put.path, join(root, '.cas', 'sha256', h.slice(0, 2), h.slice(2, 4), h))
  assert.equal(casPath(root, h), put.path)
  assert.deepEqual([put.sha256, put.size_bytes], [h, bytes.length])
  assert.equal((await stat(put.path)).mode & 0o777, 0o600)
  assert.equal((await readFile(put.path)).toString(), 'hello cas')
  assert.deepEqual(await files(join(root, '.cas', 'tmp')), [])
  await putContent(root, Readable.from([bytes]), { sha256: h, role: 'report' })
  assert.deepEqual(await files(join(root, '.cas')), [h])
})

test('哈希不符、长度不符、超过上限、命中凭据、源流出错：一律丢弃，不落盘', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-cas-bad-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ok = sha256('ok')
  await assert.rejects(putContent(root, Readable.from([Buffer.from('tampered')]), { sha256: ok, role: 'report' }), code('EVIDENCE_HASH_MISMATCH'))
  await assert.rejects(putContent(root, Readable.from([Buffer.from('okk')]), { sha256: ok, size_bytes: 2, role: 'report' }), code('EVIDENCE_HASH_MISMATCH'))
  await assert.rejects(putContent(root, Readable.from([Buffer.from('o')]), { sha256: ok, size_bytes: 2, role: 'report' }), code('EVIDENCE_HASH_MISMATCH'))
  await assert.rejects(putContent(root, Readable.from([Buffer.alloc(11)]), { sha256: ok, role: 'report' }, 10), code('EVIDENCE_FILE_TOO_LARGE'))
  // 声明长度已超上限：不读字节就拒绝
  await assert.rejects(putContent(root, Readable.from([]), { sha256: ok, size_bytes: 11, role: 'report' }, 10), code('EVIDENCE_FILE_TOO_LARGE'))
  const secret = Buffer.from('sk-' + 'SyntheticOnly'.repeat(4))
  await assert.rejects(putContent(root, Readable.from([secret]), { sha256: sha256(secret), role: 'report' }), code('EVIDENCE_SECRET_DETECTED'))
  const broken = new Readable({ read() { this.destroy(new Error('connection reset')) } })
  await assert.rejects(putContent(root, broken, { sha256: ok, role: 'report' }))
  assert.deepEqual(await files(join(root, '.cas')), [])
})

test('旧版 runner 的内联产物（content_base64）仍被接受：经内容寻址存储落入任务目录并复算', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-cas-legacy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = await materializeRemoteResult(root, 'codex:tsk-legacy:1', {
    schema: 'cmap/remote-runner/v1', kind: 'result', remote_task_id: 'codex:tsk-legacy:1',
    result: {
      schema: 'cmap/task-result/v1', mission_id: 'mis-1', task_id: 'tsk-legacy', attempt: 1, status: 'completed', summary: 'ok',
      criterion_results: [{ criterion_id: 'C1', actual: 'true', passed: true, evidence_artifact_ids: ['a1'] }],
      artifacts: [{ artifact_id: 'a1', role: 'report', uri: 'evidence/report.txt', media_type: 'text/plain', size_bytes: 2, sha256: sha256('ok') }],
    },
    artifacts: [{ uri: 'evidence/report.txt', content_base64: Buffer.from('ok').toString('base64') }],
  })
  assert.deepEqual([result.artifacts[0]!.sha256, result.artifacts[0]!.size_bytes], [sha256('ok'), 2])
  assert.equal(await readFile(join(root, 'tsk-legacy', 'evidence/report.txt'), 'utf8'), 'ok')
  assert.equal(await readFile(casPath(root, sha256('ok')), 'utf8'), 'ok')
})
