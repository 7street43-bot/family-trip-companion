function getApiKey() {
  return process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
}

function json(body, status=200) {
  return new Response(JSON.stringify(body), {
    status,
    headers:{
      'content-type':'application/json; charset=utf-8',
      'cache-control':'no-store'
    }
  });
}

export default async (req) => {
  if (req.method !== 'GET') return json({ error:'method_not_allowed' },405);
  const apiKey = getApiKey();
  if (!apiKey) return json({ error:'not_configured', message:'GOOGLE_PLACES_API_KEY 尚未設定（亦支援舊名 GOOGLE_MAPS_API_KEY）' },503);

  const url = new URL(req.url);
  const placeId = String(url.searchParams.get('placeId') || '').trim();
  const requestedWidth = Math.max(200, Math.min(1200, Number(url.searchParams.get('w') || 800)));
  if (!/^ChI|^[A-Za-z0-9_-]{10,}$/.test(placeId)) return json({ error:'invalid_place_id' },400);

  const details = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers:{
      'X-Goog-Api-Key':apiKey,
      'X-Goog-FieldMask':'photos'
    }
  });
  if (!details.ok) {
    const detail = await details.text();
    console.error('[place-photo] Place details upstream error', { status:details.status, placeId, detail:detail.slice(0,1200) });
    return json({ error:'place_details_error', status:details.status, detail:detail.slice(0,1200) },502);
  }
  const place = await details.json();
  const photo = Array.isArray(place.photos) ? place.photos[0] : null;
  if (!photo?.name) return json({ error:'no_photo' },404);

  const mediaUrl = `https://places.googleapis.com/v1/${photo.name}/media?maxWidthPx=${requestedWidth}&skipHttpRedirect=true&key=${encodeURIComponent(apiKey)}`;
  const media = await fetch(mediaUrl, { headers:{ 'accept':'application/json' } });
  if (!media.ok) {
    const detail = await media.text();
    console.error('[place-photo] Photo media upstream error', { status:media.status, placeId, detail:detail.slice(0,1200) });
    return json({ error:'photo_media_error', status:media.status, detail:detail.slice(0,1200) },502);
  }
  const out = await media.json();
  if (!out.photoUri) return json({ error:'photo_uri_missing' },502);

  const attributions = (photo.authorAttributions || []).map(a => ({
    displayName: a.displayName || '',
    uri: a.uri || '',
    photoUri: a.photoUri || ''
  }));
  return json({ photoUri:out.photoUri, attributions, widthPx:photo.widthPx || null, heightPx:photo.heightPx || null });
};

export const config = { path:'/api/place-photo' };
