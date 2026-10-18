/**
 * S5 续接：DAG 在等审批 / 等资源锁时 continueAsNew，避免历史超限。
 * 真实 Temporal；Activity 是记账用的假实现。确定性由重放每一段历史验证。
 */
import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {resolve} from 'node:path'
import {Worker,NativeConnection} from '@temporalio/worker'
import {Client,Connection} from '@temporalio/client'
import type {DagActivities,DagNodeOutcome} from '../../workflows/dag-activities.ts'
import type {DagWorkflowResult} from '../../workflows/dag.workflow.ts'

process.env['NO_PROXY']='localhost,127.0.0.1,::1'
process.env['no_proxy']=process.env['NO_PROXY']
const queue=`cmap-dag-can-${process.pid}-${Date.now()}`
let connection:Connection,native:NativeConnection,worker:Worker,running:Promise<void>,client:Client

/** a 等审批若干轮，b 等资源锁若干轮；join 依赖两者。 */
function harness(id:string,waits:number){
  const nodes=[{node_id:'a',deps:[] as string[]},{node_id:'b',deps:[] as string[]},{node_id:'join',deps:['a','b']}]
  const materialized:string[]=[],approvals=new Map<string,number>(),attempts=new Map<string,number>(),outcomes=new Map<string,DagNodeOutcome>()
  let loads=0
  const activities:DagActivities={
    async loadDagSchedule(){loads++;return {nodes,concurrency:2,maxAdditionalCycles:0,state:'RUNNING'}},
    async materializeDagNode(input){materialized.push(`${input.nodeId}:${input.attempt}`);return {taskId:`${id}:${input.nodeId}:${input.attempt}`}},
    async checkDagApproval(taskId){
      const n=(approvals.get(taskId)??0)+1;approvals.set(taskId,n)
      return {decision:taskId.includes(':a:')&&n<=waits?'pending':'approved'}
    },
    async runDagAttempt({taskId}){
      const n=(attempts.get(taskId)??0)+1;attempts.set(taskId,n)
      if(taskId.includes(':b:')&&n<=waits)return {outcome:'waiting_resource',taskId,reason:'RESOURCE_BUSY:device'}
      return {outcome:'collected',taskId}
    },
    async reviewDagAttempt({taskId}){
      const nodeId=taskId.split(':').at(-2)!
      const out:DagNodeOutcome={nodeId,taskId,attempt:1,status:'accepted'}
      outcomes.set(nodeId,out);return out
    },
    async finishDagNode(input){const out:DagNodeOutcome={...input};outcomes.set(input.nodeId,out);return out},
    async finalizeDagMission(){
      return {missionId:id,state:'COMPLETED',taskIds:[...outcomes.values()].map(o=>o.taskId!).sort(),blockedNodeIds:[],nodeOutcomes:[...outcomes.values()]}
    },
  }
  return {activities,materialized,approvals,attempts,get loads(){return loads}}
}
const runs=new Map<string,ReturnType<typeof harness>>()
const owner=(taskId:string)=>runs.get(taskId.split(':').slice(0,-2).join(':'))!

before(async()=>{
  connection=await Connection.connect({address:process.env['TEMPORAL_ADDRESS']??'localhost:7233'})
  native=await NativeConnection.connect({address:process.env['TEMPORAL_ADDRESS']??'localhost:7233'})
  client=new Client({connection})
  worker=await Worker.create({connection:native,taskQueue:queue,workflowsPath:resolve('workflows/dag.workflow.ts'),activities:{
    loadDagSchedule:(id:string)=>runs.get(id)!.activities.loadDagSchedule(id),
    materializeDagNode:(input:Parameters<DagActivities['materializeDagNode']>[0])=>runs.get(input.missionId)!.activities.materializeDagNode(input),
    checkDagApproval:(taskId:string)=>owner(taskId).activities.checkDagApproval(taskId),
    runDagAttempt:(input:{taskId:string})=>owner(input.taskId).activities.runDagAttempt(input),
    reviewDagAttempt:(input:Parameters<DagActivities['reviewDagAttempt']>[0])=>owner(input.taskId).activities.reviewDagAttempt(input),
    finishDagNode:(input:Parameters<DagActivities['finishDagNode']>[0])=>runs.get(input.missionId)!.activities.finishDagNode(input),
    finalizeDagMission:(id:string)=>runs.get(id)!.activities.finalizeDagMission(id),
    proposeTaskKnowledge:async()=>{},recordEscalationHandoff:async()=>{},cancelMissionTasks:async()=>({canceled:[],unconfirmed:[]}),
  }})
  running=worker.run()
})
after(async()=>{worker?.shutdown();await running;await connection?.close();await native?.close()})

test('等审批与等资源锁超过历史阈值时 continueAsNew：节点状态带入新 run，不重复物化，每段历史可重放', async()=>{
  const id=`${queue}-long`,state=harness(id,30);runs.set(id,state)
  const handle=await client.workflow.start('dagMissionWorkflow',{workflowId:id,taskQueue:queue,args:[{missionId:id,maxHistoryLength:60}]})
  const result=await handle.result() as DagWorkflowResult
  assert.equal(result.state,'COMPLETED')
  assert.ok(state.loads>1,`应至少 continueAsNew 一次，实际 run 数 ${state.loads}`)
  assert.deepEqual([...state.materialized].sort(),['a:1','b:1','join:1'],'续跑沿用已物化的任务，不重新物化')
  assert.equal(state.approvals.get(`${id}:a:1`),31)
  assert.equal(state.attempts.get(`${id}:b:1`),31)

  // 逐段重放：每个 run 的历史都必须能被当前代码确定性地重放。
  // 从最新 run 沿 continuedExecutionRunId 回溯整条链。
  let runId:string|undefined=(await handle.describe()).runId,segments=0
  while(runId) {
    const history=await client.workflow.getHandle(id,runId).fetchHistory()
    assert.ok((history.events?.length??0)<200,'每段历史都应受阈值约束')
    await Worker.runReplayHistory({workflowsPath:resolve('workflows/dag.workflow.ts')},history)
    segments++
    runId=history.events?.[0]?.workflowExecutionStartedEventAttributes?.continuedExecutionRunId||undefined
  }
  assert.equal(segments,state.loads)
})

test('未触发阈值时行为不变：单个 run 完成', async()=>{
  const id=`${queue}-short`,state=harness(id,2);runs.set(id,state)
  const result=await client.workflow.execute('dagMissionWorkflow',{workflowId:id,taskQueue:queue,args:[{missionId:id}]}) as DagWorkflowResult
  assert.equal(result.state,'COMPLETED')
  assert.equal(state.loads,1)
})
