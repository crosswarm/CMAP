import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MemoryStore,type Mission,type ApprovalScope} from '#domain-model'
import {createActivities} from '../../workflows/activities.ts'
import {FakeAdapter,syntheticRunner} from './fake-adapter.ts'

const actor={type:'system',id:'approval-dispatch-test'} as const
async function fixture(scope:ApprovalScope,approved=true) {
  const store=new MemoryStore(),adapter=new FakeAdapter(),workRoot=await mkdtemp(join(tmpdir(),'cmap-approval-dispatch-'))
  const now=new Date().toISOString()
  const mission:Mission={id:'mis-approval-dispatch',tenant:'team-ycc',owner:'crosswarm',type:'inspect',goal:'synthetic approval boundary',constraints:{risk_level:scope},acceptance:[{criterion_id:'C',metric:'value',operator:'eq',expected:true,hard_gate:true}],workflow_template:'inspect/v1',state:'RUNNING',revision:1,created_at:now,updated_at:now}
  await store.createMission({mission,actor})
  const acts=createActivities({store,adapter,runner:syntheticRunner(),workRoot})
  const {taskId}=await acts.createTask({missionId:mission.id,capability:'code.analyze'})
  await acts.markReady(taskId)
  if(approved){
    const gate=await acts.requestApproval(taskId)
    // Explicit synthetic test authority; this Adapter never contacts a provider.
    await store.decideApproval(gate.approvalId!,'approved','test-harness:human',new Date().toISOString())
    await acts.waitForApproval({taskId,approvalId:gate.approvalId!,scope})
  }
  return {store,adapter,acts,taskId,workRoot}
}

test('legacy adapters require a current independent approval for each risk scope',async t=>{
  for(const scope of ['controlled','mutating'] as const){
    for(const change of ['missing','pending','scope','task','mission','expired','actor','self','future','before-created']){
      const f=await fixture(scope);t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
      const get=f.store.getApproval.bind(f.store)
      f.store.getApproval=async id=>{
        const a=await get(id);if(!a||change==='missing')return null
        return {...a,...(change==='pending'?{decision:'pending' as const}:change==='scope'?{scope:scope==='controlled'?'mutating' as const:'controlled' as const}:change==='task'?{task_id:'wrong'}:change==='mission'?{mission_id:'wrong'}:change==='expired'?{expires_at:new Date(Date.now()-1).toISOString()}:change==='actor'?{decided_by:'agent:jev'}:change==='self'?{decided_by:a.requested_by}:change==='future'?{decided_at:new Date(Date.now()+60000).toISOString()}:{decided_at:new Date(Date.parse(a.created_at)-1).toISOString()})}
      }
      assert.deepEqual(await f.acts.dispatchTask(f.taskId),{dispatched:false,admissionDenied:{phase:'initial',code:'APPROVAL_INVALID'}},scope+':'+change)
      assert.equal(f.adapter.startCalls.length,0)
      assert.equal((await f.store.getTask(f.taskId))?.binding,null)
      assert.deepEqual(await readdir(f.workRoot),[])
    }
  }
})

test('valid legacy approvals execute, but expiry during health prevents launch',async t=>{
  for(const expires of [false,true]){
    const f=await fixture('controlled');t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
    if(expires){
      const health=f.adapter.health.bind(f.adapter),get=f.store.getApproval.bind(f.store)
      f.adapter.health=async()=>{f.store.getApproval=async id=>{const a=await get(id);return a?{...a,expires_at:new Date(Date.now()-1).toISOString()}:null};return health()}
    }
    const result=await f.acts.dispatchTask(f.taskId)
    assert.equal(result.dispatched,!expires)
    assert.equal(f.adapter.startCalls.length,expires?0:1)
  }
})
