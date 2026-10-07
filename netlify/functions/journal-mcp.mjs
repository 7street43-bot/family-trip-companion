import { handleJournalGpt } from './journal-gpt.mjs';

const SUPABASE_URL = String(process.env.JOURNAL_SUPABASE_URL || 'https://edjnwbticmkajwdqbgjz.supabase.co').replace(/\/$/, '');
const PUBLISHABLE_KEY = String(process.env.JOURNAL_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_g9rjLCbIIJo07h3z7UUKmg_yz3s176j');
const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name:'family-trip-journal', version:'1.0.0' };

function responseJson(body, status=200, headers={}) {
  return new Response(JSON.stringify(body), {
    status,
    headers:{
      'content-type':'application/json; charset=utf-8',
      'cache-control':'no-store',
      'x-content-type-options':'nosniff',
      ...headers
    }
  });
}

function bearer(req) {
  const match = String(req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function resourceMetadataUrl(req) {
  return new URL('/.well-known/oauth-protected-resource', req.url).toString();
}

function unauthorized(req, detail='Authorization required') {
  return responseJson(
    { error:'invalid_token', error_description:detail },
    401,
    { 'www-authenticate':`Bearer resource_metadata="${resourceMetadataUrl(req)}"` }
  );
}

async function verifyUser(token, fetchImpl=fetch) {
  if (!token) return null;
  const res = await fetchImpl(`${SUPABASE_URL}/auth/v1/user`, {
    headers:{ apikey:PUBLISHABLE_KEY, authorization:`Bearer ${token}` }
  }).catch(()=>null);
  if (!res?.ok) return null;
  const data = await res.json().catch(()=>null);
  return data?.id ? data : null;
}

async function restRows(path, token, fetchImpl=fetch) {
  const res = await fetchImpl(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers:{ apikey:PUBLISHABLE_KEY, authorization:`Bearer ${token}` }
  });
  const data = await res.json().catch(()=>null);
  if (!res.ok) throw new Error(String(data?.message || data?.error || `rest_http_${res.status}`));
  return Array.isArray(data) ? data : [];
}

async function listWorkspaces(user, token, fetchImpl=fetch) {
  const [workspaces, memberships] = await Promise.all([
    restRows('family_workspaces?select=id,name,created_by,is_primary,created_at&order=created_at.asc', token, fetchImpl),
    restRows(`family_workspace_members?select=workspace_id,role&user_id=eq.${encodeURIComponent(user.id)}`, token, fetchImpl)
  ]);
  const roles = new Map(memberships.map(row => [String(row.workspace_id), String(row.role || 'member')]));
  return workspaces.map(row => ({
    id:String(row.id),
    name:String(row.name || '我的家庭'),
    role:roles.get(String(row.id)) || (String(row.created_by) === String(user.id) ? 'owner' : 'member'),
    isPrimary:!!row.is_primary
  }));
}

const entryInput = {
  type:'object',
  properties:{
    entryDate:{ type:'string', description:'日誌日期，YYYY-MM-DD' },
    timezone:{ type:'string', default:'Asia/Taipei' },
    title:{ type:['string','null'] },
    summary:{ type:['string','null'] },
    tags:{ type:'array', items:{type:'string'} },
    participants:{ type:'array', items:{type:'string'} },
    tripRef:{ type:['string','null'] }
  },
  required:['entryDate'],
  additionalProperties:false
};

const tools = [
  {
    name:'family_list_workspaces',
    description:'列出目前登入者可存取的家庭 Workspace。讀寫日誌前若 workspaceId 不明，先呼叫此工具。',
    inputSchema:{ type:'object', properties:{}, additionalProperties:false },
    annotations:{ readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false }
  },
  {
    name:'journal_list_entries',
    description:'列出指定家庭的旅遊日誌，可依日期或 tripRef 篩選。',
    inputSchema:{ type:'object', properties:{
      workspaceId:{type:'string'}, from:{type:['string','null']}, to:{type:['string','null']},
      tripRef:{type:['string','null']}, includeArchived:{type:'boolean',default:false},
      limit:{type:'integer',minimum:1,maximum:500,default:100}
    }, required:['workspaceId'], additionalProperties:false },
    annotations:{ readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false }
  },
  {
    name:'journal_get_entry',
    description:'讀取一篇日誌及其區塊、媒體與可選修訂紀錄。',
    inputSchema:{ type:'object', properties:{
      workspaceId:{type:'string'}, entryId:{type:'string'}, includeArchived:{type:'boolean',default:true}, includeRevisions:{type:'boolean',default:false}
    }, required:['workspaceId','entryId'], additionalProperties:false },
    annotations:{ readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false }
  },
  {
    name:'journal_create_entry',
    description:'在指定家庭建立一篇旅遊日誌。此工具會寫入資料。',
    inputSchema:{ type:'object', properties:{ workspaceId:{type:'string'}, input:entryInput }, required:['workspaceId','input'], additionalProperties:false },
    annotations:{ readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false }
  },
  {
    name:'journal_update_entry',
    description:'以樂觀鎖版本更新既有旅遊日誌。expectedVersion 必須是目前版本；衝突時不覆寫。',
    inputSchema:{ type:'object', properties:{
      workspaceId:{type:'string'}, entryId:{type:'string'}, expectedVersion:{type:'integer',minimum:1},
      patch:{type:'object',properties:{
        entryDate:{type:'string'}, timezone:{type:'string'}, title:{type:['string','null']}, summary:{type:['string','null']},
        tags:{type:'array',items:{type:'string'}}, participants:{type:'array',items:{type:'string'}}, tripRef:{type:['string','null']}
      },additionalProperties:false}
    }, required:['workspaceId','entryId','expectedVersion','patch'], additionalProperties:false },
    annotations:{ readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false }
  },
  {
    name:'journal_set_archived',
    description:'封存或還原一篇旅遊日誌。此動作不做實體刪除。',
    inputSchema:{ type:'object', properties:{
      workspaceId:{type:'string'}, entryId:{type:'string'}, expectedVersion:{type:'integer',minimum:1}, archived:{type:'boolean'}
    }, required:['workspaceId','entryId','expectedVersion','archived'], additionalProperties:false },
    annotations:{ readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:false }
  },
  {
    name:'journal_mutate_block',
    description:'建立、更新、排序、刪除或還原日誌區塊。delete 為軟刪除並保留可還原性。',
    inputSchema:{ type:'object', properties:{
      workspaceId:{type:'string'}, entryId:{type:'string'}, operation:{type:'string',enum:['create','update','reorder','delete','restore']},
      block:{type:'object',properties:{
        blockId:{type:['string','null']}, expectedVersion:{type:'integer',minimum:0}, blockType:{type:['string','null']},
        sortOrder:{type:['number','null']}, content:{type:'object'}
      },required:['expectedVersion'],additionalProperties:false}
    }, required:['workspaceId','entryId','operation','block'], additionalProperties:false },
    annotations:{ readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:false }
  },
  {
    name:'journal_reserve_media',
    description:'為日誌照片預約私有媒體 metadata 與安全 Storage path。此工具不直接上傳圖片二進位。',
    inputSchema:{ type:'object', properties:{
      workspaceId:{type:'string'}, entryId:{type:'string'}, mediaId:{type:['string','null']},
      mimeType:{type:'string',enum:['image/jpeg','image/png','image/webp','image/heic','image/heif']},
      width:{type:['integer','null'],minimum:1}, height:{type:['integer','null'],minimum:1},
      caption:{type:['string','null']}, takenAt:{type:['string','null']}, sortOrder:{type:'integer',minimum:0,default:1000}
    }, required:['workspaceId','entryId','mimeType'], additionalProperties:false },
    annotations:{ readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false }
  },
  {
    name:'journal_finalize_media',
    description:'在 App/客戶端完成私有圖片上傳後，將已預約媒體標記為 ready。',
    inputSchema:{ type:'object', properties:{
      workspaceId:{type:'string'}, entryId:{type:'string'}, mediaId:{type:'string'}, expectedVersion:{type:'integer',minimum:1}
    }, required:['workspaceId','entryId','mediaId','expectedVersion'], additionalProperties:false },
    annotations:{ readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false }
  },
  {
    name:'journal_update_media',
    description:'以樂觀鎖版本更新照片 caption、尺寸、拍攝時間或排序。',
    inputSchema:{ type:'object', properties:{
      workspaceId:{type:'string'}, entryId:{type:'string'}, mediaId:{type:'string'}, expectedVersion:{type:'integer',minimum:1},
      patch:{type:'object',properties:{
        width:{type:['integer','null'],minimum:1}, height:{type:['integer','null'],minimum:1},
        caption:{type:['string','null']}, takenAt:{type:['string','null']}, sortOrder:{type:'integer',minimum:0}
      },additionalProperties:false}
    }, required:['workspaceId','entryId','mediaId','expectedVersion','patch'], additionalProperties:false },
    annotations:{ readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false }
  },
  {
    name:'journal_set_media_archived',
    description:'封存或還原一張日誌照片 metadata；不直接刪除私有 Storage 物件。',
    inputSchema:{ type:'object', properties:{
      workspaceId:{type:'string'}, entryId:{type:'string'}, mediaId:{type:'string'}, expectedVersion:{type:'integer',minimum:1}, archived:{type:'boolean'}
    }, required:['workspaceId','entryId','mediaId','expectedVersion','archived'], additionalProperties:false },
    annotations:{ readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:false }
  }
];

function mapTool(name, args={}) {
  switch(name) {
    case 'journal_list_entries':
      return { command:'listEntries', workspaceId:args.workspaceId, options:{ from:args.from??null, to:args.to??null, tripRef:args.tripRef??null, includeArchived:!!args.includeArchived, limit:args.limit??100 } };
    case 'journal_get_entry':
      return { command:'getEntry', workspaceId:args.workspaceId, entryId:args.entryId, options:{ includeArchived:args.includeArchived!==false, includeRevisions:!!args.includeRevisions } };
    case 'journal_create_entry':
      return { command:'createEntry', workspaceId:args.workspaceId, input:args.input || {} };
    case 'journal_update_entry':
      return { command:'updateEntry', workspaceId:args.workspaceId, entryId:args.entryId, expectedVersion:args.expectedVersion, patch:args.patch || {} };
    case 'journal_set_archived':
      return { command:args.archived ? 'archiveEntry' : 'restoreEntry', workspaceId:args.workspaceId, entryId:args.entryId, expectedVersion:args.expectedVersion };
    case 'journal_mutate_block': {
      const command = ({ create:'createBlock', update:'updateBlock', reorder:'reorderBlock', delete:'deleteBlock', restore:'restoreBlock' })[args.operation];
      return { command, workspaceId:args.workspaceId, entryId:args.entryId, input:args.block || {} };
    }
    case 'journal_reserve_media':
      return { command:'reserveMedia', workspaceId:args.workspaceId, entryId:args.entryId, mediaId:args.mediaId??null,
        mimeType:args.mimeType, width:args.width??null, height:args.height??null, caption:args.caption??null,
        takenAt:args.takenAt??null, sortOrder:args.sortOrder??1000 };
    case 'journal_finalize_media':
      return { command:'finalizeMedia', workspaceId:args.workspaceId, entryId:args.entryId, mediaId:args.mediaId, expectedVersion:args.expectedVersion };
    case 'journal_update_media':
      return { command:'updateMedia', workspaceId:args.workspaceId, entryId:args.entryId, mediaId:args.mediaId, expectedVersion:args.expectedVersion, patch:args.patch||{} };
    case 'journal_set_media_archived':
      return { command:args.archived?'archiveMedia':'restoreMedia', workspaceId:args.workspaceId, entryId:args.entryId, mediaId:args.mediaId, expectedVersion:args.expectedVersion };
    default: return null;
  }
}

async function callJournalGateway(req, token, body, rpcId) {
  const headers = new Headers({ 'content-type':'application/json', authorization:`Bearer ${token}` });
  if (!['listEntries','getEntry'].includes(body.command)) {
    headers.set('idempotency-key', `mcp:${body.command}:${String(rpcId ?? crypto.randomUUID())}`);
  }
  const innerReq = new Request(new URL('/api/journal-gpt', req.url), { method:'POST', headers, body:JSON.stringify(body) });
  const res = await handleJournalGpt(innerReq);
  const data = await res.json().catch(()=>({ ok:false, error:`gateway_http_${res.status}` }));
  if (!res.ok || !data?.ok) {
    const error = new Error(String(data?.message || data?.error || `journal_gateway_${res.status}`));
    error.details = data;
    throw error;
  }
  return data.result;
}

function toolResult(value, isError=false) {
  return {
    content:[{ type:'text', text:JSON.stringify(value) }],
    structuredContent:value && typeof value === 'object' ? value : { value },
    ...(isError ? { isError:true } : {})
  };
}

function rpcResult(id, result) { return responseJson({ jsonrpc:'2.0', id, result }); }
function rpcError(id, code, message, data=null, status=200) {
  return responseJson({ jsonrpc:'2.0', id:id ?? null, error:{ code, message, ...(data==null?{}:{data}) } }, status);
}

export async function handleJournalMcp(req, { fetchImpl=fetch }={}) {
  if (req.method === 'GET' || req.method === 'DELETE') return responseJson({ error:'method_not_allowed' },405,{allow:'POST'});
  if (req.method !== 'POST') return responseJson({ error:'method_not_allowed' },405,{allow:'POST'});

  const token = bearer(req);
  if (!token) return unauthorized(req);
  const user = await verifyUser(token, fetchImpl);
  if (!user) return unauthorized(req, 'The access token is invalid or expired');

  let msg;
  try { msg = await req.json(); } catch { return rpcError(null,-32700,'Parse error',null,400); }
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id ?? null,-32600,'Invalid Request',null,400);

  const id = msg.id ?? null;
  const method = msg.method;

  if (method === 'notifications/initialized') return new Response(null,{status:202});
  if (method === 'ping') return rpcResult(id,{});
  if (method === 'initialize') {
    const requested = String(msg.params?.protocolVersion || PROTOCOL_VERSION);
    const protocolVersion = ['2025-03-26','2025-06-18','2025-11-25'].includes(requested) ? requested : PROTOCOL_VERSION;
    return rpcResult(id,{
      protocolVersion,
      capabilities:{ tools:{} },
      serverInfo:SERVER_INFO,
      instructions:'這個伺服器只處理雙寶出遊趣的家庭 Workspace 與旅遊日誌。若 workspaceId 不明，先呼叫 family_list_workspaces；寫入前先讀取目前資料與 version，遇到 conflict 不得覆寫。'
    });
  }
  if (method === 'tools/list') return rpcResult(id,{tools});
  if (method !== 'tools/call') return rpcError(id,-32601,'Method not found');

  const name = String(msg.params?.name || '');
  const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {};
  const tool = tools.find(t => t.name === name);
  if (!tool) return rpcError(id,-32602,'Unknown tool');

  try {
    let result;
    if (name === 'family_list_workspaces') result = { workspaces:await listWorkspaces(user,token,fetchImpl) };
    else {
      const gatewayBody = mapTool(name,args);
      if (!gatewayBody?.command) throw new Error('invalid tool mapping');
      result = await callJournalGateway(req,token,gatewayBody,id);
    }
    return rpcResult(id,toolResult(result));
  } catch (err) {
    const detail = { error:String(err?.message || err), details:err?.details || null };
    return rpcResult(id,toolResult(detail,true));
  }
}

export default async req => handleJournalMcp(req);
export const config = { path:'/api/journal-mcp', rateLimit:{ windowLimit:120, windowSize:60, aggregateBy:['ip','domain'] } };
export const __test = { tools, mapTool, handleJournalMcp };
