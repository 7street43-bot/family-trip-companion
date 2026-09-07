import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCsv, todayLocal, entryLabel, queueRecord, encodePlaceTags, extractPlaces, visibleTags, periodBounds, searchEntriesLocal, groupHistory } from '../public/journal-ui.mjs';

test('splitCsv trims, deduplicates and accepts Chinese comma',()=>{
  assert.deepEqual(splitCsv('六福村, 第一次，六福村, 雙寶'),['六福村','第一次','雙寶']);
});

test('todayLocal formats local calendar date without UTC drift',()=>{
  const d=new Date(2026,8,7,23,59,0);
  assert.equal(todayLocal(d),'2026-09-07');
});

test('entryLabel prefers title then summary then fallback',()=>{
  assert.equal(entryLabel({title:' 六福村 ',summary:'內容'}),'六福村');
  assert.equal(entryLabel({summary:'今天第一次看到長頸鹿'}),'今天第一次看到長頸鹿');
  assert.equal(entryLabel({}),'未命名日誌');
});

test('queueRecord preserves mutation id and normalized write payload',()=>{
  const id='11111111-1111-4111-8111-111111111111';
  const q=queueRecord({entryDate:'2026-09-07',summary:'記一下',tags:['A'],participants:['B']},id,'2026-09-07T01:00:00.000Z');
  assert.equal(q.id,id);
  assert.equal(q.mutationId,id);
  assert.equal(q.input.entryDate,'2026-09-07');
  assert.equal(q.input.timezone,'Asia/Taipei');
  assert.deepEqual(q.input.tags,['A']);
});

test('place tags stay structured but hidden from normal tags',()=>{
  const tags=encodePlaceTags(['六福村','台中'],['第一次','動物']);
  assert.deepEqual(tags,['第一次','動物','@place:六福村','@place:台中']);
  assert.deepEqual(extractPlaces({tags}),['六福村','台中']);
  assert.deepEqual(visibleTags(tags),['第一次','動物']);
});

test('periodBounds resolves month/year ranges including January rollover',()=>{
  const sep=new Date(2026,8,7,12,0,0);
  assert.deepEqual(periodBounds('lastMonth',sep),{from:'2026-08-01',to:'2026-08-31',label:'上月'});
  assert.deepEqual(periodBounds('lastYear',sep),{from:'2025-01-01',to:'2025-12-31',label:'去年'});
  const jan=new Date(2027,0,4,12,0,0);
  assert.deepEqual(periodBounds('lastMonth',jan),{from:'2026-12-01',to:'2026-12-31',label:'上月'});
});

test('search finds title, content, place, tag, participant and date',()=>{
  const rows=[
    {id:'1',entry_date:'2026-09-07',title:'動物園',summary:'看到長頸鹿',tags:['@place:六福村','第一次'],participants:['曜澄']},
    {id:'2',entry_date:'2025-12-20',title:'台中散步',summary:'草悟道',tags:['城市'],participants:['曜濰']}
  ];
  assert.deepEqual(searchEntriesLocal(rows,'六福村').map(x=>x.id),['1']);
  assert.deepEqual(searchEntriesLocal(rows,'長頸鹿').map(x=>x.id),['1']);
  assert.deepEqual(searchEntriesLocal(rows,'第一次').map(x=>x.id),['1']);
  assert.deepEqual(searchEntriesLocal(rows,'曜濰').map(x=>x.id),['2']);
  assert.deepEqual(searchEntriesLocal(rows,'2025').map(x=>x.id),['2']);
});

test('history groups entries by year-month and summarizes places',()=>{
  const rows=[
    {id:'1',entry_date:'2026-09-07',tags:['@place:六福村']},
    {id:'2',entry_date:'2026-09-02',tags:['@place:南寮']},
    {id:'3',entry_date:'2026-08-18',tags:['@place:台中']}
  ];
  const groups=groupHistory(rows);
  assert.equal(groups.length,2);
  assert.equal(groups[0].key,'2026-09');
  assert.deepEqual(groups[0].places,['六福村','南寮']);
  assert.equal(groups[1].key,'2026-08');
});