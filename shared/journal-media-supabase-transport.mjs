const RPC_ALLOWLIST=new Set(['journal_media_mutate']);
const BUCKET='journal-media';

function fail(message){const e=new Error(message);e.code='journal_media_transport_guard';throw e;}

export function createSupabaseJournalMediaTransport(supabaseClient){
  if(!supabaseClient?.rpc||!supabaseClient?.storage?.from)throw new TypeError('Supabase client with rpc/storage is required');
  const fromBucket=(bucket)=>{if(bucket!==BUCKET)fail('bucket not allowed');return supabaseClient.storage.from(BUCKET);};
  return {
    async rpc(name,args){
      if(!RPC_ALLOWLIST.has(name))fail('rpc not allowed');
      const {data,error}=await supabaseClient.rpc(name,args);
      if(error)throw error;
      return data;
    },
    async upload(bucket,path,file,options={}){
      const api=fromBucket(bucket);
      const {data,error}=await api.upload(path,file,{contentType:options.contentType,upsert:false});
      if(error)throw error;
      return data;
    },
    async createSignedUrl(bucket,path,expiresIn){
      const api=fromBucket(bucket);
      const {data,error}=await api.createSignedUrl(path,expiresIn);
      if(error)throw error;
      if(!data?.signedUrl)throw new Error('signed url missing');
      return data.signedUrl;
    },
    isObjectExistsError(error){
      const status=Number(error?.statusCode||error?.status||0);
      const msg=String(error?.message||'').toLowerCase();
      return status===409||msg.includes('already exists')||msg.includes('duplicate');
    }
  };
}
