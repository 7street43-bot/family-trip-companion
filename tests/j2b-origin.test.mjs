import assert from 'node:assert/strict';
import { createTrip, normalizeTripLocation, isV2Trip } from '../public/itinerary-v2-core.mjs';

const home = normalizeTripLocation({
  kind:'home',
  label:'家',
  placeId:'HOME_PLACE',
  address:'新竹市測試路 1 號',
  latitude:24.81,
  longitude:120.97,
  googleMapsUrl:'https://maps.google.com/?q=home',
  source:'google-places'
}, 'home');

assert.equal(home.kind, 'home');
assert.equal(home.label, '家');
assert.equal(home.placeId, 'HOME_PLACE');
assert.equal(home.latitude, 24.81);
assert.equal(home.longitude, 120.97);

const invalid = normalizeTripLocation({ label:'空資料' }, 'home');
assert.equal(invalid, null, 'location without address/placeId/coordinates must not be accepted');

globalThis.TwinTripDefaultOrigin = home;
const fresh = createTrip({ date:'2026-09-20', title:'新行程' });
assert.equal(isV2Trip(fresh), true);
assert.equal(fresh.modelVersion, 2, 'J2B must remain modelVersion 2 for J2A compatibility');
assert.deepEqual(fresh.origin, home, 'new trip should inherit default origin');
assert.deepEqual(fresh.destination, home, 'new trip should default destination to origin');
assert.equal(fresh.scheduleSchemaVersion, null, 'J2B-1 must not pretend Smart Schedule is active');

const legacyV2 = createTrip({
  id:'tripv2-existing-j2a',
  model:'itinerary-v2',
  modelVersion:2,
  title:'既有 J2A',
  date:'2026-09-21',
  departureTime:'09:00',
  stops:[]
});
assert.equal(legacyV2.origin, null, 'existing J2A trip without origin must not be silently rewritten');
assert.equal(legacyV2.destination, null, 'existing J2A trip without destination must not be silently rewritten');

const explicit = createTrip({
  id:'tripv2-explicit',
  title:'既有有起點行程',
  date:'2026-09-22',
  origin:home,
  destination:{...home,kind:'hotel',label:'飯店',placeId:'HOTEL_PLACE',address:'宜蘭縣測試路 2 號'}
});
assert.equal(explicit.origin.placeId, 'HOME_PLACE');
assert.equal(explicit.destination.placeId, 'HOTEL_PLACE');
assert.equal(explicit.destination.kind, 'hotel');

const edited = createTrip({ ...explicit, title:'改名', createdAt:explicit.createdAt });
assert.equal(edited.origin.placeId, 'HOME_PLACE', 'editing an existing trip must preserve origin');
assert.equal(edited.destination.placeId, 'HOTEL_PLACE', 'editing an existing trip must preserve destination');

console.log('J2B-1 ORIGIN MODEL COMPATIBILITY CONTRACT = PASS');
