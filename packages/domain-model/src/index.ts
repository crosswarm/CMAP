/**
 * @cmap/domain-model — 控制面领域模型
 *
 * Schema（schemas/*.json）是契约的单一真相源；generated/ 下的类型由
 * scripts/codegen.mjs 派生，不手写、不手改。
 *
 * 类型检查通过不代表满足契约：条件必填（如 rework 必须带 failed_criteria）
 * 无法用结构类型表达，运行时仍须经 ajv 校验。
 */

export type { TaskEnvelopeV1 } from './generated/task-envelope.ts'
export type { TaskResultV1 } from './generated/task-result.ts'
export type { ReviewDecisionV1 } from './generated/review-decision.ts'

export {
  TASK_STATES,
  A2A_MAPPING,
  TERMINAL_STATES,
  WAITING_STATES,
  ALLOWED_TRANSITIONS,
  isTerminal,
  isWaiting,
  canTransition,
  assertTransition,
  IllegalTransitionError,
} from './task-state.ts'
export type { TaskState, A2AState, TerminalState, WaitingState } from './task-state.ts'

export {
  ConcurrentModificationError,
  NotFoundError,
  WriteVerificationError,
  LockUnavailableError,
} from './store.ts'
export type {
  Store,
  CreateMissionInput,
  CreateTaskInput,
  TransitionTaskInput,
  AppendEventInput,
  TaskQuery,
} from './store.ts'

export { MemoryStore } from './memory-store.ts'
export { PgStore } from './pg-store.ts'
export type { PgStoreOptions } from './pg-store.ts'

export {
  RISK_LEVELS,
  APPROVAL_REQUIRED_RISKS,
  needsApproval,
  MISSION_STATES,
  EVENT_TYPES,
  ARTIFACT_STATES,
  ARTIFACT_RELATIONS,
  APPROVAL_DECISIONS,
  HEALTH_STATES,
} from './entities.ts'
export type {
  RiskLevel,
  ApprovalScope,
  Mission,
  MissionState,
  AcceptanceCriterion,
  TaskRecord,
  RemoteTaskBinding,
  TaskEvent,
  EventType,
  EventActor,
  Artifact,
  ArtifactState,
  ArtifactRelation,
  ArtifactEdge,
  ArtifactProducer,
  ArtifactRetention,
  ArtifactSecurity,
  Review,
  Approval,
  ApprovalDecision,
  ResourceLock,
  AgentDescriptor,
  RunnerDescriptor,
  RunnerAdmission,
  HealthState,
} from './entities.ts'
