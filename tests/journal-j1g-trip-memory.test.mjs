import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTripMemoryGroups, buildTripMemoryModel, __test } from '../public/journal-trip-memory.mjs';

const entries=[{id:'e1',entry_date:'2026-05-01',trip_ref:'trip-1',title:'動物園',summary:'第一篇',tags:[]},{id:'e2',entry_date:'2026-05-01',trip_ref:'trip-1',title:'晚餐',summary:'第二篇',tags:[]},{id:'e3',entry_date:'2026-06-02',trip_ref:null,title:'海邊',summary:'第三篇',tags:[]}];

test('groups entries by trip_ref first and date as fallback',()=>{const groups=buildTripMemoryGroups(entries);assert.equal(groups.length,2);assert.equal(groups.find(x=>x.tripRef==='trip-1').entryCount,2);assert.equal(groups.find(x=>x.key==='date:2026-06-02').entryCount,1);});

test('memory model reuses saved itinerary route and schedule',()=>{const trip={id:'trip-1',date:'2026-05-01',title:'親子一日遊',origin:{label:'家',address:'新竹'},destination:{label:'家'},stops:[{title:'動物園',address:'新竹市',plannedTime:'10:00',plannedDurationMinutes:120},{title:'餐廳',address:'竹北',plannedTime:'13:00',plannedDurationMinutes:60}],routePlan:{actual:{totalDurationSeconds:3600,totalDistanceMeters:42000,legs:[{durationSeconds:600,distanceMeters:5000},{durationSeconds:1200,distanceMeters:17000},{durationSeconds:1800,distanceMeters:20000}]}},schedulePlan:{totalMinutes:300,returnTime:'15:00'}};const media=[{id:'m1',entry_id:'e1',storage_path:'a.jpg',upload_state:'ready',deleted_at:null,sort_order:1},{id:'m2',entry_id:'e1',storage_path:'b.jpg',upload_state:'pending',deleted_at:null,sort_order:2}];const model=buildTripMemoryModel({trip,entries:entries.slice(0,2),media});assert.equal(model.tripId,'trip-1');assert.equal(model.title,'親子一日遊');assert.equal(model.stops.length,2);assert.equal(model.roadMinutes,60);assert.equal(model.roadDistanceMeters,42000);assert.equal(model.totalMinutes,300);assert.equal(model.returnTime,'15:00');assert.equal(model.journals.length,2);assert.equal(model.photos.length,1);});

test('trip memory photo loading stays bounded and progressive',()=>{assert.equal(__test.PHOTO_PAGE_SIZE,8);assert.equal(__test.MAX_TRIP_MEDIA,120);});
