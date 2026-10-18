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
import {createActivities} from '../../workflows/activities.ts'
import {FileFakeAdapter,syntheticActivityDeps,syntheticRunner} from './fake-adapter.ts'
import {fakeMemrossServer} from './fake-memross.ts'

const QUEUE=`cmap-continuity-${process.pid}-${Date.now()}`
const ADDRESS=process.env['TEMPORAL_ADDRESS']??'localhost:7233'

/** 结果附带可复用结论，驱动 propose。 */
class FindingAdapter extends FileFakeAdapter {
  override async collectResult(binding:RemoteTaskBinding):Promise<TaskResultV1> {
    const result=await super.collectResult(binding)
    return {...result,findings:[{severity:'medium',code:'READBACK',description:'写回后必须回读持久化结果'}]}
  }
}

let conn:Connection,native:NativeConnection,worker:Worker,running:Promise<void>,client:Client
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
    activities:createActivities(syntheticActivityDeps({store,adapter,workRoot,runner:syntheticRunner({runner_id:'test-runner'}),pollIntervalMs:1,memory:memross.memory}))})
  running=worker.run()
})
after(async()=>{worker?.shutdown();await running?.catch(()=>{});await conn?.close();await native?.close();if(workRoot)await rm(workRoot,{recursive:true,force:true})})

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
