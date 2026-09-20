import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import type { CheckableCriterion } from '../../packages/domain-model/src/criterion-check.ts'
import { recomputeCriterionPassed } from '../../packages/domain-model/src/criterion-check.ts'

const criterion = (operator: CheckableCriterion['operator'], expected: unknown): CheckableCriterion => ({
  operator,
  expected,
})

const passes = (
  operator: CheckableCriterion['operator'],
  expected: unknown,
  actual: unknown,
  agentPassed = true,
) => recomputeCriterionPassed(criterion(operator, expected), { actual, passed: agentPassed })

describe('criterion control-plane recompute', () => {
  test('numeric operators compare finite numbers and strict numeric strings only', () => {
    assert.equal(passes('lt', 3, 2), true)
    assert.equal(passes('lte', 3, '3'), true)
    assert.equal(passes('gt', 3, 4), true)
    assert.equal(passes('gte', 3, '4.5'), true)

    assert.equal(passes('eq', 3, 5), false)
    assert.equal(passes('lte', 3, ''), false)
    assert.equal(passes('lte', 3, '3ms'), false)
    assert.equal(passes('lte', 3, Number.NaN), false)
  })

  test('eq and neq compare by expected type and never let missing actual pass neq', () => {
    assert.equal(passes('eq', 3, '3'), true)
    assert.equal(passes('eq', true, 'true'), true)
    assert.equal(passes('eq', '3', 3), false)
    assert.equal(passes('neq', 3, 5), true)
    assert.equal(passes('neq', 3, ''), false)
    assert.equal(recomputeCriterionPassed(criterion('neq', 3), { passed: true }), false)
  })

  test('contains and not_contains support string substrings and array members', () => {
    assert.equal(passes('contains', 'ok', 'looks ok'), true)
    assert.equal(passes('contains', 'ok', ['fail', 'ok']), true)
    assert.equal(passes('contains', 'ok', ['fail']), false)
    assert.equal(passes('not_contains', 'ok', 'failed'), true)
    assert.equal(passes('not_contains', 'ok', ['fail']), true)
    assert.equal(passes('not_contains', 'ok', ['ok']), false)
  })

  test('object, array, and null expected values compare against strict JSON strings', () => {
    assert.equal(passes('eq', { ok: true, n: 1 }, '{"ok":true,"n":1}'), true)
    assert.equal(passes('neq', { ok: true }, '{"ok":true}'), false)
    assert.equal(passes('eq', [1, { ok: true }], '[1,{"ok":true}]'), true)
    assert.equal(passes('eq', null, 'null'), true)

    assert.equal(passes('neq', { ok: true }, '{bad json'), false)
    assert.equal(passes('neq', null, ''), false)
    assert.equal(recomputeCriterionPassed(criterion('neq', { ok: true }), { passed: true }), false)
  })

  test('array contains and not_contains use structural member equality', () => {
    const expected = { id: 'A', flags: ['x'] }
    assert.equal(passes('contains', expected, [{ id: 'A', flags: ['x'] }]), true)
    assert.equal(passes('contains', expected, '[{"id":"A","flags":["x"]}]'), true)
    assert.equal(passes('not_contains', expected, [{ id: 'A', flags: ['x'] }]), false)
    assert.equal(passes('not_contains', expected, [{ id: 'B', flags: ['x'] }]), true)
    assert.equal(passes('not_contains', expected, 'not json'), false)
  })

  test('Agent false remains false even when actual matches', () => {
    assert.equal(passes('eq', 3, 3, false), false)
  })
})
