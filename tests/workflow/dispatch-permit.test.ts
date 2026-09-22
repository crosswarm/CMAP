import assert from 'node:assert/strict'
import {test} from 'node:test'
import {generateKeyPairSync} from 'node:crypto'
import {MemoryStore, issueDispatchPermit, verifyDispatchPermit, type RunnerDescriptor, type TaskEnvelopeV1} from '#domain-model'
import {AdapterError, type AgentAdapter, type DispatchContext} from '#adapter-sdk'
import {createActivities, type ActivityDeps} from '../../workflows/activities.ts'
import {CodexAdapter} from '../../adapters/codex-adapter/src/index.ts'

const runner:RunnerDescriptor={
  runner_id:'permit-test',tenant:'test',host:'local',agents:['fixture'],resources:[],
  admission:{allowed_tenants:['test'],allowed_owners:['test'],allowed_capabilities:['code.analyze'],max_risk:'read-meta'},
  health:'healthy',last_heartbeat_at:'2026-09-22T00:00:00.000Z',
}
// These objects only test composition rejection; no provider method may run.
const candidate=(patch:Record<string,unknown>={}):AgentAdapter=>({
  adapterId:'fixture',agentId:'fixture',authorizationMode:'managed',
  prepareBinding:()=>{throw new Error('must not prepare during composition')},...patch,
} as unknown as AgentAdapter)

test('managed activities reject a missing permit signer before accepting work',()=>{
  assert.throws(()=>createActivities({store:new MemoryStore(),runner,adapter:candidate()} as unknown as ActivityDeps),/DISPATCH_PERMIT_SIGNER_REQUIRED/)
})
test('managed activities reject standalone adapters',()=>{
  assert.throws(()=>createActivities({store:new MemoryStore(),runner,adapter:candidate({authorizationMode:'standalone'}),signDispatchPermit:()=>''}),/MANAGED_ADAPTER_REQUIRED/)
})
test('managed activities reject adapters without durable prepared binding',()=>{
  assert.throws(()=>createActivities({store:new MemoryStore(),runner,adapter:candidate({prepareBinding:undefined}),signDispatchPermit:()=>''}),/PREPARED_ADAPTER_REQUIRED/)
})

async function fixture(phase:'entry'|'after-guard'|'provider'|'issuer') {
  const store=new MemoryStore(),keys=generateKeyPairSync('ed25519'),issuer='permit-test'
  let nowMs=Date.now(),issued=0
  class TestCodex extends CodexAdapter {
    override async health(){return {state:'healthy' as const,checked_at:new Date().toISOString()}}
    override async startTask(envelope:TaskEnvelopeV1,ctx:DispatchContext){
      if(phase==='provider')throw new AdapterError('PROVIDER_FAILED','provider failed',false,'provider-failed')
      return super.startTask(envelope,{...ctx,beforeSend:async(binding,policy)=>{
        await ctx.beforeSend!(binding,policy)
        if(phase==='after-guard')nowMs+=2000
      }})
    }
  }
  const adapter=new TestCodex({bin:'/usr/bin/false',outputSchemaPath:'schemas/codex-output.v1.schema.json',authorization:{mode:'managed',verifier:(token,envelope,adapterId,runnerId)=>
    verifyDispatchPermit(token,{publicKey:keys.publicKey,issuer,runnerId,adapterId,envelope,nowMs})}})
  const deps:ActivityDeps={store,adapter,runner:{...runner,agents:['codex']},signDispatchPermit:(envelope,{runnerId,adapterId})=>{
    issued++
    if(phase==='issuer')throw new Error('ISSUER_UNAVAILABLE')
    return phase==='entry'?'not-a-permit':issueDispatchPermit({privateKey:keys.privateKey,issuer,runnerId,adapterId,envelope,nowMs,ttlSeconds:1})
  }}
  const at=new Date().toISOString()
  await store.createMission({actor:{type:'system',id:'test'},mission:{
    id:'permit-mission',tenant:'test',owner:'test',type:'inspect',goal:'synthetic permit test',constraints:{},
    acceptance:[{criterion_id:'C',metric:'value',operator:'eq',expected:1,hard_gate:true}],workflow_template:'inspect/v1',
    state:'DRAFT',revision:1,created_at:at,updated_at:at,
  }})
  const acts=createActivities(deps)
  const {taskId}=await acts.createTask({missionId:'permit-mission',capability:'code.analyze'})
  await acts.markReady(taskId)
  return {store,adapter,deps,acts,taskId,issued:()=>issued}
}

for(const phase of ['entry','after-guard'] as const)test(`permit refusal at ${phase} keeps a durable tombstone and never reissues`,async()=>{
  const f=await fixture(phase)
  const expected={dispatched:false,admissionDenied:{phase:'post-intent',code:'PERMIT_INVALID'}}
  assert.deepEqual(await f.acts.dispatchTask(f.taskId),expected)
  const saved=await f.store.getTask(f.taskId)
  assert.equal(saved?.state,'FAILED_TERMINAL')
  assert.equal(saved?.result,null)
  assert.ok(saved?.binding)
  await assert.rejects(f.adapter.getStatus(saved.binding),{code:'BINDING_NOT_FOUND'})
  const retry=createActivities({...f.deps,signDispatchPermit:()=>{throw new Error('must not reissue')}})
  assert.deepEqual(await retry.dispatchTask(f.taskId),expected)
  const collected=await retry.collectTaskResult(f.taskId)
  assert.ok(!('executionUncertain' in collected))
  assert.deepEqual(collected.admissionDenied,expected.admissionDenied)
  assert.equal(f.issued(),1)
  const events=await f.store.listEvents('permit-mission')
  assert.equal(events.filter(e=>e.event_type==='TASK_STARTED').length,0)
  assert.equal(events.filter(e=>e.idempotency_key===`runner-admission:${f.taskId}`).length,1)
  assert.equal(JSON.stringify(events).includes('cmap1.'),false)
})

test('provider errors remain uncertain and are not converted into permit refusal',async()=>{
  const f=await fixture('provider')
  await assert.rejects(f.acts.dispatchTask(f.taskId),{code:'PROVIDER_FAILED'})
  const saved=await f.store.getTask(f.taskId)
  assert.equal(saved?.state,'RUNNING')
  assert.ok(saved?.binding)
  assert.equal(saved?.result,null)
  assert.equal((await f.store.listEvents('permit-mission')).some(e=>e.payload['code']==='PERMIT_INVALID'),false)
})

test('issuer failure occurs before binding claim and can retry safely',async()=>{
  const f=await fixture('issuer')
  await assert.rejects(f.acts.dispatchTask(f.taskId),/ISSUER_UNAVAILABLE/)
  assert.equal((await f.store.getTask(f.taskId))?.binding,null)
  assert.equal((await f.store.listEvents('permit-mission')).some(e=>e.event_type==='TASK_DISPATCH_INTENT'),false)
})
