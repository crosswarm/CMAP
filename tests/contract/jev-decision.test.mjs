import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const ajv = new Ajv({ strict: true, allErrors: true })
addFormats(ajv)
const validate = ajv.compile(JSON.parse(readFileSync(new URL('../../schemas/jev-decision.v1.schema.json', import.meta.url))))

const SHA = 'a'.repeat(64)
const approval = {
  schema: 'cmap/jev-decision/v1',
  decision_id: 'jvd_001',
  decision_type: 'approval',
  subject: { mission_id: 'mis_001', task_id: 'tsk_001', approval_id: 'apr_001', approval_scope: 'controlled' },
  policy_id: 'pol_20261021_a',
  policy_sha256: SHA,
  mode: 'enforce',
  input_sha256: SHA,
  model: 'jev-1.13.0',
  confidence: 0.95,
  declared_risk: 'controlled',
  assessed_risk: 'medium',
  effective_risk: 'medium',
  outcome: 'approve',
  route: 'auto',
  reason_code: 'within_policy',
  decided_at: '2026-10-21T00:00:00Z',
  elapsed_ms: 820,
}
const routing = {
  ...approval,
  decision_id: 'jvd_002',
  decision_type: 'routing',
  subject: { mission_id: 'mis_001', task_id: 'tsk_002' },
  declared_risk: 'read-meta',
  assessed_risk: 'low',
  effective_risk: 'low',
  outcome: 'assign',
  assigned_agent: 'codex@lap',
}

test('Jev 决定记录：风险只升不降，高风险与影子模式不得自动执行', () => {
  for (const ok of [
    approval,
    routing,
    { ...approval, assessed_risk: 'high', effective_risk: 'high', outcome: 'escalate', route: 'human', reason_code: 'assessed_high_risk' },
    { ...approval, mode: 'shadow', route: 'human', reason_code: 'shadow_mode' },
    { ...approval, model: null, confidence: null, assessed_risk: null, outcome: 'escalate', route: 'human', reason_code: 'jev_unavailable' },
  ]) assert.equal(validate(ok), true, JSON.stringify(validate.errors))

  const bad = {
    '高风险自动执行': { ...approval, assessed_risk: 'high', effective_risk: 'high' },
    'Jev 把风险调低': { ...approval, assessed_risk: 'high', effective_risk: 'medium', route: 'human' },
    '声明 mutating 却判低风险': { ...approval, declared_risk: 'mutating', assessed_risk: 'low', effective_risk: 'low', subject: { ...approval.subject, approval_scope: 'mutating' } },
    '影子模式自动执行': { ...approval, mode: 'shadow' },
    '升级却自动执行': { ...approval, outcome: 'escalate' },
    '审批缺 scope': { ...approval, subject: { mission_id: 'mis_001', task_id: 'tsk_001', approval_id: 'apr_001' } },
    '审批结果出现分配': { ...approval, outcome: 'assign' },
    '分配没写目标': { ...routing, assigned_agent: undefined },
    '分配目标是通配': { ...routing, assigned_agent: 'codex@*' },
    '自动执行却没有模型结果': { ...approval, model: null, confidence: null },
    '附带自由文本理由': { ...approval, reason: '看起来很安全' },
  }
  for (const [name, sample] of Object.entries(bad)) assert.equal(validate(JSON.parse(JSON.stringify(sample))), false, name)
})
