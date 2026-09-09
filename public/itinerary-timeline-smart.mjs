import { suggestStopDurationMinutes, suggestionReason } from './itinerary-duration-core.mjs';

const root = document.getElementById('app');
const metadataByKey = new Map();
const persistedDurationByKey = new Map();
const userTouchedKeys = new Set();
let activeTripId = null;
let loadToken = 0;
let queued = false;

function clean(value = '') {
  return String(value ?? '').normalize('NFKC').trim();
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

function typeFromIcon(text = '') {
  if (text.includes('🍽')) return 'restaurant';
  if (text.includes('🏨')) return 'hotel';
  if (text.includes('🎈')) return 'activity';
  return 'attraction';
}

function scanCandidateMetadata() {
  document.querySelectorAll('.it2-place-row[data-it2-candidate]').forEach(row => {
    const key = clean(row.dataset.it2Candidate);
    if (!key) return;
    const title = clean(row.querySelector('.it2-place-copy strong')?.textContent);
    const icon = clean(row.querySelector('.it2-place-icon')?.textContent);
    metadataByKey.set(key, {
      ...(metadataByKey.get(key) || {}),
      key,
      title,
      entityType: typeFromIcon(icon)
    });
  });
}

async function hydrateTripMetadata(id) {
  const token = ++loadToken;
  persistedDurationByKey.clear();
  if (!id || !window.TwinDB) {
    queueRefresh();
    return;
  }
  const trip = await TwinDB.get('itineraries', id).catch(() => null);
  if (token !== loadToken || !trip) return;

  const scheduleStops = Array.isArray(trip.schedulePlan?.stops) ? trip.schedulePlan.stops : [];
  for (const row of scheduleStops) {
    const key = clean(row?.key);
    const duration = Number(row?.durationMinutes);
    if (key && Number.isFinite(duration) && duration >= 0) persistedDurationByKey.set(key, Math.round(duration));
  }

  for (const [index, stop] of (trip.stops || []).entries()) {
    const key = stableStopKey(stop, index);
    if (!key) continue;
    metadataByKey.set(key, {
      ...(metadataByKey.get(key) || {}),
      key,
      title: clean(stop.title),
      entityType: stop.entityType || 'attraction',
      primaryType: stop.primaryType || ''
    });
    const duration = Number(stop.plannedDurationMinutes);
    if (!persistedDurationByKey.has(key) && Number.isFinite(duration) && duration >= 0) {
      persistedDurationByKey.set(key, Math.round(duration));
    }
  }
  queueRefresh();
}

function stopTitleFromInput(input) {
  return clean(input.closest('.it2-stop-row')?.querySelector('.it2-stop-copy strong')?.textContent);
}

function setDuration(input, value, reason) {
  const next = Math.max(0, Math.min(1440, Math.round(Number(value) || 0)));
  const current = Number(input.value);
  if (current !== next) {
    input.value = String(next);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  input.dataset.j2cSmartSuggested = String(next);
  input.setAttribute('aria-label', `停留時間，${reason}，可手動修改`);
  input.title = `${reason}，可手動修改`;
}

function applyDurationSuggestions() {
  document.querySelectorAll('[data-j2c-duration]').forEach(input => {
    const key = clean(input.dataset.key);
    if (!key || userTouchedKeys.has(key)) return;

    if (persistedDurationByKey.has(key)) {
      setDuration(input, persistedDurationByKey.get(key), '使用已儲存時間');
      return;
    }

    const meta = metadataByKey.get(key) || {};
    const title = meta.title || stopTitleFromInput(input);
    const suggestionInput = {
      ...meta,
      title,
      entityType: meta.entityType || 'attraction'
    };
    const duration = suggestStopDurationMinutes(suggestionInput);
    setDuration(input, duration, suggestionReason(suggestionInput));
  });
}

function rewriteTimelineCopy() {
  const card = document.getElementById('j2cTimelineCard');
  if (!card) return;
  const status = card.querySelector('.j2c-timeline-status:not(.success)');
  const statusText = '可先調整；按「套用此時間軸」或直接「儲存修改／完成行程」才會保存。';
  if (status && status.textContent !== statusText) status.textContent = statusText;

  const helper = card.querySelector('.j2c-timeline-helper');
  const helperText = '停留時間會依景點／餐廳／活動類型給建議值，可手動修改。道路車程仍採非即時壅塞估算；不含營業時間、排隊與臨時交通事件。';
  if (helper && helper.textContent.includes('每站預設停留 90 分') && helper.textContent !== helperText) {
    helper.textContent = helperText;
  }
}

function refresh() {
  scanCandidateMetadata();
  applyDurationSuggestions();
  rewriteTimelineCopy();
}

function queueRefresh() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    refresh();
  });
}

const observer = new MutationObserver(queueRefresh);
if (root) observer.observe(root, { childList: true, subtree: true });

document.addEventListener('input', event => {
  const input = event.target?.closest?.('[data-j2c-duration]');
  if (!input) return;
  const key = clean(input.dataset.key);
  if (key) userTouchedKeys.add(key);
}, true);

document.addEventListener('click', event => {
  const button = event.target?.closest?.('button');
  if (!button) return;

  if (button.matches('[data-it2-open]')) {
    activeTripId = clean(button.dataset.it2Open) || null;
    userTouchedKeys.clear();
    void hydrateTripMetadata(activeTripId);
    return;
  }
  if (button.matches('[data-it2-new]')) {
    activeTripId = null;
    persistedDurationByKey.clear();
    metadataByKey.clear();
    userTouchedKeys.clear();
    loadToken += 1;
    return;
  }
  if (button.matches('[data-it2-back-list]')) {
    activeTripId = null;
    persistedDurationByKey.clear();
    userTouchedKeys.clear();
    loadToken += 1;
  }
}, true);

queueRefresh();

window.TwinItineraryDurationSmart = Object.freeze({
  version: 'J2C-1.2',
  suggestStopDurationMinutes
});
