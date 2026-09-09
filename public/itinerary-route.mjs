const root = document.getElementById('app');

const state = {
  activeTripId: undefined,
  newDraftActive: false,
  loading: false,
  error: '',
  plan: null,
  applying: false,
  loadedPlanFor: null,
  renderSeq: 0
};

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[c]));
}

function clean(value = '') {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.max(1, Math.round((total % 3600) / 60));
  if (hours) return `${hours} 小時 ${minutes} 分`;
  return `${minutes} 分`;
}

function formatDistance(meters) {
  const value = Math.max(0, Number(meters) || 0);
  if (value >= 10000) return `${Math.round(value / 1000)} km`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} km`;
  return `${Math.round(value)} m`;
}

function arrangeScreen() {
  return root?.querySelector('[data-it2-screen="arrange"]') || null;
}

function stopRows() {
  return [...(arrangeScreen()?.querySelectorAll('.it2-stop-row') || [])];
}

function rowTitle(row) {
  return clean(row?.querySelector('.it2-stop-copy strong')?.textContent || '');
}

function rowAddress(row) {
  const raw = clean(row?.querySelector('.it2-stop-copy small')?.textContent || '');
  if (!raw) return '';
  const parts = raw.split('・').map(clean).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join('・') : '';
}

function domSignature() {
  return stopRows().map(row => `${rowTitle(row)}@@${rowAddress(row)}`).join('||');
}

function stableStopKey(stop = {}, index = 0) {
  return clean(
    stop.candidateKey
    || (stop.entityId ? `entity:${stop.entityId}` : '')
    || (stop.placeId ? `place:${stop.placeId}` : '')
    || stop.id
    || `stop:${index}:${stop.title || ''}`
  );
}

function routableNodeFromStop(stop = {}, fallback = {}, index = 0) {
  const latitude = stop.latitude === null || stop.latitude === undefined || stop.latitude === '' ? NaN : Number(stop.latitude);
  const longitude = stop.longitude === null || stop.longitude === undefined || stop.longitude === '' ? NaN : Number(stop.longitude);
  const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);
  const title = clean(stop.title || fallback.title || `地點 ${index + 1}`);
  const address = clean(stop.address || fallback.address || title);
  return {
    key: clean(fallback.key || stableStopKey(stop, index) || `row:${index}:${title}`),
    title,
    placeId: clean(stop.placeId || '') || null,
    latitude: hasCoordinates ? latitude : null,
    longitude: hasCoordinates ? longitude : null,
    address
  };
}

function routableNodeFromEntity(entity = {}, fallback = {}, index = 0) {
  return routableNodeFromStop({
    id: entity.id,
    entityId: entity.id,
    candidateKey: `entity:${entity.id}`,
    title: entity.name,
    latitude: entity.latitude,
    longitude: entity.longitude,
    address: clean([
      entity.address,
      entity.formattedAddress,
      entity.county || entity.cityRaw,
      entity.district
    ].filter(Boolean).join(' '))
  }, fallback, index);
}

function matchStopToRow(stops = [], row, used = new Set()) {
  const title = rowTitle(row);
  const address = rowAddress(row);
  let best = -1;
  for (let i = 0; i < stops.length; i += 1) {
    if (used.has(i)) continue;
    if (clean(stops[i]?.title) !== title) continue;
    if (address && clean(stops[i]?.address) && address.includes(clean(stops[i].address))) return i;
    if (best < 0) best = i;
  }
  return best;
}

async function currentStoredTrip() {
  if (!state.activeTripId || !window.TwinDB) return null;
  return TwinDB.get('itineraries', state.activeTripId).catch(() => null);
}

async function routingContext() {
  const rows = stopRows();
  if (!rows.length) throw new Error('行程至少需要 1 個地點。');

  const storedTrip = state.newDraftActive ? null : await currentStoredTrip();
  const defaultOrigin = window.TwinItineraryOrigin?.getDefault?.()
    || globalThis.TwinTripDefaultOrigin
    || null;
  const origin = storedTrip?.origin || defaultOrigin;
  const destination = storedTrip?.destination || origin;
  if (!origin) throw new Error('這趟行程沒有實際出發地；請先在右上角設定「家」，再建立新行程。');

  const storedStops = Array.isArray(storedTrip?.stops) ? storedTrip.stops : [];
  const usedStored = new Set();
  const entities = window.TwinDB ? await TwinDB.getAll('entities').catch(() => []) : [];
  const usedEntities = new Set();

  const stops = rows.map((row, index) => {
    const fallback = {
      key: `row:${index}:${rowTitle(row)}:${rowAddress(row)}`,
      title: rowTitle(row),
      address: rowAddress(row)
    };

    if (storedStops.length) {
      const matched = matchStopToRow(storedStops, row, usedStored);
      if (matched >= 0) {
        usedStored.add(matched);
        return routableNodeFromStop(storedStops[matched], {
          ...fallback,
          key: stableStopKey(storedStops[matched], matched)
        }, index);
      }
    }

    const entityIndex = entities.findIndex((entity, i) =>
      !usedEntities.has(i)
      && clean(entity?.name) === fallback.title
      && Number.isFinite(Number(entity?.latitude))
      && Number.isFinite(Number(entity?.longitude))
    );
    if (entityIndex >= 0) {
      usedEntities.add(entityIndex);
      return routableNodeFromEntity(entities[entityIndex], {
        ...fallback,
        key: `entity:${entities[entityIndex].id}`
      }, index);
    }

    return routableNodeFromStop({
      title: fallback.title,
      address: fallback.address || fallback.title
    }, fallback, index);
  });

  return { origin, destination, stops, storedTrip };
}

function orderChanged(plan = state.plan) {
  if (!plan) return false;
  const current = plan.requestedStopKeys || [];
  const suggested = plan.orderedStopKeys || [];
  return current.length === suggested.length && current.some((key, index) => key !== suggested[index]);
}

function routeCardHtml() {
  const year = new Date().getFullYear();
  if (state.loading) {
    return `<div class="j2b2-route-card" id="j2b2RouteCard">
      <div class="j2b2-route-head"><div><strong>🚗 道路順遊</strong><small>正在向 Google Routes 計算實際道路距離與車程…</small></div></div>
      <button class="it2-btn it2-btn-primary it2-btn-block" disabled>計算中…</button>
      <div class="j2b2-google">Powered by Google, ©${year} Google</div>
    </div>`;
  }

  if (!state.plan) {
    return `<div class="j2b2-route-card" id="j2b2RouteCard">
      <div class="j2b2-route-head"><div><strong>🚗 道路順遊</strong><small>按下後才會把這趟起點與地點送到 Google Routes；不會自動改順序。</small></div></div>
      ${state.error ? `<div class="j2b2-route-error">${esc(state.error)}</div>` : ''}
      <button class="it2-btn it2-btn-primary it2-btn-block" data-j2b2-calc>計算道路車程與順遊</button>
      <div class="j2b2-route-helper">J2B-2 使用開車道路估算（非即時壅塞）作為順遊基礎，仍由你決定是否套用。</div>
    </div>`;
  }

  const plan = state.plan;
  const current = plan.current || plan.actual;
  const suggested = plan.suggested || current;
  const savings = Math.max(0, Number(plan.originalSavingsSeconds ?? plan.savingsSeconds) || 0);
  const changed = orderChanged(plan) && !plan.applied;
  const status = plan.applied
    ? `<div class="j2b2-route-status success">已套用建議順序，按「儲存修改／完成行程」才會正式保存。</div>`
    : changed
      ? `<div class="j2b2-route-status">Google 建議可少約 <strong>${esc(formatDuration(savings))}</strong> 的道路移動時間。</div>`
      : `<div class="j2b2-route-status success">目前順序已接近這次道路矩陣的建議順序。</div>`;

  return `<div class="j2b2-route-card" id="j2b2RouteCard">
    <div class="j2b2-route-head"><div><strong>🚗 道路順遊</strong><small>Google Routes｜DRIVE｜TRAFFIC_UNAWARE</small></div></div>
    <div class="j2b2-route-metrics">
      <div><span>目前／套用後</span><strong>${esc(formatDuration(current?.totalDurationSeconds))}</strong><small>${esc(formatDistance(current?.totalDistanceMeters))}</small></div>
      <div><span>建議順序</span><strong>${esc(formatDuration(suggested?.totalDurationSeconds))}</strong><small>${esc(formatDistance(suggested?.totalDistanceMeters))}</small></div>
    </div>
    ${status}
    ${state.error ? `<div class="j2b2-route-error">${esc(state.error)}</div>` : ''}
    <div class="j2b2-route-actions">
      ${changed ? '<button class="it2-btn it2-btn-primary" data-j2b2-apply>套用建議順序</button>' : ''}
      <button class="it2-btn" data-j2b2-calc>重新計算</button>
    </div>
    <div class="j2b2-route-helper">只計道路移動，不含景點停留時間；道路與交通狀況可能改變。</div>
    <div class="j2b2-google">Powered by Google, ©${year} Google</div>
  </div>`;
}

function clearLegDecorations(screen = arrangeScreen()) {
  screen?.querySelectorAll('.j2b2-leg').forEach(node => node.remove());
}

function decorateLegs(screen = arrangeScreen()) {
  clearLegDecorations(screen);
  const plan = state.plan;
  if (!screen || !plan || plan.signature !== domSignature()) return;
  const actual = plan.current || plan.actual;
  const legs = Array.isArray(actual?.legs) ? actual.legs : [];
  if (!legs.length) return;

  const rows = [...screen.querySelectorAll('.it2-stop-row')];
  rows.forEach((row, index) => {
    const leg = legs[index];
    if (!leg) return;
    const copy = row.querySelector('.it2-stop-copy');
    if (copy) copy.insertAdjacentHTML(
      'beforeend',
      `<small class="j2b2-leg">🚗 前一段 ${esc(formatDuration(leg.durationSeconds))}・${esc(formatDistance(leg.distanceMeters))}</small>`
    );
  });

  const fixed = [...screen.querySelectorAll('.it2-fixed-stop')];
  const returnLeg = legs.at(-1);
  if (fixed.length >= 2 && returnLeg) {
    fixed.at(-1)?.querySelector('div')?.insertAdjacentHTML(
      'beforeend',
      `<small class="j2b2-leg">🚗 最後一段 ${esc(formatDuration(returnLeg.durationSeconds))}・${esc(formatDistance(returnLeg.distanceMeters))}</small>`
    );
  }
}

async function hydratePersistedPlan() {
  if (!state.activeTripId || state.newDraftActive || state.loadedPlanFor === state.activeTripId || state.plan) return;
  state.loadedPlanFor = state.activeTripId;
  const trip = await currentStoredTrip();
  const saved = trip?.routePlan;
  if (!saved || Number(saved.schemaVersion) !== 1 || saved.provider !== 'google-routes') return;
  const stopKeys = Array.isArray(saved.stopKeys)
    ? saved.stopKeys
    : (trip.stops || []).map(stableStopKey);
  state.plan = {
    provider: saved.provider,
    matrixVersion: saved.matrixVersion || 1,
    travelMode: saved.travelMode || 'DRIVE',
    routingPreference: saved.routingPreference || 'TRAFFIC_UNAWARE',
    strategy: saved.strategy || 'nearest-neighbor+2opt',
    requestedStopKeys: stopKeys,
    orderedStopKeys: Array.isArray(saved.suggestedStopKeys) ? saved.suggestedStopKeys : stopKeys,
    current: saved.actual || saved.current,
    suggested: saved.suggested || saved.actual || saved.current,
    savingsSeconds: Number(saved.savingsSeconds) || 0,
    originalSavingsSeconds: Number(saved.savingsSeconds) || 0,
    generatedAt: saved.generatedAt,
    applied: Boolean(saved.applied),
    signature: domSignature(),
    persisted: true
  };
}

async function decorateArrange() {
  const screen = arrangeScreen();
  if (!screen) return;
  const seq = ++state.renderSeq;
  await hydratePersistedPlan();
  if (seq !== state.renderSeq || !arrangeScreen()) return;

  let card = screen.querySelector('#j2b2RouteCard');
  const html = routeCardHtml();
  if (card) card.outerHTML = html;
  else {
    const timeline = screen.querySelector('.it2-timeline');
    if (timeline) timeline.insertAdjacentHTML('beforebegin', html);
  }
  decorateLegs(screen);
}

function decorateCurrentScreen() {
  if (arrangeScreen()) {
    void decorateArrange();
    return;
  }
  if (root?.querySelector('[data-it2-screen="list"]')) {
    state.loading = false;
    state.error = '';
    state.plan = null;
    state.loadedPlanFor = null;
  }
}

async function calculateRoute() {
  if (state.loading) return;
  state.loading = true;
  state.error = '';
  state.plan = null;
  await decorateArrange();

  try {
    const context = await routingContext();
    const response = await fetch('/api/itinerary-route-matrix', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        origin: context.origin,
        destination: context.destination,
        stops: context.stops
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || body.error || `道路計算失敗 (${response.status})`);
    if (body.provider !== 'google-routes' || !body.current || !body.suggested) throw new Error('道路計算回傳不完整');

    state.plan = {
      ...body,
      signature: domSignature(),
      applied: false,
      persisted: false,
      originalSavingsSeconds: Number(body.savingsSeconds) || 0
    };
  } catch (error) {
    state.error = `目前無法計算道路順遊：${error.message || '請稍後再試'}`;
  } finally {
    state.loading = false;
    await decorateArrange();
  }
}

async function applySuggestedOrder() {
  const plan = state.plan;
  if (!plan || !orderChanged(plan) || state.applying) return;
  const current = [...plan.requestedStopKeys];
  const desired = [...plan.orderedStopKeys];
  if (current.length !== desired.length || new Set(current).size !== current.length) {
    state.error = '目前地點識別不一致，請重新計算後再套用。';
    return void decorateArrange();
  }

  state.applying = true;
  state.error = '';
  try {
    for (let target = 0; target < desired.length; target += 1) {
      let index = current.indexOf(desired[target]);
      if (index < 0) throw new Error('建議順序與目前地點不一致');
      while (index > target) {
        const button = arrangeScreen()?.querySelector(`[data-it2-move="up"][data-index="${index}"]`);
        if (!button || button.disabled) throw new Error('無法套用建議順序');
        button.click();
        [current[index - 1], current[index]] = [current[index], current[index - 1]];
        index -= 1;
        await Promise.resolve();
      }
    }
    plan.applied = true;
    plan.baseline = plan.current;
    plan.current = plan.suggested;
    plan.requestedStopKeys = [...desired];
    plan.signature = domSignature();
    plan.originalSavingsSeconds = Number(plan.originalSavingsSeconds ?? plan.savingsSeconds) || 0;
    state.plan = plan;
  } catch (error) {
    state.error = error.message || '套用建議順序失敗';
  } finally {
    state.applying = false;
    await decorateArrange();
  }
}

function routePlanForSave(value = {}) {
  const plan = state.plan;
  if (!plan || !arrangeScreen() || plan.signature !== domSignature()) return null;
  const stops = Array.isArray(value.stops) ? value.stops : [];
  if (stops.length !== (plan.requestedStopKeys || []).length) return null;

  const stableKeys = stops.map(stableStopKey);
  const requestKeys = plan.requestedStopKeys || [];
  const mapToStable = new Map(requestKeys.map((key, index) => [key, stableKeys[index]]));
  const suggestedStopKeys = (plan.orderedStopKeys || [])
    .map(key => mapToStable.get(key))
    .filter(Boolean);
  if (suggestedStopKeys.length !== stableKeys.length) return null;

  return {
    schemaVersion: 1,
    provider: 'google-routes',
    matrixVersion: Number(plan.matrixVersion) || 1,
    travelMode: plan.travelMode || 'DRIVE',
    routingPreference: plan.routingPreference || 'TRAFFIC_UNAWARE',
    strategy: plan.strategy || 'nearest-neighbor+2opt',
    generatedAt: plan.generatedAt || new Date().toISOString(),
    savedAt: new Date().toISOString(),
    stopKeys: stableKeys,
    suggestedStopKeys,
    applied: Boolean(plan.applied),
    actual: plan.current || plan.actual,
    suggested: plan.suggested || plan.current || plan.actual,
    savingsSeconds: Number(plan.originalSavingsSeconds ?? plan.savingsSeconds) || 0,
    savingsMeters: Number(plan.savingsMeters) || 0
  };
}

function patchItineraryPersistence() {
  if (!window.TwinDB?.put || TwinDB.__j2b2RoutePatched) return;
  const originalPut = TwinDB.put.bind(TwinDB);
  TwinDB.put = async (store, value) => {
    if (store === 'itineraries' && value?.model === 'itinerary-v2') {
      const routePlan = routePlanForSave(value);
      const next = routePlan ? { ...value, routePlan } : value;
      return originalPut(store, next);
    }
    return originalPut(store, value);
  };
  TwinDB.__j2b2RoutePatched = true;
}

const observer = new MutationObserver(() => decorateCurrentScreen());
if (root) observer.observe(root, { childList: true });

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;

  if (button.matches('[data-j2b2-calc]')) {
    event.preventDefault();
    event.stopPropagation();
    return void calculateRoute();
  }
  if (button.matches('[data-j2b2-apply]')) {
    event.preventDefault();
    event.stopPropagation();
    return void applySuggestedOrder();
  }

  if (button.matches('[data-it2-new]')) {
    state.activeTripId = undefined;
    state.newDraftActive = true;
    state.plan = null;
    state.loadedPlanFor = null;
    return;
  }
  if (button.matches('[data-it2-open]')) {
    state.activeTripId = button.dataset.it2Open;
    state.newDraftActive = false;
    state.plan = null;
    state.loadedPlanFor = null;
    return;
  }
  if (button.matches('[data-it2-back-list]')) {
    state.activeTripId = undefined;
    state.newDraftActive = false;
    state.plan = null;
    state.loadedPlanFor = null;
    return;
  }

  if (!state.applying && button.matches('[data-it2-move], [data-it2-remove], [data-it2-back-pick], [data-it2-edit-basic]')) {
    state.plan = null;
    state.error = '';
  }
}, true);

patchItineraryPersistence();
decorateCurrentScreen();

window.TwinItineraryRoute = Object.freeze({
  version: 'J2B-2',
  calculate: calculateRoute,
  getPlan: () => state.plan ? structuredClone(state.plan) : null
});