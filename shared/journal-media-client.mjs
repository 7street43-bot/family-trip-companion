const BUCKET='journal-media';
const SOURCES=new Set(['mobile','desktop','gpt']);
const MIME_TO_EXT=new Map([
  ['image/jpeg','jpg'],['image/png','png'],['image/webp','webp'],['image/heic','heic'],['image/heif','heif']
]);
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class JournalMediaError extends Error{
  constructor(message,{code='journal_media_error',category='validation',retryable=false,details=null,cause=null}={}){
    super(message);this.name='JournalMediaError';this.code=code;this.category=category;this.retryable=retryable;this.details=details;this.cause=cause;
  }
}

function assertUuid(name,value){const v=String(value||'').toLowerCase();if(!UUID_RE.test(v))throw new JournalMediaError(`${name} must be a uuid`,{code:`invalid_${name}`});return v;}
function assertSource(source){const s=String(source||'').toLowerCase();if(!SOURCES.has(s))throw new JournalMediaError('invalid media source',{code:'invalid_source'});return s;}
function newUuid(){if(globalThis.crypto?.randomUUID)return globalThis.crypto.randomUUID();throw new JournalMediaError('secure UUID generator unavailable',{code:'uuid_unavailable',category:'protocol'});}
function normalizeMime(mime){const m=String(mime||'').toLowerCase();if(!MIME_TO_EXT.has(m))throw new JournalMediaError('unsupported image type',{code:'unsupported_media_type'});return m;}

export function buildJournalMediaPath({workspaceId,entryId,mediaId,mimeType}){
  const w=assertUuid('workspaceId',workspaceId),e=assertUuid('entryId',entryId),m=assertUuid('mediaId',mediaId),mime=normalizeMime(mimeType);
  return `${w}/${e}/${m}/${m}.${MIME_TO_EXT.get(mime)}`;
}

export function createJournalMediaClient({source,transport}){
  const src=assertSource(source);
  if(!transport||typeof transport.rpc!=='function'||typeof transport.upload!=='function'||typeof transport.createSignedUrl!=='function'){
    throw new JournalMediaError('invalid media transport',{code:'invalid_transport'});
  }

  async function mutate(action,{workspaceId,entryId,mediaId,expectedVersion,payload={},mutationId}){
    const w=assertUuid('workspaceId',workspaceId),e=assertUuid('entryId',entryId),m=assertUuid('mediaId',mediaId),mu=assertUuid('mutationId',mutationId);
    const data=await transport.rpc('journal_media_mutate',{
      p_action:action,p_workspace_id:w,p_entry_id:e,p_media_id:m,
      p_expected_version:expectedVersion,p_payload:payload,p_source:src,p_mutation_id:mu
    });
    if(!data||typeof data!=='object'||!['applied','replayed','conflict'].includes(data.status)){
      throw new JournalMediaError('invalid media mutation response',{code:'invalid_response',category:'protocol',details:data});
    }
    return data;
  }

  async function reserve({workspaceId,entryId,mediaId=newUuid(),mimeType,width=null,height=null,caption=null,takenAt=null,sortOrder=1000,mutationId=newUuid()}){
    const mime=normalizeMime(mimeType);
    const path=buildJournalMediaPath({workspaceId,entryId,mediaId,mimeType:mime});
    const result=await mutate('reserve',{workspaceId,entryId,mediaId,expectedVersion:0,mutationId,payload:{
      storage_path:path,mime_type:mime,width,height,caption,taken_at:takenAt,sort_order:sortOrder
    }});
    return {result,mediaId:String(mediaId).toLowerCase(),storagePath:path,reserveMutationId:String(mutationId).toLowerCase()};
  }

  async function finalize({workspaceId,entryId,mediaId,expectedVersion=1,mutationId=newUuid()}){
    const result=await mutate('finalize',{workspaceId,entryId,mediaId,expectedVersion,mutationId,payload:{}});
    return {result,finalizeMutationId:String(mutationId).toLowerCase()};
  }

  async function uploadPhoto({workspaceId,entryId,file,mediaId=newUuid(),reserveMutationId=newUuid(),finalizeMutationId=newUuid(),width=null,height=null,caption=null,takenAt=null,sortOrder=1000}){
    if(!file)throw new JournalMediaError('file required',{code:'file_required'});
    const mime=normalizeMime(file.type);
    if(Number(file.size)>26214400)throw new JournalMediaError('photo exceeds 25 MB',{code:'file_too_large'});
    const reserved=await reserve({workspaceId,entryId,mediaId,mimeType:mime,width,height,caption,takenAt,sortOrder,mutationId:reserveMutationId});
    if(reserved.result.status==='conflict')return {...reserved,finalizeMutationId,result:reserved.result};
    try{
      await transport.upload(BUCKET,reserved.storagePath,file,{contentType:mime,upsert:false});
    }catch(err){
      if(!transport.isObjectExistsError?.(err))throw new JournalMediaError('photo upload failed',{code:'upload_failed',category:'transport',retryable:true,details:{storagePath:reserved.storagePath},cause:err});
    }
    const finalized=await finalize({workspaceId,entryId,mediaId,expectedVersion:Number(reserved.result.version)||1,mutationId:finalizeMutationId});
    return {...reserved,...finalized,result:finalized.result};
  }

  async function update({workspaceId,entryId,mediaId,expectedVersion,patch,mutationId=newUuid()}){
    const allowed=new Set(['width','height','caption','takenAt','sortOrder']);
    const input=patch&&typeof patch==='object'?patch:{};
    for(const k of Object.keys(input))if(!allowed.has(k))throw new JournalMediaError(`unsupported media patch field: ${k}`,{code:'invalid_patch'});
    const payload={};
    if('width'in input)payload.width=input.width;if('height'in input)payload.height=input.height;if('caption'in input)payload.caption=input.caption;if('takenAt'in input)payload.taken_at=input.takenAt;if('sortOrder'in input)payload.sort_order=input.sortOrder;
    return mutate('update',{workspaceId,entryId,mediaId,expectedVersion,payload,mutationId});
  }

  const archive=(args)=>mutate('archive',{...args,payload:{},mutationId:args.mutationId||newUuid()});
  const restore=(args)=>mutate('restore',{...args,payload:{},mutationId:args.mutationId||newUuid()});
  const signedUrl=async({storagePath,expiresIn=900})=>transport.createSignedUrl(BUCKET,String(storagePath),Math.max(60,Math.min(3600,Number(expiresIn)||900)));

  return {source:src,bucket:BUCKET,reserve,finalize,uploadPhoto,update,archive,restore,signedUrl,buildPath:buildJournalMediaPath};
}
