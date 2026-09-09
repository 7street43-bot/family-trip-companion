import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../netlify/functions/itinerary-route-matrix.mjs';

const {
  normalizeNode,
  toWaypoint,
  sameLocation,
  parseDuration,
  matrixFromElements,
  routeTotals,
  nearestNeighbor,
  twoOpt,
  buildRequestNodes
} = __test;

test('waypoint prefers placeId, then coordinates, then address', () => {
  assert.deepEqual(toWaypoint({ placeId: 'abc', latitude: 1, longitude: 2, address: 'x' }), { placeId: 'abc' });
  assert.deepEqual(toWaypoint({ latitude: 24.8, longitude: 121.0, address: 'x' }), {
    location: { latLng: { latitude: 24.8, longitude: 121.0 } }
  });
  assert.deepEqual(toWaypoint({ address: '新竹市' }), { address: '新竹市' });
});

test('null coordinates are not coerced to zero', () => {
  const node = normalizeNode({ key: 'x', title: 'X', latitude: null, longitude: null, address: '新竹市' });
  assert.equal(node.latitude, null);
  assert.equal(node.longitude, null);
  assert.deepEqual(toWaypoint(node), { address: '新竹市' });
});

test('sameLocation handles placeId, coordinates, and address', () => {
  assert.equal(sameLocation({ placeId: 'p1' }, { placeId: 'p1' }), true);
  assert.equal(sameLocation({ latitude: 24, longitude: 121 }, { latitude: 24, longitude: 121 }), true);
  assert.equal(sameLocation({ address: 'A' }, { address: 'A' }), true);
  assert.equal(sameLocation({ address: 'A' }, { address: 'B' }), false);
});

test('duration parser and route matrix retain valid directed edges', () => {
  assert.equal(parseDuration('90s'), 90);
  assert.equal(parseDuration('3.5s'), 3.5);
  assert.equal(Number.isNaN(parseDuration('x')), true);

  const elements = [
    { originIndex: 0, destinationIndex: 1, status: {}, condition: 'ROUTE_EXISTS', distanceMeters: 1000, duration: '100s' },
    { originIndex: 1, destinationIndex: 0, status: {}, condition: 'ROUTE_EXISTS', distanceMeters: 1200, duration: '120s' }
  ];
  const matrix = matrixFromElements(elements, 2);
  assert.equal(matrix[0][1].durationSeconds, 100);
  assert.equal(matrix[1][0].distanceMeters, 1200);
  assert.equal(matrix[0][0].durationSeconds, 0);
});

test('nearest-neighbor plus 2-opt can improve a round trip while preserving fixed home', () => {
  const size = 4;
  const matrix = Array.from({ length: size }, () => Array(size).fill(null));
  for (let i = 0; i < size; i += 1) matrix[i][i] = { durationSeconds: 0, distanceMeters: 0 };
  const set = (a, b, seconds) => { matrix[a][b] = { durationSeconds: seconds, distanceMeters: seconds * 10 }; };

  // Home 0, stops 1/2/3. Original 0-1-2-3-0 is intentionally poor.
  set(0,1,10); set(1,2,80); set(2,3,10); set(3,0,10);
  set(0,2,20); set(2,1,10); set(1,3,10);
  set(0,3,40); set(3,1,10); set(1,0,10); set(2,0,20);
  set(3,2,10); set(2,0,20); set(1,0,10);
  set(2,3,10); set(3,0,10);
  // Fill remaining directed edges with a usable high cost.
  for (let a=0;a<size;a+=1) for (let b=0;b<size;b+=1) if(!matrix[a][b]) set(a,b,90);

  const current = routeTotals([0,1,2,3,0], matrix);
  const greedy = nearestNeighbor(0, [1,2,3], 0, matrix);
  const optimized = twoOpt(greedy, matrix);
  assert.ok(current);
  assert.ok(greedy);
  assert.ok(optimized);
  assert.equal(optimized.route[0], 0);
  assert.equal(optimized.route.at(-1), 0);
  assert.deepEqual(new Set(optimized.route.slice(1,-1)), new Set([1,2,3]));
  assert.ok(optimized.totalDurationSeconds < current.totalDurationSeconds);
});

test('request builder preserves stop keys and avoids duplicate home destination', () => {
  const built = buildRequestNodes({
    origin: { placeId: 'home', label: '家' },
    destination: { placeId: 'home', label: '家' },
    stops: [
      { key: 'a', placeId: 'a', title: 'A' },
      { key: 'b', latitude: 24.8, longitude: 121.0, title: 'B' }
    ]
  });
  assert.equal(built.error, undefined);
  assert.equal(built.nodes.length, 3);
  assert.equal(built.endIndex, 0);
  assert.deepEqual(built.stops.map(s => s.key), ['a','b']);
});

test('request builder fails closed on duplicate keys and excessive stops', () => {
  assert.equal(buildRequestNodes({
    origin: { address: 'A' },
    stops: [{ key: 'x', address: 'B' }, { key: 'x', address: 'C' }]
  }).error, 'duplicate_stop_key');

  assert.equal(buildRequestNodes({
    origin: { address: 'A' },
    stops: Array.from({length:13}, (_,i) => ({ key:`s${i}`, address:`B${i}` }))
  }).error, 'too_many_stops');
});