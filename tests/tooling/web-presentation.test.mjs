import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptanceRows, approvalPayload, dagNodeRows, expectedValue, stateTone, missionDisplayState } from '../../apps/web/src/presentation.ts'

test('正常资源等待与等待审批不能使用相同的行动提示', () => {
  assert.equal(stateTone('WAITING_RESOURCE'), 'neutral')
  assert.equal(stateTone('APPROVAL_REQUIRED'), 'attention')
})

test('任务队列从实际Task状态区分资源等待和需要人工输入', () => {
  assert.equal(missionDisplayState({ state: 'RUNNING' }, [{ state: 'WAITING_RESOURCE' }]), 'WAITING_RESOURCE')
  assert.equal(missionDisplayState({ state: 'RUNNING' }, [{ state: 'INPUT_REQUIRED' }]), 'INPUT_REQUIRED')
  assert.equal(missionDisplayState({ state: 'COMPLETED' }, [{ state: 'WAITING_RESOURCE' }]), 'COMPLETED')
})

test('前端不把未经评审的 Agent 自报通过显示成验收通过，漏答单独表达', () => {
  const mission = { acceptance: [{ criterion_id: 'a' }, { criterion_id: 'b' }] }
  const task = { id: 't', created_at: '2026-09-21T00:00:00Z', result: { criterion_results: [{ criterion_id: 'a', actual: 3, passed: true }] } }
  assert.deepEqual(acceptanceRows(mission, [task], []).map((r) => r.state), ['pending', 'unanswered'])
  const reviews = [{ round: 1, reviewed_task_ids: ['t'], decision: { failed_criteria: [{ criterion_id: 'a', reason: '控制面核验失败' }] } }]
  assert.equal(acceptanceRows(mission, [task], reviews)[0].state, 'failed')
})

test('旧账本自报通过也不能覆盖明确不达标的 actual', () => {
  const mission = { acceptance: [{ criterion_id: 'a', operator: 'eq', expected: 3 }] }
  const task = { id: 't', created_at: '2026-09-21T00:00:00Z', result: { criterion_results: [{ criterion_id: 'a', actual: '5', passed: true }] } }
  const reviews = [{ round: 1, reviewed_task_ids: ['t'], decision: { decision: 'accept' } }]
  assert.equal(acceptanceRows(mission, [task], reviews)[0].state, 'failed')
})

test('首轮尚无结果时不编造上轮结果提示', () => {
  const mission = { acceptance: [{ criterion_id: 'a', operator: 'eq', expected: 3 }] }
  const task = { id: 't', created_at: '2026-09-21T00:00:00Z', result: null }
  assert.equal(acceptanceRows(mission, [task], [])[0].previousRound, false)
})

test('DAG 验收按 criterion 所属节点取最新终态尝试，不串用其他节点结果', () => {
  const mission = {
    workflow_template: 'dag/v1',
    constraints: {
      plan: {
        schema: 'cmap/mission-plan/v1',
        nodes: [
          { node_id: 'A', goal: 'A', capability: 'code.a', deps: [], criterion_ids: ['a'], risk_level: 'read-meta' },
          { node_id: 'B', goal: 'B', capability: 'code.b', deps: ['A'], criterion_ids: ['b'], risk_level: 'read-meta' },
        ],
      },
    },
    acceptance: [
      { criterion_id: 'a', metric: 'ma', operator: 'eq', expected: 1 },
      { criterion_id: 'b', metric: 'mb', operator: 'eq', expected: 1 },
    ],
  }
  const tasks = [
    {
      id: 'task-a-1',
      created_at: '2026-09-21T00:00:00Z',
      state: 'COMPLETED',
      attempt: 1,
      envelope: { identity: { plan_node_id: 'A' } },
      result: { criterion_results: [{ criterion_id: 'a', actual: 1, passed: true }] },
    },
    {
      id: 'task-b-1',
      created_at: '2026-09-21T00:01:00Z',
      state: 'COMPLETED',
      attempt: 1,
      envelope: { identity: { plan_node_id: 'B' } },
      result: { criterion_results: [{ criterion_id: 'b', actual: 1, passed: true }] },
    },
    {
      id: 'task-b-2',
      created_at: '2026-09-21T00:02:00Z',
      state: 'FAILED_TERMINAL',
      attempt: 2,
      envelope: { identity: { plan_node_id: 'B' } },
      result: {
        criterion_results: [
          { criterion_id: 'b', actual: 2, passed: false },
          { criterion_id: 'a', actual: 999, passed: true },
        ],
      },
    },
  ]
  const reviews = [
    { id: 'r-a', round: 1, reviewed_task_ids: ['task-a-1'], decision: { decision: 'accept' } },
    { id: 'r-b1', round: 1, reviewed_task_ids: ['task-b-1'], decision: { decision: 'accept' } },
    { id: 'r-b2', round: 2, reviewed_task_ids: ['task-b-2'], decision: { decision: 'rework', failed_criteria: [{ criterion_id: 'b', reason: '最新终态未达标' }] } },
  ]

  const rows = acceptanceRows(mission, tasks, reviews)
  assert.deepEqual(rows.map((r) => [r.criterion.criterion_id, r.sourceTask, r.actual, r.state]), [
    ['a', 'task-a-1', 1, 'passed'],
    ['b', 'task-b-2', 2, 'failed'],
  ])
})

test('DAG 节点投影展示依赖、状态、尝试轮次和执行端', () => {
  const mission = {
    workflow_template: 'dag/v1',
    constraints: {
      plan: {
        schema: 'cmap/mission-plan/v1',
        nodes: [
          { node_id: 'A', goal: '采集', capability: 'code.a', deps: [], criterion_ids: ['a'], risk_level: 'read-meta', preferred_agent: 'codex' },
          { node_id: 'B', goal: '汇总', capability: 'code.b', deps: ['A'], criterion_ids: ['b'], risk_level: 'read-meta', fallback_agents: ['kimi'] },
        ],
      },
    },
    acceptance: [{ criterion_id: 'a' }, { criterion_id: 'b' }],
  }
  const rows = dagNodeRows(mission, [
    {
      id: 'task-a-1',
      state: 'COMPLETED',
      attempt: 1,
      created_at: '2026-09-21T00:00:00Z',
      envelope: { identity: { plan_node_id: 'A' } },
      deps: [],
      binding: { adapter: 'codex-adapter', runner_id: 'runner-1' },
    },
    {
      id: 'task-b-2',
      state: 'RUNNING',
      attempt: 2,
      created_at: '2026-09-21T00:02:00Z',
      envelope: { identity: { plan_node_id: 'B' } },
      deps: ['task-a-1'],
      binding: null,
    },
  ], [])

  assert.deepEqual(rows.map((r) => [r.nodeId, r.status, r.attempt, r.agent, r.deps.join(',')]), [
    ['A', 'COMPLETED', 1, 'codex-adapter / runner-1', ''],
    ['B', 'RUNNING', 2, 'fallback kimi', 'A'],
  ])
})

test('DAG 全局终止会把未创建节点标为阻塞，完成的返工尝试仍显示返工', () => {
  const mission = {
    workflow_template: 'dag/v1',
    state: 'ESCALATED',
    constraints: {
      plan: {
        schema: 'cmap/mission-plan/v1',
        nodes: [
          { node_id: 'A', goal: '采集', capability: 'code.a', deps: [], criterion_ids: ['a'], risk_level: 'read-meta' },
          { node_id: 'B', goal: '汇总', capability: 'code.b', deps: ['A'], criterion_ids: ['b'], risk_level: 'read-meta' },
        ],
      },
    },
    acceptance: [{ criterion_id: 'a' }, { criterion_id: 'b' }],
  }
  const rows = dagNodeRows(mission, [
    {
      id: 'task-a-1',
      state: 'COMPLETED',
      attempt: 1,
      created_at: '2026-09-21T00:00:00Z',
      envelope: { identity: { plan_node_id: 'A' } },
      deps: [],
      binding: null,
    },
  ], [
    { id: 'r-a', round: 1, reviewed_task_ids: ['task-a-1'], decision: { decision: 'rework' } },
  ])

  assert.deepEqual(rows.map((r) => [r.nodeId, r.status, r.actualTaskState]), [
    ['A', 'REWORK', 'COMPLETED'],
    ['B', 'BLOCKED', undefined],
  ])
})

test('DAG 验收必须有节点最新终态的 accept 评审才显示通过', () => {
  const mission = {
    workflow_template: 'dag/v1',
    constraints: {
      plan: {
        schema: 'cmap/mission-plan/v1',
        nodes: [
          { node_id: 'A', goal: 'A', capability: 'code.a', deps: [], criterion_ids: ['a'], risk_level: 'read-meta' },
        ],
      },
    },
    acceptance: [{ criterion_id: 'a', metric: 'ma', operator: 'eq', expected: 1 }],
  }
  const task = {
    id: 'task-a-1',
    created_at: '2026-09-21T00:00:00Z',
    state: 'COMPLETED',
    attempt: 1,
    envelope: { identity: { plan_node_id: 'A' } },
    result: { criterion_results: [{ criterion_id: 'a', actual: 1, passed: true }] },
  }

  assert.equal(
    acceptanceRows(mission, [task], [{ id: 'r-a', round: 1, reviewed_task_ids: ['task-a-1'], decision: { decision: 'rework' } }])[0].state,
    'failed',
  )
  assert.equal(
    acceptanceRows(mission, [task], [{ id: 'r-a', round: 1, reviewed_task_ids: ['task-a-1'], decision: { decision: 'escalate' } }])[0].state,
    'failed',
  )
  assert.equal(
    acceptanceRows(mission, [task], [{ id: 'r-a', round: 1, reviewed_task_ids: ['task-a-1'], decision: { decision: 'accept' } }])[0].state,
    'passed',
  )
})

test('批准当前 scope 不会合并另一类授权，过期或已处理不可再批', () => {
  const approval = { scope: 'controlled', decision: 'pending', expires_at: '2099-01-01T00:00:00Z' }
  assert.deepEqual(approvalPayload(approval, 'controlled', 'approved', 'test:operator'), { scope: 'controlled', decision: 'approved', decided_by: 'test:operator' })
  assert.throws(() => approvalPayload(approval, 'mutating', 'approved', 'test:operator'))
  assert.throws(() => approvalPayload({ ...approval, decision: 'approved' }, 'controlled', 'approved', 'test:operator'))
  assert.throws(() => approvalPayload({ ...approval, expires_at: '2000-01-01T00:00:00Z' }, 'controlled', 'approved', 'test:operator'))
})

test('数字和布尔验收不会把空输入、NaN 或任意文本当有效值', () => {
  assert.equal(expectedValue('number', '3'), 3)
  assert.equal(expectedValue('boolean', 'false'), false)
  for (const value of ['', 'NaN', 'Infinity']) assert.throws(() => expectedValue('number', value))
  assert.throws(() => expectedValue('boolean', 'yes'))
})
