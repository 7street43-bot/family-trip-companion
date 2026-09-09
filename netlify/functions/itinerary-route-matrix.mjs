function getApiKey() {
  return process.env.GOOGLE_ROUTES_API_KEY
    || process.env.GOOGLE_MAPS_API_KEY
    || process.env.GOOGLE_PLACES_API_KEY
    || '';
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function clean(value = '', max = 240) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, max);
}

function finiteCoordinate(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeNode(input = {}, index = 0, fallbackPrefix = 'stop') {
  const latitude = finiteCoordinate(input.latitude);
  const longitude = finiteCoordinate(input.longitude);
  const placeId = clean(input.placeId, 220);
  const address = clean(input.address, 320);
  const title = clean(input.title || input.label || address || `${fallbackPrefix} ${index + 1}`, 140);
  const key = clean(input.key || input.candidateKey || input.id || `${fallbackPrefix}:${index}`, 220);
  if (!placeId && (latitude === null || longitude === null) && !address) return null;
  return {
    key,
    title,
    placeId: placeId || null,
    latitude,
    longitude,
    address
  };
}

function toWaypoint(node = {}) {
  if (node.placeId) return { placeId: node.placeId };
  if (Number.isFinite(node.latitude) && Number.isFinite(node.longitude)) {
    return { location: { latLng: { latitude: node.latitude, longitude: node.longitude } } };
  }
  if (node.address) return { address: node.address };
  return null;
}

function sameLocation(a = {}, b = {}) {
  if (a.placeId && b.placeId) return a.placeId === b.placeId;
  if (
    Number.isFinite(a.latitude) && Number.isFinite(a.longitude)
    && Number.isFinite(b.latitude) && Number.isFinite(b.longitude)
  ) {
    return Math.abs(a.latitude - b.latitude) < 1e-6 && Math.abs(a.longitude - b.longitude) < 1e-6;
  }
  return Boolean(a.address && b.address && a.address === b.address);
}

function parseDuration(value = '') {
  const match = String(value).match(/^(-?\d+(?:\.\d+)?)s$/);
  return match ? Number(match[1]) : NaN;
}

function elementOk(element = {}) {
  const code = Number(element.status?.code || 0);
  return code === 0
    && element.condition === 'ROUTE_EXISTS'
    && Number.isFinite(Number(element.distanceMeters))
    && Number.isFinite(parseDuration(element.duration));
}

function matrixFromElements(elements = [], size = 0) {
  const matrix = Array.from({ length: size }, () => Array(size).fill(null));
  for (const element of elements) {
    const oi = Number(element.originIndex);
    const di = Number(element.destinationIndex);
    if (!Number.isInteger(oi) || !Number.isInteger(di) || oi < 0 || di < 0 || oi >= size || di >= size) continue;
    if (oi === di) {
      matrix[oi][di] = { durationSeconds: 0, distanceMeters: 0 };
      continue;
    }
    if (!elementOk(element)) continue;
    matrix[oi][di] = {
      durationSeconds: parseDuration(element.duration),
      distanceMeters: Number(element.distanceMeters)
    };
  }
  for (let i = 0; i < size; i += 1) {
    if (!matrix[i][i]) matrix[i][i] = { durationSeconds: 0, distanceMeters: 0 };
  }
  return matrix;
}

function routeTotals(route = [], matrix = []) {
  const legs = [];
  let totalDurationSeconds = 0;
  let totalDistanceMeters = 0;
  for (let i = 0; i < route.length - 1; i += 1) {
    const fromIndex = route[i];
    const toIndex = route[i + 1];
    const edge = matrix[fromIndex]?.[toIndex];
    if (!edge) return null;
    totalDurationSeconds += edge.durationSeconds;
    totalDistanceMeters += edge.distanceMeters;
    legs.push({
      fromIndex,
      toIndex,
      durationSeconds: Math.round(edge.durationSeconds),
      distanceMeters: Math.round(edge.distanceMeters)
    });
  }
  return {
    totalDurationSeconds: Math.round(totalDurationSeconds),
    totalDistanceMeters: Math.round(totalDistanceMeters),
    legs
  };
}

function nearestNeighbor(startIndex, stopIndices = [], endIndex, matrix = []) {
  const remaining = new Set(stopIndices);
  const route = [startIndex];
  let current = startIndex;
  while (remaining.size) {
    let best = null;
    for (const candidate of remaining) {
      const edge = matrix[current]?.[candidate];
      if (!edge) continue;
      if (
        !best
        || edge.durationSeconds < best.durationSeconds
        || (edge.durationSeconds === best.durationSeconds && edge.distanceMeters < best.distanceMeters)
      ) {
        best = { index: candidate, ...edge };
      }
    }
    if (!best) return null;
    route.push(best.index);
    remaining.delete(best.index);
    current = best.index;
  }
  route.push(endIndex);
  return routeTotals(route, matrix) ? route : null;
}

function twoOpt(route = [], matrix = [], maxPasses = 8) {
  let bestRoute = [...route];
  let bestTotals = routeTotals(bestRoute, matrix);
  if (!bestTotals) return null;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let improved = false;
    for (let i = 1; i < bestRoute.length - 2; i += 1) {
      for (let j = i + 1; j < bestRoute.length - 1; j += 1) {
        const candidate = [
          ...bestRoute.slice(0, i),
          ...bestRoute.slice(i, j + 1).reverse(),
          ...bestRoute.slice(j + 1)
        ];
        const totals = routeTotals(candidate, matrix);
        if (!totals) continue;
        const better = totals.totalDurationSeconds < bestTotals.totalDurationSeconds
          || (
            totals.totalDurationSeconds === bestTotals.totalDurationSeconds
            && totals.totalDistanceMeters < bestTotals.totalDistanceMeters
          );
        if (better) {
          bestRoute = candidate;
          bestTotals = totals;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return { route: bestRoute, ...bestTotals };
}

function enrichRoute(routeResult, nodes = [], stopNodeIndices = []) {
  if (!routeResult) return null;
  const stopSet = new Set(stopNodeIndices);
  const orderedStopKeys = routeResult.route
    .filter(index => stopSet.has(index))
    .map(index => nodes[index]?.key)
    .filter(Boolean);
  const legs = routeResult.legs.map(leg => ({
    ...leg,
    fromKey: nodes[leg.fromIndex]?.key || null,
    fromTitle: nodes[leg.fromIndex]?.title || '',
    toKey: nodes[leg.toIndex]?.key || null,
    toTitle: nodes[leg.toIndex]?.title || ''
  }));
  return {
    orderedStopKeys,
    totalDurationSeconds: routeResult.totalDurationSeconds,
    totalDistanceMeters: routeResult.totalDistanceMeters,
    legs
  };
}

function buildRequestNodes(body = {}) {
  const origin = normalizeNode({ ...(body.origin || {}), key: 'origin', title: body.origin?.label || body.origin?.title || '出發地' }, 0, 'origin');
  if (!origin) return { error: 'origin_required' };

  const rawStops = Array.isArray(body.stops) ? body.stops : [];
  if (!rawStops.length) return { error: 'stops_required' };
  if (rawStops.length > 12) return { error: 'too_many_stops' };

  const stops = rawStops.map((stop, index) => normalizeNode(stop, index, 'stop'));
  if (stops.some(stop => !stop)) return { error: 'unroutable_stop' };

  const keys = new Set();
  for (const stop of stops) {
    if (!stop.key || keys.has(stop.key)) return { error: 'duplicate_stop_key' };
    keys.add(stop.key);
  }

  const destinationCandidate = normalizeNode({
    ...(body.destination || body.origin || {}),
    key: 'destination',
    title: body.destination?.label || body.destination?.title || '終點'
  }, 0, 'destination') || origin;

  const nodes = [origin, ...stops];
  const stopNodeIndices = stops.map((_, index) => index + 1);
  let endIndex = 0;
  if (!sameLocation(origin, destinationCandidate)) {
    endIndex = nodes.length;
    nodes.push(destinationCandidate);
  }

  return {
    origin,
    stops,
    destination: endIndex === 0 ? origin : destinationCandidate,
    nodes,
    stopNodeIndices,
    startIndex: 0,
    endIndex
  };
}

async function callRoutes(apiKey, nodes = []) {
  const waypoints = nodes.map(toWaypoint);
  if (waypoints.some(waypoint => !waypoint)) throw new Error('invalid_waypoint');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'originIndex,destinationIndex,status,condition,distanceMeters,duration'
      },
      body: JSON.stringify({
        origins: waypoints.map(waypoint => ({ waypoint })),
        destinations: waypoints.map(waypoint => ({ waypoint })),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE'
      })
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1800);
      const error = new Error('google_routes_error');
      error.status = response.status;
      error.detail = detail;
      throw error;
    }
    const result = await response.json();
    return Array.isArray(result) ? result : [];
  } finally {
    clearTimeout(timer);
  }
}

export default async req => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const apiKey = getApiKey();
  if (!apiKey) return json({ error: 'not_configured', message: 'GOOGLE_ROUTES_API_KEY 尚未設定' }, 503);

  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'invalid_json' }, 400); }

  const built = buildRequestNodes(body);
  if (built.error) return json({ error: built.error }, 400);

  try {
    const elements = await callRoutes(apiKey, built.nodes);
    const matrix = matrixFromElements(elements, built.nodes.length);
    const currentRouteIndices = [built.startIndex, ...built.stopNodeIndices, built.endIndex];
    const currentTotals = routeTotals(currentRouteIndices, matrix);
    if (!currentTotals) {
      return json({ error: 'route_incomplete', message: '部分地點之間沒有可用的開車路線' }, 422);
    }

    const greedy = nearestNeighbor(built.startIndex, built.stopNodeIndices, built.endIndex, matrix);
    if (!greedy) return json({ error: 'route_incomplete', message: '無法建立完整順遊路線' }, 422);
    const optimized = twoOpt(greedy, matrix) || { route: greedy, ...routeTotals(greedy, matrix) };

    const current = enrichRoute({ route: currentRouteIndices, ...currentTotals }, built.nodes, built.stopNodeIndices);
    const suggested = enrichRoute(optimized, built.nodes, built.stopNodeIndices);

    return json({
      provider: 'google-routes',
      matrixVersion: 1,
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_UNAWARE',
      strategy: 'nearest-neighbor+2opt',
      requestedStopKeys: built.stops.map(stop => stop.key),
      orderedStopKeys: suggested.orderedStopKeys,
      current,
      suggested,
      savingsSeconds: Math.max(0, current.totalDurationSeconds - suggested.totalDurationSeconds),
      savingsMeters: Math.max(0, current.totalDistanceMeters - suggested.totalDistanceMeters),
      elementCount: built.nodes.length * built.nodes.length,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[itinerary-route-matrix] provider error', {
      status: error.status || 502,
      detail: error.detail || String(error)
    });
    return json({
      error: 'route_provider_error',
      status: error.status || 502,
      detail: error.detail || ''
    }, 502);
  }
};

export const __test = {
  clean,
  normalizeNode,
  toWaypoint,
  sameLocation,
  parseDuration,
  matrixFromElements,
  routeTotals,
  nearestNeighbor,
  twoOpt,
  buildRequestNodes
};

export const config = {
  path: '/api/itinerary-route-matrix',
  rateLimit: { windowLimit: 15, windowSize: 60, aggregateBy: ['ip', 'domain'] }
};