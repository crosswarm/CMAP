import { test } from 'node:test'
// precommit-allow-secrets: 仅含合成密钥样式，用于验证审批摘要在外发前拒绝敏感值。
import assert from 'node:assert/strict'
import { adviseApproval, pendingApprovalContext } from '../../scripts/jev-approval.mjs'
import { MemoryStore } from '#domain-model'
import { createControlPlane } from '../../apps/control-plane-api/src/server.ts'

const context = {
  surface: 'codex_tool', request_id: 'synthetic-test', action_summary: 'Run local tests for the requested change',
  risk: 'mutating', environment: 'local', reversible: true,
  authorization_verified: true, authorization_scope: 'mutating', requires_human: false,
}
const response = (choice = 'continue', confidence = 0.99) => new Response(JSON.stringify({
  model: 'jev-test', answers: { disposition: { type: 'choice', choice, confidence,
    probabilities: { continue: choice === 'continue' ? 1 : 0, review: choice === 'review' ? 1 : 0,
      reject: choice === 'reject' ? 1 : 0, insufficient: choice === 'insufficient' ? 1 : 0 } } },
  usage: { input_tokens: 20, output_tokens: 4 },
}))
const options = { apiKey: 'synthetic', fetch: async () => response() }

test('已核验授权内的可逆本地工具操作经 Jev 判断可继续', async () => {
  const result = await adviseApproval(context, options)
  assert.equal(result.can_continue, true)
  assert.equal(result.reason_code, 'within_existing_authorization')
  assert.equal(result.model, 'jev-test')
  assert.match(result.input_sha256, /^[a-f0-9]{64}$/)
  assert.equal('action_summary' in result, false)
})

test('模型不能覆盖真人、scope、生产及不可逆边界，CMAP pending 不能变成批准', async () => {
  for (const [patch, reason] of [
    [{ requires_human: true, surface: 'cmap_approval' }, 'human_required'],
    [{ requires_human: false, surface: 'cmap_approval' }, 'human_required'],
    [{ authorization_verified: false }, 'authorization_missing'],
    [{ authorization_scope: 'controlled' }, 'scope_mismatch'],
    [{ environment: 'production' }, 'production_or_irreversible'],
    [{ reversible: false }, 'production_or_irreversible'],
  ]) {
    const input = { ...context, ...patch }
    const before = structuredClone(input)
    const advice = await adviseApproval(input, options)
    assert.equal(advice.can_continue, false)
    assert.equal(advice.reason_code, reason)
    assert.deepEqual(input, before)
  }
})

test('CMAP 真实 HTTP 待审批接入 Jev 后仍 pending，隔离跨租户且只发送最小元数据', async () => {
  const store = new MemoryStore()
  const actor = { type: 'system', id: 'test' }
  const now = new Date().toISOString()
  await store.createMission({ actor, mission: {
    id: 'm1', tenant: 'local', owner: 'test', type: 'inspect', goal: 'synthetic',
    constraints: {}, acceptance: [], workflow_template: 'inspect/v1', state: 'DRAFT',
    revision: 1, created_at: now, updated_at: now,
  } })
  const approval = {
    id: 'a1', mission_id: 'm1', task_id: 'synthetic-task', action: 'code.commit',
    scope: 'mutating', requested_by: 'test', risk_level: 'mutating',
    reason: 'synthetic private business reason', evidence_artifact_ids: ['private-evidence'],
    decision: 'pending', decided_by: null, decided_at: null,
    expires_at: '2099-01-01T00:00:00Z', created_at: now,
  }
  await store.createApproval(approval)
  const server = await createControlPlane({ store, tenant: 'local' })
  const other = await createControlPlane({ store, tenant: 'other' })
  await server.listen(0)
  await other.listen(0)
  try {
    const input = await pendingApprovalContext('a1', `http://127.0.0.1:${server.address().port}`)
    assert.equal(input.requires_human, true)
    assert.equal(input.authorization_verified, false)
    assert.equal(JSON.stringify(input).includes('private'), false)
    assert.equal((await adviseApproval(input, options)).can_continue, false)
    assert.deepEqual(await store.getApproval('a1'), approval)
    await assert.rejects(pendingApprovalContext('a1', `http://127.0.0.1:${other.address().port}`))
    await assert.rejects(pendingApprovalContext('a1', 'https://example.com'))
  } finally {
    await server.close()
    await other.close()
  }
})

test('Jev 拒绝、低置信度、未知响应、网络失败和缺 key 都不能自动继续', async () => {
  for (const fetch of [
    async () => response('reject'), async () => response('review'),
    async () => response('continue', 0.5), async () => response('invented'),
    async () => new Response('not-json'), async () => { throw new Error('synthetic network failure') },
  ]) assert.equal((await adviseApproval(context, { ...options, fetch })).can_continue, false)
  assert.equal((await adviseApproval(context, { apiKey: '' })).reason_code, 'unavailable')
})

test('输入契约拒绝无授权字段和额外原始命令；敏感值不发给 Jev', async () => {
  let calls = 0
  const opts = { ...options, fetch: async () => { calls++; return response() } }
  await assert.rejects(adviseApproval({ ...context, authorization_verified: undefined }, opts))
  await assert.rejects(adviseApproval({ ...context, command: 'raw command' }, opts))
  await assert.rejects(adviseApproval({ ...context, action_summary: 'Authorization: Bearer synthetic-private-value' }, opts))
  await assert.rejects(adviseApproval({ ...context, action_summary: 'Use sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD' }, opts))
  await assert.rejects(adviseApproval({ ...context, action_summary: 'example localhost: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD' }, opts))
  assert.equal(calls, 0)
})
