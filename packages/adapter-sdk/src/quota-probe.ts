/**
 * 零额度探针（ADR-0009 §1）：在持有提供方登录态的 runner 主机上读取账号级额度，不发起任何模型调用。
 *
 *   codex   `codex app-server --listen stdio://`：initialize → initialized → account/rateLimits/read
 *   claude  `claude -p` stream-json：只发 control_request initialize 与 get_usage（实验性接口），不发 user 消息
 *   kimi    尚无可用的零额度读取，记 unknown
 *
 * 读不到（超时、无法启动、应答畸形）记 unknown；提供方明确回错记 error。两者都不等于充足。
 * 账号只留带提供方域前缀的 sha256 摘要；原始账号 id、邮箱、令牌都不出本模块。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'

import type { QuotaSnapshotV1 } from '#domain-model'
import { terminateOwnedProcessGroup } from './process-group.ts'
import { codexProviderEnv, providerBaseEnv } from './provider-env.ts'

type Provider = QuotaSnapshotV1['provider']
type Window = QuotaSnapshotV1['windows'][number]

const validateSnapshot = new Ajv2020({ strict: true }).compile<QuotaSnapshotV1>(
  JSON.parse(readFileSync(new URL('../../../schemas/quota-snapshot.v1.schema.json', import.meta.url), 'utf8')),
)

export interface QuotaProbeOptions {
  readonly bin?: string
  /** 整个探测（启动 + 应答）的上限，默认 10 秒；超时即 unknown。 */
  readonly timeoutMs?: number
  readonly env?: NodeJS.ProcessEnv
}

const MAX_STDOUT_BYTES = 4 * 1024 * 1024

const snapshot = (provider: Provider, status: QuotaSnapshotV1['status'], rest: Partial<QuotaSnapshotV1> = {}): QuotaSnapshotV1 => ({
  schema: 'cmap/quota-snapshot/v1', provider, account_ref: null, windows: [], ordinary_usage_allowed: null,
  observed_at: new Date().toISOString(), status, ...rest,
})

export const unknownQuota = (provider: Provider): QuotaSnapshotV1 => snapshot(provider, 'unknown')

const accountRef = (provider: Provider, identity: string): string =>
  createHash('sha256').update(`cmap-quota-account-v1\n${provider}\n${identity}`).digest('hex')

const isoOrNull = (value: unknown): string | null => {
  const ms = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** 结果必须满足契约，否则按 unknown：宁可不知道，也不把畸形数据当成额度。 */
const checked = (provider: Provider, s: QuotaSnapshotV1): QuotaSnapshotV1 => (validateSnapshot(s) ? s : unknownQuota(provider))

type Step = (message: Record<string, any>, send: (m: object) => void) => QuotaSnapshotV1 | undefined

/** 起子进程按行收发 JSON；step 给出快照即结束。任何意外都收敛为 unknown，绝不抛错。 */
const converse = (provider: Provider, bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number,
  first: object, step: Step): Promise<QuotaSnapshotV1> => new Promise((resolve) => {
  let done = false
  let child: ReturnType<typeof spawn>
  const finish = (s: QuotaSnapshotV1): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    child?.stdin?.end()
    if (child) terminateOwnedProcessGroup(child)
    resolve(checked(provider, s))
  }
  const timer = setTimeout(() => finish(unknownQuota(provider)), timeoutMs)
  try {
    child = spawn(bin, args, { env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
  } catch {
    finish(unknownQuota(provider))
    return
  }
  const send = (m: object): void => { if (!done) child.stdin?.write(`${JSON.stringify(m)}\n`) }
  let buffer = ''
  let size = 0
  child.stdout?.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > MAX_STDOUT_BYTES) return finish(unknownQuota(provider))
    buffer += chunk.toString('utf8')
    let i
    while (!done && (i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
      let message: unknown
      try { message = JSON.parse(line) } catch { continue }
      if (typeof message !== 'object' || message === null) continue
      try {
        const out = step(message as Record<string, any>, send)
        if (out) finish(out)
      } catch {
        finish(unknownQuota(provider))
      }
    }
  })
  child.stdin?.on('error', () => finish(unknownQuota(provider)))
  child.on('error', () => finish(unknownQuota(provider)))
  child.on('close', () => finish(unknownQuota(provider)))
  send(first)
})

const codexWindow = (kind: string, w: any): Window[] => w == null ? [] : [{
  kind, used_percent: w.usedPercent,
  window_minutes: w.windowDurationMins ?? null,
  resets_at: w.resetsAt == null ? null : isoOrNull(w.resetsAt),
}]

export const probeCodexQuota = (opts: QuotaProbeOptions = {}): Promise<QuotaSnapshotV1> =>
  converse('codex', opts.bin ?? process.env['CODEX_BIN'] ?? 'codex', ['app-server', '--listen', 'stdio://'],
    opts.env ?? codexProviderEnv(), opts.timeoutMs ?? 10_000,
    { id: 1, method: 'initialize', params: { clientInfo: { name: 'cmap-quota-probe', version: '1' } } },
    (m, send) => {
      if (m['id'] === 1) {
        if (m['error']) return snapshot('codex', 'error')
        send({ method: 'initialized' })
        send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } })
        return undefined
      }
      if (m['id'] !== 2) return undefined
      if (m['error']) return snapshot('codex', 'error')
      const r = m['result']
      const limits = r?.rateLimits
      if (!limits) return unknownQuota('codex')
      return snapshot('codex', 'ok', {
        account_ref: typeof r.accountId === 'string' && r.accountId ? accountRef('codex', r.accountId) : null,
        windows: [...codexWindow('primary', limits.primary), ...codexWindow('secondary', limits.secondary)],
        ordinary_usage_allowed: typeof r.ordinaryUsageAllowed === 'boolean' ? r.ordinaryUsageAllowed : null,
      })
    })

const CLAUDE_WINDOWS: readonly [string, number][] = [['five_hour', 300], ['seven_day', 10080]]

export const probeClaudeQuota = (opts: QuotaProbeOptions = {}): Promise<QuotaSnapshotV1> => {
  let account: string | null = null
  return converse('claude', opts.bin ?? 'claude',
    ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config'],
    opts.env ?? providerBaseEnv(process.env, { CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'], USER: process.env['USER'] }),
    opts.timeoutMs ?? 10_000,
    { type: 'control_request', request_id: 'cmap-quota-init', request: { subtype: 'initialize' } },
    (m, send) => {
      if (m['type'] !== 'control_response') return undefined
      const r = m['response']
      if (r?.request_id === 'cmap-quota-init') {
        if (r.subtype !== 'success') return snapshot('claude', 'error')
        const a = r.response?.account
        if (typeof a?.email === 'string' && a.email) account = accountRef('claude', `${a.email}\n${a.organization ?? ''}`)
        send({ type: 'control_request', request_id: 'cmap-quota-usage', request: { subtype: 'get_usage', skip_behaviors: true } })
        return undefined
      }
      if (r?.request_id !== 'cmap-quota-usage') return undefined
      if (r.subtype !== 'success') return snapshot('claude', 'error', { account_ref: account })
      const usage = r.response
      if (usage?.rate_limits_available !== true) return snapshot('claude', 'unknown', { account_ref: account })
      const windows = CLAUDE_WINDOWS.flatMap(([kind, minutes]) => {
        const w = usage.rate_limits?.[kind]
        return w == null ? [] : [{ kind, used_percent: w.utilization, window_minutes: minutes, resets_at: w.resets_at == null ? null : isoOrNull(w.resets_at) }]
      })
      return snapshot('claude', 'ok', { account_ref: account, windows })
    })
}

export const probeKimiQuota = async (): Promise<QuotaSnapshotV1> => unknownQuota('kimi')

export interface QuotaCacheOptions {
  /** 快照有效期，默认 5 分钟（与控制面过期阈值一致）；过期后下一次读取重探。 */
  readonly ttlMs?: number
  /** 读取最多等探测多久；等不到就先返回旧快照（没有则 unknown），探测在后台完成后写入缓存。默认一直等。 */
  readonly waitMs?: number
  readonly now?: () => number
}

/** 给探针加缓存：有效期内复用，并发读取共享同一次探测。 */
export const cachedQuotaProbe = (provider: Provider, probe: () => Promise<QuotaSnapshotV1>, opts: QuotaCacheOptions = {}): () => Promise<QuotaSnapshotV1> => {
  const ttlMs = opts.ttlMs ?? 300_000
  const now = opts.now ?? Date.now
  let cached: QuotaSnapshotV1 | undefined
  let cachedAt = 0
  let inflight: Promise<QuotaSnapshotV1> | undefined
  return async () => {
    if (cached && now() - cachedAt < ttlMs) return cached
    inflight ??= probe().catch(() => unknownQuota(provider)).then((s) => {
      cached = s
      cachedAt = now()
      inflight = undefined
      return s
    })
    if (opts.waitMs === undefined) return inflight
    let timer: NodeJS.Timeout | undefined
    const fallback = new Promise<QuotaSnapshotV1>((resolve) => {
      timer = setTimeout(() => resolve(cached ?? unknownQuota(provider)), opts.waitMs)
    })
    try {
      return await Promise.race([inflight, fallback])
    } finally {
      clearTimeout(timer)
    }
  }
}
