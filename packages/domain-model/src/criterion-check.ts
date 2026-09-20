export interface CheckableCriterion {
  readonly operator: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq' | 'contains' | 'not_contains'
  readonly expected: unknown
}

export interface CriterionResultLike {
  readonly actual?: unknown
  readonly passed: boolean
}

/**
 * 控制面复算 Agent 自报的硬指标：对象/数组/null 按 JSON 结构比较，
 * actual 可为对应的严格 JSON 字符串；contains/not_contains 只接受字符串
 * 子串或数组成员，不把缺失、空串、NaN、带单位文本当成有效数字。
 */
const INVALID = Symbol('invalid')

const strictNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

const boolValue = (v: unknown): boolean | null => {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return null
}

const parseJson = (v: string): unknown | typeof INVALID => {
  try {
    return JSON.parse(v)
  } catch {
    return INVALID
  }
}

const isJsonObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const jsonEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => jsonEqual(x, b[i]))
  }
  if (isJsonObject(a) || isJsonObject(b)) {
    if (!isJsonObject(a) || !isJsonObject(b)) return false
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
  }
  return false
}

const actualJsonValue = (expected: unknown, actual: unknown): unknown | typeof INVALID => {
  if (actual === undefined) return INVALID
  if (expected === null) {
    if (actual === null) return actual
    const parsed = typeof actual === 'string' ? parseJson(actual) : INVALID
    return parsed === null ? parsed : INVALID
  }
  if (Array.isArray(expected)) {
    if (Array.isArray(actual)) return actual
    const parsed = typeof actual === 'string' ? parseJson(actual) : INVALID
    return Array.isArray(parsed) ? parsed : INVALID
  }
  if (isJsonObject(expected)) {
    if (isJsonObject(actual)) return actual
    const parsed = typeof actual === 'string' ? parseJson(actual) : INVALID
    return isJsonObject(parsed) ? parsed : INVALID
  }
  return INVALID
}

const sameByExpectedType = (expected: unknown, actual: unknown): boolean | null => {
  if (actual === undefined) return null
  if (typeof expected === 'number') {
    const e = strictNumber(expected)
    const a = strictNumber(actual)
    return e === null || a === null ? null : a === e
  }
  if (typeof expected === 'boolean') {
    const a = boolValue(actual)
    return a === null ? null : a === expected
  }
  if (typeof expected === 'string') return typeof actual === 'string' ? actual === expected : null
  const a = actualJsonValue(expected, actual)
  return a === INVALID ? null : jsonEqual(expected, a)
}

export const recomputeCriterionPassed = (
  criterion: CheckableCriterion,
  result: CriterionResultLike | undefined,
): boolean => {
  if (result?.passed !== true) return false

  const { actual } = result
  const { operator, expected } = criterion
  switch (operator) {
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const a = strictNumber(actual)
      const e = strictNumber(expected)
      if (a === null || e === null) return false
      if (operator === 'lt') return a < e
      if (operator === 'lte') return a <= e
      if (operator === 'gt') return a > e
      return a >= e
    }
    case 'eq': {
      const same = sameByExpectedType(expected, actual)
      return same === true
    }
    case 'neq': {
      const same = sameByExpectedType(expected, actual)
      return same === false
    }
    case 'contains':
    case 'not_contains': {
      let has: boolean | null = null
      if (typeof actual === 'string' && typeof expected === 'string') {
        has = actual.includes(expected)
      } else if (Array.isArray(actual)) {
        has = actual.some((x) => jsonEqual(x, expected))
      } else if (typeof actual === 'string' && typeof expected !== 'string') {
        const parsed = parseJson(actual)
        if (Array.isArray(parsed)) has = parsed.some((x) => jsonEqual(x, expected))
      }
      if (has === null) return false
      return operator === 'contains' ? has : !has
    }
  }
}
