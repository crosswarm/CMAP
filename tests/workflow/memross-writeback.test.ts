/**
 * S5 协作与交接：Mission 结论回写 Memross（propose 候选、升级交接记录）。
 * Memross 用假 fetch 记录请求；真实服务由 scripts/e2e-continuity.mjs 覆盖。
 */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {MemoryStore,type EventActor,type Mission,type Store} from '#domain-model'
import {createActivities} from '../../workflows/activities.ts'
import {cmapArtifactUri,knowledgeIdempotencyKey} from '../../workflows/memross-writeback.ts'
import {syntheticActivityDeps,syntheticRunner} from './fake-adapter.ts'
import {fakeMemrossServer as memross} from './fake-memross.ts'

const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const actor:EventActor={type:'system',id:'writeback-test'}
const now=new Date().toISOString()

async function setup(mode:'ok'|'down'|'reject-blocks'='ok',constraints:Record<string,unknown>={memory:{project_id:'prj_a',limit:3}}){
  const store=new MemoryStore(),workRoot=await mkdtemp(join(tmpdir(),'cmap-writeback-'))
  const mission:Mission={id:'mis_writeback',tenant:'team-ycc',owner:'crosswarm',type:'inspect',goal:'统计 value',
    constraints:{risk_level:'read-meta',max_additional_cycles:0,...constraints},
    acceptance:[{criterion_id:'C',metric:'value',operator:'eq',expected:3,hard_gate:true}],
    workflow_template:'inspect/v1',state:'RUNNING',revision:1,created_at:now,updated_at:now}
  await store.createMission({mission,actor})
  const mem=memross(mode)
  const acts=createActivities(syntheticActivityDeps({store,runner:syntheticRunner(),workRoot,memory:mem.memory}))
  const {taskId}=await acts.createTask({missionId:mission.id,capability:'code.analyze'})
  return {store,workRoot,acts,taskId,mission,...mem}
}

async function finish(store:Store,missionId:string,taskId:string,actual:string){
  for(const [to,eventType] of [['READY','TASK_READY'],['QUEUED','TASK_ASSIGNED'],['RUNNING','TASK_STARTED']] as const)
    await store.transitionTask({taskId,to,eventType,actor,idempotencyKey:`seed:${taskId}:${to}`})
  const reportSha=sha('report')
  await store.setTaskResult(taskId,{schema:'cmap/task-result/v1',mission_id:missionId,task_id:taskId,attempt:1,status:'completed',summary:'s',
    criterion_results:[{criterion_id:'C',actual,passed:actual==='3'}],
    artifacts:[{artifact_id:`${taskId}:report`,role:'report',uri:'evidence/report.json',sha256:reportSha,size_bytes:6}],
    findings:[{severity:'medium',code:'REFRESH_READBACK',description:'刷新写回后必须回读持久化结果，接口 200 不代表落库。'},{severity:'info',code:'NOTE',description:'无关紧要'}],
    recommended_followups:[{capability:'code.analyze',reason:'先跑回读校验脚本再判定写回成功'}]})
  await store.putArtifact({artifact_id:`${taskId}:report`,mission_id:missionId,task_id:taskId,role:'report',uri:'evidence/report.json',media_type:'application/json',
    size_bytes:6,sha256:reportSha,version:1,state:'AVAILABLE',producer:{agent_id:'fake',adapter_version:'1',execution_session_id:'s'},provenance:{},
    retention:{retain_until:'2099-01-01T00:00:00.000Z',immutable:true},security:{classification:'internal',contains_secrets:false,contains_pii:false,allowed_roles:[]},created_at:now})
  if(actual==='3')for(const [to,eventType] of [['VERIFYING','HARD_GATE_EVALUATED'],['REVIEWING','REVIEW_STARTED'],['COMPLETED','REVIEW_ACCEPTED']] as const)
    await store.transitionTask({taskId,to,eventType,actor,idempotencyKey:`seed:${taskId}:${to}`})
  return reportSha
}

test('accept 后把 findings/recommended_followups 以 pitfall/procedure 提交 propose，带 cmap-artifact 与已用 memross-block 证据，幂等', async t=>{
  const f=await setup();t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
  const reportSha=await finish(f.store,f.mission.id,f.taskId,'3')
  await f.acts.proposeTaskKnowledge({missionId:f.mission.id,taskId:f.taskId})
  const proposes=f.calls.filter(c=>c.path==='/api/memory/v1/propose')
  assert.deepEqual(proposes.map(c=>c.body.kind),['pitfall','procedure'],'info 级 finding 不提交')
  const [first]=proposes
  assert.equal(first!.auth,'Bearer worker-token')
  assert.deepEqual(first!.body.scope,{project_id:'prj_a'})
  assert.equal(first!.body.idempotency_key,knowledgeIdempotencyKey(f.mission.id,f.taskId,0))
  assert.match(first!.body.idempotency_key,/^[A-Za-z0-9._:-]{8,128}$/)
  assert.ok(first!.body.body.includes('回读持久化结果'))
  assert.deepEqual(first!.body.evidence,[
    {uri:cmapArtifactUri(f.taskId,`${f.taskId}:report`),sha256:reportSha},
    {uri:'memross-block:doc_aaaaaaaaaaaaaaaaaaaaaaaa/rev_'+'b'.repeat(32)+'/blk_cccccccccccccccccccccccc',sha256:sha('## 坑\n\n刷新后必须回读持久化结果。\n')},
  ])
  assert.match(cmapArtifactUri(f.taskId,`${f.taskId}:report`),/^cmap-artifact:[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,128}$/)
  const events=(await f.store.listEvents(f.mission.id)).filter(e=>e.event_type==='KNOWLEDGE_PROPOSED')
  assert.equal(events.length,2)
  assert.equal(JSON.stringify(events).includes('回读持久化结果'),false,'事件不存结论正文')

  await f.acts.proposeTaskKnowledge({missionId:f.mission.id,taskId:f.taskId})
  assert.equal(f.calls.filter(c=>c.path==='/api/memory/v1/propose').length,2,'已有回执不再提交')
})

test('Memross 不可用时记录失败事件、不抛错；拒收 memross-block 时退回只带 cmap-artifact 证据', async t=>{
  const down=await setup('down');t.after(()=>rm(down.workRoot,{recursive:true,force:true}))
  await finish(down.store,down.mission.id,down.taskId,'3')
  await down.acts.proposeTaskKnowledge({missionId:down.mission.id,taskId:down.taskId})
  const failed=(await down.store.listEvents(down.mission.id)).filter(e=>e.event_type==='KNOWLEDGE_PROPOSAL_FAILED')
  assert.equal(failed.length,2)
  assert.equal(failed[0]!.payload['code'],'MEMORY_UNAVAILABLE')

  const rejected=await setup('reject-blocks');t.after(()=>rm(rejected.workRoot,{recursive:true,force:true}))
  await finish(rejected.store,rejected.mission.id,rejected.taskId,'3')
  await rejected.acts.proposeTaskKnowledge({missionId:rejected.mission.id,taskId:rejected.taskId})
  const sent=rejected.calls.filter(c=>c.path==='/api/memory/v1/propose')
  assert.equal(sent.length,4)
  assert.ok(sent[1]!.body.evidence.every((e:any)=>e.uri.startsWith('cmap-artifact:')))
  assert.equal((await rejected.store.listEvents(rejected.mission.id)).filter(e=>e.event_type==='KNOWLEDGE_PROPOSED').length,2)
})

test('没有 Memross 项目范围时不提交 propose，也不抛错', async t=>{
  const f=await setup('ok',{});t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
  await finish(f.store,f.mission.id,f.taskId,'3')
  await f.acts.proposeTaskKnowledge({missionId:f.mission.id,taskId:f.taskId})
  assert.equal(f.calls.length,0)
})

test('ESCALATED 时写交接记录：失败标准、证据链接、绑定状态与 refs；幂等；不可用时只记事件', async t=>{
  const f=await setup();t.after(()=>rm(f.workRoot,{recursive:true,force:true}))
  const reportSha=await finish(f.store,f.mission.id,f.taskId,'2')
  await f.store.setMissionState(f.mission.id,'ESCALATED',actor)
  await f.acts.recordEscalationHandoff({missionId:f.mission.id,reason:'返工轮次已达上限'})
  const [call]=f.calls.filter(c=>c.path==='/api/memory/v1/handoff')
  assert.ok(call)
  assert.equal(call.auth,'Bearer worker-token')
  assert.equal(call.body.op,'put')
  assert.deepEqual(call.body.scope,{project_id:'prj_a'})
  assert.equal(call.body.goal,'统计 value')
  assert.match(call.body.state,/ESCALATED/)
  assert.match(call.body.state,/返工轮次已达上限/)
  assert.ok(call.body.failed_attempts.some((x:string)=>x.includes(f.taskId)&&x.includes('C')))
  assert.ok(call.body.verification.includes(reportSha))
  assert.ok(call.body.verification.includes(cmapArtifactUri(f.taskId,`${f.taskId}:report`)))
  assert.ok(Array.isArray(call.body.done)&&Array.isArray(call.body.todo)&&call.body.next_steps.length>0)
  assert.deepEqual(call.body.refs,{mission_ids:[f.mission.id],block_ids:['blk_cccccccccccccccccccccccc']})
  const recorded=(await f.store.listEvents(f.mission.id)).filter(e=>e.event_type==='HANDOFF_RECORDED')
  assert.deepEqual(recorded.map(e=>e.payload['handoff_id']),['hof_00000000-0000-0000-0000-000000000001'])
  await f.acts.recordEscalationHandoff({missionId:f.mission.id,reason:'返工轮次已达上限'})
  assert.equal(f.calls.filter(c=>c.path==='/api/memory/v1/handoff').length,1)

  const down=await setup('down');t.after(()=>rm(down.workRoot,{recursive:true,force:true}))
  await finish(down.store,down.mission.id,down.taskId,'2')
  await down.acts.recordEscalationHandoff({missionId:down.mission.id,reason:'x'})
  assert.equal((await down.store.listEvents(down.mission.id)).filter(e=>e.event_type==='HANDOFF_FAILED')[0]?.payload['code'],'MEMORY_UNAVAILABLE')
})
