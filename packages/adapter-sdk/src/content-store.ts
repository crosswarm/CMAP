/**
 * 控制面内容寻址存储（ADR-0008 §6，M09）：证据字节按 sha256 存放在 `<CMAP_WORK_ROOT>/.cas/sha256/ab/cd/<hash>`。
 *
 * 写入一律流式：临时文件（0600、独占创建）边写边算 sha256 与长度、边扫已知凭据模式；结束后与声明的哈希和长度核对，
 * 一致才原子重命名到内容地址，不一致、超限、命中凭据或源流出错都删掉临时文件，什么都不留。
 * 地址即内容：读者仍按账本里的 sha256 复算，不因为文件在这里就采信。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { AdapterError } from './index.ts'
import { hasKnownSecret } from './secret-patterns.ts'

const DEFAULT_MAX_EVIDENCE_BYTES = 256 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/

/** 证据读取与传输的单文件上限：`CMAP_MAX_EVIDENCE_BYTES`（正整数字节），默认 256MiB；非法值拒绝（fail closed）。 */
export const maxEvidenceBytes = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = env['CMAP_MAX_EVIDENCE_BYTES']?.trim()
  if (!raw) return DEFAULT_MAX_EVIDENCE_BYTES
  const value = Number(raw)
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value)) throw new RangeError('CMAP_MAX_EVIDENCE_BYTES must be a positive integer')
  return value
}

export const casPath = (workRoot: string, sha256: string): string => {
  if (!SHA256.test(sha256)) throw new RangeError('content address must be a lowercase sha256')
  return join(workRoot, '.cas', 'sha256', sha256.slice(0, 2), sha256.slice(2, 4), sha256)
}

/** 出站网关上传的登记位置：只有在本租约下核验过的上传才算数，结果不能引用别处已有的内容。 */
export const leaseUploadPath = (workRoot: string, leaseId: string, sha256: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(leaseId) || !SHA256.test(sha256)) throw new RangeError('invalid lease upload address')
  return join(workRoot, '.cas', 'leases', leaseId, sha256)
}

export const evidenceTooLarge = (role: string, max: number): AdapterError =>
  new AdapterError('EVIDENCE_FILE_TOO_LARGE', `证据 ${role} 超过 ${max} 字节上限`, false, `evidence-file-too-large:${role}`)
export const evidenceHashMismatch = (role: string, declared: string, actual: string): AdapterError =>
  new AdapterError('EVIDENCE_HASH_MISMATCH', `证据 ${role} 哈希不符：声明 ${declared}，实际 ${actual}`, false, `evidence-hash-mismatch:${role}`)
export const evidenceSecret = (): AdapterError =>
  new AdapterError('EVIDENCE_SECRET_DETECTED', '证据命中已知凭据模式', false, 'evidence-secret-detected')

/**
 * 流式凭据扫描：按块解码 UTF-8（多字节字符不被切开），每块与上一块末尾 4096 个字符拼接后匹配，跨块边界的凭据也能识别。
 * shortcut: 只覆盖长度 ≤ 4096 字符的匹配；URL 内嵌口令里超长的用户名段跨块时可能漏掉。需要严格时换成流式正则引擎。
 */
const OVERLAP = 4096
const secretScanner = () => {
  const decoder = new StringDecoder('utf8')
  let tail = ''
  let found = false
  const scan = (text: string): void => {
    if (found) return
    const window = tail + text
    found = hasKnownSecret(window)
    tail = window.slice(-OVERLAP)
  }
  return { push: (chunk: Buffer) => scan(decoder.write(chunk)), end: (): boolean => { scan(decoder.end()); return found } }
}

/**
 * 边读边算 sha256、长度与凭据命中；超过 limit 立即中止（不再读后续字节）。每块先计入摘要再交给 onChunk。
 * 不在这里判断哈希是否符合，调用方拿到结果再核对。
 */
export const digestStream = async (
  source: AsyncIterable<Uint8Array>,
  limit: number,
  onTooLarge: () => Error,
  onChunk?: (chunk: Buffer) => Promise<unknown>,
): Promise<{ sha256: string; size_bytes: number; secret: boolean }> => {
  const hash = createHash('sha256')
  const scanner = secretScanner()
  let size = 0
  for await (const raw of source) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    size += chunk.length
    if (size > limit) throw onTooLarge()
    hash.update(chunk)
    scanner.push(chunk)
    if (onChunk) await onChunk(chunk)
  }
  return { sha256: hash.digest('hex'), size_bytes: size, secret: scanner.end() }
}

/**
 * 把一路字节流写进内容寻址存储，返回对象路径。expected.sha256 必填（先有声明再收字节）；size_bytes 给出时长度也必须一致，
 * 且超过声明长度即中止。同一内容已存在时重命名覆盖为刚核验过的字节（内容相同，原子替换）。
 */
export const putContent = async (
  workRoot: string,
  source: AsyncIterable<Uint8Array>,
  expected: { sha256: string; size_bytes?: number; role: string },
  maxBytes: number = maxEvidenceBytes(),
): Promise<{ path: string; sha256: string; size_bytes: number }> => {
  const declared = expected.sha256.toLowerCase()
  const target = casPath(workRoot, declared)
  if (expected.size_bytes !== undefined && expected.size_bytes > maxBytes) throw evidenceTooLarge(expected.role, maxBytes)
  const tmpDir = join(workRoot, '.cas', 'tmp')
  await mkdir(tmpDir, { recursive: true, mode: 0o700 })
  const temp = join(tmpDir, `${process.pid}-${randomUUID()}`)
  const file = await open(temp, 'wx', 0o600)
  let kept = false
  try {
    const limit = expected.size_bytes ?? maxBytes
    const tooLarge = (): Error => expected.size_bytes === undefined
      ? evidenceTooLarge(expected.role, maxBytes)
      : evidenceHashMismatch(expected.role, declared, `超过声明长度 ${expected.size_bytes}`)
    const writeAll = async (chunk: Buffer): Promise<void> => {
      for (let offset = 0; offset < chunk.length;) offset += (await file.write(chunk, offset)).bytesWritten
    }
    const got = await digestStream(source, limit, tooLarge, writeAll)
    if (got.secret) throw evidenceSecret()
    if (got.sha256 !== declared || (expected.size_bytes !== undefined && got.size_bytes !== expected.size_bytes)) {
      throw evidenceHashMismatch(expected.role, declared, got.sha256)
    }
    await file.datasync()
    await file.close()
    await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
    await rename(temp, target)
    kept = true
    return { path: target, sha256: got.sha256, size_bytes: got.size_bytes }
  } finally {
    if (!kept) {
      await file.close().catch(() => undefined)
      await rm(temp, { force: true })
    }
  }
}
