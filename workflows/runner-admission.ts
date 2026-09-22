import type { RunnerDescriptor, Store, TaskRecord, RunnerAdmissionErrorCode } from '#domain-model'
import { RUNNER_ADMISSION_CODES, RunnerAdmissionError, admissionSubjectFromTask, assertRunnerAdmission, needsApproval } from '#domain-model'

export interface AdmissionDenial {
  readonly admissionDenied: {
    readonly phase: 'initial' | 'post-intent'
    readonly code: RunnerAdmissionErrorCode
  }
}

export const admissionDenialReason = (denial: AdmissionDenial): string =>
  `${denial.admissionDenied.phase === 'initial' ? 'RUNNER_ADMISSION_DENIED' : 'RUNNER_ADMISSION_REVOKED'}:${denial.admissionDenied.code}`

const receiptKey = (taskId: string): string => `runner-admission:${taskId}`

/** Admission does not make an unready task executable. Bound runs use recovery. */
export function assertDispatchableTask(task: TaskRecord): void {
  if(!['READY','QUEUED','WAITING_RESOURCE'].includes(task.state))throw new Error('TASK_NOT_DISPATCHABLE')
}

/** Recheck the local approval record; authenticated human identity still belongs to P4. */
export async function assertCurrentTaskApproval(store: Store, task: TaskRecord): Promise<void> {
  if(!needsApproval(task.risk))return
  const id=`apr:${task.id}:${task.risk}`,approval=await store.getApproval(id),now=Date.now()
  const who=approval?.decided_by?.trim()
  const decided=Date.parse(approval?.decided_at??''),created=Date.parse(approval?.created_at??''),expires=Date.parse(approval?.expires_at??'')
  if(!approval||approval.id!==id||approval.task_id!==task.id||approval.mission_id!==task.mission_id||
     approval.scope!==task.risk||approval.decision!=='approved'||!who||who===approval.requested_by.trim()||
     /^(agent|system):/i.test(who)||!Number.isFinite(created)||!Number.isFinite(decided)||
     decided<created||decided>now||!Number.isFinite(expires)||expires<=now) {
    throw new RunnerAdmissionError('APPROVAL_INVALID')
  }
}

export async function readAdmissionDenial(store: Store, task: TaskRecord): Promise<AdmissionDenial | undefined> {
  const events = (await store.listEvents(task.mission_id)).filter(event => event.idempotency_key === receiptKey(task.id))
  if (!events.length) return undefined
  const event = events[0]!
  const phase = event.payload['phase'], code = event.payload['code']
  if (events.length !== 1 || event.task_id !== task.id ||
      (phase !== 'initial' && phase !== 'post-intent') ||
      !RUNNER_ADMISSION_CODES.includes(code as RunnerAdmissionErrorCode) ||
      event.event_type !== (phase === 'initial' ? 'TASK_CANCELED' : 'TASK_FAILED') ||
      task.state !== (phase === 'initial' ? 'CANCELED' : 'FAILED_TERMINAL') ||
      (phase === 'initial' ? task.binding !== null : task.binding === null)) {
    throw new Error('RUNNER_ADMISSION_RECEIPT_INVALID')
  }
  return {admissionDenied:{phase,code:code as RunnerAdmissionErrorCode}}
}

export async function assertStoredTaskAdmission(store: Store, runner: RunnerDescriptor, task: TaskRecord): Promise<void> {
  const mission = await store.getMission(task.mission_id)
  if (!mission) throw new RunnerAdmissionError('IDENTITY_MISMATCH')
  assertRunnerAdmission(runner, admissionSubjectFromTask(mission,task))
}

export async function persistAdmissionDenial(
  store: Store, runner: RunnerDescriptor, task: TaskRecord, error: RunnerAdmissionError,
  phase: AdmissionDenial['admissionDenied']['phase'],
): Promise<AdmissionDenial> {
  const previous = await readAdmissionDenial(store,task)
  if (previous) return previous
  if (phase === 'initial' ? task.binding !== null : task.binding === null || task.state !== 'RUNNING') {
    throw new Error('RUNNER_ADMISSION_PHASE_INVALID')
  }
  const denial:AdmissionDenial={admissionDenied:{phase,code:error.code}}
  await store.transitionTask({
    taskId:task.id,to:phase === 'initial' ? 'CANCELED' : 'FAILED_TERMINAL',expectedFrom:task.state,
    actor:{type:'system',id:'runner-admission',runner_id:runner.runner_id},
    eventType:phase === 'initial' ? 'TASK_CANCELED' : 'TASK_FAILED',idempotencyKey:receiptKey(task.id),
    payload:{...denial.admissionDenied,reason:admissionDenialReason(denial)},
  })
  return denial
}

/** Replayed denial takes precedence over a prepared binding and over new grants. */
export async function preflightTaskAdmission(store: Store, runner: RunnerDescriptor, task: TaskRecord): Promise<AdmissionDenial | undefined> {
  const previous=await readAdmissionDenial(store,task)
  if(previous)return previous
  if(task.binding)return undefined // observation/recovery must survive a policy change
  if(!['DRAFT','READY','QUEUED','WAITING_RESOURCE','APPROVAL_REQUIRED'].includes(task.state)) {
    throw new Error('TASK_NOT_DISPATCHABLE')
  }
  try {await assertStoredTaskAdmission(store,runner,task)}
  catch(error) {
    if(!(error instanceof RunnerAdmissionError))throw error
    return persistAdmissionDenial(store,runner,task,error,'initial')
  }
  return undefined
}

/** Only execution entry points check approval; materialization may precede approval. */
export async function preflightTaskDispatch(store: Store, runner: RunnerDescriptor, task: TaskRecord): Promise<AdmissionDenial | undefined> {
  const denied=await preflightTaskAdmission(store,runner,task)
  if(denied||task.binding)return denied
  assertDispatchableTask(task)
  try {await assertCurrentTaskApproval(store,task)}
  catch(error) {
    if(!(error instanceof RunnerAdmissionError))throw error
    return persistAdmissionDenial(store,runner,task,error,'initial')
  }
  return undefined
}
