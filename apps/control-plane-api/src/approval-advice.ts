import { execFile as execFileCb } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ApprovalAdviceV1 } from '#domain-model'

const execFile = promisify(execFileCb)

interface ExecError extends Error {
  readonly code?: number
  readonly stdout?: string | Buffer
}

export interface ApprovalAdviceRunnerOptions {
  readonly repoRoot: string
  readonly port: number
}

const generic = (): Error => new Error('approval advice unavailable')

const parseAdvice = (repoRoot: string, raw: string | Buffer | undefined, id: string): ApprovalAdviceV1 => {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(raw ?? ''))
  } catch {
    throw generic()
  }
  const schema = JSON.parse(readFileSync(join(repoRoot, 'schemas/approval-advice.v1.schema.json'), 'utf8')) as object
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema)
  if (!validate(parsed)) throw generic()
  const advice = parsed as ApprovalAdviceV1
  if (advice.request_id !== id || advice.can_continue !== false) throw generic()
  return advice
}

export const getApprovalAdviceFromJev = async (
  id: string,
  opts: ApprovalAdviceRunnerOptions,
): Promise<ApprovalAdviceV1> => {
  const args = [join(opts.repoRoot, 'scripts/jev-approval.mjs'), '--approval', id]
  try {
    const { stdout } = await execFile(process.execPath, args, {
      cwd: opts.repoRoot,
      timeout: 20_000,
      maxBuffer: 64 * 1024,
      env: { ...process.env, CMAP_API_PORT: String(opts.port) },
    })
    return parseAdvice(opts.repoRoot, stdout, id)
  } catch (error) {
    const e = error as ExecError
    if (e.code === 2) {
      const advice = parseAdvice(opts.repoRoot, e.stdout, id)
      if (advice.reason_code === 'unavailable') return advice
    }
    throw generic()
  }
}
