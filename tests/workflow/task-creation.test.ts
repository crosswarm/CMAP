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
