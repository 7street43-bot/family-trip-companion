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

function clean(value = '', max = 240) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, max);
}

function themes(value) {
  const rows = Array.isArray(value) ? value : String(value || '').split(/[,，、\n]/);
  return [...new Set(rows.map(v => clean(v, 30)).filter(Boolean))].slice(0, 8);
}

function normalizeInput(body = {}) {
  return {
    request: clean(body.request, 500),
    location: clean(body.location, 80),
    anchor: clean(body.anchor, 120),
    themes: themes(body.themes),
    entityType: ['attraction', 'restaurant', 'hotel', 'activity'].includes(body.entityType) ? body.entityType : 'attraction',
    limit: Math.max(3, Math.min(20, Number(body.limit) || 12))
  };
}

function buildQueryPlan(raw = {}) {
  const input = normalizeInput(raw);
  const queries = [];
  const add = value => {
    const q = clean(value, 500).replace(/\s+/g, ' ');
    if (q && !queries.includes(q)) queries.push(q);
  };
  const themeText = input.themes.join(' ');

  if (input.request) add([input.request, input.location].filter(Boolean).join(' '));
  if (input.anchor) add([input.anchor, '附近', themeText || '景點', input.location].filter(Boolean).join(' '));
  if (input.location && themeText) add([input.location, themeText, '景點'].join(' '));
  if (input.location && !input.request && !input.anchor && !themeText) add(`${input.location} 景點`);
  if (!input.location && themeText) add(`${themeText} 台灣 景點`);

  return { input, queries: queries.slice(0, 4) };
}

function mapEntityType(primaryType = '', types = []) {
  const text = [primaryType, ...(Array.isArray(types) ? types : [])].join(' ');
  if (/(restaurant|cafe|bakery|food|meal)/.test(text)) return 'restaurant';
  if (/(hotel|lodging|motel|hostel|resort|campground|guest_house)/.test(text)) return 'hotel';
  if (/(amusement|playground|activity|sports|aquarium|zoo)/.test(text)) return 'activity';
  return 'attraction';
}

function extractAdmin(place = {}) {
  const components = Array.isArray(place.addressComponents) ? place.addressComponents : [];
  const byType = type => components.find(c => Array.isArray(c.types) && c.types.includes(type));
  const address = String(place.formattedAddress || '').replace(/臺/g, '台');
  const countyMatch = address.match(/(基隆市|台北市|新北市|桃園市|新竹市|新竹縣|宜蘭縣|苗栗縣|台中市|彰化縣|南投縣|雲林縣|嘉義市|嘉義縣|台南市|高雄市|屏東縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)/);
  let county = clean(byType('administrative_area_level_1')?.longText || byType('locality')?.longText, 40).replace(/臺/g, '台');
  if (!/(縣|市)$/.test(county) || county === '台灣') county = countyMatch?.[1] || '';
  let district = clean(byType('sublocality_level_1')?.longText || byType('administrative_area_level_2')?.longText, 40).replace(/臺/g, '台');
  if (!/(區|鄉|鎮|市)$/.test(district) && county && address.includes(county)) {
    const tail = address.slice(address.indexOf(county) + county.length);
    district = tail.match(/^([^0-9\s]{1,8}(?:區|鄉|鎮|市))/)?.[1] || district;
  }
  return { county, district };
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
          'places.id', 'places.displayName', 'places.formattedAddress', 'places.addressComponents',
          'places.location', 'places.googleMapsUri', 'places.primaryType', 'places.primaryTypeDisplayName',
          'places.types', 'places.rating', 'places.userRatingCount', 'places.businessStatus',
          'places.currentOpeningHours', 'places.regularOpeningHours'
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

function relevanceScore(place, queryIndex) {
  const rating = Number(place.rating) || 0;
  const reviews = Number(place.userRatingCount) || 0;
  const operational = place.businessStatus === 'OPERATIONAL' ? 3 : 0;
  const openNow = place.currentOpeningHours?.openNow === true ? 2 : 0;
  return Math.round((100 - queryIndex * 9) + rating * 2 + Math.min(12, Math.log10(reviews + 1) * 4) + operational + openNow);
}

function mapCandidate(place = {}, sourceQuery = '', queryIndex = 0, sourceRank = 0) {
  const admin = extractAdmin(place);
  return {
    placeId: place.id || '',
    title: place.displayName?.text || '',
    formattedAddress: place.formattedAddress || '',
    county: admin.county,
    district: admin.district,
    latitude: place.location?.latitude ?? null,
    longitude: place.location?.longitude ?? null,
    googleMapsUrl: place.googleMapsUri || '',
    primaryType: place.primaryType || '',
    primaryTypeLabel: place.primaryTypeDisplayName?.text || '',
    entityType: mapEntityType(place.primaryType, place.types),
    types: Array.isArray(place.types) ? place.types : [],
    rating: Number.isFinite(place.rating) ? place.rating : null,
    userRatingCount: Number.isFinite(place.userRatingCount) ? place.userRatingCount : null,
    businessStatus: place.businessStatus || '',
    openNow: typeof place.currentOpeningHours?.openNow === 'boolean' ? place.currentOpeningHours.openNow : null,
    sourceQuery,
    sourceRank,
    queryIndex,
    relevanceScore: relevanceScore(place, queryIndex)
  };
}

function mergeResults(groups = [], limit = 12) {
  const byId = new Map();
  for (const group of groups) {
    for (const candidate of group) {
      if (!candidate.placeId || !candidate.title) continue;
      const previous = byId.get(candidate.placeId);
      if (!previous || candidate.relevanceScore > previous.relevanceScore) {
        byId.set(candidate.placeId, {
          ...(previous || {}),
          ...candidate,
          matchedQueries: [...new Set([...(previous?.matchedQueries || []), candidate.sourceQuery])]
        });
      } else {
        previous.matchedQueries = [...new Set([...(previous.matchedQueries || []), candidate.sourceQuery])];
      }
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.relevanceScore - a.relevanceScore || (b.userRatingCount || 0) - (a.userRatingCount || 0))
    .slice(0, limit);
}

export default async req => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const apiKey = getApiKey();
  if (!apiKey) return json({ error: 'not_configured', message: 'GOOGLE_PLACES_API_KEY 尚未設定' }, 503);

  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'invalid_json' }, 400); }

  const plan = buildQueryPlan(body);
  if (!plan.queries.length) return json({ error: 'planner_input_required' }, 400);

  try {
    const groups = [];
    for (let i = 0; i < plan.queries.length; i++) {
      const query = plan.queries[i];
      const result = await searchText(apiKey, query);
      groups.push((result.places || []).slice(0, 10).map((place, rank) => mapCandidate(place, query, i, rank)));
    }
    const candidates = mergeResults(groups, plan.input.limit);
    return json({
      planner: {
        version: 'candidate-planner-v1',
        strategy: 'places-query-expansion',
        aiAdapterReady: true
      },
      input: plan.input,
      queriesTried: plan.queries,
      candidates
    });
  } catch (error) {
    console.error('[itinerary-candidates] provider error', { status: error.status || 502, detail: error.detail || String(error) });
    return json({ error: 'candidate_provider_error', status: error.status || 502, detail: error.detail || '' }, 502);
  }
};

export const __test = { normalizeInput, buildQueryPlan, mapEntityType, extractAdmin, relevanceScore, mapCandidate, mergeResults };
export const config = { path: '/api/itinerary-candidates', rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
