/**
 * 零额度探针单测（ADR-0009 §1）：假 app-server / 假 claude 子进程，不调用真实提供方。
 */
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { QuotaSnapshotV1 } from '#domain-model'
import { cachedQuotaProbe, probeClaudeQuota, probeCodexQuota, probeKimiQuota } from '../../packages/adapter-sdk/src/quota-probe.ts'
import { CodexAdapter } from '../../adapters/codex-adapter/src/index.ts'

const RAW_ACCOUNT = 'acct-0000-raw-id'
const RAW_EMAIL = 'someone@example.invalid'

/** 写一个假 CLI：收到的每行 JSON 记到 log，按 respond 脚本应答。 */
const fakeCli = async (respond: string): Promise<{ bin: string; log: string; args: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-quota-probe-'))
  const bin = join(dir, 'fake.cjs')
  const log = join(dir, 'log')
  const args = join(dir, 'args')
  await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(args)}, JSON.stringify(process.argv.slice(2)))
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    fs.appendFileSync(${JSON.stringify(log)}, line + '\\n')
    const m = JSON.parse(line)
    ${respond}
  }
})
`)
  await chmod(bin, 0o755)
  return { bin, log, args }
}

const received = async (log: string): Promise<any[]> =>
  (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l))

const CODEX_OK = `
if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } })
if (m.method === 'account/rateLimits/read') send({ id: m.id, result: {
  ordinaryUsageAllowed: true, accountId: ${JSON.stringify(RAW_ACCOUNT)},
  rateLimits: { primary: { usedPercent: 84, windowDurationMins: 10080, resetsAt: 1793319769 }, secondary: null, planType: 'prolite' },
} })`

test('Codex：initialize → initialized → account/rateLimits/read，归一为账号级快照，账号只留摘要', async () => {
  const cli = await fakeCli(CODEX_OK)
  const snap = await probeCodexQuota({ bin: cli.bin, timeoutMs: 5_000 })
  assert.deepEqual(JSON.parse(await readFile(cli.args, 'utf8')), ['app-server', '--listen', 'stdio://'])
  const msgs = await received(cli.log)
  assert.equal(msgs[0].method, 'initialize')
  assert.equal(typeof msgs[0].params.clientInfo.name, 'string')
  assert.deepEqual(msgs.slice(1).map((m) => m.method), ['initialized', 'account/rateLimits/read'])
  assert.deepEqual(msgs[2].params, { excludeResetCreditDetails: true })
  assert.equal(snap.status, 'ok')
  assert.equal(snap.provider, 'codex')
  assert.match(snap.account_ref!, /^[a-f0-9]{64}$/)
  assert.notEqual(snap.account_ref, createHash('sha256').update(RAW_ACCOUNT).digest('hex'), '摘要带提供方域前缀，不是裸 sha256')
  assert.ok(!JSON.stringify(snap).includes(RAW_ACCOUNT))
  assert.equal(snap.ordinary_usage_allowed, true)
  assert.deepEqual(snap.windows, [{ kind: 'primary', used_percent: 84, window_minutes: 10080, resets_at: new Date(1793319769 * 1000).toISOString() }])
  assert.ok(Date.parse(snap.observed_at) > 0)
  // 同一账号两次探测得到同一摘要（两台 runner 共享一个额度池）
  assert.equal((await probeCodexQuota({ bin: cli.bin })).account_ref, snap.account_ref)
})

test('Codex：ordinaryUsageAllowed 为 null 时如实为 null，不推断', async () => {
  const cli = await fakeCli(CODEX_OK.replace('ordinaryUsageAllowed: true', 'ordinaryUsageAllowed: null'))
  assert.equal((await probeCodexQuota({ bin: cli.bin })).ordinary_usage_allowed, null)
})

test('Codex：提供方返回 JSON-RPC 错误记 error；超时、不存在的 bin、畸形应答都记 unknown', async () => {
  const errored = await fakeCli(`
if (m.method === 'initialize') send({ id: m.id, result: {} })
if (m.method === 'account/rateLimits/read') send({ id: m.id, error: { code: -32000, message: 'not logged in' } })`)
  const e = await probeCodexQuota({ bin: errored.bin })
  assert.equal(e.status, 'error')
  assert.equal(e.account_ref, null)
  assert.deepEqual(e.windows, [])

  const hang = await fakeCli('')
  const started = Date.now()
  const t = await probeCodexQuota({ bin: hang.bin, timeoutMs: 200 })
  assert.equal(t.status, 'unknown')
  assert.ok(Date.now() - started < 3_000, '超时必须及时返回')

  assert.equal((await probeCodexQuota({ bin: join(tmpdir(), 'no-such-codex-bin') })).status, 'unknown')

  const malformed = await fakeCli(`
if (m.method === 'initialize') send({ id: m.id, result: {} })
if (m.method === 'account/rateLimits/read') send({ id: m.id, result: { accountId: 'x', rateLimits: { primary: { usedPercent: 'lots' } } } })`)
  assert.equal((await probeCodexQuota({ bin: malformed.bin })).status, 'unknown')
})

const CLAUDE_OK = `
if (m.type === 'control_request' && m.request.subtype === 'initialize') send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { account: { email: ${JSON.stringify(RAW_EMAIL)}, organization: 'org' } } } })
if (m.type === 'control_request' && m.request.subtype === 'get_usage') send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {
  rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 47, resets_at: '2026-10-23T05:20:00.151415+00:00' }, seven_day: { utilization: 92, resets_at: '2026-10-23T06:00:00.151435+00:00' }, seven_day_opus: null },
} } })`

test('Claude：只发 initialize 与 get_usage(skip_behaviors) 控制请求，不发 user 消息、不带 --bare', async () => {
  const cli = await fakeCli(CLAUDE_OK)
  const snap = await probeClaudeQuota({ bin: cli.bin, timeoutMs: 5_000 })
  const args = JSON.parse(await readFile(cli.args, 'utf8'))
  for (const flag of ['-p', '--input-format', '--output-format', '--verbose', '--no-session-persistence', '--strict-mcp-config']) assert.ok(args.includes(flag), flag)
  assert.ok(!args.includes('--bare'))
  const msgs = await received(cli.log)
  assert.deepEqual(msgs.map((m) => m.type), ['control_request', 'control_request'])
  assert.deepEqual(msgs.map((m) => m.request.subtype), ['initialize', 'get_usage'])
  assert.equal(msgs[1].request.skip_behaviors, true)
  assert.equal(snap.status, 'ok')
  assert.equal(snap.provider, 'claude')
  assert.match(snap.account_ref!, /^[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(snap).includes(RAW_EMAIL))
  assert.equal(snap.ordinary_usage_allowed, null)
  assert.deepEqual(snap.windows, [
    { kind: 'five_hour', used_percent: 47, window_minutes: 300, resets_at: '2026-10-23T05:20:00.151Z' },
    { kind: 'seven_day', used_percent: 92, window_minutes: 10080, resets_at: '2026-10-23T06:00:00.151Z' },
  ])
})

test('Claude：控制请求返回 error 记 error；超时记 unknown', async () => {
  const errored = await fakeCli(`
if (m.request.subtype === 'initialize') send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } })
if (m.request.subtype === 'get_usage') send({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'unsupported' } })`)
  assert.equal((await probeClaudeQuota({ bin: errored.bin })).status, 'error')
  assert.equal((await probeClaudeQuota({ bin: (await fakeCli('')).bin, timeoutMs: 200 })).status, 'unknown')
})

test('Kimi 尚无零额度读取：一律 unknown', async () => {
  const snap = await probeKimiQuota()
  assert.equal(snap.provider, 'kimi')
  assert.equal(snap.status, 'unknown')
  assert.equal(snap.account_ref, null)
})

const fixed = (observedAt: string, used = 10): QuotaSnapshotV1 => ({
  schema: 'cmap/quota-snapshot/v1', provider: 'codex', account_ref: 'a'.repeat(64),
  windows: [{ kind: 'primary', used_percent: used, window_minutes: 10080, resets_at: null }],
  ordinary_usage_allowed: true, observed_at: observedAt, status: 'ok',
})

test('缓存：有效期内复用、过期重探；并发只探一次；探测慢时按等待上限返回旧值或 unknown', async () => {
  let clock = 0
  let calls = 0
  const probe = cachedQuotaProbe('codex', async () => { calls += 1; return fixed(new Date(clock).toISOString(), calls) }, { ttlMs: 1_000, now: () => clock })
  const [a, b] = await Promise.all([probe(), probe()])
  assert.equal(calls, 1)
  assert.deepEqual(a, b)
  clock = 999
  assert.equal((await probe()).windows[0]!.used_percent, 1)
  clock = 1_000
  assert.equal((await probe()).windows[0]!.used_percent, 2, '过期即重探')
  assert.equal(calls, 2)

  let release!: () => void
  const slow = cachedQuotaProbe('codex', () => new Promise<QuotaSnapshotV1>((resolve) => { release = () => resolve(fixed('2026-10-23T00:00:00.000Z')) }), { waitMs: 20 })
  const first = await slow()
  assert.equal(first.status, 'unknown', '没有旧值时等不到就是 unknown')
  release()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal((await slow()).status, 'ok', '后台探测完成后写入缓存')
})

test('本机进程内 CodexAdapter 的 health 附带快照；未配置探针时不带', async () => {
  const cli = await fakeCli(CODEX_OK)
  const version = join(await mkdtemp(join(tmpdir(), 'cmap-quota-health-')), 'codex.cjs')
  await writeFile(version, `#!${process.execPath}\nconsole.log('fake 0.0.0')\n`)
  await chmod(version, 0o755)
  const schema = join(process.cwd(), 'schemas/codex-output.v1.schema.json')
  const withQuota = new CodexAdapter({ authorization: { mode: 'standalone' }, bin: version, outputSchemaPath: schema, quota: () => probeCodexQuota({ bin: cli.bin }) })
  const health = await withQuota.health()
  assert.equal(health.state, 'healthy')
  assert.equal(health.quota?.status, 'ok')
  assert.equal(health.quota?.provider, 'codex')
  const plain = await new CodexAdapter({ authorization: { mode: 'standalone' }, bin: version, outputSchemaPath: schema }).health()
  assert.equal(plain.quota, undefined)
})
