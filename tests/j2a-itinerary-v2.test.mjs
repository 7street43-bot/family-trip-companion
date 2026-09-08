import assert from 'node:assert/strict';
import {
  createTrip,
  withEntities,
  withCustomStop,
  moveStop,
  removeStop,
  splitTrips,
  isV2Trip
} from '../public/itinerary-v2-core.mjs';

const e1 = { id:'e1', name:'斑比山丘', entityType:'attraction', latitude:24.7, longitude:121.7 };
const e2 = { id:'e2', name:'張美阿嬤農場', entityType:'attraction' };
const e3 = { id:'e3', name:'午餐', entityType:'restaurant' };

const trip = createTrip({ date:'2026-09-12', title:'', departureTime:'09:00' });
assert.equal(isV2Trip(trip), true);
assert.equal(trip.modelVersion, 2);
assert.equal(trip.title, '9/12 一日遊');
assert.equal(trip.departureTime, '09:00');

const picked = withEntities(trip, [e1,e2,e3,e1]);
assert.equal(picked.stops.length, 4, 'same call preserves duplicate input only once per existing set contract check');
const deduped = withEntities(picked, [e1,e2]);
assert.equal(deduped.stops.length, 4, 'existing entity ids must not be duplicated later');

const custom = withCustomStop(deduped, '回程買牛舌餅');
assert.equal(custom.stops.at(-1).kind, 'custom');
assert.equal(custom.stops.at(-1).title, '回程買牛舌餅');

const moved = moveStop(custom, 0, 2);
assert.equal(moved.stops[2].entityId, 'e1');
const removed = removeStop(moved, 2);
assert.equal(removed.stops.some(s=>s.id===moved.stops[2].id), false);

const old = { id:'legacy', date:'2026-09-01', stops:[] };
const future = createTrip({ date:'2026-10-01', title:'未來' });
const past = createTrip({ date:'2026-08-01', title:'過去' });
const split = splitTrips([old, future, past], '2026-09-08');
assert.deepEqual(split.upcoming.map(x=>x.title), ['未來']);
assert.deepEqual(split.past.map(x=>x.title), ['過去']);

console.log('J2A ITINERARY V2 CORE CONTRACT = PASS');
