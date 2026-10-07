import test from 'node:test';
import assert from 'node:assert/strict';
import { buildYearSummary, buildYearMarkdown, buildYearJson } from '../public/journal-yearly.mjs';

const rows=[
  {entry_date:'2026-01-03',title:'南寮',summary:'看海',tags:['@place:南寮','第一次'],participants:['曜澄','曜濰'],trip_ref:'t1',version:1},
  {entry_date:'2026-01-03',title:'晚餐',summary:'吃飯',tags:['@place:新竹','美食'],participants:['曜澄'],trip_ref:'t1',version:2},
  {entry_date:'2026-08-08',title:'六福村',summary:'看長頸鹿',tags:['@place:六福村','動物'],participants:['曜澄','曜濰'],trip_ref:'t2',version:1},
  {entry_date:'2025-12-31',title:'去年',summary:'不要算',tags:['@place:台中'],participants:['曜濰'],version:1},
  {entry_date:'2026-09-01',title:'收起',summary:'不要算',tags:['@place:台北'],participants:['曜濰'],deleted_at:'2026-09-02T00:00:00Z',version:2}
];

test('year summary counts outing days, places, active months and trip refs',()=>{
  const r=buildYearSummary(rows,2026);
  assert.equal(r.entryCount,3);
  assert.equal(r.outingDays,2);
  assert.equal(r.placeCount,3);
  assert.equal(r.activeMonths,2);
  assert.equal(r.tripRefCount,2);
  assert.equal(r.topPlaces[0].count,1);
  assert.deepEqual(r.entries.map(x=>x.date),['2026-01-03','2026-01-03','2026-08-08']);
});

test('year summary excludes archived and other years',()=>{
  const r=buildYearSummary(rows,2025);
  assert.equal(r.entryCount,1);
  assert.equal(r.topPlaces[0].name,'台中');
});

test('markdown export contains summary, places and journal text',()=>{
  const r=buildYearSummary(rows,2026);
  const md=buildYearMarkdown(r,'2026-10-07T00:00:00.000Z');
  assert.match(md,/2026 年度旅遊回顧/);
  assert.match(md,/出遊紀錄日：2 天/);
  assert.match(md,/六福村/);
  assert.match(md,/看長頸鹿/);
});

test('json export is structured and round-trippable',()=>{
  const r=buildYearSummary(rows,2026);
  const parsed=JSON.parse(buildYearJson(r,'2026-10-07T00:00:00.000Z'));
  assert.equal(parsed.exportType,'family-trip-journal-yearly-recap');
  assert.equal(parsed.report.year,2026);
  assert.equal(parsed.report.entryCount,3);
});
