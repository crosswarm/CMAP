/**
 * 威胁模型「P4 安全验收清单」的两项零命中检查：
 *   1. 审计流（events 表）中 grep 凭据模式；
 *   2. Artifact（账本登记的产物字节）中 grep 提示词正文与 token。
 *
 * 模式：凭据沿用运行时唯一模式源 secret-patterns.ts；token 另加控制面自己签发的派发许可（cmap1.）与注册令牌（cmapenr1.）；
 * 提示词正文以 renderTaskPrompt 写出的带校验值数据区块标记与固定说明标题识别。是已知模式检测，不是完整 DLP。
 * 只报告命中的来源、id 与标签，不回显命中内容。
 *
 * 用法：CMAP_DATABASE_URL=... CMAP_WORK_ROOT=... [CMAP_DB_SCHEMA=public] node scripts/p4-zero-hit.ts
 * 退出码：0 零命中；1 有命中；2 配置缺失；3 有产物读不到（检查不完整，不算通过）。
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { SECRET_PATTERNS } from '../packages/adapter-sdk/src/secret-patterns.ts'

const TOKEN_PATTERNS = [
  { label: '派发许可', pattern: /\bcmap1\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
  { label: '注册令牌', pattern: /\bcmapenr1\.[A-Za-z0-9_-]{43}/ },
]
const PROMPT_PATTERNS = [
  { label: '提示词数据区块', pattern: /<<<(?:END-)?CMAP-DATA [0-9a-f]{16}/ },
  { label: '提示词说明', pattern: /## 数据区块说明/ },
]
const AUDIT_PATTERNS = [...SECRET_PATTERNS, ...TOKEN_PATTERNS]
const ARTIFACT_PATTERNS = [...SECRET_PATTERNS, ...TOKEN_PATTERNS, ...PROMPT_PATTERNS]

export interface ZeroHit {
  readonly source: 'event' | 'artifact'
  readonly id: string
  readonly label: string
}

const labels = (text: string, patterns: readonly { label: string; pattern: RegExp }[]): string[] =>
  patterns.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label)

/** events：账本事件（整条序列化后扫描）；artifacts：产物 id 与字节。返回命中列表，空即零命中。 */
export const scanZeroHit = (input: {
  readonly events?: readonly { readonly event_id: string }[]
  readonly artifacts?: readonly { readonly artifact_id: string; readonly bytes: Uint8Array | string }[]
}): ZeroHit[] => {
  const hits: ZeroHit[] = []
  for (const event of input.events ?? []) {
    for (const label of labels(JSON.stringify(event), AUDIT_PATTERNS)) hits.push({ source: 'event', id: event.event_id, label })
  }
  for (const { artifact_id, bytes } of input.artifacts ?? []) {
    for (const label of labels(Buffer.from(bytes).toString('utf8'), ARTIFACT_PATTERNS)) hits.push({ source: 'artifact', id: artifact_id, label })
  }
  return hits
}

/** 与 API 下载同一套归属：artifact://<mission>/<task>/<path>、绝对路径、相对 Task 目录的路径。 */
export const artifactFile = (workRoot: string, artifact: { readonly task_id: string; readonly uri: string }): string => {
  if (artifact.uri.startsWith('artifact://')) {
    const [, ...rest] = new URL(artifact.uri).pathname.split('/').filter(Boolean).map(decodeURIComponent)
    return resolve(workRoot, artifact.task_id, ...rest)
  }
  return isAbsolute(artifact.uri) ? artifact.uri : resolve(workRoot, artifact.task_id, artifact.uri)
}

const main = async (): Promise<number> => {
  const url = process.env['CMAP_DATABASE_URL']
  const workRoot = process.env['CMAP_WORK_ROOT']
  const schema = process.env['CMAP_DB_SCHEMA'] ?? 'public'
  if (!url || !workRoot || !/^[a-z_][a-z0-9_]*$/.test(schema)) {
    console.error('需要 CMAP_DATABASE_URL 与 CMAP_WORK_ROOT；CMAP_DB_SCHEMA 只允许小写标识符')
    return 2
  }
  const pg = (await import('pg')).default
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  let events: { event_id: string }[]
  let rows: { artifact_id: string; task_id: string; uri: string }[]
  try {
    events = (await client.query(`SELECT * FROM ${schema}.events ORDER BY lamport`)).rows
    rows = (await client.query(`SELECT artifact_id, task_id, uri FROM ${schema}.artifacts ORDER BY artifact_id`)).rows
  } finally {
    await client.end()
  }
  const artifacts: { artifact_id: string; bytes: Buffer }[] = []
  const unreadable: string[] = []
  for (const row of rows) {
    try { artifacts.push({ artifact_id: row.artifact_id, bytes: await readFile(artifactFile(workRoot, row)) }) }
    catch { unreadable.push(row.artifact_id) }
  }
  const hits = scanZeroHit({ events, artifacts })
  console.log(JSON.stringify({ events: events.length, artifacts: artifacts.length, unreadable, hits }, null, 2))
  if (hits.length) return 1
  return unreadable.length ? 3 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main()
