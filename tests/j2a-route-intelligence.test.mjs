import assert from 'node:assert/strict';
import {
  routePointFromStop,
  routePointFromOrigin,
  buildRouteLocations,
  optimizeRoute,
  applyOptimizedRoute,
  formatRouteDuration,
  formatRouteDistance,
  MAX_ROUTE_STOPS
} from '../public/itinerary-route-core.mjs';
import { __test as provider } from '../netlify/functions/itinerary-route-matrix.mjs';

const placeStop = { candidateKey:'place:a', placeId:'ChIJA', title:'A' };
const coordStop = { candidateKey:'place:b', latitude:24.7, longitude:121.7, title:'B' };
const addressStop = { candidateKey:'place:c', address:'宜蘭縣冬山鄉大進七路128號', title:'C' };
const vagueStop = { candidateKey:'entity:vague', address:'宜蘭縣冬山鄉', title:'Vague' };

assert.equal(routePointFromStop(placeStop).placeId, 'ChIJA');
assert.equal(routePointFromStop(coordStop).latitude, 24.7);
assert.equal(routePointFromStop(addressStop).address.includes('128號'), true);
assert.equal(routePointFromStop(vagueStop), null, 'county/district only must not be treated as a precise route locator');
assert.equal(routePointFromOrigin({ address:'新竹市東區光復路二段1號' }).key, 'origin:home');

const built = buildRouteLocations([placeStop, coordStop, addressStop], { address:'新竹市東區光復路二段1號' });
assert.equal(built.ok, true);
assert.equal(built.locations.length, 4);
assert.equal(buildRouteLocations([placeStop, vagueStop]).reason, 'unroutable_stops');
assert.equal(buildRouteLocations(Array.from({ length:MAX_ROUTE_STOPS + 1 }, (_, i) => ({ candidateKey:`place:${i}`, placeId:`p${i}`, title:String(i) }))).reason, 'too_many_stops');

const locations = provider.normalizeLocations([
  { key:'origin:home', address:'新竹市東區光復路二段1號' },
  { key:'place:a', placeId:'ChIJA', latitude:0, longitude:0 },
  { key:'place:b', latitude:24.7, longitude:121.7 }
]);
const request = provider.buildRoutesRequest(locations);
assert.equal(request.routingPreference, 'TRAFFIC_UNAWARE');
assert.deepEqual(request.origins[1].waypoint, { placeId:'ChIJA' }, 'placeId must win over coordinate fallback');
assert.equal(request.origins[2].waypoint.location.latLng.latitude, 24.7);
assert.throws(() => provider.normalizeLocations([{ key:'a', address:'A' }, { key:'a', address:'B' }]), /location_key_duplicate/);

const parsedArray = provider.parseMatrixPayload('[{"originIndex":0,"destinationIndex":1,"condition":"ROUTE_EXISTS","duration":"10s","distanceMeters":1000}]');
assert.equal(parsedArray.length, 1);
const parsedLines = provider.parseMatrixPayload('{"originIndex":0}\n{"originIndex":1}');
assert.equal(parsedLines.length, 2, 'provider must tolerate streamed/newline JSON representation');
assert.equal(provider.parseDuration('90.5s'), 90.5);

function e(fromKey, toKey, durationSeconds, distanceMeters = durationSeconds * 100) {
  return { fromKey, toKey, durationSeconds, distanceMeters, condition:'ROUTE_EXISTS', statusCode:0 };
}
const matrix = [
  e('origin:home','place:a',10), e('origin:home','place:b',50), e('origin:home','place:c',60),
  e('place:a','place:b',10), e('place:a','place:c',40), e('place:a','origin:home',50),
  e('place:b','place:a',10), e('place:b','place:c',10), e('place:b','origin:home',40),
  e('place:c','place:a',40), e('place:c','place:b',10), e('place:c','origin:home',10)
];
const points = [placeStop, coordStop, addressStop].map(routePointFromStop);
const roundTrip = optimizeRoute(points, matrix, { originPoint:routePointFromOrigin({ address:'新竹市東區光復路二段1號' }), roundTrip:true });
assert.equal(roundTrip.ok, true);
assert.deepEqual(roundTrip.orderKeys, ['place:a','place:b','place:c']);
assert.equal(roundTrip.totalDurationSeconds, 40);
assert.equal(roundTrip.legs.length, 4);

const openPath = optimizeRoute(points, matrix);
assert.equal(openPath.ok, true);
assert.equal(openPath.totalDurationSeconds, 20);
assert.ok([
  'place:a|place:b|place:c',
  'place:c|place:b|place:a'
].includes(openPath.orderKeys.join('|')));

const incomplete = optimizeRoute(points, [e('place:a','place:b',10)]);
assert.equal(incomplete.ok, false);
assert.equal(incomplete.reason, 'route_incomplete');

const trip = { id:'t1', stops:[
  { candidateKey:'place:c', title:'C' },
  { candidateKey:'place:a', title:'A' },
  { candidateKey:'place:b', title:'B' }
] };
const applied = applyOptimizedRoute(trip, roundTrip);
assert.deepEqual(applied.stops.map(x => x.title), ['A','B','C']);
assert.equal(applied.routePlan.totalDurationSeconds, 40);
assert.equal(formatRouteDuration(3660), '1 小時 1 分');
assert.equal(formatRouteDistance(12500), '13 km');

console.log('J2A-2A ROUTE MATRIX + EXACT OPTIMIZER CONTRACT = PASS');
