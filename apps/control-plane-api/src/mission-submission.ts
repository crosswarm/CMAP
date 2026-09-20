import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { Mission } from '#domain-model'
import type { MissionCreateV1 } from '../../../packages/domain-model/src/generated/mission-create.ts'

const readSchema = (name: string) => JSON.parse(readFileSync(new URL(`../../../schemas/${name}.v1.schema.json`, import.meta.url), 'utf8'))
const ajv = new Ajv2020({ strict: true })
addFormats.default(ajv)
ajv.addSchema(readSchema('task-envelope'), 'https://cmap.local/schemas/task-envelope.v1.schema.json')
const validate = ajv.compile<MissionCreateV1>(readSchema('mission-create'))

export const missionFromRequest = (input: unknown, tenant: string, owner: string): Mission => {
  if (!validate(input) || new Set(input.acceptance.map((c) => c.criterion_id)).size !== input.acceptance.length) {
    throw new RangeError('请求不符合 mission-create v1，验收标准 ID 必须唯一')
  }
  const id = 'mis_' + createHash('sha256').update(JSON.stringify([tenant, owner, input.request_id])).digest('hex')
  const now = new Date().toISOString()
  return {
    id, tenant, owner, type: 'inspect', goal: input.goal,
    constraints: { risk_level: input.risk_level, max_additional_cycles: input.max_additional_cycles ?? 2 },
    acceptance: input.acceptance.map((c) => ({ ...c, hard_gate: c.hard_gate ?? true })),
    workflow_template: 'inspect/v1', state: 'DRAFT', revision: 1,
    created_at: now, updated_at: now,
  }
}
