/**
 * S02 审批等待改 Signal 唤醒：审批未决时不再每秒轮询，等 approvalDecided 门铃或 10 分钟超时再回读账本。
 * 真实 Temporal；Activity 是记账用的假实现，审批结论只由 checkDagApproval 回读给出，信号不带业务数据。
 */
import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {Worker,NativeConnection} from '@temporalio/worker'
import {Client,Connection,type WorkflowHandle} from '@temporalio/client'
import proto from '@temporalio/proto'
import type {DagActivities,DagNodeOutcome} from '../../workflows/dag-activities.ts'
import type {DagWorkflowResult} from '../../workflows/dag.workflow.ts'

process.env['NO_PROXY']='localhost,127.0.0.1,::1'
process.env['no_proxy']=process.env['NO_PROXY']
const queue=`cmap-dag-approval-signal-${process.pid}-${Date.now()}`
let connection:Connection,native:NativeConnection,worker:Worker,running:Promise<void>,client:Client

/** 单节点 n1：审批结论由测试控制，模拟真人在 API 落账。 */
const state={decision:'pending' as 'pending'|'approved'|'rejected',checks:0}
const outcomes=new Map<string,DagNodeOutcome>()
const activities:DagActivities={
  async loadDagSchedule(){return {nodes:[{node_id:'n1',deps:[]}],concurrency:1,maxAdditionalCycles:0,state:'RUNNING'}},
  async materializeDagNode(input){return {taskId:`${input.missionId}:n1`}},
  async checkDagApproval(){state.checks++;return {decision:state.decision}},
  async runDagAttempt({taskId}){return {outcome:'collected',taskId}},
  async reviewDagAttempt({taskId}){const out:DagNodeOutcome={nodeId:'n1',taskId,attempt:1,status:'accepted'};outcomes.set('n1',out);return out},
  async finishDagNode(input){const out:DagNodeOutcome={...input};outcomes.set(input.nodeId,out);return out},
  async handoffQuotaExhausted(){throw new Error('unused')},
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

test('审批未决期间历史不随时间增长；门铃响后回读账本，未决就继续等，已批准立即继续；历史可重放', async()=>{
  const id=`${queue}-wait`
  const handle=await client.workflow.start('dagMissionWorkflow',{workflowId:id,taskQueue:queue,args:[{missionId:id}]})
  await until(()=>state.checks>=1,'首次回读审批')
  await delay(1000)
  const before=await historyLength(handle)
  await delay(4000)
  const grown=await historyLength(handle)-before
  assert.ok(grown<3,`等待 4 秒内历史增长了 ${grown} 个事件，仍在轮询`)
  assert.equal(state.checks,1,'未收到门铃不应再回读审批')

  // 门铃只是提醒：账本仍未决，回读一次后接着等。
  await handle.signal('approvalDecided')
  await until(()=>state.checks===2,'门铃后回读')
  await delay(2000)
  assert.equal(state.checks,2,'未决时不得转为轮询')

  state.decision='approved'
  const rung=Date.now()
  await handle.signal('approvalDecided')
  const result=await handle.result() as DagWorkflowResult
  assert.ok(Date.now()-rung<3000,`信号后应立即继续，实际 ${Date.now()-rung}ms`)
  assert.equal(result.state,'COMPLETED')
  assert.equal(state.checks,3)
  await Worker.runReplayHistory({workflowsPath:resolve('workflows/dag.workflow.ts')},await handle.fetchHistory())
})

test('补丁前的历史（审批未决时每秒轮询）在新代码下仍可确定性重放', async()=>{
  const fixture=JSON.parse(readFileSync(new URL('../fixtures/dag-approval-poll-legacy.json',import.meta.url),'utf8'))
  const history=proto.temporal.api.history.v1.History.fromObject(fixture)
  assert.ok(history.events.some(e=>e.timerStartedEventAttributes?.startToFireTimeout?.seconds?.toString()==='1'),'旧历史应含 1 秒轮询定时器')
  await Worker.runReplayHistory({workflowsPath:resolve('workflows/dag.workflow.ts')},history)
})
