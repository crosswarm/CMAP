/** Real local rejection paths. Requires an isolated Worker, allowed/denied-owner APIs,
 * and a CODEX_BIN wrapper counting only `exec` launches (never arguments/prompts).
 * No human approval is synthesized; the controlled child must be denied before it runs.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Client, Connection } from '@temporalio/client'
import { Worker } from '@temporalio/worker'
import { PgStore } from '#domain-model'
import { dagTaskId } from '../workflows/dag-materialization.ts'
import { createActivities } from '../workflows/activities.ts'
import { FakeAdapter, syntheticRunner } from '../tests/workflow/fake-adapter.ts'

process.env.NO_PROXY=process.env.no_proxy='localhost,127.0.0.1,::1'
process.env.grpc_proxy=''
const schema=process.env.CMAP_DB_SCHEMA,workRoot=process.env.CMAP_WORK_ROOT,counter=process.env.CMAP_LAUNCH_COUNTER
assert.ok(schema?.startsWith('cmap_dag_admission_'),'Use an isolated admission schema')
assert.ok(workRoot&&isAbsolute(workRoot)&&counter&&isAbsolute(counter),'Absolute private work root/counter required')
const allowedPort=Number(process.env.CMAP_API_PORT),deniedPort=Number(process.env.CMAP_DENIED_API_PORT)
assert.ok(allowedPort>0&&deniedPort>0&&allowedPort!==deniedPort)
const store=new PgStore({connectionString:process.env.CMAP_DATABASE_URL??'postgres://temporal:temporal@localhost:5433/cmap',schema})
const connection=await Connection.connect({address:process.env.TEMPORAL_ADDRESS??'localhost:7233',connectTimeout:5000})
const client=new Client({connection,namespace:process.env.TEMPORAL_NAMESPACE??'default'})
assert.ok(process.argv.length===2||(process.argv.length===3&&process.argv[2]==='--dag-only'),'Only --dag-only resume is supported')
const launches=async()=>{try{return (await readFile(counter,'utf8')).trim().split('\n').filter(Boolean).length}catch(e){if(e.code==='ENOENT')return 0;throw e}}
const criterion=id=>({criterion_id:id,metric:id,operator:'eq',expected:42,hard_gate:true})
async function run(port,request){
  const response=await fetch(`http://127.0.0.1:${port}/v1/missions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(15000)})
  assert.equal(response.status,202)
  const started=await response.json(),handle=client.workflow.getHandle(started.workflow_id)
  const result=await handle.result()
  const mission=await store.getMission(result.missionId)
  assert.equal(mission.state,'ESCALATED')
  assert.equal(result.state,'ESCALATED')
  return {result,mission,handle}
}
try {
  if(process.argv[2]!=='--dag-only') {
  const before=await launches()
  const denied=await run(deniedPort,{request_id:`admission-owner-${Date.now()}`,goal:'Write a private structured report with value 42.',risk_level:'read-meta',max_additional_cycles:0,acceptance:[criterion('value')]})
  const tasks=await store.queryTasks({missionId:denied.mission.id})
  assert.equal(tasks.length,1)
  const task=tasks[0]
  assert.equal(task.state,'CANCELED');assert.equal(task.binding,null);assert.equal(task.result,null)
  assert.match(denied.result.summary,/RUNNER_ADMISSION_DENIED:OWNER_DENIED/)
  assert.equal(await launches(),before)
  await assert.rejects(access(join(workRoot,task.id)),{code:'ENOENT'})
  const events=await store.listEvents(denied.mission.id)
  assert.equal(events.some(e=>['TASK_ASSIGNED','TASK_STARTED','TASK_DISPATCH_INTENT'].includes(e.event_type)),false)
  const receipt=events.find(e=>e.idempotency_key===`runner-admission:${task.id}`)
  assert.equal(receipt.payload.code,'OWNER_DENIED')
  // Restart/retry semantics against real PostgreSQL, with an inert Adapter and a
  // newly relaxed synthetic grant. This is not another real Agent execution.
  const adapter=new FakeAdapter(),runner=syntheticRunner({runner_id:'receipt-recheck',tenant:task.envelope.identity.tenant,agents:['fake'],admission:{allowed_tenants:[task.envelope.identity.tenant],allowed_owners:[task.envelope.identity.owner],allowed_capabilities:['code.analyze'],max_risk:'read-meta'}})
  const retry=createActivities({store,adapter,runner,workRoot})
  assert.deepEqual(await retry.dispatchTask(task.id),{dispatched:false,admissionDenied:{phase:'initial',code:'OWNER_DENIED'}})
  assert.equal(adapter.startCalls.length,0)
  await Worker.runReplayHistory({workflowsPath:resolve('workflows/index.ts')},await denied.handle.fetchHistory())
  console.log(JSON.stringify({case:'owner-denied',missionId:denied.mission.id,launchDelta:0,pgReceiptReplay:'passed',historyReplay:'passed'}))
  }

  const parentGoal='Write evidence/report.json containing exactly {"value":42}. Read it back and report actual 42 for criterion parent. Include the file as a report artifact.'
  const beforeDag=await launches()
  const dag=await run(allowedPort,{request_id:`admission-dag-${Date.now()}`,goal:'Verify host admission before copying an accepted parent report.',risk_level:'controlled',max_additional_cycles:0,acceptance:[criterion('parent'),criterion('blocked')],plan:{schema:'cmap/mission-plan/v1',nodes:[
    {node_id:'parent',goal:parentGoal,capability:'code.analyze',deps:[],criterion_ids:['parent'],risk_level:'read-meta',preferred_agent:'codex'},
    {node_id:'blocked',goal:'Read the supplied parent report and report its value.',capability:'code.analyze',deps:['parent'],criterion_ids:['blocked'],risk_level:'controlled',preferred_agent:'codex'},
  ]}})
  const dagTasks=await store.queryTasks({missionId:dag.mission.id})
  assert.equal(dagTasks.length,1);assert.equal(dagTasks[0].state,'COMPLETED')
  assert.equal(dagTasks[0].binding.adapter,'codex-adapter')
  const report=(await store.listArtifacts(dagTasks[0].id)).find(a=>a.role==='report')
  assert.ok(report,'Allowed parent must publish a report')
  const bytes=await readFile(isAbsolute(report.uri)?report.uri:join(workRoot,dagTasks[0].id,report.uri))
  assert.equal(createHash('sha256').update(bytes).digest('hex'),report.sha256)
  assert.ok(JSON.parse(bytes).value===42,'Allowed parent report must independently prove 42')
  assert.equal(dag.result.nodeOutcomes.find(n=>n.nodeId==='blocked').reason,'RUNNER_ADMISSION_DENIED:RISK_DENIED')
  assert.equal(await launches()-beforeDag,1)
  const blockedId=dagTaskId(dag.mission.id,'blocked',1)
  assert.equal(await store.getTask(blockedId),null)
  await assert.rejects(access(join(workRoot,blockedId)),{code:'ENOENT'})
  assert.equal((await store.listPendingApprovals(dag.mission.id)).length,0)
  assert.equal((await store.listActiveLocks(new Date().toISOString())).filter(l=>l.mission_id===dag.mission.id).length,0)
  await Worker.runReplayHistory({workflowsPath:resolve('workflows/index.ts')},await dag.handle.fetchHistory())
  console.log(JSON.stringify({case:'dag-pre-copy-denied',missionId:dag.mission.id,realParentRuns:1,blockedChildRuns:0,childTask:false,childDirectory:false,historyReplay:'passed'}))
} finally {await store.close();await connection.close()}
