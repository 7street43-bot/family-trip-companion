import { createJournalClient, JournalClientError, normalizeJournalError } from '../../shared/journal-client.mjs';

const DEFAULT_URL = 'https://iaecgwitsxghsovdkotw.supabase.co';
const DEFAULT_PUBLISHABLE_KEY = 'sb_publishable_6der9Hrl7J1KLrrzuXCdKQ_yl-IpYRe';
const RPCS = new Set(['journal_create','journal_update','journal_archive','journal_block_mutate']);
const TABLES = new Set(['journal_entries','journal_blocks','journal_media','journal_revisions']);
const FILTER_OPS = new Set(['eq','is','gte','lte']);
const COMMANDS = new Set([
  'createEntry','updateEntry','archiveEntry','restoreEntry',
  'createBlock','updateBlock','reorderBlock','deleteBlock','restoreBlock',
  'listEntries','getEntry'
]);
const MUTATING = new Set([
  'createEntry','updateEntry','archiveEntry','restoreEntry',
  'createBlock','updateBlock','reorderBlock','deleteBlock','restoreBlock'
]);

function json(body, status=200) {
  return new Response(JSON.stringify(body), { status, headers:{
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store',
    'x-content-type-options':'nosniff'
  }});
}

function config(env=process.env) {
  const url=String(env.SUPABASE_URL||DEFAULT_URL).trim().replace(/\/$/,'');
  const publishableKey=String(env.SUPABASE_PUBLISHABLE_KEY||DEFAULT_PUBLISHABLE_KEY).trim();
  if(!/^https:\/\/.+\.supabase\.co$/i.test(url)||!/^sb_publishable_/i.test(publishableKey)) throw new Error('journal_gateway_not_configured');
  return {url,publishableKey};
}

function bearer(req) {
  const raw=String(req.headers.get('authorization')||'');
  const m=raw.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim()||'';
}

async function readJsonResponse(res) {
  let data=null;
  try { data=await res.json(); } catch { data=null; }
  if(!res.ok){
    const err=new Error(String(data?.message||data?.msg||data?.error_description||data?.error||`upstream_http_${res.status}`));
    err.code=data?.code||`HTTP_${res.status}`;
    err.details=data?.details||data?.hint||null;
    err.status=res.status;
    throw err;
  }
  return data;
}

async function upstreamFetch(fetchImpl, url, init={}) {
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),12000);
  try { return await fetchImpl(url,{...init,signal:ctrl.signal}); }
  catch(err){
    if(err?.name==='AbortError'){
      const e=new Error('journal gateway upstream timeout');e.code='GATEWAY_TIMEOUT';throw e;
    }
    throw err;
  } finally { clearTimeout(timer); }
}

async function verifyUser({fetchImpl,baseUrl,publishableKey,token}) {
  const res=await upstreamFetch(fetchImpl,`${baseUrl}/auth/v1/user`,{headers:{apikey:publishableKey,authorization:`Bearer ${token}`}});
  if(!res.ok) return null;
  const data=await res.json().catch(()=>null);
  return data?.id?data:null;
}

async function rpcFetch({fetchImpl,baseUrl,publishableKey,token,name,args}) {
  const res=await upstreamFetch(fetchImpl,`${baseUrl}/rest/v1/rpc/${encodeURIComponent(name)}`,{
    method:'POST',headers:{apikey:publishableKey,authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(args||{})
  });
  return readJsonResponse(res);
}

function createRestJournalTransport({fetchImpl,baseUrl,publishableKey,token}) {
  async function rpc(name,args){
    if(!RPCS.has(String(name||''))) throw new Error(`journal rpc not allowed:${name}`);
    try { return {data:await rpcFetch({fetchImpl,baseUrl,publishableKey,token,name,args}),error:null}; }
    catch(error){ return {data:null,error}; }
  }
  async function query(spec={}){
    const table=String(spec.table||'');
    if(!TABLES.has(table)) throw new Error(`journal table not allowed:${table}`);
    const workspaceId=String(spec.workspaceId||'').trim();
    if(!workspaceId) throw new Error('workspaceId required');
    const url=new URL(`${baseUrl}/rest/v1/${table}`);
    url.searchParams.set('select','*');
    url.searchParams.set('workspace_id',`eq.${workspaceId}`);
    for(const f of spec.filters||[]){
      const col=String(f?.column||''),op=String(f?.op||'');
      if(!/^[a-z_][a-z0-9_]*$/i.test(col)||!FILTER_OPS.has(op)) throw new Error('invalid journal query filter');
      const val=op==='is'?(f.value===null?'null':String(f.value)):String(f.value);
      url.searchParams.set(col,`${op}.${val}`);
    }
    if((spec.order||[]).length){
      const order=(spec.order||[]).map(o=>{
        const col=String(o?.column||'');if(!/^[a-z_][a-z0-9_]*$/i.test(col)) throw new Error('invalid journal query order');
        return `${col}.${o.ascending?'asc':'desc'}`;
      }).join(',');
      url.searchParams.set('order',order);
    }
    url.searchParams.set('limit',String(Math.max(1,Math.min(Number(spec.limit)||100,1000))));
    try {
      const res=await upstreamFetch(fetchImpl,url,{headers:{apikey:publishableKey,authorization:`Bearer ${token}`}});
      return {data:await readJsonResponse(res),error:null};
    } catch(error){ return {data:null,error}; }
  }
  return Object.freeze({rpc,query});
}

function uuidLike(s){return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s||''));}
async function deterministicMutationId(userId,command,key){
  const data=new TextEncoder().encode(`${userId}:${command}:${key}`);
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',data));
  const b=hash.slice(0,16);b[6]=(b[6]&0x0f)|0x50;b[8]=(b[8]&0x3f)|0x80;
  const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

async function mutationIdFor(req,body,userId,command){
  if(uuidLike(body?.mutationId)) return String(body.mutationId);
  const key=String(req.headers.get('idempotency-key')||'').trim();
  if(!key||key.length>128) throw new JournalClientError('mutationId UUID or Idempotency-Key is required', {code:'journal_idempotency_required',category:'validation'});
  return deterministicMutationId(userId,command,key);
}

async function ensureWorkspace({fetchImpl,baseUrl,publishableKey,token,body}){
  const explicit=String(body?.workspaceId||'').trim();
  if(explicit) return explicit;
  const data=await rpcFetch({fetchImpl,baseUrl,publishableKey,token,name:'ensure_personal_family_workspace',args:{workspace_name:'我的家庭'}});
  const id=String(data||'').trim();
  if(!id) throw new Error('workspace_bootstrap_failed');
  return id;
}

async function executeCommand(client,command,body,mutationId){
  switch(command){
    case 'createEntry': return client.createEntry(body.input||{}, {mutationId});
    case 'updateEntry': return client.updateEntry(body.entryId,body.expectedVersion,body.patch||{}, {mutationId});
    case 'archiveEntry': return client.archiveEntry(body.entryId,body.expectedVersion,{mutationId});
    case 'restoreEntry': return client.restoreEntry(body.entryId,body.expectedVersion,{mutationId});
    case 'createBlock': return client.createBlock(body.entryId,body.input||{}, {mutationId});
    case 'updateBlock': return client.updateBlock(body.entryId,body.input||{}, {mutationId});
    case 'reorderBlock': return client.reorderBlock(body.entryId,body.input||{}, {mutationId});
    case 'deleteBlock': return client.deleteBlock(body.entryId,body.input||{}, {mutationId});
    case 'restoreBlock': return client.restoreBlock(body.entryId,body.input||{}, {mutationId});
    case 'listEntries': return client.listEntries(body.options||{});
    case 'getEntry': return client.getEntry(body.entryId,body.options||{});
    default: throw new JournalClientError('Unsupported Journal command',{code:'journal_command_invalid',category:'validation'});
  }
}

function errorStatus(err){
  const e=normalizeJournalError(err);
  if(e.category==='auth') return 401;
  if(e.category==='access') return 403;
  if(e.category==='validation') return 400;
  if(e.category==='transport') return 502;
  return 500;
}

export async function handleJournalGpt(req,{fetchImpl=globalThis.fetch?.bind(globalThis),env=process.env}={}){
  if(req.method!=='POST') return json({ok:false,error:'method_not_allowed'},405);
  const token=bearer(req);if(!token) return json({ok:false,error:'missing_bearer_token'},401);
  const len=Number(req.headers.get('content-length')||0);if(len>131072) return json({ok:false,error:'payload_too_large'},413);
  let body={};try{body=await req.json();}catch{return json({ok:false,error:'invalid_json'},400);}
  const command=String(body?.command||'');if(!COMMANDS.has(command)) return json({ok:false,error:'invalid_command'},400);
  try{
    const {url:baseUrl,publishableKey}=config(env);
    const user=await verifyUser({fetchImpl,baseUrl,publishableKey,token});
    if(!user) return json({ok:false,error:'invalid_or_expired_token'},401);
    const workspaceId=await ensureWorkspace({fetchImpl,baseUrl,publishableKey,token,body});
    const mutationId=MUTATING.has(command)?await mutationIdFor(req,body,user.id,command):null;
    const client=createJournalClient({
      source:'gpt',
      transport:createRestJournalTransport({fetchImpl,baseUrl,publishableKey,token}),
      workspaceProvider:async()=>workspaceId
    });
    const result=await executeCommand(client,command,body,mutationId);
    return json({ok:true,command,result});
  }catch(err){
    const e=normalizeJournalError(err);
    return json({ok:false,error:e.code,category:e.category,retryable:e.retryable,message:e.message,details:e.details||null,mutationId:e.mutationId||null},errorStatus(e));
  }
}

export default async req=>handleJournalGpt(req);
export const config={path:'/api/journal-gpt',rateLimit:{windowLimit:60,windowSize:60,aggregateBy:['ip','domain']}};
export const __test={bearer,deterministicMutationId,createRestJournalTransport,executeCommand,handleJournalGpt};
