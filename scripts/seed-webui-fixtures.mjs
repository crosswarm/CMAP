/** 仅为独立浏览器验收库生成明确标注的合成场景，不运行 Agent，不代表业务验收通过。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { PgStore } from '#domain-model'

const schema = process.env.CMAP_DB_SCHEMA
const workRoot = process.env.CMAP_WORK_ROOT
assert.ok(schema?.startsWith('cmap_webui_'), '只能写入 cmap_webui_* 合成测试 schema')
assert.ok(workRoot && isAbsolute(workRoot), '必须指定独立绝对 CMAP_WORK_ROOT')
const store = new PgStore({ connectionString: process.env.CMAP_DATABASE_URL ?? 'postgres://temporal:temporal@localhost:5433/cmap', schema })
const prefix = `ui-${Date.now().toString(36)}`
const now = new Date().toISOString()
const actor = { type: 'system', id: 'synthetic-browser-fixture' }
const ajv = new Ajv({ strict: true, allErrors: true })
addFormats(ajv)
const validator = (name) => ajv.compile(JSON.parse(readFileSync(new URL(`../schemas/${name}.v1.schema.json`, import.meta.url))))
const validEnvelope = validator('task-envelope')
const validResult = validator('task-result')
const validReview = validator('review-decision')
const createTask = async (value) => { assert.ok(validEnvelope(value.envelope), JSON.stringify(validEnvelope.errors)); return store.createTask({ task: value, actor }) }
const putResult = async (id, value) => { assert.ok(validResult(value), JSON.stringify(validResult.errors)); return store.setTaskResult(id, value) }
const putReview = async (value) => { assert.ok(validReview(value.decision), JSON.stringify(validReview.errors)); return store.putReview(value) }
const acceptance = [{ criterion_id: 'FILE-COUNT', metric: 'sample_file_count', operator: 'eq', expected: 3, hard_gate: true }]
const mission = (name, state, goal) => ({
  id: `${prefix}-${name}`, tenant: 'team-ycc', owner: 'test-harness:webui', type: 'synthetic-ui-test',
  goal, constraints: { max_additional_cycles: 2 }, acceptance, workflow_template: 'inspect/v1',
  state, revision: 1, created_at: now, updated_at: now,
})
const task = (name, m, state, risk = 'read-meta') => ({
  id: `${prefix}-${name}`, mission_id: m.id, parent_task_id: null, supersedes_task_id: null,
  capability: 'synthetic.check', risk, state, attempt: 1, max_attempts: 1, lamport: 0,
  envelope: {
    schema: 'cmap/task-envelope/v1', identity: { mission_id: m.id, task_id: `${prefix}-${name}`, idempotency_key: `${prefix}-${name}`, revision: 1 },
    classification: { task_type: 'inspect', requested_capability: 'synthetic.check', risk_level: risk },
    goal: { statement: m.goal, success_definition: acceptance }, environment: {},
    execution_policy: { timeout_seconds: 60, max_attempts: 1 }, permissions: { forbidden: [] },
    evidence_requirements: { required_artifact_roles: ['report'] }, output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
  }, result: null, binding: null, deps: [], created_at: now, updated_at: now,
})
try {
  await store.migrate()
  const dual = mission('dual', 'AWAITING_APPROVAL', '双范围审批 · 合成浏览器验证')
  const evidence = mission('evidence', 'COMPLETED', '核对三个样本文件 · 合成浏览器验证')
  const waiting = mission('waiting', 'RUNNING', '等待测试资源 · 合成浏览器验证')
  const review = mission('review', 'ESCALATED', '返工后仍未达标 · 合成浏览器验证')
  for (const m of [dual, evidence, waiting, review]) await store.createMission({ mission: m, actor })
  const approvalIds = []
  for (const scope of ['controlled', 'mutating']) {
    const t = task(scope, dual, 'APPROVAL_REQUIRED', scope)
    await createTask(t)
    const id = `${prefix}-approval-${scope}`
    approvalIds.push(id)
    await store.createApproval({ id, mission_id: dual.id, task_id: t.id, action: `synthetic.${scope}`,
      scope, requested_by: 'synthetic-browser-fixture', risk_level: scope,
      reason: scope === 'controlled' ? '仅验证受控副作用授权的界面隔离，不发送真实消息。' : '仅验证代码变更授权的界面隔离，不修改业务源码。',
      evidence_artifact_ids: [], decision: 'pending', decided_by: null, decided_at: null,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_at: now })
  }
  const complete = task('complete', evidence, 'COMPLETED')
  await createTask(complete)
  const dir = join(workRoot, complete.id)
  await mkdir(join(dir, 'evidence'), { recursive: true })
  await mkdir(join(dir, 'sample'), { recursive: true })
  for (let i = 1; i <= 3; i++) await writeFile(join(dir, 'sample', `${i}.txt`), 'synthetic fixture\n')
  const bytes = Buffer.from(JSON.stringify({ source: 'synthetic-browser-fixture', sample_file_count: 3 }, null, 2))
  await writeFile(join(dir, 'evidence/report.json'), bytes)
  const art = { artifact_id: `${complete.id}:report`, mission_id: evidence.id, task_id: complete.id,
    role: 'report', uri: 'evidence/report.json', media_type: 'application/json', size_bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, state: 'AVAILABLE',
    producer: { agent_id: 'synthetic-fixture', adapter_version: 'test', execution_session_id: prefix },
    provenance: {}, retention: { retain_until: '2099-01-01T00:00:00Z', immutable: true },
    security: { classification: 'internal', contains_secrets: false, contains_pii: false, allowed_roles: [] }, created_at: now }
  await store.putArtifact(art)
  await putResult(complete.id, { schema: 'cmap/task-result/v1', mission_id: evidence.id, task_id: complete.id,
    attempt: 1, status: 'completed', summary: '合成界面样例，实际存在三个样本文件。',
    criterion_results: [{ criterion_id: 'FILE-COUNT', actual: '3', passed: true, evidence_artifact_ids: [art.artifact_id] }],
    artifacts: [{ artifact_id: art.artifact_id, role: art.role, uri: art.uri, size_bytes: art.size_bytes, sha256: art.sha256 }] })
  await putReview({ id: `${prefix}-accept`, mission_id: evidence.id, reviewed_task_ids: [complete.id], round: 1,
    decision: { schema: 'cmap/review-decision/v1', mission_id: evidence.id, reviewed_task_ids: [complete.id], decision: 'accept',
      hard_gate_summary: { total: 1, passed: 1, failed: 0 }, review_confidence: { level: 'high', score: 1 } }, created_at: now })
  const waitTask = task('wait', waiting, 'WAITING_RESOURCE')
  await createTask(waitTask)
  const first = task('round1', review, 'COMPLETED')
  const second = { ...task('round2', review, 'FAILED_TERMINAL'), supersedes_task_id: first.id, created_at: new Date(Date.now() + 1).toISOString() }
  for (const t of [first, second]) {
    await createTask(t)
    await putResult(t.id, { schema: 'cmap/task-result/v1', mission_id: review.id, task_id: t.id, attempt: 1,
      status: 'failed', summary: '合成失败样例', criterion_results: [{ criterion_id: 'FILE-COUNT', actual: t === first ? '1' : '2', passed: false }], artifacts: [] })
  }
  await putReview({ id: `${prefix}-escalate`, mission_id: review.id, reviewed_task_ids: [second.id], round: 2,
    decision: { schema: 'cmap/review-decision/v1', mission_id: review.id, reviewed_task_ids: [second.id], decision: 'escalate',
      hard_gate_summary: { total: 1, passed: 0, failed: 1 }, review_confidence: { level: 'high', score: 1 },
      failed_criteria: [{ criterion_id: 'FILE-COUNT', expected: '3', actual: '2', reason: '当前结果为 2，未达到期望 3。' }],
      escalation: { reason: '合成场景：返工预算已耗尽，需要人工介入。' } }, created_at: now })
  console.log(JSON.stringify({ prefix, missions: { dual: dual.id, evidence: evidence.id, waiting: waiting.id, review: review.id }, approvals: approvalIds }))
} finally { await store.close() }
