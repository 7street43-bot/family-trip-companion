const MODEL = 'itinerary-v2';
const MODEL_VERSION = 2;
const LOCATION_KINDS = new Set(['home', 'hotel', 'place', 'custom']);

function localDateISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function uid(prefix = 'it2') {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function autoTitle(date) {
  if (!date) return '家庭一日遊';
  const [, m, d] = String(date).split('-');
  return `${Number(m)}/${Number(d)} 一日遊`;
}

function stopCandidateKey(stop = {}) {
  if (stop.candidateKey) return String(stop.candidateKey);
  if (stop.entityId) return `entity:${stop.entityId}`;
  if (stop.placeId) return `place:${stop.placeId}`;
  if (stop.kind === 'custom' && stop.id) return `custom:${stop.id}`;
  return '';
}

export function normalizeTripLocation(location, fallbackKind = 'place') {
  if (!location || typeof location !== 'object') return null;
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);
  const placeId = String(location.placeId || '').trim();
  const address = String(location.address || location.formattedAddress || '').trim();
  if (!placeId && !hasCoordinates && !address) return null;
  const requestedKind = String(location.kind || '').trim();
  const kind = LOCATION_KINDS.has(requestedKind) ? requestedKind : (LOCATION_KINDS.has(fallbackKind) ? fallbackKind : 'place');
  const defaultLabel = kind === 'home' ? '家' : kind === 'hotel' ? '住宿' : '出發地';
  return {
    kind,
    label: String(location.label || location.displayName || defaultLabel).trim() || defaultLabel,
    placeId: placeId || null,
    latitude: hasCoordinates ? latitude : null,
    longitude: hasCoordinates ? longitude : null,
    address,
    googleMapsUrl: String(location.googleMapsUrl || location.googleMapsUri || '').trim(),
    source: String(location.source || (placeId ? 'google-places' : 'manual')).trim() || 'manual'
  };
}

export function createTrip(input = {}) {
  const now = new Date().toISOString();
  const date = input.date || localDateISO();
  // Only brand-new drafts may inherit the asynchronously loaded default Home.
  // Existing J2A/J2B rows always preserve their own explicit (or missing) origin.
  const originInput = input.origin !== undefined ? input.origin : (!input.id ? globalThis.TwinTripDefaultOrigin : null);
  const origin = normalizeTripLocation(originInput, 'home');
  const destinationInput = input.destination !== undefined ? input.destination : (!input.id ? origin : null);
  const destination = normalizeTripLocation(destinationInput, origin?.kind || 'home');
  return {
    id: input.id || uid('tripv2'),
    model: MODEL,
    modelVersion: MODEL_VERSION,
    status: input.status || 'draft',
    title: String(input.title || '').trim() || autoTitle(date),
    date,
    departureTime: input.departureTime || '09:00',
    origin,
    destination,
    scheduleSchemaVersion: Number.isInteger(input.scheduleSchemaVersion) ? input.scheduleSchemaVersion : null,
    stops: Array.isArray(input.stops) ? input.stops.map((s, i) => normalizeStop(s, i)) : [],
    plannerInput: input.plannerInput && typeof input.plannerInput === 'object' ? { ...input.plannerInput } : null,
    createdAt: input.createdAt || now,
    updatedAt: now
  };
}

export function normalizeStop(stop = {}, index = 0) {
  const id = stop.id || uid('stopv2');
  const entityId = stop.entityId || null;
  const placeId = stop.placeId || null;
  const kind = stop.kind || (entityId ? 'entity' : placeId ? 'external' : 'custom');
  const candidateKey = stop.candidateKey || (entityId ? `entity:${entityId}` : placeId ? `place:${placeId}` : kind === 'custom' ? `custom:${id}` : '');
  return {
    id,
    kind,
    candidateKey: candidateKey || null,
    source: stop.source || (entityId ? 'saved' : placeId ? 'external' : 'custom'),
    entityId,
    placeId,
    title: String(stop.title || '').trim() || '未命名地點',
    entityType: stop.entityType || 'attraction',
    latitude: Number.isFinite(stop.latitude) ? stop.latitude : null,
    longitude: Number.isFinite(stop.longitude) ? stop.longitude : null,
    address: String(stop.address || ''),
    googleMapsUrl: String(stop.googleMapsUrl || ''),
    rating: Number.isFinite(stop.rating) ? stop.rating : null,
    userRatingCount: Number.isFinite(stop.userRatingCount) ? stop.userRatingCount : null,
    plannedTime: stop.plannedTime || '',
    note: String(stop.note || ''),
    order: index
  };
}

export function stopFromEntity(entity, index = 0) {
  return normalizeStop({
    kind: 'entity',
    candidateKey: `entity:${entity.id}`,
    source: entity.favorite ? 'favorite' : 'saved',
    entityId: entity.id,
    title: entity.name,
    entityType: entity.entityType,
    latitude: entity.latitude,
    longitude: entity.longitude,
    address: [entity.county || entity.cityRaw, entity.district].filter(Boolean).join(' ')
  }, index);
}

export function stopFromCandidate(candidate = {}, index = 0) {
  return normalizeStop({
    kind: candidate.entityId ? 'entity' : candidate.placeId ? 'external' : 'custom',
    candidateKey: candidate.key,
    source: candidate.source,
    entityId: candidate.entityId,
    placeId: candidate.placeId,
    title: candidate.title,
    entityType: candidate.entityType,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    address: candidate.address,
    googleMapsUrl: candidate.googleMapsUrl,
    rating: candidate.rating,
    userRatingCount: candidate.userRatingCount
  }, index);
}

export function customStop(title, index = 0) {
  return normalizeStop({ kind: 'custom', title }, index);
}

export function withEntities(trip, entities = []) {
  const existing = new Set((trip.stops || []).map(s => s.entityId).filter(Boolean));
  const additions = [];
  for (const entity of entities) {
    if (!entity?.id || existing.has(entity.id)) continue;
    existing.add(entity.id);
    additions.push(stopFromEntity(entity, trip.stops.length + additions.length));
  }
  return createTrip({ ...trip, stops: [...trip.stops, ...additions], createdAt: trip.createdAt });
}

export function withCandidates(trip, candidates = [], selectionOrder = []) {
  const selected = new Set(selectionOrder);
  const byKey = new Map(candidates.filter(Boolean).map(candidate => [candidate.key, candidate]));
  const next = [];
  const included = new Set();

  // Existing stop order wins. This preserves manual reordering when the user returns
  // to the candidate pool, changes the selection, then confirms again.
  for (const stop of trip.stops || []) {
    const key = stopCandidateKey(stop);
    if (!key) continue;
    if (!selected.has(key)) continue;
    next.push(stop);
    included.add(key);
  }

  // Newly selected candidates are appended in the order in which the user selected them.
  for (const key of selectionOrder) {
    if (included.has(key)) continue;
    const candidate = byKey.get(key);
    if (!candidate) continue;
    next.push(stopFromCandidate(candidate, next.length));
    included.add(key);
  }

  return createTrip({ ...trip, stops: next, createdAt: trip.createdAt });
}

export function withCustomStop(trip, title) {
  const clean = String(title || '').trim();
  if (!clean) return trip;
  return createTrip({ ...trip, stops: [...trip.stops, customStop(clean, trip.stops.length)], createdAt: trip.createdAt });
}

export function moveStop(trip, from, to) {
  const stops = [...(trip.stops || [])];
  if (from < 0 || to < 0 || from >= stops.length || to >= stops.length || from === to) return trip;
  const [moved] = stops.splice(from, 1);
  stops.splice(to, 0, moved);
  return createTrip({ ...trip, stops, createdAt: trip.createdAt });
}

export function removeStop(trip, index) {
  const stops = [...(trip.stops || [])];
  if (index < 0 || index >= stops.length) return trip;
  stops.splice(index, 1);
  return createTrip({ ...trip, stops, createdAt: trip.createdAt });
}

export function isV2Trip(trip) {
  return trip?.model === MODEL && trip?.modelVersion === MODEL_VERSION;
}

export function splitTrips(trips = [], today = localDateISO()) {
  const rows = trips.filter(isV2Trip).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  return {
    upcoming: rows.filter(t => !t.date || t.date >= today),
    past: rows.filter(t => t.date && t.date < today).reverse()
  };
}

export function formatDateLabel(value) {
  if (!value) return '未設定日期';
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(date);
}

export const ITINERARY_V2 = Object.freeze({ MODEL, MODEL_VERSION });
