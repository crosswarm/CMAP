import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const ajv = new Ajv({ strict: true, allErrors: true })
addFormats(ajv)
const validate = ajv.compile(JSON.parse(readFileSync(new URL('../../schemas/delegation-policy.v1.schema.json', import.meta.url))))

const policy = {
  schema: 'cmap/delegation-policy/v1',
  policy_id: 'pol_20261021_a',
  tenant: 'team-ycc',
  issued_by: 'user:crosswarm',
  issued_at: '2026-10-21T00:00:00Z',
  expires_at: '2026-11-21T00:00:00Z',
  mode: 'shadow',
  min_confidence: 0.9,
  daily_auto_budget: 20,
  rules: [
    { decision_type: 'approval', approval_scope: 'controlled', capabilities: ['yonwork.validate'], outcomes: ['approve', 'reject'] },
    { decision_type: 'approval', approval_scope: 'mutating', capabilities: ['code.implement'], outcomes: ['approve'], require_no_push: true },
    { decision_type: 'routing', capabilities: ['code.analyze', 'code.implement'] },
    { decision_type: 'retry_uncertain', capabilities: ['code.analyze'], max_declared_risk: 'read-sensitive' },
  ],
}

const withRule = (i, patch) => ({ ...policy, rules: policy.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
const withoutKey = (obj, key) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key))

test('委托策略：真人签发、有期限、逐 scope、只能收窄', () => {
  assert.equal(validate(policy), true, JSON.stringify(validate.errors))
  assert.equal(validate({ ...policy, mode: 'enforce', daily_auto_budget: 0 }), true)
  const bad = {
    '通配 capability': withRule(2, { capabilities: ['code.*'] }),
    '空 capability 列表': withRule(2, { capabilities: [] }),
    '审批缺 scope': { ...policy, rules: [withoutKey(policy.rules[0], 'approval_scope')] },
    '一条规则同时覆盖两个 scope': withRule(0, { approval_scope: ['controlled', 'mutating'] }),
    'mutating 未限定不推送': { ...policy, rules: [withoutKey(policy.rules[1], 'require_no_push')] },
    'mutating 允许推送': withRule(1, { require_no_push: false }),
    '审批结果出现分配': withRule(0, { outcomes: ['assign'] }),
    '有写副作用的任务允许 Jev 决定重做': withRule(3, { max_declared_risk: 'controlled' }),
    '置信度阈值过低': { ...policy, min_confidence: 0.5 },
    '缺有效期': withoutKey(policy, 'expires_at'),
    '签发人不是真人': { ...policy, issued_by: 'jev:jev-latest' },
    '没有任何规则': { ...policy, rules: [] },
    '多余字段': { ...policy, allow_all: true },
  }
  for (const [name, sample] of Object.entries(bad)) assert.equal(validate(sample), false, name)
})
