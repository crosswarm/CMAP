import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHash} from 'node:crypto'
import {access,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {MemoryStore,type Artifact,type Mission,type RiskLevel} from '#domain-model'
import {createActivities} from '../../workflows/activities.ts'
import {reviewArtifactUri} from '../../workflows/review-inputs.ts'
import {FakeAdapter,syntheticActivityDeps,syntheticRunner} from './fake-adapter.ts'

const actor={type:'system',id:'input-dispatch-test'} as const
const bytes=Buffer.from('{"diagnostic":"synthetic","value":3}')
const digest=createHash('sha256').update(bytes).digest('hex')

async function fixture(risk:RiskLevel='read-meta') {
  const store=new MemoryStore(),adapter=new FakeAdapter(),workRoot=await mkdtemp(join(tmpdir(),'cmap-input-dispatch-'))
  const now=new Date().toISOString()
  const mission:Mission={id:'input-dispatch',tenant:'team-ycc',owner:'crosswarm',type:'inspect',goal:'synthetic',constraints:{risk_level:risk},
    acceptance:[{criterion_id:'C',metric:'value',operator:'eq',expected:3,hard_gate:true}],workflow_template:'inspect/v1',state:'RUNNING',revision:1,created_at:now,updated_at:now}
  await store.createMission({mission,actor})
  const deps=syntheticActivityDeps({store,adapter,workRoot,runner:syntheticRunner()})
  const acts=createActivities(deps)
  const sourceId=(await acts.createTask({missionId:mission.id,capability:'code.analyze',creationKey:'source'})).taskId
  for (const [to,eventType] of [['READY','TASK_READY'],['QUEUED','TASK_ASSIGNED'],['RUNNING','TASK_STARTED'],['VERIFYING','HARD_GATE_EVALUATED'],['REWORK','REVIEW_REWORK_REQUESTED'],['COMPLETED','TASK_COMPLETED']] as const) {
    await store.transitionTask({taskId:sourceId,to,eventType,actor,idempotencyKey:'seed:'+to})
  }
  const artifact:Artifact={artifact_id:sourceId+':report',mission_id:mission.id,task_id:sourceId,role:'report',uri:'evidence/source.json',
    sha256:digest,size_bytes:bytes.length,media_type:'application/json',version:1,state:'AVAILABLE',created_at:now,
    producer:{agent_id:'synthetic',adapter_version:'1',execution_session_id:'fixture'},provenance:{},
    retention:{immutable:true,retain_until:'2099-01-01T00:00:00.000Z'},security:{classification:'internal',contains_secrets:false,contains_pii:false,allowed_roles:[]}}
  await mkdir(join(workRoot,sourceId,'evidence'),{recursive:true})
  await writeFile(join(workRoot,sourceId,artifact.uri),bytes)
  await store.setTaskResult(sourceId,{schema:'cmap/task-result/v1',mission_id:mission.id,task_id:sourceId,attempt:1,status:'failed',summary:'synthetic diagnostic',
    criterion_results:[{criterion_id:'C',actual:'0',passed:false,evidence_artifact_ids:[artifact.artifact_id]}],
    artifacts:[{artifact_id:artifact.artifact_id,role:artifact.role,uri:artifact.uri,sha256:digest,size_bytes:bytes.length}]})
  await store.putArtifact(artifact)
  const ref={artifact_id:artifact.artifact_id,source_task_id:sourceId,role:'report',sha256:digest,uri:reviewArtifactUri(artifact.artifact_id)}
  const taskId=(await acts.createTask({missionId:mission.id,capability:'code.analyze',creationKey:'child',supersedesTaskId:sourceId,artifactRefs:[ref]})).taskId
  await acts.markReady(taskId)
  return {store,adapter,workRoot,deps,acts,sourceId,taskId,artifact,ref}
}

test('dispatch copies verified inputs before Adapter start and bound retries never rewrite active files',async t=>{
  const f=await fixture();t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
  const start=f.adapter.startTask.bind(f.adapter)
  f.adapter.startTask=async(envelope,context)=>{
    assert.deepEqual(await readFile(join(f.workRoot,f.taskId,f.ref.uri)),bytes)
    return start(envelope,context)
  }
  assert.equal((await f.acts.dispatchTask(f.taskId)).dispatched,true)
  await writeFile(join(f.workRoot,f.taskId,f.ref.uri),'active workspace change')
  assert.equal((await createActivities(f.deps).dispatchTask(f.taskId)).dispatched,false)
  assert.equal(await readFile(join(f.workRoot,f.taskId,f.ref.uri),'utf8'),'active workspace change')
  assert.equal(f.adapter.startCalls.length,1)
})

test('bad source bytes cause durable initial INPUT_INVALID and zero external start',async t=>{
  const f=await fixture();t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
  await writeFile(join(f.workRoot,f.sourceId,f.artifact.uri),'tampered')
  const denied={dispatched:false,admissionDenied:{phase:'initial',code:'INPUT_INVALID'}}
  assert.deepEqual(await f.acts.dispatchTask(f.taskId),denied)
  await writeFile(join(f.workRoot,f.sourceId,f.artifact.uri),bytes)
  assert.deepEqual(await createActivities(f.deps).dispatchTask(f.taskId),denied)
  assert.equal(f.adapter.startCalls.length,0)
  assert.equal((await f.store.getTask(f.taskId))?.binding,null)
  assert.equal((await f.store.getTask(f.taskId))?.state,'CANCELED')
})

test('approval wait and admission denial happen before input copying',async t=>{
  const f=await fixture('controlled');t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
  assert.equal((await f.acts.requestApproval(f.taskId)).required,true)
  await assert.rejects(f.acts.dispatchTask(f.taskId),/TASK_NOT_DISPATCHABLE/)
  await assert.rejects(access(join(f.workRoot,f.taskId)))
  assert.equal(f.adapter.startCalls.length,0)
  const g=await fixture();t.after(()=>rm(g.workRoot,{recursive:true,force:true}))
  const runner=syntheticRunner();const denied=createActivities({...g.deps,runner:{...runner,admission:{...runner.admission,allowed_owners:[]}}})
  assert.deepEqual(await denied.dispatchTask(g.taskId),{dispatched:false,admissionDenied:{phase:'initial',code:'OWNER_DENIED'}})
  await assert.rejects(access(join(g.workRoot,g.taskId)))
})

test('an Adapter without task workspace isolation cannot receive copied input files',async t=>{
  const f=await fixture();t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
  const descriptor=await f.adapter.discover()
  f.adapter.discover=async()=>({...descriptor,supports_worktree_isolation:false})
  assert.deepEqual(await f.acts.dispatchTask(f.taskId),{dispatched:false,admissionDenied:{phase:'initial',code:'INPUT_INVALID'}})
  assert.equal(f.adapter.startCalls.length,0)
  await assert.rejects(access(join(f.workRoot,f.taskId)))
})

test('beforeSend revalidates revocation and copied bytes with post-intent zero-send receipts',async t=>{
  for(const mode of ['revoke','tamper'] as const) {
    const f=await fixture();t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
    const start=f.adapter.startTask.bind(f.adapter)
    f.adapter.startTask=async(envelope,context)=>{
      if(mode==='revoke')await f.store.putArtifact({...f.artifact,state:'REVOKED'})
      else await writeFile(join(f.workRoot,f.taskId,f.ref.uri),'tampered after claim')
      return start(envelope,context)
    }
    const denied={dispatched:false,admissionDenied:{phase:'post-intent',code:'INPUT_INVALID'}}
    assert.deepEqual(await f.acts.dispatchTask(f.taskId),denied)
    assert.deepEqual(await createActivities(f.deps).dispatchTask(f.taskId),denied)
    assert.equal(f.adapter.startCalls.length,0)
    const task=await f.store.getTask(f.taskId)
    assert.equal(task?.state,'FAILED_TERMINAL')
    assert.ok(task?.binding)
  }
})
