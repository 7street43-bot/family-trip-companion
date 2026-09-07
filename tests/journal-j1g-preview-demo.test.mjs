import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPreviewFiles, previewSafetyCopy, __test } from '../public/journal-media-preview-demo.mjs';

test('fixed Preview host is exact and production host is rejected',()=>{
  assert.equal(__test.isFixedPreview({location:{hostname:__test.PREVIEW_HOST}}),true);
  assert.equal(__test.isFixedPreview({location:{hostname:'comfy-heliotrope-475c71.netlify.app'}}),false);
  assert.equal(__test.isFixedPreview({location:{hostname:`evil-${__test.PREVIEW_HOST}`}}),false);
});

test('preview file classifier enforces MIME, 25MB and 20-file cap',()=>{
  const ok={name:'a.heic',type:'image/heic',size:1024};
  assert.equal(classifyPreviewFiles([ok])[0].ok,true);
  assert.equal(classifyPreviewFiles([{name:'bad.gif',type:'image/gif',size:1024}])[0].ok,false);
  assert.equal(classifyPreviewFiles([{name:'big.jpg',type:'image/jpeg',size:__test.MAX_BYTES+1}])[0].ok,false);
  assert.equal(classifyPreviewFiles(Array.from({length:25},(_,i)=>({name:`${i}.jpg`,type:'image/jpeg',size:1024}))).length,__test.MAX_FILES);
});

test('preview safety copy explicitly forbids cloud persistence',()=>{
  const text=previewSafetyCopy();
  assert.match(text,/不上傳/);
  assert.match(text,/不建立日誌/);
  assert.match(text,/重整即清除/);
});
