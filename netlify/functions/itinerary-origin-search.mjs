function getApiKey() {
  return process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
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

function clean(value = '', max = 180) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, max);
}

function normalizeQuery(value = '') {
  const query = clean(value, 180);
  if (!query) return '';
  return /(?:台灣|臺灣|Taiwan)/i.test(query) ? query : `${query} 台灣`;
}

function mapCandidate(place = {}, rank = 0) {
  const latitude = Number(place.location?.latitude);
  const longitude = Number(place.location?.longitude);
  return {
    placeId: String(place.id || ''),
    displayName: clean(place.displayName?.text || '', 120),
    address: clean(place.formattedAddress || '', 220),
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    googleMapsUrl: String(place.googleMapsUri || ''),
    primaryType: String(place.primaryType || ''),
    rank
  };
}

async function searchText(apiKey, textQuery) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': [
          'places.id', 'places.displayName', 'places.formattedAddress',
          'places.location', 'places.googleMapsUri', 'places.primaryType'
        ].join(',')
      },
      body: JSON.stringify({ textQuery, languageCode: 'zh-TW', regionCode: 'TW' })
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1200);
      const error = new Error('google_places_error');
      error.status = response.status;
      error.detail = detail;
      throw error;
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

export default async req => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const apiKey = getApiKey();
  if (!apiKey) return json({ error: 'not_configured', message: 'GOOGLE_PLACES_API_KEY 尚未設定' }, 503);

  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'invalid_json' }, 400); }

  const query = clean(body?.query, 180);
  if (query.length < 2) return json({ error: 'query_required' }, 400);
  const textQuery = normalizeQuery(query);

  try {
    const result = await searchText(apiKey, textQuery);
    const seen = new Set();
    const candidates = [];
    for (const place of result.places || []) {
      if (!place?.id || seen.has(place.id)) continue;
      seen.add(place.id);
      const candidate = mapCandidate(place, candidates.length);
      if (!candidate.placeId || !candidate.address || candidate.latitude === null || candidate.longitude === null) continue;
      candidates.push(candidate);
      if (candidates.length >= 6) break;
    }
    return json({
      provider: 'google-places',
      query,
      textQuery,
      candidates
    });
  } catch (error) {
    console.error('[itinerary-origin-search] provider error', { status: error.status || 502, detail: error.detail || String(error) });
    return json({ error: 'origin_provider_error', status: error.status || 502, detail: error.detail || '' }, 502);
  }
};

export const __test = { clean, normalizeQuery, mapCandidate };
export const config = { path: '/api/itinerary-origin-search', rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
