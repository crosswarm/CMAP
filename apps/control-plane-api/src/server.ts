/**
 * 控制面 REST API。
 *
 * 用 Node 内置 http 处理路由，输入校验复用已有 Ajv 与 Schema。
 *
 * 两条贯穿全局的规则：
 *  1. **租户过滤是默认行为**，不是可选参数。跨租户请求一律 404，不返回 403——
 *     后者会泄漏「该 id 确实存在」。
 *  2. **审批必须显式声明 scope**。controlled 与 mutating 互不蕴含，缺失 scope
 *     就默许通过，等于把两类授权合并了（威胁模型 T4 明确禁止）。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { buildEvidencePack, NotFoundError, ApprovalDecisionConflictError, MissionConflictError, EventConflictError } from '#domain-model'
import type { Store, Approval, ApprovalAdviceV1, ApprovalScope, Artifact, MissionEventV1, TaskEvent } from '#domain-model'
import type { Mission } from '#domain-model'
import { legacyInspectForm, missionFromRequest, validateMissionCancel } from './mission-submission.ts'
import type { MissionSubmissionV1 } from '../../../packages/domain-model/src/generated/mission-submission.ts'
import type { ControlPlaneContextV1 } from '../../../packages/domain-model/src/generated/control-plane-context.ts'

export interface ControlPlaneOptions {
  readonly store: Store
  /** 当前请求上下文的租户。P4 接入鉴权后改为从令牌解析。 */
  readonly tenant: string
  /** P2 本机操作人配置。不是 OIDC 身份，也不接受浏览器填写。 */
  readonly owner?: string
  /** Agent 任务工作目录根。Artifact 下载只能读取 workRoot/taskId 下的普通文件。 */
  readonly workRoot?: string
  /** Vite 构建产物目录；配置后仅托管 / 与 /assets/*。 */
  readonly frontendDir?: string
  /** 只查询模型建议；不得写入 Approval 或代替真人批准。 */
  readonly getApprovalAdvice?: (id: string) => Promise<ApprovalAdviceV1>
  /** 必须按 workflowId 幂等启动，运行中与已关闭的 Workflow 均不得重复。 */
  readonly startMission?: (missionId: string, workflowId: string) => Promise<void>
  /** 向运行中的 Mission Workflow 发送 cancelMission 信号；重复发送由 Workflow 去重。 */
  readonly cancelMission?: (missionId: string, workflowId: string, reason: string) => Promise<void>
  /** 审批决定落账后向 Mission Workflow 发 approvalDecided 门铃；不带业务数据，Workflow 醒来回读账本。 */
  readonly notifyApprovalDecided?: (missionId: string, workflowId: string) => Promise<void>
}

interface Ctx {
  readonly req: IncomingMessage
  readonly res: ServerResponse
  readonly params: Record<string, string>
  readonly store: Store
  readonly tenant: string
  readonly shutdown: AbortSignal
  readonly config: ControlPlaneOptions
}

type Handler = (ctx: Ctx) => Promise<void>

interface Route {
  readonly method: 'GET' | 'POST'
  /** 形如 /v1/missions/:id/tasks，:name 捕获为参数 */
  readonly pattern: string
  readonly handler: Handler
}

// ------------------------------------------------------------ 响应工具

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

const fail = (res: ServerResponse, status: number, error: string): void =>
  json(res, status, { error })

class PayloadTooLargeError extends Error {}
class ForbiddenFileError extends Error {}
class FileTooLargeError extends Error {}
class HashMismatchError extends Error {}

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
const DEFAULT_TERMINAL_LIMIT = 50

const readBody = (req: IncomingMessage): Promise<unknown> => new Promise((resolve, reject) => {
  let chunks: Buffer[] | null = []
  let size = 0
  req.on('data', (chunk: Buffer) => {
    if (chunks === null) return
    size += chunk.length
    if (size > 64 * 1024) {
      chunks = null
      reject(new PayloadTooLargeError('请求体超过 64KiB'))
    } else chunks?.push(chunk)
  })
  req.once('error', reject)
  req.once('aborted', () => reject(new Error('请求已断开')))
  req.once('end', () => {
    if (chunks === null) return
    try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
    catch { resolve(null) }
  })
})

// -------------------------------------------------------------- 路由匹配

const matchRoute = (
  routes: readonly Route[],
  method: string,
  path: string,
): { route: Route; params: Record<string, string> } | null => {
  const parts = path.split('/').filter(Boolean)

  for (const route of routes) {
    if (route.method !== method) continue
    const pat = route.pattern.split('/').filter(Boolean)
    if (pat.length !== parts.length) continue

    const params: Record<string, string> = {}
    let ok = true
    for (const [i, seg] of pat.entries()) {
      const actual = parts[i]!
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(actual)
      else if (seg !== actual) { ok = false; break }
    }
    if (ok) return { route, params }
  }
  return null
}

// ---------------------------------------------------------------- 处理器

/**
 * 按租户取 Mission。不属于本租户时返回 null，调用方一律以 404 应答——
 * 用 403 区分「无权」与「不存在」会泄漏 id 的存在性。
 */
const missionInTenant = async (ctx: Ctx, id: string) => {
  const m = await ctx.store.getMission(id)
  return m && m.tenant === ctx.tenant ? m : null
}

const eventData = (event: TaskEvent): MissionEventV1 => ({
  schema: 'cmap/mission-event/v1', event_id: event.event_id,
  event_type: event.event_type, event_version: event.event_version,
  occurred_at: event.occurred_at, mission_id: event.mission_id,
  task_id: event.task_id, lamport: event.lamport,
})

const pendingApprovalsInTenant = async (ctx: Ctx): Promise<readonly Approval[]> => {
  const pending = await ctx.store.listPendingApprovals()
  const visible: Approval[] = []
  for (const approval of pending) {
    if (await missionInTenant(ctx, approval.mission_id)) visible.push(approval)
  }
  return visible
}

const emptyJsonBody = async (ctx: Ctx): Promise<boolean> => {
  const body = await readBody(ctx.req)
  if (
    body === null ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body as Record<string, unknown>).length !== 0
  ) {
    fail(ctx.res, 400, '请求体必须是空 JSON 对象 {}')
    return false
  }
  return true
}

const missionSubmission = (missionId: string): MissionSubmissionV1 => ({
  accepted: true,
  mission_id: missionId,
  workflow_id: `mission-${missionId}`,
})

const respondMissionStart = async (ctx: Ctx, mission: Mission): Promise<void> => {
  const result = missionSubmission(mission.id)
  if (mission.state === 'DRAFT') {
    if (!ctx.config.startMission) return fail(ctx.res, 503, 'Mission 启动入口未配置')
    try { await ctx.config.startMission(mission.id, result.workflow_id) }
    catch {
      json(ctx.res, 503, { error: 'Workflow 启动未确认，请使用原 Mission id 重试', mission_id: mission.id })
      return
    }
  }
  json(ctx.res, 202, result)
}

const streamEvents = async (ctx: Ctx, source: () => Promise<readonly TaskEvent[]>): Promise<void> => {
  let events = await source()
  const cursor = ctx.req.headers['last-event-id']
  if (cursor && !events.some((event) => encodeURIComponent(event.event_id) === cursor)) {
    return fail(ctx.res, 400, 'Last-Event-ID 不属于该事件流')
  }
  const disconnected = new AbortController()
  const signal = AbortSignal.any([ctx.shutdown, disconnected.signal])
  const onClose = () => disconnected.abort()
  ctx.res.on('close', onClose)
  if (ctx.res.destroyed) disconnected.abort()
  const write = async (frame: string) => {
    signal.throwIfAborted()
    if (!ctx.res.write(frame)) await once(ctx.res, 'drain', { signal })
  }
  try {
    signal.throwIfAborted()
    ctx.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      'connection': 'close',
    })
    await write('retry: 1000\n\n')
    const seen = new Set<string>()
    let heartbeat = Date.now()
    // ponytail: 每秒扫描已提交历史；大规模事件流改为提交有序的持久游标。
    // sequence/lamport 不等于提交顺序，不能用最大 lamport 跳过晚提交事务。
    while (!signal.aborted) {
      for (const event of events) {
        if (seen.has(event.event_id)) continue
        await write(`id: ${encodeURIComponent(event.event_id)}\nevent: mission-event\ndata: ${JSON.stringify(eventData(event))}\n\n`)
        seen.add(event.event_id)
      }
      if (Date.now() - heartbeat >= 15_000) {
        await write(': heartbeat\n\n')
        heartbeat = Date.now()
      }
      await delay(1000, undefined, { signal })
      events = await source()
    }
  } catch (error) {
    if (!signal.aborted) throw error
  } finally {
    ctx.res.off('close', onClose)
    ctx.res.end()
  }
}

const streamMissionEvents: Handler = async (ctx) => {
  const id = ctx.params['id']!
  if (!(await missionInTenant(ctx, id))) return fail(ctx.res, 404, `Mission 不存在：${id}`)
  await streamEvents(ctx, () => ctx.store.listEvents(id))
}

const streamTenantEvents: Handler = async (ctx) => {
  await streamEvents(ctx, () => ctx.store.listTenantEvents(ctx.tenant))
}

const isSingleSegment = (v: string): boolean =>
  Boolean(v) && !v.includes('/') && !v.includes('\\') && v !== '.' && v !== '..'

const inside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !rel.includes(`..${sep}`))
}

const safePathParts = (parts: readonly string[]): void => {
  if (parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\'))) {
    throw new ForbiddenFileError('Artifact 路径越界')
  }
}

const artifactFilePath = (taskRoot: string, artifact: Artifact): string => {
  if (artifact.uri.startsWith('artifact://')) {
    let url: URL
    try { url = new URL(artifact.uri) } catch { throw new ForbiddenFileError('Artifact URI 非法') }
    const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p))
    const [taskId, ...rest] = parts
    if (url.protocol !== 'artifact:' || url.hostname !== artifact.mission_id || taskId !== artifact.task_id || rest.length === 0) {
      throw new ForbiddenFileError('Artifact URI 与账本归属不一致')
    }
    safePathParts(rest)
    return resolve(taskRoot, join(...rest))
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(artifact.uri)) {
    throw new ForbiddenFileError('Artifact URI 协议不受支持')
  }

  if (isAbsolute(artifact.uri)) return resolve(artifact.uri)
  const parts = artifact.uri.split('/').filter(Boolean)
  safePathParts(parts)
  return resolve(taskRoot, join(...parts))
}

const readSmallFile = async (file: string): Promise<Buffer> => {
  const handle = await open(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(MAX_ARTIFACT_BYTES + 1)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    if (bytesRead > MAX_ARTIFACT_BYTES) throw new FileTooLargeError('Artifact 超过 2MiB')
    return Buffer.from(buf.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

const attachmentFilename = (id: string): string => {
  const safe = basename(id).replace(/["\\\x00-\x1f\x7f-\uffff]/g, '_').trim()
  return (safe || 'artifact').slice(0, 120)
}

const readArtifactBytes = async (workRoot: string, taskId: string, artifact: Artifact) => {
  const taskRoot = resolve(workRoot, taskId)
  const taskRootInfo = await lstat(taskRoot).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') throw new NotFoundError('Task directory', taskId)
    throw e
  })
  if (!taskRootInfo.isDirectory() || taskRootInfo.isSymbolicLink()) {
    throw new ForbiddenFileError('Task 目录不是普通目录')
  }

  const file = artifactFilePath(taskRoot, artifact)
  if (!inside(taskRoot, file)) throw new ForbiddenFileError('Artifact 路径越界')

  const [realTaskRoot, fileInfo] = await Promise.all([
    realpath(taskRoot),
    lstat(file).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') throw new NotFoundError('Artifact file', artifact.artifact_id)
      throw e
    }),
  ])
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new ForbiddenFileError('Artifact 不是普通文件')

  const realFile = await realpath(file)
  if (!inside(realTaskRoot, realFile)) throw new ForbiddenFileError('Artifact symlink 逃逸')

  const actual = await stat(realFile)
  if (actual.size > MAX_ARTIFACT_BYTES) throw new FileTooLargeError('Artifact 超过 2MiB')
  const bytes = await readSmallFile(realFile)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== artifact.sha256.toLowerCase()) throw new HashMismatchError('Artifact 内容哈希与账本不符')
  return { bytes, sha256 }
}

const downloadArtifact: Handler = async (ctx) => {
  const missionId = ctx.params['id']!
  const taskId = ctx.params['taskId']!
  const artifactId = ctx.params['artifactId']!
  if (!isSingleSegment(taskId)) return fail(ctx.res, 403, 'taskId 必须是单一路径段')
  if (!ctx.config.workRoot) return fail(ctx.res, 503, 'Artifact 工作目录未配置')
  if (!(await missionInTenant(ctx, missionId))) return fail(ctx.res, 404, `Mission 不存在：${missionId}`)
  const task = await ctx.store.getTask(taskId)
  if (!task || task.mission_id !== missionId) return fail(ctx.res, 404, `Task 不存在：${taskId}`)
  const artifact = (await ctx.store.listArtifacts(taskId)).find((a) => a.artifact_id === artifactId)
  if (!artifact || artifact.mission_id !== missionId || artifact.task_id !== taskId) {
    return fail(ctx.res, 404, `Artifact 不存在：${artifactId}`)
  }
  try {
    const { bytes, sha256 } = await readArtifactBytes(ctx.config.workRoot, taskId, artifact)
    ctx.res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': bytes.length,
      'content-disposition': `attachment; filename="${attachmentFilename(artifact.artifact_id)}"`,
      'x-content-type-options': 'nosniff',
      'x-content-sha256': sha256,
    })
    ctx.res.end(bytes)
  } catch (e) {
    if (e instanceof NotFoundError) return fail(ctx.res, 404, e.message)
    if (e instanceof ForbiddenFileError) return fail(ctx.res, 403, e.message)
    if (e instanceof FileTooLargeError) return fail(ctx.res, 413, e.message)
    if (e instanceof HashMismatchError) return fail(ctx.res, 409, e.message)
    throw e
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

const CSP = "default-src 'self'; img-src 'self' blob:; base-uri 'self'; object-src 'none'; frame-ancestors 'none'"

const serveStatic = async (ctx: Omit<Ctx, 'params'>, path: string): Promise<boolean> => {
  if (ctx.req.method !== 'GET' || (path !== '/' && !path.startsWith('/assets/'))) return false
  const frontendDir = ctx.config.frontendDir
  if (!frontendDir) {
    fail(ctx.res, 503, '前端构建目录未配置')
    return true
  }
  const root = resolve(frontendDir)
  try {
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory()) {
      fail(ctx.res, 503, '前端构建目录不可用')
      return true
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      fail(ctx.res, 503, '前端构建目录不存在')
      return true
    }
    throw e
  }

  const rel = path === '/' ? 'index.html' : decodeURIComponent(path.slice('/assets/'.length))
  if (!rel || rel.split('/').some((p) => !p || p === '.' || p === '..') || rel.includes('\\')) {
    fail(ctx.res, 403, '静态资源路径越界')
    return true
  }
  const file = resolve(root, path === '/' ? rel : join('assets', rel))
  if (!inside(root, file)) {
    fail(ctx.res, 403, '静态资源路径越界')
    return true
  }
  const realRoot = await realpath(root)
  let realFile: string
  try {
    realFile = await realpath(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      fail(ctx.res, 404, '静态资源不存在')
      return true
    }
    throw e
  }
  if (!inside(realRoot, realFile)) {
    fail(ctx.res, 403, '静态资源路径越界')
    return true
  }
  const info = await stat(realFile)
  if (!info.isFile()) {
    fail(ctx.res, 404, '静态资源不存在')
    return true
  }
  const bytes = await readFile(realFile)
  ctx.res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(realFile).toLowerCase()] ?? 'application/octet-stream',
    'content-length': bytes.length,
    'cache-control': path === '/' ? 'no-cache' : 'public, max-age=31536000, immutable',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
  })
  ctx.res.end(bytes)
  return true
}

const routes: readonly Route[] = [
  {
    method: 'GET',
    pattern: '/v1/context',
    handler: async ({ res, tenant, config }) => {
      const body: ControlPlaneContextV1 = { tenant, owner: config.owner ?? null, authentication: 'local' }
      json(res, 200, body)
    },
  },
  { method: 'GET', pattern: '/v1/events', handler: streamTenantEvents },
  {
    method: 'POST', pattern: '/v1/missions',
    handler: async (ctx) => {
      const { owner, startMission } = ctx.config
      if (!owner?.trim() || !startMission) return fail(ctx.res, 503, 'Mission 创建入口未配置')
      let body, mission
      try {
        body = await readBody(ctx.req)
        mission = missionFromRequest(body, ctx.tenant, owner)
      } catch (error) {
        if (error instanceof RangeError) return fail(ctx.res, 400, error.message)
        throw error
      }
      // 续作来源：同租户、同 owner、已终结。不区分「不存在」与「无权」，避免泄漏他人 Mission。
      const sourceId = mission.constraints['continues_mission_id']
      if (typeof sourceId === 'string') {
        const source = await missionInTenant(ctx, sourceId)
        if (!source || source.owner !== owner || !['COMPLETED', 'FAILED', 'ESCALATED', 'CANCELED'].includes(source.state)) {
          return fail(ctx.res, 400, 'continues_mission_id 必须指向本 owner 的已终结 Mission')
        }
      }
      let saved
      const actor = { type: 'system', id: 'control-plane-api' } as const
      try {
        saved = await ctx.store.createMission({ mission, actor })
      } catch (error) {
        if (!(error instanceof MissionConflictError)) throw error
        const legacy = (body as { plan?: unknown }).plan === undefined && (await ctx.store.getMission(mission.id))?.workflow_template === 'inspect/v1'
        if (!legacy) return fail(ctx.res, 409, error.message)
        try {
          saved = await ctx.store.createMission({ mission: legacyInspectForm(mission), actor })
        } catch (legacyError) {
          if (legacyError instanceof MissionConflictError) return fail(ctx.res, 409, legacyError.message)
          throw legacyError
        }
      }
      await respondMissionStart(ctx, saved)
    },
  },
  {
    method: 'POST', pattern: '/v1/missions/:id/start',
    handler: async (ctx) => {
      if (!(await emptyJsonBody(ctx))) return
      const id = ctx.params['id']!
      const mission = await ctx.store.getMission(id)
      if (!mission || mission.tenant !== ctx.tenant) return fail(ctx.res, 404, `Mission 不存在：${id}`)
      if (!ctx.config.owner?.trim()) return fail(ctx.res, 503, '本机 owner 未配置')
      if (mission.owner !== ctx.config.owner) return fail(ctx.res, 403, '只能启动本机 owner 创建的 Mission')
      await respondMissionStart(ctx, mission)
    },
  },
  {
    method: 'POST', pattern: '/v1/missions/:id/cancel',
    handler: async (ctx) => {
      const body = await readBody(ctx.req)
      if (!validateMissionCancel(body)) return fail(ctx.res, 400, '请求不符合 mission-cancel v1：reason 必填（1–500 字）')
      const id = ctx.params['id']!
      const mission = await missionInTenant(ctx, id)
      if (!mission) return fail(ctx.res, 404, `Mission 不存在：${id}`)
      const owner = ctx.config.owner?.trim()
      if (!owner || !ctx.config.cancelMission) return fail(ctx.res, 503, 'Mission 取消入口未配置')
      if (mission.owner !== owner) return fail(ctx.res, 403, '只能取消本机 owner 创建的 Mission')
      if (['COMPLETED', 'FAILED', 'ESCALATED', 'CANCELED'].includes(mission.state)) {
        return fail(ctx.res, 409, `Mission 已处于终态 ${mission.state}，不能取消`)
      }
      const result = missionSubmission(mission.id)
      const actor = { type: 'human', id: owner } as const
      // 原因先落账本：信号发不出去时，取消意图仍可追溯，客户端可用同一请求重试。
      try {
        await ctx.store.appendEvent({ event: {
          event_type: 'MISSION_CANCEL_REQUESTED', event_version: 1, occurred_at: new Date().toISOString(),
          mission_id: mission.id, task_id: null, attempt: null, actor, causation_id: null,
          correlation_id: mission.id, trace_id: null, idempotency_key: `mission-cancel-requested:${mission.id}`,
          payload: { reason: body.reason },
        } })
      } catch (error) {
        // 已有取消请求（原因不同）：沿用首次记录，仍重发信号。
        if (!(error instanceof EventConflictError)) throw error
      }
      if (mission.state === 'DRAFT') {
        await ctx.store.setMissionState(mission.id, 'CANCELED', actor, `mission-canceled:${mission.id}`)
        return json(ctx.res, 202, result)
      }
      try { await ctx.config.cancelMission(mission.id, result.workflow_id, body.reason) }
      catch { return json(ctx.res, 503, { error: '取消信号未确认送达，请重试', mission_id: mission.id }) }
      json(ctx.res, 202, result)
    },
  },
  { method: 'GET', pattern: '/v1/missions/:id/events', handler: streamMissionEvents },
  { method: 'GET', pattern: '/v1/missions/:id/artifacts/:taskId/:artifactId', handler: downloadArtifact },
  {
    method: 'GET',
    pattern: '/v1/health',
    handler: async ({ res, store }) => {
      const h = await store.healthCheck()
      json(res, h.ok ? 200 : 503, h)
    },
  },

  {
    method: 'GET',
    pattern: '/v1/missions',
    handler: async ({ req, res, store, tenant }) => {
      const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('terminal_limit')
      const terminalLimit = raw === null ? DEFAULT_TERMINAL_LIMIT : Number(raw)
      if (raw === '' || !Number.isInteger(terminalLimit) || terminalLimit < 0 || terminalLimit > 500) {
        return fail(res, 400, 'terminal_limit 必须是 0 到 500 的整数')
      }
      json(res, 200, { items: await store.queryMissions({ tenant, terminal_limit: terminalLimit }) })
    },
  },

  {
    method: 'GET',
    pattern: '/v1/missions/:id',
    handler: async (ctx) => {
      const m = await missionInTenant(ctx, ctx.params['id']!)
      if (!m) return fail(ctx.res, 404, `Mission 不存在：${ctx.params['id']}`)
      json(ctx.res, 200, m)
    },
  },

  {
    method: 'GET',
    pattern: '/v1/missions/:id/tasks',
    handler: async (ctx) => {
      const id = ctx.params['id']!
      if (!(await missionInTenant(ctx, id))) {
        return fail(ctx.res, 404, `Mission 不存在：${id}`)
      }
      const items = await ctx.store.queryTasks({ missionId: id })
      json(ctx.res, 200, { items })
    },
  },

  {
    method: 'GET',
    pattern: '/v1/missions/:id/evidence',
    handler: async (ctx) => {
      const id = ctx.params['id']!
      if (!(await missionInTenant(ctx, id))) {
        return fail(ctx.res, 404, `Mission 不存在：${id}`)
      }
      json(ctx.res, 200, await buildEvidencePack(ctx.store, id))
    },
  },

  {
    method: 'GET',
    pattern: '/v1/missions/:id/reviews',
    handler: async (ctx) => {
      const id = ctx.params['id']!
      if (!(await missionInTenant(ctx, id))) {
        return fail(ctx.res, 404, `Mission 不存在：${id}`)
      }
      json(ctx.res, 200, { items: await ctx.store.listReviews(id) })
    },
  },

  {
    method: 'GET',
    pattern: '/v1/approvals',
    handler: async (ctx) => {
      json(ctx.res, 200, { items: await pendingApprovalsInTenant(ctx) })
    },
  },

  {
    method: 'POST',
    pattern: '/v1/approvals/:id/advice',
    handler: async (ctx) => {
      const id = ctx.params['id']!
      if (!(await emptyJsonBody(ctx))) return

      const target = await ctx.store.getApproval(id)
      if (!target || target.decision !== 'pending' || !(await missionInTenant(ctx, target.mission_id))) {
        return fail(ctx.res, 404, `审批不存在：${id}`)
      }
      if (!ctx.config.getApprovalAdvice) return fail(ctx.res, 503, '审批建议入口未配置')

      try {
        const advice = await ctx.config.getApprovalAdvice(id)
        if (advice.request_id !== id || advice.can_continue !== false) {
          return fail(ctx.res, 503, '审批建议不可用')
        }
        json(ctx.res, 200, advice)
      } catch {
        fail(ctx.res, 503, '审批建议不可用')
      }
    },
  },

  {
    method: 'GET',
    pattern: '/v1/approvals/:id/jev-decision',
    handler: async (ctx) => {
      // 只读账本里的影子决定：不是人工授权，不改审批。
      const id = ctx.params['id']!
      const target = await ctx.store.getApproval(id)
      const recorded = target && (await missionInTenant(ctx, target.mission_id))
        ? (await ctx.store.listEvents(target.mission_id)).find((e) => e.event_type === 'JEV_DECIDED' && e.idempotency_key === `jev-decided:${id}`)
        : undefined
      if (!recorded) return fail(ctx.res, 404, `Jev 决定不存在：${id}`)
      json(ctx.res, 200, recorded.payload)
    },
  },

  {
    method: 'POST',
    pattern: '/v1/approvals/:id/decision',
    handler: async (ctx) => {
      const id = ctx.params['id']!
      if (!ctx.config.owner?.trim()) return fail(ctx.res, 503, '本机 owner 未配置，不能决策审批')
      const body = await readBody(ctx.req)
      if (body === null || typeof body !== 'object') {
        return fail(ctx.res, 400, '请求体不是合法 JSON')
      }

      const { decision, scope, decided_by: decidedBy } =
        body as { decision?: string; scope?: string; decided_by?: string }

      // scope 必填：缺失时默许通过等于把 controlled 与 mutating 合并了
      if (scope !== 'controlled' && scope !== 'mutating') {
        return fail(
          ctx.res, 400,
          'scope 必须显式声明为 controlled 或 mutating——两类授权互不蕴含',
        )
      }
      if (decision !== 'approved' && decision !== 'rejected') {
        return fail(ctx.res, 400, 'decision 必须是 approved 或 rejected')
      }
      // 审计流不能出现「不知道谁批的」记录
      if (typeof decidedBy !== 'string' || !decidedBy.trim()) {
        return fail(ctx.res, 400, 'decided_by 必填，审批必须可追溯到具体的人')
      }
      // 身份由控制面配置决定，请求体只能复述它，不能自报别人
      if (decidedBy !== ctx.config.owner) {
        return fail(ctx.res, 403, 'decided_by 必须等于本机 owner')
      }

      const target = await ctx.store.getApproval(id)
      if (!target || !(await missionInTenant(ctx, target.mission_id))) {
        return fail(ctx.res, 404, `审批不存在：${id}`)
      }

      // 意图与请求不符说明调用方认知错位，不能放行
      if (target.scope !== (scope as ApprovalScope)) {
        return fail(
          ctx.res, 409,
          `scope 不符：该审批的范围是 ${target.scope}，而请求声明的是 ${scope}`,
        )
      }

      try {
        const updated = await ctx.store.decideApproval(
          id, decision, decidedBy, new Date().toISOString(),
        )
        // 决定已落账：门铃丢了 Workflow 也会在等待超时后回读，所以失败只记录。
        try { await ctx.config.notifyApprovalDecided?.(updated.mission_id, missionSubmission(updated.mission_id).workflow_id) }
        catch (error) { console.warn(`approvalDecided 信号未送达 mission=${updated.mission_id}: ${error instanceof Error ? error.message : String(error)}`) }
        json(ctx.res, 200, updated)
      } catch (e) {
        if (e instanceof NotFoundError) return fail(ctx.res, 404, e.message)
        if (e instanceof ApprovalDecisionConflictError) return fail(ctx.res, 409, e.message)
        if (e instanceof RangeError) return fail(ctx.res, 400, e.message)
        throw e
      }
    },
  },

  {
    method: 'GET',
    pattern: '/v1/locks',
    handler: async (ctx) => {
      const visible = []
      for (const lock of await ctx.store.listActiveLocks(new Date().toISOString())) {
        const task = await ctx.store.getTask(lock.task_id)
        if (!task || task.mission_id !== lock.mission_id) continue
        if (await missionInTenant(ctx, task.mission_id)) visible.push(lock)
      }
      json(ctx.res, 200, { items: visible })
    },
  },
]

// ------------------------------------------------------------------ 组装

export const createControlPlane = async (opts: ControlPlaneOptions) => {
  const shutdown = new AbortController()
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const port = (server.address() as AddressInfo).port
        const host = req.headers.host
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
          return fail(res, 403, '仅接受本机 Host')
        }
        if (req.method === 'POST') {
          const origin = req.headers.origin
          if ((origin && origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
            return fail(res, 403, '跨来源写入被拒绝')
          }
          if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
            return fail(res, 415, '写入必须使用 application/json')
          }
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        try { decodeURIComponent(url.pathname) } catch {
          return fail(res, 400, '路径编码无效')
        }
        const staticCtx = {
          req, res, store: opts.store, tenant: opts.tenant,
          shutdown: shutdown.signal, config: opts,
        }
        if (await serveStatic(staticCtx, url.pathname)) return
        const hit = matchRoute(routes, req.method ?? 'GET', url.pathname)

        if (!hit) return fail(res, 404, `未知路径：${req.method} ${url.pathname}`)

        await hit.route.handler({
          req, res, params: hit.params,
          store: opts.store, tenant: opts.tenant,
          shutdown: shutdown.signal,
          config: opts,
        })
      } catch (e) {
        if (res.destroyed) return
        if (e instanceof PayloadTooLargeError) {
          res.shouldKeepAlive = false
          return fail(res, 413, e.message)
        }
        // 未预期的异常也必须返回 JSON——前端按 JSON 解析，
        // 返回 HTML 或空响应会变成解析异常而非清晰报错。
        if (!res.headersSent) fail(res, 500, `内部错误：${(e as Error).message}`)
        else res.end()
      }
    })()
  })

  return {
    listen: (port: number) =>
      new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve)),
    close: () => new Promise<void>((resolve) => {
      shutdown.abort()
      server.close(() => resolve())
    }),
    address: (): AddressInfo | string | null => server.address(),
  }
}
