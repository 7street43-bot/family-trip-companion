import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFootprintPlaces, buildKnownLocationIndex, mergeFootprintResolution, __test } from '../public/journal-yearly-map.mjs';

const entries=[
  {id:'e1',entry_date:'2026-01-03',title:'南寮看海',summary:'',tags:['@place:南寮','親子']},
  {id:'e2',entry_date:'2026-02-01',title:'再去南寮',summary:'',tags:['@place: 南寮 ','@place:新竹動物園']},
  {id:'e3',entry_date:'2026-03-01',title:'已收起',summary:'',tags:['@place:六福村'],deleted_at:'2026-03-02'}
];

test('footprint groups repeated place tags and excludes archived entries',()=>{
  const rows=buildFootprintPlaces(entries);
  assert.equal(rows.length,2);
  assert.equal(rows[0].name,'南寮');
  assert.equal(rows[0].visits.length,2);
  assert.deepEqual(rows[0].visits.map(x=>x.entryId),['e1','e2']);
  assert.equal(rows[1].name,'新竹動物園');
});

test('known location index reuses entity and itinerary coordinates',()=>{
  const entities=[{id:'x',name:'南寮',latitude:24.85,longitude:120.92}];
  const itineraries=[{origin:{label:'家',latitude:24.81,longitude:121.0},stops:[{title:'六福村',latitude:24.82,longitude:121.18,placeId:'p6'}]}];
  const idx=buildKnownLocationIndex(entities,itineraries);
  assert.equal(idx.get('南寮').source,'entity');
  assert.equal(idx.get('六福村').placeId,'p6');
  assert.equal(idx.get('家').latitude,24.81);
});

test('resolution prefers known coordinates and then fresh cache',()=>{
  const places=buildFootprintPlaces(entries);
  const known=new Map([['南寮',{name:'南寮',latitude:24.85,longitude:120.92,source:'entity'}]]);
  const cache={['新竹動物園'.toLocaleLowerCase('zh-TW')]:{savedAt:Date.now(),location:{name:'新竹動物園',latitude:24.80,longitude:120.98,source:'cache'}}};
  const r=mergeFootprintResolution(places,known,cache);
  assert.equal(r.resolved.length,2);
  assert.equal(r.unresolved.length,0);
});

test('map runtime stays bounded and on-demand',()=>{
  assert.equal(__test.MAX_REMOTE_RESOLVE,12);
  assert.equal(__test.CACHE_TTL_MS,30*24*60*60*1000);
  assert.match(__test.LEAFLET_JS,/leaflet@1\.9\.4/);
  assert.equal(__test.OSM_TILE,'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
});
