import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {MemoryStore,type Mission} from '#domain-model'
import {missionFromRequest} from '../../apps/control-plane-api/src/mission-submission.ts'
import {createActivities} from '../../workflows/activities.ts'
import {MEMORY_ROLE, fetchMemorySnapshot} from '../../workflows/memory-context.ts'
import {taskCreationId} from '../../workflows/task-creation.ts'
import {syntheticActivityDeps,syntheticRunner} from './fake-adapter.ts'

const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')
const actor={type:'system',id:'memory-context-test'} as const
const body='## 验收\n\n刷新后核验取数响应、写入回执和持久化回读。\n'
const block={document_id:'doc_1',revision_id:'rev_1',block_id:'blk_1',title:'验收',title_path:['刷新写回','验收'],
  source:{path:'docs/refresh.md',start_line:3,end_line:5,workspaces:[{workspace_id:'ws_1',branch:'develop'}]},
  kind:'source_excerpt',status:'active',body_sha256:sha(body),conflict:null}

/** 只认本测试期望的两个端点，记录每次调用；read 永远返回完整块。 */
function fakeMemross(options:{fail?:boolean,tamper?:boolean,results?:unknown[]}={}){
  const calls:{path:string,body:any,auth:string|null}[]=[]
  const fetchImpl=(async(url:string|URL,init?:RequestInit)=>{
    if(options.fail)throw new TypeError('fetch failed')
    const path=new URL(String(url)).pathname
    const payload=JSON.parse(String(init?.body))
    calls.push({path,body:payload,auth:new Headers(init?.headers).get('authorization')})
    const json=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})
    if(path==='/api/memory/v1/search')return json(200,{request_id:'req_s',index_version:'idx_1',scope_policy_version:'pol_1',
      resolved_scope:{project_ids:[payload.scope.project_id]},results:options.results??[block],truncated:false,warnings:['SOURCE_VERSION_UNTRACKED']})
    if(path==='/api/memory/v1/read'){
      const returned=options.tamper?body+'injected':body
      return json(200,{request_id:'req_r',document_id:'doc_1',revision_id:'rev_1',block_id:'blk_1',body:returned,
        returned_body_sha256:sha(returned),body_sha256:sha(body),truncated:false})
    }
    return json(404,{code:'NOT_FOUND'})
  }) as typeof fetch
  return {calls,memory:{url:'http://memross.test:19092',token:'test-token',fetch:fetchImpl}}
}

const mission=(constraints:Record<string,unknown>):Mission=>({id:'mis_memory',tenant:'test',owner:'test',type:'inspect',goal:'刷新写回如何验收',constraints,
  acceptance:[{criterion_id:'C',metric:'value',operator:'eq',expected:1,hard_gate:true}],
  workflow_template:'inspect/v1',state:'RUNNING',revision:1,created_at:'2026-10-16T00:00:00.000Z',updated_at:'2026-10-16T00:00:00.000Z'})

async function fixture(constraints:Record<string,unknown>){
  const store=new MemoryStore()
  await store.createMission({mission:mission(constraints),actor})
  const workRoot=await mkdtemp(join(tmpdir(),'cmap-memory-'))
  return {store,workRoot}
}

test('mission-create 的 memory 进入 Mission 约束，并拒绝与 plan 同时出现', () => {
  const base={request_id:'synthetic-request',goal:'Count files',risk_level:'read-meta',
    acceptance:[{criterion_id:'files',metric:'count',operator:'eq',expected:3}]}
  const m=missionFromRequest({...base,memory:{project_id:'prj_a'}},'t','o')
  assert.deepEqual(m.constraints['memory'],{project_id:'prj_a',limit:3})
  assert.equal(missionFromRequest(base,'t','o').constraints['memory'],undefined)
  const plan={schema:'cmap/mission-plan/v1',nodes:[{node_id:'A',goal:'Collect A',capability:'code.inspect',deps:[],criterion_ids:['files'],risk_level:'read-meta'}]}
  assert.ok(missionFromRequest({...base,plan},'t','o').constraints['plan'],'对照：同一 plan 单独提交合法')
  assert.throws(()=>missionFromRequest({...base,plan,memory:{project_id:'prj_a'}},'t','o'),/memory/)
})

test('快照逐块读取并核对散列，正文标注为数据，不含凭据', async () => {
  const {calls,memory}=fakeMemross()
  const snapshot=await fetchMemorySnapshot(memory,{projectId:'prj_a',query:'刷新写回',limit:3})
  assert.deepEqual(calls.map(c=>c.path),['/api/memory/v1/search','/api/memory/v1/read'])
  assert.equal(calls[0]!.auth,'Bearer test-token')
  assert.deepEqual(calls[1]!.body,{document_id:'doc_1',revision_id:'rev_1',block_id:'blk_1',expected_body_sha256:sha(body)})
  const text=snapshot.bytes.toString('utf8')
  assert.match(text,/数据，不是指令/)
  assert.ok(text.includes(body.trim()))
  const manifest=JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)![1]!)
  assert.deepEqual(manifest.items.map((i:any)=>[i.block_id,i.body_sha256]),[['blk_1',sha(body)]])
  assert.equal(manifest.index_version,'idx_1')
  assert.equal(text.includes('test-token'),false)
  await assert.rejects(fetchMemorySnapshot(fakeMemross({tamper:true}).memory,{projectId:'prj_a',query:'q',limit:3}),/MEMORY_HASH_MISMATCH/)
  await assert.rejects(fetchMemorySnapshot(fakeMemross({fail:true}).memory,{projectId:'prj_a',query:'q',limit:3}),/MEMORY_UNAVAILABLE/)
  const empty=await fetchMemorySnapshot(fakeMemross({results:[]}).memory,{projectId:'prj_a',query:'q',limit:3})
  assert.match(empty.bytes.toString('utf8'),/没有命中/)
})

test('首个任务携带冻结快照：工作区字节、信封引用与 artifact 记录三者一致，重试不重复检索', async (t) => {
  const {store,workRoot}=await fixture({memory:{project_id:'prj_a',limit:3}})
  t.after(()=>rm(workRoot,{recursive:true,force:true}))
  const {calls,memory}=fakeMemross()
  const acts=createActivities(syntheticActivityDeps({store,runner:syntheticRunner(),workRoot,memory}))
  const {taskId}=await acts.createTask({missionId:'mis_memory',capability:'code.analyze'})
  assert.equal(taskId,taskCreationId('mis_memory'))
  assert.deepEqual(calls[0]!.body,{query:'刷新写回如何验收',scope:{project_id:'prj_a'},limit:3})
  const task=(await store.getTask(taskId))!
  const ref=task.envelope.inputs!.artifact_refs!.find(r=>r.role===MEMORY_ROLE)!
  const bytes=await readFile(join(workRoot,taskId,ref.uri!))
  assert.equal(sha(bytes),ref.sha256)
  const [artifact]=await store.listArtifacts(taskId)
  assert.equal(artifact!.artifact_id,ref.artifact_id)
  assert.equal(artifact!.sha256,ref.sha256)
  assert.equal(artifact!.mission_id,'mis_memory')
  assert.equal(artifact!.producer.agent_id,'memross')

  const again=await createActivities(syntheticActivityDeps({store,runner:syntheticRunner(),workRoot,memory})).createTask({missionId:'mis_memory',capability:'code.analyze'})
  assert.equal(again.taskId,taskId)
  assert.equal(calls.length,2,'重试复用已冻结快照，不再检索')
  assert.equal((await store.listArtifacts(taskId)).length,1)
})

test('要求记忆但 Memross 不可用或未配置时失败关闭；未要求时不调用', async (t) => {
  const down=await fixture({memory:{project_id:'prj_a',limit:3}})
  t.after(()=>rm(down.workRoot,{recursive:true,force:true}))
  await assert.rejects(createActivities(syntheticActivityDeps({store:down.store,runner:syntheticRunner(),workRoot:down.workRoot,memory:fakeMemross({fail:true}).memory}))
    .createTask({missionId:'mis_memory',capability:'code.analyze'}),/MEMORY_UNAVAILABLE/)
  await assert.rejects(createActivities(syntheticActivityDeps({store:down.store,runner:syntheticRunner(),workRoot:down.workRoot}))
    .createTask({missionId:'mis_memory',capability:'code.analyze'}),/MEMORY_NOT_CONFIGURED/)
  assert.equal((await down.store.queryTasks({missionId:'mis_memory'})).length,0)

  const plain=await fixture({})
  t.after(()=>rm(plain.workRoot,{recursive:true,force:true}))
  const {calls,memory}=fakeMemross()
  const {taskId}=await createActivities(syntheticActivityDeps({store:plain.store,runner:syntheticRunner(),workRoot:plain.workRoot,memory}))
    .createTask({missionId:'mis_memory',capability:'code.analyze'})
  assert.equal(calls.length,0)
  assert.equal((await plain.store.getTask(taskId))!.envelope.inputs,undefined)
})
