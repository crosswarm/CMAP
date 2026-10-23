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
export type { DispatchPermitV1 } from './generated/dispatch-permit.ts'
export type { RemoteRunnerMessageV1, RemoteRunnerDispatchV1, RemoteRunnerResultV1 } from './generated/remote-runner.ts'
export type { QuotaSnapshotV1 } from './generated/quota-snapshot.ts'
export { DispatchPermitError, issueDispatchPermit, verifyDispatchPermit, loadOrCreatePermitKey, loadPinnedPublicKey } from './dispatch-permit.ts'
export type { DispatchPermitErrorCode } from './dispatch-permit.ts'
export type { MissionPlanV1 } from './generated/mission-plan.ts'
export { normalizeMissionPlan, yonWorkProfileFromRoute } from './mission-plan.ts'
export type { YonWorkOutputV1 } from './generated/yonwork-output.ts'
export type { TaskResultV1 } from './generated/task-result.ts'
export type { ReviewDecisionV1 } from './generated/review-decision.ts'
export type { ReviewApplicationV1 } from './generated/review-application.ts'
export type { MissionEventV1 } from './generated/mission-event.ts'
export type { ControlPlaneContextV1 } from './generated/control-plane-context.ts'
export type { ApprovalAdviceV1 } from './generated/approval-advice.ts'
export type { JevDecisionV1 } from './generated/jev-decision.ts'
export type { ApprovalDecisionInputV1 } from './generated/approval-decision-input.ts'
export { ApprovalDecisionConflictError } from './approval-state.ts'
export { MissionConflictError } from './mission-input.ts'

export {
  TASK_STATES,
  TERMINAL_STATES,
  WAITING_STATES,
  ALLOWED_TRANSITIONS,
  isTerminal,
  isWaiting,
  canTransition,
  assertTransition,
  IllegalTransitionError,
} from './task-state.ts'
export type { TaskState, TerminalState, WaitingState } from './task-state.ts'

export {
  ConcurrentModificationError,
  NotFoundError,
  WriteVerificationError,
  LockUnavailableError,
  ArtifactConflictError,
  TaskConflictError,
  assertSameTaskInput,
  assertSameReviewInput,
  ReviewConflictError,
  EventConflictError,
  BindingConflictError,
} from './store.ts'
export type {
  Store,
  CreateMissionInput,
  CreateTaskInput,
  ClaimTaskBindingInput,
  ClaimTaskBindingResult,
  TransitionTaskInput,
  AppendEventInput,
  TaskQuery,
  MissionQuery,
  MissionAttention,
} from './store.ts'

export { buildEvidencePack } from './evidence-pack.ts'
export type { EvidencePack, EvidencePackTask } from './evidence-pack.ts'

export { recomputeCriterionPassed } from './criterion-check.ts'

export { detectNoProgress, NO_PROGRESS_REASONS } from './no-progress.ts'
export type { ProgressSnapshot, NoProgressResult, NoProgressReason } from './no-progress.ts'

export { MemoryStore } from './memory-store.ts'
export { RUNNER_ADMISSION_CODES, RunnerAdmissionError, assertRunnerAdmission, admissionSubjectFromTask, admissionSubjectFromDagNode, snapshotRunnerDescriptor } from './runner-admission.ts'
export type { RunnerAdmissionErrorCode, RunnerAdmissionSubject } from './runner-admission.ts'
export type { RunnerAdmissionV1 } from './generated/runner-admission.ts'
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
