import assert from 'node:assert/strict'
import {test} from 'node:test'
import {MemoryStore,TaskConflictError,type Mission,type TaskRecord} from '#domain-model'
import {createActivities} from '../../workflows/activities.ts'
import {syntheticActivityDeps,syntheticRunner} from './fake-adapter.ts'

const actor={type:'system',id:'task-creation-test'} as const
const m:Mission={id:'creation',tenant:'test',owner:'test',type:'inspect',goal:'synthetic',constraints:{},
  acceptance:[{criterion_id:'C',metric:'value',operator:'eq',expected:1,hard_gate:true}],
  workflow_template:'inspect/v1',state:'RUNNING',revision:1,created_at:'2026-09-22T00:00:00.000Z',updated_at:'2026-09-22T00:00:00.000Z'}
const input={missionId:m.id,capability:'code.analyze'}
const acts=(store:MemoryStore)=>createActivities(syntheticActivityDeps({store,runner:syntheticRunner()}))
async function fixture(){const store=new MemoryStore();await store.createMission({mission:m,actor});return store}

test('initial task commit with lost response is recovered by a fresh Activity instance',async()=>{
  const store=await fixture(),create=store.createTask.bind(store)
  store.createTask=async input=>{await create(input);throw new Error('lost creation acknowledgement')}
  await assert.rejects(acts(store).createTask(input),/lost creation acknowledgement/)
  store.createTask=create
  const out=await acts(store).createTask(input)
  const tasks=await store.queryTasks({missionId:m.id})
  assert.equal(tasks.length,1)
  assert.equal(out.taskId,tasks[0]!.id)
  assert.equal((await store.listEvents(m.id)).filter(e=>e.event_type==='TASK_CREATED').length,1)
})

test('explicit distinct intents stay distinct and concurrent retries share one task',async()=>{
  const store=await fixture()
  const same=await Promise.all(Array.from({length:4},()=>acts(store).createTask({...input,creationKey:'one'})))
  assert.equal(new Set(same.map(x=>x.taskId)).size,1)
  const other=await acts(store).createTask({...input,creationKey:'two'})
  assert.notEqual(other.taskId,same[0]!.taskId)
  assert.equal((await store.queryTasks({missionId:m.id})).length,2)
  await assert.rejects(acts(store).createTask({...input,creationKey:'one',goal:'different intent'}),TaskConflictError)
})

test('invalid creation keys fail before task writes',async()=>{
  const store=await fixture()
  for(const creationKey of ['', ' ', 'x'.repeat(513),null,7]) {
    await assert.rejects(acts(store).createTask({...input,creationKey:creationKey as string}),/TASK_CREATION_KEY_INVALID/)
  }
  assert.equal((await store.queryTasks({missionId:m.id})).length,0)
})

const legacy=(task:TaskRecord,id:string):TaskRecord=>({...task,id,envelope:{...task.envelope,identity:{...task.envelope.identity,task_id:id,idempotency_key:`${m.id}:${id}`}}})
test('one matching legacy initial task is retained; ambiguity and changed intent fail closed',async()=>{
  const source=await fixture(),out=await acts(source).createTask(input),template=(await source.getTask(out.taskId))!
  const store=await fixture()
  await store.createTask({task:legacy(template,'tsk_old_0001'),actor})
  assert.deepEqual(await acts(store).createTask(input),{taskId:'tsk_old_0001'})
  await assert.rejects(acts(store).createTask({...input,goal:'changed'}),TaskConflictError)
  await store.createTask({task:legacy(template,'tsk_old_0002'),actor})
  await assert.rejects(acts(store).createTask(input),/TASK_CREATION_AMBIGUOUS/)
  assert.equal((await store.queryTasks({missionId:m.id})).length,2)
})

test('typed parameters and normalized artifact refs survive creation, mutation and retries without changing authority', async () => {
  const store = await fixture()
  const artifactRefs = [{artifact_id:'source:report',source_task_id:'source',role:'report',sha256:'a'.repeat(64),uri:'inputs/review/'+'b'.repeat(64)+'/payload'}]
  const parameters = {nested:{values:[0,false,null]},risk_level:'mutating',execution_policy:{max_attempts:999}}
  const incoming = {...input,creationKey:'rich',taskType:'refinement.test',parameters,artifactRefs}
  const original = structuredClone(incoming)
  const getMission = store.getMission.bind(store)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  store.getMission = async id => {entered.resolve();await release.promise;return getMission(id)}
  const pending = acts(store).createTask(incoming)
  await entered.promise
  incoming.taskType = 'changed'
  incoming.parameters.nested.values.push(99)
  incoming.artifactRefs[0]!.role = 'changed'
  release.resolve()
  const created = await pending
  store.getMission = getMission
  const task = await store.getTask(created.taskId)
  assert.equal(task?.envelope.classification.task_type,original.taskType)
  assert.deepEqual(task.envelope.inputs?.parameters,original.parameters)
  assert.deepEqual(task.envelope.inputs?.artifact_refs,original.artifactRefs)
  assert.equal(task.risk,'read-meta')
  assert.equal(task.envelope.execution_policy.max_attempts,1)
  assert.deepEqual(task.envelope.permissions,{forbidden:[]})
  assert.deepEqual(await acts(store).createTask(original),created)
  await assert.rejects(acts(store).createTask({...original,parameters:{changed:true}}),TaskConflictError)
})

test('non-JSON parameters and empty task types fail before task writes; explicit empty parameters remain present', async () => {
  const store = await fixture()
  const cyclic: Record<string,unknown> = {};cyclic.self=cyclic
  for (const parameters of [{value:Infinity},{value:1n},{value:undefined},{value:new Date()},cyclic]) {
    await assert.rejects(acts(store).createTask({...input,parameters,creationKey:'bad'}),/INVALID/)
  }
  await assert.rejects(acts(store).createTask({...input,taskType:'',creationKey:'bad'}),/INVALID/)
  assert.equal((await store.queryTasks({missionId:m.id})).length,0)
  const created = await acts(store).createTask({...input,parameters:{},creationKey:'empty'})
  assert.deepEqual((await store.getTask(created.taskId))?.envelope.inputs?.parameters,{})
})
