/**
 * S5 续接：continues_mission_id 让新 Mission 的首个任务收到上一个 Mission 已接受的产物、
 * 交接内容与记忆快照（不恢复 Agent 会话）。
 */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {MemoryStore,type EventActor,type Mission,type MissionState,type Store} from '#domain-model'
import {missionFromRequest} from '../../apps/control-plane-api/src/mission-submission.ts'
import {createActivities} from '../../workflows/activities.ts'
import {materializeDagNode} from '../../workflows/dag-materialization.ts'
import {MEMORY_ROLE} from '../../workflows/memory-context.ts'
import {taskCreationId} from '../../workflows/task-creation.ts'
import {syntheticActivityDeps,syntheticRunner} from './fake-adapter.ts'
import {fakeMemross} from './fake-memross.ts'

const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const actor:EventActor={type:'system',id:'continuation-test'}
const now=new Date().toISOString()
const criterion={criterion_id:'C',metric:'value',operator:'eq' as const,expected:3,hard_gate:true}
const mission=(id:string,constraints:Record<string,unknown>,state:MissionState='RUNNING',owner='crosswarm'):Mission=>({id,tenant:'team-ycc',owner,type:'inspect',
  goal:`目标 ${id}`,constraints:{risk_level:'read-meta',max_additional_cycles:1,...constraints},acceptance:[criterion],
  workflow_template:'inspect/v1',state,revision:1,created_at:now,updated_at:now})

/** 上一个 Mission：首轮返工、第二轮通过；两轮都有报告，只有通过的那一份应被续作继承。 */
async function priorMission(store:Store,workRoot:string,id='mis_prior'){
  await store.createMission({mission:mission(id,{memory:{project_id:'prj_a',limit:3}}),actor})
  const acts=createActivities(syntheticActivityDeps({store,runner:syntheticRunner(),workRoot,memory:fakeMemross().memory}))
  const {taskId:first}=await acts.createTask({missionId:id,capability:'code.analyze'})
  const finish=async(taskId:string,actual:string)=>{
    for(const [to,eventType] of [['READY','TASK_READY'],['QUEUED','TASK_ASSIGNED'],['RUNNING','TASK_STARTED']] as const)
      await store.transitionTask({taskId,to,eventType,actor,idempotencyKey:`seed:${taskId}:${to}`})
    const bytes=Buffer.from(`report ${actual}`)
    await mkdir(join(workRoot,taskId,'evidence'),{recursive:true})
    await writeFile(join(workRoot,taskId,'evidence/report.txt'),bytes)
    await store.setTaskResult(taskId,{schema:'cmap/task-result/v1',mission_id:id,task_id:taskId,attempt:1,status:'completed',summary:'s',
      criterion_results:[{criterion_id:'C',actual,passed:actual==='3'}],artifacts:[{artifact_id:`${taskId}:report`,role:'report',uri:'evidence/report.txt',sha256:sha(bytes),size_bytes:bytes.length}]})
    await store.putArtifact({artifact_id:`${taskId}:report`,mission_id:id,task_id:taskId,role:'report',uri:'evidence/report.txt',media_type:'text/plain',
      size_bytes:bytes.length,sha256:sha(bytes),version:1,state:'AVAILABLE',producer:{agent_id:'fake',adapter_version:'1',execution_session_id:'s'},provenance:{},
      retention:{retain_until:'2099-01-01T00:00:00.000Z',immutable:true},security:{classification:'internal',contains_secrets:false,contains_pii:false,allowed_roles:[]},created_at:now})
    await acts.markVerifying(taskId)
    const round=(await store.getTask(taskId))!.supersedes_task_id?1:0
    const {decision,progress}=await acts.evaluateHardGate({taskId,round})
    if(decision.decision==='accept')await acts.beginReview(taskId)
    return {out:await acts.applyReviewDecision({taskId,decision,round,currentProgress:progress}),reportSha:sha(bytes)}
  }
  const r1=await finish(first,'2')
  const second=r1.out.followupTaskIds[0]!
  const r2=await finish(second,'3')
  assert.equal(r2.out.outcome,'accept')
  await store.setMissionState(id,'COMPLETED',actor)
  const memRef=(await store.getTask(first))!.envelope.inputs!.artifact_refs!.find(r=>r.role===MEMORY_ROLE)!
  return {first,second,acceptedReportSha:r2.reportSha,rejectedReportSha:r1.reportSha,memorySha:memRef.sha256!}
}

test('续作首任务收到上一个 Mission 已接受的产物、交接内容与记忆快照；重试不重复', async t=>{
  const store=new MemoryStore(),workRoot=await mkdtemp(join(tmpdir(),'cmap-continuation-'))
  t.after(()=>rm(workRoot,{recursive:true,force:true}))
  const prior=await priorMission(store,workRoot)
  await store.createMission({mission:mission('mis_next',{continues_mission_id:'mis_prior'}),actor})
  const acts=createActivities(syntheticActivityDeps({store,runner:syntheticRunner(),workRoot}))
  const {taskId}=await acts.createTask({missionId:'mis_next',capability:'code.analyze'})
  assert.equal(taskId,taskCreationId('mis_next'))
  const task=(await store.getTask(taskId))!
  assert.deepEqual(task.envelope.inputs!.parameters,{continues_mission_id:'mis_prior'})
  const refs=task.envelope.inputs!.artifact_refs!
  const inputs=refs.filter(r=>r.role==='continuation_input')
  assert.deepEqual(inputs.map(r=>r.sha256),[prior.acceptedReportSha],'只继承已接受的产物')
  assert.deepEqual(refs.filter(r=>r.role==='continuation_memory').map(r=>r.sha256),[prior.memorySha])
  const handoffRef=refs.find(r=>r.role==='handoff')!
  for(const ref of refs) assert.equal(sha(await readFile(join(workRoot,taskId,ref.uri!))),ref.sha256,`${ref.role} 字节与引用一致`)
  const handoff=JSON.parse(await readFile(join(workRoot,taskId,handoffRef.uri!),'utf8'))
  assert.deepEqual(handoff.refs.mission_ids,['mis_prior'])
  assert.ok(handoff.done.some((d:string)=>d.includes(prior.second)))
  assert.ok(handoff.failed_attempts.some((d:string)=>d.includes(prior.first)))
  assert.equal(JSON.stringify(handoff).includes('目标 mis_next'),false)

  const artifacts=await store.listArtifacts(taskId)
  assert.equal(artifacts.length,refs.length)
  const cont=artifacts.find(a=>a.role==='continuation_input')!
  assert.equal(cont.producer.agent_id,'cmap-continuation')
  assert.deepEqual(cont.provenance,{source:'continuation',source_mission_id:'mis_prior',source_task_id:prior.second,source_artifact_id:`${prior.second}:report`,source_role:'report'})
  assert.equal(new Set(artifacts.map(a=>`${a.role}:${a.version}`)).size,artifacts.length,'(task_id, role, version) 唯一')

  await createActivities(syntheticActivityDeps({store,runner:syntheticRunner(),workRoot})).createTask({missionId:'mis_next',capability:'code.analyze'})
  assert.equal((await store.listArtifacts(taskId)).length,refs.length)
  assert.deepEqual((await store.getTask(taskId))!.envelope,task.envelope)
})

test('不带 plan 的续作走 dag/v1：单节点首轮收到同样的冻结输入，重试不重复', async t=>{
  const store=new MemoryStore(),workRoot=await mkdtemp(join(tmpdir(),'cmap-continuation-'))
  t.after(()=>rm(workRoot,{recursive:true,force:true}))
  const prior=await priorMission(store,workRoot)
  const next=missionFromRequest({request_id:'synthetic-continue',goal:'续作目标',risk_level:'read-meta',
    acceptance:[{criterion_id:'C',metric:'value',operator:'eq',expected:3}],continues_mission_id:'mis_prior'},'team-ycc','crosswarm')
  assert.equal(next.workflow_template,'dag/v1')
  await store.createMission({mission:next,actor})
  const deps={store,workRoot,runner:syntheticRunner()}
  const out=await materializeDagNode(deps,{missionId:next.id,nodeId:'main',attempt:1,acceptedDeps:{}})
  assert.ok('taskId' in out)
  const task=(await store.getTask(out.taskId))!
  assert.equal(task.envelope.inputs!.parameters!['continues_mission_id'],'mis_prior')
  const refs=task.envelope.inputs!.artifact_refs!
  assert.deepEqual(refs.filter(r=>r.role==='continuation_input').map(r=>r.sha256),[prior.acceptedReportSha],'只继承已接受的产物')
  assert.deepEqual(refs.filter(r=>r.role==='continuation_memory').map(r=>r.sha256),[prior.memorySha])
  assert.equal(refs.filter(r=>r.role==='handoff').length,1)
  for(const ref of refs) assert.equal(sha(await readFile(join(workRoot,out.taskId,ref.uri!))),ref.sha256,`${ref.role} 字节与引用一致`)
  assert.equal((await store.listArtifacts(out.taskId)).length,refs.length)
  await materializeDagNode(deps,{missionId:next.id,nodeId:'main',attempt:1,acceptedDeps:{}})
  assert.equal((await store.listArtifacts(out.taskId)).length,refs.length)
  assert.deepEqual((await store.getTask(out.taskId))!.envelope,task.envelope)
})

test('续作来源必须同租户、同 owner 且已终结，否则失败关闭', async t=>{
  const store=new MemoryStore(),workRoot=await mkdtemp(join(tmpdir(),'cmap-continuation-'))
  t.after(()=>rm(workRoot,{recursive:true,force:true}))
  await store.createMission({mission:mission('mis_running',{}, 'RUNNING'),actor})
  await store.createMission({mission:mission('mis_other_owner',{}, 'COMPLETED','someone-else'),actor})
  const acts=createActivities(syntheticActivityDeps({store,runner:syntheticRunner(),workRoot}))
  for(const source of ['mis_running','mis_other_owner','mis_missing']) {
    const id=`mis_next_${source}`
    await store.createMission({mission:mission(id,{continues_mission_id:source}),actor})
    await assert.rejects(acts.createTask({missionId:id,capability:'code.analyze'}),/CONTINUATION_INVALID/)
    assert.equal((await store.queryTasks({missionId:id})).length,0)
  }
})

test('mission-create：continues_mission_id 进入约束，不能与 plan 同时出现', () => {
  const base={request_id:'synthetic-request',goal:'g',risk_level:'read-meta',acceptance:[{criterion_id:'files',metric:'count',operator:'eq',expected:3}]}
  assert.equal(missionFromRequest({...base,continues_mission_id:'mis_prior'},'t','o').constraints['continues_mission_id'],'mis_prior')
  const plan={schema:'cmap/mission-plan/v1',nodes:[{node_id:'A',goal:'A',capability:'code.inspect',deps:[],criterion_ids:['files'],risk_level:'read-meta'}]}
  assert.throws(()=>missionFromRequest({...base,plan,continues_mission_id:'mis_prior'},'t','o'),/continues_mission_id/)
  assert.throws(()=>missionFromRequest({...base,continues_mission_id:'../x'},'t','o'),RangeError)
})
