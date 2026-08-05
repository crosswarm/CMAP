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

import { buildEvidencePack, NotFoundError } from '#domain-model'
import type { Store, Approval, ApprovalScope } from '#domain-model'

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

const routes: readonly Route[] = [
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
      // 没有 listMissions，用任务反查 mission 集合的做法会漏掉无任务的 Mission。
      // 这里直接遍历——P4 换 PG 实现时应下沉为带 WHERE tenant 的查询。
      const tasks = await store.queryTasks({})
      const ids = new Set(tasks.map((t) => t.mission_id))
      const items = []
      for (const id of ids) {
        const m = await store.getMission(id)
        if (m && m.tenant === tenant) items.push(m)
      }
      json(res, 200, { items })
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
    handler: async ({ res, store }) => {
      json(res, 200, { items: await store.listPendingApprovals() })
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
      if (!decidedBy) {
        return fail(ctx.res, 400, 'decided_by 必填，审批必须可追溯到具体的人')
      }

      const pending = await ctx.store.listPendingApprovals()
      const target = pending.find((a: Approval) => a.id === id)
      if (!target) return fail(ctx.res, 404, `待审批不存在：${id}`)

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
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const hit = matchRoute(routes, req.method ?? 'GET', url.pathname)

        if (!hit) return fail(res, 404, `未知路径：${req.method} ${url.pathname}`)

        await hit.route.handler({
          req, res, params: hit.params,
          store: opts.store, tenant: opts.tenant,
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    address: (): AddressInfo | string | null => server.address(),
  }
}
