/**
 * 无进展检测。
 *
 * 防的是返工无限循环：每轮都"改了点什么"但实际卡在原地，而预算
 * 在持续消耗。
 *
 * 关键设计：**不靠自然语言判断**。让模型回答「有没有进展」得到的是
 * 主观判断，既不可复现也无法审计，且模型倾向于报告乐观结果。改由
 * 确定性程序比对相邻两轮的四项客观事实。
 */

/** 指标提升低于该比例视为没有实质改善。 */
const IMPROVEMENT_THRESHOLD = 0.02

export interface ProgressSnapshot {
  /** 代码改动的哈希。未变说明这一轮没动代码。 */
  readonly patchHash: string
  /** 未通过的验收标准 ID 集合。集合变化说明卡点在转移。 */
  readonly failedCriteriaIds: readonly string[]
  /** 主指标实测值。null 表示本轮无指标数据。 */
  readonly metricValue: number | null
  /** 错误指纹。相同说明碰到的是同一个问题。 */
  readonly errorFingerprint: string | null
}

export const NO_PROGRESS_REASONS = [
  'patch_hash_unchanged',
  'failed_criteria_unchanged',
  'metric_improvement_below_threshold',
  'same_error_fingerprint',
] as const

export type NoProgressReason = (typeof NO_PROGRESS_REASONS)[number]

export interface NoProgressResult {
  readonly detected: boolean
  /** 具体是哪几项判定为无进展，便于在返工报告中说明理由。 */
  readonly reasons: readonly NoProgressReason[]
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}

/**
 * 判定是否无进展。四项判据全部成立才算——任何一项显示在推进，
 * 就应当继续给机会。
 *
 * `prev` 为 null 表示这是首轮，没有比较对象，一律视为有进展。
 */
export const detectNoProgress = (
  prev: ProgressSnapshot | null,
  curr: ProgressSnapshot,
): NoProgressResult => {
  if (!prev) return { detected: false, reasons: [] }

  const reasons: NoProgressReason[] = []

  if (prev.patchHash === curr.patchHash) {
    reasons.push('patch_hash_unchanged')
  }

  if (sameSet(prev.failedCriteriaIds, curr.failedCriteriaIds)) {
    reasons.push('failed_criteria_unchanged')
  }

  // 缺少指标数据时不给出「未提升」的判据——把缺失当作证据是错的，
  // 那会让没有指标的任务被误判成无进展。
  //
  // 但基准为 0 不等于缺少数据：0 → 0 是真真切切的「没有改善」。
  // 早先用 `prev.metricValue !== 0` 做除零保护，副作用是这类任务永远
  // 缺一项判据，而判定要求四项齐备——于是它们永远逃过检测，只能靠
  // 轮次上限兜底。改为按绝对差值判断。
  if (prev.metricValue !== null && curr.metricValue !== null) {
    const base = Math.abs(prev.metricValue)
    const delta = prev.metricValue - curr.metricValue
    const improved = base === 0 ? delta > 0 : delta / base >= IMPROVEMENT_THRESHOLD

    if (!improved) reasons.push('metric_improvement_below_threshold')
  }

  if (
    prev.errorFingerprint !== null &&
    prev.errorFingerprint === curr.errorFingerprint
  ) {
    reasons.push('same_error_fingerprint')
  }

  // 四项判据齐备才判定无进展。少一项就说明某个维度在动。
  const detected = reasons.length === NO_PROGRESS_REASONS.length

  return { detected, reasons }
}
