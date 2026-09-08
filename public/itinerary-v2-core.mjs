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
    stops: Array.isArray(input.stops) ? input.stops.map((s, i) => normalizeStop(s, i)) : [],
    createdAt: input.createdAt || now,
    updatedAt: now
  };
}

export function normalizeStop(stop = {}, index = 0) {
  return {
    id: stop.id || uid('stopv2'),
    kind: stop.kind || (stop.entityId ? 'entity' : 'custom'),
    entityId: stop.entityId || null,
    title: String(stop.title || '').trim() || '未命名地點',
    entityType: stop.entityType || 'attraction',
    latitude: Number.isFinite(stop.latitude) ? stop.latitude : null,
    longitude: Number.isFinite(stop.longitude) ? stop.longitude : null,
    plannedTime: stop.plannedTime || '',
    note: String(stop.note || ''),
    order: index
  };
}

export function stopFromEntity(entity, index = 0) {
  return normalizeStop({
    kind: 'entity',
    entityId: entity.id,
    title: entity.name,
    entityType: entity.entityType,
    latitude: entity.latitude,
    longitude: entity.longitude
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
