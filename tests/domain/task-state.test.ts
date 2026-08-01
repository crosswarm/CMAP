import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  TASK_STATES,
  ALLOWED_TRANSITIONS,
  A2A_MAPPING,
  TERMINAL_STATES,
  WAITING_STATES,
  canTransition,
  assertTransition,
  isTerminal,
  isWaiting,
  IllegalTransitionError,
  needsApproval,
  RISK_LEVELS,
} from '#domain-model'
import type { TaskState, RiskLevel } from '#domain-model'

describe('状态机结构完整性', () => {
  test('每个状态都有迁移表条目', () => {
    for (const s of TASK_STATES) {
      assert.ok(Array.isArray(ALLOWED_TRANSITIONS[s]), `${s} 缺少迁移表条目`)
    }
  })

  test('迁移目标都是合法状态（防拼写错误）', () => {
    for (const from of TASK_STATES) {
      for (const to of ALLOWED_TRANSITIONS[from]) {
        assert.ok(TASK_STATES.includes(to), `${from} → ${to}：${to} 不是合法状态`)
      }
    }
  })

  test('每个状态都有 A2A 映射条目', () => {
    for (const s of TASK_STATES) {
      assert.ok(s in A2A_MAPPING, `${s} 缺少 A2A 映射`)
    }
  })

  test('终态没有出口', () => {
    for (const s of TERMINAL_STATES) {
      assert.equal(ALLOWED_TRANSITIONS[s].length, 0, `${s} 是终态但仍有出口`)
    }
  })

  test('除 DRAFT 外每个状态都可达（无孤岛）', () => {
    const reachable = new Set<TaskState>()
    for (const from of TASK_STATES) {
      for (const to of ALLOWED_TRANSITIONS[from]) reachable.add(to)
    }
    for (const s of TASK_STATES) {
      if (s === 'DRAFT') continue
      assert.ok(reachable.has(s), `${s} 不可达，是孤岛状态`)
    }
  })
})

describe('等待态：正常但非活跃', () => {
  test('等待态不是终态', () => {
    for (const s of WAITING_STATES) {
      assert.equal(isWaiting(s), true)
      assert.equal(isTerminal(s), false, `${s} 是等待态，不应被当作终态`)
    }
  })

  test('每个等待态都能回到 RUNNING（等待可解除）', () => {
    for (const s of WAITING_STATES) {
      assert.ok(canTransition(s, 'RUNNING'), `${s} 无法回到 RUNNING，等待将永久卡死`)
    }
  })

  test('RUNNING 可以进入任一等待态', () => {
    for (const s of WAITING_STATES) {
      assert.ok(canTransition('RUNNING', s), `RUNNING 无法进入 ${s}`)
    }
  })

  test('WAITING_RESOURCE 不是失败：真机不可用时任务应等待而非丢失', () => {
    assert.ok(canTransition('QUEUED', 'WAITING_RESOURCE'))
    assert.ok(canTransition('WAITING_RESOURCE', 'RUNNING'))
    assert.equal(isTerminal('WAITING_RESOURCE'), false)
  })
})

describe('审批闸口', () => {
  test('APPROVAL_REQUIRED 可被拒绝', () => {
    assert.ok(canTransition('APPROVAL_REQUIRED', 'REJECTED'))
  })

  test('批准后回到 RUNNING', () => {
    assert.ok(canTransition('APPROVAL_REQUIRED', 'RUNNING'))
  })

  test('只有 controlled 与 mutating 需要人工授权', () => {
    const expected: Record<RiskLevel, boolean> = {
      'read-meta': false,
      'read-sensitive': false,
      controlled: true,
      mutating: true,
    }
    for (const r of RISK_LEVELS) {
      assert.equal(needsApproval(r), expected[r], `${r} 的授权要求判定错误`)
    }
  })
})

describe('评审与返工', () => {
  test('硬门槛不过直接进 REWORK，不经过 REVIEWING', () => {
    assert.ok(canTransition('VERIFYING', 'REWORK'), '硬门槛失败应能直接返工')
    assert.ok(canTransition('VERIFYING', 'REVIEWING'), '硬门槛通过应进入软判断')
  })

  test('REVIEWING 可以 accept / rework / escalate 三条出口', () => {
    assert.ok(canTransition('REVIEWING', 'COMPLETED'), 'accept 缺出口')
    assert.ok(canTransition('REVIEWING', 'REWORK'), 'rework 缺出口')
    assert.ok(canTransition('REVIEWING', 'APPROVAL_REQUIRED'), 'escalate 缺出口')
  })

  test('REWORK 不是终态，但也不回到 RUNNING——它派生新 Task', () => {
    assert.equal(isTerminal('REWORK'), false)
    assert.equal(
      canTransition('REWORK', 'RUNNING'),
      false,
      'REWORK 不得原地重跑：返工须创建新 Task 以保留证据历史与因果链',
    )
    assert.ok(canTransition('REWORK', 'COMPLETED'), '派生后继 Task 后本 Task 应可收尾')
    assert.ok(canTransition('REWORK', 'FAILED_TERMINAL'), '预算耗尽应可落终态')
  })
})

describe('重试与终止', () => {
  test('FAILED_RETRYABLE 可回到队列重试', () => {
    assert.ok(canTransition('FAILED_RETRYABLE', 'QUEUED'))
  })

  test('FAILED_RETRYABLE 可升级为终局失败（预算硬止损）', () => {
    assert.ok(canTransition('FAILED_RETRYABLE', 'FAILED_TERMINAL'))
  })

  test('FAILED_TERMINAL 不可复活', () => {
    assert.equal(canTransition('FAILED_TERMINAL', 'QUEUED'), false)
    assert.equal(canTransition('FAILED_TERMINAL', 'RUNNING'), false)
  })

  test('COMPLETED 不可被改写', () => {
    assert.equal(ALLOWED_TRANSITIONS['COMPLETED'].length, 0)
  })
})

describe('迁移守卫必须抛错而非静默', () => {
  test('非法迁移抛 IllegalTransitionError', () => {
    assert.throws(
      () => assertTransition('COMPLETED', 'RUNNING'),
      (e: unknown) => {
        assert.ok(e instanceof IllegalTransitionError)
        assert.equal(e.from, 'COMPLETED')
        assert.equal(e.to, 'RUNNING')
        return true
      },
    )
  })

  test('错误信息列出合法目标，便于定位', () => {
    try {
      assertTransition('QUEUED', 'COMPLETED')
      assert.fail('应当抛错')
    } catch (e) {
      assert.ok(e instanceof IllegalTransitionError)
      assert.match(e.message, /RUNNING/)
    }
  })

  test('合法迁移不抛错', () => {
    assert.doesNotThrow(() => assertTransition('QUEUED', 'RUNNING'))
  })
})

describe('A2A 映射语义', () => {
  test('多个内部状态映射到 working 是有意的（A2A 不区分等资源与执行中）', () => {
    assert.equal(A2A_MAPPING['RUNNING'], 'working')
    assert.equal(A2A_MAPPING['WAITING_RESOURCE'], 'working')
    assert.equal(A2A_MAPPING['VERIFYING'], 'working')
    assert.equal(A2A_MAPPING['REVIEWING'], 'working')
  })

  test('控制面独有的状态没有 A2A 对应', () => {
    assert.equal(A2A_MAPPING['DRAFT'], null)
    assert.equal(A2A_MAPPING['READY'], null)
    assert.equal(A2A_MAPPING['REWORK'], null)
  })

  test('审批被建模为 input-required（A2A 无审批语义）', () => {
    assert.equal(A2A_MAPPING['APPROVAL_REQUIRED'], 'input-required')
  })
})
