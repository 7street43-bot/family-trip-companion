import {
  createTrip,
  withEntities,
  withCustomStop,
  moveStop,
  removeStop,
  splitTrips,
  formatDateLabel,
  isV2Trip
} from './itinerary-v2-core.mjs';

const root = document.getElementById('app');
const nav = document.getElementById('bottomNav');

const ui = {
  screen: 'list',
  trips: [],
  entities: [],
  draft: null,
  selectedIds: new Set(),
  query: '',
  source: 'saved',
  busy: false,
  mounted: false
};

const TYPE_ICON = { attraction: '🌿', hotel: '🏨', restaurant: '🍽', activity: '🎈' };
const TYPE_LABEL = { attraction: '景點', hotel: '住宿', restaurant: '餐廳', activity: '其他' };

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function localToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function loadData() {
  if (!window.TwinDB) throw new Error('TwinDB unavailable');
  const [trips, entities] = await Promise.all([
    TwinDB.getAll('itineraries'),
    TwinDB.getAll('entities')
  ]);
  ui.trips = trips.filter(isV2Trip);
  ui.entities = entities.filter(e => e && e.captureStatus !== 'inbox' && e.name);
}

function setNavActive() {
  if (!nav) return;
  nav.querySelectorAll('.nav-item').forEach(button => {
    const active = button.dataset.view === 'trips';
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

function pageHead(title, subtitle, action = '') {
  return `<div class="it2-head"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${action}</div>`;
}

function tripCard(trip) {
  return `<button class="it2-trip-card" data-it2-open="${esc(trip.id)}">
    <div class="it2-trip-card-main"><strong>${esc(trip.title)}</strong><span>${esc(formatDateLabel(trip.date))}</span></div>
    <div class="it2-trip-card-meta"><span>${trip.stops?.length || 0} 個地點</span><span>›</span></div>
  </button>`;
}

function renderList() {
  const { upcoming, past } = splitTrips(ui.trips);
  return `<section class="it2-page" data-it2-screen="list">
    ${pageHead('我的行程', '選日期、勾地點、排順序，就可以出發。', '<button class="it2-btn it2-btn-primary" data-it2-new>＋ 建立新行程</button>')}
    ${upcoming.length ? `<section class="it2-section"><div class="it2-section-title"><h2>即將出發</h2><span>${upcoming.length} 趟</span></div><div class="it2-trip-list">${upcoming.map(tripCard).join('')}</div></section>` : `
      <div class="it2-empty"><div class="it2-empty-icon">🗓</div><h2>還沒有下一趟行程</h2><p>不用先研究怎麼操作。先選日期，再把想去的地方勾進來。</p><button class="it2-btn it2-btn-primary it2-btn-large" data-it2-new>建立第一個行程</button></div>`}
    ${past.length ? `<section class="it2-section"><div class="it2-section-title"><h2>過去行程</h2><span>${past.length} 趟</span></div><div class="it2-trip-list">${past.map(tripCard).join('')}</div></section>` : ''}
  </section>`;
}

function renderCreate() {
  const draft = ui.draft || createTrip({ date: localToday() });
  ui.draft = draft;
  return `<section class="it2-page it2-flow" data-it2-screen="create">
    <button class="it2-back" data-it2-back-list>‹ 我的行程</button>
    <div class="it2-step">1 / 3</div>
    <h1>哪一天去哪？</h1>
    <p class="it2-lead">先決定日期就好，名稱可以讓 App 自動取。</p>
    <div class="it2-form-card">
      <label><span>日期</span><input id="it2Date" type="date" value="${esc(draft.date)}" /></label>
      <label><span>行程名稱 <small>可不填</small></span><input id="it2Title" type="text" value="${esc(draft.title || '')}" placeholder="例如：宜蘭一日遊" /></label>
      <label><span>預計出發</span><input id="it2Departure" type="time" value="${esc(draft.departureTime || '09:00')}" /></label>
    </div>
    <button class="it2-btn it2-btn-primary it2-btn-block" data-it2-to-pick>下一步：選地點</button>
  </section>`;
}

function filteredEntities() {
  const q = ui.query.trim().toLowerCase();
  let rows = [...ui.entities];
  if (ui.source === 'favorite') rows = rows.filter(e => e.favorite);
  if (q) rows = rows.filter(e => [e.name, e.county, e.district, e.cityRaw, e.note, ...(e.tags || [])].join(' ').toLowerCase().includes(q));
  return rows.sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || String(a.name).localeCompare(String(b.name), 'zh-Hant'));
}

function entityRow(entity) {
  const checked = ui.selectedIds.has(entity.id);
  const location = entity.county || entity.cityRaw || entity.district || '';
  return `<button class="it2-place-row ${checked ? 'selected' : ''}" data-it2-place="${esc(entity.id)}" aria-pressed="${checked}">
    <span class="it2-check">${checked ? '✓' : ''}</span>
    <span class="it2-place-icon">${TYPE_ICON[entity.entityType] || '📍'}</span>
    <span class="it2-place-copy"><strong>${esc(entity.name)}</strong><small>${esc(TYPE_LABEL[entity.entityType] || '地點')}${location ? `・${esc(location)}` : ''}${entity.favorite ? '・♥ 收藏' : ''}</small></span>
  </button>`;
}

function renderPick() {
  const rows = filteredEntities();
  const favoriteCount = ui.entities.filter(e => e.favorite).length;
  return `<section class="it2-page it2-flow it2-pick-page" data-it2-screen="pick">
    <button class="it2-back" data-it2-back-create>‹ 日期</button>
    <div class="it2-step">2 / 3</div>
    <h1>想去哪幾個地方？</h1>
    <p class="it2-lead">直接勾選，可以一次選很多個。</p>
    <div class="it2-source-tabs">
      <button class="${ui.source === 'saved' ? 'active' : ''}" data-it2-source="saved">已收藏資料</button>
      <button class="${ui.source === 'favorite' ? 'active' : ''}" data-it2-source="favorite">♥ 我的最愛 ${favoriteCount ? `(${favoriteCount})` : ''}</button>
    </div>
    <div class="it2-search"><span>⌕</span><input id="it2Search" value="${esc(ui.query)}" placeholder="搜尋景點、餐廳、住宿" /></div>
    <div class="it2-custom-row"><input id="it2Custom" placeholder="沒有收藏？直接輸入地點名稱" /><button class="it2-btn" data-it2-add-custom>＋ 加入</button></div>
    <div class="it2-place-list">${rows.length ? rows.map(entityRow).join('') : '<div class="it2-mini-empty">沒有符合的收藏資料。</div>'}</div>
    <div class="it2-sticky-action"><span>已選 <strong>${ui.selectedIds.size + (ui.draft?.stops?.filter(s => s.kind === 'custom').length || 0)}</strong> 個</span><button class="it2-btn it2-btn-primary" data-it2-to-arrange>下一步：排順序</button></div>
  </section>`;
}

function stopRow(stop, index, total) {
  return `<div class="it2-stop-row">
    <div class="it2-stop-index">${index + 1}</div>
    <div class="it2-stop-copy"><strong>${esc(stop.title)}</strong><small>${esc(TYPE_LABEL[stop.entityType] || (stop.kind === 'custom' ? '自訂地點' : '地點'))}</small></div>
    <div class="it2-stop-actions">
      <button data-it2-move="up" data-index="${index}" aria-label="往上" ${index === 0 ? 'disabled' : ''}>↑</button>
      <button data-it2-move="down" data-index="${index}" aria-label="往下" ${index === total - 1 ? 'disabled' : ''}>↓</button>
      <button data-it2-remove data-index="${index}" aria-label="刪除">×</button>
    </div>
  </div>`;
}

function renderArrange() {
  const trip = ui.draft;
  return `<section class="it2-page it2-flow" data-it2-screen="arrange">
    <button class="it2-back" data-it2-back-pick>‹ 選地點</button>
    <div class="it2-step">3 / 3</div>
    <div class="it2-builder-head"><div><h1>${esc(trip.title)}</h1><p>${esc(formatDateLabel(trip.date))}</p></div><button class="it2-btn" data-it2-edit-basic>修改日期</button></div>
    <div class="it2-timeline">
      <div class="it2-fixed-stop"><span class="it2-stop-index">⌂</span><div><strong>${esc(trip.departureTime || '09:00')} 出發</strong><small>從家裡開始</small></div></div>
      <div class="it2-stop-list">${trip.stops.length ? trip.stops.map((s, i) => stopRow(s, i, trip.stops.length)).join('') : '<div class="it2-mini-empty">還沒有地點，回上一步選幾個。</div>'}</div>
      <div class="it2-fixed-stop"><span class="it2-stop-index">⌂</span><div><strong>回家</strong><small>最後一站</small></div></div>
    </div>
    <div class="it2-builder-note">先把順序排好即可；下一階段會加入「幫我順路排」與車程時間。</div>
    <button class="it2-btn it2-btn-primary it2-btn-block" data-it2-save ${trip.stops.length ? '' : 'disabled'}>${ui.trips.some(t => t.id === trip.id) ? '儲存修改' : '完成行程'}</button>
  </section>`;
}

function render() {
  if (!root) return;
  setNavActive();
  root.innerHTML = ui.screen === 'create' ? renderCreate() : ui.screen === 'pick' ? renderPick() : ui.screen === 'arrange' ? renderArrange() : renderList();
  ui.mounted = true;
}

async function openList() {
  ui.busy = true;
  try {
    await loadData();
    ui.screen = 'list';
    ui.draft = null;
    ui.selectedIds = new Set();
    ui.query = '';
    render();
    window.scrollTo({ top: 0, behavior: 'instant' });
  } finally {
    ui.busy = false;
  }
}

async function openTrip(id) {
  await loadData();
  const trip = ui.trips.find(t => t.id === id);
  if (!trip) return openList();
  ui.draft = createTrip({ ...trip, createdAt: trip.createdAt });
  ui.selectedIds = new Set((trip.stops || []).map(s => s.entityId).filter(Boolean));
  ui.screen = 'arrange';
  render();
}

function syncBasicFields() {
  if (!ui.draft) return;
  const date = document.getElementById('it2Date')?.value || ui.draft.date;
  const title = document.getElementById('it2Title')?.value || '';
  const departureTime = document.getElementById('it2Departure')?.value || '09:00';
  ui.draft = createTrip({ ...ui.draft, date, title, departureTime, createdAt: ui.draft.createdAt });
}

function materializeSelected() {
  if (!ui.draft) return;
  const selected = ui.entities.filter(e => ui.selectedIds.has(e.id));
  const custom = (ui.draft.stops || []).filter(s => s.kind === 'custom');
  const clean = createTrip({ ...ui.draft, stops: custom, createdAt: ui.draft.createdAt });
  ui.draft = withEntities(clean, selected);
}

async function saveDraft() {
  if (!ui.draft?.stops?.length || ui.busy) return;
  ui.busy = true;
  try {
    const saved = createTrip({ ...ui.draft, status: 'planned', createdAt: ui.draft.createdAt });
    await TwinDB.put('itineraries', saved);
    await openList();
  } finally {
    ui.busy = false;
  }
}

function onRootClick(event) {
  const button = event.target.closest('button');
  if (!button || !root?.contains(button)) return;
  if (button.matches('[data-it2-new]')) {
    ui.draft = createTrip({ date: localToday(), title: '' });
    ui.selectedIds = new Set();
    ui.query = '';
    ui.screen = 'create';
    render();
    return;
  }
  if (button.matches('[data-it2-back-list]')) return void openList();
  if (button.matches('[data-it2-to-pick]')) { syncBasicFields(); ui.screen = 'pick'; render(); return; }
  if (button.matches('[data-it2-back-create]')) { ui.screen = 'create'; render(); return; }
  if (button.matches('[data-it2-source]')) { ui.source = button.dataset.it2Source; render(); return; }
  if (button.matches('[data-it2-place]')) {
    const id = button.dataset.it2Place;
    if (ui.selectedIds.has(id)) ui.selectedIds.delete(id); else ui.selectedIds.add(id);
    render();
    return;
  }
  if (button.matches('[data-it2-add-custom]')) {
    const input = document.getElementById('it2Custom');
    const value = input?.value?.trim();
    if (value) { ui.draft = withCustomStop(ui.draft, value); render(); }
    return;
  }
  if (button.matches('[data-it2-to-arrange]')) {
    materializeSelected();
    ui.screen = 'arrange';
    render();
    return;
  }
  if (button.matches('[data-it2-back-pick]')) { ui.screen = 'pick'; render(); return; }
  if (button.matches('[data-it2-edit-basic]')) { ui.screen = 'create'; render(); return; }
  if (button.matches('[data-it2-move]')) {
    const index = Number(button.dataset.index);
    const to = button.dataset.it2Move === 'up' ? index - 1 : index + 1;
    ui.draft = moveStop(ui.draft, index, to);
    render();
    return;
  }
  if (button.matches('[data-it2-remove]')) {
    const index = Number(button.dataset.index);
    const removed = ui.draft.stops[index];
    if (removed?.entityId) ui.selectedIds.delete(removed.entityId);
    ui.draft = removeStop(ui.draft, index);
    render();
    return;
  }
  if (button.matches('[data-it2-save]')) return void saveDraft();
  if (button.matches('[data-it2-open]')) return void openTrip(button.dataset.it2Open);
}

function onRootInput(event) {
  if (event.target?.id === 'it2Search') {
    ui.query = event.target.value || '';
    const caret = event.target.selectionStart;
    render();
    const next = document.getElementById('it2Search');
    next?.focus();
    if (Number.isInteger(caret)) next?.setSelectionRange(caret, caret);
  }
}

function interceptTripNavigation(event) {
  const trigger = event.target.closest('[data-view="trips"], [data-view-jump="trips"]');
  if (!trigger) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  void openList();
}

document.addEventListener('click', interceptTripNavigation, true);
root?.addEventListener('click', onRootClick, true);
root?.addEventListener('input', onRootInput, true);

window.TwinItineraryV2 = Object.freeze({
  open: openList,
  openTrip,
  version: 'J2A-0'
});
