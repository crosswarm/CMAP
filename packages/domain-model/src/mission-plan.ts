import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import type { RiskLevel } from './entities.ts'
import type { MissionPlanV1 } from './generated/mission-plan.ts'

const RISKS: readonly RiskLevel[] = ['read-meta', 'read-sensitive', 'controlled', 'mutating']

type MissionPlanNode = MissionPlanV1['nodes'][number]

const readSchema = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../schemas/${name}.v1.schema.json`, import.meta.url), 'utf8'))
const ajv = new Ajv2020({ strict: true })
addFormats.default(ajv)
ajv.addSchema(readSchema('task-envelope'), 'https://cmap.local/schemas/task-envelope.v1.schema.json')
const validatePlan = ajv.compile<MissionPlanV1>(readSchema('mission-plan'))

const fail = (message: string): never => {
  throw new RangeError(message)
}

const unique = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length) fail(`${label} 不能重复`)
}

const riskIndex = (risk: RiskLevel, label: string): number => {
  const index = RISKS.indexOf(risk)
  if (index < 0) fail(`${label} 无效`)
  return index
}

const normalizeNode = (value: unknown, ceilingIndex: number): MissionPlanNode => {
  const node = value as MissionPlanNode
  unique(node.deps, `${node.node_id}.deps`)
  unique(node.criterion_ids, `${node.node_id}.criterion_ids`)

  const nodeRiskIndex = riskIndex(node.risk_level, `${node.node_id}.risk_level`)
  if (nodeRiskIndex > ceilingIndex) fail(`${node.node_id}.risk_level 超过 Mission 风险上限`)

  const required_resource_locks = node.required_resource_locks ?? []
  unique(required_resource_locks.map((lock) => lock.resource), `${node.node_id}.required_resource_locks.resource`)

  return {
    ...node,
    required_resource_locks,
  }
}

const validateGraph = (nodes: readonly MissionPlanNode[]): void => {
  const ids = nodes.map((node) => node.node_id)
  unique(ids, 'nodes.node_id')
  const allIds = new Set(ids)

  for (const node of nodes) {
    for (const dep of node.deps) {
      if (dep === node.node_id) fail(`${node.node_id}.deps 不能依赖自身`)
      if (!allIds.has(dep)) fail(`${node.node_id}.deps 引用不存在节点 ${dep}`)
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(nodes.map((node) => [node.node_id, node]))

  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) fail('deps 存在环')
    visiting.add(id)
    const node = byId.get(id) ?? fail(`节点不存在 ${id}`)
    for (const dep of node.deps) visit(dep)
    visiting.delete(id)
    visited.add(id)
  }

  for (const node of nodes) visit(node.node_id)
}

const validateCriterionCoverage = (
  nodes: readonly MissionPlanNode[],
  acceptance: readonly { criterion_id: string }[],
): void => {
  const accepted = acceptance.map((criterion) => criterion.criterion_id)
  unique(accepted, 'Mission acceptance criterion_id')

  const assigned = nodes.flatMap((node) => node.criterion_ids)
  unique(assigned, 'plan criterion_ids')

  const acceptedSet = new Set(accepted)
  for (const criterionId of assigned) {
    if (!acceptedSet.has(criterionId)) fail(`plan criterion_id 未在 Mission acceptance 中声明：${criterionId}`)
  }
  if (assigned.length !== accepted.length) fail('plan criterion_ids 必须精确覆盖 Mission acceptance')
}

export const normalizeMissionPlan = (
  input: unknown,
  acceptance: readonly { criterion_id: string }[],
  riskCeiling: RiskLevel,
): MissionPlanV1 => {
  if (!validatePlan(input)) fail('plan 不符合 mission-plan v1')
  const plan = input as MissionPlanV1

  const ceilingIndex = riskIndex(riskCeiling, 'riskCeiling')
  const nodes = plan.nodes.map((node) => normalizeNode(node, ceilingIndex))
  validateGraph(nodes)
  validateCriterionCoverage(nodes, acceptance)

  return {
    schema: 'cmap/mission-plan/v1',
    concurrency: plan.concurrency ?? 2,
    nodes: nodes as MissionPlanV1['nodes'],
  }
}
