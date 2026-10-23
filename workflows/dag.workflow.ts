import { condition, continueAsNew, defineSignal, isCancellation, patched, proxyActivities, setHandler, sleep, workflowInfo } from '@temporalio/workflow'
import type { ProgressSnapshot } from '#domain-model'
import type { Activities } from './activities.ts'
import type { DagActivities, DagNodeOutcome } from './dag-activities.ts'

export type DagWorkflowResult = Awaited<ReturnType<DagActivities['finalizeDagMission']>>

const acts = proxyActivities<DagActivities>({
  startToCloseTimeout:'5 minutes',
  retry:{initialInterval:'2 seconds',maximumAttempts:3},
})
const writeback = proxyActivities<Pick<Activities,'proposeTaskKnowledge'|'recordEscalationHandoff'|'cancelMissionTasks'>>({
  startToCloseTimeout:'5 minutes',
  retry:{initialInterval:'2 seconds',maximumAttempts:3},
})
/** S5 协作/交接：旧历史重放时 patched() 为 false，不插入新 Activity。 */
const KNOWLEDGE_PATCH='dag-knowledge-propose-v1'
const HANDOFF_PATCH='dag-escalation-handoff-v1'
/** S5 续接：与 missionWorkflow 同名的取消信号；旧历史重放时 patched() 为 false，照旧忽略。 */
const CANCEL_PATCH='dag-cancel-v1'
export const cancelMissionSignal=defineSignal<[{readonly reason:string}]>('cancelMission')
/**
 * S02 审批门铃：API 落账审批决定后发送，只提醒回读账本，不带业务数据。
 * 旧历史重放时 patched() 为 false，照旧每秒轮询；超时也回读，信号丢失最多延迟一个周期。
 */
const APPROVAL_SIGNAL_PATCH='dag-approval-signal-v1'
export const approvalDecidedSignal=defineSignal('approvalDecided')
// 旁路回写：失败不改变节点或 Mission 结果。
const sideEffect=async (run:()=>Promise<void>):Promise<void>=>{
  try{await run()}catch(error){if(isCancellation(error))throw error}
}
const attempt = proxyActivities<Pick<DagActivities,'runDagAttempt'>>({
  startToCloseTimeout:'2 hours',heartbeatTimeout:'2 minutes',
  // 不在派发确认不明时另起一次 Agent；节点返工通过新 Task 表达。
  retry:{maximumAttempts:1},
})
/**
 * Worker 重启恢复：Worker 失联（心跳/超时）后重试一次。runDagAttempt 自身的错误不可重试，
 * 重试的 attempt 只对重启安全 Adapter 的既有 binding 恢复观察，绝不新启动 Agent。
 * 旧历史重放时 patched() 为 false，仍按 maximumAttempts 1 调度。
 */
const ATTEMPT_RESUME_PATCH='dag-attempt-restart-resume-v1'
const resumableAttempt = proxyActivities<Pick<DagActivities,'runDagAttempt'>>({
  startToCloseTimeout:'2 hours',heartbeatTimeout:'2 minutes',
  retry:{initialInterval:'2 seconds',maximumAttempts:2},
})

/** 停在等待点（等审批 / 等资源锁）的节点，continueAsNew 后从这里继续，不重新物化。 */
export interface ParkedDagNode {
  readonly nodeId: string
  readonly taskId: string
  readonly attemptNumber: number
  readonly previousProgress?: ProgressSnapshot
  readonly phase: 'approval' | 'attempt'
}

export interface DagWorkflowInput {
  readonly missionId: string
  /** 历史事件数达到此值（或服务端建议）时在等待点 continueAsNew。测试用小值，默认 8000。 */
  readonly maxHistoryLength?: number
  /** 上一段 run 交接过来的进度：已终结节点的结论与停在等待点的节点。 */
  readonly resume?: { readonly outcomes: readonly DagNodeOutcome[]; readonly parked: readonly ParkedDagNode[] }
}

/** S5 续接：长时间等待时换新历史。旧历史重放时 patched() 为 false，照旧原地 sleep。 */
const CONTINUE_PATCH='dag-continue-as-new-v1'
/** Q04 额度续接（ADR-0009 §3）：旧历史里 QUOTA_EXHAUSTED 照旧走评审返工。 */
const QUOTA_HANDOFF_PATCH='dag-quota-handoff-v1'
const DEFAULT_MAX_HISTORY=8000

export async function dagMissionWorkflow(input: DagWorkflowInput): Promise<DagWorkflowResult> {
  const {missionId}=input
  let cancelReason:string|undefined
  let cancelSweep:Promise<unknown>=Promise.resolve()
  const schedule=await acts.loadDagSchedule(missionId)
  if(['COMPLETED','FAILED','ESCALATED','CANCELED'].includes(schedule.state)) {
    return acts.finalizeDagMission(missionId)
  }
  const outcomes=new Map<string,DagNodeOutcome>((input.resume?.outcomes??[]).map(o=>[o.nodeId,o]))
  const resumable=new Map<string,ParkedDagNode>((input.resume?.parked??[]).map(p=>[p.nodeId,p]))
  const parked=new Map<string,ParkedDagNode>()
  const running=new Map<string,Promise<void>>()
  let stopping=false
  let draining=false
  let approvalBell=0
  setHandler(approvalDecidedSignal,()=>{approvalBell++})
  setHandler(cancelMissionSignal,(signal)=>{
    if(cancelReason!==undefined||!patched(CANCEL_PATCH))return
    cancelReason=typeof signal?.reason==='string'&&signal.reason.trim()?signal.reason.slice(0,500):'MISSION_CANCELED'
    stopping=true
    cancelSweep=writeback.cancelMissionTasks({missionId,reason:cancelReason}).catch(()=>undefined)
  })
  // 一旦开始收拢就不再派生新节点，各节点在下一个等待点停下；停止优先于收拢。
  const shouldPark=():boolean=>{
    if(stopping)return false
    if(!draining) {
      const info=workflowInfo()
      if(!info.continueAsNewSuggested&&info.historyLength<(input.maxHistoryLength??DEFAULT_MAX_HISTORY))return false
      if(!patched(CONTINUE_PATCH))return false
      draining=true
    }
    return true
  }
  const stopReason=()=>cancelReason!==undefined?'MISSION_CANCELED':'DAG_STOPPED'

  const executeNode=async (node:typeof schedule.nodes[number],resume?:ParkedDagNode):Promise<DagNodeOutcome|ParkedDagNode>=>{
    let taskId:string|undefined=resume?.taskId
    let attemptNumber=resume?.attemptNumber??1
    let previousProgress:ProgressSnapshot|undefined=resume?.previousProgress
    let phase:'materialize'|'approval'|'attempt'=resume?.phase??'materialize'
    const stopped=()=>acts.finishDagNode({missionId,nodeId:node.node_id,...(taskId?{taskId}:{}),status:'failed',reason:stopReason()})
    const park=(at:'approval'|'attempt'):ParkedDagNode=>({nodeId:node.node_id,taskId:taskId!,attemptNumber,...(previousProgress?{previousProgress}:{}),phase:at})
    try {
      for(;;) {
        if(phase==='materialize') {
          if(stopping) return stopped()
          const previousTaskId=taskId
          const acceptedDeps=Object.fromEntries(node.deps.map(id=>{
            const parent=outcomes.get(id)
            if(parent?.status!=='accepted'||!parent.taskId)throw new Error('DAG dependency proof missing')
            return [id,parent.taskId]
          }))
          const created=await acts.materializeDagNode({missionId,nodeId:node.node_id,attempt:attemptNumber,acceptedDeps,...(previousTaskId?{supersedesTaskId:previousTaskId}:{})})
          if('admissionDenied' in created) {
            const prefix=created.admissionDenied.phase==='initial'?'RUNNER_ADMISSION_DENIED':'RUNNER_ADMISSION_REVOKED'
            return acts.finishDagNode({missionId,nodeId:node.node_id,status:'escalated',reason:`${prefix}:${created.admissionDenied.code}`})
          }
          taskId=created.taskId
          phase='approval'
        }
        const current=taskId!
        if(phase==='approval') {
          for(;;) {
            if(stopping) return stopped()
            // 回读前记下门铃：回读期间到达的信号也能唤醒下一轮等待。
            const bell=approvalBell
            const approval=await acts.checkDagApproval(current)
            if(approval.decision==='rejected')return acts.finishDagNode({missionId,nodeId:node.node_id,taskId:current,status:'failed',reason:'APPROVAL_REJECTED'})
            if(approval.decision==='approved')break
            if(shouldPark())return park('approval')
            if(patched(APPROVAL_SIGNAL_PATCH))await condition(()=>approvalBell!==bell||stopping||draining,'10 minutes')
            else await sleep('1 second')
          }
          phase='attempt'
        }
        let quotaExhausted=false
        for(;;) {
          if(stopping) return stopped()
          const result=await (patched(ATTEMPT_RESUME_PATCH)?resumableAttempt:attempt).runDagAttempt({taskId:current})
          if(result.outcome==='collected'){quotaExhausted=result.reason==='QUOTA_EXHAUSTED';break}
          if(result.outcome==='escalated')return acts.finishDagNode({missionId,nodeId:node.node_id,taskId:current,status:'escalated',reason:result.reason??'ATTEMPT_FAILED'})
          if(shouldPark())return park('attempt')
          await sleep('1 second')
        }
        // 取消时不再评审；其余停止原因下，已启动的分支必须完成结果/评审落账。
        if(cancelReason!==undefined)return stopped()
        // 额度耗尽：派生同轮续接任务重新路由，不评审、不耗返工预算。只在出现 QUOTA_EXHAUSTED 时才查补丁，旧历史不受影响。
        if(quotaExhausted&&patched(QUOTA_HANDOFF_PATCH)) {
          const handoff=await acts.handoffQuotaExhausted({taskId:current})
          if(handoff.outcome==='escalated')return acts.finishDagNode({missionId,nodeId:node.node_id,taskId:current,status:'escalated',reason:handoff.reason})
          taskId=handoff.taskId
          phase='approval'
          continue
        }
        const reviewed=await acts.reviewDagAttempt({taskId:current,...(previousProgress?{previousProgress}:{})})
        if(reviewed.status==='accepted'){
          await sideEffect(async()=>{if(patched(KNOWLEDGE_PATCH))await writeback.proposeTaskKnowledge({missionId,taskId:current})})
        }
        if(reviewed.status!=='rework')return reviewed
        if(attemptNumber>schedule.maxAdditionalCycles) {
          return acts.finishDagNode({missionId,nodeId:node.node_id,taskId:current,status:'escalated',reason:'BUDGET_EXHAUSTED'})
        }
        previousProgress=reviewed.progress
        attemptNumber++
        phase='materialize'
      }
    }catch{
      return acts.finishDagNode({missionId,nodeId:node.node_id,...(taskId?{taskId}:{}),status:'escalated',reason:'NODE_EXECUTION_ERROR'})
    }
  }

  for(;;) {
    if(!stopping&&!draining) {
      for(const node of schedule.nodes) {
        if(running.size>=schedule.concurrency)break
        if(outcomes.has(node.node_id)||running.has(node.node_id))continue
        if(!node.deps.every(id=>outcomes.get(id)?.status==='accepted'))continue
        const resume=resumable.get(node.node_id)
        resumable.delete(node.node_id)
        const promise=executeNode(node,resume).then(outcome=>{
          if('phase' in outcome)parked.set(node.node_id,outcome)
          else {
            outcomes.set(node.node_id,outcome)
            if(outcome.status==='failed'||outcome.status==='escalated')stopping=true
          }
          running.delete(node.node_id)
        })
        running.set(node.node_id,promise)
      }
    }
    if(!running.size&&parked.size) {
      if(!stopping) {
        // 所有在跑的节点都已停在等待点或结束：带着进度换一段新历史。
        await continueAsNew<typeof dagMissionWorkflow>({
          missionId,
          ...(input.maxHistoryLength!==undefined?{maxHistoryLength:input.maxHistoryLength}:{}),
          resume:{outcomes:[...outcomes.values()],parked:[...parked.values()]},
        })
      }
      // 收拢途中触发了停止：停在等待点的节点按停止原因收尾。
      for(const p of parked.values()) {
        outcomes.set(p.nodeId,await acts.finishDagNode({missionId,nodeId:p.nodeId,taskId:p.taskId,status:'failed',reason:stopReason()}))
      }
      parked.clear()
    }
    if(!running.size) {
      if(!stopping&&outcomes.size!==schedule.nodes.length) {
        const missing=schedule.nodes.find(node=>!outcomes.has(node.node_id))!
        await acts.finishDagNode({missionId,nodeId:missing.node_id,status:'escalated',reason:'UNRESOLVED_DEPENDENCIES'})
      }
      break
    }
    await Promise.race(running.values())
  }
  if(cancelReason!==undefined) {
    await cancelSweep
    await writeback.cancelMissionTasks({missionId,reason:cancelReason,finalize:true})
  }
  const final=await acts.finalizeDagMission(missionId)
  if(final.state==='ESCALATED') {
    const reason=final.nodeOutcomes.filter(o=>o.status==='escalated').map(o=>`${o.nodeId}:${o.reason??'ESCALATED'}`).join(',')||'DAG_ESCALATED'
    await sideEffect(async()=>{if(patched(HANDOFF_PATCH))await writeback.recordEscalationHandoff({missionId,reason})})
  }
  return final
}
