/** 只读 search/read 的假 Memross：一个固定块，记录每次检索。本文件不是测试用例。 */
import {createHash} from 'node:crypto'

const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
export const blockBody='## 坑\n\n刷新后必须回读持久化结果。\n'

export function fakeMemross() {
  const searches:any[]=[]
  const fetchImpl=(async(url:string|URL,init?:RequestInit)=>{
    const path=new URL(String(url)).pathname,payload=JSON.parse(String(init?.body))
    const json=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}})
    if(path==='/api/memory/v1/search'){searches.push(payload);return json({request_id:'req_s',index_version:'idx',results:[{document_id:'doc_aaaaaaaaaaaaaaaaaaaaaaaa',revision_id:'rev_'+'b'.repeat(32),block_id:'blk_cccccccccccccccccccccccc',body_sha256:sha(blockBody),title:'坑'}]})}
    return json({request_id:'req_r',body:blockBody,body_sha256:sha(blockBody),returned_body_sha256:sha(blockBody),truncated:false})
  }) as typeof fetch
  return {searches,memory:{url:'http://memross.test',token:'test-token',fetch:fetchImpl}}
}


export type MemrossCall={path:string,body:any,auth:string|null}
/** 含 search/read（同上）与 propose/handoff 的假 Memross，记录写入请求。 */
export function fakeMemrossServer(mode:'ok'|'down'|'reject-blocks'='ok'){
  const calls:MemrossCall[]=[]
  const read=fakeMemross().memory.fetch!
  const fetchImpl=(async(url:string|URL,init?:RequestInit)=>{
    const path=new URL(String(url)).pathname
    if(path.endsWith('/search')||path.endsWith('/read'))return read(url,init)
    const body=JSON.parse(String(init?.body))
    calls.push({path,body,auth:new Headers(init?.headers).get('authorization')})
    if(mode==='down')throw new TypeError('fetch failed')
    const json=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})
    if(path==='/api/memory/v1/propose'){
      if(mode==='reject-blocks'&&body.evidence.some((e:any)=>e.uri.startsWith('memross-block:')))return json(400,{code:'EVIDENCE_REJECTED'})
      return json(200,{proposal_id:`prop_${sha(body.idempotency_key).slice(0,24)}`,status:'candidate',duplicate_of:null,evidence_status:'pending_verification',receipt_id:'rcpt_1'})
    }
    if(path==='/api/memory/v1/handoff')return json(200,{request_id:'req_h',handoff_id:'hof_00000000-0000-0000-0000-000000000001',expires_at:'2099-01-01T00:00:00.000Z'})
    return json(404,{code:'NOT_FOUND'})
  }) as typeof fetch
  return {calls,memory:{url:'http://memross.test',token:'worker-token',fetch:fetchImpl}}
}
