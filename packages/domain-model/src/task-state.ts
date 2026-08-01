/**
 * Task 状态机。
 *
 * 控制面的状态比 A2A 更细，因为要区分几种「正常但非活跃」的停顿——
 * 等资源、等审批、等补充输入。这些在 UI 上不能都显示成转圈，在调度上
 * 也不能当作失败重试。
 *
 * 状态迁移是确定性逻辑，放在 Workflow 侧；触发迁移的副作用放 Activity。
 */

export const TASK_STATES = [
  'DRAFT',
  'READY',
  'QUEUED',
  'RUNNING',
  'WAITING_RESOURCE',
  'INPUT_REQUIRED',
  'AUTH_REQUIRED',
  'APPROVAL_REQUIRED',
  'VERIFYING',
  'REVIEWING',
  'REWORK',
  'COMPLETED',
  'FAILED_RETRYABLE',
  'FAILED_TERMINAL',
  'CANCELED',
  'REJECTED',
] as const

export type TaskState = (typeof TASK_STATES)[number]

/** A2A 1.0 任务状态。保留映射以便将来与外部 Agent 互操作，当前不实现协议栈。 */
export type A2AState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'

/**
 * 控制面状态 → A2A 状态。
 * 多个内部状态映射到同一个 A2A 状态是有意的：A2A 不区分「等资源」和
 * 「正在跑」，但我们必须区分。
 */
export const A2A_MAPPING: Record<TaskState, A2AState | null> = {
  DRAFT: null,
  READY: null,
  QUEUED: 'submitted',
  RUNNING: 'working',
  WAITING_RESOURCE: 'working',
  INPUT_REQUIRED: 'input-required',
  AUTH_REQUIRED: 'auth-required',
  APPROVAL_REQUIRED: 'input-required',
  VERIFYING: 'working',
  REVIEWING: 'working',
  REWORK: null,
  COMPLETED: 'completed',
  FAILED_RETRYABLE: 'failed',
  FAILED_TERMINAL: 'failed',
  CANCELED: 'canceled',
  REJECTED: 'rejected',
}

/** 终态：不再迁移。REWORK 不是终态——它会派生新 Task。 */
export const TERMINAL_STATES = [
  'COMPLETED',
  'FAILED_TERMINAL',
  'CANCELED',
  'REJECTED',
] as const satisfies readonly TaskState[]

export type TerminalState = (typeof TERMINAL_STATES)[number]

export const isTerminal = (s: TaskState): s is TerminalState =>
  (TERMINAL_STATES as readonly TaskState[]).includes(s)

/**
 * 非活跃但正常的等待态。
 * UI 必须把它们与 RUNNING 区分呈现，调度器不得按失败处理。
 */
export const WAITING_STATES = [
  'WAITING_RESOURCE',
  'INPUT_REQUIRED',
  'AUTH_REQUIRED',
  'APPROVAL_REQUIRED',
] as const satisfies readonly TaskState[]

export type WaitingState = (typeof WAITING_STATES)[number]

export const isWaiting = (s: TaskState): s is WaitingState =>
  (WAITING_STATES as readonly TaskState[]).includes(s)

/** 合法迁移表。未列出的迁移一律非法。 */
export const ALLOWED_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  DRAFT: ['READY', 'CANCELED'],
  READY: ['QUEUED', 'CANCELED'],
  QUEUED: ['RUNNING', 'WAITING_RESOURCE', 'CANCELED', 'REJECTED'],

  RUNNING: [
    'WAITING_RESOURCE',
    'INPUT_REQUIRED',
    'AUTH_REQUIRED',
    'APPROVAL_REQUIRED',
    'VERIFYING',
    'FAILED_RETRYABLE',
    'FAILED_TERMINAL',
    'CANCELED',
  ],

  // 等待态解除后回到 RUNNING；也可能直接被取消或超时
  WAITING_RESOURCE: ['RUNNING', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'CANCELED'],
  INPUT_REQUIRED: ['RUNNING', 'FAILED_TERMINAL', 'CANCELED'],
  AUTH_REQUIRED: ['RUNNING', 'FAILED_TERMINAL', 'CANCELED'],
  APPROVAL_REQUIRED: ['RUNNING', 'REJECTED', 'FAILED_TERMINAL', 'CANCELED'],

  // 硬门槛由确定性程序判定，不通过直接进 REWORK，不经过 REVIEWING
  VERIFYING: ['REVIEWING', 'REWORK', 'FAILED_TERMINAL', 'CANCELED'],

  // 软判断。accept 仍须硬门槛已过；rework 派生新 Task；escalate 交人类
  REVIEWING: ['COMPLETED', 'REWORK', 'APPROVAL_REQUIRED', 'FAILED_TERMINAL', 'CANCELED'],

  // REWORK 是本 Task 的出口：派生新 Task 后本 Task 落 COMPLETED（已尽其责），
  // 或预算耗尽落 FAILED_TERMINAL。不复用旧 Task 重跑，以保留证据历史与因果链。
  REWORK: ['COMPLETED', 'FAILED_TERMINAL', 'CANCELED'],

  FAILED_RETRYABLE: ['QUEUED', 'FAILED_TERMINAL', 'CANCELED'],

  COMPLETED: [],
  FAILED_TERMINAL: [],
  CANCELED: [],
  REJECTED: [],
}

export const canTransition = (from: TaskState, to: TaskState): boolean =>
  ALLOWED_TRANSITIONS[from].includes(to)

export class IllegalTransitionError extends Error {
  readonly from: TaskState
  readonly to: TaskState

  constructor(from: TaskState, to: TaskState) {
    super(
      `非法状态迁移 ${from} → ${to}。合法目标：${ALLOWED_TRANSITIONS[from].join(', ') || '（终态，无出口）'}`,
    )
    this.name = 'IllegalTransitionError'
    this.from = from
    this.to = to
  }
}

/** 迁移守卫。非法迁移必须抛错而非静默忽略——静默是这类系统最难查的故障。 */
export const assertTransition = (from: TaskState, to: TaskState): void => {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to)
}
