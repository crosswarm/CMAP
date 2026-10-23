/**
 * Q04 额度续接交接（ADR-0009 §3）：真实 Temporal 上跑 dagMissionWorkflow，真实 dag/v1 Activity + 假 Adapter。
 * 原 Agent 以 QUOTA_EXHAUSTED 结束 → 派生同轮续接任务（不耗返工预算），重新路由时排除原 Agent；
 * 只读级新开工作区，有写副作用的先证明原 Agent 已退出再以原工作区快照为冻结输入，并重新走审批闸口；续接超限升级。
 */
import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'

process.env['NO_PROXY']='localhost,127.0.0.1,::1'
process.env['no_proxy']='localhost,127.0.0.1,::1'

import {createHash} from 'node:crypto'
import {mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {Worker,NativeConnection} from '@temporalio/worker'
import {Client,Connection} from '@temporalio/client'
import {MemoryStore,type Mission,type RemoteTaskBinding,type RiskLevel,type TaskResultV1} from '#domain-model'
import {AdapterError,type NormalizedAgentStatus} from '#adapter-sdk'
import {createActivities} from '../../workflows/activities.ts'
import {createDagActivities} from '../../workflows/dag-activities.ts'
import {FileFakeAdapter,syntheticActivityDeps,syntheticRunner} from './fake-adapter.ts'

const QUEUE=`cmap-quota-handoff-${process.pid}-${Date.now()}`
const ADDRESS=process.env['TEMPORAL_ADDRESS']??'localhost:7233'

/** exhaust 为真时：先在工作区留下半成品，再按触顶退出；exitConfirmed 为假时，交接时的复核观测不到终态。 */
class Agent extends FileFakeAdapter {
  exhaust=false
  exitConfirmed=true
  readonly exhausted=new Set<string>()
  constructor(id:string){
    super()
    Object.defineProperty(this,'adapterId',{value:`${id}-adapter`})
    Object.defineProperty(this,'agentId',{value:id})
  }
  override async getStatus(binding?:RemoteTaskBinding):Promise<NormalizedAgentStatus> {
    if(binding&&this.exhausted.has(binding.remote_task_id)&&!this.exitConfirmed)return {status:'running',at:new Date().toISOString(),terminal_observed:false}
    return super.getStatus()
  }
  override async collectResult(binding:RemoteTaskBinding):Promise<TaskResultV1> {
    if(this.exhaust) {
      const index=this.startCalls.findIndex(e=>'fake:'+e.identity.task_id===binding.remote_task_id)
      const worktree=this.contexts[index]!.worktree!
      await mkdir(join(worktree,'work'),{recursive:true})
      await writeFile(join(worktree,'work','partial.txt'),`partial by ${this.agentId}`)
      this.exhausted.add(binding.remote_task_id)
      throw new AdapterError('QUOTA_EXHAUSTED','额度已耗尽',false,'quota-exhausted:fake')
    }
    return super.collectResult(binding)
  }
}

let conn:Connection,native:NativeConnection,worker:Worker,running:Promise<void>,client:Client,workRoot:string
const store=new MemoryStore()
const primary=new Agent('primary'),backup=new Agent('backup'),other=new Agent('other')

const mission=(id:string,risk:RiskLevel,fallback:string[]):Mission=>({id,tenant:'team-ycc',owner:'crosswarm',type:'inspect',goal:'Q04 续接验证',
  constraints:{risk_level:risk,max_additional_cycles:0,plan:{schema:'cmap/mission-plan/v1',nodes:[
    {node_id:'n1',goal:'节点 n1',capability:'code.analyze',deps:[],criterion_ids:['C1'],risk_level:risk,preferred_agent:'primary',fallback_agents:fallback}]}},
  acceptance:[{criterion_id:'C1',metric:'ok',operator:'eq',expected:1,hard_gate:true}],
  workflow_template:'dag/v1',state:'DRAFT',revision:1,created_at:'2026-10-23T00:00:00.000Z',updated_at:'2026-10-23T00:00:00.000Z'})

before(async()=>{
  workRoot=await mkdtemp(join(tmpdir(),'cmap-quota-handoff-'))
  conn=await Connection.connect({address:ADDRESS,connectTimeout:15_000})
  native=await NativeConnection.connect({address:ADDRESS})
  client=new Client({connection:conn})
  const deps=syntheticActivityDeps({store,adapters:[primary,backup,other],workRoot,runner:syntheticRunner({runner_id:'test-runner'}),pollIntervalMs:1})
  worker=await Worker.create({connection:native,taskQueue:QUEUE,workflowsPath:resolve('workflows/dag.workflow.ts'),
    activities:{...createActivities(deps),...createDagActivities(deps)}})
  running=worker.run()
})
after(async()=>{worker?.shutdown();await running?.catch(()=>{});await conn?.close();await native?.close();if(workRoot)await rm(workRoot,{recursive:true,force:true})})

const reset=()=>{for(const a of [primary,backup,other]){a.exhaust=false;a.exitConfirmed=true}}
const start=async(id:string,risk:RiskLevel,fallback:string[]=['backup'])=>{
  await store.createMission({mission:mission(id,risk,fallback),actor:{type:'system',id:'test'}})
  return client.workflow.start('dagMissionWorkflow',{taskQueue:QUEUE,workflowId:`${QUEUE}-${id}`,args:[{missionId:id}]})
}
const events=async(id:string,type:string)=>(await store.listEvents(id)).filter(e=>e.event_type===type)
const routing=async(id:string,taskId:string)=>(await events(id,'ROUTING_DECIDED')).filter(e=>e.task_id===taskId).map(e=>e.payload as any)
const waitFor=async<T>(read:()=>Promise<T|null|undefined|false>,ms=15_000):Promise<T>=>{
  const deadline=Date.now()+ms
  for(;;){const v=await read();if(v)return v;if(Date.now()>deadline)throw new Error('等待条件超时');await new Promise(r=>setTimeout(r,20))}
}
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex')

test('只读级：A 触顶后派生同轮续接任务，排除 A 派给 B 完成；新开工作区、不耗返工预算、可重放', async()=>{
  reset();primary.exhaust=true
  const id='mis-qh-read'
  const handle=await start(id,'read-meta')
  const result=await handle.result()
  assert.equal(result.state,'COMPLETED','max_additional_cycles=0：若续接耗返工预算会升级')
  const tasks=(await store.queryTasks({missionId:id})).toSorted((a,b)=>a.created_at.localeCompare(b.created_at))
  assert.equal(tasks.length,2)
  const [from,to]=tasks as [typeof tasks[number],typeof tasks[number]]
  assert.equal(from.state,'FAILED_TERMINAL')
  assert.equal(from.result?.error?.code,'QUOTA_EXHAUSTED')
  assert.equal(to.state,'COMPLETED')
  assert.equal(to.attempt,1,'续接与原任务同轮')
  assert.equal(to.supersedes_task_id,from.id)
  assert.equal(to.envelope.identity.supersedes_task_id,from.id)
  const previous=to.envelope.inputs?.previous_attempt
  assert.equal(previous?.supersedes_task_id,from.id)
  assert.equal(previous?.kind,'quota_handoff')
  assert.equal(previous?.failed_criteria[0]?.criterion_id,'TASK-STATUS')
  assert.match(previous!.failed_criteria[0]!.reason,/QUOTA_EXHAUSTED/)
  assert.equal(to.binding?.adapter,'backup-adapter')
  const route=await routing(id,to.id)
  assert.equal(route.length,1)
  assert.deepEqual(route[0].candidates.map((c:any)=>[c.agent_id,c.verdict,c.reason]),[['primary','skipped','quota_handoff_excluded'],['backup','selected',null]])
  const [handoff]=await events(id,'QUOTA_HANDOFF')
  assert.equal((await events(id,'QUOTA_HANDOFF')).length,1)
  assert.deepEqual(handoff!.payload,{schema:'cmap/quota-handoff/v1',node_id:'n1',from_task_id:from.id,to_task_id:to.id,handoff_index:1,
    from_agent:'primary',excluded_agents:['primary'],risk_level:'read-meta',workspace:'fresh',snapshot:null,exit_proof:null})
  await assert.rejects(stat(join(workRoot,to.id,'work','partial.txt')),'只读级新开工作区，不带原工作区内容')
  assert.equal(primary.startCalls.filter(e=>e.identity.mission_id===id).length,1)
  assert.equal(backup.startCalls.filter(e=>e.identity.mission_id===id).length,1)
  await Worker.runReplayHistory({workflowsPath:resolve('workflows/dag.workflow.ts')},await handle.fetchHistory())
})

test('写副作用：证明 A 已退出后以原工作区快照为冻结输入在新工作区解包，续接任务重新走审批', async()=>{
  reset();primary.exhaust=true
  const id='mis-qh-write'
  const handle=await start(id,'mutating')
  const approve=async(taskId:string)=>{
    const approval=await waitFor(async()=>(await store.listPendingApprovals(id)).find(a=>a.task_id===taskId))
    await store.decideApproval(approval.id,'approved','test-harness:human',new Date().toISOString())
    await handle.signal('approvalDecided')
    return approval.id
  }
  const first=await waitFor(async()=>(await store.queryTasks({missionId:id}))[0])
  const firstApproval=await approve(first.id)
  const to=await waitFor(async()=>(await store.queryTasks({missionId:id})).find(t=>t.supersedes_task_id===first.id))
  const secondApproval=await approve(to.id)
  assert.notEqual(secondApproval,firstApproval,'原审批绑定原任务，续接任务另需审批')
  const result=await handle.result()
  assert.equal(result.state,'COMPLETED')
  const [handoff]=await events(id,'QUOTA_HANDOFF')
  const payload=handoff!.payload as any
  assert.equal(payload.workspace,'snapshot')
  assert.equal(payload.exit_proof.terminal_observed,true)
  assert.equal(payload.exit_proof.result_recorded,true)
  const snapshot=(await store.listArtifacts(to.id)).find(a=>a.role==='workspace_snapshot')!
  assert.equal(snapshot.artifact_id,payload.snapshot.artifact_id)
  assert.equal(snapshot.sha256,payload.snapshot.sha256)
  assert.equal(snapshot.provenance['source_task_id'],first.id)
  const ref=(await store.getTask(to.id))!.envelope.inputs!.artifact_refs!.find(r=>r.role==='workspace_snapshot')!
  assert.equal(ref.sha256,snapshot.sha256)
  assert.equal(sha(await readFile(join(workRoot,to.id,ref.uri!))),snapshot.sha256,'冻结输入字节与登记散列一致')
  assert.equal(await readFile(join(workRoot,to.id,'work','partial.txt'),'utf8'),'partial by primary','快照已在新工作区解包')
  assert.notEqual(resolve(workRoot,to.id),resolve(workRoot,first.id),'不共享可写工作区')
})

test('写副作用：观测不到原 Agent 已退出时不续接，节点升级', async()=>{
  reset();primary.exhaust=true;primary.exitConfirmed=false
  const id='mis-qh-unconfirmed'
  const handle=await start(id,'controlled')
  const first=await waitFor(async()=>(await store.listPendingApprovals(id))[0])
  await store.decideApproval(first.id,'approved','test-harness:human',new Date().toISOString())
  await handle.signal('approvalDecided')
  const result=await handle.result()
  assert.equal(result.state,'ESCALATED')
  assert.equal(result.nodeOutcomes[0]?.reason,'QUOTA_HANDOFF_EXIT_UNCONFIRMED')
  assert.equal((await store.queryTasks({missionId:id})).length,1)
  assert.equal((await events(id,'QUOTA_HANDOFF')).length,0)
})

test('Agent 自报 QUOTA_EXHAUSTED 不触发续接：只认 Adapter 的分类，照常按返工预算升级', async()=>{
  reset()
  const id='mis-qh-self-report'
  const collect=primary.collectResult.bind(primary)
  primary.collectResult=async(binding)=>({...await collect(binding),status:'failed',error:{code:'QUOTA_EXHAUSTED',message:'我没额度了',retryable:false,fingerprint:'x'}})
  try {
    const result=await (await start(id,'read-meta')).result()
    assert.equal(result.state,'ESCALATED')
    assert.equal(result.nodeOutcomes[0]?.reason,'BUDGET_EXHAUSTED')
    assert.equal((await events(id,'QUOTA_HANDOFF')).length,0)
    const [task]=await store.queryTasks({missionId:id})
    assert.equal(task!.result?.error?.code,'AGENT_REPORTED_QUOTA_EXHAUSTED')
  } finally { primary.collectResult=collect }
})

test('续接上限 2：A→B→C 都触顶后不再续接，节点升级 QUOTA_HANDOFF_LIMIT', async()=>{
  reset();primary.exhaust=true;backup.exhaust=true;other.exhaust=true
  const id='mis-qh-limit'
  const handle=await start(id,'read-meta',['backup','other'])
  const result=await handle.result()
  assert.equal(result.state,'ESCALATED')
  assert.equal(result.nodeOutcomes[0]?.reason,'QUOTA_HANDOFF_LIMIT')
  const handoffs=(await events(id,'QUOTA_HANDOFF')).map(e=>e.payload as any)
  assert.deepEqual(handoffs.map(h=>[h.handoff_index,h.from_agent,h.excluded_agents]),[[1,'primary',['primary']],[2,'backup',['primary','backup']]])
  const tasks=await store.queryTasks({missionId:id})
  assert.equal(tasks.length,3)
  assert.ok(tasks.every(t=>t.state==='FAILED_TERMINAL'))
})
