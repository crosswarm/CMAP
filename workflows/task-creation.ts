import {createHash} from 'node:crypto'
import {RISK_LEVELS, TaskConflictError, assertSameTaskInput} from '#domain-model'
import type {Store, TaskRecord, TaskEnvelopeV1, RiskLevel} from '#domain-model'

export const MISSION_ACTOR={type:'system',id:'mission-workflow'} as const

export interface CreateTaskInput {
  readonly missionId:string
  readonly capability:string
  readonly goal?:string
  readonly supersedesTaskId?:string
  /** Omitted is the reserved initial intent. Distinct direct creates need distinct keys. */
  readonly creationKey?:string
}
export interface CreateTaskOutput { readonly taskId:string }

export function taskCreationId(missionId:string,creationKey='initial'):string {
  if(typeof creationKey!=='string'||!creationKey.trim()||creationKey.length>512)throw new Error('TASK_CREATION_KEY_INVALID')
  return `tsk_${createHash('sha256').update(JSON.stringify(['cmap/task-creation/v1',missionId,creationKey])).digest('hex')}`
}

const snapshot=(input:CreateTaskInput):CreateTaskInput=>({
  missionId:input.missionId,capability:input.capability,
  ...(input.goal!==undefined?{goal:input.goal}:{}),
  ...(input.supersedesTaskId!==undefined?{supersedesTaskId:input.supersedesTaskId}:{}),
  ...(input.creationKey!==undefined?{creationKey:input.creationKey}:{}),
})

export async function taskCreationMatches(store:Store,task:TaskRecord,input:CreateTaskInput):Promise<boolean> {
  const expected=await buildTask(store,snapshot(input),task.id)
  try {assertSameTaskInput(task,expected);return true}
  catch(error){if(error instanceof TaskConflictError)return false;throw error}
}

export async function createLedgerTask(store:Store,source:CreateTaskInput,expectedId?:string):Promise<CreateTaskOutput> {
  const input=snapshot(source),key=input.creationKey===undefined?'initial':input.creationKey,derivedId=taskCreationId(input.missionId,key)
  let taskId=expectedId??derivedId
  if(expectedId!==undefined&&expectedId!==derivedId&&!(await store.getTask(expectedId))) {
    throw new Error('LEGACY_TASK_MISSING')
  }
  if(expectedId===undefined&&key==='initial'&&!(await store.getTask(derivedId))) {
    const legacy=(await store.queryTasks({missionId:input.missionId})).filter(t=>
      !t.parent_task_id&&!t.supersedes_task_id&&!t.envelope.identity.plan_node_id&&
      !/^tsk_[a-f0-9]{64}$/.test(t.id))
    const matches:TaskRecord[]=[]
    for(const task of legacy)if(await taskCreationMatches(store,task,input))matches.push(task)
    if(matches.length>1)throw new Error('TASK_CREATION_AMBIGUOUS')
    if(matches.length===1)taskId=matches[0]!.id
    else if(legacy.length)throw new TaskConflictError(derivedId)
  }
  await store.createTask({task:await buildTask(store,input,taskId),actor:MISSION_ACTOR})
  return {taskId}
}

async function buildTask(store:Store,input:CreateTaskInput,taskId:string):Promise<TaskRecord> {
  const now = new Date().toISOString()

  // 信封必须自洽：spawn 出来的 Agent 不继承任何上下文，它只能看到这份信封。
  // 目标与验收标准因此必须从 Mission 抄进来——写死的占位会让 Agent 去回应
  // 一条根本不存在的标准，而验收又按 Mission 的标准判，永远对不上。
  const m = await store.getMission(input.missionId)
  if (!m) throw new Error(`Mission 不存在：${input.missionId}`)

  // 没有验收标准就没有「完成」的定义，任务无从判定，也无从返工。
  // 与其派一个永远说不清算不算过的任务出去，不如在这里挡住。
  const [firstCriterion, ...restCriteria] = m.acceptance.map((c) => ({
    criterion_id: c.criterion_id,
    metric: c.metric,
    operator: c.operator,
    expected: c.expected,
    hard_gate: c.hard_gate,
  }))
  if (!firstCriterion) {
    throw new Error(`Mission ${m.id} 未声明验收标准，无法判定任务是否完成`)
  }

  const requestedRisk = m.constraints['risk_level']
  if (
    requestedRisk !== undefined &&
    (typeof requestedRisk !== 'string' || !(RISK_LEVELS as readonly string[]).includes(requestedRisk))
  ) {
    throw new Error(`Mission ${m.id} 的 risk_level 非法：${String(requestedRisk)}`)
  }
  const risk = (requestedRisk ?? 'read-meta') as RiskLevel

  const envelope = {
    schema: 'cmap/task-envelope/v1',
    identity: {
      mission_id: input.missionId,
      task_id: taskId,
      ...(input.supersedesTaskId ? { supersedes_task_id: input.supersedesTaskId } : {}),
      idempotency_key: `${input.missionId}:${taskId}`,
      revision: 1,
      tenant: m.tenant,
      owner: m.owner,
    },
    classification: {
      task_type: m.type,
      requested_capability: input.capability,
      risk_level: risk,
    },
    goal: {
      statement: input.goal ?? m.goal,
      success_definition: [firstCriterion, ...restCriteria],
    },
    // 工作目录不进信封：本机绝对路径会让同一任务无法在别的机器上执行。
    environment: { tenant: m.tenant },
    execution_policy: { timeout_seconds: 300, max_attempts: 1 },
    permissions: { forbidden: [] },
    evidence_requirements: { required_artifact_roles: ['report'] },
    output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
  } as TaskEnvelopeV1

  return {
    id: taskId,
    mission_id: input.missionId,
    parent_task_id: null,
    supersedes_task_id: input.supersedesTaskId ?? null,
    capability: input.capability,
    risk,
    state: 'DRAFT',
    attempt: 1,
    max_attempts: 1,
    lamport: 0,
    envelope,
    result: null,
    binding: null,
    deps: [],
    created_at: now,
    updated_at: now,
  }
}
