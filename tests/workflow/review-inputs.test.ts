import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { MemoryStore, RunnerAdmissionError } from '#domain-model'
import type { Artifact, EventActor, Mission, ReviewDecisionV1, Store, TaskEnvelopeV1, TaskRecord, TaskResultV1 } from '#domain-model'
import {
  prepareReviewInputs,
  resolveReviewInputs,
  reviewArtifactUri,
  verifyReviewInputs,
} from '../../workflows/review-inputs.ts'

const ACTOR: EventActor = { type: 'system', id: 'review-inputs-test' }
const T0 = '2026-09-22T00:00:00.000Z'
const SYNTHETIC_SECRET = ['AKIA', '1234567890ABCDEF'].join('')
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
type EnvelopeArtifactRef = NonNullable<NonNullable<TaskEnvelopeV1['inputs']>['artifact_refs']>[number]

const mission = (id = 'mis-review-inputs'): Mission => ({
  id,
  tenant: 'team-ycc',
  owner: 'crosswarm',
  type: 'inspect',
  goal: 'review inputs',
  constraints: {},
  acceptance: [{ criterion_id: 'C', metric: 'ok', operator: 'eq', expected: true, hard_gate: true }],
  workflow_template: 'inspect/v1',
  state: 'RUNNING',
  revision: 1,
  created_at: T0,
  updated_at: T0,
})

const envelope = (
  m: Mission,
  taskId: string,
  patch: Partial<TaskEnvelopeV1> = {},
): TaskEnvelopeV1 => ({
  schema: 'cmap/task-envelope/v1',
  identity: {
    mission_id: m.id,
    task_id: taskId,
    idempotency_key: `${m.id}:${taskId}`,
    revision: 1,
    tenant: m.tenant,
    owner: m.owner,
  },
  classification: { task_type: m.type, requested_capability: 'code.analyze', risk_level: 'read-meta' },
  goal: {
    statement: 'inspect',
    success_definition: [{ criterion_id: 'C', metric: 'ok', operator: 'eq', expected: true, hard_gate: true }],
  },
  environment: { tenant: m.tenant },
  execution_policy: { timeout_seconds: 30, max_attempts: 1 },
  permissions: { forbidden: [] },
  evidence_requirements: { required_artifact_roles: ['report'] },
  output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
  ...patch,
})

const task = (
  m: Mission,
  id: string,
  patch: Partial<TaskRecord> = {},
): TaskRecord => ({
  id,
  mission_id: m.id,
  parent_task_id: null,
  supersedes_task_id: null,
  capability: 'code.analyze',
  risk: 'read-meta',
  state: 'COMPLETED',
  attempt: 1,
  max_attempts: 1,
  lamport: 0,
  envelope: envelope(m, id),
  result: null,
  binding: null,
  deps: [],
  created_at: T0,
  updated_at: T0,
  ...patch,
})

const result = (
  m: Mission,
  taskId: string,
  artifactId: string,
  artifactSha: string,
  role = 'report',
  status: TaskResultV1['status'] = 'completed',
): TaskResultV1 => ({
  schema: 'cmap/task-result/v1',
  mission_id: m.id,
  task_id: taskId,
  attempt: 1,
  status,
  summary: 'done',
  criterion_results: [{ criterion_id: 'C', actual: true, passed: status === 'completed', evidence_artifact_ids: [artifactId] }],
  artifacts: [{ artifact_id: artifactId, role, uri: 'evidence/report.txt', sha256: artifactSha, size_bytes: 4 }],
})

const artifact = (
  m: Mission,
  taskId: string,
  artifactId: string,
  artifactSha: string,
  patch: Partial<Artifact> = {},
): Artifact => ({
  artifact_id: artifactId,
  mission_id: m.id,
  task_id: taskId,
  role: 'report',
  uri: 'evidence/report.txt',
  media_type: 'text/plain',
  size_bytes: 4,
  sha256: artifactSha,
  version: 1,
  state: 'AVAILABLE',
  producer: { agent_id: 'codex', adapter_version: 'test', execution_session_id: 'session' },
  provenance: {},
  retention: { retain_until: '2099-01-01T00:00:00.000Z', immutable: true },
  security: { classification: 'internal', contains_secrets: false, contains_pii: false, allowed_roles: [] },
  created_at: T0,
  ...patch,
})

const decision = (...refs: readonly string[][]): ReviewDecisionV1 => ({
  schema: 'cmap/review-decision/v1',
  mission_id: 'mis-review-inputs',
  reviewed_task_ids: ['source'],
  decision: 'rework',
  hard_gate_summary: { total: 1, passed: 0, failed: 1 },
  failed_criteria: [{ criterion_id: 'C', expected: 'true', actual: 'false', reason: 'bad' }],
  required_followups: refs.map((artifactRefs, i) => ({
    capability: 'code.analyze',
    task_type: 'inspect',
    inputs: artifactRefs.length ? { artifact_refs: [...artifactRefs] } : {},
    focus: [`child ${i}`],
  })),
  stop_conditions: { max_additional_cycles: 1 },
  review_confidence: { level: 'high' },
})

const inputInvalid = async (fn: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(fn, (error) => error instanceof RunnerAdmissionError && error.code === 'INPUT_INVALID')
}

const seed = async (patch: {
  missionPatch?: Partial<Mission>
  producerPatch?: Partial<TaskRecord>
  artifactPatch?: Partial<Artifact>
  resultStatus?: TaskResultV1['status']
  bytes?: string
} = {}) => {
  const store = new MemoryStore()
  const m = { ...mission(), ...patch.missionPatch }
  const bytes = patch.bytes ?? 'data'
  const digest = sha(bytes)
  await store.createMission({ mission: m, actor: ACTOR })
  const source = task(m, 'source')
  const producer = task(m, 'producer', {
    result: result(m, 'producer', 'art-1', digest, 'report', patch.resultStatus),
    ...patch.producerPatch,
  })
  await store.createTask({ task: source, actor: ACTOR })
  await store.createTask({ task: producer, actor: ACTOR })
  await store.putArtifact(artifact(m, 'producer', 'art-1', digest, patch.artifactPatch))
  return { store, m, source, producer, bytes, digest }
}

test('resolveReviewInputs freezes same-mission artifact metadata in followup order without reading files', async () => {
  const { store, source, digest } = await seed({ resultStatus: 'failed' })
  const matrix = await resolveReviewInputs(store, source, decision(['art-1'], []))

  assert.deepEqual(matrix, [
    [{ artifact_id: 'art-1', source_task_id: 'producer', role: 'report', sha256: digest, uri: reviewArtifactUri('art-1') }],
    [],
  ])
})

test('resolveReviewInputs rejects unavailable, restricted, role-limited, unassessed, foreign and uncollected metadata', async () => {
  for (const artifactPatch of [
    { state: 'REVOKED' as const },
    { security: { classification: 'restricted' as const, contains_secrets: false, contains_pii: false, allowed_roles: [] } },
    { security: { classification: 'internal' as const, contains_secrets: true, contains_pii: false, allowed_roles: [] } },
    { security: { classification: 'internal' as const, contains_secrets: false, contains_pii: true, allowed_roles: [] } },
    { security: { classification: 'internal' as const, contains_secrets: false, contains_pii: false, allowed_roles: ['engineer'] } },
    { provenance: { content_assessment: 'unassessed' } },
  ] satisfies Partial<Artifact>[]) {
    const { store, source } = await seed({ artifactPatch })
    await inputInvalid(() => resolveReviewInputs(store, source, decision(['art-1'])))
  }

  const foreign = await seed({ artifactPatch: { mission_id: 'other-mission' } })
  await inputInvalid(() => resolveReviewInputs(foreign.store, foreign.source, decision(['art-1'])))

  const noResult = await seed({ producerPatch: { result: null } })
  await inputInvalid(() => resolveReviewInputs(noResult.store, noResult.source, decision(['art-1'])))
})

test('resolveReviewInputs rejects unknown refs and mismatched task/result artifact proof', async () => {
  const unknown = await seed()
  await inputInvalid(() => resolveReviewInputs(unknown.store, unknown.source, decision(['missing-art'])))

  const mismatch = await seed({ artifactPatch: { role: 'trace' } })
  await inputInvalid(() => resolveReviewInputs(mismatch.store, mismatch.source, decision(['art-1'])))

  const duplicateResult = await seed()
  const producer = (await duplicateResult.store.getTask('producer'))!
  producer.result = {
    ...producer.result!,
    artifacts: [...producer.result!.artifacts, { ...producer.result!.artifacts[0]! }],
  }
  await duplicateResult.store.setTaskResult(producer.id, producer.result)
  await inputInvalid(() => resolveReviewInputs(duplicateResult.store, duplicateResult.source, decision(['art-1'])))

  const malformedSecurity = await seed({
    artifactPatch: { security: { classification: 'internal', contains_secrets: undefined, contains_pii: false, allowed_roles: [] } as unknown as Artifact['security'] },
  })
  await inputInvalid(() => resolveReviewInputs(malformedSecurity.store, malformedSecurity.source, decision(['art-1'])))
})

const childWithRef = async (
  store: Store,
  m: Mission,
  sourceTaskId: string,
  artifactId: string,
  digest: string,
  binding = false,
): Promise<TaskRecord> => {
  const ref = {
    artifact_id: artifactId,
    source_task_id: sourceTaskId,
    role: 'report',
    sha256: digest,
    uri: reviewArtifactUri(artifactId),
  }
  const child = task(m, 'child', {
    state: 'READY',
    envelope: envelope(m, 'child', { inputs: { artifact_refs: [ref] } }),
    binding: binding ? { adapter: 'codex-adapter', remote_task_id: 'remote', protocol: 'codex', protocol_version: '1', runner_id: 'runner' } : null,
  })
  await store.createTask({ task: child, actor: ACTOR })
  return child
}

const writeSourceBytes = async (workRoot: string, sourceTaskId: string, bytes: string): Promise<void> => {
  await mkdir(join(workRoot, sourceTaskId, 'evidence'), { recursive: true })
  await writeFile(join(workRoot, sourceTaskId, 'evidence/report.txt'), bytes)
}

test('opaque artifact IDs and roles are preserved through resolution, copy and verification', async t => {
  const artifactId = ' producer:trace/../bundle\\part '
  const role = ' trace/bundle '
  const { store, m, source, bytes, digest } = await seed({
    artifactPatch: { artifact_id: artifactId, role },
    producerPatch: { result: result(mission(), 'producer', artifactId, sha('data'), role) },
  })
  const matrix = await resolveReviewInputs(store, source, decision([artifactId]))
  assert.equal(matrix[0]![0]!.artifact_id, artifactId)
  assert.equal(matrix[0]![0]!.role, role)
  const child = await childWithRef(store, m, 'producer', artifactId, digest)
  const recipient = { ...child, envelope: { ...child.envelope, inputs: { artifact_refs: matrix[0]! } } }
  const workRoot = await mkdtemp(join(tmpdir(), 'cmap-review-opaque-'))
  t.after(() => rm(workRoot, { recursive: true, force: true }))
  await writeSourceBytes(workRoot, 'producer', bytes)
  await prepareReviewInputs(store, recipient, workRoot)
  await verifyReviewInputs(store, recipient, workRoot)
  assert.equal(await readFile(join(workRoot, child.id, reviewArtifactUri(artifactId)), 'utf8'), bytes)
})

test('prepareReviewInputs copies verified bytes idempotently and rejects target conflicts', async () => {
  const { store, m, bytes, digest } = await seed()
  const workRoot = await mkdtemp(join(tmpdir(), 'cmap-review-inputs-'))
  await writeSourceBytes(workRoot, 'producer', bytes)
  const child = await childWithRef(store, m, 'producer', 'art-1', digest)

  await prepareReviewInputs(store, child, workRoot)
  await prepareReviewInputs(store, child, workRoot)
  assert.equal(await readFile(join(workRoot, child.id, reviewArtifactUri('art-1')), 'utf8'), bytes)

  await writeFile(join(workRoot, child.id, reviewArtifactUri('art-1')), 'different')
  await inputInvalid(() => prepareReviewInputs(store, child, workRoot))
})

test('prepareReviewInputs rejects verified source bytes with known secret patterns despite legacy safe metadata', async (t) => {
  const { store, m, digest } = await seed({ bytes: SYNTHETIC_SECRET })
  const workRoot = await mkdtemp(join(tmpdir(), 'cmap-review-secret-'))
  t.after(() => rm(workRoot, { recursive: true, force: true }))
  await writeSourceBytes(workRoot, 'producer', SYNTHETIC_SECRET)
  const child = await childWithRef(store, m, 'producer', 'art-1', digest)

  await inputInvalid(() => prepareReviewInputs(store, child, workRoot))
  await assert.rejects(readFile(join(workRoot, child.id, reviewArtifactUri('art-1'))), /ENOENT/)
})

test('prepareReviewInputs leaves legacy refs and already-bound workspaces untouched', async () => {
  const { store, m, digest } = await seed()
  const legacy = task(m, 'legacy-child', {
    state: 'READY',
    envelope: envelope(m, 'legacy-child', { inputs: { artifact_refs: [{ artifact_id: 'art-1', role: 'report', sha256: digest, uri: 'inputs/legacy/payload' }] } }),
  })
  await store.createTask({ task: legacy, actor: ACTOR })
  await prepareReviewInputs(store, legacy)

  const boundRoot = await mkdtemp(join(tmpdir(), 'cmap-review-bound-'))
  await writeSourceBytes(boundRoot, 'producer', 'data')
  const bound = await childWithRef(store, m, 'producer', 'art-1', digest, true)
  const target = join(boundRoot, bound.id, reviewArtifactUri('art-1'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, 'owned')
  await prepareReviewInputs(store, bound, boundRoot)
  assert.equal(await readFile(target, 'utf8'), 'owned')
})

test('prepareReviewInputs rejects malformed present source_task_id refs but leaves truly legacy refs', async () => {
  const { store, m, digest } = await seed()
  for (const malformed of [undefined, null, 7, '', ' ', '../producer']) {
    const child = task(m, `bad-${String(malformed)}`, {
      state: 'READY',
      envelope: envelope(m, `bad-${String(malformed)}`, {
        inputs: {
          artifact_refs: [{ artifact_id: 'art-1', source_task_id: malformed, role: 'report', sha256: digest, uri: reviewArtifactUri('art-1') } as unknown as EnvelopeArtifactRef],
        },
      }),
    })
    await store.createTask({ task: child, actor: ACTOR })
    const workRoot = await mkdtemp(join(tmpdir(), 'cmap-review-bad-ref-'))
    await inputInvalid(() => prepareReviewInputs(store, child, workRoot))
  }

  const badSha = task(m, 'bad-sha', {
    state: 'READY',
    envelope: envelope(m, 'bad-sha', {
      inputs: { artifact_refs: [{ artifact_id: 'art-1', source_task_id: 'producer', role: 'report', sha256: 'ABC', uri: reviewArtifactUri('art-1') }] },
    }),
  })
  await store.createTask({ task: badSha, actor: ACTOR })
  const badShaRoot = await mkdtemp(join(tmpdir(), 'cmap-review-bad-sha-'))
  await inputInvalid(() => prepareReviewInputs(store, badSha, badShaRoot))

  const legacy = task(m, 'legacy-absent', {
    state: 'READY',
    envelope: envelope(m, 'legacy-absent', { inputs: { artifact_refs: [{ artifact_id: 'art-1', role: 'report', sha256: digest, uri: 'inputs/legacy/payload' }] } }),
  })
  await store.createTask({ task: legacy, actor: ACTOR })
  await prepareReviewInputs(store, legacy)
})

test('prepareReviewInputs rejects source traversal, source symlink, missing workRoot and hash tamper', async () => {
  const noRoot = await seed()
  const noRootChild = await childWithRef(noRoot.store, noRoot.m, 'producer', 'art-1', noRoot.digest)
  await inputInvalid(() => prepareReviewInputs(noRoot.store, noRootChild))

  const tamper = await seed()
  const tamperRoot = await mkdtemp(join(tmpdir(), 'cmap-review-tamper-'))
  await writeSourceBytes(tamperRoot, 'producer', 'changed')
  const tamperChild = await childWithRef(tamper.store, tamper.m, 'producer', 'art-1', tamper.digest)
  await inputInvalid(() => prepareReviewInputs(tamper.store, tamperChild, tamperRoot))

  const link = await seed()
  const linkRoot = await mkdtemp(join(tmpdir(), 'cmap-review-link-'))
  const outside = await mkdtemp(join(tmpdir(), 'cmap-review-outside-'))
  await writeSourceBytes(outside, 'producer', 'data')
  await symlink(join(outside, 'producer'), join(linkRoot, 'producer'))
  const linkChild = await childWithRef(link.store, link.m, 'producer', 'art-1', link.digest)
  await inputInvalid(() => prepareReviewInputs(link.store, linkChild, linkRoot))
})

test('verifyReviewInputs is readonly and rechecks target hash plus current registry metadata', async () => {
  const { store, m, bytes, digest } = await seed()
  const workRoot = await mkdtemp(join(tmpdir(), 'cmap-review-verify-'))
  await writeSourceBytes(workRoot, 'producer', bytes)
  const child = await childWithRef(store, m, 'producer', 'art-1', digest)
  await prepareReviewInputs(store, child, workRoot)
  await verifyReviewInputs(store, child, workRoot)

  await rename(join(workRoot, child.id), join(workRoot, `${child.id}.moved`))
  await inputInvalid(() => verifyReviewInputs(store, child, workRoot))
  await assert.rejects(lstat(join(workRoot, child.id)))
})

test('verifyReviewInputs rejects same-hash payload behind a swapped intermediate symlink', async () => {
  const { store, m, bytes, digest } = await seed()
  const workRoot = await mkdtemp(join(tmpdir(), 'cmap-review-link-target-'))
  await writeSourceBytes(workRoot, 'producer', bytes)
  const child = await childWithRef(store, m, 'producer', 'art-1', digest)
  await prepareReviewInputs(store, child, workRoot)

  const outside = await mkdtemp(join(tmpdir(), 'cmap-review-link-outside-'))
  await mkdir(join(outside, 'review', createHash('sha256').update('art-1').digest('hex')), { recursive: true })
  await writeFile(join(outside, 'review', createHash('sha256').update('art-1').digest('hex'), 'payload'), bytes)
  await rm(join(workRoot, child.id, 'inputs', 'review'), { recursive: true })
  await symlink(join(outside, 'review'), join(workRoot, child.id, 'inputs', 'review'))

  await inputInvalid(() => verifyReviewInputs(store, child, workRoot))
})

test('prepareReviewInputs validates receiver scope and snapshots task refs before awaits', async () => {
  const { store, m, bytes, digest } = await seed()
  const workRoot = await mkdtemp(join(tmpdir(), 'cmap-review-snapshot-'))
  await writeSourceBytes(workRoot, 'producer', bytes)

  const ownerMismatch = await childWithRef(store, m, 'producer', 'art-1', digest)
  const badScope = { ...ownerMismatch, id: 'owner-mismatch', envelope: { ...ownerMismatch.envelope, identity: { ...ownerMismatch.envelope.identity, task_id: 'owner-mismatch', owner: 'other-owner' } } }
  await store.createTask({ task: badScope, actor: ACTOR })
  await inputInvalid(() => prepareReviewInputs(store, badScope, workRoot))

  class SlowMissionStore extends MemoryStore {
    override async getMission(id: string): ReturnType<MemoryStore['getMission']> {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return super.getMission(id)
    }
  }
  const slow = new SlowMissionStore()
  await slow.createMission({ mission: m, actor: ACTOR })
  await slow.createTask({ task: task(m, 'source'), actor: ACTOR })
  await slow.createTask({ task: task(m, 'producer', { result: result(m, 'producer', 'art-1', digest) }), actor: ACTOR })
  await slow.putArtifact(artifact(m, 'producer', 'art-1', digest))
  const child = await childWithRef(slow, m, 'producer', 'art-1', digest)
  const started = prepareReviewInputs(slow, child, workRoot)
  ;(child.envelope.inputs!.artifact_refs![0] as { source_task_id: string }).source_task_id = '../changed'
  await started
  assert.equal(await readFile(join(workRoot, child.id, reviewArtifactUri('art-1')), 'utf8'), bytes)
})
