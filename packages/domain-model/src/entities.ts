/**
 * 控制面账本实体。
 *
 * 这些是控制面「拥有」的事实，与 Agent 无关：Agent 可以建议下一步，
 * 但不能自行充当数据库。所有状态变更都要落成事件。
 */

import type { TaskState } from './task-state.ts'
import type { TaskEnvelopeV1 } from './generated/task-envelope.ts'
import type { TaskResultV1 } from './generated/task-result.ts'
import type { ReviewDecisionV1 } from './generated/review-decision.ts'

/** 风险分级。与 yonwork-cli-adapter 既有风险模型对齐。 */
export const RISK_LEVELS = ['read-meta', 'read-sensitive', 'controlled', 'mutating'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

/** 需要人工授权的风险级别。 */
export const APPROVAL_REQUIRED_RISKS = ['controlled', 'mutating'] as const satisfies readonly RiskLevel[]
export type ApprovalScope = (typeof APPROVAL_REQUIRED_RISKS)[number]

export const needsApproval = (r: RiskLevel): r is ApprovalScope =>
  (APPROVAL_REQUIRED_RISKS as readonly RiskLevel[]).includes(r)

// ---------------------------------------------------------------- Mission

export const MISSION_STATES = [
  'DRAFT',
  'PLANNING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'REVIEWING',
  'COMPLETED',
  'ESCALATED',
  'FAILED',
  'CANCELED',
] as const
export type MissionState = (typeof MISSION_STATES)[number]

export const TERMINAL_MISSION_STATES: ReadonlySet<MissionState> = new Set(['COMPLETED', 'ESCALATED', 'FAILED', 'CANCELED'])

/** 终态之间仍可改写（沿用原语义），但不得回到非终态：取消后迟到的 RUNNING 会让任务照常派发。 */
export const assertMissionStateChange = (id: string, from: MissionState, to: MissionState): void => {
  if (TERMINAL_MISSION_STATES.has(from) && !TERMINAL_MISSION_STATES.has(to)) {
    throw new Error(`Mission ${id} 已终结（${from}），不能回到 ${to}`)
  }
}

export interface Mission {
  readonly id: string
  readonly tenant: string
  /** 发起人。授权归属与审计的锚点。 */
  readonly owner: string
  readonly type: string
  readonly goal: string
  readonly constraints: Readonly<Record<string, unknown>>
  /** 机读验收标准。Mission 级的硬门槛，Task 级的在各自信封里。 */
  readonly acceptance: readonly AcceptanceCriterion[]
  readonly workflow_template: string
  state: MissionState
  revision: number
  readonly created_at: string
  updated_at: string
}

export interface AcceptanceCriterion {
  readonly criterion_id: string
  readonly metric: string
  readonly operator: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq' | 'contains' | 'not_contains'
  readonly expected: unknown
  readonly unit?: string
  /** true 表示由确定性程序判定。软判断不得覆盖硬指标。 */
  readonly hard_gate: boolean
}

// ------------------------------------------------------------------- Task

export interface TaskRecord {
  readonly id: string
  readonly mission_id: string
  readonly parent_task_id: string | null
  /** 返工时指向被取代的前一轮 Task，用于重建因果链。 */
  readonly supersedes_task_id: string | null
  readonly capability: string
  readonly risk: RiskLevel
  state: TaskState
  attempt: number
  readonly max_attempts: number
  /** 逻辑时钟。跨主机排序一律不依赖 wall clock。 */
  lamport: number
  readonly envelope: TaskEnvelopeV1
  result: TaskResultV1 | null
  /** 外部 Agent 侧的任务标识。对方生成，不强行统一到控制面 ID。 */
  binding: RemoteTaskBinding | null
  readonly deps: readonly string[]
  readonly created_at: string
  updated_at: string
}

/** 双层任务标识：控制面 ID 稳定，外部 ID 由对方 Agent 生成。 */
export interface RemoteTaskBinding {
  readonly adapter: string
  readonly remote_task_id: string
  readonly remote_context_id?: string
  readonly protocol: string
  readonly protocol_version: string
  /**
   * 执行方标识。没有它，控制面只知道「任务在哪」而不知道「谁在执行」，
   * P4 时无法定位执行方以做取消、超时判定与故障转移。
   */
  readonly runner_id: string
  /** 供续跑使用：codex exec resume / kimi -S / claude --resume */
  readonly provider_session_id?: string
}

// ------------------------------------------------------------------ Event

export const EVENT_TYPES = [
  'MISSION_CREATED',
  'PLAN_PROPOSED',
  'PLAN_ACCEPTED',
  /** DAG 逻辑节点终态与未派发节点的阻塞原因，仅含关联元数据。 */
  'DAG_NODE_FINISHED',
  'DAG_NODE_BLOCKED',
  'TASK_CREATED',
  'TASK_READY',
  'TASK_DISPATCH_INTENT',
  /** 派发前的执行者选择：各候选判定与原因、选中者、是否回落、耗时；用于路由效率评测。 */
  'ROUTING_DECIDED',
  'TASK_ASSIGNED',
  'TASK_STARTED',
  'TASK_HEARTBEAT',
  'RESOURCE_LOCK_REQUESTED',
  'RESOURCE_LOCK_ACQUIRED',
  'RESOURCE_LOCK_RELEASED',
  'RESOURCE_LOCK_EXPIRED',
  'AGENT_MESSAGE_RECEIVED',
  'ARTIFACT_UPLOAD_STARTED',
  'ARTIFACT_PUBLISHED',
  'INPUT_REQUIRED',
  'AUTH_REQUIRED',
  'APPROVAL_REQUESTED',
  'APPROVAL_GRANTED',
  'APPROVAL_DENIED',
  /** ADR-0007 Jev 决定（payload 为 jev-decision.v1）。影子模式只记录，不改审批或任务状态。 */
  'JEV_DECIDED',
  /** ADR-0009 §3 额度续接（payload 为 quota-handoff.v1）：原任务 QUOTA_EXHAUSTED 后派生的同轮续接任务。 */
  'QUOTA_HANDOFF',
  /** ADR-0009 §5 某账号从额度低恢复（重置时刻已过且重新探测确认），每个低额度时段只记一次。 */
  'QUOTA_RESTORED',
  'HARD_GATE_EVALUATED',
  'REVIEW_STARTED',
  'REVIEW_APPLICATION_INTENT',
  'REVIEW_APPLICATION_COMPLETED',
  'REVIEW_ACCEPTED',
  'REVIEW_REWORK_REQUESTED',
  'REVIEW_ESCALATED',
  'NO_PROGRESS_DETECTED',
  'TASK_RETRY_SCHEDULED',
  'TASK_FAILED',
  'TASK_CANCELED',
  'TASK_COMPLETED',
  'MISSION_COMPLETED',
  /** 需要人介入。与 MISSION_FAILED 分开：一个要人来救，一个只是结果不达标。 */
  'MISSION_ESCALATED',
  'MISSION_FAILED',
  /** 其余状态流转（如进入 RUNNING）。没有它，中间态只能借用终态事件，届时界面会显示假信号。 */
  'MISSION_STATE_CHANGED',
  /** 验收通过的结论已作为候选提交 Memross（只存 proposal_id 与状态，不存正文）。 */
  'KNOWLEDGE_PROPOSED',
  /** 提交 Memross 候选失败（错误类别）。旁路失败，不影响 Mission 结果。 */
  'KNOWLEDGE_PROPOSAL_FAILED',
  /** Mission 升级时已写 Memross 交接记录（只存 handoff_id）。 */
  'HANDOFF_RECORDED',
  /** 交接记录写入失败（错误类别）。不影响升级流程。 */
  'HANDOFF_FAILED',
  /** Mission 累计 tokens 超过 CMAP_MISSION_COST_ALERT_TOKENS：每个 Mission 至多一条，payload 仅含 total_tokens 与 threshold_tokens。只告警，不阻断执行。 */
  'MISSION_COST_ALERT',
  /** 人请求取消 Mission（payload 含原因）。状态由 Workflow 收尾。 */
  'MISSION_CANCEL_REQUESTED',
  /** 因 Mission 取消向已绑定任务的 Adapter 发出 cancel；confirmed 表示 Adapter 是否确认。 */
  'TASK_CANCEL_REQUESTED',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export interface TaskEvent {
  readonly event_id: string
  readonly event_type: EventType
  readonly event_version: number
  readonly occurred_at: string
  readonly mission_id: string
  readonly task_id: string | null
  readonly attempt: number | null
  readonly actor: EventActor
  /** 因果链：本事件由哪个事件引发。多人多机场景下复盘的唯一依据。 */
  readonly causation_id: string | null
  readonly correlation_id: string
  readonly trace_id: string | null
  readonly lamport: number
  /** 事件去重键。重复回调不得产生重复 Artifact 或重复 Task。 */
  readonly idempotency_key: string
  readonly payload: Readonly<Record<string, unknown>>
}

export interface EventActor {
  readonly type: 'agent' | 'human' | 'system'
  readonly id: string
  /** runner 身份。跨主机时用于追溯任务实际在谁的机器上执行。 */
  readonly runner_id?: string
}

// --------------------------------------------------------------- Artifact

export const ARTIFACT_STATES = ['UPLOADING', 'AVAILABLE', 'EXPIRED', 'REVOKED'] as const
export type ArtifactState = (typeof ARTIFACT_STATES)[number]

/**
 * 只保留有实际使用场景的两种关系。
 *
 * 原本从研究报告照搬了 8 种（VALIDATES/INVALIDATES/IMPLEMENTS/REFERENCES/
 * GENERATED_FROM/SUMMARIZES），但它们不是从 CMAP 的需求推导出来的，
 * 其存在只会制造「该用哪个关系」的决策负担。加一个枚举值的成本，
 * 远低于用错关系类型后的数据清理。
 */
export const ARTIFACT_RELATIONS = [
  /** 派生：指标对比派生自前后两份原始测量 */
  'DERIVED_FROM',
  /** 取代：返工后第二轮的 trace 取代第一轮 */
  'SUPERSEDES',
] as const
export type ArtifactRelation = (typeof ARTIFACT_RELATIONS)[number]

export interface Artifact {
  readonly artifact_id: string
  readonly mission_id: string
  readonly task_id: string
  readonly role: string
  readonly uri: string
  readonly media_type: string
  readonly size_bytes: number
  /** 内容寻址。防证据被覆盖导致结论不可验证。 */
  readonly sha256: string
  readonly version: number
  state: ArtifactState
  readonly producer: ArtifactProducer
  readonly provenance: Readonly<Record<string, unknown>>
  readonly retention: ArtifactRetention
  readonly security: ArtifactSecurity
  readonly created_at: string
}

export interface ArtifactProducer {
  readonly agent_id: string
  readonly adapter_version: string
  readonly execution_session_id: string
}

export interface ArtifactRetention {
  readonly retain_until: string
  /** 关键验收证据应不可变，防保留期内被覆盖。 */
  readonly immutable: boolean
}

export interface ArtifactSecurity {
  readonly classification: 'public' | 'internal' | 'restricted'
  readonly contains_secrets: boolean
  readonly contains_pii: boolean
  readonly allowed_roles: readonly string[]
}

export interface ArtifactEdge {
  readonly source_artifact_id: string
  readonly target_artifact_id: string
  readonly relation: ArtifactRelation
}

// ----------------------------------------------------------------- Review

export interface Review {
  readonly id: string
  readonly mission_id: string
  readonly reviewed_task_ids: readonly string[]
  readonly round: number
  readonly decision: ReviewDecisionV1
  readonly created_at: string
}

// --------------------------------------------------------------- Approval

export const APPROVAL_DECISIONS = ['pending', 'approved', 'rejected', 'expired'] as const
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number]

export interface Approval {
  readonly id: string
  readonly mission_id: string
  readonly task_id: string
  readonly action: string
  /**
   * 授权范围。controlled 与 mutating 互不蕴含——批准前者不放行后者。
   * UI 上不得合并成单一「批准」按钮。
   */
  readonly scope: ApprovalScope
  readonly requested_by: string
  readonly risk_level: RiskLevel
  readonly reason: string
  readonly evidence_artifact_ids: readonly string[]
  decision: ApprovalDecision
  /** 批准者必须是有权限的真人。Agent 不得自批，也不得伪装成人工授权。 */
  decided_by: string | null
  decided_at: string | null
  readonly expires_at: string
  readonly created_at: string
}

// ---------------------------------------------------------- Resource Lock

export interface ResourceLock {
  readonly lock_id: string
  readonly resource: string
  readonly task_id: string
  readonly mission_id: string
  readonly holder_runner_id: string
  readonly acquired_at: string
  /** 必须带 TTL 且可抢占——runner 崩溃不得永久占住真机。 */
  readonly expires_at: string
  released_at: string | null
}

// --------------------------------------------------------- Agent / Runner

export const HEALTH_STATES = ['healthy', 'degraded', 'unavailable'] as const
export type HealthState = (typeof HEALTH_STATES)[number]

export interface AgentDescriptor {
  readonly agent_id: string
  readonly provider: string
  readonly roles: readonly string[]
  readonly capabilities: readonly string[]
  readonly risk_ceiling: RiskLevel
  readonly supports_session_resume: boolean
  readonly supports_worktree_isolation: boolean
  health: HealthState
}

export interface RunnerDescriptor {
  readonly runner_id: string
  readonly tenant: string
  readonly host: string
  readonly agents: readonly string[]
  /** 稀缺独占资源，如真机、computer-use。调度需按 affinity 定位。 */
  readonly resources: readonly string[]
  /**
   * 准入策略。默认拒绝、白名单放行——别人的任务不能默认在你机器上跑。
   * 这是多人多机跨公网场景最危险的一处。
   */
  readonly admission: RunnerAdmission
  health: HealthState
  last_heartbeat_at: string
}

export interface RunnerAdmission {
  readonly allowed_tenants: readonly string[]
  readonly allowed_owners: readonly string[]
  readonly allowed_capabilities: readonly string[]
  readonly max_risk: RiskLevel
}
