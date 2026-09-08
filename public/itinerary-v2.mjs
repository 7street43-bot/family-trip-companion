import {
  createTrip,
  withCandidates,
  withOrigin,
  moveStop,
  removeStop,
  splitTrips,
  formatDateLabel,
  isV2Trip
} from './itinerary-v2-core.mjs';
import {
  normalizePlannerInput,
  candidateFromEntity,
  candidateFromExternal,
  candidateFromCustom,
  candidateFromStop,
  mergeCandidatePool,
  toggleSelectionOrder,
  selectedCandidates,
  queryDisplay
} from './itinerary-candidates-core.mjs';
import {
  buildRouteLocations,
  optimizeRoute,
  applyOptimizedRoute,
  formatRouteDuration,
  formatRouteDistance,
  MAX_ROUTE_STOPS
} from './itinerary-route-core.mjs';

const root = document.getElementById('app');
const nav = document.getElementById('bottomNav');

const ui = {
  screen: 'list',
  trips: [],
  entities: [],
  draft: null,
  candidatePool: [],
  selectedKeys: [],
  query: '',
  source: 'smart',
  smart: {
    request: '', location: '', anchor: '', themes: '',
    loading: false, error: '', planner: null, queriesTried: []
  },
  route: { loading:false, error:'' },
  busy: false,
  mounted: false
};

const TYPE_ICON = { attraction: '🌿', hotel: '🏨', restaurant: '🍽', activity: '🎈' };
const TYPE_LABEL = { attraction: '景點', hotel: '住宿', restaurant: '餐廳', activity: '其他' };
const SOURCE_LABEL = { saved: '收藏', favorite: '最愛', external: '智慧候選', custom: '自己加入', history: '去過' };

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

function selectedSet() {
  return new Set(ui.selectedKeys);
}

function seedCandidates(extra = []) {
  const saved = ui.entities.map(candidateFromEntity).filter(Boolean);
  ui.candidatePool = mergeCandidatePool(saved, ui.candidatePool, extra);
}

function resetCandidateState() {
  ui.candidatePool = ui.entities.map(candidateFromEntity).filter(Boolean);
  ui.selectedKeys = [];
  ui.query = '';
  ui.source = 'smart';
  ui.smart = { request:'', location:'', anchor:'', themes:'', loading:false, error:'', planner:null, queriesTried:[] };
  ui.route = { loading:false, error:'' };
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
  const route = trip.routePlan?.totalDurationSeconds ? `・車程 ${formatRouteDuration(trip.routePlan.totalDurationSeconds)}` : '';
  return `<button class="it2-trip-card" data-it2-open="${esc(trip.id)}">
    <div class="it2-trip-card-main"><strong>${esc(trip.title)}</strong><span>${esc(formatDateLabel(trip.date))}</span></div>
    <div class="it2-trip-card-meta"><span>${trip.stops?.length || 0} 個地點${route}</span><span>›</span></div>
  </button>`;
}

function renderList() {
  const { upcoming, past } = splitTrips(ui.trips);
  return `<section class="it2-page" data-it2-screen="list">
    ${pageHead('我的行程', '說你想去哪，先找候選，再確認成行程；確認後還能幫你順路排。', '<button class="it2-btn it2-btn-primary" data-it2-new>＋ 建立新行程</button>')}
    ${upcoming.length ? `<section class="it2-section"><div class="it2-section-title"><h2>即將出發</h2><span>${upcoming.length} 趟</span></div><div class="it2-trip-list">${upcoming.map(tripCard).join('')}</div></section>` : `
      <div class="it2-empty"><div class="it2-empty-icon">🗓</div><h2>還沒有下一趟行程</h2><p>選日期後，可以直接說「想怎麼玩」，也可以從收藏挑。</p><button class="it2-btn it2-btn-primary it2-btn-large" data-it2-new>建立第一個行程</button></div>`}
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
    <p class="it2-lead">先決定日期。若填出發／回家地址，之後會連去程與回程一起順路計算。</p>
    <div class="it2-form-card">
      <label><span>日期</span><input id="it2Date" type="date" value="${esc(draft.date)}" /></label>
      <label><span>行程名稱 <small>可不填</small></span><input id="it2Title" type="text" value="${esc(draft.title || '')}" placeholder="例如：宜蘭一日遊" /></label>
      <label><span>預計出發</span><input id="it2Departure" type="time" value="${esc(draft.departureTime || '09:00')}" /></label>
      <label><span>出發／回家地址 <small>可不填</small></span><input id="it2OriginAddress" type="text" value="${esc(draft.origin?.address || '')}" placeholder="例如：新竹市東區光復路二段…" /><small>留白時只最佳化景點彼此的順序，不儲存任何預設私人地址。</small></label>
    </div>
    <button class="it2-btn it2-btn-primary it2-btn-block" data-it2-to-pick>下一步：找地點</button>
  </section>`;
}

function filteredSavedCandidates() {
  const q = ui.query.trim().toLowerCase();
  let rows = ui.candidatePool.filter(c => c.entityId);
  if (ui.source === 'favorite') rows = rows.filter(c => c.favorite || c.source === 'favorite');
  if (q) rows = rows.filter(c => [c.title, c.address, ...(c.tags || [])].join(' ').toLowerCase().includes(q));
  return rows.sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || String(a.title).localeCompare(String(b.title), 'zh-Hant'));
}

function smartCandidates() {
  return ui.candidatePool
    .filter(c => c.source === 'external')
    .sort((a, b) => (a.sourceRank ?? 999) - (b.sourceRank ?? 999) || (b.userRatingCount || 0) - (a.userRatingCount || 0));
}

function candidateMeta(candidate) {
  const bits = [SOURCE_LABEL[candidate.source] || '候選'];
  if (candidate.address) bits.push(candidate.address);
  if (candidate.rating) bits.push(`★ ${candidate.rating}${candidate.userRatingCount ? ` (${candidate.userRatingCount})` : ''}`);
  return bits.join('・');
}

function candidateRow(candidate) {
  const checked = selectedSet().has(candidate.key);
  return `<button class="it2-place-row ${checked ? 'selected' : ''}" data-it2-candidate="${esc(candidate.key)}" aria-pressed="${checked}">
    <span class="it2-check">${checked ? '✓' : ''}</span>
    <span class="it2-place-icon">${TYPE_ICON[candidate.entityType] || '📍'}</span>
    <span class="it2-place-copy"><strong>${esc(candidate.title)}</strong><small>${esc(candidateMeta(candidate))}</small></span>
  </button>`;
}

function renderSelectedTray() {
  const selected = selectedCandidates(ui.candidatePool, ui.selectedKeys);
  if (!selected.length) return `<div class="it2-candidate-tray empty"><strong>候選池</strong><span>先把可能想去的地方放進來；還不會寫入正式行程。</span></div>`;
  return `<div class="it2-candidate-tray"><div class="it2-candidate-tray-head"><strong>候選池 ${selected.length}</strong><span>下一步確認後才加入行程</span></div><div class="it2-candidate-chips">${selected.map(c => `<button data-it2-candidate="${esc(c.key)}" title="移除候選">${esc(c.title)} ×</button>`).join('')}</div></div>`;
}

function renderSmartPanel() {
  const rows = smartCandidates();
  const searched = ui.smart.planner || ui.smart.queriesTried.length;
  return `<div class="it2-smart-panel">
    <label class="it2-smart-request"><span>你想怎麼玩？</span><textarea id="it2SmartRequest" rows="3" placeholder="例如：帶小孩去宜蘭一日，不想一直開車，想看動物，也要有雨天備案">${esc(ui.smart.request)}</textarea></label>
    <div class="it2-smart-grid">
      <label><span>縣市／區域 <small>可不填</small></span><input id="it2SmartLocation" value="${esc(ui.smart.location)}" placeholder="例如：宜蘭、礁溪" /></label>
      <label><span>主景點 <small>可不填</small></span><input id="it2SmartAnchor" value="${esc(ui.smart.anchor)}" placeholder="例如：斑比山丘" /></label>
      <label><span>主題 <small>可多個</small></span><input id="it2SmartThemes" value="${esc(ui.smart.themes)}" placeholder="動物、室內、親子餐廳" /></label>
    </div>
    <button class="it2-btn it2-btn-primary it2-btn-block" data-it2-smart-search ${ui.smart.loading ? 'disabled' : ''}>${ui.smart.loading ? '正在找候選景點…' : '✨ 找候選景點'}</button>
    ${ui.smart.error ? `<div class="it2-smart-error">${esc(ui.smart.error)}</div>` : ''}
    ${searched ? `<div class="it2-smart-summary">${esc(queryDisplay(ui.smart))}｜找到 ${rows.length} 個候選點</div>` : ''}
    <div class="it2-place-list it2-smart-results">${rows.length ? rows.map(candidateRow).join('') : '<div class="it2-mini-empty">輸入需求後，外部資料只會先進候選池；你確認後才會成為正式行程。</div>'}</div>
  </div>`;
}

function renderSavedPanel() {
  const rows = filteredSavedCandidates();
  return `<div class="it2-search"><span>⌕</span><input id="it2Search" value="${esc(ui.query)}" placeholder="搜尋收藏的景點、餐廳、住宿" /></div>
    <div class="it2-place-list">${rows.length ? rows.map(candidateRow).join('') : '<div class="it2-mini-empty">沒有符合的收藏資料。</div>'}</div>`;
}

function renderPick() {
  const favoriteCount = ui.candidatePool.filter(c => c.entityId && c.favorite).length;
  return `<section class="it2-page it2-flow it2-pick-page" data-it2-screen="pick">
    <button class="it2-back" data-it2-back-create>‹ 日期</button>
    <div class="it2-step">2 / 3</div>
    <h1>先找候選，再決定去哪</h1>
    <p class="it2-lead">行程來源不限收藏。可以直接說需求、指定區域或主景點，也可以從收藏挑。</p>
    ${renderSelectedTray()}
    <div class="it2-source-tabs it2-source-tabs-three">
      <button class="${ui.source === 'smart' ? 'active' : ''}" data-it2-source="smart">✨ 幫我找</button>
      <button class="${ui.source === 'saved' ? 'active' : ''}" data-it2-source="saved">收藏</button>
      <button class="${ui.source === 'favorite' ? 'active' : ''}" data-it2-source="favorite">♥ 最愛 ${favoriteCount ? `(${favoriteCount})` : ''}</button>
    </div>
    ${ui.source === 'smart' ? renderSmartPanel() : renderSavedPanel()}
    <div class="it2-manual"><span>找不到？</span><div class="it2-custom-row"><input id="it2Custom" placeholder="直接輸入地點名稱" /><button class="it2-btn" data-it2-add-custom>＋ 放入候選池</button></div></div>
    <div class="it2-sticky-action"><span>候選池 <strong>${ui.selectedKeys.length}</strong> 個</span><button class="it2-btn it2-btn-primary" data-it2-to-arrange ${ui.selectedKeys.length ? '' : 'disabled'}>確認並排順序</button></div>
  </section>`;
}

function routeLegTo(key) {
  return (ui.draft?.routePlan?.legs || []).find(leg => leg.toKey === key) || null;
}

function stopRow(stop, index, total) {
  const source = SOURCE_LABEL[stop.source] || TYPE_LABEL[stop.entityType] || '地點';
  const leg = routeLegTo(stop.candidateKey);
  const drive = leg ? `<span class="it2-drive-chip">🚗 ${esc(formatRouteDuration(leg.durationSeconds))}</span>` : '';
  return `<div class="it2-stop-row" data-it2-stop-key="${esc(stop.candidateKey || stop.id)}">
    <div class="it2-stop-index">${index + 1}</div>
    <div class="it2-stop-copy"><div class="it2-stop-title-line"><strong>${esc(stop.title)}</strong>${drive}</div><small>${esc(source)}${stop.address ? `・${esc(stop.address)}` : ''}</small></div>
    <div class="it2-stop-actions">
      <button data-it2-move="up" data-index="${index}" aria-label="往上" ${index === 0 ? 'disabled' : ''}>↑</button>
      <button data-it2-move="down" data-index="${index}" aria-label="往下" ${index === total - 1 ? 'disabled' : ''}>↓</button>
      <button data-it2-remove data-index="${index}" aria-label="刪除">×</button>
    </div>
  </div>`;
}

function routeReasonMessage(routeCheck) {
  if (routeCheck.reason === 'need_two_stops') return '至少需要 2 個地點才能順路排序。';
  if (routeCheck.reason === 'too_many_stops') return `目前一次最多 ${MAX_ROUTE_STOPS} 站，避免 Route Matrix 成本失控。`;
  if (routeCheck.reason === 'unroutable_stops') return `有 ${routeCheck.blockers.length} 個地點缺少 Google 地點、精確座標或完整地址；先回候選池選正式地點。`;
  return '目前無法建立路由矩陣。';
}

function renderRouteTools() {
  const trip = ui.draft;
  const check = buildRouteLocations(trip.stops || [], trip.origin || null);
  const plan = trip.routePlan;
  const hasOrigin = !!check.originPoint;
  const summary = plan ? `<div class="it2-route-summary"><strong>順路排序完成</strong><span>總車程 ${esc(formatRouteDuration(plan.totalDurationSeconds))}・${esc(formatRouteDistance(plan.totalDistanceMeters))}${plan.roundTrip ? '・含回家' : '・不含出發／回家'}</span></div>` : '';
  const note = check.ok
    ? (hasOrigin ? '會計算「出發地 → 各站 → 回家」的完整閉環。' : '未填出發地址，所以只比較景點彼此的車程順序。')
    : routeReasonMessage(check);
  return `<section class="it2-route-tools">
    <div><strong>順路排</strong><p>${esc(note)}</p></div>
    <button class="it2-btn it2-btn-route" data-it2-optimize-route ${!check.ok || ui.route.loading ? 'disabled' : ''}>${ui.route.loading ? '正在算車程…' : '✨ 幫我順路排'}</button>
    ${ui.route.error ? `<div class="it2-route-error">${esc(ui.route.error)}</div>` : ''}
    ${summary}
  </section>`;
}

function renderArrange() {
  const trip = ui.draft;
  const originAddress = trip.origin?.address || '';
  const returnLeg = (trip.routePlan?.legs || []).find(leg => leg.toKey === 'origin:home');
  return `<section class="it2-page it2-flow" data-it2-screen="arrange">
    <button class="it2-back" data-it2-back-pick>‹ 候選池</button>
    <div class="it2-step">3 / 3</div>
    <div class="it2-builder-head"><div><h1>${esc(trip.title)}</h1><p>${esc(formatDateLabel(trip.date))}</p></div><button class="it2-btn" data-it2-edit-basic>修改日期／出發地</button></div>
    ${renderRouteTools()}
    <div class="it2-timeline">
      <div class="it2-fixed-stop"><span class="it2-stop-index">⌂</span><div><strong>${esc(trip.departureTime || '09:00')} 出發</strong><small>${originAddress ? esc(originAddress) : '未設定出發地址'}</small></div></div>
      <div class="it2-stop-list">${trip.stops.length ? trip.stops.map((s, i) => stopRow(s, i, trip.stops.length)).join('') : '<div class="it2-mini-empty">候選池還沒有確認任何地點。</div>'}</div>
      <div class="it2-fixed-stop"><span class="it2-stop-index">⌂</span><div><strong>${originAddress ? '回家' : '行程結束'}</strong><small>${returnLeg ? `🚗 ${esc(formatRouteDuration(returnLeg.durationSeconds))}` : (originAddress ? '回到出發地' : '未計回程')}</small></div></div>
    </div>
    <div class="it2-builder-note">候選池不會自動寫入行程；順路排也只改目前草稿順序，最後按「完成行程」才正式儲存。</div>
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
    resetCandidateState();
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
  resetCandidateState();
  seedCandidates((trip.stops || []).map(candidateFromStop).filter(Boolean));
  ui.selectedKeys = (trip.stops || []).map(s => s.candidateKey || (s.entityId ? `entity:${s.entityId}` : s.placeId ? `place:${s.placeId}` : s.kind === 'custom' ? `custom:${s.id}` : '')).filter(Boolean);
  if (trip.plannerInput) {
    ui.smart = { ...ui.smart, ...trip.plannerInput };
    ui.smart.themes = Array.isArray(trip.plannerInput.themes) ? trip.plannerInput.themes.join('、') : (trip.plannerInput.themes || '');
  }
  ui.screen = 'arrange';
  render();
}

function syncBasicFields() {
  if (!ui.draft) return;
  const date = document.getElementById('it2Date')?.value || ui.draft.date;
  const title = document.getElementById('it2Title')?.value || '';
  const departureTime = document.getElementById('it2Departure')?.value || '09:00';
  const originAddress = document.getElementById('it2OriginAddress')?.value?.trim() || '';
  const originChanged = originAddress !== (ui.draft.origin?.address || '');
  let next = createTrip({ ...ui.draft, date, title, departureTime, createdAt:ui.draft.createdAt });
  if (originChanged) next = withOrigin(next, { ...next.origin, address:originAddress, label:'家' });
  ui.draft = next;
  ui.route.error = '';
}

function syncSmartFields() {
  const request = document.getElementById('it2SmartRequest')?.value ?? ui.smart.request;
  const location = document.getElementById('it2SmartLocation')?.value ?? ui.smart.location;
  const anchor = document.getElementById('it2SmartAnchor')?.value ?? ui.smart.anchor;
  const themes = document.getElementById('it2SmartThemes')?.value ?? ui.smart.themes;
  ui.smart = { ...ui.smart, request, location, anchor, themes };
  return normalizePlannerInput({ request, location, anchor, themes });
}

async function searchSmartCandidates() {
  if (ui.smart.loading) return;
  const plannerInput = syncSmartFields();
  if (!plannerInput.request && !plannerInput.location && !plannerInput.anchor && !plannerInput.themes.length) {
    ui.smart.error = '至少輸入一句需求、區域、主景點或主題。';
    render();
    return;
  }
  ui.smart.loading = true;
  ui.smart.error = '';
  render();
  try {
    const response = await fetch('/api/itinerary-candidates', {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ ...plannerInput, limit:15 })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || body.error || `候選搜尋失敗 (${response.status})`);
    const external = (body.candidates || []).map(candidateFromExternal).filter(Boolean);
    ui.candidatePool = mergeCandidatePool(ui.candidatePool, external);
    ui.smart.planner = body.planner || null;
    ui.smart.queriesTried = body.queriesTried || [];
    if (!external.length) ui.smart.error = '沒有找到合適候選點，可以換一種說法或縮小區域。';
  } catch (error) {
    ui.smart.error = `目前無法取得外部候選景點：${error.message || '請稍後再試'}`;
  } finally {
    ui.smart.loading = false;
    render();
  }
}

async function optimizeCurrentRoute() {
  if (!ui.draft || ui.route.loading) return;
  const check = buildRouteLocations(ui.draft.stops || [], ui.draft.origin || null);
  if (!check.ok) {
    ui.route.error = routeReasonMessage(check);
    render();
    return;
  }
  ui.route.loading = true;
  ui.route.error = '';
  render();
  try {
    const response = await fetch('/api/itinerary-route-matrix', {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ locations:check.locations })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || body.error || `路由服務失敗 (${response.status})`);
    const plan = optimizeRoute(check.stopPoints, body.elements || [], { originPoint:check.originPoint, roundTrip:!!check.originPoint });
    if (!plan.ok) throw new Error(plan.reason === 'route_incomplete' ? '部分地點之間找不到可行車程' : '無法完成順路排序');
    const applied = applyOptimizedRoute(ui.draft, plan);
    ui.draft = createTrip({
      ...applied,
      routePlan:{ ...applied.routePlan, provider:body.provider || null },
      createdAt:ui.draft.createdAt
    });
  } catch (error) {
    ui.route.error = `目前無法順路排序：${error.message || '請稍後再試'}`;
  } finally {
    ui.route.loading = false;
    render();
  }
}

function materializeSelected() {
  if (!ui.draft) return;
  const plannerInput = normalizePlannerInput(ui.smart);
  const base = createTrip({ ...ui.draft, plannerInput, createdAt: ui.draft.createdAt });
  ui.draft = withCandidates(base, ui.candidatePool, ui.selectedKeys);
  ui.route.error = '';
}

async function saveDraft() {
  if (!ui.draft?.stops?.length || ui.busy) return;
  ui.busy = true;
  try {
    const saved = createTrip({ ...ui.draft, status:'planned', createdAt:ui.draft.createdAt });
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
    ui.draft = createTrip({ date:localToday(), title:'' });
    resetCandidateState();
    ui.screen = 'create';
    render();
    return;
  }
  if (button.matches('[data-it2-back-list]')) return void openList();
  if (button.matches('[data-it2-to-pick]')) { syncBasicFields(); seedCandidates(); ui.screen = 'pick'; render(); return; }
  if (button.matches('[data-it2-back-create]')) { ui.screen = 'create'; render(); return; }
  if (button.matches('[data-it2-source]')) { ui.source = button.dataset.it2Source; render(); return; }
  if (button.matches('[data-it2-candidate]')) {
    const key = button.dataset.it2Candidate;
    ui.selectedKeys = toggleSelectionOrder(ui.selectedKeys, key, !selectedSet().has(key));
    render();
    return;
  }
  if (button.matches('[data-it2-add-custom]')) {
    const candidate = candidateFromCustom(document.getElementById('it2Custom')?.value || '');
    if (candidate) {
      ui.candidatePool = mergeCandidatePool(ui.candidatePool, [candidate]);
      ui.selectedKeys = toggleSelectionOrder(ui.selectedKeys, candidate.key, true);
      render();
    }
    return;
  }
  if (button.matches('[data-it2-smart-search]')) return void searchSmartCandidates();
  if (button.matches('[data-it2-to-arrange]')) { materializeSelected(); ui.screen = 'arrange'; render(); return; }
  if (button.matches('[data-it2-back-pick]')) {
    ui.selectedKeys = (ui.draft?.stops || []).map(s => s.candidateKey).filter(Boolean);
    seedCandidates((ui.draft?.stops || []).map(candidateFromStop).filter(Boolean));
    ui.screen = 'pick';
    render();
    return;
  }
  if (button.matches('[data-it2-edit-basic]')) { ui.screen = 'create'; render(); return; }
  if (button.matches('[data-it2-optimize-route]')) return void optimizeCurrentRoute();
  if (button.matches('[data-it2-move]')) {
    const index = Number(button.dataset.index);
    ui.draft = moveStop(ui.draft, index, button.dataset.it2Move === 'up' ? index - 1 : index + 1);
    ui.route.error = '';
    render();
    return;
  }
  if (button.matches('[data-it2-remove]')) {
    const index = Number(button.dataset.index);
    const removed = ui.draft.stops[index];
    if (removed?.candidateKey) ui.selectedKeys = toggleSelectionOrder(ui.selectedKeys, removed.candidateKey, false);
    ui.draft = removeStop(ui.draft, index);
    ui.route.error = '';
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
    return;
  }
  if (event.target?.id === 'it2SmartRequest') ui.smart.request = event.target.value || '';
  if (event.target?.id === 'it2SmartLocation') ui.smart.location = event.target.value || '';
  if (event.target?.id === 'it2SmartAnchor') ui.smart.anchor = event.target.value || '';
  if (event.target?.id === 'it2SmartThemes') ui.smart.themes = event.target.value || '';
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
  version: 'J2A-2'
});
