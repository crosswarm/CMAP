import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { normalizeMissionPlan, type Mission } from '#domain-model'
import type { MissionCreateV1 } from '../../../packages/domain-model/src/generated/mission-create.ts'
import type { MissionCancelV1 } from '../../../packages/domain-model/src/generated/mission-cancel.ts'

const readSchema = (name: string) => JSON.parse(readFileSync(new URL(`../../../schemas/${name}.v1.schema.json`, import.meta.url), 'utf8'))
const ajv = new Ajv2020({ strict: true })
addFormats.default(ajv)
ajv.addSchema(readSchema('task-envelope'), 'https://cmap.local/schemas/task-envelope.v1.schema.json')
ajv.addSchema(readSchema('mission-plan'), 'https://cmap.local/schemas/mission-plan.v1.schema.json')
const validate = ajv.compile<MissionCreateV1>(readSchema('mission-create'))
export const validateMissionCancel = ajv.compile<MissionCancelV1>(readSchema('mission-cancel'))

export const missionFromRequest = (input: unknown, tenant: string, owner: string): Mission => {
  if (!validate(input) || new Set(input.acceptance.map((c) => c.criterion_id)).size !== input.acceptance.length) {
    throw new RangeError('请求不符合 mission-create v1，验收标准 ID 必须唯一')
  }
  const id = 'mis_' + createHash('sha256').update(JSON.stringify([tenant, owner, input.request_id])).digest('hex')
  // 续作只接在合成计划的单节点上；显式 DAG 没有单一首任务，继承归属不清。
  if (input.plan !== undefined && input.continues_mission_id !== undefined) throw new RangeError('continues_mission_id 不能与 plan 同时出现（仅不带 plan 的请求支持）')
  const memory = input.memory === undefined ? undefined : { ...input.memory, limit: input.memory.limit ?? 3 }
  // 不带 plan 时合成单节点计划，承载原 inspect/v1 首任务的目标、能力、全部验收与风险；节点带上 Mission 记忆以保留 query。
  const plan = normalizeMissionPlan(input.plan ?? {
    schema: 'cmap/mission-plan/v1',
    nodes: [{ node_id: 'main', goal: input.goal, capability: 'code.analyze', deps: [], criterion_ids: input.acceptance.map((c) => c.criterion_id), risk_level: input.risk_level, ...(memory ? { memory } : {}) }],
  }, input.acceptance, input.risk_level)
  const now = new Date().toISOString()
  return {
    id, tenant, owner, type: 'inspect', goal: input.goal,
    constraints: { risk_level: input.risk_level, max_additional_cycles: input.max_additional_cycles ?? 2, plan, ...(memory ? {memory} : {}), ...(input.continues_mission_id ? {continues_mission_id: input.continues_mission_id} : {}) },
    acceptance: input.acceptance.map((c) => ({ ...c, hard_gate: c.hard_gate ?? true })),
    workflow_template: 'dag/v1', state: 'DRAFT', revision: 1,
    created_at: now, updated_at: now,
  }
}

/** S01 之前不带 plan 的请求存为 inspect/v1（约束里没有 plan）；原键重试按这一形态比较，沿用旧记录及其模板。 */
export const legacyInspectForm = (mission: Mission): Mission => {
  const { plan: _plan, ...constraints } = mission.constraints
  return { ...mission, constraints, workflow_template: 'inspect/v1' }
}
