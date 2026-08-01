import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const here = dirname(fileURLToPath(import.meta.url))
const schemaDir = join(here, '../../schemas')

const load = (name) => JSON.parse(readFileSync(join(schemaDir, name), 'utf8'))

const envelopeSchema = load('task-envelope.v1.schema.json')
const resultSchema = load('task-result.v1.schema.json')
const reviewSchema = load('review-decision.v1.schema.json')

const ajv = new Ajv({ strict: true, allErrors: true })
addFormats(ajv)

const validateEnvelope = ajv.compile(envelopeSchema)
const validateResult = ajv.compile(resultSchema)
const validateReview = ajv.compile(reviewSchema)

/** 深拷贝后按路径改写，用于从合法样例派生非法样例 */
const mutate = (base, fn) => {
  const copy = structuredClone(base)
  fn(copy)
  return copy
}

const SHA40 = 'e35a48a1b2c3d4e5f60718293a4b5c6d7e8f9012'
const SHA256 = 'f8b0'.padEnd(64, '0')

// ---------------------------------------------------------------- 合法样例

const validEnvelope = {
  schema: 'cmap/task-envelope/v1',
  identity: {
    mission_id: 'mis_perf_001',
    task_id: 'tsk_verify_001',
    parent_task_id: null,
    supersedes_task_id: null,
    correlation_id: 'corr_001',
    idempotency_key: 'mis_perf_001:baseline:e35a48a',
    revision: 1,
    lamport: 42,
    tenant: 'team-ycc',
    owner: 'crosswarm',
  },
  classification: {
    task_type: 'performance.verify',
    requested_capability: 'yonwork.performance.first_screen.measure',
    risk_level: 'read-meta',
    priority: 70,
    confidentiality: 'internal',
  },
  goal: {
    statement: '在低端 Android 真机上验证冷启动首屏 P95 是否不高于 1800ms',
    success_definition: [
      { criterion_id: 'PERF-P95', metric: 'first_screen_p95_ms', operator: 'lte', expected: 1800, unit: 'ms', hard_gate: true },
    ],
  },
  inputs: {
    context: { repo: 'git@github.com:crosswarm/app.git', ref: SHA40, paths: ['docs/initiatives/fcp/proposal.md'] },
    artifact_refs: [{ artifact_id: 'art_proto_003', uri: 'artifact://mis_perf_001/protocol/v3', role: 'test_protocol', sha256: SHA256 }],
    parameters: { repetitions: 20 },
    context_summary: '上一轮要求补充低端设备冷启动样本',
  },
  environment: {
    application_version: '6.9.1-rc4',
    device_selector: { profile: 'android-low-end', preferred_device_id: 'device-android-low-03' },
    tenant: 'perf-test-01',
    account_ref: 'secretref://yonwork/perf-test-user',
    cache_mode: 'cold',
    locale: 'zh-CN',
  },
  execution_policy: {
    timeout_seconds: 1800,
    max_attempts: 2,
    heartbeat_seconds: 30,
    affinity: { host: 'test-1' },
    required_resource_locks: [{ resource: 'device:android-low-03', ttl_seconds: 1800 }],
    retry: { retryable_error_codes: ['DEVICE_TEMPORARILY_UNAVAILABLE'], initial_interval_seconds: 10, backoff_coefficient: 2, max_interval_seconds: 120 },
  },
  permissions: {
    repository: { read: true, write: false, deny_push: ['main', 'release/*'] },
    yonwork: { launch_app: true, capture_trace: true, query_monitor: true },
    forbidden: ['production_access', 'delete_non_test_data'],
  },
  evidence_requirements: {
    required_artifact_roles: ['raw_measurements', 'environment_manifest', 'trace_bundle'],
    minimum_trace_coverage_ratio: 0.95,
    artifact_retention_days: 180,
  },
  output_contract: {
    schema_uri: 'https://cmap.local/schemas/task-result/v1',
    final_statuses: ['completed', 'failed'],
  },
}

const validResult = {
  schema: 'cmap/task-result/v1',
  mission_id: 'mis_perf_001',
  task_id: 'tsk_verify_001',
  attempt: 1,
  status: 'completed',
  summary: '完成 20 次有效冷启动，首屏 P95 为 1762ms',
  confidence: { level: 'high', score: 0.94, limitations: ['仅覆盖 office-wifi'] },
  criterion_results: [
    { criterion_id: 'PERF-P95', expected: { operator: 'lte', value: 1800 }, actual: 1762, unit: 'ms', passed: true, evidence_artifact_ids: ['art_m_004'] },
  ],
  findings: [{ severity: 'medium', code: 'CONFIG_API_SERIAL', description: '配置接口与首页元数据接口串行', evidence_artifact_ids: ['art_trace_004'] }],
  artifacts: [{ artifact_id: 'art_m_004', role: 'raw_measurements', uri: 'artifact://mis_perf_001/verify/after.json', media_type: 'application/json', size_bytes: 2048, sha256: SHA256 }],
  session: { provider_session_id: 'sess_abc', worktree: '/workspaces/mis_perf_001/codex/tsk_verify_001', commit_sha: SHA40 },
  degradation: { level: 'A', reason: 'Codex + Computer Use 全能力可用' },
  cost: { tokens: 28452, duration_seconds: 412.5 },
}

const validReviewAccept = {
  schema: 'cmap/review-decision/v1',
  mission_id: 'mis_perf_001',
  review_round: 1,
  reviewed_task_ids: ['tsk_verify_001'],
  decision: 'accept',
  hard_gate_summary: { total: 2, passed: 2, failed: 0 },
  review_confidence: { level: 'high', score: 0.91 },
  reviewer: { actor_type: 'agent', actor_id: 'claude-reviewer', model: 'claude-opus-5' },
}

const validReviewRework = {
  schema: 'cmap/review-decision/v1',
  mission_id: 'mis_perf_001',
  review_round: 2,
  reviewed_task_ids: ['tsk_verify_002'],
  decision: 'rework',
  hard_gate_summary: { total: 4, passed: 3, failed: 1 },
  failed_criteria: [
    { criterion_id: 'PERF-P95', expected: '<= 1800 ms', actual: '1914 ms', reason: '低端设备 P95 未达标', evidence: ['art_m_006'] },
  ],
  evidence_gaps: [{ gap_code: 'TRACE_COVERAGE_LOW', description: '20 次样本中仅 16 次含完整 Trace', required_coverage: 0.95, actual_coverage: 0.8 }],
  required_followups: [
    { capability: 'codex.performance.root_cause', task_type: 'performance.analyze', inputs: { artifact_refs: ['art_trace_006'] }, focus: ['config-api-serialization'] },
  ],
  no_progress: { detected: false, consecutive_rounds: 0, patch_hash_unchanged: false, failed_criteria_unchanged: true, metric_improvement_ratio: 0.07, same_error_fingerprint: false },
  stop_conditions: { max_additional_cycles: 1 },
  review_confidence: { level: 'high', score: 0.91 },
}

// ---------------------------------------------------------------- 元校验

describe('Schema 自身合法性', () => {
  test('三个 Schema 都能在 strict 模式下编译', () => {
    // ajv.compile 在 strict 模式下会对无效关键字/类型冲突抛错，能编译即证明 Schema 本身合法
    assert.ok(validateEnvelope)
    assert.ok(validateResult)
    assert.ok(validateReview)
  })

  test('$id 稳定，供 output_contract 引用', () => {
    assert.equal(envelopeSchema.$id, 'https://cmap.local/schemas/task-envelope/v1')
    assert.equal(resultSchema.$id, 'https://cmap.local/schemas/task-result/v1')
    assert.equal(reviewSchema.$id, 'https://cmap.local/schemas/review-decision/v1')
    // 信封声明的输出契约必须指向真实存在的 result schema
    assert.equal(
      envelopeSchema.properties.output_contract.properties.schema_uri.const,
      resultSchema.$id,
    )
  })
})

// ---------------------------------------------------------------- 正样例

describe('合法样例通过校验', () => {
  test('Task Envelope', () => {
    assert.ok(validateEnvelope(validEnvelope), JSON.stringify(validateEnvelope.errors, null, 2))
  })
  test('Task Result', () => {
    assert.ok(validateResult(validResult), JSON.stringify(validateResult.errors, null, 2))
  })
  test('Review Decision — accept', () => {
    assert.ok(validateReview(validReviewAccept), JSON.stringify(validateReview.errors, null, 2))
  })
  test('Review Decision — rework', () => {
    assert.ok(validateReview(validReviewRework), JSON.stringify(validateReview.errors, null, 2))
  })
})

// ------------------------------------------------- 跨主机可复现性约束

describe('上下文寻址：跨主机可复现', () => {
  test('ref 为分支名时拒绝（必须钉死 40 位 commit SHA）', () => {
    const bad = mutate(validEnvelope, (e) => { e.inputs.context.ref = 'main' })
    assert.equal(validateEnvelope(bad), false)
  })

  test('ref 为短 SHA 时拒绝', () => {
    const bad = mutate(validEnvelope, (e) => { e.inputs.context.ref = 'e35a48a' })
    assert.equal(validateEnvelope(bad), false)
  })

  test('paths 含本机绝对路径时拒绝', () => {
    const bad = mutate(validEnvelope, (e) => { e.inputs.context.paths = ['/Users/cfone/Studio/app/x.md'] })
    assert.equal(validateEnvelope(bad), false)
  })

  test('paths 含 .. 逃逸时拒绝', () => {
    const bad = mutate(validEnvelope, (e) => { e.inputs.context.paths = ['../../etc/passwd'] })
    assert.equal(validateEnvelope(bad), false)
  })
})

// ------------------------------------------------------------ 凭据约束

describe('凭据不得内联', () => {
  test('account_ref 为明文时拒绝', () => {
    const bad = mutate(validEnvelope, (e) => { e.environment.account_ref = 'user:password123' })
    assert.equal(validateEnvelope(bad), false)
  })

  test('account_ref 为 secretref:// 引用时通过', () => {
    const ok = mutate(validEnvelope, (e) => { e.environment.account_ref = 'secretref://vault/key' })
    assert.ok(validateEnvelope(ok))
  })
})

// -------------------------------------------------------- 风险分级约束

describe('风险分级', () => {
  test('四级枚举之外的值被拒绝', () => {
    const bad = mutate(validEnvelope, (e) => { e.classification.risk_level = 'write' })
    assert.equal(validateEnvelope(bad), false)
  })

  test('controlled 与 mutating 都是合法取值且彼此独立', () => {
    for (const level of ['read-meta', 'read-sensitive', 'controlled', 'mutating']) {
      const ok = mutate(validEnvelope, (e) => { e.classification.risk_level = level })
      assert.ok(validateEnvelope(ok), `${level} 应为合法风险级别`)
    }
  })
})

// ---------------------------------------------------------- 资源锁约束

describe('资源锁必须带 TTL', () => {
  test('缺少 ttl_seconds 时拒绝（防 runner 崩溃后永久占住真机）', () => {
    const bad = mutate(validEnvelope, (e) => { e.execution_policy.required_resource_locks = [{ resource: 'device:x' }] })
    assert.equal(validateEnvelope(bad), false)
  })
})

// -------------------------------------------------------- 证据完整性约束

describe('证据完整性', () => {
  test('required_artifact_roles 为空数组时拒绝', () => {
    const bad = mutate(validEnvelope, (e) => { e.evidence_requirements.required_artifact_roles = [] })
    assert.equal(validateEnvelope(bad), false)
  })

  test('Result 的 artifact 缺 sha256 时拒绝（内容寻址防证据被覆盖）', () => {
    const bad = mutate(validResult, (r) => { delete r.artifacts[0].sha256 })
    assert.equal(validateResult(bad), false)
  })

  test('sha256 长度不足 64 时拒绝', () => {
    const bad = mutate(validResult, (r) => { r.artifacts[0].sha256 = 'abc123' })
    assert.equal(validateResult(bad), false)
  })

  test('sha256 含非 hex 字符时拒绝', () => {
    const bad = mutate(validResult, (r) => { r.artifacts[0].sha256 = 'z'.repeat(64) })
    assert.equal(validateResult(bad), false)
  })
})

// ------------------------------------------------ 返工契约的条件必填

describe('Review Decision 条件必填', () => {
  test('rework 缺 failed_criteria 时拒绝', () => {
    const bad = mutate(validReviewRework, (r) => { delete r.failed_criteria })
    assert.equal(validateReview(bad), false)
  })

  test('rework 缺 required_followups 时拒绝（否则控制面无法自动建后继 Task）', () => {
    const bad = mutate(validReviewRework, (r) => { delete r.required_followups })
    assert.equal(validateReview(bad), false)
  })

  test('rework 的 failed_criteria 为空数组时拒绝', () => {
    const bad = mutate(validReviewRework, (r) => { r.failed_criteria = [] })
    assert.equal(validateReview(bad), false)
  })

  test('rework 的 required_followups 为空数组时拒绝', () => {
    const bad = mutate(validReviewRework, (r) => { r.required_followups = [] })
    assert.equal(validateReview(bad), false)
  })

  test('escalate 缺 escalation 时拒绝', () => {
    const bad = mutate(validReviewAccept, (r) => { r.decision = 'escalate' })
    assert.equal(validateReview(bad), false)
  })

  test('escalate 带 escalation 时通过', () => {
    const ok = mutate(validReviewAccept, (r) => {
      r.decision = 'escalate'
      r.escalation = { reason: 'Codex 与 Kimi 结论冲突', blocking_question: '以哪份根因分析为准', options: [{ label: '采纳 Codex', tradeoff: '实现快但根因证据较弱' }] }
    })
    assert.ok(validateReview(ok), JSON.stringify(validateReview.errors, null, 2))
  })

  test('accept 不强制 failed_criteria', () => {
    assert.ok(validateReview(validReviewAccept))
  })
})

// ---------------------------------------------------- 未知字段一律拒绝

describe('additionalProperties: false 全面生效', () => {
  test('Envelope 顶层未知字段被拒绝', () => {
    const bad = mutate(validEnvelope, (e) => { e.unexpected_field = 1 })
    assert.equal(validateEnvelope(bad), false)
  })

  test('Envelope 嵌套层未知字段被拒绝', () => {
    const bad = mutate(validEnvelope, (e) => { e.identity.sneaky = 'x' })
    assert.equal(validateEnvelope(bad), false)
  })

  test('Result 顶层未知字段被拒绝', () => {
    const bad = mutate(validResult, (r) => { r.extra = true })
    assert.equal(validateResult(bad), false)
  })

  test('Review 顶层未知字段被拒绝', () => {
    const bad = mutate(validReviewAccept, (r) => { r.extra = true })
    assert.equal(validateReview(bad), false)
  })

  test('schema 常量写错时拒绝（防止跨版本混用）', () => {
    const bad = mutate(validEnvelope, (e) => { e.schema = 'cmap/task-envelope/v2' })
    assert.equal(validateEnvelope(bad), false)
  })
})

// ------------------------------------------------ SSE 终态与降级如实标注

describe('YonWork SSE 终态观测', () => {
  test('四个观测位都可独立记录（握手不等于完成）', () => {
    const ok = mutate(validResult, (r) => {
      r.sse_observations = { accepted: true, delta_observed: true, complete_observed: false, history_observed: false, run_id: 'run_1', request_id: 'req_1' }
    })
    assert.ok(validateResult(ok), JSON.stringify(validateResult.errors, null, 2))
  })

  test('降级等级限定在 A-D', () => {
    const bad = mutate(validResult, (r) => { r.degradation.level = 'S' })
    assert.equal(validateResult(bad), false)
  })
})
