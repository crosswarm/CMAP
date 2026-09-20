import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Ajv from 'ajv'
import { planMission, plannerSchema } from '../../scripts/plan-mission.mjs'

const input = {request_id:'planner-test-01',goal:'Count synthetic files.',risk_level:'read-meta',acceptance:[{criterion_id:'count',metric:'files',operator:'eq',expected:3}]}
const plan = {schema:'cmap/mission-plan/v1',nodes:[{node_id:'count',goal:'Count files and write a report.',capability:'code.analyze',deps:[],criterion_ids:['count'],risk_level:'read-meta'}]}
async function fake(t, body) {
  const dir=await mkdtemp(join(tmpdir(),'cmap-planner-test-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const bin=join(dir,'claude'),args=join(dir,'args.json')
  await writeFile(bin,'#!/usr/bin/env node\n'+`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2)));let stdin='';for await(const c of process.stdin)stdin+=c;`+body,{mode:0o700})
  return {bin,args,dir}
}
const output = (value) => `console.log(${JSON.stringify(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:value,session_id:'synthetic-session'}))})`

test('provider schema is self-contained Draft-07 derived from mission-plan',()=>{
  const schema=plannerSchema()
  assert.equal(schema.$schema,'http://json-schema.org/draft-07/schema#')
  assert.equal(JSON.stringify(schema).includes('"$ref"'),false)
  const validate=new Ajv({strict:true}).compile(schema)
  assert.equal(validate(plan),true)
  assert.equal(validate({...plan,owner:'invented'}),false)
  assert.equal(validate({...plan,nodes:[{...plan.nodes[0],risk_level:'unknown'}]}),false)
  assert.equal(validate({...plan,nodes:[{...plan.nodes[0],required_resource_locks:[{resource:'x',ttl_seconds:1}]}]}),false)
})

test('isolated CLI adds canonical plan while preserving caller facts and dropping provider metadata',async t=>{
  const {bin,args}=await fake(t,output(plan))
  const actual=await planMission(input,{bin})
  assert.deepEqual(actual,{...input,plan:{...plan,concurrency:2,nodes:[{...plan.nodes[0],required_resource_locks:[]}]}})
  const argv=JSON.parse(await readFile(args,'utf8'))
  for(const flag of ['--safe-mode','--restricted','--strict-mcp-config','--no-chrome','--no-session-persistence']) assert.ok(argv.includes(flag),flag)
  assert.equal(argv[argv.indexOf('--tools')+1],'')
  assert.equal(argv[argv.indexOf('--permission-mode')+1],'dontAsk')
  assert.equal(argv[argv.indexOf('--permission-prompts')+1],'none')
  assert.equal(argv.includes(input.goal),false,'goal is stdin, not a command line argument')
  assert.equal('session_id' in actual,false)
})

test('invalid caller input is rejected before model invocation; explicit plan only normalizes',async()=>{
  await assert.rejects(()=>planMission({...input,owner:'invented'},{bin:'/not-a-cli'}),/请求/)
  const actual=await planMission({...input,plan},{bin:'/not-a-cli'})
  assert.equal(actual.plan.concurrency,2)
})

test('preserves UTF-8 plan text split across stdout chunks',async t=>{
  const chinese={...plan,nodes:[{...plan.nodes[0],goal:'核对数字并写入报告'}]}
  const encoded=JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:chinese})
  const {bin}=await fake(t,`const data=Buffer.from(${JSON.stringify(encoded)});const cut=data.indexOf(Buffer.from('数'))+1;process.stdout.write(data.subarray(0,cut));await new Promise(r=>setTimeout(r,20));process.stdout.write(data.subarray(cut));`)
  assert.equal((await planMission(input,{bin})).plan.nodes[0].goal,chinese.nodes[0].goal)
})

test('rejects invalid model graph, unknown fields, and risk escalation',async t=>{
  for(const invalid of [
    {...plan,nodes:[{...plan.nodes[0],deps:['count']}]},
    {...plan,owner:'invented'},
    {...plan,nodes:[{...plan.nodes[0],risk_level:'mutating'}]},
    {...plan,nodes:[{...plan.nodes[0],criterion_ids:['unknown']}]},
    {...plan,nodes:[{...plan.nodes[0],capability:'not-installed'}]},
    {...plan,nodes:[{...plan.nodes[0],preferred_agent:'imaginary-agent'}]},
    {...plan,nodes:[{...plan.nodes[0],preferred_agent:'kimi',capability:'performance.root_cause'}]},
  ]) {
    const {bin}=await fake(t,output(invalid))
    await assert.rejects(()=>planMission(input,{bin}),/PLANNER_PLAN_INVALID/)
  }
})

test('provider failures stay sanitized; no fallback parses free-form output',async t=>{
  for(const body of [
    `console.log('private provider body');process.exitCode=1`,
    `console.log(JSON.stringify({type:'result',subtype:'error_max_turns',is_error:true,structured_output:${JSON.stringify(plan)}}))`,
    `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'a prose plan'}))`,
    `console.log('not JSON, private provider body')`,
  ]) {
    const {bin}=await fake(t,body)
    await assert.rejects(()=>planMission(input,{bin}),error=>/^PLANNER_[A-Z_]+$/.test(error.message))
  }
})

test('reports the observed authentication rejection without provider details',async t=>{
  const {bin}=await fake(t,`console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,result:'Failed to authenticate. API Error: 403 Request not allowed'}));process.exitCode=1`)
  await assert.rejects(()=>planMission(input,{bin}),{message:'PLANNER_AUTH_REJECTED'})
})

test('Planner receives current adapter descriptors including Kimi mutating support',async t=>{
  const proposed={...plan,nodes:[{...plan.nodes[0],risk_level:'mutating',preferred_agent:'kimi'}]}
  const {bin}=await fake(t,`const desc=JSON.parse(stdin).adapters.find(a=>a.agent_id==='kimi');if(desc.risk_ceiling!=='mutating')process.exit(7);`+output(proposed))
  assert.equal((await planMission({...input,risk_level:'mutating'},{bin})).plan.nodes[0].risk_level,'mutating')
})

test('timeout and output cap terminate owned CLI before returning an error',async t=>{
  for(const [body,timeoutMs,errorCode] of [
    [`setInterval(()=>{},1000)`,150,'PLANNER_TIMEOUT'],
    [`process.stdout.write('x'.repeat(1100000));setInterval(()=>{},1000)`,5000,'PLANNER_OUTPUT_LIMIT'],
  ]) {
    const {bin}=await fake(t,body)
    const started=Date.now()
    await assert.rejects(()=>planMission(input,{bin,timeoutMs}),{message:errorCode})
    assert.ok(Date.now()-started<6000)
  }
})
