import {test} from 'node:test'
import assert from 'node:assert/strict'
import {MemoryStore} from '#domain-model'
import type {Mission,TaskEnvelopeV1,RemoteTaskBinding} from '#domain-model'
import type {DispatchContext} from '#adapter-sdk'
import {FakeAdapter, syntheticRunner} from './fake-adapter.ts'
import {createActivities} from '../../workflows/activities.ts'

const actor={type:'system',id:'prepared-test'} as const
const policy='a'.repeat(64)
class PreparedAdapter extends FakeAdapter {
  sends=0
  observations: Array<{state:string|undefined,bound:boolean,intents:number,guard:boolean}>=[]
  before: (()=>Promise<void>)|undefined
  reportedPolicy:string|undefined=policy
  loseAcknowledgement=false
  constructor(readonlyStore:MemoryStore) {
    super();this.store=readonlyStore
    Object.defineProperty(this,'adapterId',{value:'yonwork-adapter'})
    Object.defineProperty(this,'agentId',{value:'yonwork:cmap-test'})
  }
  readonly store:MemoryStore
  override async discover(){return {...await super.discover(),adapter_id:this.adapterId,agent_id:this.agentId,capabilities:['yonwork.validate'],risk_ceiling:'controlled' as const}}
  prepareBinding(e:TaskEnvelopeV1,ctx:DispatchContext):RemoteTaskBinding {
    return {adapter:this.adapterId,remote_task_id:'run-'+e.identity.task_id,remote_context_id:'agent:cmap-test:explicit:'+e.identity.task_id,protocol:'yonwork-host-sse',protocol_version:'1',runner_id:ctx.runner_id}
  }
  override async startTask(e:TaskEnvelopeV1,ctx:DispatchContext){
    const binding=this.prepareBinding(e,ctx)
    await this.before?.()
    await ctx.beforeSend?.(binding,this.reportedPolicy)
    const saved=await this.store.getTask(e.identity.task_id)
    this.observations.push({state:saved?.state,bound:!!saved?.binding,intents:(await this.store.listEvents(e.identity.mission_id)).filter(x=>x.event_type==='TASK_DISPATCH_INTENT').length,guard:!!ctx.beforeSend})
    this.sends++
    if(this.loseAcknowledgement)throw new Error('simulated lost acknowledgement')
    return binding
  }
}
async function fixture({approved=true,lock=true,lockRunner='runner',expired=false}={}) {
  const store=new MemoryStore(),adapter=new PreparedAdapter(store),now=new Date().toISOString()
  const mission:Mission={id:'mis-prepared',tenant:'test',owner:'test-harness',type:'inspect',goal:'synthetic controlled test',constraints:{},acceptance:[{criterion_id:'C',metric:'value',operator:'eq',expected:true,hard_gate:true}],workflow_template:'dag/v1',state:'RUNNING',revision:1,created_at:now,updated_at:now}
  await store.createMission({mission,actor})
  const envelope:TaskEnvelopeV1={schema:'cmap/task-envelope/v1',identity:{mission_id:mission.id,task_id:'prepared',idempotency_key:'prepared',revision:1,tenant:mission.tenant,owner:mission.owner},classification:{task_type:'inspect',requested_capability:'yonwork.validate',risk_level:'controlled'},goal:{statement:mission.goal,success_definition:[{criterion_id:'C',metric:'value',operator:'eq',expected:true,hard_gate:true}]},inputs:{parameters:{yonwork_policy_sha256:policy}},environment:{},execution_policy:{timeout_seconds:30,max_attempts:1,preferred_agent:'yonwork:cmap-test',required_resource_locks:[{resource:'yonwork:host',ttl_seconds:15}]},permissions:{forbidden:[],yonwork:{chat_send:true}},evidence_requirements:{required_artifact_roles:['report']},output_contract:{schema_uri:'https://cmap.local/schemas/task-result/v1'}}
  await store.createTask({actor,task:{id:'prepared',mission_id:mission.id,parent_task_id:null,supersedes_task_id:null,capability:'yonwork.validate',risk:'controlled',state:'DRAFT',attempt:1,max_attempts:1,lamport:0,envelope,result:null,binding:null,deps:[],created_at:now,updated_at:now}})
  const acts=createActivities({store,adapter,runner: syntheticRunner({ runner_id: 'runner' }),approvalPollIntervalMs:1})
  await acts.markReady('prepared')
  const gate=await acts.requestApproval('prepared')
  if(approved){
    // Synthetic authority applies only to this fake Adapter; no live Host calls.
    await store.decideApproval(gate.approvalId!,'approved','test-harness:human',new Date().toISOString())
    await acts.waitForApproval({taskId:'prepared',approvalId:gate.approvalId!,scope:'controlled'})
  }
  if(lock)await store.acquireLock({lock_id:'owned',resource:'yonwork:host',task_id:'prepared',mission_id:mission.id,holder_runner_id:lockRunner,acquired_at:expired?new Date(Date.now()-5000).toISOString():now,expires_at:new Date(Date.now()+(expired?-1000:60000)).toISOString(),released_at:null})
  return {store,adapter,acts}
}

test('prepared dispatch persists RUNNING/intent before send and supplies the final guard',async()=>{
  const {store,adapter,acts}=await fixture()
  await acts.dispatchTask('prepared')
  assert.deepEqual(adapter.observations,[{state:'RUNNING',bound:true,intents:1,guard:true}])
  assert.equal((await store.getTask('prepared'))?.binding?.remote_task_id,'run-prepared')
  assert.equal((await store.listEvents('mis-prepared')).filter(x=>x.event_type==='TASK_STARTED').length,1)
})
test('pending approval and unheld/wrong/expired leases never send',async()=>{
  for(const options of [{approved:false},{lock:false},{lockRunner:'other'},{expired:true}]){
    const {adapter,acts}=await fixture(options)
    await acts.dispatchTask('prepared').catch(()=>undefined)
    assert.equal(adapter.sends,0,JSON.stringify(options))
  }
})
test('post-preparation policy/lease drift prevents send but keeps durable intent',async()=>{
  for(const change of ['policy','missing-policy','lease']){
    const {store,adapter,acts}=await fixture()
    if(change==='policy')adapter.reportedPolicy='b'.repeat(64)
    else if(change==='missing-policy')adapter.reportedPolicy=undefined
    else adapter.before=()=>store.releaseLock('owned',new Date().toISOString())
    await assert.rejects(()=>acts.dispatchTask('prepared'))
    assert.equal(adapter.sends,0)
    assert.equal((await store.getTask('prepared'))?.state,'RUNNING')
    assert.ok((await store.getTask('prepared'))?.binding)
  }
})
test('uncertain acceptance with a persisted intent never redispatches through a fresh adapter',async()=>{
  const {store,adapter,acts}=await fixture();adapter.loseAcknowledgement=true
  await assert.rejects(()=>acts.dispatchTask('prepared'))
  const next=new PreparedAdapter(store)
  const fresh=createActivities({store,adapter:next,runner: syntheticRunner({ runner_id: 'runner' })})
  assert.equal((await fresh.dispatchTask('prepared')).dispatched,false)
  assert.equal(adapter.sends,1)
  assert.equal(next.sends,0)
})

test('lost TASK_STARTED write retains intent and recovery never resends or invents acknowledgement',async()=>{
  const {store,adapter,acts}=await fixture()
  const append=store.appendEvent.bind(store)
  store.appendEvent=async input=>{
    if(input.event.event_type==='TASK_STARTED')throw new Error('started receipt unavailable')
    return append(input)
  }
  await assert.rejects(()=>acts.dispatchTask('prepared'),/started receipt unavailable/)
  store.appendEvent=append
  const next=new PreparedAdapter(store)
  const fresh=createActivities({store,adapter:next,runner:syntheticRunner({runner_id:'runner'})})
  assert.equal((await fresh.dispatchTask('prepared')).dispatched,false)
  assert.equal(adapter.sends,1)
  assert.equal(next.sends,0)
  const events=await store.listEvents('mis-prepared')
  assert.equal(events.filter(e=>e.event_type==='TASK_DISPATCH_INTENT').length,1)
  assert.equal(events.filter(e=>e.event_type==='TASK_STARTED').length,0)
})

test('wrong scope, expired and self-issued approvals cannot dispatch',async()=>{
  for(const patch of [
    {scope:'mutating' as const},
    {task_id:'another-task'},
    {mission_id:'another-mission'},
    {expires_at:new Date(Date.now()-1000).toISOString()},
    {decided_by:'agent:yonwork'},
    {decided_by:'system:jev'},
    {decided_at:new Date(Date.now()+60000).toISOString()},
  ]){
    const {store,adapter,acts}=await fixture()
    const getApproval=store.getApproval.bind(store)
    store.getApproval=async id=>{
      const approval=await getApproval(id)
      return approval?{...approval,...patch}:approval
    }
    assert.deepEqual(await acts.dispatchTask('prepared'),{dispatched:false,admissionDenied:{phase:'initial',code:'APPROVAL_INVALID'}})
    assert.equal(adapter.sends,0)
    assert.equal((await store.getTask('prepared'))?.binding,null)
  }
})

test('concurrent dispatch claims permit only one external send',async()=>{
  const {store,adapter,acts}=await fixture()
  const results=await Promise.allSettled([acts.dispatchTask('prepared'),acts.dispatchTask('prepared')])
  assert.ok(results.some(result=>result.status==='fulfilled'&&result.value.dispatched))
  assert.equal(adapter.sends,1)
  assert.equal((await store.listEvents('mis-prepared')).filter(event=>event.event_type==='TASK_DISPATCH_INTENT').length,1)
})

test('captured YonWork reports are restricted/unassessed, never asserted clean by model data',async()=>{
  const {store,acts}=await fixture()
  await acts.dispatchTask('prepared')
  await store.setTaskResult('prepared',{schema:'cmap/task-result/v1',mission_id:'mis-prepared',task_id:'prepared',attempt:1,status:'completed',summary:'fixture',criterion_results:[{criterion_id:'C',actual:true,passed:true}],artifacts:[{artifact_id:'prepared:report',role:'report',uri:'evidence/report.json',sha256:'a'.repeat(64),size_bytes:2}]})
  await acts.collectTaskResult('prepared')
  const report=(await store.listArtifacts('prepared'))[0]!
  assert.equal(report.security.classification,'restricted')
  assert.equal(report.security.contains_secrets,true)
  assert.equal(report.security.contains_pii,true)
  assert.equal(report.provenance['content_assessment'],'unassessed')
})
