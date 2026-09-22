import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRunnerDescriptor } from '../../apps/worker/src/runner-config.ts'

const descriptors = [
  {
    adapter_id: 'codex-adapter',
    agent_id: 'codex',
    provider: 'openai',
    version: '1',
    capabilities: ['code.patch', 'test-harness:dag'],
    risk_ceiling: 'controlled',
    supports_session_resume: true,
    supports_worktree_isolation: true,
    execution_level: 'B',
  },
  {
    adapter_id: 'kimi-adapter',
    agent_id: 'kimi',
    provider: 'moonshot',
    version: '1',
    capabilities: ['code.review'],
    risk_ceiling: 'read-sensitive',
    supports_session_resume: false,
    supports_worktree_isolation: true,
    execution_level: 'B',
  },
]

const env = (overrides = {}) => ({
  RUNNER_ID: 'runner-local',
  RUNNER_TENANT: 'tenant-host',
  RUNNER_ALLOWED_TENANTS: 'tenant-a,tenant-b',
  RUNNER_ALLOWED_OWNERS: 'owner-a',
  RUNNER_ALLOWED_CAPABILITIES: 'code.patch,test-harness:dag',
  RUNNER_MAX_RISK: 'controlled',
  ...overrides,
})

test('buildRunnerDescriptor normalizes env and inventory without task fallbacks', () => {
  const runner = buildRunnerDescriptor(env({ CMAP_TENANT: 'wrong' }), descriptors, {
    hostname: 'host-a',
    now: '2026-09-22T01:02:03.000Z',
  })

  assert.deepEqual(runner, {
    runner_id: 'runner-local',
    tenant: 'tenant-host',
    host: 'host-a',
    agents: ['codex', 'kimi'],
    resources: [],
    admission: {
      allowed_tenants: ['tenant-a', 'tenant-b'],
      allowed_owners: ['owner-a'],
      allowed_capabilities: ['code.patch', 'test-harness:dag'],
      max_risk: 'controlled',
    },
    health: 'healthy',
    last_heartbeat_at: '2026-09-22T01:02:03.000Z',
  })
})

test('explicit empty allowlists are preserved as deny-all', () => {
  const runner = buildRunnerDescriptor(
    env({
      RUNNER_ALLOWED_TENANTS: '',
      RUNNER_ALLOWED_OWNERS: '',
      RUNNER_ALLOWED_CAPABILITIES: '',
    }),
    descriptors,
    { hostname: 'host-a', now: '2026-09-22T01:02:03.000Z' },
  )

  assert.deepEqual(runner.admission.allowed_tenants, [])
  assert.deepEqual(runner.admission.allowed_owners, [])
  assert.deepEqual(runner.admission.allowed_capabilities, [])
})

test('buildRunnerDescriptor clones descriptor and admission arrays', () => {
  const runner = buildRunnerDescriptor(env(), descriptors, {
    hostname: 'host-a',
    now: '2026-09-22T01:02:03.000Z',
  })

  assert.notEqual(runner.agents, descriptors)
  assert.notEqual(runner.admission.allowed_capabilities, descriptors[0].capabilities)
  assert.deepEqual([...runner.agents].sort(), ['codex', 'kimi'])
})

test('buildRunnerDescriptor rejects missing or invalid environment without leaking values', () => {
  const secretValue = 'tenant-secret'
  const invalid = [
    { RUNNER_ID: undefined },
    { RUNNER_ID: '' },
    { RUNNER_HOST: '' },
    { RUNNER_ALLOWED_TENANTS: undefined },
    { RUNNER_ALLOWED_TENANTS: `tenant-a,${secretValue},` },
    { RUNNER_ALLOWED_TENANTS: 'tenant-a,tenant-a' },
    { RUNNER_ALLOWED_TENANTS: '*' },
    { RUNNER_MAX_RISK: 'admin' },
  ]

  for (const override of invalid) {
    assert.throws(
      () => buildRunnerDescriptor(env(override), descriptors, { hostname: 'host-a' }),
      (error) => error instanceof Error &&
        /RUNNER_|runner descriptor/.test(error.message) &&
        !error.message.includes(secretValue),
    )
  }
})

test('buildRunnerDescriptor rejects duplicate or missing agent IDs', () => {
  assert.throws(
    () => buildRunnerDescriptor(env(), [{ ...descriptors[0], agent_id: '' }], { hostname: 'host-a' }),
    /agent_id/,
  )
  assert.throws(
    () => buildRunnerDescriptor(
      env(),
      [descriptors[0], { ...descriptors[1], agent_id: 'codex' }],
      { hostname: 'host-a' },
    ),
    /agent_id/,
  )
})

test('buildRunnerDescriptor rejects malformed agent IDs instead of normalizing inventory', () => {
  for (const agent_id of [' codex', 'codex ', 'co dex', '*', 'x'.repeat(257), 7]) {
    assert.throws(
      () => buildRunnerDescriptor(env(), [{ ...descriptors[0], agent_id }], { hostname: 'host-a' }),
      /agent_id/,
    )
  }
})

test('buildRunnerDescriptor rejects capability grants outside discovered descriptors', () => {
  assert.throws(
    () => buildRunnerDescriptor(
      env({ RUNNER_ALLOWED_CAPABILITIES: 'code.patch,secret.capability' }),
      descriptors,
      { hostname: 'host-a' },
    ),
    /RUNNER_ALLOWED_CAPABILITIES/,
  )
})
