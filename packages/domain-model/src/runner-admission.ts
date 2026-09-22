import { RISK_LEVELS } from './entities.ts'
import type { Mission, RiskLevel, RunnerDescriptor, TaskRecord } from './entities.ts'
import type { MissionPlanV1 } from './generated/mission-plan.ts'

export const RUNNER_ADMISSION_CODES = [
  'INVALID_RUNNER',
  'RUNNER_UNHEALTHY',
  'TENANT_DENIED',
  'OWNER_DENIED',
  'CAPABILITY_DENIED',
  'RISK_DENIED',
  'HOST_MISMATCH',
  'IDENTITY_MISMATCH',
  'CLASSIFICATION_MISMATCH',
  'APPROVAL_INVALID',
] as const

export type RunnerAdmissionErrorCode = (typeof RUNNER_ADMISSION_CODES)[number]

export class RunnerAdmissionError extends Error {
  readonly code: RunnerAdmissionErrorCode

  constructor(code: RunnerAdmissionErrorCode, message = code) {
    super(message)
    this.name = 'RunnerAdmissionError'
    this.code = code
  }
}

export interface RunnerAdmissionSubject {
  readonly mission_id: string
  readonly task_id: string
  readonly tenant: string
  readonly owner: string
  readonly capability: string
  readonly risk: RiskLevel
  readonly affinity_host?: string
}

const fail = (code: RunnerAdmissionErrorCode): never => {
  throw new RunnerAdmissionError(code)
}

const isValidScope = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= 256 && !/[\s*]/u.test(value)

const assertScopes = (values: readonly string[]): void => {
  if (!Array.isArray(values) || values.length > 128 || new Set(values).size !== values.length || !values.every(isValidScope)) {
    fail('INVALID_RUNNER')
  }
}

const riskRank = (risk: unknown): number => (RISK_LEVELS as readonly unknown[]).indexOf(risk)

export const snapshotRunnerDescriptor = (runner: RunnerDescriptor): RunnerDescriptor => Object.freeze({
  ...runner,
  agents: Object.freeze([...runner.agents]),
  resources: Object.freeze([...runner.resources]),
  admission: Object.freeze({
    allowed_tenants: Object.freeze([...runner.admission.allowed_tenants]),
    allowed_owners: Object.freeze([...runner.admission.allowed_owners]),
    allowed_capabilities: Object.freeze([...runner.admission.allowed_capabilities]),
    max_risk: runner.admission.max_risk,
  }),
})

export const assertRunnerAdmission = (runner: RunnerDescriptor, subject: RunnerAdmissionSubject): void => {
  if (
    !isValidScope(runner.runner_id) ||
    !isValidScope(runner.tenant) ||
    !isValidScope(runner.host) ||
    riskRank(runner.admission.max_risk) < 0
  ) fail('INVALID_RUNNER')
  if (runner.health !== 'healthy') fail('RUNNER_UNHEALTHY')

  assertScopes(runner.admission.allowed_tenants)
  assertScopes(runner.admission.allowed_owners)
  assertScopes(runner.admission.allowed_capabilities)

  if (!runner.admission.allowed_tenants.includes(subject.tenant)) fail('TENANT_DENIED')
  if (!runner.admission.allowed_owners.includes(subject.owner)) fail('OWNER_DENIED')
  if (!runner.admission.allowed_capabilities.includes(subject.capability)) fail('CAPABILITY_DENIED')
  const subjectRiskRank = riskRank(subject.risk)
  if (subjectRiskRank < 0 || subjectRiskRank > riskRank(runner.admission.max_risk)) fail('RISK_DENIED')
  if (subject.affinity_host !== undefined && subject.affinity_host !== runner.host) fail('HOST_MISMATCH')
}

export const admissionSubjectFromTask = (mission: Mission, task: TaskRecord): RunnerAdmissionSubject => {
  const identity = task.envelope.identity
  const classification = task.envelope.classification

  if (
    task.mission_id !== mission.id ||
    task.id !== identity.task_id ||
    identity.mission_id !== mission.id ||
    identity.tenant !== mission.tenant ||
    identity.owner !== mission.owner
  ) fail('IDENTITY_MISMATCH')

  if (task.capability !== classification.requested_capability || task.risk !== classification.risk_level) {
    fail('CLASSIFICATION_MISMATCH')
  }

  const subject: RunnerAdmissionSubject = {
    mission_id: mission.id,
    task_id: task.id,
    tenant: mission.tenant,
    owner: mission.owner,
    capability: task.capability,
    risk: task.risk,
  }
  const affinityHost = task.envelope.execution_policy.affinity?.host
  return affinityHost === undefined ? subject : { ...subject, affinity_host: affinityHost }
}

export const admissionSubjectFromDagNode = (
  mission: Mission,
  node: MissionPlanV1['nodes'][number],
  taskId: string,
): RunnerAdmissionSubject => ({
  mission_id: mission.id,
  task_id: taskId,
  tenant: mission.tenant,
  owner: mission.owner,
  capability: node.capability,
  risk: node.risk_level,
})
