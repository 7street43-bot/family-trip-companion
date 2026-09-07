import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleMedia, pendingMediaCount, validatePhotoFile, safeTakenAt } from '../public/journal-media-ui.mjs';

test('visibleMedia hides pending and archived by default, sorted by sort order',()=>{
  const rows=[
    {id:'b',upload_state:'ready',deleted_at:null,sort_order:200,created_at:'2026-01-02'},
    {id:'a',upload_state:'ready',deleted_at:null,sort_order:100,created_at:'2026-01-01'},
    {id:'p',upload_state:'pending',deleted_at:null,sort_order:1},
    {id:'h',upload_state:'ready',deleted_at:'2026-01-03T00:00:00Z',sort_order:50}
  ];
  assert.deepEqual(visibleMedia(rows,false).map(x=>x.id),['a','b']);
  assert.deepEqual(visibleMedia(rows,true).map(x=>x.id),['h','a','b']);
});

test('pendingMediaCount counts only live pending reservations',()=>{
  assert.equal(pendingMediaCount([
    {upload_state:'pending',deleted_at:null},
    {upload_state:'pending',deleted_at:'2026-01-01'},
    {upload_state:'ready',deleted_at:null}
  ]),1);
});

test('validatePhotoFile enforces supported image MIME and 25MB cap',()=>{
  assert.equal(validatePhotoFile({type:'image/jpeg',size:1024}).ok,true);
  assert.equal(validatePhotoFile({type:'image/heic',size:25*1024*1024}).ok,true);
  assert.equal(validatePhotoFile({type:'image/gif',size:1024}).ok,false);
  assert.equal(validatePhotoFile({type:'image/jpeg',size:25*1024*1024+1}).ok,false);
  assert.equal(validatePhotoFile({type:'image/png',size:0}).ok,false);
});

test('safeTakenAt uses plausible file lastModified and ignores invalid dates',()=>{
  const ts=Date.UTC(2026,8,7,12,34,56);
  assert.equal(safeTakenAt({lastModified:ts}),new Date(ts).toISOString());
  assert.equal(safeTakenAt({lastModified:0}),null);
  assert.equal(safeTakenAt({lastModified:Date.UTC(1999,0,1)}),null);
});
