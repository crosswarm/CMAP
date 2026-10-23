/**
 * M04 出站网关的 Workflow 门铃：attempt 返回 awaiting_report 后，Workflow 不再每秒重入，而是等 runnerReported 信号
 * 或 30 秒超时再回读；重入时带回上一轮的 deadlineAt（超时不因重入顺延）。真实 Temporal，Activity 为记账用假实现。
 */
import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {resolve} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {Worker,NativeConnection} from '@temporalio/worker'
import {Client,Connection,type WorkflowHandle} from '@temporalio/client'
import type {DagActivities,DagNodeOutcome} from '../../workflows/dag-activities.ts'
import type {DagWorkflowResult} from '../../workflows/dag.workflow.ts'

process.env['NO_PROXY']='localhost,127.0.0.1,::1'
process.env['no_proxy']=process.env['NO_PROXY']
const queue=`cmap-dag-runner-report-${process.pid}-${Date.now()}`
let connection:Connection,native:NativeConnection,worker:Worker,running:Promise<void>,client:Client

const DEADLINE='2099-01-01T00:00:00.000Z'
/** reported 模拟 API 已把终态回报落账；attempt 只在落账后才返回 collected。 */
const state={reported:false,attempts:[] as {deadlineAt?:string}[]}
const outcomes=new Map<string,DagNodeOutcome>()
const activities:DagActivities={
  async loadDagSchedule(){return {nodes:[{node_id:'n1',deps:[]}],concurrency:1,maxAdditionalCycles:0,state:'RUNNING'}},
  async materializeDagNode(input){return {taskId:`${input.missionId}:n1`}},
  async checkDagApproval(){return {decision:'approved'}},
  async runDagAttempt({taskId,deadlineAt}){
    state.attempts.push(deadlineAt?{deadlineAt}:{})
    return state.reported?{outcome:'collected',taskId}:{outcome:'awaiting_report',taskId,deadlineAt:DEADLINE}
  },
  async reviewDagAttempt({taskId}){const out:DagNodeOutcome={nodeId:'n1',taskId,attempt:1,status:'accepted'};outcomes.set('n1',out);return out},
  async handoffQuotaExhausted(){throw new Error('unused')},
  async finishDagNode(input){const out:DagNodeOutcome={...input};outcomes.set(input.nodeId,out);return out},
  async finalizeDagMission(missionId){
    return {missionId,state:'COMPLETED',taskIds:[...outcomes.values()].map(o=>o.taskId!),blockedNodeIds:[],nodeOutcomes:[...outcomes.values()]}
  },
}

before(async()=>{
  connection=await Connection.connect({address:process.env['TEMPORAL_ADDRESS']??'localhost:7233'})
  native=await NativeConnection.connect({address:process.env['TEMPORAL_ADDRESS']??'localhost:7233'})
  client=new Client({connection})
  worker=await Worker.create({connection:native,taskQueue:queue,workflowsPath:resolve('workflows/dag.workflow.ts'),activities:{
    ...activities,proposeTaskKnowledge:async()=>{},recordEscalationHandoff:async()=>{},cancelMissionTasks:async()=>({canceled:[],unconfirmed:[]}),
  }})
  running=worker.run()
})
after(async()=>{worker?.shutdown();await running;await connection?.close();await native?.close()})

const historyLength=async(handle:WorkflowHandle)=>(await handle.fetchHistory()).events?.length??0
const until=async(ok:()=>boolean,label:string)=>{
  for(const deadline=Date.now()+15_000;!ok();await delay(50))if(Date.now()>deadline)throw new Error(`等待超时：${label}`)
}

test('等回报期间不重入、历史不增长；门铃响后带原截止重入，已落账即继续；历史可重放', async()=>{
  const id=`${queue}-wait`
  const handle=await client.workflow.start('dagMissionWorkflow',{workflowId:id,taskQueue:queue,args:[{missionId:id}]})
  await until(()=>state.attempts.length>=1,'首次 attempt')
  assert.deepEqual(state.attempts[0],{},'首次进入不带截止')
  await delay(1000)
  const before=await historyLength(handle)
  await delay(3000)
  assert.ok(await historyLength(handle)-before<3,'等待期间仍在轮询')
  assert.equal(state.attempts.length,1,'未收到门铃不应重入')

  // 门铃只是提醒：仍未落账就回读一次接着等。
  await handle.signal('runnerReported')
  await until(()=>state.attempts.length===2,'门铃后重入')
  assert.deepEqual(state.attempts[1],{deadlineAt:DEADLINE},'重入沿用上一轮截止')
  await delay(1500)
  assert.equal(state.attempts.length,2)

  state.reported=true
  const rung=Date.now()
  await handle.signal('runnerReported')
  const result=await handle.result() as DagWorkflowResult
  assert.ok(Date.now()-rung<3000,`信号后应立即继续，实际 ${Date.now()-rung}ms`)
  assert.equal(result.state,'COMPLETED')
  assert.equal(state.attempts.length,3)
  await Worker.runReplayHistory({workflowsPath:resolve('workflows/dag.workflow.ts')},await handle.fetchHistory())
})
