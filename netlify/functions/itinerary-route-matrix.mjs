function env(name) {
  return globalThis.Netlify?.env?.get?.(name) || '';
}

function getApiKey() {
  return env('GOOGLE_ROUTES_API_KEY') || env('GOOGLE_PLACES_API_KEY') || env('GOOGLE_MAPS_API_KEY');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

function clean(value = '', max = 300) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, max);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseDuration(value = '') {
  const match = String(value || '').match(/^(-?\d+(?:\.\d+)?)s$/);
  return match ? Math.max(0, Number(match[1])) : null;
}

function normalizeLocation(raw = {}) {
  const key = clean(raw.key, 220);
  if (!key) return null;
  const placeId = clean(raw.placeId, 180);
  const latitude = numberOrNull(raw.latitude);
  const longitude = numberOrNull(raw.longitude);
  const address = clean(raw.address, 260);
  const validLatLng = latitude !== null && longitude !== null && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
  if (!placeId && !validLatLng && !address) return null;
  return { key, placeId:placeId || null, latitude:validLatLng ? latitude : null, longitude:validLatLng ? longitude : null, address };
}

function normalizeLocations(raw = []) {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 9) {
    const error = new Error('locations_count_invalid');
    error.status = 400;
    throw error;
  }
  const locations = raw.map(normalizeLocation);
  if (locations.some(x => !x)) {
    const error = new Error('location_invalid');
    error.status = 400;
    throw error;
  }
  const keys = locations.map(x => x.key);
  if (new Set(keys).size !== keys.length) {
    const error = new Error('location_key_duplicate');
    error.status = 400;
    throw error;
  }
  return locations;
}

function waypoint(location) {
  if (location.placeId) return { placeId:location.placeId };
  if (location.latitude !== null && location.longitude !== null) {
    return { location:{ latLng:{ latitude:location.latitude, longitude:location.longitude } } };
  }
  return { address:location.address };
}

function buildRoutesRequest(locations) {
  return {
    origins: locations.map(location => ({ waypoint:waypoint(location) })),
    destinations: locations.map(location => ({ waypoint:waypoint(location) })),
    travelMode:'DRIVE',
    routingPreference:'TRAFFIC_UNAWARE',
    languageCode:'zh-TW',
    regionCode:'tw',
    units:'METRIC'
  };
}

function parseMatrixPayload(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {}
  const out = [];
  for (const line of raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
    const parsed = JSON.parse(line);
    if (Array.isArray(parsed)) out.push(...parsed); else out.push(parsed);
  }
  return out;
}

function mapElements(elements, locations) {
  const out = [];
  for (const element of elements) {
    const originIndex = Number(element.originIndex);
    const destinationIndex = Number(element.destinationIndex);
    const from = locations[originIndex];
    const to = locations[destinationIndex];
    if (!from || !to) continue;
    const statusCode = Number(element.status?.code ?? 0);
    const condition = clean(element.condition, 80);
    out.push({
      fromKey:from.key,
      toKey:to.key,
      originIndex,
      destinationIndex,
      statusCode:Number.isFinite(statusCode) ? statusCode : 0,
      condition:condition || (from.key === to.key ? 'ROUTE_EXISTS' : ''),
      distanceMeters:numberOrNull(element.distanceMeters) ?? (from.key === to.key ? 0 : null),
      durationSeconds:parseDuration(element.duration) ?? (from.key === to.key ? 0 : null)
    });
  }
  const seen = new Set(out.map(x => `${x.fromKey}→${x.toKey}`));
  for (const location of locations) {
    const key = `${location.key}→${location.key}`;
    if (!seen.has(key)) out.push({ fromKey:location.key, toKey:location.key, originIndex:null, destinationIndex:null, statusCode:0, condition:'ROUTE_EXISTS', distanceMeters:0, durationSeconds:0 });
  }
  return out;
}

async function computeMatrix(apiKey, requestBody) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
      method:'POST',
      signal:controller.signal,
      headers:{
        'content-type':'application/json',
        'X-Goog-Api-Key':apiKey,
        'X-Goog-FieldMask':'originIndex,destinationIndex,status,condition,distanceMeters,duration'
      },
      body:JSON.stringify(requestBody)
    });
    const bodyText = await response.text();
    if (!response.ok) {
      const error = new Error('google_routes_error');
      error.status = response.status;
      error.detail = bodyText.slice(0, 1200);
      throw error;
    }
    return parseMatrixPayload(bodyText);
  } finally {
    clearTimeout(timer);
  }
}

export default async req => {
  if (req.method !== 'POST') return json({ error:'method_not_allowed' }, 405);
  const apiKey = getApiKey();
  if (!apiKey) return json({ error:'not_configured', message:'Google Maps Platform API key 尚未設定' }, 503);
  let body;
  try { body = await req.json(); }
  catch { return json({ error:'invalid_json' }, 400); }

  let locations;
  try { locations = normalizeLocations(body.locations); }
  catch (error) { return json({ error:error.message || 'invalid_locations' }, error.status || 400); }

  try {
    const requestBody = buildRoutesRequest(locations);
    const elements = mapElements(await computeMatrix(apiKey, requestBody), locations);
    return json({
      provider:{ version:'google-routes-v2', method:'computeRouteMatrix', travelMode:'DRIVE', routingPreference:'TRAFFIC_UNAWARE' },
      locationCount:locations.length,
      elementCount:elements.length,
      elements
    });
  } catch (error) {
    console.error('[itinerary-route-matrix] provider error', { status:error.status || 502, detail:error.detail || String(error) });
    return json({ error:'route_provider_error', status:error.status || 502, detail:error.detail || '' }, 502);
  }
};

export const __test = { parseDuration, normalizeLocation, normalizeLocations, waypoint, buildRoutesRequest, parseMatrixPayload, mapElements };
export const config = { path:'/api/itinerary-route-matrix', rateLimit:{ windowLimit:10, windowSize:60, aggregateBy:['ip','domain'] } };
