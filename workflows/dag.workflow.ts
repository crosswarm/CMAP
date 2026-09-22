import { proxyActivities, sleep } from '@temporalio/workflow'
import type { ProgressSnapshot } from '#domain-model'
import type { DagActivities, DagNodeOutcome } from './dag-activities.ts'

export type DagWorkflowResult = Awaited<ReturnType<DagActivities['finalizeDagMission']>>

const acts = proxyActivities<DagActivities>({
  startToCloseTimeout:'5 minutes',
  retry:{initialInterval:'2 seconds',maximumAttempts:3},
})
const attempt = proxyActivities<Pick<DagActivities,'runDagAttempt'>>({
  startToCloseTimeout:'2 hours',heartbeatTimeout:'2 minutes',
  // 不在派发确认不明时另起一次 Agent；节点返工通过新 Task 表达。
  retry:{maximumAttempts:1},
})

export async function dagMissionWorkflow(input: { missionId: string }): Promise<DagWorkflowResult> {
  const {missionId}=input
  const schedule=await acts.loadDagSchedule(missionId)
  if(['COMPLETED','FAILED','ESCALATED','CANCELED'].includes(schedule.state)) {
    return acts.finalizeDagMission(missionId)
  }
  const outcomes=new Map<string,DagNodeOutcome>()
  const running=new Map<string,Promise<void>>()
  let stopping=false

  const executeNode=async (node:typeof schedule.nodes[number]):Promise<DagNodeOutcome>=>{
    let taskId:string|undefined
    let attemptNumber=1
    let previousProgress:ProgressSnapshot|undefined
    const stopped=()=>acts.finishDagNode({missionId,nodeId:node.node_id,...(taskId?{taskId}:{}),status:'failed',reason:'DAG_STOPPED'})
    try {
      for(;;) {
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
        for(;;) {
          if(stopping) return stopped()
          const approval=await acts.checkDagApproval(taskId)
          if(approval.decision==='rejected')return acts.finishDagNode({missionId,nodeId:node.node_id,taskId,status:'failed',reason:'APPROVAL_REJECTED'})
          if(approval.decision==='approved')break
          await sleep('1 second')
        }
        for(;;) {
          if(stopping) return stopped()
          const result=await attempt.runDagAttempt({taskId})
          if(result.outcome==='collected')break
          if(result.outcome==='escalated')return acts.finishDagNode({missionId,nodeId:node.node_id,taskId,status:'escalated',reason:result.reason??'ATTEMPT_FAILED'})
          await sleep('1 second')
        }
        // 已启动的分支必须完成结果/评审落账，即使别的分支已触发停止。
        const reviewed=await acts.reviewDagAttempt({taskId,...(previousProgress?{previousProgress}:{})})
        if(reviewed.status!=='rework')return reviewed
        if(attemptNumber>schedule.maxAdditionalCycles) {
          return acts.finishDagNode({missionId,nodeId:node.node_id,taskId,status:'escalated',reason:'BUDGET_EXHAUSTED'})
        }
        previousProgress=reviewed.progress
        attemptNumber++
      }
    }catch{
      return acts.finishDagNode({missionId,nodeId:node.node_id,...(taskId?{taskId}:{}),status:'escalated',reason:'NODE_EXECUTION_ERROR'})
    }
  }

  for(;;) {
    if(!stopping) {
      for(const node of schedule.nodes) {
        if(running.size>=schedule.concurrency)break
        if(outcomes.has(node.node_id)||running.has(node.node_id))continue
        if(!node.deps.every(id=>outcomes.get(id)?.status==='accepted'))continue
        const promise=executeNode(node).then(outcome=>{
          outcomes.set(node.node_id,outcome)
          if(outcome.status==='failed'||outcome.status==='escalated')stopping=true
          running.delete(node.node_id)
        })
        running.set(node.node_id,promise)
      }
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
  return acts.finalizeDagMission(missionId)
}
