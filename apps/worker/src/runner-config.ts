import { hostname as osHostname } from 'node:os'
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { AdapterDescriptor } from '#adapter-sdk'
import type { RunnerDescriptor } from '#domain-model'
import type { RunnerAdmissionV1 } from '../../../packages/domain-model/src/generated/runner-admission.ts'

const schema = JSON.parse(
  readFileSync(new URL('../../../schemas/runner-admission.v1.schema.json', import.meta.url), 'utf8'),
)
const validateAdmission = new Ajv2020({ strict: true, allErrors: true }).compile<RunnerAdmissionV1>(schema)

const fail = (message: string): never => {
  throw new RangeError(message)
}

const hasEnv = (env: NodeJS.ProcessEnv, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(env, key) && env[key] !== undefined

const readRequired = (env: NodeJS.ProcessEnv, key: string): string => {
  if (!hasEnv(env, key)) fail(`${key} is required`)
  const value = env[key]!.trim()
  if (value === '') fail(`${key} must not be blank`)
  return value
}

const readList = (env: NodeJS.ProcessEnv, key: string): string[] => {
  if (!hasEnv(env, key)) fail(`${key} is required`)
  const raw = env[key]!
  if (raw === '') return []
  const values = raw.split(',').map((value) => value.trim())
  if (values.some((value) => value === '')) fail(`${key} must not contain blank members`)
  return values
}

const readHost = (env: NodeJS.ProcessEnv, fallback: string): string => {
  if (!hasEnv(env, 'RUNNER_HOST')) return fallback
  const host = env.RUNNER_HOST!.trim()
  if (host === '') fail('RUNNER_HOST must not be blank')
  return host
}

const assertKnownCapabilities = (
  allowed: readonly string[],
  descriptors: readonly AdapterDescriptor[],
): void => {
  const known = new Set(descriptors.flatMap((descriptor) => descriptor.capabilities))
  if (allowed.some((capability) => !known.has(capability))) {
    fail('RUNNER_ALLOWED_CAPABILITIES contains unregistered capabilities')
  }
}

const agentIds = (descriptors: readonly AdapterDescriptor[]): readonly string[] => {
  const ids = descriptors.map((descriptor) => descriptor.agent_id)
  if (ids.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 256 || /[\s*]/.test(id))) {
    fail('adapter descriptor agent_id is invalid')
  }
  if (new Set(ids).size !== ids.length) fail('adapter descriptor agent_id must be unique')
  return [...ids]
}

export const buildRunnerDescriptor = (
  env: NodeJS.ProcessEnv,
  descriptors: readonly AdapterDescriptor[],
  options: { hostname?: string; now?: string } = {},
): RunnerDescriptor => {
  const admission: RunnerAdmissionV1 = {
    schema: 'cmap/runner-admission/v1',
    runner_id: readRequired(env, 'RUNNER_ID'),
    runner_tenant: readRequired(env, 'RUNNER_TENANT'),
    host: readHost(env, options.hostname ?? osHostname()),
    allowed_tenants: readList(env, 'RUNNER_ALLOWED_TENANTS'),
    allowed_owners: readList(env, 'RUNNER_ALLOWED_OWNERS'),
    allowed_capabilities: readList(env, 'RUNNER_ALLOWED_CAPABILITIES'),
    max_risk: readRequired(env, 'RUNNER_MAX_RISK') as RunnerAdmissionV1['max_risk'],
  }

  if (!validateAdmission(admission)) {
    const fields = [...new Set(validateAdmission.errors?.map((error) => error.instancePath || error.schemaPath))]
      .join(', ')
    fail(`runner descriptor failed schema validation${fields ? `: ${fields}` : ''}`)
  }
  assertKnownCapabilities(admission.allowed_capabilities, descriptors)

  return {
    runner_id: admission.runner_id,
    tenant: admission.runner_tenant,
    host: admission.host,
    agents: agentIds(descriptors),
    resources: [],
    admission: {
      allowed_tenants: [...admission.allowed_tenants],
      allowed_owners: [...admission.allowed_owners],
      allowed_capabilities: [...admission.allowed_capabilities],
      max_risk: admission.max_risk,
    },
    health: 'healthy',
    last_heartbeat_at: options.now ?? new Date().toISOString(),
  }
}
