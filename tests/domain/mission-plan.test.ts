import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeMissionPlan } from '../../packages/domain-model/src/mission-plan.ts'

const acceptance = [
  { criterion_id: 'a' },
  { criterion_id: 'b' },
  { criterion_id: 'c' },
] as const

const forkJoin = {
  schema: 'cmap/mission-plan/v1',
  nodes: [
    { node_id: 'A', goal: 'Collect A', capability: 'code.inspect', deps: [], criterion_ids: ['a'], risk_level: 'read-meta' },
    { node_id: 'B', goal: 'Collect B', capability: 'code.inspect', deps: [], criterion_ids: ['b'], risk_level: 'read-sensitive',
      required_resource_locks: [{ resource: 'worktree:/path', ttl_seconds: 60 }] },
    { node_id: 'Join', goal: 'Join evidence', capability: 'code.review', deps: ['A', 'B'], criterion_ids: ['c'], risk_level: 'read-sensitive' },
  ],
}

describe('mission plan normalization', () => {
  test('defaults concurrency and locks while preserving declared node order', () => {
    const normalized = normalizeMissionPlan(forkJoin, acceptance, 'read-sensitive')

    assert.equal(normalized.concurrency, 2)
    assert.deepEqual(normalized.nodes.map((node) => node.node_id), ['A', 'B', 'Join'])
    assert.deepEqual(normalized.nodes[0]?.required_resource_locks, [])
    assert.deepEqual(normalized.nodes[1]?.required_resource_locks, [{ resource: 'worktree:/path', ttl_seconds: 60 }])
  })

  test('rejects invalid plan semantics with RangeError', () => {
    const invalidPlans = [
      { ...forkJoin, nodes: [{ ...forkJoin.nodes[0], deps: ['Missing'] }] },
      { ...forkJoin, nodes: [{ ...forkJoin.nodes[0], deps: ['A'] }] },
      { ...forkJoin, nodes: [{ ...forkJoin.nodes[0], criterion_ids: ['a'] }, { ...forkJoin.nodes[1], criterion_ids: ['a'] }] },
      { ...forkJoin, nodes: [{ ...forkJoin.nodes[0], criterion_ids: ['a'] }] },
      { ...forkJoin, nodes: [{ ...forkJoin.nodes[0], risk_level: 'mutating' }] },
      { schema: 'cmap/mission-plan/v1', nodes: [
        { ...forkJoin.nodes[0], node_id: 'A', deps: ['C'] },
        { ...forkJoin.nodes[1], node_id: 'B', deps: [] },
        { ...forkJoin.nodes[2], node_id: 'C', deps: ['A'] },
      ] },
      { ...forkJoin, nodes: [{ ...forkJoin.nodes[1], required_resource_locks: [
        { resource: 'yonwork:tenant', ttl_seconds: 60 },
        { resource: 'yonwork:tenant', ttl_seconds: 90 },
      ] }] },
    ]

    for (const plan of invalidPlans) {
      assert.throws(() => normalizeMissionPlan(plan, acceptance, 'read-sensitive'), RangeError)
    }
  })
})
