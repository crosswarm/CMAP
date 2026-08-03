/**
 * @cmap/adapter-sdk — Agent 适配器接口
 *
 * 一条铁律：Adapter 必须把厂商输出归一化为 TaskResultV1。
 * Workflow 不得直接解析 Claude / Codex / Kimi / YonWork 的自然语言终端输出——
 * 那样做的结果是流程会被措辞变化随机打断，且失败无法归因。
 *
 * 归一化的落点是各 Agent 的结构化输出能力（均已实测）：
 *   codex   codex exec --output-schema <FILE> --json
 *   claude  claude -p --output-format stream-json
 *   kimi    kimi -p --output-format stream-json
 *   yonwork yonwork-cli-adapter.mjs 的 JSON 输出
 */

import type {
  TaskEnvelopeV1,
  TaskResultV1,
  RemoteTaskBinding,
  RiskLevel,
  HealthState,
} from '#domain-model'

// ------------------------------------------------------------ 描述与发现

export interface AdapterDescriptor {
  readonly adapter_id: string
  readonly agent_id: string
  readonly provider: string
  readonly version: string
  readonly capabilities: readonly string[]
  /** 该 Adapter 允许承接的最高风险级别。超出即拒绝派发。 */
  readonly risk_ceiling: RiskLevel
  readonly supports_session_resume: boolean
  readonly supports_worktree_isolation: boolean
  /**
   * 执行能力等级，语义见 execution-portability.md：
   * A 自带 Computer Use ｜ B 其他 Agent + CLI ｜ C 人工 + CLI ｜ D 仅 Bridge
   * 降级必须如实标注，不得以低等级冒充高等级。
   */
  readonly execution_level: 'A' | 'B' | 'C' | 'D'
}

export interface AdapterHealth {
  readonly state: HealthState
  readonly checked_at: string
  readonly detail?: string
}

// ------------------------------------------------------------ 派发上下文

export interface DispatchContext {
  /** 短期、受众绑定的令牌。禁止共用长期 API Key，禁止 Token Passthrough。 */
  readonly token: string
  readonly runner_id: string
  readonly trace_id: string
  readonly correlation_id: string
  /** 代码类任务的隔离工作区，避免 Codex 与 Kimi 并发污染。 */
  readonly worktree?: string
  readonly deadline_at: string
}

// -------------------------------------------------------------- 归一化事件

export const AGENT_EVENT_KINDS = [
  'started',
  'progress',
  'heartbeat',
  'tool_call',
  'artifact_ready',
  'input_required',
  'auth_required',
  'completed',
  'failed',
] as const
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number]

export interface NormalizedAgentEvent {
  readonly kind: AgentEventKind
  readonly at: string
  readonly message?: string
  readonly payload?: Readonly<Record<string, unknown>>
}

export const AGENT_STATUSES = [
  'queued',
  'running',
  'input_required',
  'auth_required',
  'completed',
  'failed',
  'canceled',
  'rejected',
] as const
export type AgentStatusKind = (typeof AGENT_STATUSES)[number]

export interface NormalizedAgentStatus {
  readonly status: AgentStatusKind
  readonly at: string
  /**
   * 终态观测标记。用于 YonWork 这类 SSE 链路：
   * 连接建立或心跳不能证明消息完成，只有观测到终态才可标记 success。
   */
  readonly terminal_observed: boolean
  readonly detail?: string
}

export interface AgentInput {
  readonly kind: 'context' | 'credential_ref' | 'approval'
  readonly content: string
}

export interface SubscriptionHandle {
  readonly unsubscribe: () => Promise<void>
}

// -------------------------------------------------------------------- SPI

export interface AgentAdapter {
  readonly adapterId: string
  readonly agentId: string

  discover(): Promise<AdapterDescriptor>

  /**
   * 派发任务。信封必须自洽——spawn 出的 worker 不继承任何上下文。
   * 实现须携带 envelope.identity.idempotency_key 做外部副作用去重：
   * 即使引擎声称 exactly-once，超时后也无法确认副作用是否已发生。
   */
  startTask(envelope: TaskEnvelopeV1, ctx: DispatchContext): Promise<RemoteTaskBinding>

  sendInput(binding: RemoteTaskBinding, input: AgentInput): Promise<void>

  getStatus(binding: RemoteTaskBinding): Promise<NormalizedAgentStatus>

  subscribe(
    binding: RemoteTaskBinding,
    onEvent: (event: NormalizedAgentEvent) => Promise<void>,
  ): Promise<SubscriptionHandle>

  cancel(binding: RemoteTaskBinding, reason: string): Promise<void>

  /**
   * 收取归一化结果。
   * 实现不得凭进程 rc=0 判定成功：信封 evidence_requirements 声明的
   * artifact role 若缺失，必须返回 failed。
   */
  collectResult(binding: RemoteTaskBinding): Promise<TaskResultV1>

  health(): Promise<AdapterHealth>
}

// ------------------------------------------------------------------ 错误

export class AdapterError extends Error {
  readonly code: string
  readonly retryable: boolean
  /** 错误指纹，供无进展检测比对相邻两轮是否同一错误。 */
  readonly fingerprint: string

  constructor(code: string, message: string, retryable: boolean, fingerprint: string) {
    super(message)
    this.name = 'AdapterError'
    this.code = code
    this.retryable = retryable
    this.fingerprint = fingerprint
  }
}

/** 风险超出 Adapter 上限。属于策略拒绝，不可重试。 */
export class RiskCeilingExceededError extends AdapterError {
  constructor(required: RiskLevel, ceiling: RiskLevel, adapterId: string) {
    super(
      'RISK_CEILING_EXCEEDED',
      `任务风险级别 ${required} 超出 Adapter ${adapterId} 的上限 ${ceiling}`,
      false,
      `risk-ceiling:${adapterId}:${required}`,
    )
    this.name = 'RiskCeilingExceededError'
  }
}

/** 声明的证据产物缺失。无证据即失败，不接受 rc=0 作为成功依据。 */
export class EvidenceMissingError extends AdapterError {
  constructor(missingRoles: readonly string[], taskId: string) {
    super(
      'EVIDENCE_MISSING',
      `任务 ${taskId} 缺少声明的证据产物：${missingRoles.join(', ')}`,
      false,
      `evidence-missing:${missingRoles.slice().sort().join(',')}`,
    )
    this.name = 'EvidenceMissingError'
  }
}
