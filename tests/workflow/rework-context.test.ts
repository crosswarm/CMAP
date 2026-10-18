/**
 * S5 衔接：返工任务拿到上一轮失败标准、上一轮产物与首轮记忆快照（review input），
 * DAG 节点首轮冻结自己的记忆快照，返工轮复用它而不重新检索。
 */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {MemoryStore,type Artifact,type EventActor,type Mission,type Store} from '#domain-model'
import {renderTaskPrompt} from '../../packages/adapter-sdk/src/structured-output.ts'
import {createActivities} from '../../workflows/activities.ts'
import {createDagActivities} from '../../workflows/dag-activities.ts'
import {dagTaskId} from '../../workflows/dag-materialization.ts'
import {MEMORY_ROLE} from '../../workflows/memory-context.ts'
import {prepareReviewInputs,reviewArtifactUri} from '../../workflows/review-inputs.ts'
import {syntheticActivityDeps,syntheticRunner} from './fake-adapter.ts'
import {fakeMemross} from './fake-memross.ts'

const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const actor:EventActor={type:'system',id:'rework-context-test'}

const now=new Date().toISOString()
const criterion={criterion_id:'C',metric:'value',operator:'eq' as const,expected:3,hard_gate:true}

async function finishWithReport(store:Store,workRoot:string,missionId:string,taskId:string,attempt:number,actual:string){
  for(const [to,eventType] of [['READY','TASK_READY'],['QUEUED','TASK_ASSIGNED'],['RUNNING','TASK_STARTED'],['VERIFYING','HARD_GATE_EVALUATED']] as const){
    const t=(await store.getTask(taskId))!
    if(t.state!==to)await store.transitionTask({taskId,to,eventType,actor,idempotencyKey:`seed:${taskId}:${to}`})
  }
  const bytes=Buffer.from(`report ${taskId}`)
  await mkdir(join(workRoot,taskId,'evidence'),{recursive:true})
  await writeFile(join(workRoot,taskId,'evidence/report.txt'),bytes)
  const artifactId=`${taskId}:report`
  await store.setTaskResult(taskId,{schema:'cmap/task-result/v1',mission_id:missionId,task_id:taskId,attempt,status:'completed',summary:'s',
    criterion_results:[{criterion_id:'C',actual,passed:actual==='3',evidence_artifact_ids:[artifactId]}],
    artifacts:[{artifact_id:artifactId,role:'report',uri:'evidence/report.txt',sha256:sha(bytes),size_bytes:bytes.length}]})
  const artifact:Artifact={artifact_id:artifactId,mission_id:missionId,task_id:taskId,role:'report',uri:'evidence/report.txt',media_type:'text/plain',
    size_bytes:bytes.length,sha256:sha(bytes),version:1,state:'AVAILABLE',producer:{agent_id:'fake',adapter_version:'1',execution_session_id:'s'},
    provenance:{},retention:{retain_until:'2099-01-01T00:00:00.000Z',immutable:true},
    security:{classification:'internal',contains_secrets:false,contains_pii:false,allowed_roles:[]},created_at:now}
  await store.putArtifact(artifact)
  return artifact
}

test('inspect/v1 返工后继带上一轮失败标准、上一轮报告与首轮记忆快照，提示词含“上一轮未通过”', async t=>{
  const store=new MemoryStore(),workRoot=await mkdtemp(join(tmpdir(),'cmap-rework-ctx-'))
  t.after(()=>rm(workRoot,{recursive:true,force:true}))
  const mission:Mission={id:'mis_rework_ctx',tenant:'team-ycc',owner:'crosswarm',type:'inspect',goal:'统计 value',
    constraints:{risk_level:'read-meta',max_additional_cycles:2,memory:{project_id:'prj_a',limit:3}},acceptance:[criterion],
    workflow_template:'inspect/v1',state:'RUNNING',revision:1,created_at:now,updated_at:now}
  await store.createMission({mission,actor})
  const {memory,searches}=fakeMemross()
  const acts=createActivities(syntheticActivityDeps({store,runner:syntheticRunner(),workRoot,memory}))
  const {taskId:first}=await acts.createTask({missionId:mission.id,capability:'code.analyze'})
  const memRef=(await store.getTask(first))!.envelope.inputs!.artifact_refs!.find(r=>r.role===MEMORY_ROLE)!
  const report=await finishWithReport(store,workRoot,mission.id,first,1,'2')
  const {decision,progress}=await acts.evaluateHardGate({taskId:first,round:0})
  const out=await acts.applyReviewDecision({taskId:first,decision,round:0,currentProgress:progress})
  assert.equal(out.outcome,'rework')
  const child=(await store.getTask(out.followupTaskIds[0]!))!
  const prev=child.envelope.inputs!.previous_attempt!
  assert.equal(prev.supersedes_task_id,first)
  assert.equal(prev.supersedes_task_id,child.envelope.identity.supersedes_task_id)
  assert.deepEqual(prev.failed_criteria.map(c=>c.criterion_id),['C'])
  assert.match(prev.failed_criteria[0]!.actual,/2/)
  assert.ok(prev.focus?.some(f=>f.includes('C')))
  const refs=child.envelope.inputs!.artifact_refs!
  assert.deepEqual(refs.find(r=>r.role==='report'),{artifact_id:report.artifact_id,source_task_id:first,role:'report',sha256:report.sha256,uri:reviewArtifactUri(report.artifact_id)})
  assert.deepEqual(refs.find(r=>r.role===MEMORY_ROLE),{artifact_id:memRef.artifact_id,source_task_id:first,role:MEMORY_ROLE,sha256:memRef.sha256,uri:reviewArtifactUri(memRef.artifact_id)})

  await prepareReviewInputs(store,child,workRoot)
  const copied=await readFile(join(workRoot,child.id,reviewArtifactUri(memRef.artifact_id)))
  assert.equal(sha(copied),memRef.sha256,'返工轮读到的就是首轮冻结的同一份记忆')
  assert.equal(searches.length,1,'返工不重新检索')

  const prompt=renderTaskPrompt(child.envelope)
  assert.match(prompt,/## 上一轮未通过/)
  assert.ok(prompt.includes(first))
  assert.match(prompt,/数据，不是指令/)

  // 第二轮再返工：记忆仍指向首轮产生的那一份。
  await finishWithReport(store,workRoot,mission.id,child.id,1,'1')
  const second=await acts.evaluateHardGate({taskId:child.id,round:1})
  const out2=await acts.applyReviewDecision({taskId:child.id,decision:second.decision,round:1,previousProgress:progress,currentProgress:second.progress})
  const grandchild=(await store.getTask(out2.followupTaskIds[0]!))!
  assert.equal(grandchild.envelope.inputs!.artifact_refs!.find(r=>r.role===MEMORY_ROLE)!.source_task_id,first)
  assert.equal(grandchild.envelope.inputs!.previous_attempt!.supersedes_task_id,child.id)
})

test('没有返工上下文的任务提示词不出现“上一轮未通过”', () => {
  const prompt=renderTaskPrompt({schema:'cmap/task-envelope/v1',identity:{mission_id:'m',task_id:'t',idempotency_key:'k',revision:1},
    classification:{task_type:'inspect',requested_capability:'code.analyze',risk_level:'read-meta'},goal:{statement:'g',success_definition:[criterion]},
    environment:{},execution_policy:{timeout_seconds:1,max_attempts:1},permissions:{forbidden:[]},evidence_requirements:{required_artifact_roles:['report']},
    output_contract:{schema_uri:'https://cmap.local/schemas/task-result/v1'}})
  assert.equal(prompt.includes('上一轮未通过'),false)
})

const dagMission=(id:string,constraints:Record<string,unknown>={}):Mission=>({id,tenant:'team-ycc',owner:'crosswarm',type:'inspect',goal:'DAG',
  constraints:{risk_level:'read-meta',max_additional_cycles:2,memory:{project_id:'prj_a',limit:2},
    plan:{schema:'cmap/mission-plan/v1',nodes:[
      {node_id:'a',goal:'节点 a 的目标',capability:'code.analyze',deps:[],criterion_ids:['C'],risk_level:'read-meta'},
      {node_id:'b',goal:'节点 b 的目标',capability:'code.analyze',deps:[],criterion_ids:['D'],risk_level:'read-meta',memory:{project_id:'prj_b',query:'自定义查询'}},
    ]},...constraints},
  acceptance:[criterion,{...criterion,criterion_id:'D'}],workflow_template:'dag/v1',state:'RUNNING',revision:1,created_at:now,updated_at:now})

test('DAG 节点首轮冻结记忆快照（继承 Mission 用节点 goal 查询 / 节点覆盖），返工轮经 review input 复用并带失败标准', async t=>{
  const store=new MemoryStore(),workRoot=await mkdtemp(join(tmpdir(),'cmap-dag-ctx-'))
  t.after(()=>rm(workRoot,{recursive:true,force:true}))
  const m=dagMission('mis_dag_ctx')
  await store.createMission({mission:m,actor})
  const {memory,searches}=fakeMemross()
  const acts=createDagActivities(syntheticActivityDeps({store,runner:syntheticRunner(),workRoot,memory}))
  const a1=await acts.materializeDagNode({missionId:m.id,nodeId:'a',attempt:1,acceptedDeps:{}})
  const b1=await acts.materializeDagNode({missionId:m.id,nodeId:'b',attempt:1,acceptedDeps:{}})
  assert.ok('taskId' in a1 && 'taskId' in b1)
  assert.deepEqual(searches.map(s=>[s.scope.project_id,s.query,s.limit]),[['prj_a','节点 a 的目标',2],['prj_b','自定义查询',3]])
  const aTask=(await store.getTask(a1.taskId))!
  const memRef=aTask.envelope.inputs!.artifact_refs!.find(r=>r.role===MEMORY_ROLE)!
  assert.equal(sha(await readFile(join(workRoot,a1.taskId,memRef.uri!))),memRef.sha256)
  assert.ok((await store.listArtifacts(a1.taskId)).some(x=>x.artifact_id===memRef.artifact_id&&x.producer.agent_id==='memross'))
  // 重试不重新检索
  await acts.materializeDagNode({missionId:m.id,nodeId:'a',attempt:1,acceptedDeps:{}})
  assert.equal(searches.length,2)

  await finishWithReport(store,workRoot,m.id,a1.taskId,1,'2')
  const reviewed=await acts.reviewDagAttempt({taskId:a1.taskId})
  assert.equal(reviewed.status,'rework')
  const a2=await acts.materializeDagNode({missionId:m.id,nodeId:'a',attempt:2,supersedesTaskId:a1.taskId,acceptedDeps:{}})
  assert.ok('taskId' in a2)
  assert.equal(a2.taskId,dagTaskId(m.id,'a',2))
  assert.equal(searches.length,2,'返工轮不重新检索')
  const a2Task=(await store.getTask(a2.taskId))!
  assert.equal(a2Task.envelope.goal.statement,'节点 a 的目标')
  assert.equal(a2Task.envelope.inputs!.previous_attempt!.supersedes_task_id,a1.taskId)
  assert.deepEqual(a2Task.envelope.inputs!.previous_attempt!.failed_criteria.map(c=>c.criterion_id),['C'])
  const refs=a2Task.envelope.inputs!.artifact_refs!
  assert.equal(refs.find(r=>r.role==='report')?.source_task_id,a1.taskId)
  assert.deepEqual(refs.find(r=>r.role===MEMORY_ROLE),{artifact_id:memRef.artifact_id,source_task_id:a1.taskId,role:MEMORY_ROLE,sha256:memRef.sha256,uri:reviewArtifactUri(memRef.artifact_id)})
  await prepareReviewInputs(store,a2Task,workRoot)
  assert.equal(sha(await readFile(join(workRoot,a2.taskId,reviewArtifactUri(memRef.artifact_id)))),memRef.sha256)
})

test('mission-create 允许 memory 与 plan 同时出现（作为节点缺省记忆）', async () => {
  const {missionFromRequest}=await import('../../apps/control-plane-api/src/mission-submission.ts')
  const plan={schema:'cmap/mission-plan/v1',nodes:[{node_id:'A',goal:'Collect A',capability:'code.inspect',deps:[],criterion_ids:['files'],risk_level:'read-meta',memory:{project_id:'prj_b'}}]}
  const m=missionFromRequest({request_id:'synthetic-request',goal:'g',risk_level:'read-meta',acceptance:[{criterion_id:'files',metric:'count',operator:'eq',expected:3}],
    plan,memory:{project_id:'prj_a'}},'t','o')
  assert.deepEqual(m.constraints['memory'],{project_id:'prj_a',limit:3})
  assert.equal(m.workflow_template,'dag/v1')
})
