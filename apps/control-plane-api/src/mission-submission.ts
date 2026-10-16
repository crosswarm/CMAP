import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { normalizeMissionPlan, type Mission } from '#domain-model'
import type { MissionCreateV1 } from '../../../packages/domain-model/src/generated/mission-create.ts'

const readSchema = (name: string) => JSON.parse(readFileSync(new URL(`../../../schemas/${name}.v1.schema.json`, import.meta.url), 'utf8'))
const ajv = new Ajv2020({ strict: true })
addFormats.default(ajv)
ajv.addSchema(readSchema('task-envelope'), 'https://cmap.local/schemas/task-envelope.v1.schema.json')
ajv.addSchema(readSchema('mission-plan'), 'https://cmap.local/schemas/mission-plan.v1.schema.json')
const validate = ajv.compile<MissionCreateV1>(readSchema('mission-create'))

export const missionFromRequest = (input: unknown, tenant: string, owner: string): Mission => {
  if (!validate(input) || new Set(input.acceptance.map((c) => c.criterion_id)).size !== input.acceptance.length) {
    throw new RangeError('请求不符合 mission-create v1，验收标准 ID 必须唯一')
  }
  const id = 'mis_' + createHash('sha256').update(JSON.stringify([tenant, owner, input.request_id])).digest('hex')
  // 记忆快照只接在 inspect/v1 首个任务上；DAG 节点各有输入，混用会让快照归属不清。
  if (input.plan !== undefined && input.memory !== undefined) throw new RangeError('memory 不能与 plan 同时出现（仅 inspect/v1 支持）')
  const plan = input.plan === undefined ? undefined : normalizeMissionPlan(input.plan, input.acceptance, input.risk_level)
  const memory = input.memory === undefined ? undefined : { ...input.memory, limit: input.memory.limit ?? 3 }
  const now = new Date().toISOString()
  return {
    id, tenant, owner, type: 'inspect', goal: input.goal,
    constraints: { risk_level: input.risk_level, max_additional_cycles: input.max_additional_cycles ?? 2, ...(plan ? {plan} : {}), ...(memory ? {memory} : {}) },
    acceptance: input.acceptance.map((c) => ({ ...c, hard_gate: c.hard_gate ?? true })),
    workflow_template: plan ? 'dag/v1' : 'inspect/v1', state: 'DRAFT', revision: 1,
    created_at: now, updated_at: now,
  }
}
