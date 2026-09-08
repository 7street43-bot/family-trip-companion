const ROUTE_MODEL = 'itinerary-route-plan-v1';
export const MAX_ROUTE_STOPS = 8;

function text(value = '', max = 300) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, max);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stopKey(stop = {}) {
  return text(stop.candidateKey || (stop.entityId ? `entity:${stop.entityId}` : stop.placeId ? `place:${stop.placeId}` : stop.id ? `stop:${stop.id}` : ''), 220);
}

export function isPreciseAddress(value = '') {
  const address = text(value, 260);
  if (address.length < 6) return false;
  return /\d/.test(address) && /(路|街|巷|弄|號|大道|Road|Street|Rd\.?|St\.?)/i.test(address);
}

function baseRoutePoint({ key, title, placeId, latitude, longitude, address }, { allowAnyAddress = false } = {}) {
  const cleanKey = text(key, 220);
  if (!cleanKey) return null;
  const pid = text(placeId, 180);
  const lat = numberOrNull(latitude);
  const lng = numberOrNull(longitude);
  const addr = text(address, 260);
  const validLatLng = lat !== null && lng !== null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  const usableAddress = addr && (allowAnyAddress ? addr.length >= 4 : isPreciseAddress(addr));
  if (!pid && !validLatLng && !usableAddress) return null;
  return {
    key: cleanKey,
    title: text(title, 160) || cleanKey,
    placeId: pid || null,
    latitude: validLatLng ? lat : null,
    longitude: validLatLng ? lng : null,
    address: usableAddress ? addr : ''
  };
}

export function routePointFromStop(stop = {}) {
  return baseRoutePoint({
    key: stopKey(stop),
    title: stop.title,
    placeId: stop.placeId,
    latitude: stop.latitude,
    longitude: stop.longitude,
    address: stop.address
  });
}

export function routePointFromOrigin(origin = {}) {
  const hasInput = text(origin.placeId, 180) || text(origin.address, 260) ||
    (numberOrNull(origin.latitude) !== null && numberOrNull(origin.longitude) !== null);
  if (!hasInput) return null;
  return baseRoutePoint({
    key: 'origin:home',
    title: origin.label || '出發地',
    placeId: origin.placeId,
    latitude: origin.latitude,
    longitude: origin.longitude,
    address: origin.address
  }, { allowAnyAddress: true });
}

export function buildRouteLocations(stops = [], origin = null) {
  if (!Array.isArray(stops) || stops.length < 2) return { ok:false, reason:'need_two_stops', locations:[], blockers:[] };
  if (stops.length > MAX_ROUTE_STOPS) return { ok:false, reason:'too_many_stops', locations:[], blockers:stops.slice(MAX_ROUTE_STOPS).map(s => stopKey(s)) };
  const points = [];
  const blockers = [];
  for (const stop of stops) {
    const point = routePointFromStop(stop);
    if (point) points.push(point);
    else blockers.push(stopKey(stop) || text(stop.title, 160) || 'unknown');
  }
  if (blockers.length) return { ok:false, reason:'unroutable_stops', locations:points, blockers };
  const originPoint = routePointFromOrigin(origin || {});
  return { ok:true, reason:'ok', locations:originPoint ? [originPoint, ...points] : points, stopPoints:points, originPoint, blockers:[] };
}

export function matrixKey(fromKey, toKey) {
  return `${fromKey}→${toKey}`;
}

export function normalizeMatrix(elements = []) {
  const map = new Map();
  for (const raw of Array.isArray(elements) ? elements : []) {
    const fromKey = text(raw.fromKey, 220);
    const toKey = text(raw.toKey, 220);
    if (!fromKey || !toKey) continue;
    const durationSeconds = numberOrNull(raw.durationSeconds);
    const distanceMeters = numberOrNull(raw.distanceMeters);
    const condition = text(raw.condition, 80);
    const statusCode = numberOrNull(raw.statusCode) ?? 0;
    if (fromKey === toKey) {
      map.set(matrixKey(fromKey, toKey), { fromKey, toKey, durationSeconds:0, distanceMeters:0, condition:'ROUTE_EXISTS', statusCode:0 });
      continue;
    }
    if (statusCode !== 0 || condition !== 'ROUTE_EXISTS' || durationSeconds === null || distanceMeters === null) continue;
    map.set(matrixKey(fromKey, toKey), { fromKey, toKey, durationSeconds, distanceMeters, condition, statusCode });
  }
  return map;
}

function edge(map, fromKey, toKey) {
  return map.get(matrixKey(fromKey, toKey)) || null;
}

function better(a, b) {
  if (!b) return true;
  if (a.durationSeconds !== b.durationSeconds) return a.durationSeconds < b.durationSeconds;
  if (a.distanceMeters !== b.distanceMeters) return a.distanceMeters < b.distanceMeters;
  return a.path.join('|') < b.path.join('|');
}

export function optimizeRoute(stopPoints = [], matrixElements = [], { originPoint = null, roundTrip = false } = {}) {
  const points = Array.isArray(stopPoints) ? stopPoints.filter(Boolean) : [];
  if (points.length < 2) return { ok:false, reason:'need_two_stops' };
  if (points.length > MAX_ROUTE_STOPS) return { ok:false, reason:'too_many_stops' };
  const keys = points.map(p => text(p.key, 220));
  if (keys.some(k => !k) || new Set(keys).size !== keys.length) return { ok:false, reason:'invalid_stop_keys' };
  const originKey = originPoint?.key ? text(originPoint.key, 220) : '';
  const matrix = normalizeMatrix(matrixElements);
  const n = keys.length;
  const states = Array.from({ length:1 << n }, () => Array(n).fill(null));

  for (let i = 0; i < n; i++) {
    let durationSeconds = 0;
    let distanceMeters = 0;
    if (originKey) {
      const e = edge(matrix, originKey, keys[i]);
      if (!e) continue;
      durationSeconds = e.durationSeconds;
      distanceMeters = e.distanceMeters;
    }
    states[1 << i][i] = { durationSeconds, distanceMeters, path:[keys[i]] };
  }

  for (let mask = 1; mask < (1 << n); mask++) {
    for (let last = 0; last < n; last++) {
      const state = states[mask][last];
      if (!state) continue;
      for (let next = 0; next < n; next++) {
        if (mask & (1 << next)) continue;
        const e = edge(matrix, keys[last], keys[next]);
        if (!e) continue;
        const nextMask = mask | (1 << next);
        const candidate = {
          durationSeconds: state.durationSeconds + e.durationSeconds,
          distanceMeters: state.distanceMeters + e.distanceMeters,
          path: [...state.path, keys[next]]
        };
        if (better(candidate, states[nextMask][next])) states[nextMask][next] = candidate;
      }
    }
  }

  const fullMask = (1 << n) - 1;
  let best = null;
  for (let last = 0; last < n; last++) {
    const state = states[fullMask][last];
    if (!state) continue;
    let candidate = state;
    if (originKey && roundTrip) {
      const back = edge(matrix, keys[last], originKey);
      if (!back) continue;
      candidate = {
        durationSeconds: state.durationSeconds + back.durationSeconds,
        distanceMeters: state.distanceMeters + back.distanceMeters,
        path: state.path
      };
    }
    if (better(candidate, best)) best = candidate;
  }
  if (!best) return { ok:false, reason:'route_incomplete' };

  const legs = [];
  let from = originKey || '';
  for (const to of best.path) {
    if (from) {
      const e = edge(matrix, from, to);
      if (!e) return { ok:false, reason:'route_incomplete' };
      legs.push({ ...e });
    }
    from = to;
  }
  if (originKey && roundTrip) {
    const e = edge(matrix, from, originKey);
    if (!e) return { ok:false, reason:'route_incomplete' };
    legs.push({ ...e });
  }

  return {
    ok:true,
    model:ROUTE_MODEL,
    strategy:'exact-duration-dp',
    orderKeys:best.path,
    totalDurationSeconds:best.durationSeconds,
    totalDistanceMeters:best.distanceMeters,
    roundTrip:!!(originKey && roundTrip),
    originKey:originKey || null,
    legs
  };
}

export function applyOptimizedRoute(trip = {}, plan = {}) {
  if (!plan?.ok || !Array.isArray(plan.orderKeys)) return trip;
  const byKey = new Map((trip.stops || []).map(stop => [stopKey(stop), stop]));
  if (plan.orderKeys.length !== byKey.size) return trip;
  const ordered = plan.orderKeys.map(key => byKey.get(key));
  if (ordered.some(x => !x)) return trip;
  return {
    ...trip,
    stops: ordered.map((stop, index) => ({ ...stop, order:index })),
    routePlan: {
      model:ROUTE_MODEL,
      strategy:plan.strategy || 'exact-duration-dp',
      orderKeys:[...plan.orderKeys],
      totalDurationSeconds:plan.totalDurationSeconds,
      totalDistanceMeters:plan.totalDistanceMeters,
      roundTrip:!!plan.roundTrip,
      originKey:plan.originKey || null,
      legs:(plan.legs || []).map(x => ({ ...x })),
      optimizedAt:new Date().toISOString()
    },
    updatedAt:new Date().toISOString()
  };
}

export function formatRouteDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.max(hours ? 0 : 1, Math.round((value % 3600) / 60));
  return hours ? `${hours} 小時${minutes ? ` ${minutes} 分` : ''}` : `${minutes} 分`;
}

export function formatRouteDistance(meters) {
  const value = Math.max(0, Number(meters) || 0);
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} km` : `${Math.round(value)} m`;
}

export const ITINERARY_ROUTE = Object.freeze({ model:ROUTE_MODEL, maxStops:MAX_ROUTE_STOPS });
