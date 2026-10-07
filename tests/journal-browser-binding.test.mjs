import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBrowserJournalSource, createBrowserJournalBinding } from '../public/journal-browser.mjs';

const WID='11111111-1111-4111-8111-111111111111';

function env(origin,width=1200,fine=true){return {location:{origin},innerWidth:width,matchMedia:()=>({matches:fine})};}
function configFetch(siteOrigin='https://prod.example'){return async()=>new Response(JSON.stringify({configured:true,url:'https://iaecgwitsxghsovdkotw.supabase.co',publishableKey:'sb_publishable_test',siteOrigin}),{status:200,headers:{'content-type':'application/json'}});}
function fakeSupabase({session=true,onRpc=()=>{}}={}){
  const calls=[];
  const client={
    auth:{getSession:async()=>({data:{session:session?{user:{id:'u1',email:'x@example.com'}}:null},error:null})},
    rpc:async(name,args)=>{calls.push({name,args});onRpc(name,args);if(name==='ensure_personal_family_workspace')return {data:WID,error:null};if(name==='journal_create')return {data:{status:'applied',targetType:'entry',targetId:'e1',version:1,operation:'create'},error:null};return {data:null,error:null};},
    from:()=>({select(){return this;},eq(){return this;},is(){return this;},gte(){return this;},lte(){return this;},order(){return this;},limit(){return Promise.resolve({data:[],error:null});}})
  };
  return {client,calls,module:{createClient:()=>client}};
}

test('browser source detects desktop vs mobile',()=>{
  assert.equal(detectBrowserJournalSource(env('https://x',1200,true)),'desktop');
  assert.equal(detectBrowserJournalSource(env('https://x',430,false)),'mobile');
  assert.equal(detectBrowserJournalSource(env('https://x',700,true)),'mobile');
});

test('preview/origin mismatch fails closed before workspace or Journal mutation',async()=>{
  const fake=fakeSupabase();
  const binding=createBrowserJournalBinding({fetchImpl:configFetch('https://prod.example'),loadSupabase:async()=>fake.module,env:env('https://preview.example')});
  await assert.rejects(()=>binding.createEntry({entryDate:'2026-09-07'}),e=>e?.code==='journal_origin_mismatch'&&e?.category==='access');
  assert.equal(fake.calls.length,0);
});

test('desktop binding reuses authenticated session and injects desktop source',async()=>{
  const fake=fakeSupabase();
  const binding=createBrowserJournalBinding({fetchImpl:configFetch('https://prod.example'),loadSupabase:async()=>fake.module,env:env('https://prod.example',1440,true)});
  const result=await binding.createEntry({entryDate:'2026-09-07',title:'測試'} ,{mutationId:'22222222-2222-4222-8222-222222222222'});
  assert.equal(result.ok,true);
  assert.deepEqual(fake.calls.map(x=>x.name),['ensure_personal_family_workspace','journal_create']);
  const args=fake.calls[1].args;
  assert.equal(args.p_source,'desktop');
  assert.equal(args.p_workspace_id,WID);
  assert.equal(args.p_mutation_id,'22222222-2222-4222-8222-222222222222');
});

test('mobile binding injects mobile source',async()=>{
  const fake=fakeSupabase();
  const binding=createBrowserJournalBinding({fetchImpl:configFetch('https://prod.example'),loadSupabase:async()=>fake.module,env:env('https://prod.example',430,false)});
  await binding.createEntry({entryDate:'2026-09-07'},{mutationId:'33333333-3333-4333-8333-333333333333'});
  assert.equal(fake.calls[1].args.p_source,'mobile');
});

test('browser binding requires a signed-in session',async()=>{
  const fake=fakeSupabase({session:false});
  const binding=createBrowserJournalBinding({fetchImpl:configFetch('https://prod.example'),loadSupabase:async()=>fake.module,env:env('https://prod.example')});
  await assert.rejects(()=>binding.listEntries(),e=>e?.code==='journal_not_authenticated'&&e?.category==='auth');
  assert.equal(fake.calls.length,0);
});


test('Journal browser loads dedicated journal-config instead of shared cloud-config',async()=>{
  let requested='';
  const fetchImpl=async url=>{requested=String(url);return new Response(JSON.stringify({configured:true,url:'https://edjnwbticmkajwdqbgjz.supabase.co',publishableKey:'sb_publishable_test',siteOrigin:'https://prod.example'}),{status:200,headers:{'content-type':'application/json'}});};
  const fake=fakeSupabase({session:false});
  const binding=createBrowserJournalBinding({fetchImpl,loadSupabase:async()=>fake.module,env:env('https://prod.example')});
  await binding.init();
  assert.equal(requested,'/api/journal-config');
});

test('year album media query is workspace scoped, chunked and filters only live ready media',async()=>{
  const calls=[];
  const query={
    select(v){calls.push(['select',v]);return this;},
    eq(k,v){calls.push(['eq',k,v]);return this;},
    in(k,v){calls.push(['in',k,[...v]]);return this;},
    is(k,v){calls.push(['is',k,v]);return this;},
    order(k,v){calls.push(['order',k,v]);return this;},
    limit(v){calls.push(['limit',v]);return Promise.resolve({data:[{id:'m1',entry_id:'e1',storage_path:'x'}],error:null});}
  };
  const client={
    auth:{getSession:async()=>({data:{session:{user:{id:'u1'}}},error:null})},
    rpc:async name=>name==='ensure_personal_family_workspace'?{data:WID,error:null}:{data:null,error:null},
    from:table=>{calls.push(['from',table]);return query;},
    storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:'x'},error:null}),createSignedUrls:async()=>({data:[],error:null})})}
  };
  const binding=createBrowserJournalBinding({fetchImpl:configFetch('https://prod.example'),loadSupabase:async()=>({createClient:()=>client}),env:env('https://prod.example')});
  const ids=Array.from({length:80},(_,i)=>`entry-${i}`);
  const rows=await binding.listMediaForEntries(ids,{limit:240});
  assert.equal(rows.length,2);
  const chunks=calls.filter(x=>x[0]==='in');
  assert.equal(chunks.length,2);
  assert.equal(chunks[0][2].length,75);
  assert.equal(chunks[1][2].length,5);
  assert.ok(calls.some(x=>x[0]==='eq'&&x[1]==='workspace_id'&&x[2]===WID));
  assert.ok(calls.some(x=>x[0]==='eq'&&x[1]==='upload_state'&&x[2]==='ready'));
  assert.ok(calls.some(x=>x[0]==='is'&&x[1]==='deleted_at'&&x[2]===null));
});
