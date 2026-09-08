const MODEL = 'itinerary-v2';
const MODEL_VERSION = 2;

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

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stopCandidateKey(stop = {}) {
  if (stop.candidateKey) return String(stop.candidateKey);
  if (stop.entityId) return `entity:${stop.entityId}`;
  if (stop.placeId) return `place:${stop.placeId}`;
  if (stop.kind === 'custom' && stop.id) return `custom:${stop.id}`;
  return '';
}

export function normalizeOrigin(origin = {}) {
  const latitude = numberOrNull(origin.latitude);
  const longitude = numberOrNull(origin.longitude);
  return {
    label: String(origin.label || '家').trim().slice(0, 80) || '家',
    address: String(origin.address || '').trim().slice(0, 260),
    placeId: String(origin.placeId || '').trim().slice(0, 180) || null,
    latitude: latitude !== null && latitude >= -90 && latitude <= 90 ? latitude : null,
    longitude: longitude !== null && longitude >= -180 && longitude <= 180 ? longitude : null
  };
}

function cloneRoutePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  return {
    ...plan,
    orderKeys: Array.isArray(plan.orderKeys) ? [...plan.orderKeys] : [],
    legs: Array.isArray(plan.legs) ? plan.legs.map(leg => ({ ...leg })) : []
  };
}

export function createTrip(input = {}) {
  const now = new Date().toISOString();
  const date = input.date || localDateISO();
  return {
    id: input.id || uid('tripv2'),
    model: MODEL,
    modelVersion: MODEL_VERSION,
    status: input.status || 'draft',
    title: String(input.title || '').trim() || autoTitle(date),
    date,
    departureTime: input.departureTime || '09:00',
    origin: normalizeOrigin(input.origin || {}),
    stops: Array.isArray(input.stops) ? input.stops.map((s, i) => normalizeStop(s, i)) : [],
    plannerInput: input.plannerInput && typeof input.plannerInput === 'object' ? { ...input.plannerInput } : null,
    routePlan: cloneRoutePlan(input.routePlan),
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
    latitude: numberOrNull(stop.latitude),
    longitude: numberOrNull(stop.longitude),
    address: String(stop.address || ''),
    googleMapsUrl: String(stop.googleMapsUrl || ''),
    rating: numberOrNull(stop.rating),
    userRatingCount: numberOrNull(stop.userRatingCount),
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
    placeId: entity.googlePlaceId || null,
    title: entity.name,
    entityType: entity.entityType,
    latitude: entity.latitude,
    longitude: entity.longitude,
    address: entity.address || [entity.county || entity.cityRaw, entity.district].filter(Boolean).join(' '),
    googleMapsUrl: entity.googleMapsUrl || ''
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

export function withOrigin(trip, origin = {}) {
  return createTrip({ ...trip, origin:normalizeOrigin(origin), routePlan:null, createdAt:trip.createdAt });
}

export function withEntities(trip, entities = []) {
  const existing = new Set((trip.stops || []).map(s => s.entityId).filter(Boolean));
  const additions = [];
  for (const entity of entities) {
    if (!entity?.id || existing.has(entity.id)) continue;
    existing.add(entity.id);
    additions.push(stopFromEntity(entity, trip.stops.length + additions.length));
  }
  return createTrip({ ...trip, stops: [...trip.stops, ...additions], routePlan:null, createdAt: trip.createdAt });
}

export function withCandidates(trip, candidates = [], selectionOrder = []) {
  const selected = new Set(selectionOrder);
  const byKey = new Map(candidates.filter(Boolean).map(candidate => [candidate.key, candidate]));
  const next = [];
  const included = new Set();

  for (const stop of trip.stops || []) {
    const key = stopCandidateKey(stop);
    if (!key || !selected.has(key)) continue;
    next.push(stop);
    included.add(key);
  }

  for (const key of selectionOrder) {
    if (included.has(key)) continue;
    const candidate = byKey.get(key);
    if (!candidate) continue;
    next.push(stopFromCandidate(candidate, next.length));
    included.add(key);
  }

  return createTrip({ ...trip, stops: next, routePlan:null, createdAt: trip.createdAt });
}

export function withCustomStop(trip, title) {
  const clean = String(title || '').trim();
  if (!clean) return trip;
  return createTrip({ ...trip, stops: [...trip.stops, customStop(clean, trip.stops.length)], routePlan:null, createdAt: trip.createdAt });
}

export function moveStop(trip, from, to) {
  const stops = [...(trip.stops || [])];
  if (from < 0 || to < 0 || from >= stops.length || to >= stops.length || from === to) return trip;
  const [moved] = stops.splice(from, 1);
  stops.splice(to, 0, moved);
  return createTrip({ ...trip, stops, routePlan:null, createdAt: trip.createdAt });
}

export function removeStop(trip, index) {
  const stops = [...(trip.stops || [])];
  if (index < 0 || index >= stops.length) return trip;
  stops.splice(index, 1);
  return createTrip({ ...trip, stops, routePlan:null, createdAt: trip.createdAt });
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
