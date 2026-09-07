import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJournalMediaPath, createJournalMediaClient, JournalMediaError } from '../shared/journal-media-client.mjs';
import { createSupabaseJournalMediaTransport } from '../shared/journal-media-supabase-transport.mjs';

const W='11111111-1111-4111-8111-111111111111';
const E='22222222-2222-4222-8222-222222222222';
const M='33333333-3333-4333-8333-333333333333';
const R='44444444-4444-4444-8444-444444444444';
const F='55555555-5555-4555-8555-555555555555';

function fakeTransport(){
  const calls=[];
  return {
    calls,
    async rpc(name,args){calls.push(['rpc',name,args]);return {status:'applied',targetType:'media',targetId:args.p_media_id,version:args.p_action==='reserve'?1:2,operation:args.p_action==='reserve'?'register':'update'};},
    async upload(bucket,path,file,opts){calls.push(['upload',bucket,path,file,opts]);return {path};},
    async createSignedUrl(bucket,path,expires){calls.push(['signed',bucket,path,expires]);return `signed:${path}`;},
    isObjectExistsError(err){return err?.statusCode===409;}
  };
}

test('storage path is identity-locked and MIME-derived',()=>{
  assert.equal(buildJournalMediaPath({workspaceId:W,entryId:E,mediaId:M,mimeType:'image/jpeg'}),`${W}/${E}/${M}/${M}.jpg`);
  assert.equal(buildJournalMediaPath({workspaceId:W,entryId:E,mediaId:M,mimeType:'image/heic'}),`${W}/${E}/${M}/${M}.heic`);
  assert.throws(()=>buildJournalMediaPath({workspaceId:W,entryId:E,mediaId:M,mimeType:'image/gif'}),JournalMediaError);
  assert.throws(()=>buildJournalMediaPath({workspaceId:'../x',entryId:E,mediaId:M,mimeType:'image/jpeg'}),JournalMediaError);
});

test('reserve maps only to journal_media_mutate with fixed source',async()=>{
  const t=fakeTransport(),c=createJournalMediaClient({source:'mobile',transport:t});
  const r=await c.reserve({workspaceId:W,entryId:E,mediaId:M,mimeType:'image/jpeg',caption:'雙寶',mutationId:R});
  assert.equal(r.storagePath,`${W}/${E}/${M}/${M}.jpg`);
  const call=t.calls[0];
  assert.equal(call[1],'journal_media_mutate');
  assert.equal(call[2].p_action,'reserve');
  assert.equal(call[2].p_source,'mobile');
  assert.equal(call[2].p_expected_version,0);
  assert.equal(call[2].p_payload.storage_path,r.storagePath);
});

test('uploadPhoto is reserve -> exact private upload -> finalize',async()=>{
  const t=fakeTransport(),c=createJournalMediaClient({source:'desktop',transport:t});
  const file={type:'image/webp',size:1234};
  const out=await c.uploadPhoto({workspaceId:W,entryId:E,file,mediaId:M,reserveMutationId:R,finalizeMutationId:F});
  assert.equal(out.result.status,'applied');
  assert.deepEqual(t.calls.map(x=>x[0]),['rpc','upload','rpc']);
  assert.equal(t.calls[1][1],'journal-media');
  assert.equal(t.calls[1][2],`${W}/${E}/${M}/${M}.webp`);
  assert.equal(t.calls[1][4].upsert,false);
  assert.equal(t.calls[2][2].p_action,'finalize');
  assert.equal(t.calls[2][2].p_expected_version,1);
});

test('retry tolerates storage object already existing and finalizes idempotently',async()=>{
  const t=fakeTransport();
  t.upload=async()=>{const e=new Error('already exists');e.statusCode=409;throw e;};
  const c=createJournalMediaClient({source:'mobile',transport:t});
  const out=await c.uploadPhoto({workspaceId:W,entryId:E,file:{type:'image/jpeg',size:10},mediaId:M,reserveMutationId:R,finalizeMutationId:F});
  assert.equal(out.result.status,'applied');
});

test('unsafe files/patches fail before I/O',async()=>{
  const t=fakeTransport(),c=createJournalMediaClient({source:'mobile',transport:t});
  await assert.rejects(()=>c.uploadPhoto({workspaceId:W,entryId:E,file:{type:'image/gif',size:10},mediaId:M,reserveMutationId:R,finalizeMutationId:F}),/unsupported image type/);
  await assert.rejects(()=>c.uploadPhoto({workspaceId:W,entryId:E,file:{type:'image/jpeg',size:26214401},mediaId:M,reserveMutationId:R,finalizeMutationId:F}),/25 MB/);
  await assert.rejects(()=>c.update({workspaceId:W,entryId:E,mediaId:M,expectedVersion:2,patch:{storagePath:'evil'},mutationId:R}),/unsupported media patch field/);
  assert.equal(t.calls.length,0);
});

test('signed URLs are private bucket only and expiry is bounded',async()=>{
  const t=fakeTransport(),c=createJournalMediaClient({source:'gpt',transport:t});
  const path=buildJournalMediaPath({workspaceId:W,entryId:E,mediaId:M,mimeType:'image/png'});
  assert.equal(await c.signedUrl({storagePath:path,expiresIn:99999}),`signed:${path}`);
  assert.equal(t.calls[0][1],'journal-media');
  assert.equal(t.calls[0][3],3600);
});

test('Supabase transport blocks arbitrary RPCs/buckets and never exposes remove/update',async()=>{
  const bucketApi={upload:async()=>({data:{},error:null}),createSignedUrl:async()=>({data:{signedUrl:'x'},error:null})};
  const supabase={rpc:async()=>({data:{status:'applied'},error:null}),storage:{from:()=>bucketApi}};
  const t=createSupabaseJournalMediaTransport(supabase);
  await assert.rejects(()=>t.rpc('evil_rpc',{}),/rpc not allowed/);
  await assert.rejects(()=>t.upload('public','x',{},{}),/bucket not allowed/);
  assert.equal(typeof t.remove,'undefined');
  assert.equal(typeof t.update,'undefined');
});

test('15k generated paths remain unique across media ids',()=>{
  const seen=new Set();
  for(let i=0;i<15000;i++){
    const hex=i.toString(16).padStart(12,'0');
    const id=`aaaaaaaa-aaaa-4aaa-8aaa-${hex}`;
    seen.add(buildJournalMediaPath({workspaceId:W,entryId:E,mediaId:id,mimeType:'image/jpeg'}));
  }
  assert.equal(seen.size,15000);
});
