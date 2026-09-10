export const SCHEDULE_SCHEMA_VERSION = 1;
export const DEFAULT_STOP_DURATION_MINUTES = 90;

export function parseClockMinutes(value = '') {
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

export function normalizeDurationMinutes(value, fallback = DEFAULT_STOP_DURATION_MINUTES) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1440, Math.round(n)));
}

export function routeLegMinutes(leg = {}) {
  const seconds = Number(leg.durationSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.ceil(seconds / 60);
}

export function clockParts(totalMinutes) {
  const total = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const dayOffset = Math.floor(total / 1440);
  const withinDay = total % 1440;
  const hour = Math.floor(withinDay / 60);
  const minute = withinDay % 60;
  const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return {
    totalMinutes: total,
    dayOffset,
    clock,
    label: dayOffset ? `${dayOffset === 1 ? '隔日' : `第 ${dayOffset + 1} 天`} ${clock}` : clock
  };
}

export function formatMinutes(value) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours && minutes) return `${hours} 小時 ${minutes} 分`;
  if (hours) return `${hours} 小時`;
  return `${minutes} 分`;
}

export function buildRoadTimeline({
  departureTime = '09:00',
  stopKeys = [],
  durationsMinutes = [],
  route = null
} = {}) {
  const start = parseClockMinutes(departureTime);
  if (start === null) return { error: 'invalid_departure_time' };
  if (!Array.isArray(stopKeys) || !stopKeys.length) return { error: 'stops_required' };
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  if (legs.length !== stopKeys.length + 1) return { error: 'route_legs_mismatch' };

  const travelMinutes = legs.map(routeLegMinutes);
  if (travelMinutes.some(value => value === null)) return { error: 'invalid_route_leg' };

  const dwell = stopKeys.map((_, index) => normalizeDurationMinutes(durationsMinutes[index]));
  const stops = [];
  let cursor = start;

  for (let index = 0; index < stopKeys.length; index += 1) {
    cursor += travelMinutes[index];
    const arrival = clockParts(cursor);
    const durationMinutes = dwell[index];
    cursor += durationMinutes;
    const departure = clockParts(cursor);
    stops.push({
      key: String(stopKeys[index]),
      travelMinutes: travelMinutes[index],
      durationMinutes,
      arrivalMinutes: arrival.totalMinutes,
      arrivalClock: arrival.clock,
      arrivalDayOffset: arrival.dayOffset,
      arrivalLabel: arrival.label,
      departureMinutes: departure.totalMinutes,
      departureClock: departure.clock,
      departureDayOffset: departure.dayOffset,
      departureLabel: departure.label
    });
  }

  const returnTravelMinutes = travelMinutes.at(-1);
  cursor += returnTravelMinutes;
  const returnAt = clockParts(cursor);
  const roadMinutes = travelMinutes.reduce((sum, value) => sum + value, 0);
  const dwellMinutes = dwell.reduce((sum, value) => sum + value, 0);

  return {
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    departureTime: clockParts(start).clock,
    departureMinutes: start,
    stops,
    returnTravelMinutes,
    returnMinutes: returnAt.totalMinutes,
    returnClock: returnAt.clock,
    returnDayOffset: returnAt.dayOffset,
    returnLabel: returnAt.label,
    roadMinutes,
    dwellMinutes,
    totalMinutes: cursor - start
  };
}
