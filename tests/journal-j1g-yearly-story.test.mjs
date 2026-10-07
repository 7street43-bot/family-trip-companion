import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStoryMoments, __test } from '../public/journal-yearly-story.mjs';

const entries=[
  {id:'e1',entry_date:'2026-01-03',title:'南寮',summary:'看海',tags:['@place:南寮']},
  {id:'e2',entry_date:'2026-01-20',title:'動物園',summary:'看猴子',tags:['@place:新竹動物園']},
  {id:'e3',entry_date:'2026-03-08',title:'六福村',summary:'看長頸鹿',tags:['@place:六福村']},
  {id:'e4',entry_date:'2026-03-18',title:'公園',summary:'玩溜滑梯',tags:['@place:公園']},
  {id:'e5',entry_date:'2026-08-01',title:'海邊',summary:'踩沙',tags:[]}
];
const media=[
  {id:'m2',entry_id:'e1',storage_path:'late.jpg',upload_state:'ready',deleted_at:null,sort_order:20,caption:'第二張'},
  {id:'m1',entry_id:'e1',storage_path:'first.jpg',upload_state:'ready',deleted_at:null,sort_order:10,caption:'第一張'},
  {id:'m3',entry_id:'e3',storage_path:'giraffe.jpg',upload_state:'ready',deleted_at:null,sort_order:5,caption:'長頸鹿'},
  {id:'m4',entry_id:'e4',storage_path:'hidden.jpg',upload_state:'ready',deleted_at:'2026-03-19',sort_order:1}
];

test('story selection balances months before taking a second moment from a month',()=>{
  const rows=buildStoryMoments(entries,media,3);
  assert.deepEqual(rows.map(x=>x.entryId),['e1','e3','e5']);
  assert.deepEqual(rows.map(x=>x.month),['2026-01','2026-03','2026-08']);
});

test('story uses the first live photo by sort order and preserves text-only memories',()=>{
  const rows=buildStoryMoments(entries,media,5);
  const jan=rows.find(x=>x.entryId==='e1');
  const park=rows.find(x=>x.entryId==='e4');
  assert.equal(jan.storagePath,'first.jpg');
  assert.equal(jan.caption,'第一張');
  assert.equal(park.storagePath,'');
  assert.equal(park.title,'公園');
});

test('story caps the number of selected moments and keeps chronological order',()=>{
  const many=Array.from({length:30},(_,i)=>({
    id:`id-${i}`,
    entry_date:`2026-${String((i%12)+1).padStart(2,'0')}-${String((i%27)+1).padStart(2,'0')}`,
    title:`T${i}`,
    summary:''
  }));
  const rows=buildStoryMoments(many,[],99);
  assert.equal(rows.length,20);
  const dates=rows.map(x=>x.date);
  assert.deepEqual(dates,[...dates].sort());
});

test('story runtime is bounded and progressive',()=>{
  assert.equal(__test.MAX_STORY_MOMENTS,20);
  assert.equal(__test.SIGN_WINDOW,3);
  assert.equal(__test.AUTO_MS,5000);
});
