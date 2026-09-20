import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request, ApiError } from '../../apps/web/src/api.ts'

test('创建启动未确认时保留已登记 Mission ID，供关闭表单后恢复', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: '启动未确认', mission_id: 'registered' }), { status: 503 }))
  await assert.rejects(request('/v1/missions'), (error) => error instanceof ApiError && error.status === 503 && error.missionId === 'registered')
})

test('请求超时提供可重试错误，显式取消仍保留 AbortError', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('timeout', 'TimeoutError') })
  await assert.rejects(request('/v1/missions'), (error) => error instanceof ApiError && error.status === 0 && /超时/.test(error.message))
  globalThis.fetch.mock.mockImplementation(async () => { throw new DOMException('cancel', 'AbortError') })
  await assert.rejects(request('/v1/missions'), { name: 'AbortError' })
})
