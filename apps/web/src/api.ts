import type { Approval, Artifact } from '#domain-model'
import { authHeaders, login, oidcEnabled } from './auth.ts'

export class ApiError extends Error {
  readonly status: number
  readonly missionId: string | null
  constructor(
    status: number,
    message: string,
    missionId: string | null = null,
  ) {
    super(message)
    this.status = status
    this.missionId = missionId
  }
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(30_000)
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout
  let response: Response
  try {
    response = await fetch(path, {
      ...options,
      headers: { ...authHeaders(), ...(options.headers as Record<string, string>) },
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError')
      throw new ApiError(0, '请求等待超时，尚未确认结果')
    throw error
  }
  // token 过期或被拒：整页重走登录，IdP 会话仍在时无需再输口令
  if (response.status === 401 && oidcEnabled) void login()
  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new ApiError(response.status, '服务返回了无法读取的内容')
  }
  if (!response.ok) {
    const message =
      data &&
      typeof data === 'object' &&
      'error' in data &&
      typeof data.error === 'string'
        ? data.error
        : '请求失败，请重试'
    const missionId =
      data &&
      typeof data === 'object' &&
      'mission_id' in data &&
      typeof data.mission_id === 'string'
        ? data.mission_id
        : null
    throw new ApiError(response.status, message, missionId)
  }
  return data as T
}

export const post = <T>(path: string, body: unknown, signal?: AbortSignal) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })

/**
 * 订阅 SSE 帧。本机模式用 EventSource；OIDC 模式下 EventSource 带不了 Authorization，
 * 改用 fetch 读流，断开 1 秒后重连（服务端每次连接都回放历史，调用方按 event_id 去重）。
 */
export function subscribe(
  path: string,
  on: { open: () => void; error: () => void; event: (data: string) => void },
): () => void {
  if (!oidcEnabled) {
    const stream = new EventSource(path)
    stream.onopen = on.open
    stream.onerror = on.error
    stream.addEventListener('mission-event', (e) => on.event((e as MessageEvent<string>).data))
    return () => stream.close()
  }
  const abort = new AbortController()
  void (async () => {
    while (!abort.signal.aborted) {
      try {
        const response = await fetch(path, { headers: authHeaders(), signal: abort.signal })
        if (response.status === 401) void login()
        if (!response.ok || !response.body) throw new Error(String(response.status))
        on.open()
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += value
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''
          for (const frame of frames) {
            const lines = frame.split('\n')
            if (!lines.includes('event: mission-event')) continue
            const data = lines.find((l) => l.startsWith('data: '))
            if (data) on.event(data.slice('data: '.length))
          }
        }
      } catch {
        if (abort.signal.aborted) return
      }
      on.error()
      await new Promise((r) => setTimeout(r, 1000))
    }
  })()
  return () => abort.abort()
}

export const artifactURL = (artifact: Artifact) =>
  `/v1/missions/${encodeURIComponent(artifact.mission_id)}/artifacts/${encodeURIComponent(artifact.task_id)}/${encodeURIComponent(artifact.artifact_id)}`
export const approvalURL = (approval: Approval) =>
  `/v1/approvals/${encodeURIComponent(approval.id)}/decision`
