import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../netlify/functions/journal-gpt.mjs';

const BASE='https://iaecgwitsxghsovdkotw.supabase.co';
const KEY='sb_publishable_test';
const WID='11111111-1111-4111-8111-111111111111';

function req(body,{token='jwt-token',idem='idem-1',headers={}}={}){
  const h={'content-type':'application/json',...headers};
  if(token)h.authorization=`Bearer ${token}`;
  if(idem)h['idempotency-key']=idem;
  return new Request('https://preview.example/api/journal-gpt',{method:'POST',headers:h,body:JSON.stringify(body)});
}

function fakeFetch({authOk=true,onRpc=()=>{},journalResponse={status:'applied',targetType:'entry',targetId:'e1',version:1,operation:'create'}}={}){
  return async(url,init={})=>{
    const u=String(url);
    if(u===`${BASE}/auth/v1/user`){
      return new Response(JSON.stringify(authOk?{id:'user-1',email:'x@example.com'}:{message:'invalid jwt'}),{status:authOk?200:401,headers:{'content-type':'application/json'}});
    }
    if(u===`${BASE}/rest/v1/rpc/ensure_personal_family_workspace`){
      return new Response(JSON.stringify(WID),{status:200,headers:{'content-type':'application/json'}});
    }
    if(u.includes('/rest/v1/rpc/')){
      const name=u.split('/').pop();
      const payload=JSON.parse(init.body||'{}');
      onRpc(name,payload,init.headers||{});
      return new Response(JSON.stringify(journalResponse),{status:200,headers:{'content-type':'application/json'}});
    }
    if(u.includes('/rest/v1/journal_')){
      return new Response(JSON.stringify([]),{status:200,headers:{'content-type':'application/json'}});
    }
    throw new Error(`unexpected URL ${u}`);
  };
}

const env={SUPABASE_URL:BASE,SUPABASE_PUBLISHABLE_KEY:KEY};

test('missing bearer token is rejected before upstream calls',async()=>{
  let called=0;
  const res=await __test.handleJournalGpt(req({command:'listEntries'},{token:'',idem:null}),{fetchImpl:async()=>{called++;throw new Error('should not call');},env});
  assert.equal(res.status,401);assert.equal(called,0);
});

test('invalid Supabase JWT is rejected',async()=>{
  const res=await __test.handleJournalGpt(req({command:'listEntries'},{idem:null}),{fetchImpl:fakeFetch({authOk:false}),env});
  assert.equal(res.status,401);
  const body=await res.json();assert.equal(body.error,'invalid_or_expired_token');
});

test('mutations require UUID mutationId or Idempotency-Key',async()=>{
  const res=await __test.handleJournalGpt(req({command:'createEntry',input:{entryDate:'2026-09-07'}},{idem:null}),{fetchImpl:fakeFetch(),env});
  assert.equal(res.status,400);
  const body=await res.json();assert.equal(body.error,'journal_idempotency_required');
});

test('gateway fixes actor source to gpt and never trusts body source',async()=>{
  let seen=null;
  const res=await __test.handleJournalGpt(req({command:'createEntry',source:'desktop',input:{entryDate:'2026-09-07',title:'X'}}),{fetchImpl:fakeFetch({onRpc:(n,p)=>{if(n==='journal_create')seen=p;}}),env});
  assert.equal(res.status,200);
  assert.equal(seen.p_source,'gpt');
  assert.equal(seen.p_workspace_id,WID);
  assert.match(seen.p_mutation_id,/^[0-9a-f-]{36}$/i);
});

test('same user/command/idempotency key derives the same mutation UUID',async()=>{
  const ids=[];
  const fetchImpl=fakeFetch({onRpc:(n,p)=>{if(n==='journal_create')ids.push(p.p_mutation_id);}});
  for(let i=0;i<2;i++){
    const res=await __test.handleJournalGpt(req({command:'createEntry',input:{entryDate:'2026-09-07'}},{idem:'same-key'}),{fetchImpl,env});
    assert.equal(res.status,200);
  }
  assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);
});

test('explicit mutation UUID is passed through unchanged',async()=>{
  const id='44444444-4444-4444-8444-444444444444';let seen='';
  const res=await __test.handleJournalGpt(req({command:'createEntry',mutationId:id,input:{entryDate:'2026-09-07'}},{idem:null}),{fetchImpl:fakeFetch({onRpc:(n,p)=>{if(n==='journal_create')seen=p.p_mutation_id;}}),env});
  assert.equal(res.status,200);assert.equal(seen,id);
});

test('conflict is returned as normal Journal result, not gateway error',async()=>{
  const res=await __test.handleJournalGpt(req({command:'updateEntry',entryId:'e1',expectedVersion:1,patch:{title:'new'}}),{fetchImpl:fakeFetch({journalResponse:{status:'conflict',reason:'version_mismatch',serverVersion:2}}),env});
  assert.equal(res.status,200);
  const body=await res.json();assert.equal(body.ok,true);assert.equal(body.result.status,'conflict');assert.equal(body.result.ok,false);assert.equal(body.result.conflict.serverVersion,2);
});

test('read commands do not require idempotency key and remain workspace scoped',async()=>{
  const res=await __test.handleJournalGpt(req({command:'listEntries',workspaceId:WID,options:{limit:5}},{idem:null}),{fetchImpl:fakeFetch(),env});
  assert.equal(res.status,200);
  const body=await res.json();assert.equal(body.command,'listEntries');assert.deepEqual(body.result,[]);
});

test('unsupported command fails closed',async()=>{
  const res=await __test.handleJournalGpt(req({command:'rawSql'},{idem:null}),{fetchImpl:fakeFetch(),env});
  assert.equal(res.status,400);
});
