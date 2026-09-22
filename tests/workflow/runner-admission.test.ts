import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, type Mission, type RunnerDescriptor, type TaskEnvelopeV1, type RemoteTaskBinding } from '#domain-model'
import type { DispatchContext } from '#adapter-sdk'
import { createActivities } from '../../workflows/activities.ts'
import { createDagAttemptRunner } from '../../workflows/dag-attempt.ts'
import { FakeAdapter } from './fake-adapter.ts'

const actor = {type:'system',id:'runner-admission-test'} as const
const runner = ():RunnerDescriptor => ({
  runner_id:'admission-runner',tenant:'test',host:'test-host',agents:['fake'],resources:[],health:'healthy',
  last_heartbeat_at:new Date().toISOString(),admission:{allowed_tenants:['test'],allowed_owners:['allowed-user'],allowed_capabilities:['code.analyze'],max_risk:'read-meta'},
})
async function fixture(owner='denied-user', ready=true) {
  const store=new MemoryStore(),adapter=new FakeAdapter(),workRoot=await mkdtemp(join(tmpdir(),'cmap-admission-'))
  const calls={discover:0,health:0}
  const discover=adapter.discover.bind(adapter),health=adapter.health.bind(adapter)
  adapter.discover=async()=>{calls.discover++;return discover()}
  adapter.health=async()=>{calls.health++;return health()}
  const at=new Date().toISOString()
  const mission:Mission={id:'mis-admission',tenant:'test',owner,type:'inspect',goal:'synthetic admission check',constraints:{},acceptance:[{criterion_id:'C',metric:'value',operator:'eq',expected:true,hard_gate:true}],workflow_template:'inspect/v1',state:'RUNNING',revision:1,created_at:at,updated_at:at}
  await store.createMission({mission,actor})
  const deps={store,adapter,runner:runner(),workRoot}
  const acts=createActivities(deps)
  const {taskId}=await acts.createTask({missionId:mission.id,capability:'code.analyze'})
  if(ready)await acts.markReady(taskId)
  return {store,adapter,workRoot,acts,taskId,deps,calls}
}

test('a host grant cannot start a draft or approval-waiting task',async t=>{
  for(const state of ['DRAFT','APPROVAL_REQUIRED']) {
    const f=await fixture('allowed-user',state!=='DRAFT');t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
    if(state==='APPROVAL_REQUIRED')await f.store.transitionTask({taskId:f.taskId,to:'APPROVAL_REQUIRED',actor,eventType:'APPROVAL_REQUESTED',idempotencyKey:'waiting'})
    await assert.rejects(()=>f.acts.dispatchTask(f.taskId))
    assert.equal(f.adapter.startCalls.length,0,state)
    assert.deepEqual(f.calls,{discover:0,health:0})
    assert.deepEqual(await readdir(f.workRoot),[])
    assert.equal((await f.store.getTask(f.taskId))?.binding,null)
    assert.equal((await f.store.getTask(f.taskId))?.state,state)
  }
})

test('dispatch rechecks a task entering approval wait during Adapter health',async t=>{
  const f=await fixture('allowed-user');t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
  const health=f.adapter.health.bind(f.adapter)
  f.adapter.health=async()=>{
    await f.store.transitionTask({taskId:f.taskId,to:'APPROVAL_REQUIRED',actor,eventType:'APPROVAL_REQUESTED',idempotencyKey:'late-wait'})
    return health()
  }
  await assert.rejects(()=>f.acts.dispatchTask(f.taskId),/TASK_NOT_DISPATCHABLE/)
  assert.equal(f.adapter.startCalls.length,0)
  assert.deepEqual(await readdir(f.workRoot),[])
})

test('runner denies owner before Adapter launch, binding, assignment or work directory',async t=>{
  const f=await fixture();t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
  const result=await f.acts.dispatchTask(f.taskId)
  assert.deepEqual(result,{dispatched:false,admissionDenied:{phase:'initial',code:'OWNER_DENIED'}})
  assert.equal(f.adapter.startCalls.length,0)
  assert.deepEqual(f.calls,{discover:0,health:0})
  assert.deepEqual(await readdir(f.workRoot),[])
  const task=await f.store.getTask(f.taskId)
  assert.equal(task?.state,'CANCELED')
  assert.equal(task?.binding,null)
  const events=await f.store.listEvents('mis-admission')
  assert.equal(events.some(e=>['TASK_ASSIGNED','TASK_STARTED'].includes(e.event_type)),false)
  assert.equal(events.filter(e=>e.idempotency_key===`runner-admission:${f.taskId}`).length,1)
})

test('persisted initial denial replays after policy loosens and after commit-before-return crash',async t=>{
  const f=await fixture();t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
  const transition=f.store.transitionTask.bind(f.store)
  let lost=true
  f.store.transitionTask=async input=>{
    const result=await transition(input)
    if(lost&&input.idempotencyKey===`runner-admission:${f.taskId}`){lost=false;throw new Error('synthetic lost receipt return')}
    return result
  }
  await assert.rejects(()=>f.acts.dispatchTask(f.taskId),/synthetic lost receipt return/)
  const relaxed=runner()
  const fresh=createActivities({...f.deps,runner:{...relaxed,admission:{...relaxed.admission,allowed_owners:['allowed-user','denied-user']}}})
  const a=await fresh.dispatchTask(f.taskId),b=await fresh.dispatchTask(f.taskId)
  assert.deepEqual(a,{dispatched:false,admissionDenied:{phase:'initial',code:'OWNER_DENIED'}})
  assert.equal(JSON.stringify(a),JSON.stringify(b))
  assert.equal(f.adapter.startCalls.length,0)
})

test('matching explicit grant preserves real dispatch semantics',async t=>{
  const f=await fixture('allowed-user');t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
  assert.equal((await f.acts.dispatchTask(f.taskId)).dispatched,true)
  assert.equal(f.adapter.startCalls.length,1)
  assert.equal(f.adapter.contexts[0]?.runner_id,'admission-runner')
})

class Prepared extends FakeAdapter {
  before: (()=>void)|undefined
  constructor(){super();Object.defineProperty(this,'adapterId',{value:'yonwork-adapter'});Object.defineProperty(this,'agentId',{value:'yonwork:cmap-test'})}
  override async discover(){return {...await super.discover(),adapter_id:this.adapterId,agent_id:this.agentId,capabilities:['yonwork.validate']}}
  prepareBinding(e:TaskEnvelopeV1,ctx:DispatchContext):RemoteTaskBinding{return {adapter:this.adapterId,remote_task_id:`prepared:${e.identity.task_id}`,protocol:'yonwork-host-sse',protocol_version:'1',runner_id:ctx.runner_id}}
  override async startTask(e:TaskEnvelopeV1,ctx:DispatchContext){
    const binding=this.prepareBinding(e,ctx)
    this.before?.()
    await ctx.beforeSend!(binding,'a'.repeat(64))
    this.startCalls.push(e)
    return binding
  }
}

test('post-intent denial receipt outranks binding recovery, survives a lost return, and stops result polling',async t=>{
  for(const crash of [false,true]) {
    const f=await fixture('allowed-user');t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
    const base=(await f.store.getTask(f.taskId))!,id=base.id+'-prepared'
    const adapter=new Prepared(),policy=runner()
    const admitted={...policy,agents:[adapter.agentId],admission:{...policy.admission,allowed_capabilities:['yonwork.validate'],max_risk:'controlled' as const}}
    const envelope:TaskEnvelopeV1={...base.envelope,identity:{...base.envelope.identity,task_id:id,idempotency_key:id},classification:{...base.envelope.classification,requested_capability:'yonwork.validate',risk_level:'controlled'},inputs:{parameters:{yonwork_policy_sha256:'a'.repeat(64)}},execution_policy:{...base.envelope.execution_policy,preferred_agent:adapter.agentId,required_resource_locks:[{resource:'yonwork:host',ttl_seconds:15}]},permissions:{forbidden:[],yonwork:{chat_send:true}}}
    await f.store.createTask({actor,task:{...base,id,state:'DRAFT',capability:'yonwork.validate',risk:'controlled',envelope}})
    const acts=createActivities({store:f.store,adapter,runner:admitted,workRoot:f.workRoot})
    await acts.markReady(id)
    const gate=await acts.requestApproval(id)
    // Synthetic approval belongs only to this fake Adapter; no live YonWork call.
    await f.store.decideApproval(gate.approvalId!,'approved','test-harness:human',new Date().toISOString())
    await acts.waitForApproval({taskId:id,approvalId:gate.approvalId!,scope:'controlled'})
    await f.store.acquireLock({lock_id:'owned',resource:'yonwork:host',task_id:id,mission_id:base.mission_id,holder_runner_id:admitted.runner_id,acquired_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString(),released_at:null})
    const getMission=f.store.getMission.bind(f.store)
    adapter.before=()=>{f.store.getMission=async key=>{const m=await getMission(key);return m?{...m,owner:'changed-owner'}:null}}
    const transition=f.store.transitionTask.bind(f.store)
    let lose=crash
    f.store.transitionTask=async input=>{const task=await transition(input);if(lose&&input.idempotencyKey===`runner-admission:${id}`){lose=false;throw new Error('synthetic revoked receipt return lost')}return task}
    const expected={dispatched:false,admissionDenied:{phase:'post-intent',code:'IDENTITY_MISMATCH'}}
    if(crash)await assert.rejects(()=>acts.dispatchTask(id),/receipt return lost/)
    else assert.deepEqual(await acts.dispatchTask(id),expected)
    f.store.getMission=getMission
    const fresh=createActivities({store:f.store,adapter,runner:admitted,workRoot:f.workRoot})
    assert.deepEqual(await fresh.dispatchTask(id),expected)
    assert.deepEqual(await fresh.dispatchTask(id),expected)
    assert.equal((await f.store.getTask(id))?.state,'FAILED_TERMINAL')
    assert.ok((await f.store.getTask(id))?.binding)
    assert.equal(adapter.startCalls.length,0)
    assert.deepEqual((await fresh.collectTaskResult(id)).admissionDenied,expected.admissionDenied)
  }
})

test('caller mutation cannot expand a captured runner grant',async t=>{
  const f=await fixture();t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
  ;(f.deps.runner.admission.allowed_owners as string[]).push('denied-user')
  assert.deepEqual(await f.acts.dispatchTask(f.taskId),{dispatched:false,admissionDenied:{phase:'initial',code:'OWNER_DENIED'}})
  assert.equal(f.adapter.startCalls.length,0)
})

test('an existing unbound DAG attempt is denied before resource acquisition',async t=>{
  const f=await fixture();t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
  const base=(await f.store.getTask(f.taskId))!,id=base.id+'-locked'
  await f.store.createTask({actor,task:{...base,id,envelope:{...base.envelope,identity:{...base.envelope.identity,task_id:id,idempotency_key:id},execution_policy:{...base.envelope.execution_policy,required_resource_locks:[{resource:'test:exclusive',ttl_seconds:15}]}}}})
  let acquisitions=0
  const acquire=f.store.acquireLock.bind(f.store)
  f.store.acquireLock=async lock=>{acquisitions++;return acquire(lock)}
  const attempt=createDagAttemptRunner(f.deps)
  assert.deepEqual(await attempt({taskId:id}),{outcome:'escalated',taskId:id,reason:'RUNNER_ADMISSION_DENIED:OWNER_DENIED'})
  assert.equal(acquisitions,0)
  assert.equal(f.adapter.startCalls.length,0)
  assert.deepEqual(await readdir(f.workRoot),[])
})

test('malformed denial receipt and unrelated terminal state never restart a task',async t=>{
  for(const malformed of [false,true]) {
    const f=await fixture('allowed-user');t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
    await f.store.transitionTask({taskId:f.taskId,to:'CANCELED',actor,eventType:'TASK_CANCELED',idempotencyKey:malformed?`runner-admission:${f.taskId}`:'other-cancel',payload:malformed?{phase:'initial',code:'UNTRUSTED_CODE'}:{}})
    await assert.rejects(()=>f.acts.dispatchTask(f.taskId),malformed?/RUNNER_ADMISSION_RECEIPT_INVALID/:/TASK_NOT_DISPATCHABLE/)
    assert.equal(f.adapter.startCalls.length,0)
  }
})

test('legacy result polling cancels its known binding when admission ledger reads fail',async t=>{
  for(const failure of ['task','events']) {
  const f=await fixture('allowed-user');t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
  await f.acts.dispatchTask(f.taskId)
  const getTask=f.store.getTask.bind(f.store)
  let reads=0
  if(failure==='task')f.store.getTask=async id=>{if(++reads===2)throw new Error('synthetic ledger failure');return getTask(id)}
  else f.store.listEvents=async()=>{throw new Error('synthetic event read failure')}
  await assert.rejects(()=>f.acts.collectTaskResult(f.taskId))
  assert.equal(f.adapter.cancelCalls.length,1)
  assert.equal(f.adapter.cancelCalls[0]?.remote_task_id,`fake:${f.taskId}`)
  }
})
