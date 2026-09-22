import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import type { Mission, MissionPlanV1, RunnerDescriptor, TaskRecord } from '#domain-model'
import type { TaskEnvelopeV1 } from '../../packages/domain-model/src/generated/task-envelope.ts'
import {
  RunnerAdmissionError,
  RUNNER_ADMISSION_CODES,
  admissionSubjectFromDagNode,
  admissionSubjectFromTask,
  assertRunnerAdmission,
  snapshotRunnerDescriptor,
} from '../../packages/domain-model/src/runner-admission.ts'

const now = '2026-09-22T00:00:00.000Z'

const mission = (overrides: Partial<Mission> = {}): Mission => ({
  id: 'mission-1',
  tenant: 'tenant-a',
  owner: 'owner-a',
  type: 'test',
  goal: 'prove admission',
  constraints: {},
  acceptance: [{ criterion_id: 'c1', metric: 'done', operator: 'eq', expected: true, hard_gate: true }],
  workflow_template: 'test',
  state: 'RUNNING',
  revision: 1,
  created_at: now,
  updated_at: now,
  ...overrides,
})

const envelope = (overrides: Partial<TaskEnvelopeV1> = {}): TaskEnvelopeV1 => ({
  schema: 'cmap/task-envelope/v1',
  identity: {
    mission_id: 'mission-1',
    task_id: 'task-1',
    idempotency_key: 'idem-1',
    revision: 1,
    tenant: 'tenant-a',
    owner: 'owner-a',
  },
  classification: {
    task_type: 'test',
    requested_capability: 'code.inspect',
    risk_level: 'read-sensitive',
  },
  goal: {
    statement: 'inspect',
    success_definition: [{ criterion_id: 'c1', metric: 'done', operator: 'eq', expected: true }],
  },
  environment: {},
  execution_policy: {
    timeout_seconds: 60,
    max_attempts: 1,
  },
  permissions: {
    forbidden: [],
  },
  evidence_requirements: {
    required_artifact_roles: ['report'],
  },
  output_contract: {
    schema_uri: 'https://cmap.local/schemas/task-result/v1',
  },
  ...overrides,
})

const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: 'task-1',
  mission_id: 'mission-1',
  parent_task_id: null,
  supersedes_task_id: null,
  capability: 'code.inspect',
  risk: 'read-sensitive',
  state: 'READY',
  attempt: 0,
  max_attempts: 1,
  lamport: 1,
  envelope: envelope(),
  result: null,
  binding: null,
  deps: [],
  created_at: now,
  updated_at: now,
  ...overrides,
})

const runner = (overrides: Partial<RunnerDescriptor> = {}): RunnerDescriptor => ({
  runner_id: 'runner-1',
  tenant: 'tenant-a',
  host: 'host-a',
  agents: ['agent-1'],
  resources: [],
  admission: {
    allowed_tenants: ['tenant-a'],
    allowed_owners: ['owner-a'],
    allowed_capabilities: ['code.inspect'],
    max_risk: 'controlled',
  },
  health: 'healthy',
  last_heartbeat_at: now,
  ...overrides,
})

const denyCode = (fn: () => unknown): RunnerAdmissionError['code'] => {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof RunnerAdmissionError)
    return error.code
  }
  assert.fail('expected RunnerAdmissionError')
}

describe('runner admission domain policy', () => {
  test('allows exact matching persisted Mission and Task subject', () => {
    const subject = admissionSubjectFromTask(mission(), task())
    assert.deepEqual(subject, {
      mission_id: 'mission-1',
      task_id: 'task-1',
      tenant: 'tenant-a',
      owner: 'owner-a',
      capability: 'code.inspect',
      risk: 'read-sensitive',
    })
    assert.equal(assertRunnerAdmission(runner(), subject), undefined)
  })

  test('denies every grant dimension exactly and treats empty allowlists as deny-all', () => {
    const subject = admissionSubjectFromTask(mission(), task())

    assert.equal(denyCode(() => assertRunnerAdmission(runner({ admission: { ...runner().admission, allowed_tenants: [] } }), subject)), 'TENANT_DENIED')
    assert.equal(denyCode(() => assertRunnerAdmission(runner({ admission: { ...runner().admission, allowed_owners: ['owner-b'] } }), subject)), 'OWNER_DENIED')
    assert.equal(denyCode(() => assertRunnerAdmission(runner({ admission: { ...runner().admission, allowed_capabilities: ['code.write'] } }), subject)), 'CAPABILITY_DENIED')
    assert.equal(denyCode(() => assertRunnerAdmission(runner({ admission: { ...runner().admission, max_risk: 'read-meta' } }), subject)), 'RISK_DENIED')
  })

  test('exports bounded durable denial codes', () => {
    assert.deepEqual(RUNNER_ADMISSION_CODES, [
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
      'PERMIT_INVALID',
    ])
  })

  test('rejects unhealthy runners, wildcard grants and wrong host affinity', () => {
    assert.equal(denyCode(() => assertRunnerAdmission(runner({ health: 'unavailable' }), admissionSubjectFromTask(mission(), task()))), 'RUNNER_UNHEALTHY')
    assert.equal(
      denyCode(() => assertRunnerAdmission(runner({ admission: { ...runner().admission, allowed_owners: ['*'] } }), admissionSubjectFromTask(mission(), task()))),
      'INVALID_RUNNER',
    )
    assert.equal(
      denyCode(() => assertRunnerAdmission(runner(), admissionSubjectFromTask(mission(), task({ envelope: envelope({ execution_policy: { timeout_seconds: 60, max_attempts: 1, affinity: { host: 'host-b' } } }) })))),
      'HOST_MISMATCH',
    )
  })

  test('rejects malformed runtime runner scopes using schema identifier rules', () => {
    const subject = admissionSubjectFromTask(mission(), task())
    const malformed = [
      runner({ runner_id: 'runner 1' }),
      runner({ tenant: 'tenant-*' }),
      runner({ host: 'host\ta' }),
      runner({ admission: { ...runner().admission, allowed_tenants: ['tenant-a', 'tenant-a'] } }),
      runner({ admission: { ...runner().admission, allowed_owners: ['owner a'] } }),
      runner({ admission: { ...runner().admission, allowed_capabilities: ['code.*'] } }),
      runner({ admission: { ...runner().admission, allowed_capabilities: ['x'.repeat(257)] } }),
    ]

    for (const badRunner of malformed) {
      assert.equal(denyCode(() => assertRunnerAdmission(badRunner, subject)), 'INVALID_RUNNER')
    }
  })

  test('rejects corrupted runtime subject risk instead of allowing negative risk rank', () => {
    const subject = {
      ...admissionSubjectFromTask(mission(), task()),
      risk: 'unknown-risk',
    } as unknown as Parameters<typeof assertRunnerAdmission>[1]

    assert.equal(denyCode(() => assertRunnerAdmission(runner(), subject)), 'RISK_DENIED')
  })

  test('requires persisted Task and envelope identities, capability and risk to agree with Mission facts', () => {
    const identityMismatches: TaskRecord[] = [
      task({ mission_id: 'other' }),
      task({ id: 'other' }),
      task({ envelope: envelope({ identity: { ...envelope().identity, mission_id: 'other' } }) }),
      task({ envelope: envelope({ identity: { ...envelope().identity, task_id: 'other' } }) }),
      task({ envelope: envelope({ identity: { ...envelope().identity, tenant: 'other' } }) }),
      task({ envelope: envelope({ identity: { ...envelope().identity, owner: 'other' } }) }),
    ]
    const classificationMismatches: TaskRecord[] = [
      task({ capability: 'code.review' }),
      task({ risk: 'controlled' }),
      task({ envelope: envelope({ classification: { ...envelope().classification, requested_capability: 'code.review' } }) }),
      task({ envelope: envelope({ classification: { ...envelope().classification, risk_level: 'controlled' } }) }),
    ]

    for (const badTask of identityMismatches) {
      assert.equal(denyCode(() => admissionSubjectFromTask(mission(), badTask)), 'IDENTITY_MISMATCH')
    }
    for (const badTask of classificationMismatches) {
      assert.equal(denyCode(() => admissionSubjectFromTask(mission(), badTask)), 'CLASSIFICATION_MISMATCH')
    }
  })

  test('builds DAG node subject from Mission and normalized node before artifacts exist', () => {
    const node: MissionPlanV1['nodes'][number] = {
      node_id: 'node-a',
      goal: 'inspect',
      capability: 'code.inspect',
      deps: [],
      criterion_ids: ['c1'],
      risk_level: 'controlled',
    }

    assert.deepEqual(admissionSubjectFromDagNode(mission(), node, 'task-node-a'), {
      mission_id: 'mission-1',
      task_id: 'task-node-a',
      tenant: 'tenant-a',
      owner: 'owner-a',
      capability: 'code.inspect',
      risk: 'controlled',
    })
  })

  test('snapshots trusted descriptor arrays so caller alias mutation cannot change admission', () => {
    const mutable = runner()
    const snapshot = snapshotRunnerDescriptor(mutable)
    const mutableAdmission = mutable.admission as unknown as { allowed_owners: string[] }
    mutableAdmission.allowed_owners = ['owner-b']

    assert.equal(assertRunnerAdmission(snapshot, admissionSubjectFromTask(mission(), task())), undefined)
    assert.ok(Object.isFrozen(snapshot))
    assert.ok(Object.isFrozen(snapshot.admission.allowed_owners))
  })
})
