import test from 'node:test';
import assert from 'node:assert/strict';
import { buildYearAlbum, albumStats, __test } from '../public/journal-yearly-photos.mjs';

const entries=[
  {id:'e1',entry_date:'2026-01-03',title:'南寮'},
  {id:'e2',entry_date:'2026-08-08',title:'六福村'}
];
const media=[
  {id:'m2',entry_id:'e2',storage_path:'b.jpg',upload_state:'ready',deleted_at:null,taken_at:'2026-08-08T12:00:00Z',sort_order:20,caption:'長頸鹿'},
  {id:'m1',entry_id:'e1',storage_path:'a.jpg',upload_state:'ready',deleted_at:null,taken_at:null,created_at:'2026-01-03T10:00:00Z',sort_order:10,caption:''},
  {id:'m3',entry_id:'e1',storage_path:'c.jpg',upload_state:'pending',deleted_at:null,sort_order:30},
  {id:'m4',entry_id:'e1',storage_path:'d.jpg',upload_state:'ready',deleted_at:'2026-01-04',sort_order:40}
];

test('year album keeps only ready live media and maps entry context',()=>{
  const rows=buildYearAlbum(media,entries);
  assert.deepEqual(rows.map(x=>x.id),['m1','m2']);
  assert.equal(rows[0].entryTitle,'南寮');
  assert.equal(rows[0].date,'2026-01-03');
  assert.equal(rows[1].caption,'長頸鹿');
});

test('album stats count photos, source entries and months',()=>{
  const r=albumStats(buildYearAlbum(media,entries));
  assert.deepEqual(r,{photos:2,months:2,entries:2});
});

test('photo recap uses bounded progressive pages',()=>{
  assert.equal(__test.PAGE_SIZE,12);
  assert.equal(__test.MAX_YEAR_MEDIA,240);
});
