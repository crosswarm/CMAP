import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { detectNoProgress } from '#domain-model'
import type { ProgressSnapshot } from '#domain-model'

/**
 * 无进展检测防的是返工无限循环。
 *
 * 关键设计：不靠自然语言判断「有没有进展」——那是模型的主观判断，
 * 不可复现也无法审计。改由确定性程序比对相邻两轮的四项客观事实。
 */

const snap = (o: Partial<ProgressSnapshot> = {}): ProgressSnapshot => ({
  patchHash: 'h1',
  failedCriteriaIds: ['PERF-P95'],
  metricValue: 1900,
  errorFingerprint: 'TIMEOUT',
  ...o,
})

describe('无进展检测', () => {
  test('四项全同判定为无进展', () => {
    const r = detectNoProgress(snap(), snap())
    assert.equal(r.detected, true)
    assert.equal(r.reasons.length, 4, '应列出全部四项判据')
  })

  test('指标提升达阈值即视为有进展，即便其余三项相同', () => {
    // 1900 → 1800 提升 5.26%，超过 2% 阈值
    const r = detectNoProgress(snap(), snap({ metricValue: 1800 }))
    assert.equal(r.detected, false, '指标在改善就不该判定无进展')
    assert.ok(!r.reasons.includes('metric_improvement_below_threshold'))
  })

  test('指标提升不足阈值不算进展', () => {
    // 1900 → 1890 仅提升 0.53%
    const r = detectNoProgress(snap(), snap({ metricValue: 1890 }))
    assert.equal(r.detected, true, '微小波动不构成进展')
    assert.ok(r.reasons.includes('metric_improvement_below_threshold'))
  })

  test('失败标准集合变化说明在推进', () => {
    const r = detectNoProgress(snap(), snap({ failedCriteriaIds: ['FUNC-ERROR'] }))
    assert.equal(r.detected, false, '卡点变了说明上一个已解决')
  })

  test('失败标准减少同样算推进', () => {
    const prev = snap({ failedCriteriaIds: ['PERF-P95', 'FUNC-ERROR'] })
    const curr = snap({ failedCriteriaIds: ['PERF-P95'] })
    assert.equal(detectNoProgress(prev, curr).detected, false)
  })

  test('patch 变化说明代码在动', () => {
    const r = detectNoProgress(snap(), snap({ patchHash: 'h2' }))
    assert.equal(r.detected, false)
    assert.ok(!r.reasons.includes('patch_hash_unchanged'))
  })

  test('错误指纹变化说明碰到了新问题', () => {
    const r = detectNoProgress(snap(), snap({ errorFingerprint: 'ASSERTION_FAILED' }))
    assert.equal(r.detected, false)
  })

  test('reasons 精确列出哪几项判定为无进展', () => {
    // patch 变了，其余三项未变
    const r = detectNoProgress(snap(), snap({ patchHash: 'h2' }))
    assert.ok(!r.reasons.includes('patch_hash_unchanged'), 'patch 变了不该列入')
    assert.ok(r.reasons.includes('failed_criteria_unchanged'))
    assert.ok(r.reasons.includes('same_error_fingerprint'))
  })

  test('缺少指标数据时不因此判定无进展', () => {
    const prev = snap({ metricValue: null })
    const curr = snap({ metricValue: null })
    const r = detectNoProgress(prev, curr)
    // 其余三项相同仍会判定，但不得把「无数据」当作「无提升」
    assert.ok(
      !r.reasons.includes('metric_improvement_below_threshold'),
      '无指标数据时不应给出指标未提升的判据——那是把缺失当成了证据',
    )
  })

  test('指标为 0 且未变化时仍算未提升', () => {
    // 除零保护不能让这类任务永远逃过检测：判定要求四项齐备，
    // 若指标判据被跳过，detected 永远为 false，只能靠轮次上限兜底。
    const prev = snap({ metricValue: 0 })
    const curr = snap({ metricValue: 0 })
    const r = detectNoProgress(prev, curr)
    assert.equal(r.detected, true, '0 → 0 没有任何改善，应判定无进展')
    assert.ok(r.reasons.includes('metric_improvement_below_threshold'))
  })

  test('指标从 0 变差同样算未提升', () => {
    const r = detectNoProgress(snap({ metricValue: 0 }), snap({ metricValue: 5 }))
    assert.ok(
      r.reasons.includes('metric_improvement_below_threshold'),
      '指标变差不能被算作进展',
    )
  })

  test('指标从 0 改善时算有进展', () => {
    // 例如错误数从 0 变成 -1 不合理，但指标可能是「剩余待修项」等可为负的量
    const r = detectNoProgress(snap({ metricValue: 0 }), snap({ metricValue: -3 }))
    assert.equal(r.detected, false, '指标在改善就不该判定无进展')
  })

  test('无前一轮时不判定无进展（首轮没有比较对象）', () => {
    const r = detectNoProgress(null, snap())
    assert.equal(r.detected, false)
    assert.deepEqual(r.reasons, [])
  })
})
