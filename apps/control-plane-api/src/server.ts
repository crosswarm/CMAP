/**
 * 控制面 REST API。
 *
 * 用 Node 内置 http，不引框架——路由规模小，加一个框架换不来等值的收益，
 * 而项目目前只有一个运行时依赖（pg），这份克制值得保持。
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

import { buildEvidencePack, NotFoundError, ApprovalDecisionConflictError } from '#domain-model'
import type { Store, Approval, ApprovalScope, MissionEventV1 } from '#domain-model'

export interface ControlPlaneOptions {
  readonly store: Store
  /** 当前请求上下文的租户。P4 接入鉴权后改为从令牌解析。 */
  readonly tenant: string
}

interface Ctx {
  readonly req: IncomingMessage
  readonly res: ServerResponse
  readonly params: Record<string, string>
  readonly store: Store
  readonly tenant: string
  readonly shutdown: AbortSignal
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

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null // 交给调用方判定为 400
  }
}

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

const pendingApprovalsInTenant = async (ctx: Ctx): Promise<readonly Approval[]> => {
  const pending = await ctx.store.listPendingApprovals()
  const visible: Approval[] = []
  for (const approval of pending) {
    if (await missionInTenant(ctx, approval.mission_id)) visible.push(approval)
  }
  return visible
}

const streamMissionEvents: Handler = async (ctx) => {
  const id = ctx.params['id']!
  if (!(await missionInTenant(ctx, id))) return fail(ctx.res, 404, `Mission 不存在：${id}`)
  let events = await ctx.store.listEvents(id)
  const cursor = ctx.req.headers['last-event-id']
  if (cursor && !events.some((event) => encodeURIComponent(event.event_id) === cursor)) {
    return fail(ctx.res, 400, 'Last-Event-ID 不属于该 Mission')
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
    // ponytail: 每秒扫描本 Mission 已提交历史；大规模事件流改为提交有序的持久游标。
    // sequence/lamport 不等于提交顺序，不能用最大 lamport 跳过晚提交事务。
    while (!signal.aborted) {
      for (const event of events) {
        if (seen.has(event.event_id)) continue
        const data: MissionEventV1 = {
          schema: 'cmap/mission-event/v1', event_id: event.event_id,
          event_type: event.event_type, event_version: event.event_version,
          occurred_at: event.occurred_at, mission_id: event.mission_id,
          task_id: event.task_id, lamport: event.lamport,
        }
        await write(`id: ${encodeURIComponent(event.event_id)}\nevent: mission-event\ndata: ${JSON.stringify(data)}\n\n`)
        seen.add(event.event_id)
      }
      if (Date.now() - heartbeat >= 15_000) {
        await write(': heartbeat\n\n')
        heartbeat = Date.now()
      }
      await delay(1000, undefined, { signal })
      events = await ctx.store.listEvents(id)
    }
  } catch (error) {
    if (!signal.aborted) throw error
  } finally {
    ctx.res.off('close', onClose)
    ctx.res.end()
  }
}

const routes: readonly Route[] = [
  { method: 'GET', pattern: '/v1/missions/:id/events', handler: streamMissionEvents },
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
    handler: async ({ res, store, tenant }) => {
      json(res, 200, { items: await store.queryMissions({ tenant }) })
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
    pattern: '/v1/approvals/:id/decision',
    handler: async (ctx) => {
      const id = ctx.params['id']!
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
    handler: async ({ res, store }) => {
      json(res, 200, { items: await store.listActiveLocks(new Date().toISOString()) })
    },
  },
]

// ------------------------------------------------------------------ 组装

export const createControlPlane = async (opts: ControlPlaneOptions) => {
  const shutdown = new AbortController()
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const hit = matchRoute(routes, req.method ?? 'GET', url.pathname)

        if (!hit) return fail(res, 404, `未知路径：${req.method} ${url.pathname}`)

        await hit.route.handler({
          req, res, params: hit.params,
          store: opts.store, tenant: opts.tenant,
          shutdown: shutdown.signal,
        })
      } catch (e) {
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
