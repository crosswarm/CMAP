/** Jev（TypeSafe System One）客户端：jev-approval.mjs 与 ADR-0007 影子决定共用。只发请求、校验回答，不做任何授权判断。 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'

/** TYPESAFE_API_KEY 环境变量优先，其次 ~/.agents/tools/jev-ultrafast/.env；不复制密钥。 */
export function readJevApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  let file: Record<string, string | undefined> = {}
  try { file = parseEnv(readFileSync(join(homedir(), '.agents/tools/jev-ultrafast/.env'), 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取现有 Jev 配置') }
  return env['TYPESAFE_API_KEY'] ?? file['TYPESAFE_API_KEY']
}

/** 官方接口、jev-latest、15 秒超时、不跟随重定向。非 2xx 抛错，不回显响应正文。 */
export async function askJev(
  apiKey: string,
  body: { readonly state: unknown; readonly questions: Record<string, unknown> },
  request: typeof fetch = fetch,
): Promise<{ model?: unknown; answers?: Record<string, unknown>; usage?: Record<string, unknown> }> {
  const response = await request('https://api.typesafe.ai/v1/systemone', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ model: 'jev-latest', ...body }),
  })
  if (!response.ok) throw new Error('Jev request failed')
  return await response.json() as { model?: unknown; answers?: Record<string, unknown>; usage?: Record<string, unknown> }
}

/** 校验单选回答：choice 在选项内，置信度与各选项概率在 [0,1] 且概率和为 1。不合法返回 null。 */
export function parseChoice<T extends string>(answer: unknown, choices: readonly T[]): { choice: T; confidence: number; probabilities: Record<T, number> } | null {
  const a = answer as { type?: unknown; choice?: unknown; confidence?: unknown; probabilities?: Record<string, unknown> } | undefined
  const p = a?.probabilities
  if (a?.type !== 'choice' || !choices.includes(a.choice as T) ||
      typeof a.confidence !== 'number' || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1 ||
      !choices.every((c) => typeof p?.[c] === 'number' && Number.isFinite(p[c]) && p[c] >= 0 && p[c] <= 1) ||
      Math.abs(choices.reduce((sum, c) => sum + (p![c] as number), 0) - 1) > 0.01) return null
  return { choice: a.choice as T, confidence: a.confidence, probabilities: p as Record<T, number> }
}

export const validJevModel = (model: unknown): model is string => typeof model === 'string' && /^[\w.:-]{1,80}$/.test(model)
