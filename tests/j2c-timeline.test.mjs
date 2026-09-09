import assert from 'node:assert/strict';
import {
  SCHEDULE_SCHEMA_VERSION,
  parseClockMinutes,
  normalizeDurationMinutes,
  routeLegMinutes,
  buildRoadTimeline
} from '../public/itinerary-timeline-core.mjs';

assert.equal(SCHEDULE_SCHEMA_VERSION, 1);
assert.equal(parseClockMinutes('09:00'), 540);
assert.equal(parseClockMinutes('23:59'), 1439);
assert.equal(parseClockMinutes('24:00'), null);
assert.equal(normalizeDurationMinutes('', 90), 90);
assert.equal(normalizeDurationMinutes(75, 90), 75);
assert.equal(routeLegMinutes({ durationSeconds: 61 }), 2, 'road minutes round up to avoid early ETA');

const route = {
  legs: [
    { durationSeconds: 600 },
    { durationSeconds: 900 },
    { durationSeconds: 600 },
    { durationSeconds: 600 }
  ]
};
const timeline = buildRoadTimeline({
  departureTime: '09:00',
  stopKeys: ['a', 'b', 'c'],
  durationsMinutes: [90, 90, 90],
  route
});
assert.equal(timeline.error, undefined);
assert.equal(timeline.stops[0].arrivalLabel, '09:10');
assert.equal(timeline.stops[0].departureLabel, '10:40');
assert.equal(timeline.stops[1].arrivalLabel, '10:55');
assert.equal(timeline.stops[2].departureLabel, '14:05');
assert.equal(timeline.returnLabel, '14:15');
assert.equal(timeline.roadMinutes, 45);
assert.equal(timeline.dwellMinutes, 270);
assert.equal(timeline.totalMinutes, 315);

const rollover = buildRoadTimeline({
  departureTime: '23:30',
  stopKeys: ['late'],
  durationsMinutes: [60],
  route: { legs: [{ durationSeconds: 1200 }, { durationSeconds: 600 }] }
});
assert.equal(rollover.stops[0].arrivalLabel, '23:50');
assert.equal(rollover.stops[0].departureLabel, '隔日 00:50');
assert.equal(rollover.returnLabel, '隔日 01:00');

assert.equal(buildRoadTimeline({ departureTime:'09:00', stopKeys:['a'], route:{ legs:[] } }).error, 'route_legs_mismatch');
assert.equal(buildRoadTimeline({ departureTime:'bad', stopKeys:['a'], route:{ legs:[{},{}] } }).error, 'invalid_departure_time');

console.log('J2C-1 ROAD TIMELINE CORE CONTRACT = PASS');
