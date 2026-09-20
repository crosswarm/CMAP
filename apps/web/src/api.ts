import type { Approval, Artifact } from '#domain-model'

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
    response = await fetch(path, { ...options, signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError')
      throw new ApiError(0, '请求等待超时，尚未确认结果')
    throw error
  }
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

export const artifactURL = (artifact: Artifact) =>
  `/v1/missions/${encodeURIComponent(artifact.mission_id)}/artifacts/${encodeURIComponent(artifact.task_id)}/${encodeURIComponent(artifact.artifact_id)}`
export const approvalURL = (approval: Approval) =>
  `/v1/approvals/${encodeURIComponent(approval.id)}/decision`
