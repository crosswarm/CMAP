/**
 * S5 多任务衔接 / 协作 / 交接 / 续接：真实 Temporal 上跑 missionWorkflow，假 Adapter + 假 Memross。
 * 判据只认账本状态、事件与调用次数。真实 Agent 与真实 Memross 由 scripts/e2e-continuity.mjs 覆盖。
 */
import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'

process.env['NO_PROXY']='localhost,127.0.0.1,::1'
process.env['no_proxy']='localhost,127.0.0.1,::1'

import {Worker,NativeConnection} from '@temporalio/worker'
import {Client,Connection} from '@temporalio/client'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {MemoryStore,type Mission,type RemoteTaskBinding,type TaskResultV1} from '#domain-model'
import {AdapterError,type NormalizedAgentStatus} from '#adapter-sdk'
import {createActivities} from '../../workflows/activities.ts'
import {createDagActivities} from '../../workflows/dag-activities.ts'
import {FileFakeAdapter,syntheticActivityDeps,syntheticRunner} from './fake-adapter.ts'
import {fakeMemrossServer} from './fake-memross.ts'

const QUEUE=`cmap-continuity-${process.pid}-${Date.now()}`
const ADDRESS=process.env['TEMPORAL_ADDRESS']??'localhost:7233'

/** 结果附带可复用结论，驱动 propose；hold 时一直运行，直到被 cancel。 */
class FindingAdapter extends FileFakeAdapter {
  hold=false
  readonly canceled=new Set<string>()
  override async getStatus(binding?:RemoteTaskBinding):Promise<NormalizedAgentStatus> {
    const at=new Date().toISOString()
    if(binding&&this.canceled.has(binding.remote_task_id))return {status:'canceled',at,terminal_observed:true}
    if(this.hold)return {status:'running',at,terminal_observed:false}
    return super.getStatus()
  }
  override async cancel(binding:RemoteTaskBinding):Promise<void> {
    await super.cancel(binding)
    this.canceled.add(binding.remote_task_id)
  }
  override async collectResult(binding:RemoteTaskBinding):Promise<TaskResultV1> {
    if(this.canceled.has(binding.remote_task_id))throw new AdapterError('TASK_CANCELED','已取消',false,'task-canceled')
    const result=await super.collectResult(binding)
    return {...result,findings:[{severity:'medium',code:'READBACK',description:'写回后必须回读持久化结果'}]}
  }
}

let conn:Connection,native:NativeConnection,worker:Worker,running:Promise<void>,client:Client,dagWorker:Worker,dagRunning:Promise<void>
const store=new MemoryStore()
const adapter=new FindingAdapter()
const memross=fakeMemrossServer()
let workRoot:string

const mission=(id:string,constraints:Record<string,unknown>={}):Mission=>({id,tenant:'team-ycc',owner:'crosswarm',type:'inspect',goal:'S5 衔接验证',
  constraints:{risk_level:'read-meta',memory:{project_id:'prj_a',limit:3},...constraints},
  acceptance:[{criterion_id:'C1',metric:'ok',operator:'eq',expected:1,hard_gate:true}],
  workflow_template:'inspect/v1',state:'DRAFT',revision:1,created_at:'2026-10-18T00:00:00.000Z',updated_at:'2026-10-18T00:00:00.000Z'})

before(async()=>{
  workRoot=await mkdtemp(join(tmpdir(),'cmap-continuity-'))
  conn=await Connection.connect({address:ADDRESS,connectTimeout:15_000})
  native=await NativeConnection.connect({address:ADDRESS})
  client=new Client({connection:conn})
  worker=await Worker.create({connection:native,taskQueue:QUEUE,workflowsPath:resolve('workflows/mission.workflow.ts'),
    activities:createActivities(syntheticActivityDeps({store,adapter,workRoot,runner:syntheticRunner({runner_id:'test-runner'}),pollIntervalMs:1,approvalPollIntervalMs:5,memory:memross.memory}))})
  running=worker.run()
  const dagDeps=syntheticActivityDeps({store,adapter,workRoot,runner:syntheticRunner({runner_id:'test-runner'}),pollIntervalMs:1})
  dagWorker=await Worker.create({connection:native,taskQueue:`${QUEUE}-dag`,workflowsPath:resolve('workflows/dag.workflow.ts'),
    activities:{...createActivities(dagDeps),...createDagActivities(dagDeps)}})
  dagRunning=dagWorker.run()
})
after(async()=>{worker?.shutdown();dagWorker?.shutdown();await running?.catch(()=>{});await dagRunning?.catch(()=>{});await conn?.close();await native?.close();if(workRoot)await rm(workRoot,{recursive:true,force:true})})

const execute=(missionId:string)=>client.workflow.execute('missionWorkflow',{taskQueue:QUEUE,workflowId:`${QUEUE}-${missionId}`,args:[{missionId}]})

test('协作：REVIEW_ACCEPTED 后把可复用结论提交 Memross propose，Mission 仍 COMPLETED', async()=>{
  await store.createMission({mission:mission('mis-cont-propose'),actor:{type:'system',id:'test'}})
  const before=memross.calls.length
  const result=await execute('mis-cont-propose')
  assert.equal(result.state,'COMPLETED')
  const proposes=memross.calls.slice(before).filter(c=>c.path==='/api/memory/v1/propose')
  assert.equal(proposes.length,1)
  assert.equal(proposes[0]!.body.kind,'pitfall')
  assert.ok(proposes[0]!.body.evidence.some((e:any)=>e.uri.startsWith('cmap-artifact:')))
  assert.ok(proposes[0]!.body.evidence.some((e:any)=>e.uri.startsWith('memross-block:')))
  const events=await store.listEvents('mis-cont-propose')
  assert.equal(events.filter(e=>e.event_type==='KNOWLEDGE_PROPOSED').length,1)
})

test('交接：返工预算耗尽升级时自动写 Memross 交接记录，升级结果不变', async()=>{
  await store.createMission({mission:mission('mis-cont-handoff',{max_additional_cycles:0}),actor:{type:'system',id:'test'}})
  adapter.failNext=1
  const before=memross.calls.length
  const result=await execute('mis-cont-handoff')
  assert.equal(result.state,'ESCALATED')
  const handoffs=memross.calls.slice(before).filter(c=>c.path==='/api/memory/v1/handoff')
  assert.equal(handoffs.length,1)
  assert.equal(handoffs[0]!.body.op,'put')
  assert.deepEqual(handoffs[0]!.body.refs.mission_ids,['mis-cont-handoff'])
  assert.ok(handoffs[0]!.body.failed_attempts.some((x:string)=>x.includes('C1')))
  assert.equal((await store.getMission('mis-cont-handoff'))!.state,'ESCALATED')
  assert.equal((await store.listEvents('mis-cont-handoff')).filter(e=>e.event_type==='HANDOFF_RECORDED').length,1)
  assert.equal(memross.calls.slice(before).filter(c=>c.path==='/api/memory/v1/propose').length,0,'未通过的结论不提交')
})

const waitFor=async<T>(read:()=>Promise<T|null|undefined|false>,ms=10_000):Promise<T>=>{
  const deadline=Date.now()+ms
  for(;;){const v=await read();if(v)return v;if(Date.now()>deadline)throw new Error('等待条件超时');await new Promise(r=>setTimeout(r,20))}
}

test('取消：等审批的未绑定任务直接取消，审批过期，Adapter 从未启动', async()=>{
  await store.createMission({mission:mission('mis-cont-cancel-unbound',{risk_level:'controlled'}),actor:{type:'system',id:'test'}})
  const starts=adapter.startCalls.length
  const handle=await client.workflow.start('missionWorkflow',{taskQueue:QUEUE,workflowId:`${QUEUE}-cancel-unbound`,args:[{missionId:'mis-cont-cancel-unbound'}]})
  const approval=await waitFor(async()=>(await store.listPendingApprovals('mis-cont-cancel-unbound'))[0])
  await handle.signal('cancelMission',{reason:'需求取消'})
  const result=await handle.result()
  assert.equal(result.state,'CANCELED')
  assert.equal((await store.getMission('mis-cont-cancel-unbound'))!.state,'CANCELED')
  assert.equal((await store.getTask(approval.task_id))!.state,'CANCELED')
  assert.equal((await store.getApproval(approval.id))!.decision,'expired')
  assert.equal(adapter.startCalls.length,starts,'未绑定任务不派发')
  const canceled=(await store.listEvents('mis-cont-cancel-unbound')).filter(e=>e.event_type==='TASK_CANCELED')
  assert.equal(canceled[0]!.payload['reason'],'MISSION_CANCELED')
})

test('取消：已绑定任务调用 Adapter cancel，确认后落 CANCELED 并记 TASK_CANCEL_REQUESTED', async()=>{
  await store.createMission({mission:mission('mis-cont-cancel-bound'),actor:{type:'system',id:'test'}})
  adapter.hold=true
  try {
    const handle=await client.workflow.start('missionWorkflow',{taskQueue:QUEUE,workflowId:`${QUEUE}-cancel-bound`,args:[{missionId:'mis-cont-cancel-bound'}]})
    const task=await waitFor(async()=>(await store.queryTasks({missionId:'mis-cont-cancel-bound'})).find(t=>t.binding&&t.state==='RUNNING'))
    await handle.signal('cancelMission',{reason:'需求取消'})
    const result=await handle.result()
    assert.equal(result.state,'CANCELED')
    assert.ok(adapter.cancelCalls.some(b=>b.remote_task_id===task.binding!.remote_task_id))
    assert.equal((await store.getTask(task.id))!.state,'CANCELED')
    const requested=(await store.listEvents('mis-cont-cancel-bound')).filter(e=>e.event_type==='TASK_CANCEL_REQUESTED')
    assert.equal(requested.length,1)
    assert.equal(requested[0]!.payload['confirmed'],true)
    assert.equal((await store.getMission('mis-cont-cancel-bound'))!.state,'CANCELED')
  } finally { adapter.hold=false }
})

test('取消：DAG 运行中节点收到 Adapter cancel，Mission 落 CANCELED', async()=>{
  const id='mis-cont-cancel-dag'
  await store.createMission({mission:{...mission(id,{max_additional_cycles:1,memory:undefined,
    plan:{schema:'cmap/mission-plan/v1',nodes:[{node_id:'a',goal:'节点 a',capability:'code.analyze',deps:[],criterion_ids:['C1'],risk_level:'read-meta'}]}}),
    workflow_template:'dag/v1'},actor:{type:'system',id:'test'}})
  adapter.hold=true
  try {
    const handle=await client.workflow.start('dagMissionWorkflow',{taskQueue:`${QUEUE}-dag`,workflowId:`${QUEUE}-cancel-dag`,args:[{missionId:id}]})
    const task=await waitFor(async()=>(await store.queryTasks({missionId:id})).find(t=>t.binding&&t.state==='RUNNING'))
    await handle.signal('cancelMission',{reason:'需求取消'})
    const result=await handle.result()
    assert.equal(result.state,'CANCELED')
    assert.ok(adapter.cancelCalls.some(b=>b.remote_task_id===task.binding!.remote_task_id))
    assert.equal((await store.getTask(task.id))!.state,'CANCELED')
    assert.equal((await store.getMission(id))!.state,'CANCELED')
  } finally { adapter.hold=false }
})

test('续作：continues_mission_id 的首任务带上一 Mission 已接受产物、交接与记忆快照完成', async()=>{
  await store.createMission({mission:mission('mis-cont-source'),actor:{type:'system',id:'test'}})
  const source=await execute('mis-cont-source')
  assert.equal(source.state,'COMPLETED')
  const sourceReport=(await store.listArtifacts(source.taskIds[0]!)).find(a=>a.role==='report')!
  await store.createMission({mission:mission('mis-cont-next',{continues_mission_id:'mis-cont-source',memory:undefined}),actor:{type:'system',id:'test'}})
  const result=await execute('mis-cont-next')
  assert.equal(result.state,'COMPLETED')
  const first=(await store.getTask(result.taskIds[0]!))!
  const refs=first.envelope.inputs!.artifact_refs!
  assert.deepEqual(refs.filter(r=>r.role==='continuation_input').map(r=>r.sha256),[sourceReport.sha256])
  assert.equal(refs.filter(r=>r.role==='continuation_memory').length,1)
  assert.equal(refs.filter(r=>r.role==='handoff').length,1)
  const sent=adapter.startCalls.find(e=>e.identity.task_id===first.id)!
  assert.deepEqual(sent.inputs?.artifact_refs,refs,'派发给 Agent 的信封带着同一组冻结输入')
})
