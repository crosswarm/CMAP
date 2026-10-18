import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {resolve} from 'node:path'
import {Worker,NativeConnection} from '@temporalio/worker'
import {Client,Connection} from '@temporalio/client'
import type {DagActivities,DagNodeOutcome} from '../../workflows/dag-activities.ts'
import type {DagWorkflowResult} from '../../workflows/dag.workflow.ts'

process.env['NO_PROXY']='localhost,127.0.0.1,::1'
process.env['no_proxy']=process.env['NO_PROXY']
const queue=`cmap-dag-scheduler-${process.pid}-${Date.now()}`
let connection:Connection
let native:NativeConnection
let worker:Worker
let running:Promise<void>
let client:Client
type Harness = ReturnType<typeof harness>
const runs = new Map<string,Harness>()
const taskOwners = new Map<string,Harness>()

function harness(id:string, mode:'normal'|'rework'|'failure') {
  const nodes=[{node_id:'a',deps:[] as string[]},{node_id:'b',deps:[] as string[]},...(mode==='failure'?[{node_id:'unused',deps:[] as string[]}]:[]),{node_id:'join',deps:['a','b']}]
  const materialized:Array<{nodeId:string,attempt:number,acceptedDeps:Readonly<Record<string,string>>}>=[]
  const tasks=new Map<string,{nodeId:string,attempt:number}>()
  const outcomes=new Map<string,DagNodeOutcome>()
  let active=0,maxActive=0
  const activities:DagActivities={
    async loadDagSchedule(){return {nodes,concurrency:2,maxAdditionalCycles:1,state:'RUNNING'}},
    async materializeDagNode(input){
      if(input.nodeId==='join') {
        assert.equal(outcomes.get('a')?.status,'accepted')
        assert.equal(outcomes.get('b')?.status,'accepted')
      }
      materialized.push(input)
      const taskId=`${id}:${input.nodeId}:${input.attempt}`
      tasks.set(taskId,{nodeId:input.nodeId,attempt:input.attempt});taskOwners.set(taskId,state)
      return {taskId}
    },
    async checkDagApproval(){return {decision:'approved'}},
    async runDagAttempt({taskId}){
      active++;maxActive=Math.max(maxActive,active)
      await new Promise(r=>setTimeout(r,tasks.get(taskId)!.nodeId==='b'?80:20))
      active--
      if(mode==='failure'&&tasks.get(taskId)!.nodeId==='a')return {outcome:'escalated',taskId,reason:'LOCK_LOST'}
      return {outcome:'collected',taskId}
    },
    async reviewDagAttempt({taskId}){
      const {nodeId,attempt}=tasks.get(taskId)!
      const result:DagNodeOutcome={nodeId,taskId,attempt,status:mode==='rework'&&nodeId==='a'&&attempt===1?'rework':'accepted',progress:{patchHash:String(attempt),failedCriteriaIds:[],metricValue:attempt,errorFingerprint:null}}
      if(result.status!=='rework')outcomes.set(nodeId,result)
      return result
    },
    async finishDagNode(input){const result:DagNodeOutcome={...input};outcomes.set(input.nodeId,result);return result},
    async finalizeDagMission(){
      assert.equal(active,0,'finalize must await already-started branches')
      return {missionId:id,state:[...outcomes.values()].some(o=>o.status==='escalated')?'ESCALATED':'COMPLETED',taskIds:[...tasks.keys()],blockedNodeIds:nodes.filter(n=>!outcomes.has(n.node_id)).map(n=>n.node_id),nodeOutcomes:[...outcomes.values()]}
    },
  }
  const state={activities,materialized,outcomes,get maxActive(){return maxActive}}
  return state
}

before(async()=>{
  connection=await Connection.connect({address:process.env['TEMPORAL_ADDRESS']??'localhost:7233'})
  native=await NativeConnection.connect({address:process.env['TEMPORAL_ADDRESS']??'localhost:7233'})
  client=new Client({connection})
  const byTask=(taskId:string)=>taskOwners.get(taskId)!.activities
  worker=await Worker.create({connection:native,taskQueue:queue,workflowsPath:resolve('workflows/dag.workflow.ts'),activities:{
    loadDagSchedule:(id:string)=>runs.get(id)!.activities.loadDagSchedule(id),
    materializeDagNode:(input:Parameters<DagActivities['materializeDagNode']>[0])=>runs.get(input.missionId)!.activities.materializeDagNode(input),
    checkDagApproval:(id:string)=>byTask(id).checkDagApproval(id),
    runDagAttempt:(input:{taskId:string})=>byTask(input.taskId).runDagAttempt(input),
    reviewDagAttempt:(input:Parameters<DagActivities['reviewDagAttempt']>[0])=>byTask(input.taskId).reviewDagAttempt(input),
    finishDagNode:(input:Parameters<DagActivities['finishDagNode']>[0])=>runs.get(input.missionId)!.activities.finishDagNode(input),
    finalizeDagMission:(id:string)=>runs.get(id)!.activities.finalizeDagMission(id),
    // S5 旁路回写：本文件只验证调度，回写由 memross-writeback / mission-continuity 覆盖。
    proposeTaskKnowledge:async()=>{},
    recordEscalationHandoff:async()=>{},
  }})
  running=worker.run()
})
after(async()=>{worker?.shutdown();await running;await connection?.close();await native?.close()})

for(const mode of ['normal','rework','failure'] as const) test(`真实 Temporal DAG 调度：${mode}`,async()=>{
  const id=queue+'-'+mode,state=harness(id,mode);runs.set(id,state)
  const result=await client.workflow.execute('dagMissionWorkflow',{workflowId:id,taskQueue:queue,args:[{missionId:id}]}) as DagWorkflowResult
  assert.equal(state.maxActive,2)
  if(mode==='failure') {
    assert.equal(result.state,'ESCALATED')
    // Activity completion order is independent of deterministic Workflow scheduling.
    assert.deepEqual(state.materialized.map(x=>x.nodeId).sort(),['a','b'])
    assert.deepEqual(result.blockedNodeIds,['unused','join'])
  } else {
    assert.equal(result.state,'COMPLETED')
    const join=state.materialized.find(x=>x.nodeId==='join')!
    assert.equal(join.acceptedDeps['a'],`${id}:a:${mode==='rework'?2:1}`)
    assert.equal(join.acceptedDeps['b'],`${id}:b:1`)
    assert.equal(result.taskIds.length,mode==='rework'?4:3)
  }
})
