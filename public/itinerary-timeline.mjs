import {
  SCHEDULE_SCHEMA_VERSION,
  DEFAULT_STOP_DURATION_MINUTES,
  buildRoadTimeline,
  formatMinutes
} from './itinerary-timeline-core.mjs';

const root = document.getElementById('app');

const state = {
  activeTripId: undefined,
  newDraftActive: false,
  durations: new Map(),
  timeline: null,
  error: '',
  armed: false,
  loadedScheduleFor: null,
  persistedSchedule: null,
  planToken: null,
  renderQueued: false
};

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[c]));
}

function clean(value = '') {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
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

function sameKeys(a = [], b = []) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function routePlan() {
  return window.TwinItineraryRoute?.getPlan?.() || null;
}

function routeCurrent(plan = routePlan()) {
  return plan?.current || plan?.actual || null;
}

function routePlanToken(plan = routePlan()) {
  if (!plan) return '';
  return [
    plan.generatedAt || '',
    (plan.requestedStopKeys || []).join('|'),
    Number(routeCurrent(plan)?.totalDurationSeconds) || 0
  ].join('::');
}

function departureTimeFromScreen() {
  const text = arrangeScreen()?.querySelector('.it2-fixed-stop strong')?.textContent || '';
  return text.match(/(\d{1,2}:\d{2})/)?.[1] || '09:00';
}

async function currentStoredTrip() {
  if (!state.activeTripId || !window.TwinDB) return null;
  return TwinDB.get('itineraries', state.activeTripId).catch(() => null);
}

function scheduleByKey(saved = null) {
  const map = new Map();
  for (const stop of Array.isArray(saved?.stops) ? saved.stops : []) {
    if (!stop?.key) continue;
    const duration = Number(stop.durationMinutes);
    if (Number.isFinite(duration) && duration >= 0) map.set(String(stop.key), duration);
  }
  return map;
}

async function hydratePersistedSchedule() {
  if (!state.activeTripId || state.newDraftActive || state.loadedScheduleFor === state.activeTripId) return;
  state.loadedScheduleFor = state.activeTripId;
  const trip = await currentStoredTrip();
  const saved = trip?.schedulePlan;
  if (Number(saved?.schemaVersion) === SCHEDULE_SCHEMA_VERSION && saved?.provider === 'google-routes') {
    state.persistedSchedule = structuredClone(saved);
    state.durations = scheduleByKey(saved);
    state.armed = true;
    return;
  }
  state.persistedSchedule = null;
  for (const [index, stop] of (trip?.stops || []).entries()) {
    const duration = Number(stop?.plannedDurationMinutes);
    if (Number.isFinite(duration) && duration >= 0) state.durations.set(stableStopKey(stop, index), duration);
  }
}

function ensureDurations(keys = []) {
  for (const key of keys) {
    if (!state.durations.has(key)) state.durations.set(key, DEFAULT_STOP_DURATION_MINUTES);
  }
}

function syncPlanLifecycle(plan) {
  const token = routePlanToken(plan);
  if (!token || token === state.planToken) return;
  const keys = Array.isArray(plan?.requestedStopKeys) ? plan.requestedStopKeys.map(String) : [];
  const persistedMatches = Boolean(
    state.persistedSchedule
    && state.persistedSchedule.routeGeneratedAt === plan.generatedAt
    && sameKeys(state.persistedSchedule.stopKeys || [], keys)
  );
  state.armed = persistedMatches;
  state.planToken = token;
}

function recomputeTimeline() {
  const plan = routePlan();
  const current = routeCurrent(plan);
  if (!plan || !current) {
    state.timeline = null;
    state.error = '';
    return null;
  }

  syncPlanLifecycle(plan);
  const keys = Array.isArray(plan.requestedStopKeys) ? plan.requestedStopKeys.map(String) : [];
  const rows = stopRows();
  if (!keys.length || keys.length !== rows.length) {
    state.timeline = null;
    state.error = '目前道路結果與行程地點不一致，請重新計算道路車程。';
    return null;
  }
  ensureDurations(keys);
  const built = buildRoadTimeline({
    departureTime: departureTimeFromScreen(),
    stopKeys: keys,
    durationsMinutes: keys.map(key => state.durations.get(key)),
    route: current
  });
  if (built.error) {
    state.timeline = null;
    state.error = '目前無法建立完整時間軸，請重新計算道路車程。';
    return null;
  }
  state.error = '';
  state.timeline = {
    ...built,
    signature: domSignature(),
    routeGeneratedAt: plan.generatedAt || '',
    routeTotalDurationSeconds: Number(current.totalDurationSeconds) || 0,
    stopKeys: keys
  };
  return state.timeline;
}

function timelineCardHtml(plan, timeline) {
  if (!plan || !timeline) {
    return `<div class="j2c-timeline-card" id="j2cTimelineCard" data-j2c-signature="empty">
      <div class="j2c-timeline-head"><div><strong>🕒 行程時間軸</strong><small>先完成上方「道路車程與順遊」計算，再把道路時間與停留時間串成整日行程。</small></div></div>
      ${state.error ? `<div class="j2c-timeline-error">${esc(state.error)}</div>` : ''}
      <div class="j2c-timeline-helper">不會自動寫入時間；道路結果準備好後才會產生時間軸預覽。</div>
    </div>`;
  }

  const status = state.armed
    ? '<div class="j2c-timeline-status success">已套用到行程草稿；按「完成行程／儲存修改」才會正式保存。</div>'
    : '<div class="j2c-timeline-status">先預覽，不會自動修改行程時間。</div>';
  const signature = [timeline.returnLabel, timeline.roadMinutes, timeline.dwellMinutes, timeline.totalMinutes, state.armed].join('|');
  return `<div class="j2c-timeline-card" id="j2cTimelineCard" data-j2c-signature="${esc(signature)}">
    <div class="j2c-timeline-head"><div><strong>🕒 行程時間軸</strong><small>出發時間＋Google Routes 道路車程＋各站停留時間</small></div></div>
    <div class="j2c-timeline-metrics">
      <div><span>預計回家</span><strong>${esc(timeline.returnLabel)}</strong></div>
      <div><span>整趟時間</span><strong>${esc(formatMinutes(timeline.totalMinutes))}</strong></div>
      <div><span>道路移動</span><strong>${esc(formatMinutes(timeline.roadMinutes))}</strong></div>
      <div><span>景點停留</span><strong>${esc(formatMinutes(timeline.dwellMinutes))}</strong></div>
    </div>
    ${status}
    ${state.error ? `<div class="j2c-timeline-error">${esc(state.error)}</div>` : ''}
    <div class="j2c-timeline-actions">
      ${state.armed ? '<span class="j2c-applied">✓ 時間軸已套用</span>' : '<button class="it2-btn it2-btn-primary" data-j2c-apply>套用此時間軸</button>'}
    </div>
    <div class="j2c-timeline-helper">每站預設停留 90 分，可直接修改。道路車程仍採非即時壅塞估算；不含營業時間、排隊與臨時交通事件。</div>
  </div>`;
}

function placeCard(html) {
  const screen = arrangeScreen();
  if (!screen) return;
  const routeCard = screen.querySelector('#j2b2RouteCard');
  const timeline = screen.querySelector('.it2-timeline');
  let card = screen.querySelector('#j2cTimelineCard');
  const wantedSignature = html.match(/data-j2c-signature="([^"]*)"/)?.[1] || '';
  if (!card) {
    if (routeCard) routeCard.insertAdjacentHTML('afterend', html);
    else if (timeline) timeline.insertAdjacentHTML('beforebegin', html);
    card = screen.querySelector('#j2cTimelineCard');
  } else if (card.dataset.j2cSignature !== wantedSignature) {
    card.outerHTML = html;
    card = screen.querySelector('#j2cTimelineCard');
  }
  if (routeCard && card && routeCard.nextElementSibling !== card) routeCard.after(card);
}

function clearStopDecorations() {
  arrangeScreen()?.querySelectorAll('.j2c-stop-schedule').forEach(node => node.remove());
  arrangeScreen()?.querySelectorAll('.j2c-return-time').forEach(node => node.remove());
}

function decorateStops(plan, timeline) {
  if (!plan || !timeline || timeline.signature !== domSignature()) {
    clearStopDecorations();
    return;
  }
  const keys = plan.requestedStopKeys || [];
  const rows = stopRows();
  rows.forEach((row, index) => {
    const item = timeline.stops[index];
    const key = keys[index];
    const copy = row.querySelector('.it2-stop-copy');
    if (!copy || !item || !key) return;
    let box = copy.querySelector('.j2c-stop-schedule');
    if (!box || box.dataset.j2cKey !== String(key)) {
      box?.remove();
      copy.insertAdjacentHTML('beforeend', `<div class="j2c-stop-schedule" data-j2c-key="${esc(key)}">
        <span data-j2c-arrival></span>
        <label>停留 <input data-j2c-duration data-key="${esc(key)}" type="number" min="0" max="1440" step="15" inputmode="numeric" /> 分</label>
        <span data-j2c-departure></span>
      </div>`);
      box = copy.querySelector('.j2c-stop-schedule');
    }
    box.querySelector('[data-j2c-arrival]').textContent = `${item.arrivalLabel} 到達`;
    box.querySelector('[data-j2c-departure]').textContent = `${item.departureLabel} 離開`;
    const input = box.querySelector('[data-j2c-duration]');
    if (document.activeElement !== input) input.value = String(item.durationMinutes);
  });

  const fixed = [...arrangeScreen().querySelectorAll('.it2-fixed-stop')];
  const last = fixed.at(-1)?.querySelector('div');
  if (last) {
    let node = last.querySelector('.j2c-return-time');
    if (!node) {
      last.insertAdjacentHTML('beforeend', '<small class="j2c-return-time"></small>');
      node = last.querySelector('.j2c-return-time');
    }
    node.textContent = `🕒 預計 ${timeline.returnLabel} 回家`;
  }
}

async function decorateArrange() {
  if (!arrangeScreen()) return;
  await hydratePersistedSchedule();
  const plan = routePlan();
  const timeline = recomputeTimeline();
  placeCard(timelineCardHtml(plan, timeline));
  decorateStops(plan, timeline);
}

function queueDecorate() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    if (arrangeScreen()) void decorateArrange();
    else if (root?.querySelector('[data-it2-screen="list"]')) {
      state.timeline = null;
      state.error = '';
      state.planToken = null;
    }
  });
}

function schedulePlanForSave(value = {}) {
  const plan = routePlan();
  const timeline = state.timeline;
  if (!state.armed || !plan || !timeline || !arrangeScreen() || timeline.signature !== domSignature()) return null;
  const stops = Array.isArray(value.stops) ? value.stops : [];
  const requestKeys = Array.isArray(plan.requestedStopKeys) ? plan.requestedStopKeys : [];
  if (stops.length !== requestKeys.length || stops.length !== timeline.stops.length) return null;

  const stableKeys = stops.map(stableStopKey);
  const scheduledStops = timeline.stops.map((item, index) => ({
    key: stableKeys[index],
    durationMinutes: item.durationMinutes,
    arrivalTime: item.arrivalClock,
    arrivalDayOffset: item.arrivalDayOffset,
    departureTime: item.departureClock,
    departureDayOffset: item.departureDayOffset
  }));

  return {
    nextStops: stops.map((stop, index) => ({
      ...stop,
      plannedTime: timeline.stops[index].arrivalClock,
      plannedDurationMinutes: timeline.stops[index].durationMinutes
    })),
    schedulePlan: {
      schemaVersion: SCHEDULE_SCHEMA_VERSION,
      provider: 'google-routes',
      source: 'road-time+manual-dwell',
      routeGeneratedAt: plan.generatedAt || timeline.routeGeneratedAt || '',
      routeTotalDurationSeconds: Number(routeCurrent(plan)?.totalDurationSeconds) || 0,
      departureTime: value.departureTime || timeline.departureTime,
      stopKeys: stableKeys,
      stops: scheduledStops,
      returnTime: timeline.returnClock,
      returnDayOffset: timeline.returnDayOffset,
      roadMinutes: timeline.roadMinutes,
      dwellMinutes: timeline.dwellMinutes,
      totalMinutes: timeline.totalMinutes,
      applied: true,
      generatedAt: new Date().toISOString()
    }
  };
}

async function preservePersistedScheduleIfSafe(value = {}) {
  if (!state.activeTripId || !state.persistedSchedule || routePlan()) return null;
  const stableKeys = (value.stops || []).map(stableStopKey);
  if (!sameKeys(stableKeys, state.persistedSchedule.stopKeys || [])) return null;
  if (String(value.departureTime || '') !== String(state.persistedSchedule.departureTime || '')) return null;
  const stored = await currentStoredTrip();
  if (!stored?.schedulePlan) return null;
  return {
    ...value,
    scheduleSchemaVersion: SCHEDULE_SCHEMA_VERSION,
    schedulePlan: stored.schedulePlan,
    stops: (value.stops || []).map((stop, index) => ({
      ...stop,
      plannedTime: stored.stops?.[index]?.plannedTime || stop.plannedTime || '',
      plannedDurationMinutes: stored.schedulePlan?.stops?.[index]?.durationMinutes ?? stop.plannedDurationMinutes ?? null
    }))
  };
}

function patchItineraryPersistence() {
  if (!window.TwinDB?.put || TwinDB.__j2cTimelinePatched) return;
  const originalPut = TwinDB.put.bind(TwinDB);
  TwinDB.put = async (store, value) => {
    if (store === 'itineraries' && value?.model === 'itinerary-v2') {
      if (arrangeScreen()) {
        const built = schedulePlanForSave(value);
        if (built) {
          return originalPut(store, {
            ...value,
            scheduleSchemaVersion: SCHEDULE_SCHEMA_VERSION,
            stops: built.nextStops,
            schedulePlan: built.schedulePlan
          });
        }
        const preserved = await preservePersistedScheduleIfSafe(value);
        if (preserved) return originalPut(store, preserved);
        return originalPut(store, {
          ...value,
          scheduleSchemaVersion: null
        });
      }

      const stored = value?.id ? await TwinDB.get('itineraries', value.id).catch(() => null) : null;
      if (stored?.schedulePlan && value.schedulePlan === undefined) {
        return originalPut(store, {
          ...value,
          scheduleSchemaVersion: stored.scheduleSchemaVersion,
          schedulePlan: stored.schedulePlan
        });
      }
    }
    return originalPut(store, value);
  };
  TwinDB.__j2cTimelinePatched = true;
}

const observer = new MutationObserver(() => queueDecorate());
if (root) observer.observe(root, { childList: true, subtree: true });

document.addEventListener('change', event => {
  const input = event.target.closest?.('[data-j2c-duration]');
  if (!input) return;
  const key = String(input.dataset.key || '');
  const value = Number(input.value);
  if (!key || !Number.isFinite(value) || value < 0) return;
  state.durations.set(key, Math.min(1440, Math.round(value)));
  recomputeTimeline();
  queueDecorate();
}, true);

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;

  if (button.matches('[data-j2c-apply]')) {
    event.preventDefault();
    event.stopPropagation();
    if (state.timeline && routePlan()) {
      state.armed = true;
      state.persistedSchedule = null;
      void decorateArrange();
    }
    return;
  }

  if (button.matches('[data-j2b2-calc], [data-j2b2-apply], [data-it2-move], [data-it2-remove], [data-it2-back-pick], [data-it2-edit-basic]')) {
    state.armed = false;
    state.timeline = null;
    state.planToken = null;
    state.persistedSchedule = null;
    queueDecorate();
  }

  if (button.matches('[data-it2-new]')) {
    state.activeTripId = undefined;
    state.newDraftActive = true;
    state.durations = new Map();
    state.timeline = null;
    state.armed = false;
    state.loadedScheduleFor = null;
    state.persistedSchedule = null;
    state.planToken = null;
    return;
  }
  if (button.matches('[data-it2-open]')) {
    state.activeTripId = button.dataset.it2Open;
    state.newDraftActive = false;
    state.durations = new Map();
    state.timeline = null;
    state.armed = false;
    state.loadedScheduleFor = null;
    state.persistedSchedule = null;
    state.planToken = null;
    queueDecorate();
    return;
  }
  if (button.matches('[data-it2-back-list]')) {
    state.activeTripId = undefined;
    state.newDraftActive = false;
    state.timeline = null;
    state.armed = false;
    state.loadedScheduleFor = null;
    state.persistedSchedule = null;
    state.planToken = null;
  }
}, true);

patchItineraryPersistence();
queueDecorate();

window.TwinItineraryTimeline = Object.freeze({
  version: 'J2C-1',
  getTimeline: () => state.timeline ? structuredClone(state.timeline) : null,
  isApplied: () => state.armed
});