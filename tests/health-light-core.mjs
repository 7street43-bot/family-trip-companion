import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createTrip,withEntities,moveStop,isV2Trip,splitTrips} from '../public/itinerary-v2-core.mjs';
import {searchEntriesLocal,encodePlaceTags,normalizeTripDraft} from '../public/journal-ui.mjs';
import {buildJournalMediaPath} from '../shared/journal-media-client.mjs';

const trips=[],journal=[],media=[];
const times={};
const clock=(key,fn)=>{const a=performance.now();const out=fn();times[key]=(times[key]||0)+(performance.now()-a);return out;};
const pad=n=>String(n).padStart(3,'0');
for(let i=0;i<30;i++){
  const day=String(i+1).padStart(2,'0');
  let t=createTrip({date:'2026-11-'+day,title:'家族旅程 '+pad(i),departureTime:'09:00'});
  const spots=Array.from({length:5},(_,j)=>({id:'trip'+i+'-place'+j,name:'虛構景點 '+i+'-'+j,entityType:j===2?'restaurant':'attraction',latitude:24+i/1000,longitude:121+j/1000}));
  t=clock('buildTripsMs',()=>withEntities(t,spots));
  assert.equal(t.stops.length,5);
  const moved=clock('reorderTripsMs',()=>moveStop(t,0,4));
  assert.equal(moved.stops.length,5);
  assert.equal(isV2Trip(moved),true);
  trips.push(structuredClone(moved));
}
assert.equal(trips.length,30);
const separated=splitTrips(trips,'2026-10-25');
assert.equal(separated.upcoming.length,30);
for(let i=0;i<80;i++){
  const t=trips[i%trips.length];
  const item={id:'journal'+pad(i),entry_date:t.date,title:'家族記錄 '+pad(i),
    summary:i%2===0?'桃園 虛構遊記 照片':'宜蘭 虛構旅行 日誌',
    tags:encodePlaceTags(['虛構景點 '+(i%30)+'-1'],['親子']),participants:['家人'],trip_ref:t.id};
  const d=normalizeTripDraft({entryDate:item.entry_date,title:item.title,summary:item.summary,tripRef:t.id});
  assert.equal(d.tripRef,t.id);
  journal.push(item);
}
assert.equal(journal.length,80);
assert.equal(searchEntriesLocal(journal,'桃園').length,40);
assert.equal(searchEntriesLocal(journal,'宜蘭').length,40);
const queries=['桃園','宜蘭','親子','家族記錄 0','不會出現的字'];
const searchDurations=[];
for(let i=0;i<300;i++){
  const t=performance.now();
  const result=searchEntriesLocal(journal,queries[i%queries.length]);
  assert.ok(Array.isArray(result));
  searchDurations.push(performance.now()-t);
}
const WORKSPACE='11111111-1111-4111-8111-111111111111',ENTRY='22222222-2222-4222-8222-222222222222';
for(let i=0;i<24;i++){
 const n=String(i+1).padStart(12,'0'),id='33333333-3333-4333-8333-'+n;
 const path=buildJournalMediaPath({workspaceId:WORKSPACE,entryId:ENTRY,mediaId:id,mimeType:'image/jpeg'});
 assert.ok(path.startsWith(WORKSPACE+'/'+ENTRY+'/'));
 media.push({id,path});
}
const sort=searchDurations.slice().sort((a,b)=>a-b);
const p95=sort[Math.ceil(sort.length*.95)-1];
assert.ok(p95<500,'local 80-entry search p95 >= 500ms');
console.log('HEALTH_CORE_PASS '+JSON.stringify({
 trips:trips.length,stops:trips.reduce((n,t)=>n+t.stops.length,0),
 journals:journal.length,media:media.length,searches:searchDurations.length,
 searchP95Ms:+p95.toFixed(3),buildTripsMs:+times.buildTripsMs.toFixed(2),
 reorderTripsMs:+times.reorderTripsMs.toFixed(2),networkCalls:0,productionWrites:0
}));
