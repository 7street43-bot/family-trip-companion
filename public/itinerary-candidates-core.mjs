const CANDIDATE_MODEL = 'itinerary-candidate-v1';

function text(value = '', max = 240) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, max);
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function uniq(values = []) {
  return [...new Set(values.filter(Boolean))];
}

export function normalizeThemes(value) {
  const rows = Array.isArray(value) ? value : String(value || '').split(/[,，、\n]/);
  return uniq(rows.map(v => text(v, 30)).filter(Boolean)).slice(0, 8);
}

export function normalizePlannerInput(input = {}) {
  return {
    request: text(input.request, 500),
    location: text(input.location, 80),
    anchor: text(input.anchor, 120),
    themes: normalizeThemes(input.themes),
    entityType: ['attraction', 'restaurant', 'hotel', 'activity'].includes(input.entityType) ? input.entityType : 'attraction'
  };
}

export function candidateKey(candidate = {}) {
  if (candidate.key) return text(candidate.key, 220);
  if (candidate.entityId) return `entity:${candidate.entityId}`;
  if (candidate.placeId) return `place:${candidate.placeId}`;
  if (candidate.customId) return `custom:${candidate.customId}`;
  const title = text(candidate.title || candidate.name, 120).toLowerCase();
  const location = text(candidate.address || candidate.location, 160).toLowerCase();
  return title ? `text:${title}|${location}` : '';
}

export function candidateFromEntity(entity = {}) {
  if (!entity?.id || !entity?.name) return null;
  return normalizeCandidate({
    key: `entity:${entity.id}`,
    source: entity.favorite ? 'favorite' : 'saved',
    entityId: entity.id,
    title: entity.name,
    entityType: entity.entityType || 'attraction',
    latitude: entity.latitude,
    longitude: entity.longitude,
    address: [entity.county || entity.cityRaw, entity.district].filter(Boolean).join(' '),
    favorite: !!entity.favorite,
    tags: entity.tags || []
  });
}

export function candidateFromExternal(place = {}) {
  const placeId = text(place.placeId || place.id, 180);
  const title = text(place.title || place.displayName || place.name, 160);
  if (!placeId || !title) return null;
  return normalizeCandidate({
    key: `place:${placeId}`,
    source: 'external',
    placeId,
    title,
    entityType: place.entityType || mapPrimaryType(place.primaryType),
    latitude: place.latitude,
    longitude: place.longitude,
    address: place.address || place.formattedAddress || '',
    googleMapsUrl: place.googleMapsUrl || place.googleMapsUri || '',
    primaryType: place.primaryType || '',
    primaryTypeLabel: place.primaryTypeLabel || '',
    rating: place.rating,
    userRatingCount: place.userRatingCount,
    businessStatus: place.businessStatus || '',
    openNow: typeof place.openNow === 'boolean' ? place.openNow : null,
    sourceQuery: place.sourceQuery || '',
    sourceRank: place.sourceRank
  });
}

export function candidateFromCustom(title, customId) {
  const clean = text(title, 160);
  if (!clean) return null;
  const id = text(customId, 160) || `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return normalizeCandidate({
    key: `custom:${id}`,
    customId: id,
    source: 'custom',
    title: clean,
    entityType: 'attraction'
  });
}

export function candidateFromStop(stop = {}) {
  if (!stop?.title) return null;
  const key = candidateKey(stop) || (stop.kind === 'custom' ? `custom:${stop.id}` : '');
  if (!key) return null;
  return normalizeCandidate({
    key,
    source: stop.source || (stop.entityId ? 'saved' : stop.placeId ? 'external' : 'custom'),
    entityId: stop.entityId,
    placeId: stop.placeId,
    customId: key.startsWith('custom:') ? key.slice(7) : '',
    title: stop.title,
    entityType: stop.entityType,
    latitude: stop.latitude,
    longitude: stop.longitude,
    address: stop.address,
    googleMapsUrl: stop.googleMapsUrl,
    rating: stop.rating,
    userRatingCount: stop.userRatingCount
  });
}

export function normalizeCandidate(input = {}) {
  const key = candidateKey(input);
  const title = text(input.title || input.name, 160);
  if (!key || !title) return null;
  return {
    model: CANDIDATE_MODEL,
    key,
    source: ['saved', 'favorite', 'external', 'custom', 'history'].includes(input.source) ? input.source : 'external',
    entityId: text(input.entityId, 180) || null,
    placeId: text(input.placeId, 180) || null,
    customId: text(input.customId, 180) || null,
    title,
    entityType: ['attraction', 'restaurant', 'hotel', 'activity'].includes(input.entityType) ? input.entityType : 'attraction',
    latitude: numberOrNull(input.latitude),
    longitude: numberOrNull(input.longitude),
    address: text(input.address, 220),
    googleMapsUrl: text(input.googleMapsUrl, 500),
    primaryType: text(input.primaryType, 80),
    primaryTypeLabel: text(input.primaryTypeLabel, 80),
    rating: numberOrNull(input.rating),
    userRatingCount: numberOrNull(input.userRatingCount),
    businessStatus: text(input.businessStatus, 80),
    openNow: typeof input.openNow === 'boolean' ? input.openNow : null,
    favorite: !!input.favorite,
    tags: uniq((Array.isArray(input.tags) ? input.tags : []).map(v => text(v, 40))).slice(0, 12),
    sourceQuery: text(input.sourceQuery, 300),
    sourceRank: numberOrNull(input.sourceRank)
  };
}

function mapPrimaryType(primaryType = '') {
  const value = String(primaryType || '');
  if (/(restaurant|cafe|bakery|food)/.test(value)) return 'restaurant';
  if (/(hotel|lodging|motel|hostel|resort|campground)/.test(value)) return 'hotel';
  if (/(amusement|playground|activity|sports)/.test(value)) return 'activity';
  return 'attraction';
}

function sourcePriority(source) {
  return ({ favorite: 5, saved: 4, history: 3, external: 2, custom: 1 })[source] || 0;
}

export function mergeCandidatePool(...pools) {
  const map = new Map();
  for (const raw of pools.flat()) {
    const candidate = normalizeCandidate(raw);
    if (!candidate) continue;
    const prev = map.get(candidate.key);
    if (!prev) {
      map.set(candidate.key, candidate);
      continue;
    }
    const preferCandidate = sourcePriority(candidate.source) > sourcePriority(prev.source);
    const primary = preferCandidate ? candidate : prev;
    const secondary = preferCandidate ? prev : candidate;
    map.set(candidate.key, normalizeCandidate({
      ...secondary,
      ...primary,
      latitude: primary.latitude ?? secondary.latitude,
      longitude: primary.longitude ?? secondary.longitude,
      address: primary.address || secondary.address,
      googleMapsUrl: primary.googleMapsUrl || secondary.googleMapsUrl,
      rating: primary.rating ?? secondary.rating,
      userRatingCount: primary.userRatingCount ?? secondary.userRatingCount,
      favorite: primary.favorite || secondary.favorite,
      tags: uniq([...(primary.tags || []), ...(secondary.tags || [])])
    }));
  }
  return [...map.values()];
}

export function toggleSelectionOrder(order = [], key, selected) {
  const clean = text(key, 220);
  const next = order.filter(item => item !== clean);
  if (clean && selected) next.push(clean);
  return next;
}

export function selectedCandidates(pool = [], order = []) {
  const byKey = new Map(pool.map(candidate => [candidate.key, candidate]));
  return order.map(key => byKey.get(key)).filter(Boolean);
}

export function queryDisplay(input = {}) {
  const planner = normalizePlannerInput(input);
  return planner.request || [planner.location, planner.anchor, planner.themes.join(' ')].filter(Boolean).join(' ') || '找適合的景點';
}

export const ITINERARY_CANDIDATES = Object.freeze({ model: CANDIDATE_MODEL });
