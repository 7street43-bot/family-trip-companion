import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTripMemoryGroups, buildTripMemoryModel, __test } from '../public/journal-trip-memory.mjs';

const entries=[{id:'e1',entry_date:'2026-05-01',trip_ref:'trip-1',title:'動物園',summary:'第一篇',tags:[]},{id:'e2',entry_date:'2026-05-01',trip_ref:'trip-1',title:'晚餐',summary:'第二篇',tags:[]},{id:'e3',entry_date:'2026-06-02',trip_ref:null,title:'海邊',summary:'第三篇',tags:[]}];

test('groups entries by trip_ref first and date as fallback',()=>{const groups=buildTripMemoryGroups(entries);assert.equal(groups.length,2);assert.equal(groups.find(x=>x.tripRef==='trip-1').entryCount,2);assert.equal(groups.find(x=>x.key==='date:2026-06-02').entryCount,1);});
