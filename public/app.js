(() => {
  const APP_RUNTIME_VERSION = '4.5.0-phase1.2';
  'use strict';

  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
  const app = $('#app');
  const header = $('#appHeader');
  const bottomNav = $('#bottomNav');
  const modalRoot = $('#modalRoot');
  const snackbar = $('#snackbar');
  const importInput = $('#jsonImportInput');
  const settingsBtn = $('#settingsBtn');
  const brandMark = $('#brandMark');
  const brandTitle = $('#brandTitle');
  const brandSubtitle = $('#brandSubtitle');

  const REGION_LABELS = { '1':'桃竹苗', '2':'北宜', '3':'中彰投', '4':'南部', '5':'花東' };
  const TYPE_LABELS = { attraction:'景點', hotel:'住宿', restaurant:'餐廳', activity:'其他收藏' };
  const TYPE_ICONS = { attraction:'🌿', hotel:'🏨', restaurant:'🍽', activity:'🎈' };
  const STOP_LABELS = { start:'出發', attraction:'景點', hotel:'住宿', restaurant:'餐廳', activity:'其他收藏', custom:'自訂', home:'回家' };

  const state = {
    view: 'home',
    entities: [], packItems: [], packState: [], itineraries: [], settings: {},
    selectedEntityId: null, selectedTripId: null,
    explore: { query:'', type:'attraction', themeId:'', region:'', visited:'', indoor:'', ageOnly:false, nearby:false, userPos:null, favoriteOnly:false, sort:'recommended' },
    decision: { mode:'day', context:'any', macroRegion:'all', type:'attraction', unvisitedOnly:true, favoriteOnly:false, ageOnly:false, maxKm:'', userPos:null },
    packEdit: false,
    undoTimer: null,
    deletedPack: null,
    photoSession: new Map(), photoObserver: null,
    pendingPlaceMatch: null, batchPlaceRunning: false,
    inFlightEvidence: new Map(), inFlightPlaceSearch: new Map(), inFlightPlaceDetails: new Map(), inFlightNearbyPlaces: new Map(), tripCompanion:false
  };

  function esc(v='') {
    return String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  }
  const escapeHtml = esc;

  function uuid(prefix='id') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  }
  function todayISO() {
    const d=new Date();
    const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }
  function fmtDate(s) {
    if (!s) return '未設定日期';
    const d = new Date(`${s}T12:00:00`);
    if (Number.isNaN(d.getTime())) return s;
    return new Intl.DateTimeFormat('zh-TW',{month:'numeric',day:'numeric',weekday:'short'}).format(d);
  }
  async function fetchJsonWithTimeout(url,options={},timeoutMs=15000){
    const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
    try{
      const res=await fetch(url,{...options,signal:ctrl.signal});
      let data={};try{data=await res.json();}catch{}
      if(!res.ok){const err=new Error(data?.message||data?.reason||data?.error||`http_${res.status}`);err.status=res.status;err.code=data?.error||'';err.data=data;throw err;}
      return data;
    }catch(err){if(err?.name==='AbortError'){const e=new Error('request_timeout');e.code='timeout';throw e;}throw err;}
    finally{clearTimeout(timer);}
  }

  function ageMonthsFromBirthdate(birthdate) {
    if (!birthdate) return null;
    const b = new Date(`${birthdate}T12:00:00`), n = new Date();
    if (Number.isNaN(b.getTime()) || b > n) return null;
    let m=(n.getFullYear()-b.getFullYear())*12+(n.getMonth()-b.getMonth());
    if (n.getDate() < b.getDate()) m--;
    return Math.max(0,m);
  }
  function parseSimpleAge(age='') {
    const s=String(age).trim();
    let m=s.match(/^(\d+)\s*[-～~至]\s*(\d+)\s*歲$/);
    if (m) return { minAgeMonths:+m[1]*12, maxAgeMonths:+m[2]*12 };
    m=s.match(/^(\d+)\s*歲以上$/);
    if (m) return { minAgeMonths:+m[1]*12, maxAgeMonths:null };
    return { minAgeMonths:null, maxAgeMonths:null };
  }

  function normalizedPlaceName(s='') {
    return String(s).normalize('NFKC').toLowerCase().replace(/臺/g,'台').replace(/[\s\-—–_·・,，.。:：()（）【】\[\]\/\\'"]/g,'').trim();
  }
  function isCollectionEntity(e) {
    const n=String(e?.name||'').trim();
    return /^(全台|全臺)/.test(n) ||
      /(一日遊|二日遊|三日遊|懶人包|景點整理|推薦清單|總整理)/.test(n) ||
      /全台.*(飯店|旅館|景點|博物館|樂園)/.test(n) ||
      /\d+\s*(間|個|處).*(飯店|旅館|景點|博物館|樂園)/.test(n);
  }
  function placeBranchRisk(e) {
    const key=normalizedPlaceName(e?.name||'');
    const same=state.entities.filter(x=>x.id!==e.id && x.captureStatus!=='inbox' && normalizedPlaceName(x.name||'')===key).length>0;
    const chainLike=/(遊戲愛樂園|和逸飯店|福容|新光三越|悅華|威斯汀|晶英|voco|寒沐)/i.test(String(e?.name||''));
    return same || chainLike;
  }

  function normalizeEntity(item, type) {
    const age = item.age || '';
    const parsed = parseSimpleAge(age);
    const latlng = item.latlng || '';
    const googleMapsUrl = /^https?:\/\/(maps\.app\.goo\.gl|www\.google\.com\/maps|goo\.gl\/maps)/i.test(latlng) ? latlng : '';
    return {
      id: `${type}-${item.id}`,
      legacyId: item.id,
      entityType: type,
      name: item.name || '未命名',
      region: String(item.region ?? ''),
      cityRaw: item.city || '',
      county: '', district: '', address: '',
      latitude: null, longitude: null,
      googleMapsUrl,
      note: item.note || '',
      ageNote: age,
      minAgeMonths: parsed.minAgeMonths,
      maxAgeMonths: parsed.maxAgeMonths,
      indoor: null,
      tags: [],
      favorite: false,
      visited: !!item.visited,
      sourceUrls: item.url ? [item.url] : [],
      originalUrl: item.url || '',
      coverImage: '', images: [], imageSource: '', imageUpdatedAt: '',
      sourceCoverUrl:'', sourceCoverStatus:'', sourceCoverMethod:'', sourceCoverDomain:'', sourceCoverPageUrl:'',
      googlePlaceId:'', placeDisplayName:'', placeMatchStatus:'',
      captureStatus:'ready', sourcePlatform:item.url?sourcePlatformFromUrl(item.url):'',
      familyRating:null, revisitIntent:'', familyTags:[], familyNote:'', familyReviewedAt:'',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
  }

  function mergeKnownLegacyDuplicates(entities) {
    const matches = entities.filter(e => e.entityType==='attraction' && e.name==='幸福20號農場');
    if (matches.length < 2) return entities;
    const base = matches[0];
    for (const other of matches.slice(1)) {
      base.sourceUrls = [...new Set([...(base.sourceUrls||[]), ...(other.sourceUrls||[])])];
      if (!base.ageNote && other.ageNote) {
        base.ageNote = other.ageNote;
        const p=parseSimpleAge(other.ageNote); base.minAgeMonths=p.minAgeMonths; base.maxAgeMonths=p.maxAgeMonths;
      }
      if (other.note && !base.note.includes(other.note)) base.note = [base.note, other.note].filter(Boolean).join('；');
      base.visited = base.visited || other.visited;
    }
    const removeIds = new Set(matches.slice(1).map(x=>x.id));
    return entities.filter(e=>!removeIds.has(e.id));
  }

  function migrateLegacyData(raw) {
    let entities = [];
    for (const x of (raw.attractions||[])) entities.push(normalizeEntity(x,'attraction'));
    for (const x of (raw.hotels||[])) entities.push(normalizeEntity(x,'hotel'));
    for (const x of (raw.foods||[])) {
      const type = /^遊戲[:：]/.test(x.name||'') ? 'activity' : 'restaurant';
      entities.push(normalizeEntity(x,type));
    }
    entities = mergeKnownLegacyDuplicates(entities);
    const packItems = (raw.checkItems||[]).map((x,i)=>({
      id:`pack-${x.id}`, legacyId:x.id, label:x.label||'未命名', cat:x.cat||'其他', order:i+1,
      createdAt:new Date().toISOString(), updatedAt:new Date().toISOString()
    }));
    const packState = (raw.checkItems||[]).map(x=>({ itemId:`pack-${x.id}`, checked:!!x.checked, updatedAt:new Date().toISOString() }));
    return { format:'twin-trip-v4', schemaVersion:3, entities, packItems, packState, itineraries:[], settings:[] };
  }

  async function ensureSeeded() {
    const seeded = await TwinDB.get('meta','seeded');
    if (seeded) return;
    const raw = await fetch('./seed-data.json').then(r => {
      if (!r.ok) throw new Error('無法讀取 seed-data.json'); return r.json();
    });
    const migrated = migrateLegacyData(raw);
    await TwinDB.bulkPut('entities', migrated.entities);
    await TwinDB.bulkPut('packItems', migrated.packItems);
    await TwinDB.bulkPut('packState', migrated.packState);
    await TwinDB.bulkPut('settings', [
      { key:'childBirthdate', value:'' },
      { key:'appTitle', value:'雙寶出遊' },
      { key:'appIconImage', value:'' },
      { key:'exploreThemes', value:[] },
      { key:'dataSource', value:'legacy-v5-migrated' },
      { key:'legacyExportedAt', value:raw.exportedAt||'' }
    ]);
    await TwinDB.put('meta',{ key:'seeded', value:true, seededAt:new Date().toISOString(), sourceVersion:raw.version||null });
  }


  function currentAppTitle() {
    const title=String(state.settings.appTitle||'').trim();
    return title || '雙寶出遊';
  }

  function syncAppTitle() {
    const title=currentAppTitle();
    if (brandTitle) brandTitle.textContent=title;
    if (brandSubtitle) brandSubtitle.textContent=`家庭出遊小幫手 ${APP_RUNTIME_VERSION}`;
    if (brandMark) {
      const icon=String(state.settings.appIconImage||'').trim();
      brandMark.innerHTML=icon?`<img src="${esc(icon)}" alt="" />`:'🐻';
      brandMark.classList.toggle('custom',!!icon);
    }
    document.title=`${title}｜家庭出遊小幫手 ${APP_RUNTIME_VERSION}`;
    const appleTitle=document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (appleTitle) appleTitle.setAttribute('content',title);
  }

  async function reloadData() {
    const [entities, packItems, packState, itineraries, settings] = await Promise.all([
      TwinDB.getAll('entities'), TwinDB.getAll('packItems'), TwinDB.getAll('packState'), TwinDB.getAll('itineraries'), TwinDB.getAll('settings')
    ]);
    state.entities = entities;
    state.packItems = packItems.sort((a,b)=>(a.order||0)-(b.order||0));
    state.packState = packState;
    state.itineraries = itineraries.sort((a,b)=>(a.date||'9999').localeCompare(b.date||'9999'));
    state.settings = Object.fromEntries(settings.map(x=>[x.key,x.value]));
    syncAppTitle();
    await migrateGeographyIfNeeded();
    await migrateDecisionFieldsIfNeeded();
    await migrateDecisionMetadataIfNeeded();
    await migrateDecisionConsistencyIfNeeded();
  }

  function setView(view, opts={}) {
    state.view = view;
    if (opts.entityId !== undefined) state.selectedEntityId = opts.entityId;
    if (opts.tripId !== undefined) state.selectedTripId = opts.tripId;
    render();
    window.scrollTo({top:0,behavior:'instant'});
  }

  function updateChrome() {
    const detail = state.view === 'detail';
    header.hidden = detail;
    bottomNav.hidden = detail;
    $$('.nav-item', bottomNav).forEach(b => b.classList.toggle('active', b.dataset.view===state.view));
  }

  function offlineBanner() {
    return navigator.onLine ? '' : `<div class="offline-banner">目前離線：核心資料可使用；地圖、外部連結與即時資訊需網路。</div>`;
  }

  function entityLocation(e) {
    return e.geoGroup || e.county || e.district || e.cityRaw || REGION_LABELS[e.region] || '';
  }
  function ageBadge(e) {
    if (e.ageNote) return `<span class="badge good">${esc(e.ageNote)}</span>`;
    return '';
  }
  function typeBadge(e) { return `<span class="badge">${TYPE_LABELS[e.entityType]||'其他'}</span>`; }
  function placeholderIcon(type) { return TYPE_ICONS[type] || '📌'; }
  function attributionInline(attrs=[]) {
    if (!Array.isArray(attrs) || !attrs.length) return '';
    const parts=attrs.slice(0,2).map(a=>a?.uri?`<a href="${esc(a.uri)}" target="_blank" rel="noopener">${esc(a.displayName||'Google Maps 使用者')}</a>`:esc(a?.displayName||'Google Maps 使用者'));
    return parts.length?`<span class="photo-credit">相片：${parts.join('、')}</span>`:'';
  }
  function entityImage(e, cls='entity-thumb') {
    if (e.coverImage) return `<div class="${cls}"><img src="${esc(e.coverImage)}" alt="${esc(e.name)}" loading="lazy" onerror="this.parentElement.innerHTML='${placeholderIcon(e.entityType)}'" /></div>`;
    if (e.sourceCoverUrl) return `<div class="${cls} remote-source-photo" data-source-cover="${esc(e.sourceCoverUrl)}" data-source-entity="${esc(e.id)}" data-photo-name="${esc(e.name)}"><span class="photo-placeholder" aria-hidden="true">${placeholderIcon(e.entityType)}</span></div>`;
    if (e.googlePlaceId) return `<div class="${cls} remote-photo" data-place-photo="${esc(e.googlePlaceId)}" data-photo-name="${esc(e.name)}"><span class="photo-placeholder" aria-hidden="true">${placeholderIcon(e.entityType)}</span></div>`;
    return `<div class="${cls}" aria-hidden="true">${placeholderIcon(e.entityType)}</div>`;
  }

  async function fetchPlacePhoto(placeId, width=800) {
    const cacheKey=`${placeId}:${width}`;
    if (state.photoSession.has(cacheKey)) return state.photoSession.get(cacheKey);
    const res=await fetch(`/api/place-photo?placeId=${encodeURIComponent(placeId)}&w=${width}`, {cache:'no-store'});
    if (!res.ok) throw new Error(`photo_${res.status}`);
    const data=await res.json();
    state.photoSession.set(cacheKey,data);
    return data;
  }
  async function resolvePlacePhotoNode(el) {
    if (!el || el.dataset.photoLoaded==='1' || el.dataset.photoLoading==='1' || !navigator.onLine) return;
    el.dataset.photoLoading='1';
    try {
      const width=el.classList.contains('detail-hero')?1100:500;
      const data=await fetchPlacePhoto(el.dataset.placePhoto,width);
      const img=document.createElement('img'); img.loading='lazy'; img.alt=el.dataset.photoName||''; img.src=data.photoUri;
      img.addEventListener('error',()=>{ el.innerHTML=`<span class="photo-placeholder">🌿</span>`; });
      el.innerHTML=''; el.appendChild(img);
      if (data.attributions?.length) {
        const credit=document.createElement('span'); credit.className='photo-credit'; credit.innerHTML=attributionInline(data.attributions).replace(/^<span class="photo-credit">|<\/span>$/g,''); el.appendChild(credit);
      }
      el.dataset.photoLoaded='1';
    } catch (_) {
      el.dataset.photoLoading='';
    }
  }
  async function sourceCoverForUrl(e,url) {
    const sourceUrl=String(url||'').trim();
    if(!sourceUrl) return {status:'fallback',reason:'no_url'};
    return fetchJsonWithTimeout('/api/source-cover',{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',body:JSON.stringify({url:sourceUrl,name:e.name})},16000);
  }
  async function sourceCoverForEntity(e) {
    const sourceUrl=(e.sourceUrls||[])[0]||e.originalUrl||'';
    return sourceCoverForUrl(e,sourceUrl);
  }

  async function evidenceResolverForEntity(e) {
    const sourceUrls=[...(e?.sourceUrls||[]),e?.originalUrl].map(x=>String(x||'').trim()).filter(Boolean);
    const payload={name:e?.name||'',sourceUrls:[...new Set(sourceUrls)],officialUrl:e?.placeWebsiteUrl||'',county:e?.county||'',district:e?.district||'',branchRisk:placeBranchRisk(e)};
    const key=JSON.stringify(payload);if(state.inFlightEvidence.has(key))return state.inFlightEvidence.get(key);
    const job=(async()=>{
      const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),48000);
      try{
        const res=await fetch('/api/evidence-resolve',{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',signal:ctrl.signal,body:JSON.stringify(payload)});
        let data={};try{data=await res.json();}catch{}
        if(!res.ok){const err=new Error(data?.reason||data?.error||`evidence_resolver_${res.status}`);err.status=res.status;throw err;}
        return data;
      }catch(err){if(err?.name==='AbortError'){const e2=new Error('request_timeout');e2.code='timeout';throw e2;}throw err;}
      finally{clearTimeout(timer);}
    })().finally(()=>state.inFlightEvidence.delete(key));
    state.inFlightEvidence.set(key,job);return job;
  }

  async function fallbackSourceImage(entityId) {
    const e=getEntity(entityId) || await TwinDB.get('entities',entityId); if(!e) return;
    const out={...e,sourceCoverUrl:'',sourceCoverStatus:'image-failed',imageSource:e.googlePlaceId?'google-places':'',updatedAt:new Date().toISOString()};
    await TwinDB.put('entities',out); await reloadData();
    if(out.googlePlaceId){ render(); return; }
    if(navigator.onLine && out.placeMatchStatus!=='collection'){
      const result=await autoEnrichEntity(out,{interactive:false,silent:true,skipSource:true});
      if(result.status==='matched' || result.status==='google-existing') return;
    }
    render();
  }

  async function resolveSourcePhotoNode(el) {
    if(!el || el.dataset.photoLoaded==='1' || el.dataset.photoLoading==='1' || !navigator.onLine) return;
    el.dataset.photoLoading='1';
    const img=document.createElement('img'); img.loading='lazy'; img.alt=el.dataset.photoName||''; img.referrerPolicy='no-referrer';
    img.addEventListener('load',()=>{el.dataset.photoLoaded='1';el.dataset.photoLoading='';});
    img.addEventListener('error',async()=>{el.dataset.photoLoading='';el.innerHTML='<span class="photo-placeholder">🌿</span>';await fallbackSourceImage(el.dataset.sourceEntity);});
    img.src=el.dataset.sourceCover;
    el.innerHTML=''; el.appendChild(img);
  }

  function hydratePlaceImages() {
    const nodes=$$('[data-place-photo], [data-source-cover]');
    if (!nodes.length || !navigator.onLine) return;
    if (!('IntersectionObserver' in window)) { nodes.slice(0,8).forEach(n=>n.dataset.sourceCover?resolveSourcePhotoNode(n):resolvePlacePhotoNode(n)); return; }
    state.photoObserver?.disconnect?.();
    state.photoObserver=new IntersectionObserver(entries=>{
      for (const entry of entries) if (entry.isIntersecting) { state.photoObserver.unobserve(entry.target); entry.target.dataset.sourceCover?resolveSourcePhotoNode(entry.target):resolvePlacePhotoNode(entry.target); }
    },{rootMargin:'250px'});
    nodes.forEach(n=>state.photoObserver.observe(n));
  }
  function entityCard(e) {
    const loc=entityLocation(e);
    return `<article class="entity-card clickable" data-open-entity="${esc(e.id)}">
      ${entityImage(e)}
      <div class="entity-main">
        <div class="entity-name">${esc(e.name)}</div>
        <div class="entity-meta">${loc?`<span>${esc(loc)}</span>`:''}${e.region?`<span>・${esc(REGION_LABELS[e.region]||'')}</span>`:''}</div>
        <div class="badges">${typeBadge(e)}${ageBadge(e)}${familyRatingBadge(e)}${e.visited?'<span class="badge visited">✓ 已去</span>':''}</div>
        ${e.note?`<div class="entity-note">${esc(e.note)}</div>`:''}
      </div>
      <div class="entity-actions">
        <button class="heart-btn ${e.favorite?'on':''}" data-favorite="${esc(e.id)}" aria-label="${e.favorite?'取消收藏':'收藏'}">${e.favorite?'♥':'♡'}</button>
      </div>
    </article>`;
  }

  function getUpcomingTrip() {
    return state.itineraries.filter(t=>!t.date||t.date>=todayISO()).sort((a,b)=>{
      if(!a.date&&!b.date)return String(b.updatedAt||'').localeCompare(String(a.updatedAt||''));
      if(!a.date)return 1;if(!b.date)return -1;
      return String(a.date).localeCompare(String(b.date))||String(b.updatedAt||'').localeCompare(String(a.updatedAt||''));
    })[0]||null;
  }
  function nextStop(trip) {
    return (trip?.stops||[]).find(s=>!s.done) || null;
  }
  function packHasChecked(){const checked=Object.fromEntries(state.packState.map(x=>[x.itemId,!!x.checked]));return state.packItems.some(x=>checked[x.id]);}
  function packContextIsStale(trip=getUpcomingTrip()){
    if(!trip || !packHasChecked()) return false;
    return String(state.settings.packContextTripId||'')!==String(trip.id||'');
  }
  function packProgressSummary(trip=getUpcomingTrip()) {
    if(packContextIsStale(trip)) return '待確認';
    const checked=Object.fromEntries(state.packState.map(x=>[x.itemId,!!x.checked]));
    const total=state.packItems.length;
    const done=state.packItems.filter(x=>checked[x.id]).length;
    return total?`${done}/${total}`:'尚未設定';
  }
  function getEntity(id) { return state.entities.find(e=>e.id===id); }
  function externalPlaceShape(p={}){
    return {kind:'google-place',placeId:String(p.placeId||''),name:String(p.name||p.displayName||'').trim(),address:String(p.address||p.formattedAddress||'').trim(),county:String(p.county||''),district:String(p.district||''),latitude:Number.isFinite(Number(p.latitude))?Number(p.latitude):null,longitude:Number.isFinite(Number(p.longitude))?Number(p.longitude):null,googleMapsUrl:String(p.googleMapsUrl||''),primaryType:String(p.primaryType||''),types:Array.isArray(p.types)?p.types:[],source:String(p.source||'google-places'),searchedAt:p.searchedAt||new Date().toISOString()};
  }
  function stopPlaceObj(s){
    if(!s)return null;
    if(s.entityId)return getEntity(s.entityId)||null;
    if(s.externalPlace)return externalPlaceShape(s.externalPlace);
    return null;
  }
  function backupPlaceObj(s){
    if(!s)return null;
    if(s.backupEntityId)return getEntity(s.backupEntityId)||null;
    if(s.backupExternalPlace)return externalPlaceShape(s.backupExternalPlace);
    return null;
  }
  function stopEvidenceObj(s){
    const p=stopPlaceObj(s);if(!p)return null;
    return s?.entityId?p:{...p,...(s.externalEvidence||{})};
  }
  function placeName(p){return p?.name||p?.displayName||'';}
  function placeMapsUrl(p){
    if(!p)return '';
    if(p.googleMapsUrl)return p.googleMapsUrl;
    if(Number.isFinite(p.latitude)&&Number.isFinite(p.longitude))return `https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}`;
    return '';
  }
  function stopTitle(s) {
    if (s.entityId) return getEntity(s.entityId)?.name || s.customTitle || '已移除項目';
    if (s.externalPlace) return placeName(s.externalPlace) || s.customTitle || 'Google 臨時地點';
    return s.customTitle || STOP_LABELS[s.type] || '未命名站點';
  }

  function renderHome() {
    const trip=getUpcomingTrip();
    const inbox=inboxEntities();
    const unvisited=readyEntities().filter(e=>e.entityType==='attraction'&&!e.visited).slice(0,3);
    const loved=readyEntities().filter(e=>Number.isFinite(e.familyRating)&&e.familyRating>=4).sort((a,b)=>(b.familyRating||0)-(a.familyRating||0)).slice(0,4);
    const prefModel=familyPreferenceModel();
    const prefPicks=prefModel.ready?readyEntities().filter(e=>e.entityType==='attraction'&&!e.visited&&!explicitAgeConflict(e)).map(e=>({e,m:familyPreferenceMatch(e,prefModel)})).filter(x=>x.m.score>0.2).sort((a,b)=>b.m.score-a.m.score).slice(0,3):[];
    const tripToday=trip&&trip.date===todayISO();
    return `${offlineBanner()}
      <section class="hero-card decision-hero">
        <h1>這個週末去哪？</h1>
        <p>用你已收藏的資料快速縮小候選，再直接組成行程。</p>
        <div class="hero-actions"><button class="btn primary" data-decision-open>今天去哪？</button><button class="btn" data-quick-capture>快速收藏</button></div>
      </section>
      <section class="section"><div class="home-stat-grid">
        <button class="home-stat" data-inbox-open><strong>${inbox.length}</strong><span>待整理</span></button>
        <button class="home-stat" data-view-jump="explore"><strong>${readyEntities().filter(e=>!e.visited).length}</strong><span>還沒去</span></button>
        <button class="home-stat" data-view-jump="trips"><strong>${state.itineraries.length}</strong><span>行程</span></button>
      </div></section>
      ${trip?`<section class="section"><div class="section-head"><h2 class="section-title">下一趟出遊</h2><button class="section-link" data-open-trip="${esc(trip.id)}">查看行程</button></div>
        <div class="trip-card home-trip-card"><div class="trip-title">${esc(trip.title)}</div><div class="trip-meta">${esc(fmtDate(trip.date))}・${(trip.stops||[]).length} 站</div>
        ${nextStop(trip)?`<div class="trip-next clickable" data-open-trip="${esc(trip.id)}"><div><small>下一站</small><div><strong>${esc(stopTitle(nextStop(trip)))}</strong></div></div><span>›</span></div>`:''}
        <div class="trip-readiness"><div><span>行程</span><strong>${(trip.stops||[]).length} 站</strong></div><div><span>外出包</span><strong>${packProgressSummary(trip)}</strong></div></div>
        <div class="home-trip-actions">${tripToday?`<button class="btn primary" data-trip-companion="${esc(trip.id)}">開始出遊模式</button>`:`<button class="btn primary" data-open-trip="${esc(trip.id)}">繼續排行程</button>`}<button class="btn" data-view-jump="pack">檢查外出包</button></div></div></section>`:''}
      <section class="section"><div class="section-head"><h2 class="section-title">還沒去過的收藏</h2><button class="section-link" data-view-jump="explore">查看全部</button></div>
        ${unvisited.length?`<div class="card-grid">${unvisited.map(entityCard).join('')}</div>`:`<div class="empty-state"><div class="empty-icon">🌱</div><h3>沒有未去景點</h3><p>看到新的地方就先快速收藏。</p><button class="btn primary" data-quick-capture>快速收藏</button></div>`}
      </section>
      ${prefPicks.length?`<section class="section"><div class="section-head"><h2 class="section-title">依我家偏好</h2><span class="preference-confidence">${esc(prefModel.confidenceLabel)}</span></div><div class="preference-picks">${prefPicks.map(x=>`<button class="preference-pick" data-open-entity="${esc(x.e.id)}"><strong>${esc(x.e.name)}</strong><small>${esc(x.m.label)}・${esc(x.m.reasons.slice(0,2).join('、'))}</small></button>`).join('')}</div></section>`:''}
      ${loved.length?`<section class="section"><div class="section-head"><h2 class="section-title">我家實測喜歡</h2></div><div class="filter-row">${loved.map(e=>`<button class="chip" data-open-entity="${esc(e.id)}">${esc(e.name)}・${e.familyRating}★</button>`).join('')}</div></section>`:''}`;
  }

  function sourcePlatformFromUrl(url='') {
    try {
      const h=new URL(url).hostname.toLowerCase().replace(/^www\./,'');
      if(h.includes('tiktok.com')) return 'TikTok';
      if(h.includes('facebook.com')||h.includes('fb.watch')) return 'Facebook';
      if(h.includes('instagram.com')) return 'Instagram';
      if(h.includes('youtube.com')||h.includes('youtu.be')) return 'YouTube';
      if(h.includes('maps.app.goo.gl')||h.includes('google.com')) return 'Google';
      return h || '網站';
    } catch { return '網站'; }
  }

  function normalizedSourceUrl(url='',depth=0) {
    const raw=String(url||'').trim();
    if(!raw) return '';
    if(depth>2) return raw.replace(/\/$/,'');
    try {
      const u=new URL(raw);
      u.hash='';
      const host=u.hostname.toLowerCase().replace(/^www\./,'');

      // Unwrap common social/share redirect parameters before stripping tracking.
      for(const key of ['share_url','url','u','redirect_uri']){
        const nested=u.searchParams.get(key);
        if(nested && /^https?:\/\//i.test(nested)) return normalizedSourceUrl(nested,depth+1);
      }

      // Canonical content IDs where the same item often arrives through different share wrappers.
      if(host.includes('tiktok.com')){
        const videoId=(u.pathname.match(/\/video\/(\d+)/)||[])[1] || u.searchParams.get('share_item_id');
        if(videoId) return `https://www.tiktok.com/video/${videoId}`;
      }
      if(host.includes('instagram.com')){
        const m=u.pathname.match(/\/(reel|p)\/([^/?#]+)/i);
        if(m) return `https://www.instagram.com/${m[1].toLowerCase()}/${m[2]}`;
      }
      if(host.includes('facebook.com')){
        const reel=(u.pathname.match(/\/reel\/(\d+)/)||[])[1];
        if(reel) return `https://www.facebook.com/reel/${reel}`;
        const videos=(u.pathname.match(/\/videos\/(\d+)/)||[])[1];
        if(videos) return `https://www.facebook.com/videos/${videos}`;
      }
      if(host==='youtube.com'||host==='m.youtube.com'){
        const v=u.searchParams.get('v');
        if(v) return `https://www.youtube.com/watch?v=${encodeURIComponent(v)}`;
      }
      if(host==='youtu.be'){
        const id=u.pathname.split('/').filter(Boolean)[0];
        if(id) return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
      }

      const tracking=['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid','mibextid','igsh','_r','_d','timestamp','share_app_id','share_item_id','u_code','rdid','fs','share_link_id'];
      tracking.forEach(k=>u.searchParams.delete(k));
      u.hostname=host;
      let s=u.toString();
      return s.endsWith('/')?s.slice(0,-1):s;
    } catch { return raw.replace(/\/$/,''); }
  }

  function inboxEntities() {
    return state.entities.filter(e=>e.captureStatus==='inbox').sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
  }

  function readyEntities() { return state.entities.filter(e=>e.captureStatus!=='inbox'); }

  async function migrateDecisionFieldsIfNeeded() {
    const next=[]; let changed=0;
    for(const e of state.entities){
      const explicitIndoor=e.indoor===null && (String(e.note||'').trim()==='室內' || (e.tags||[]).some(t=>String(t).trim()==='室內'));
      const n={...e,
        captureStatus:e.captureStatus||'ready',
        sourcePlatform:e.sourcePlatform||sourcePlatformFromUrl(e.originalUrl||(e.sourceUrls||[])[0]||''),
        indoor:explicitIndoor?true:e.indoor,
        familyRating:Number.isFinite(e.familyRating)?e.familyRating:null,
        revisitIntent:e.revisitIntent||'',
        familyTags:Array.isArray(e.familyTags)?e.familyTags:[],
        familyNote:e.familyNote||'',
        familyReviewedAt:e.familyReviewedAt||''
      };
      next.push(n);
      if(JSON.stringify([e.captureStatus,e.sourcePlatform,e.indoor,e.familyRating,e.revisitIntent,e.familyTags,e.familyNote,e.familyReviewedAt])!==JSON.stringify([n.captureStatus,n.sourcePlatform,n.indoor,n.familyRating,n.revisitIntent,n.familyTags,n.familyNote,n.familyReviewedAt])){
        changed++; await TwinDB.put('entities',{...n,updatedAt:e.updatedAt||new Date().toISOString()});
      }
    }
    state.entities=next;
    return changed;
  }


  let decisionMetadataCache=null;

  async function loadDecisionMetadataCatalog(){
    if(decisionMetadataCache) return decisionMetadataCache;
    try{
      const res=await fetch('./decision-metadata.json',{cache:'no-store'});
      if(!res.ok) throw new Error(`decision_metadata_${res.status}`);
      decisionMetadataCache=await res.json();
      return decisionMetadataCache;
    }catch(err){
      console.warn('Decision metadata unavailable',err);
      return {version:'',entities:{}};
    }
  }

  const DECISION_CATALOG_FIELDS=['decisionMetadataVersion','decisionEligible','environmentType','rainSuitability','toddlerFit','toddlerAccess','strollerFit','waterPlay','visitDuration','decisionTags','decisionAgeNote','decisionMinAgeMonths','decisionMaxAgeMonths','decisionConfidence','decisionEvidenceUrl','decisionEvidenceNote','decisionVerifiedAt','nursingRoomStatus','babyChangingStatus','familyRestroomStatus'];
  function decisionValueMissing(key,value){
    if(value===undefined||value===null||value==='')return true;
    if(['environmentType','rainSuitability','toddlerFit','toddlerAccess','strollerFit','waterPlay','visitDuration','nursingRoomStatus','babyChangingStatus','familyRestroomStatus'].includes(key))return value==='unknown';
    if(key==='decisionConfidence')return value==='U';
    if(key==='decisionTags')return !Array.isArray(value)||value.length===0;
    return false;
  }
  function mergeCatalogMetadataFillMissing(e,m,catalogVersion=''){
    const n={...e};const originalProv={...(e.decisionFieldProvenance||{})};
    const strongestExisting=Math.max(0,...Object.values(originalProv).map(p=>Number(p?.authorityRank||0)));
    const hasModernEvidence=strongestExisting>20||String(e.decisionMetadataVersion||'').startsWith('v4.3.10');
    const globalCatalogFields=new Set(['decisionConfidence','decisionEvidenceUrl','decisionEvidenceNote','decisionVerifiedAt']);
    for(const key of DECISION_CATALOG_FIELDS){
      if(key==='decisionMetadataVersion')continue;
      if(hasModernEvidence&&globalCatalogFields.has(key))continue;
      if(decisionValueMissing(key,n[key]) && !decisionValueMissing(key,m?.[key])) n[key]=m[key];
    }
    if((n.indoor===null||n.indoor===undefined) && (!e.environmentType||e.environmentType==='unknown')){
      if(n.environmentType==='indoor')n.indoor=true;
      else if(n.environmentType==='outdoor')n.indoor=false;
    }
    if(!n.decisionMetadataVersion)n.decisionMetadataVersion=m?.decisionMetadataVersion||catalogVersion||'';
    const prov={...(n.decisionFieldProvenance||{})};
    for(const key of DECISION_CATALOG_FIELDS){
      if(key==='decisionMetadataVersion'||globalCatalogFields.has(key))continue;
      if(!decisionValueMissing(key,n[key]) && !prov[key] && m && n[key]===m[key]){
        prov[key]={sourceType:'catalog',authorityRank:20,url:m.decisionEvidenceUrl||'',verifiedAt:m.decisionVerifiedAt||'',value:n[key]};
      }
    }
    if(hasModernEvidence){
      const ranked=Object.values(prov).filter(p=>Number(p?.authorityRank||0)>20).sort((a,b)=>Number(b.authorityRank||0)-Number(a.authorityRank||0));
      const best=ranked[0];
      if(!n.decisionEvidenceUrl&&best?.url)n.decisionEvidenceUrl=best.url;
      if(!n.decisionVerifiedAt&&best?.verifiedAt)n.decisionVerifiedAt=best.verifiedAt;
      if(!n.decisionConfidence||n.decisionConfidence==='U')n.decisionConfidence=strongestExisting>=85?'A':strongestExisting>=50?'B':'C';
    }
    n.decisionFieldProvenance=prov;
    return n;
  }

  async function migrateDecisionMetadataIfNeeded(){
    const catalog=await loadDecisionMetadataCatalog();
    const version=String(catalog?.version||'');
    const marker=`decisionCatalogMigrated:${version||'unknown'}`;
    if(state.settings[marker]===true)return 0;
    const byId=catalog?.entities||{};let changed=0;const next=[];
    for(const e of state.entities){
      const m=byId[e.id];if(!m){next.push(e);continue;}
      const n=mergeCatalogMetadataFillMissing(e,m,version);
      next.push(n);
      if(JSON.stringify(e)!==JSON.stringify(n)){changed++;await TwinDB.put('entities',{...n,updatedAt:e.updatedAt||new Date().toISOString()});}
    }
    state.entities=next;
    await TwinDB.put('settings',{key:marker,value:true});state.settings[marker]=true;
    return changed;
  }

  async function migrateDecisionConsistencyIfNeeded(){
    let changed=0; const next=[];
    for(const e of state.entities){
      let n=e;
      const derived=deriveRainFromEnvironment(e);
      if((e.rainSuitability||'unknown')==='unknown' && derived!=='unknown'){
        n={...e,rainSuitability:derived,decisionMetadataVersion:e.decisionMetadataVersion||'v4.3.8.2-derived',decisionEvidenceNote:[e.decisionEvidenceNote,derived==='good'?'場域明確為室內，衍生雨天適合':'場域為室內外皆有，衍生雨天部分可玩'].filter(Boolean).join('；'),decisionVerifiedAt:e.decisionVerifiedAt||todayISO()};
        changed++; await TwinDB.put('entities',{...n,updatedAt:e.updatedAt||new Date().toISOString()});
      }
      next.push(n);
    }
    state.entities=next; return changed;
  }

  const DECISION_LABELS={
    environmentType:{indoor:'室內',outdoor:'室外',mixed:'室內外皆有',unknown:'場域待確認'},
    rainSuitability:{good:'雨天佳',partial:'雨天部分可玩',poor:'雨天不建議',unknown:'雨天待確認'},
    toddlerFit:{good:'幼兒適合',partial:'幼兒部分限制',older:'較大再去',unknown:'適齡待確認'},
    toddlerAccess:{good:'幼兒可去',conditional:'幼兒有條件',restricted:'幼兒不建議',unknown:'幼兒可入場待確認'},
    strollerFit:{good:'推車友善',partial:'推車部分可用',poor:'推車較不便',unknown:'推車待確認'},
    waterPlay:{yes:'可玩水',seasonal:'季節性玩水',no:'非玩水景點',unknown:'玩水待確認'}
  };

  function decisionLabel(group,value){
    return DECISION_LABELS[group]?.[value]||'';
  }

  function allCountyOptions(){
    const out=[];
    for(const info of Object.values(GEO_REGION_MAP||{})){
      for(const counties of Object.values(info.groups||{})) for(const c of counties) if(!out.includes(c)) out.push(c);
    }
    return out;
  }

  function deriveRainFromEnvironment(e){
    if((e.rainSuitability||'unknown')!=='unknown') return e.rainSuitability;
    if(e.environmentType==='indoor') return 'good';
    if(e.environmentType==='mixed') return 'partial';
    return 'unknown';
  }

  function decisionFactChips(e,limit=4){
    const values=[
      decisionLabel('environmentType',e.environmentType||'unknown'),
      decisionLabel('rainSuitability',deriveRainFromEnvironment(e)),
      decisionLabel('toddlerFit',e.toddlerFit||'unknown')
    ];
    const access=e.toddlerAccess||'unknown';
    if(access==='conditional'||access==='restricted'||(access==='good'&&e.toddlerFit!=='good')) values.push(decisionLabel('toddlerAccess',access));
    values.push(decisionLabel('strollerFit',e.strollerFit||'unknown'));
    return values.filter(Boolean).slice(0,limit).map(x=>`<span class="decision-fact">${esc(x)}</span>`).join('');
  }

  function babyCareChips(e){
    const rows=[];
    if(e.nursingRoomStatus==='available') rows.push('哺乳室');
    else if(e.nursingRoomStatus==='unavailable') rows.push('無哺乳室');
    if(e.babyChangingStatus==='available') rows.push('尿布台');
    if(e.familyRestroomStatus==='available') rows.push('親子廁所');
    return rows.map(x=>`<span class="decision-fact baby-care">${esc(x)}</span>`).join('');
  }
  function babyCareStatusLabel(v){
    return v==='available'?'有':v==='unavailable'?'無':'待確認';
  }
  function babyCareStatusRow(e){
    const items=[
      ['哺乳室',e.nursingRoomStatus],['尿布台',e.babyChangingStatus],['親子廁所',e.familyRestroomStatus]
    ];
    return `<div class="baby-care-status"><strong>育兒設施</strong><div>${items.map(([label,v])=>`<span class="baby-care-status-item ${v==='available'?'yes':v==='unavailable'?'no':'unknown'}">${esc(label)}：${babyCareStatusLabel(v)}</span>`).join('')}</div></div>`;
  }

  const DECISION_FIELD_LABELS={environmentType:'場域類型',rainSuitability:'雨天',toddlerFit:'幼兒適合度',toddlerAccess:'幼兒可入場',strollerFit:'推車',nursingRoomStatus:'哺乳室',babyChangingStatus:'尿布台',familyRestroomStatus:'親子廁所',decisionAgeNote:'年齡／身高條件',ageNote:'人工適齡資料'};
  function decisionEvidenceDetails(e){
    const prov=e.decisionFieldProvenance||{};
    const rows=Object.entries(prov).filter(([field,p])=>p&&p.url&&DECISION_FIELD_LABELS[field]).sort((a,b)=>Number(b[1].authorityRank||0)-Number(a[1].authorityRank||0));
    if(!rows.length)return '';
    return `<details class="decision-evidence-details"><summary>各欄位查證依據</summary><div class="decision-evidence-list">${rows.map(([field,p])=>`<a href="${esc(p.url)}" target="_blank" rel="noopener"><strong>${esc(DECISION_FIELD_LABELS[field])}</strong><span>${esc(decisionEvidenceSourceLabel(p.sourceType||''))}${p.verifiedAt?`・${esc(p.verifiedAt)}`:''}</span></a>`).join('')}</div></details>`;
  }
  function decisionEvidenceSourceLabel(t=''){return ({manual:'人工確認',official:'官方',government:'政府',first_party:'官方網站',verified_source:'已驗證來源',web_source:'網路來源',google:'Google Places',catalog:'舊資料補值',derived:'衍生判定',legacy_auto:'舊版自動判定'}[t]||t||'來源');}

  function decisionMetadataInfo(e){
    if(!e.decisionMetadataVersion) return '';
    const confidence=e.decisionConfidence||'U';
    const confLabel={A:'A 高可信',B:'B 可用',C:'C 推定',U:'未分類'}[confidence]||confidence;
    return `<div class="info-box decision-meta-box">
      <h3>出遊判斷資料 <span class="badge">${esc(confLabel)}</span></h3>
      <div class="family-tags">${decisionFactChips(e,5)}${babyCareChips(e)}${e.waterPlay&&e.waterPlay!=='unknown'?`<span>${esc(decisionLabel('waterPlay',e.waterPlay))}</span>`:''}</div>
      ${babyCareStatusRow(e)}
      ${e.decisionAgeNote?`<p style="margin-top:10px">${esc(e.decisionAgeNote)}</p>`:''}
      <div class="helper">最後查證：${esc(e.decisionVerifiedAt||'未記錄')}。『幼兒可去』只代表可入場／有幼兒服務，不等於整體遊玩內容一定最適合目前年齡；未知資料不會被當成不適合。</div>
      ${e.decisionEvidenceUrl?`<a class="btn ghost small" href="${esc(e.decisionEvidenceUrl)}" target="_blank" rel="noopener">主要查證來源</a>`:''}
      ${decisionEvidenceDetails(e)}
    </div>`;
  }

  function familyRatingBadge(e){
    return Number.isFinite(e.familyRating)?`<span class="badge family">我家 ${'★'.repeat(Math.max(1,Math.min(5,e.familyRating)))}</span>`:'';
  }

  const FAMILY_TAGS = {
    stroller:'推車方便', strollerHard:'推車不便', parking:'停車方便', parkingHard:'停車不便', diaper:'尿布台', highchair:'兒童餐椅',
    elevator:'電梯方便', mealEasy:'吃飯方便', shade:'遮陽不錯', exitEasy:'方便中途撤退',
    energy:'很放電', sunny:'偏曬', rainy:'雨天友善', water:'玩水', crowd:'人多', queue:'排隊久', reservation:'需預約', toddler:'幼兒友善'
  };

  const PREFERENCE_FEATURE_LABELS={
    'type:attraction':'景點','type:hotel':'住宿','type:restaurant':'餐廳','type:activity':'其他收藏',
    'env:indoor':'室內','env:outdoor':'戶外','env:mixed':'室內外皆有',
    'toddler:good':'幼兒適合','toddler:partial':'幼兒部分可玩',
    'stroller:good':'推車友善','stroller:partial':'推車部分可用','stroller:poor':'推車較不便',
    'water:yes':'玩水','water:seasonal':'季節玩水','duration:short':'短時行程','duration:half':'半日行程','duration:full':'一日行程',
    'place:zoo':'動物園','place:aquarium':'水族館','place:museum':'博物館','place:park':'公園','place:amusement_park':'樂園','place:playground':'遊戲場','place:shopping_mall':'商場'
  };
  function familyFriction(e){
    let score=0,known=0;const reasons=[],warnings=[],tags=new Set(Array.isArray(e?.familyTags)?e.familyTags:[]);
    const add=(v,text,negative=false)=>{score+=v;known++;(negative?warnings:reasons).push(text);};
    // Family-tested signals outrank automated metadata; corrupted contradictory tags never get scored.
    const strollerTagGood=tags.has('stroller'),strollerTagHard=tags.has('strollerHard');
    if(strollerTagGood&&strollerTagHard)warnings.push('推車實測標記衝突');
    else if(strollerTagGood)add(2.3,'我家實測推車方便');
    else if(strollerTagHard)add(-2.3,'我家實測推車不便',true);
    else if(e?.strollerFit==='good')add(2,'推車友善');else if(e?.strollerFit==='partial')add(.5,'推車部分可用');else if(e?.strollerFit==='poor')add(-2,'推車較不便',true);
    if(e?.nursingRoomStatus==='available')add(1,'有哺乳室');else if(e?.nursingRoomStatus==='unavailable')add(-.6,'無哺乳室',true);
    if(tags.has('diaper'))add(1,'我家實測有尿布台');
    else if(e?.babyChangingStatus==='available')add(1,'有尿布台');else if(e?.babyChangingStatus==='unavailable')add(-.6,'無尿布台',true);
    if(e?.familyRestroomStatus==='available')add(1,'有親子廁所');else if(e?.familyRestroomStatus==='unavailable')add(-.4,'無親子廁所',true);
    if(e?.environmentType==='indoor')add(.7,'室內較好照顧');
    if(tags.has('parking')&&tags.has('parkingHard'))warnings.push('停車實測標記衝突');
    else if(tags.has('parking'))add(1.3,'停車方便');else if(tags.has('parkingHard'))add(-1.8,'停車不便',true);
    for(const [tag,val,text,neg] of [['highchair',.5,'有兒童餐椅',0],['elevator',.8,'電梯方便',0],['mealEasy',.7,'吃飯方便',0],['shade',.5,'遮陽不錯',0],['exitEasy',.8,'方便中途撤退',0],['sunny',-.7,'偏曬',1],['crowd',-1,'人多',1],['queue',-1.5,'排隊久',1],['reservation',-.4,'需預約',1]])if(tags.has(tag))add(val,text,!!neg);
    if(known<2)return {label:'資料不足',level:'unknown',score:0,known,reasons,warnings};
    const label=score>=4?'很輕鬆':score>=2?'輕鬆':score>=0?'普通':'比較費力';
    const level=score>=4?'excellent':score>=2?'good':score>=0?'fair':'hard';
    return {label,level,score:Number(score.toFixed(2)),known,reasons:[...new Set(reasons)],warnings:[...new Set(warnings)]};
  }
  function frictionHtml(e,{compact=false}={}){
    const f=familyFriction(e);if(f.level==='unknown')return `<div class="friction-card unknown"><strong>帶娃輕鬆度：資料不足</strong>${compact?'':`<small>未知資料不扣分；實測或官方資料增加後會更準。</small>`}</div>`;
    return `<div class="friction-card ${esc(f.level)}"><strong>帶娃輕鬆度：${esc(f.label)}</strong>${compact?'':`<div class="friction-reasons">${f.reasons.slice(0,4).map(x=>`<span>✓ ${esc(x)}</span>`).join('')}${f.warnings.slice(0,3).map(x=>`<span class="warn">△ ${esc(x)}</span>`).join('')}</div><small>只用已確認／我家實測資料；未知項目不扣分。</small>`}</div>`;
  }
  function preferenceFeatures(e){
    const out=new Set();if(!e)return [];
    if(e.entityType)out.add(`type:${e.entityType}`);
    if(['indoor','outdoor','mixed'].includes(e.environmentType))out.add(`env:${e.environmentType}`);
    if(['good','partial'].includes(e.toddlerFit))out.add(`toddler:${e.toddlerFit}`);
    if(['good','partial','poor'].includes(e.strollerFit))out.add(`stroller:${e.strollerFit}`);
    if(['yes','seasonal'].includes(e.waterPlay))out.add(`water:${e.waterPlay}`);
    if(e.visitDuration==='1-2h')out.add('duration:short');else if(e.visitDuration==='half-day')out.add('duration:half');else if(e.visitDuration==='full-day')out.add('duration:full');
    const types=new Set([e.placePrimaryType,...(e.placeTypes||[])].filter(Boolean));for(const t of ['zoo','aquarium','museum','park','amusement_park','playground','shopping_mall'])if(types.has(t))out.add(`place:${t}`);
    return [...out];
  }
  function familyPreferenceModel(){
    const validRating=e=>Number.isFinite(e?.familyRating)&&Number(e.familyRating)>=1&&Number(e.familyRating)<=5,validRevisit=e=>['yes','maybe','no'].includes(e?.revisitIntent);
    const samples=readyEntities().filter(e=>e.visited&&(validRating(e)||validRevisit(e)));const stats={};
    for(const e of samples){let outcome=validRating(e)?Number(e.familyRating)-3:0;if(e.revisitIntent==='yes')outcome+=.7;else if(e.revisitIntent==='no')outcome-=.7;else if(e.revisitIntent==='maybe')outcome-=.05;for(const f of preferenceFeatures(e)){stats[f]??={sum:0,count:0};stats[f].sum+=outcome;stats[f].count++;}}
    const weights={};for(const [f,v] of Object.entries(stats))if(v.count>=2)weights[f]={score:v.sum/v.count,count:v.count};
    const n=samples.length,ready=n>=4&&Object.keys(weights).length>0,confidence=n>=10?'high':n>=6?'medium':'low';
    return {sampleCount:n,weights,ready,confidence,confidenceLabel:!ready?`學習中 ${n}/4`:confidence==='high'?'可信度高':confidence==='medium'?'可信度中':'可信度初步'};
  }
  function familyPreferenceMatch(e,model=familyPreferenceModel()){
    if(!model.ready)return {label:'家庭偏好學習中',score:0,reasons:[],sampleCount:model.sampleCount};
    const matched=preferenceFeatures(e).map(f=>({f,...(model.weights[f]||{})})).filter(x=>Number.isFinite(x.score));
    if(!matched.length)return {label:'偏好資料不足',score:0,reasons:[],sampleCount:model.sampleCount};
    const specificity=f=>f.startsWith('type:')?0.3:f.startsWith('place:')?1.25:f.startsWith('water:')?1.15:f.startsWith('duration:')?0.7:1;
    const weighted=matched.reduce((a,x)=>a+x.score*Math.min(3,x.count)*specificity(x.f),0)/matched.reduce((a,x)=>a+Math.min(3,x.count)*specificity(x.f),0);
    const positive=matched.filter(x=>x.score>.15).sort((a,b)=>b.score-a.score).slice(0,3);
    const reasons=positive.map(x=>PREFERENCE_FEATURE_LABELS[x.f]||x.f);
    const label=weighted>=.75?'很符合我家':weighted>=.2?'可能符合我家':weighted<=-.65?'較不像我家過去偏好':'偏好中性';
    return {label,score:Number(weighted.toFixed(3)),reasons,sampleCount:model.sampleCount,confidence:model.confidence};
  }
  function preferenceHtml(e){
    const model=familyPreferenceModel(),m=familyPreferenceMatch(e,model);
    if(!model.ready)return `<div class="preference-card learning"><strong>家庭偏好：學習中</strong><small>目前 ${model.sampleCount} 次可用實測；累積至少 4 次後才開始推薦，不會假裝已經懂你家。</small></div>`;
    return `<div class="preference-card ${m.score>.2?'match':''}"><strong>${esc(m.label)}</strong><small>${m.reasons.length?`因為你家過去較喜歡：${esc(m.reasons.join('、'))}`:'目前沒有足夠相同特徵'}・${esc(model.confidenceLabel)}</small></div>`;
  }

  function familyReviewModal(e){
    const tags=new Set(e.familyTags||[]);
    showModal('我家實測', `<form id="familyReviewForm" class="form-grid">
      <div class="setting-block"><h3>${esc(e.name)}</h3><p>只記你們實際去過後的感受；不知道的不要填。</p></div>
      <div class="field"><label>雙寶喜歡程度</label><select name="familyRating"><option value="">未評分</option>${[5,4,3,2,1].map(n=>`<option value="${n}" ${e.familyRating===n?'selected':''}>${n} ★</option>`).join('')}</select></div>
      <div class="field"><label>還會再去嗎？</label><select name="revisitIntent"><option value="" ${!e.revisitIntent?'selected':''}>未設定</option><option value="yes" ${e.revisitIntent==='yes'?'selected':''}>會</option><option value="maybe" ${e.revisitIntent==='maybe'?'selected':''}>看情況</option><option value="no" ${e.revisitIntent==='no'?'selected':''}>不會</option></select></div>
      <div class="field"><label>快速標籤</label><div class="review-tag-grid">${Object.entries(FAMILY_TAGS).map(([k,l])=>`<label class="tag-check"><input type="checkbox" name="familyTag" value="${k}" ${tags.has(k)?'checked':''}><span>${l}</span></label>`).join('')}</div></div>
      <div class="field"><label>我家備註</label><textarea name="familyNote" placeholder="例如：午睡後去比較剛好、推車到某區不好推…">${esc(e.familyNote||'')}</textarea></div>
      <div class="form-actions"><button type="button" class="btn" data-close-modal>取消</button><button class="btn primary">儲存實測</button></div>
    </form>`);
    for(const [a,b] of [['stroller','strollerHard'],['parking','parkingHard']]){
      for(const key of [a,b])$('#familyReviewForm')?.querySelector(`input[name="familyTag"][value="${key}"]`)?.addEventListener('change',ev=>{if(!ev.target.checked)return;const other=key===a?b:a;const peer=$('#familyReviewForm')?.querySelector(`input[name="familyTag"][value="${other}"]`);if(peer)peer.checked=false;});
    }
    $('#familyReviewForm').addEventListener('submit',async ev=>{
      ev.preventDefault(); const fd=new FormData(ev.currentTarget);
      const latest=await TwinDB.get('entities',e.id)||e;
      const rating=fd.get('familyRating')?Number(fd.get('familyRating')):null;
      const out={...latest,visited:true,familyRating:rating,revisitIntent:String(fd.get('revisitIntent')||''),familyTags:fd.getAll('familyTag').map(String),familyNote:String(fd.get('familyNote')||'').trim(),familyReviewedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      await TwinDB.put('entities',out); await reloadData(); closeModal(); render(); toast('我家實測已儲存');
    });
  }

  let quickCaptureState={existingId:'',candidates:[],sourceTitle:'',suggestedName:'',sourceMeta:null};
  const captureAutoRunning=new Set();

  function sanitizeCaptureTitle(title='',platform=''){
    let s=String(title||'').replace(/\s+/g,' ').trim();
    s=s.replace(/\s*[|｜\-–—]\s*(Facebook|Instagram|TikTok|Threads|YouTube).*$/i,'').trim();
    s=s.replace(/^(Facebook|Instagram|TikTok|Threads|YouTube)\s*[:：\-–—]?\s*/i,'').trim();
    const generic=s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g,' ').trim();
    const blocked=new Set([
      'facebook','instagram','tiktok','threads','youtube','首頁','home',
      'make your day','log in or sign up','login or sign up','log in','login','sign up',
      'watch videos','photos and videos','discover more','page not found','content unavailable'
    ]);
    if(!s || blocked.has(generic)) return '';
    if(/^(facebook|instagram|tiktok|threads|youtube)(\s|$)/i.test(generic)) return '';
    if(generic.length<2) return '';
    if(s.length>120) s=s.slice(0,120).trim();
    return s;
  }

  function captureDuplicateForUrl(url,excludeId=''){
    const normalized=normalizedSourceUrl(url);
    if(!normalized) return null;
    return state.entities.find(e=>e.id!==excludeId && captureCanonicalUrls(e).includes(normalized))||null;
  }

  function captureBaseEntity({url,name,entityType,existing=null,captureStatus='inbox'}){
    const now=new Date().toISOString();
    return {
      ...(existing||{}),
      id:existing?.id||uuid(entityType), entityType,
      name:name||existing?.name||'待整理收藏',
      region:existing?.region||'',cityRaw:existing?.cityRaw||'',county:existing?.county||'',district:existing?.district||'',
      address:existing?.address||'',latitude:existing?.latitude??null,longitude:existing?.longitude??null,googleMapsUrl:existing?.googleMapsUrl||'',
      note:existing?.note||'',ageNote:existing?.ageNote||'',minAgeMonths:existing?.minAgeMonths??null,maxAgeMonths:existing?.maxAgeMonths??null,
      indoor:existing?.indoor??null,tags:existing?.tags||[],favorite:existing?.favorite??true,visited:existing?.visited??false,
      sourceUrls:[url,...(existing?.sourceUrls||[]).filter(x=>normalizedSourceUrl(x)!==normalizedSourceUrl(url))],originalUrl:url,
      coverImage:existing?.coverImage||'',images:existing?.images||[],imageSource:existing?.imageSource||'',imageUpdatedAt:existing?.imageUpdatedAt||'',
      sourceCoverUrl:existing?.sourceCoverUrl||'',sourceCoverStatus:existing?.sourceCoverStatus||'',sourceCoverMethod:existing?.sourceCoverMethod||'',
      sourceCoverDomain:existing?.sourceCoverDomain||'',sourceCoverPageUrl:existing?.sourceCoverPageUrl||'',googlePlaceId:existing?.googlePlaceId||'',
      placeDisplayName:existing?.placeDisplayName||'',placeMatchStatus:existing?.placeMatchStatus||'',captureStatus,sourcePlatform:sourcePlatformFromUrl(url),
      familyRating:Number.isFinite(existing?.familyRating)?existing.familyRating:null,revisitIntent:existing?.revisitIntent||'',familyTags:existing?.familyTags||[],
      familyNote:existing?.familyNote||'',familyReviewedAt:existing?.familyReviewedAt||'',createdAt:existing?.createdAt||now,updatedAt:now
    };
  }


  function captureAutomationBadge(e){
    const status=e.captureAutoStatus||'queued';
    const map={
      queued:['⏳','等待自動整理'],running:['⏳','自動整理中'],found:['✓','已找到候選'],article_found:['✓','已辨識標題'],
      needs_name:['!','需要名稱'],no_match:['!','尚未找到地點'],offline:['!','等待網路'],retry_wait:['⏳','稍後自動重試'],duplicate:['!','疑似重複收藏'],error:['!','自動整理失敗']
    };
    const [icon,label]=map[status]||['','待整理'];
    return `<span class="capture-auto-badge status-${esc(status)}">${icon} ${label}</span>`;
  }

  function captureCandidatesHtml(candidates=[],sourceTitle=''){
    if(!candidates.length) return '';
    return `${sourceTitle?`<div class="capture-source-preview"><span class="badge">來源辨識</span><strong>${esc(sourceTitle)}</strong></div>`:''}<div class="candidate-list capture-candidates">${candidates.map((c,i)=>`<button type="button" class="candidate-card" data-capture-choose="${i}"><strong>${esc(c.displayName||'未命名')}</strong><span>${esc(c.formattedAddress||'地址未提供')}</span>${c.primaryTypeLabel?`<small>${esc(c.primaryTypeLabel)}</small>`:''}<small>${c.exactName?'名稱完全符合':`名稱相似 ${Math.round((c.similarity||0)*100)}%`}${c.hasPhoto?'・有照片':''}</small><em>確認這個並收藏</em></button>`).join('')}</div><div class="helper">自動整理已先把候選找好；請確認正確地點後再轉正式收藏。</div>`;
  }

  function storedCaptureResultsHtml(e){
    if(!e) return `<div class="helper">貼上網址後，可直接先存待整理；系統會自動開始整理。</div>`;
    const status=e.captureAutoStatus||'queued';
    if((status==='found') && Array.isArray(e.captureCandidates) && e.captureCandidates.length){
      return `${captureAutomationBadge(e)}${captureCandidatesHtml(e.captureCandidates,e.captureSourceTitle||e.captureSuggestedName||'')}`;
    }
    if(status==='article_found' && e.captureSuggestedName){
      return `${captureAutomationBadge(e)}<div class="capture-source-preview"><span class="badge">已辨識</span><strong>${esc(e.captureSuggestedName)}</strong><small>其他收藏不需綁 Google 地點。</small></div><button class="btn primary full" data-capture-save-article>確認名稱並正式收藏</button>`;
    }
    if(status==='running'||status==='queued') return `${captureAutomationBadge(e)}<div class="helper">可以先離開；若中途關閉，下次開 App 會立即接手未完成的項目。</div>`;
    if(status==='needs_name') return `${captureAutomationBadge(e)}<div class="helper">來源平台沒有提供可用標題，因此目前唯一需要你補的是地點名稱／關鍵字。</div>`;
    if(status==='no_match') return `${captureAutomationBadge(e)}${e.captureSuggestedName?`<div class="capture-source-preview"><span class="badge">已辨識名稱</span><strong>${esc(e.captureSuggestedName)}</strong></div>`:''}<div class="helper">已自動搜尋，但 Google Places 沒有可靠候選；可改名稱後重新搜尋。</div>`;
    if(status==='offline') return `${captureAutomationBadge(e)}<div class="helper">恢復網路後會再處理。</div>`;
    if(status==='retry_wait') return `${captureAutomationBadge(e)}<div class="helper">暫時性網路/API錯誤，系統會自動退避後重試，不需要手動重按。</div>`;
    if(status==='duplicate') return `${captureAutomationBadge(e)}<div class="helper">已解析到與既有收藏相同的來源：${esc(e.captureDuplicateName||'既有收藏')}。</div>${e.captureDuplicateId?`<button class="btn small" data-open-capture-duplicate="${esc(e.captureDuplicateId)}">打開既有收藏</button>`:''}`;
    if(status==='error') return `${captureAutomationBadge(e)}<div class="helper">本次自動整理失敗，可按「重新找資料」。</div>`;
    return `<div class="helper">尚未自動整理。</div>`;
  }

  function refreshInboxModalIfOpen(){
    if(!modalRoot.hidden && modalRoot.querySelector('.modal-title')?.textContent==='待整理') inboxModal();
  }

  let captureResumePromise=null;
  let captureResumeTimer=null;
  const CAPTURE_RETRY_DELAYS=[5000,15000,60000,180000,600000];

  function captureRetryDelay(attempt=1){
    return CAPTURE_RETRY_DELAYS[Math.min(Math.max(0,attempt-1),CAPTURE_RETRY_DELAYS.length-1)];
  }

  async function fetchJsonResponseWithTimeout(url,options={},timeoutMs=12000){
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
    try{
      const res=await fetch(url,{...options,signal:ctrl.signal});
      let data={}; try{data=await res.json();}catch{}
      return {res,data};
    }finally{ clearTimeout(timer); }
  }

  function scheduleInboxAutomation(delayMs=0){
    if(captureResumeTimer) clearTimeout(captureResumeTimer);
    captureResumeTimer=setTimeout(()=>{
      captureResumeTimer=null;
      resumeInboxAutomation().catch(()=>{});
    },Math.max(0,delayMs));
  }

  function scheduleNextInboxRetry(){
    if(!navigator.onLine) return;
    const now=Date.now();
    let next=null;
    for(const e of inboxEntities()){
      if((e.captureAutoStatus||'')!=='retry_wait') continue;
      const t=Date.parse(e.captureAutoNextRetryAt||'');
      if(Number.isFinite(t) && t>now && (next===null||t<next)) next=t;
    }
    if(next!==null) scheduleInboxAutomation(Math.max(250,next-now+50));
  }

  function inboxNeedsAutoResolve(e){
    if(!e || e.captureStatus!=='inbox') return false;
    const status=e.captureAutoStatus||'queued';
    if(status==='queued'||status==='offline') return true;
    if(status==='running') return !captureAutoRunning.has(e.id); // after reload, immediately recover persisted running state
    if(status==='retry_wait'){
      const t=Date.parse(e.captureAutoNextRetryAt||'');
      return !Number.isFinite(t) || Date.now()>=t;
    }
    return false;
  }

  function captureCanonicalUrls(e){
    return [e?.originalUrl,...(e?.sourceUrls||[]),e?.captureSourceMeta?.finalUrl,e?.sourceCoverPageUrl]
      .filter(Boolean).map(normalizedSourceUrl).filter(Boolean);
  }

  function findCaptureDuplicateByCanonical(urls=[],excludeId=''){
    const wanted=new Set(urls.filter(Boolean));
    if(!wanted.size) return null;
    return state.entities.find(x=>x.id!==excludeId && captureCanonicalUrls(x).some(u=>wanted.has(u)))||null;
  }

  async function autoResolveInboxEntity(entityOrId,{force=false}={}){
    let e=typeof entityOrId==='string' ? (getEntity(entityOrId)||await TwinDB.get('entities',entityOrId)) : entityOrId;
    if(!e || e.captureStatus!=='inbox') return {status:'skip'};
    if(captureAutoRunning.has(e.id)) return {status:'running'};
    if(!force && !inboxNeedsAutoResolve(e)) return {status:'skip'};
    captureAutoRunning.add(e.id);
    try{
      if(!navigator.onLine){
        const out={...e,captureAutoStatus:'offline',captureAutoUpdatedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
        await TwinDB.put('entities',out);await reloadData();render();refreshInboxModalIfOpen();return {status:'offline'};
      }
      let working={...e,captureAutoStatus:'running',captureAutoUpdatedAt:new Date().toISOString(),captureAutoNextRetryAt:'',updatedAt:new Date().toISOString()};
      await TwinDB.put('entities',working);await reloadData();render();refreshInboxModalIfOpen();
      const url=working.originalUrl||working.sourceUrls?.[0]||'';
      let source={};
      if(url){
        try{
          const {data}=await fetchJsonResponseWithTimeout('/api/source-cover',{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',body:JSON.stringify({url,name:''})},10000);
          source=data||{};
        }catch(_){ source={}; }
      }
      const resolvedCanonical=normalizedSourceUrl(source.finalUrl||url);
      const duplicate=findCaptureDuplicateByCanonical([normalizedSourceUrl(url),resolvedCanonical],working.id);
      if(duplicate){
        const out={...working,captureAutoStatus:'duplicate',captureDuplicateId:duplicate.id,captureDuplicateName:duplicate.name||'既有收藏',captureSourceMeta:{reason:source.reason||'',finalUrl:source.finalUrl||'',hasImage:!!source.imageUrl},captureAutoUpdatedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
        await TwinDB.put('entities',out);await reloadData();render();refreshInboxModalIfOpen();return {status:'duplicate'};
      }
      const sourceTitle=sanitizeCaptureTitle(source.pageTitle||'',sourcePlatformFromUrl(url));
      const existingName=working.name && working.name!=='待整理收藏' ? sanitizeCaptureTitle(working.name,sourcePlatformFromUrl(url)) : '';
      const searchName=existingName||sourceTitle;
      const common={...working,captureSourceTitle:sourceTitle||working.captureSourceTitle||'',captureSuggestedName:searchName||working.captureSuggestedName||'',captureSourceMeta:{reason:source.reason||'',finalUrl:source.finalUrl||'',hasImage:!!source.imageUrl},captureAutoAttempts:0,captureAutoNextRetryAt:'',captureAutoUpdatedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      if(working.entityType==='activity'){
        const out={...common,captureAutoStatus:searchName?'article_found':'needs_name',captureCandidates:[]};
        await TwinDB.put('entities',out);await reloadData();render();refreshInboxModalIfOpen();return {status:out.captureAutoStatus};
      }
      if(!searchName){
        const out={...common,captureAutoStatus:'needs_name',captureCandidates:[]};
        await TwinDB.put('entities',out);await reloadData();render();refreshInboxModalIfOpen();return {status:'needs_name'};
      }
      const {res,data}=await fetchJsonResponseWithTimeout('/api/place-search',{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',body:JSON.stringify({name:searchName,location:'',entityType:working.entityType,branchRisk:false})},12000);
      if(!res.ok) throw new Error(data.message||data.error||`place_search_${res.status}`);
      const candidates=(data.candidates||[]).slice(0,5);
      const out={...common,captureAutoStatus:candidates.length?'found':'no_match',captureCandidates:candidates,captureAutoDecisionReason:data.decisionReason||'',captureAutoCandidateCount:candidates.length};
      await TwinDB.put('entities',out);await reloadData();render();refreshInboxModalIfOpen();return {status:out.captureAutoStatus,candidates};
    }catch(err){
      const current=getEntity(e.id)||await TwinDB.get('entities',e.id)||e;
      const attempt=(Number(current.captureAutoAttempts)||0)+1;
      const delay=captureRetryDelay(attempt);
      const nextAt=new Date(Date.now()+delay).toISOString();
      const retryable=attempt<=5;
      const out={...current,captureAutoStatus:retryable?'retry_wait':'error',captureAutoAttempts:attempt,captureAutoNextRetryAt:retryable?nextAt:'',captureAutoError:String(err?.name==='AbortError'?'timeout':err?.message||'auto_resolve_error'),captureAutoUpdatedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      await TwinDB.put('entities',out);await reloadData();render();refreshInboxModalIfOpen();
      if(retryable) scheduleInboxAutomation(delay+100);
      return {status:out.captureAutoStatus};
    }finally{
      captureAutoRunning.delete(e.id);
    }
  }

  async function resumeInboxAutomation({batchSize=3,maxTotal=50}={}){
    if(!navigator.onLine) return {processed:0};
    if(captureResumePromise) return captureResumePromise;
    captureResumePromise=(async()=>{
      let processed=0;
      while(navigator.onLine && processed<maxTotal){
        const rows=inboxEntities().filter(inboxNeedsAutoResolve).slice(0,batchSize);
        if(!rows.length) break;
        for(const e of rows){
          await autoResolveInboxEntity(e).catch(()=>{});
          processed++;
          if(processed>=maxTotal||!navigator.onLine) break;
          await new Promise(r=>setTimeout(r,120));
        }
      }
      if(navigator.onLine && inboxEntities().some(inboxNeedsAutoResolve)) scheduleInboxAutomation(250);
      else scheduleNextInboxRetry();
      return {processed};
    })();
    try{return await captureResumePromise;}finally{captureResumePromise=null;}
  }

  async function confirmStoredInboxCandidate(entityId,index=0){
    const e=getEntity(entityId)||await TwinDB.get('entities',entityId);
    const c=e?.captureCandidates?.[index];
    if(!e||!c) return;
    const base={...e,name:c.displayName||e.captureSuggestedName||e.name,captureStatus:'ready',captureAutoStatus:'confirmed',captureCandidates:[],updatedAt:new Date().toISOString()};
    const out=inferGeoEntity(applyPlaceCandidateToEntity(base,c));
    await TwinDB.put('entities',out);state.photoSession.clear();await reloadData();closeModal();setView('detail',{entityId:out.id});toast(`已確認並收藏「${out.name}」`);autoEnrichEntity(out,{interactive:false,silent:true}).catch(()=>{});
  }

  function quickCaptureModal(existing=null){
    quickCaptureState={existingId:existing?.id||'',candidates:[...(existing?.captureCandidates||[])],sourceTitle:existing?.captureSourceTitle||'',suggestedName:existing?.captureSuggestedName||'',sourceMeta:existing?.captureSourceMeta||null};
    const draftName=existing && existing.name!=='待整理收藏' ? existing.name : (existing?.captureSuggestedName||'');
    const url=existing?.originalUrl||'';
    const entityType=existing?.entityType||'attraction';
    showModal(existing?'整理快速收藏':'快速收藏', `<form id="quickCaptureForm" class="form-grid">
      <div class="setting-block"><h3>貼網址 → 找資料 → 你確認 → 才正式儲存</h3><p>找不到可靠資料也沒關係，可先放進「待整理」，之後再回來確認。</p></div>
      <div class="field"><label>FB／TikTok／網站網址 *</label><div class="capture-url-row"><input id="quickCaptureUrl" name="url" type="url" required value="${esc(url)}" placeholder="https://..."/><button type="button" class="btn" data-paste-capture>貼上</button></div></div>
      <div class="inline-fields"><div class="field"><label>類型</label><select id="quickCaptureType" name="entityType">${Object.entries(TYPE_LABELS).map(([v,l])=>`<option value="${v}" ${entityType===v?'selected':''}>${l}</option>`).join('')}</select></div><div class="field"><label>名稱／搜尋關鍵字</label><input id="quickCaptureName" name="name" maxlength="120" value="${esc(draftName)}" placeholder="可留白，先從網址辨識"/></div></div>
      <div class="form-actions capture-actions"><button type="button" class="btn" data-capture-save-inbox>先存待整理</button><button class="btn primary" type="submit">一鍵找相關資料</button></div>
      <div id="quickCaptureResults" class="capture-results">${storedCaptureResultsHtml(existing)}</div>
    </form>`,{wide:true});
    $('#quickCaptureForm').addEventListener('submit',async ev=>{ev.preventDefault();await resolveQuickCaptureFromModal();});
  }

  async function resolveQuickCaptureFromModal(){
    const url=String($('#quickCaptureUrl')?.value||'').trim();
    const type=String($('#quickCaptureType')?.value||'attraction');
    const manualName=String($('#quickCaptureName')?.value||'').trim();
    const root=$('#quickCaptureResults');
    if(!url||!root) return;
    const duplicate=captureDuplicateForUrl(url,quickCaptureState.existingId);
    if(duplicate){root.innerHTML=`<div class="empty-state compact"><h3>這個來源已收藏</h3><p>${esc(duplicate.name||'待整理收藏')}</p><button class="btn primary" data-open-capture-duplicate="${esc(duplicate.id)}">打開這筆</button></div>`;return;}
    if(!navigator.onLine){root.innerHTML=`<div class="empty-state compact"><h3>目前離線</h3><p>可以先存待整理；有網路時再回來一鍵搜尋。</p></div>`;return;}
    root.innerHTML=`<div class="capture-loading"><strong>正在讀取來源並搜尋相關地點…</strong><small>不會在你確認前寫入正式收藏。</small></div>`;
    let source={};
    try{source=await fetchJsonWithTimeout('/api/source-cover',{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',body:JSON.stringify({url,name:''})},12000);}catch(_){}
    const title=sanitizeCaptureTitle(source.pageTitle||'',sourcePlatformFromUrl(url));
    quickCaptureState.sourceTitle=title;quickCaptureState.sourceMeta=source;
    const searchName=manualName||title;quickCaptureState.suggestedName=searchName;
    if(!manualName&&title) $('#quickCaptureName').value=title;
    if(type==='activity'){
      if(!searchName){root.innerHTML=`<div class="empty-state compact"><h3>無法從網址辨識標題</h3><p>請輸入一個名稱後再搜尋，或先存待整理。</p></div>`;return;}
      root.innerHTML=`<div class="capture-source-preview"><span class="badge">來源辨識</span><strong>${esc(searchName)}</strong><small>其他收藏不強制綁 Google 地點。</small></div><button class="btn primary full" data-capture-save-article>確認名稱並正式收藏</button>`;return;
    }
    if(!searchName){root.innerHTML=`<div class="empty-state compact"><h3>網址已讀取，但無法可靠辨識地點名稱</h3><p>請在上方輸入景點／飯店／餐廳名稱，再按一次「一鍵找相關資料」。</p></div>`;return;}
    try{
      const data=await fetchJsonWithTimeout('/api/place-search',{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',body:JSON.stringify({name:searchName,location:'',entityType:type,branchRisk:false})},16000);
      const candidates=(data.candidates||[]).slice(0,5);quickCaptureState.candidates=candidates;
      if(!candidates.length){root.innerHTML=`<div class="capture-source-preview"><span class="badge">來源標題</span><strong>${esc(searchName)}</strong></div><div class="empty-state compact"><h3>Google Places 沒找到可靠候選</h3><p>可修改上方名稱再搜尋，或先放待整理。</p></div>`;return;}
      root.innerHTML=`${title?`<div class="capture-source-preview"><span class="badge">來源標題</span><strong>${esc(title)}</strong></div>`:''}<div class="candidate-list capture-candidates">${candidates.map((c,i)=>`<button type="button" class="candidate-card" data-capture-choose="${i}"><strong>${esc(c.displayName||searchName)}</strong><span>${esc(c.formattedAddress||'地址未提供')}</span>${c.primaryTypeLabel?`<small>${esc(c.primaryTypeLabel)}</small>`:''}<small>${c.exactName?'名稱完全符合':`名稱相似 ${Math.round((c.similarity||0)*100)}%`}${c.hasPhoto?'・有照片':''}</small><em>確認這個並收藏</em></button>`).join('')}</div><div class="helper">請點你確認正確的地點；在點選前不會建立正式收藏。</div>`;
    }catch(err){root.innerHTML=`<div class="capture-source-preview">${searchName?`<span class="badge">辨識名稱</span><strong>${esc(searchName)}</strong>`:''}</div><div class="empty-state compact"><h3>搜尋失敗</h3><p>${esc(String(err.message||'稍後再試'))}</p><p>仍可先存待整理。</p></div>`;}
  }

  async function saveQuickCaptureInbox(){
    const url=String($('#quickCaptureUrl')?.value||'').trim();const type=String($('#quickCaptureType')?.value||'attraction');
    const name=String($('#quickCaptureName')?.value||'').trim()||quickCaptureState.suggestedName||'待整理收藏';
    if(!url){toast('請先貼上網址');return;}
    const duplicate=captureDuplicateForUrl(url,quickCaptureState.existingId);if(duplicate){closeModal();toast(`這個來源已收藏：${duplicate.name||'待整理收藏'}`);return;}
    const existing=quickCaptureState.existingId?getEntity(quickCaptureState.existingId):null;
    const out=inferGeoEntity({...captureBaseEntity({url,name,entityType:type,existing,captureStatus:'inbox'}),captureAutoStatus:'queued',captureAutoUpdatedAt:new Date().toISOString(),captureCandidates:[],captureSuggestedName:name==='待整理收藏'?'':name});
    await TwinDB.put('entities',out);await reloadData();closeModal();render();toast('已收藏，正在自動整理','查看待整理',()=>inboxModal(),6500);autoResolveInboxEntity(out,{force:true}).catch(()=>{});
  }

  async function saveResolvedCaptureCandidate(index){
    const c=quickCaptureState.candidates?.[index];if(!c)return;
    const url=String($('#quickCaptureUrl')?.value||'').trim();const type=String($('#quickCaptureType')?.value||'attraction');const typedName=String($('#quickCaptureName')?.value||'').trim();
    const existing=quickCaptureState.existingId?getEntity(quickCaptureState.existingId):null;
    const base={...captureBaseEntity({url,name:c.displayName||typedName||quickCaptureState.suggestedName,entityType:type,existing,captureStatus:'ready'}),captureAutoStatus:'confirmed',captureCandidates:[]};
    const out=inferGeoEntity(applyPlaceCandidateToEntity(base,c));await TwinDB.put('entities',out);state.photoSession.clear();await reloadData();closeModal();setView('detail',{entityId:out.id});toast(`已確認並收藏「${c.displayName||out.name}」`);autoEnrichEntity(out,{interactive:false,silent:true}).catch(()=>{});
  }

  async function saveResolvedCaptureArticle(){
    const url=String($('#quickCaptureUrl')?.value||'').trim();const type=String($('#quickCaptureType')?.value||'activity');const name=String($('#quickCaptureName')?.value||'').trim()||quickCaptureState.suggestedName;
    if(!url||!name){toast('請確認網址與名稱');return;}
    const existing=quickCaptureState.existingId?getEntity(quickCaptureState.existingId):null;
    const out=inferGeoEntity({...captureBaseEntity({url,name,entityType:type,existing,captureStatus:'ready'}),captureAutoStatus:'confirmed',captureCandidates:[]});out.placeMatchStatus='collection';
    await TwinDB.put('entities',out);await reloadData();closeModal();setView('detail',{entityId:out.id});toast(`已收藏「${name}」`);
  }

  function inboxModal(){
    const rows=inboxEntities();
    showModal('待整理', rows.length?`<div class="setting-block"><h3>${rows.length} 筆待確認</h3><p>收藏後會自動整理。這裡依收藏時間由新到舊，優先讓你「確認」而不是重新手打。</p></div><div class="inbox-list">${rows.map(e=>{
      const top=e.captureCandidates?.[0];
      const title=e.captureSuggestedName||e.captureSourceTitle||((e.name&&e.name!=='待整理收藏')?e.name:'');
      return `<div class="inbox-row smart-inbox"><div class="inbox-main"><div class="inbox-title-line"><strong>${esc(title||e.sourcePlatform||'待辨識')}</strong>${captureAutomationBadge(e)}</div><small>${esc(e.sourcePlatform||'來源')}・${esc(fmtCaptureTime(e.createdAt))}</small>${top?`<div class="inbox-proposal"><strong>${esc(top.displayName||title)}</strong><span>${esc(top.formattedAddress||'地址未提供')}</span></div>`:`<small>${esc((e.originalUrl||'').replace(/^https?:\/\//,'').slice(0,80))}</small>`}</div><div class="inbox-actions">${top?`<button class="btn primary small" data-inbox-confirm-top="${esc(e.id)}">確認收藏</button>`:''}<button class="btn small" data-inbox-resolve="${esc(e.id)}">${top?'看其他候選':'重新找資料'}</button><button class="btn ghost small" data-inbox-edit="${esc(e.id)}">手動整理</button></div></div>`;
    }).join('')}</div>`:`<div class="empty-state"><div class="empty-icon">✓</div><h3>目前沒有待整理</h3><p>看到想去的地方就先快速收藏；收藏後會自動整理。</p><button class="btn primary" data-quick-capture>快速收藏</button></div>`);
    scheduleInboxAutomation(0);
  }

  function fmtCaptureTime(s=''){
    if(!s)return '時間未記錄';const d=new Date(s);if(Number.isNaN(d.getTime()))return '時間未記錄';
    return new Intl.DateTimeFormat('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(d);
  }

  function distanceKmBetween(a,b){
    if(!Number.isFinite(a?.latitude)||!Number.isFinite(a?.longitude)||!Number.isFinite(b?.latitude)||!Number.isFinite(b?.longitude)) return null;
    const toRad=x=>x*Math.PI/180,R=6371,dLat=toRad(b.latitude-a.latitude),dLon=toRad(b.longitude-a.longitude);
    const x=Math.sin(dLat/2)**2+Math.cos(toRad(a.latitude))*Math.cos(toRad(b.latitude))*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(x));
  }

  function explicitAgeConflict(e){
    const age=currentAgeMonths();
    // V4.3.3 researched decision-age fields supersede legacy notes/minAge values.
    if(e.decisionMetadataVersion){
      if(age!==null && e.decisionMinAgeMonths!==null && e.decisionMinAgeMonths!==undefined && age<Number(e.decisionMinAgeMonths)) return true;
      if(age!==null && e.decisionMaxAgeMonths!==null && e.decisionMaxAgeMonths!==undefined && age>Number(e.decisionMaxAgeMonths)) return true;
      return e.toddlerFit==='older';
    }
    if(age!==null && e.minAgeMonths!==null){
      if(age<e.minAgeMonths) return true;
      if(e.maxAgeMonths!==null && age>e.maxAgeMonths) return true;
    }
    return false;
  }

  function decisionScore(e,opt){
    let score=0; const reasons=[];
    if(e.favorite){score+=3;reasons.push('已收藏');}
    if(!e.visited){score+=2;reasons.push('還沒去');}
    if(Number.isFinite(e.familyRating)){score+=e.familyRating;reasons.push(`我家 ${e.familyRating}★`);}
    if(e.revisitIntent==='yes'){score+=2;reasons.push('會再去');}
    const friction=familyFriction(e);if(friction.known>=3&&friction.score>=2){score+=1;reasons.push(`帶娃${friction.label}`);}else if(friction.known>=3&&friction.score<0){score-=.5;reasons.push('帶娃較費力');}
    const pref=familyPreferenceMatch(e);if(pref.sampleCount>=4&&pref.score>=.2){score+=Math.min(2,pref.score*1.4);reasons.push(pref.label);}

    const age=currentAgeMonths();
    if(age!==null && e.decisionMetadataVersion && e.decisionMinAgeMonths!==null && e.decisionMinAgeMonths!==undefined){
      const withinMin=age>=Number(e.decisionMinAgeMonths);
      const withinMax=e.decisionMaxAgeMonths===null || e.decisionMaxAgeMonths===undefined || age<=Number(e.decisionMaxAgeMonths);
      if(withinMin&&withinMax){score+=4;reasons.push('符合查證年齡資料');}
      else {score-=8;reasons.push('查證年齡不符');}
    }else if(!e.decisionMetadataVersion && age!==null && e.minAgeMonths!==null){
      if(supportsAge(e)){score+=4;reasons.push('符合明確年齡資料');}
      else {score-=8;reasons.push('明確年齡不符');}
    }else if(e.toddlerFit==='good'){
      score+=2; reasons.push('幼兒適合');
    }else if(e.toddlerFit==='partial'){
      score+=1; reasons.push('幼兒部分設施可玩');
    }else if(e.toddlerFit==='older'){
      score-=6; reasons.push('較大再去');
    }
    if(e.toddlerAccess==='good'&&e.toddlerFit!=='good'){score+=0.5;reasons.push('官方資料顯示幼兒可去');}
    else if(e.toddlerAccess==='conditional'){reasons.push('幼兒需符合條件');}

    if((e.familyTags||[]).includes('toddler')){score+=3;reasons.push('我家實測幼兒友善');}

    if(opt.ageOnly){
      if(e.toddlerFit==='good'){score+=5;reasons.push('雙寶適配優先');}
      else if(e.toddlerFit==='partial'){score+=2;reasons.push('雙寶可玩但有限制');}
      else if(e.toddlerFit==='unknown'){reasons.push('適齡待確認');}
    }

    if(opt.context==='rain'){
      if((e.familyTags||[]).includes('rainy')){score+=8;reasons.push('我家實測雨天友善');}
      if(deriveRainFromEnvironment(e)==='good'){score+=7;reasons.push('雨天適合');}
      else if(deriveRainFromEnvironment(e)==='partial'){score+=3;reasons.push('雨天部分可玩');}
      else if(deriveRainFromEnvironment(e)==='unknown'){reasons.push('雨天資訊待確認');}
    }

    if(opt.context==='outdoor'){
      if(e.environmentType==='outdoor'){score+=6;reasons.push('已確認戶外');}
      else if(e.environmentType==='mixed'){score+=3;reasons.push('有戶外空間');}
      else if(e.environmentType==='unknown'){reasons.push('場域待確認');}
    }

    if(opt.context==='water'){
      if((e.familyTags||[]).includes('water')){score+=8;reasons.push('我家實測可玩水');}
      if(e.waterPlay==='yes'){score+=7;reasons.push('可玩水');}
      else if(e.waterPlay==='seasonal'){score+=4;reasons.push('季節性玩水');}
      else if(e.waterPlay==='unknown'){reasons.push('玩水資訊待確認');}
    }

    if(e.decisionConfidence==='A') score+=0.8;
    else if(e.decisionConfidence==='B') score+=0.3;

    let km=null;
    if(opt.userPos && Number.isFinite(e.latitude)&&Number.isFinite(e.longitude)){
      km=distanceKm({lat:opt.userPos.lat,lng:opt.userPos.lng},e);
      if(km<20){score+=4;reasons.push(`${km.toFixed(0)}km 直線距離`);}
      else if(km<50){score+=3;reasons.push(`${km.toFixed(0)}km 直線距離`);}
      else if(km<100){score+=1;reasons.push(`${km.toFixed(0)}km 直線距離`);}
      if(opt.mode==='half' && km>60) score-=4;
      if(opt.mode==='day' && km>140) score-=2;
    }
    return {score,reasons,km};
  }

  function decisionCandidates(opt=state.decision){
    let rows=readyEntities().filter(e=>e.decisionEligible!==false);
    if(opt.type) rows=rows.filter(e=>e.entityType===opt.type);
    if(opt.macroRegion && opt.macroRegion!=='all') rows=rows.filter(e=>e.macroRegion===opt.macroRegion);
    if(opt.unvisitedOnly) rows=rows.filter(e=>!e.visited);
    if(opt.favoriteOnly) rows=rows.filter(e=>e.favorite);

    // Hard exclusion only when the saved/researched evidence explicitly contradicts the request.
    if(opt.ageOnly) rows=rows.filter(e=>!explicitAgeConflict(e));
    if(opt.context==='rain') rows=rows.filter(e=>deriveRainFromEnvironment(e)!=='poor');
    if(opt.context==='outdoor') rows=rows.filter(e=>e.environmentType!=='indoor');
    if(opt.context==='water') rows=rows.filter(e=>e.waterPlay!=='no');

    const scored=rows.map(e=>({e,...decisionScore(e,opt)}));
    if(opt.maxKm && opt.userPos){
      return scored
        .filter(x=>x.km!==null && x.km<=Number(opt.maxKm))
        .sort((a,b)=>b.score-a.score || (a.km??999)-(b.km??999));
    }
    return scored.sort((a,b)=>b.score-a.score || String(a.e.name).localeCompare(String(b.e.name),'zh-Hant'));
  }

  function decisionNearMisses(opt=state.decision, excludeIds=[]){
    const excluded=new Set(excludeIds);
    let rows=readyEntities().filter(e=>e.decisionEligible!==false && !excluded.has(e.id));
    if(opt.type) rows=rows.filter(e=>e.entityType===opt.type);
    if(opt.macroRegion && opt.macroRegion!=='all') rows=rows.filter(e=>e.macroRegion===opt.macroRegion);
    if(opt.unvisitedOnly) rows=rows.filter(e=>!e.visited);
    if(opt.favoriteOnly) rows=rows.filter(e=>e.favorite);
    if(opt.ageOnly) rows=rows.filter(e=>!explicitAgeConflict(e));

    // Near-miss cards are never promoted into the formal candidate list.
    if(opt.context==='rain') rows=rows.filter(e=>deriveRainFromEnvironment(e)==='poor');
    else if(opt.context==='outdoor') rows=rows.filter(e=>e.environmentType==='indoor');
    else if(opt.context==='water') rows=rows.filter(e=>e.waterPlay==='no');
    else return [];

    const warning=e=>{
      if(opt.context==='rain') return '不完全符合：已知雨天不建議';
      if(opt.context==='outdoor') return '不完全符合：已知室內';
      if(opt.context==='water') return '不完全符合：非玩水景點';
      return '不完全符合目前條件';
    };

    return rows
      .map(e=>({e,...decisionScore(e,{...opt,context:'any'}),warning:warning(e)}))
      .sort((a,b)=>b.score-a.score || String(a.e.name).localeCompare(String(b.e.name),'zh-Hant'));
  }

  function decisionResultsHtml(){
    if(state.decision.maxKm && !state.decision.userPos) return `<div class="empty-state"><h3>距離篩選需要目前位置</h3><p>請先按「用目前位置」，再產生候選；未取得位置時不會假裝套用距離條件。</p></div>`;
    const rows=decisionCandidates().slice(0,8);
    const need=Math.max(0,3-rows.length);
    const near=need>0 ? decisionNearMisses(state.decision,rows.map(x=>x.e.id)).slice(0,need) : [];
    if(!rows.length && !near.length) return `<div class="empty-state"><h3>目前沒有符合條件的候選</h3><p>放寬一個條件再試。</p></div>`;

    const primary=rows.length
      ? `<div class="decision-results">${rows.map(x=>`<div class="decision-card"><div>${entityImage(x.e,'decision-thumb')}</div><div><strong>${esc(x.e.name)}</strong><small>${esc(entityLocation(x.e)||'未分類')}</small><div class="decision-facts">${decisionFactChips(x.e,3)}</div><div class="decision-reasons">${x.reasons.slice(0,4).map(r=>`<span>${esc(r)}</span>`).join('')}</div></div><div class="decision-actions"><button class="btn small" data-open-decision-entity="${esc(x.e.id)}">查看</button><button class="btn primary small" data-smart-trip="${esc(x.e.id)}">組行程</button></div></div>`).join('')}</div>`
      : `<div class="empty-state compact"><h3>沒有完全符合的候選</h3><p>下面只列條件接近項目，不會冒充正式推薦。</p></div>`;

    const nearHtml=near.length
      ? `<div class="near-miss-section"><div class="result-summary"><strong>條件接近</strong><span>不完全符合，僅供備選</span></div><div class="decision-results">${near.map(x=>`<div class="decision-card near-miss"><div>${entityImage(x.e,'decision-thumb')}</div><div><strong>${esc(x.e.name)}</strong><small>${esc(entityLocation(x.e)||'未分類')}</small><div class="decision-warning">${esc(x.warning)}</div><div class="decision-facts">${decisionFactChips(x.e,3)}</div></div><div class="decision-actions"><button class="btn small" data-open-decision-entity="${esc(x.e.id)}">查看</button></div></div>`).join('')}</div></div>`
      : '';
    return `${primary}${nearHtml}`;
  }

  function decisionModal(){
    const d=state.decision;
    showModal('今天去哪？', `<div class="form-grid">
      <div class="field"><label>時間</label><select id="decisionMode"><option value="half" ${d.mode==='half'?'selected':''}>半天</option><option value="day" ${d.mode==='day'?'selected':''}>一天</option><option value="overnight" ${d.mode==='overnight'?'selected':''}>兩天一夜</option></select></div>
      <div class="inline-fields"><div class="field"><label>類型</label><select id="decisionType"><option value="">全部</option>${Object.entries(TYPE_LABELS).map(([v,l])=>`<option value="${v}" ${d.type===v?'selected':''}>${l}</option>`).join('')}</select></div><div class="field"><label>大區域</label><select id="decisionRegion"><option value="all">全台</option>${Object.entries(GEO_REGION_MAP).map(([k,v])=>`<option value="${k}" ${d.macroRegion===k?'selected':''}>${v.label}</option>`).join('')}</select></div></div>
      <div class="field"><label>今天情境</label><select id="decisionContext"><option value="any">不限</option><option value="rain">雨天／室內優先</option><option value="outdoor">戶外放電</option><option value="water">想玩水</option></select></div>
      <div class="decision-toggle-row"><label><input id="decisionUnvisited" type="checkbox" ${d.unvisitedOnly?'checked':''}> 未去過</label><label><input id="decisionFavorite" type="checkbox" ${d.favoriteOnly?'checked':''}> 只看最愛</label><label><input id="decisionAge" type="checkbox" ${d.ageOnly?'checked':''}> 適合雙寶</label></div>
      <div class="field"><label>距離（選填）</label><div class="capture-url-row"><select id="decisionKm"><option value="">不限</option><option value="20">20km 內</option><option value="50">50km 內</option><option value="100">100km 內</option></select><button class="btn" data-decision-location>用目前位置</button></div><div class="helper">距離為直線距離，不冒充實際車程。</div></div>
      <button class="btn primary" data-decision-run>產生候選</button>
      <div id="decisionResults">${decisionResultsHtml()}</div>
      <div class="helper">V4.3.3 採「已知適合加分、未知保留、明確衝突才排除」。網路查證資料會標示可信度；沒有即時天氣、營業時間或交通資料就不會假裝知道。</div>
    </div>`,{wide:true});
    $('#decisionContext').value=d.context;
    $('#decisionKm').value=d.maxKm||'';
    setTimeout(hydratePlaceImages,0);
  }

  function syncDecisionFromModal(){
    state.decision={...state.decision,mode:$('#decisionMode')?.value||'day',type:$('#decisionType')?.value||'',macroRegion:$('#decisionRegion')?.value||'all',context:$('#decisionContext')?.value||'any',unvisitedOnly:!!$('#decisionUnvisited')?.checked,favoriteOnly:!!$('#decisionFavorite')?.checked,ageOnly:!!$('#decisionAge')?.checked,maxKm:$('#decisionKm')?.value||''};
  }

  function nearbySavedEntities(main){
    return readyEntities().filter(e=>e.id!==main.id).map(e=>({e,km:distanceKmBetween(main,e)})).sort((a,b)=>{
      if(a.km!==null&&b.km!==null) return a.km-b.km;
      if(a.km!==null) return -1;if(b.km!==null)return 1;
      const sameA=a.e.geoGroup&&a.e.geoGroup===main.geoGroup?0:1, sameB=b.e.geoGroup&&b.e.geoGroup===main.geoGroup?0:1;
      return sameA-sameB;
    });
  }

  function smartTripModal(main, defaultMode=state.decision?.mode||'day'){
    const near=nearbySavedEntities(main).slice(0,18);
    const optionRows=near.map(({e,km})=>`<label class="smart-option"><input type="checkbox" name="smartEntity" value="${esc(e.id)}"><span><strong>${esc(e.name)}</strong><small>${TYPE_LABELS[e.entityType]||''}${km!==null?`・約 ${km.toFixed(1)}km 直線距離`:e.geoGroup?`・${esc(e.geoGroup)}`:''}</small></span></label>`).join('');
    showModal('智慧組行程', `<form id="smartTripForm" class="form-grid">
      <div class="setting-block"><h3>主景點：${esc(main.name)}</h3><p>從你自己的收藏中找附近候選，建立可再編輯的草稿；不使用未驗證的營業時間或即時路況。</p></div>
      <div class="inline-fields"><div class="field"><label>行程型態</label><select name="mode"><option value="half" ${defaultMode==='half'?'selected':''}>半天</option><option value="day" ${defaultMode==='day'?'selected':''}>一天</option><option value="overnight" ${defaultMode==='overnight'?'selected':''}>兩天一夜</option></select></div><div class="field"><label>日期</label><input name="date" type="date" value="${todayISO()}"></div></div>
      <label class="check-line"><input type="checkbox" name="nap" checked><span><strong>保留午睡／移動段</strong><small>只建立可編輯的午睡站點，不推測實際睡眠。</small></span></label>
      <div class="field"><label>附近想一起排的收藏（兩天一夜可多選 2 個景點／其他收藏）</label><div class="smart-options">${optionRows||'<p>目前沒有足夠的附近收藏。</p>'}</div></div>
      <button class="btn primary">建立行程草稿</button>
    </form>`,{wide:true});
    $('#smartTripForm').addEventListener('submit',async ev=>{
      ev.preventDefault();const fd=new FormData(ev.currentTarget);const mode=String(fd.get('mode'));const date=String(fd.get('date')||'');const picked=fd.getAll('smartEntity').map(String).map(getEntity).filter(Boolean);const nap=fd.get('nap')==='on';
      const restaurants=picked.filter(e=>e.entityType==='restaurant').slice(0,1), hotels=picked.filter(e=>e.entityType==='hotel').slice(0,1), extras=picked.filter(e=>['attraction','activity'].includes(e.entityType)).slice(0,2);
      const indoorBackup=near.find(x=>x.e.indoor===true && ['attraction','activity'].includes(x.e.entityType) && x.e.id!==main.id && x.km!==null && x.km<=40)?.e;
      const stops=[]; let order=1;
      stops.push({id:uuid('stop'),type:main.entityType,entityId:main.id,customTitle:'',plannedTime:mode==='half'?'10:00':'10:00',plannedDurationMinutes:null,note:'主行程',backupEntityId:indoorBackup?.id||'',backupNote:indoorBackup?'已確認在 40km 直線距離內的室內備案':'',order:order++,done:false});
      if(restaurants[0]) stops.push({id:uuid('stop'),type:'restaurant',entityId:restaurants[0].id,customTitle:'',plannedTime:'12:30',plannedDurationMinutes:null,note:'',backupEntityId:'',backupNote:'',order:order++,done:false});
      if(nap && mode!=='half') stops.push({id:uuid('stop'),type:'custom',entityId:'',customTitle:'午睡／移動',plannedTime:'13:30',plannedDurationMinutes:60,note:'依雙寶當天狀況調整',backupEntityId:'',backupNote:'',order:order++,done:false});
      if(extras[0]) stops.push({id:uuid('stop'),type:extras[0].entityType,entityId:extras[0].id,customTitle:'',plannedTime:mode==='half'?'14:00':'15:00',plannedDurationMinutes:null,note:'',backupEntityId:mode==='overnight'?'':(extras[1]?.id||''),backupNote:mode==='overnight'?'':(extras[1]?'第二候選':''),order:order++,done:false});
      if(mode==='overnight'){
        if(hotels[0]) stops.push({id:uuid('stop'),type:'hotel',entityId:hotels[0].id,customTitle:'',plannedTime:'17:30',plannedDurationMinutes:null,note:'第 1 天入住',backupEntityId:'',backupNote:'',order:order++,done:false});
        else stops.push({id:uuid('stop'),type:'custom',entityId:'',customTitle:'住宿待安排',plannedTime:'17:30',plannedDurationMinutes:null,note:'第 1 天住宿尚未選擇',backupEntityId:'',backupNote:'',order:order++,done:false});
        stops.push({id:uuid('stop'),type:'custom',entityId:'',customTitle:'第 2 天開始',plannedTime:'09:00',plannedDurationMinutes:null,note:'隔日行程，可再編輯時間與站點',backupEntityId:'',backupNote:'',order:order++,done:false});
        if(extras[1]) stops.push({id:uuid('stop'),type:extras[1].entityType,entityId:extras[1].id,customTitle:'',plannedTime:'10:00',plannedDurationMinutes:null,note:'第 2 天候選',backupEntityId:'',backupNote:'',order:order++,done:false});
        else stops.push({id:uuid('stop'),type:'custom',entityId:'',customTitle:'第 2 天景點待安排',plannedTime:'10:00',plannedDurationMinutes:null,note:'可從行程中再新增站點',backupEntityId:'',backupNote:'',order:order++,done:false});
      }
      const title=`${main.geoGroup||''}${main.name}${mode==='overnight'?'兩天一夜':mode==='half'?'半日':'一日'}遊`;
      const trip={id:uuid('trip'),title,date,notes:'V4.3 智慧草稿：時間皆可編輯；未使用即時營業、路況或天氣資料。',mode,stops,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      await TwinDB.put('itineraries',trip);await reloadData();closeModal();state.selectedTripId=trip.id;setView('trips',{tripId:trip.id});toast('行程草稿已建立');
    });
  }

  function currentAgeMonths() { return ageMonthsFromBirthdate(state.settings.childBirthdate); }
  function supportsAge(e) {
    const age=currentAgeMonths(); if (age===null || e.minAgeMonths===null) return false;
    if (age < e.minAgeMonths) return false;
    if (e.maxAgeMonths!==null && age > e.maxAgeMonths) return false;
    return true;
  }


  function normalizeExploreTheme(raw={}) {
    const mode=raw?.mode==='smart'?'smart':'manual';
    const rules=raw?.rules&&typeof raw.rules==='object'?raw.rules:{};
    return {
      id:String(raw?.id||'').trim(),
      name:String(raw?.name||'').trim().slice(0,12),
      icon:String(raw?.icon||'✨').trim().slice(0,4)||'✨',
      mode,
      entityIds:[...new Set(Array.isArray(raw?.entityIds)?raw.entityIds.map(String).filter(Boolean):[])],
      rules:{
        indoorOnly:!!rules.indoorOnly,
        ageOnly:!!rules.ageOnly,
        favoriteOnly:!!rules.favoriteOnly,
        unvisitedOnly:!!rules.unvisitedOnly,
        easyOnly:!!rules.easyOnly,
        keywords:String(rules.keywords||'').trim().slice(0,120)
      },
      createdAt:String(raw?.createdAt||''),
      updatedAt:String(raw?.updatedAt||'')
    };
  }
  function exploreThemes() {
    const rows=Array.isArray(state.settings.exploreThemes)?state.settings.exploreThemes:[];
    return rows.map(normalizeExploreTheme).filter(t=>t.id&&t.name).slice(0,20);
  }
  function activeExploreTheme() {
    const id=String(state.explore.themeId||'');
    return id?exploreThemes().find(t=>t.id===id)||null:null;
  }
  function themeSearchText(e) {
    return [e?.name,e?.geoGroup,e?.county,e?.district,e?.address,e?.cityRaw,e?.note,e?.ageNote,e?.familyNote,
      ...(Array.isArray(e?.tags)?e.tags:[]),...(Array.isArray(e?.decisionTags)?e.decisionTags:[]),...(Array.isArray(e?.familyTags)?e.familyTags:[]).map(k=>FAMILY_TAGS[k]||k),
      ...(Array.isArray(e?.placeTypes)?e.placeTypes:[]),e?.placePrimaryType].filter(Boolean).join(' ').toLowerCase();
  }
  function themeMatchesEntity(theme,e) {
    if(!theme||!e||e.captureStatus==='inbox')return false;
    const t=normalizeExploreTheme(theme);
    if(t.mode==='manual')return t.entityIds.includes(String(e.id));
    const r=t.rules||{};
    if(r.indoorOnly && e.indoor!==true && e.environmentType!=='indoor')return false;
    if(r.ageOnly && !supportsAge(e))return false;
    if(r.favoriteOnly && !e.favorite)return false;
    if(r.unvisitedOnly && e.visited)return false;
    if(r.easyOnly){const f=familyFriction(e);if(f.known<2||f.score<2)return false;}
    const kws=String(r.keywords||'').split(/[，,]+/).map(x=>x.trim().toLowerCase()).filter(Boolean);
    if(kws.length){const text=themeSearchText(e);if(!kws.some(k=>text.includes(k)))return false;}
    return true;
  }
  function themeCountForType(theme,type=state.explore.type) {
    return readyEntities().filter(e=>(!type||e.entityType===type)&&themeMatchesEntity(theme,e)).length;
  }
  async function persistExploreThemes(themes) {
    const clean=(Array.isArray(themes)?themes:[]).map(normalizeExploreTheme).filter(t=>t.id&&t.name).slice(0,20);
    await TwinDB.put('settings',{key:'exploreThemes',value:clean});
    await reloadData();
    if(state.explore.themeId && !clean.some(t=>t.id===state.explore.themeId))state.explore.themeId='';
  }
  function exploreThemesHtml() {
    const themes=exploreThemes(),active=String(state.explore.themeId||'');
    const rows=themes.length?[
      `<button class="theme-chip ${!active?'active':''}" data-theme-select="" aria-pressed="${!active?'true':'false'}"><span>全部</span></button>`,
      ...themes.map(t=>`<button class="theme-chip ${active===t.id?'active':''}" data-theme-select="${esc(t.id)}" aria-pressed="${active===t.id?'true':'false'}"><span class="theme-chip-icon">${esc(t.icon)}</span><span>${esc(t.name)}</span><small>${themeCountForType(t)}</small></button>`)
    ]:[];
    return `<section class="explore-theme-wrap ${themes.length?'has-themes':'empty'}" aria-label="我的主題"><div class="explore-theme-head"><div><strong>我的主題</strong><small>${themes.length?'跨分類的自訂收藏／條件':'例如：雨天、動物、室內放電'}</small></div><div class="theme-head-actions"><button class="theme-mini-action" data-theme-add>＋ 新增</button>${themes.length?'<button class="theme-mini-action ghost" data-theme-manage>管理</button>':''}</div></div>${themes.length?`<div class="theme-chip-row">${rows.join('')}</div>`:''}</section>`;
  }
  function themeEditorModal(themeId='') {
    const themes=exploreThemes(),existing=themes.find(t=>t.id===themeId),t=existing||normalizeExploreTheme({id:'',name:'',icon:'✨',mode:'manual',entityIds:[],rules:{}});
    const selected=new Set(t.entityIds||[]);
    const rows=readyEntities().slice().sort((a,b)=>String(TYPE_LABELS[a.entityType]||'').localeCompare(String(TYPE_LABELS[b.entityType]||''),'zh-Hant')||String(a.name||'').localeCompare(String(b.name||''),'zh-Hant')).map(e=>{
      const label=`${TYPE_LABELS[e.entityType]||'其他'} ${e.name} ${entityLocation(e)}`.toLowerCase();
      return `<label class="theme-member-row" data-theme-member-label="${esc(label)}"><input type="checkbox" name="themeEntityId" value="${esc(e.id)}" ${selected.has(e.id)?'checked':''}><span><strong>${esc(e.name)}</strong><small>${esc(TYPE_LABELS[e.entityType]||'其他')}・${esc(entityLocation(e)||'地區未確認')}</small></span></label>`;
    }).join('');
    showModal(existing?'編輯我的主題':'新增我的主題',`<form id="themeEditorForm" class="form-grid">
      <div class="theme-editor-title-row"><div class="field"><label>圖示</label><input name="icon" value="${esc(t.icon||'✨')}" maxlength="4" placeholder="✨"></div><div class="field grow"><label>主題名稱 *</label><input name="name" value="${esc(t.name||'')}" maxlength="12" required placeholder="例如：雨天備案"></div></div>
      <div class="field"><label>建立方式</label><select name="mode" id="themeMode"><option value="manual" ${t.mode==='manual'?'selected':''}>手動收藏</option><option value="smart" ${t.mode==='smart'?'selected':''}>條件自動收納</option></select><div class="helper">主題是第二層篩選，不會改變景點／住宿／餐廳／其他的核心分類。</div></div>
      <div id="themeManualFields" ${t.mode==='manual'?'':'hidden'}>
        <div class="field"><label>加入主題的收藏</label><input id="themeMemberSearch" placeholder="搜尋名稱或地區"></div>
        <div class="theme-member-list">${rows||'<div class="helper">目前沒有可加入的收藏。</div>'}</div>
      </div>
      <div id="themeSmartFields" ${t.mode==='smart'?'':'hidden'}>
        <div class="theme-rule-grid">
          <label class="check-line"><input type="checkbox" name="ruleIndoor" ${t.rules.indoorOnly?'checked':''}><span><strong>室內</strong><small>只收已確認室內</small></span></label>
          <label class="check-line"><input type="checkbox" name="ruleAge" ${t.rules.ageOnly?'checked':''}><span><strong>適合目前年齡</strong><small>只用已確認年齡資料</small></span></label>
          <label class="check-line"><input type="checkbox" name="ruleFavorite" ${t.rules.favoriteOnly?'checked':''}><span><strong>最愛</strong><small>只收已按愛心</small></span></label>
          <label class="check-line"><input type="checkbox" name="ruleUnvisited" ${t.rules.unvisitedOnly?'checked':''}><span><strong>還沒去</strong><small>排除已去過</small></span></label>
          <label class="check-line"><input type="checkbox" name="ruleEasy" ${t.rules.easyOnly?'checked':''}><span><strong>帶娃輕鬆</strong><small>已知資料達「輕鬆」以上</small></span></label>
        </div>
        <div class="field"><label>關鍵字（可選）</label><input name="keywords" value="${esc(t.rules.keywords||'')}" maxlength="120" placeholder="例如：動物, 牧場, 水族館"><div class="helper">多個關鍵字用逗號分隔；符合任一即可。搜尋名稱、標籤、備註與 Google 類型。</div></div>
      </div>
      <button class="btn primary full">${existing?'儲存主題':'建立主題'}</button>
    </form>`,{wide:true});
    const mode=$('#themeMode'),manual=$('#themeManualFields'),smart=$('#themeSmartFields'),search=$('#themeMemberSearch');
    const syncMode=()=>{if(!mode)return;manual.hidden=mode.value!=='manual';smart.hidden=mode.value!=='smart';};mode?.addEventListener('change',syncMode);
    search?.addEventListener('input',()=>{const q=String(search.value||'').trim().toLowerCase();$$('.theme-member-row').forEach(row=>row.hidden=!!q&&!String(row.dataset.themeMemberLabel||'').includes(q));});
    $('#themeEditorForm').addEventListener('submit',async ev=>{
      ev.preventDefault();const fd=new FormData(ev.currentTarget),modeValue=String(fd.get('mode')||'manual'),name=String(fd.get('name')||'').trim().slice(0,12);
      if(!name)return;
      const rules={indoorOnly:!!fd.get('ruleIndoor'),ageOnly:!!fd.get('ruleAge'),favoriteOnly:!!fd.get('ruleFavorite'),unvisitedOnly:!!fd.get('ruleUnvisited'),easyOnly:!!fd.get('ruleEasy'),keywords:String(fd.get('keywords')||'').trim().slice(0,120)};
      if(modeValue==='smart'&&!rules.indoorOnly&&!rules.ageOnly&&!rules.favoriteOnly&&!rules.unvisitedOnly&&!rules.easyOnly&&!rules.keywords){toast('條件主題至少要選一個條件或填關鍵字');return;}
      const out=normalizeExploreTheme({id:existing?.id||uuid('theme'),name,icon:String(fd.get('icon')||'✨').trim()||'✨',mode:modeValue,entityIds:modeValue==='manual'?fd.getAll('themeEntityId').map(String):[],rules,createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()});
      const next=existing?themes.map(x=>x.id===existing.id?out:x):[...themes,out];await persistExploreThemes(next);state.explore.themeId=out.id;closeModal();render();toast(existing?'主題已更新':'主題已建立');
    });
  }
  function themeManagerModal() {
    const themes=exploreThemes();
    showModal('管理我的主題',`<div class="theme-manager-list">${themes.length?themes.map(t=>`<div class="theme-manager-row"><div><strong>${esc(t.icon)} ${esc(t.name)}</strong><small>${t.mode==='smart'?'條件自動收納':'手動收藏'}・目前${themeCountForType(t,'')}筆</small></div><div><button class="btn small" data-theme-edit="${esc(t.id)}">編輯</button><button class="btn ghost small" data-theme-delete="${esc(t.id)}">刪除</button></div></div>`).join(''):'<div class="empty-state compact"><h3>還沒有自訂主題</h3><p>可以建立雨天、動物、室內放電、雙寶超愛等主題。</p></div>'}</div><button class="btn primary full" data-theme-add>＋ 新增主題</button>`);
  }

  function exploreTypeCounts() {
    const rows=readyEntities();
    return {
      attraction: rows.filter(e=>e.entityType==='attraction').length,
      hotel: rows.filter(e=>e.entityType==='hotel').length,
      restaurant: rows.filter(e=>e.entityType==='restaurant').length,
      activity: rows.filter(e=>e.entityType==='activity').length
    };
  }

  function exploreTypeTabsHtml() {
    const counts=exploreTypeCounts();
    const main=[
      ['attraction','🌿','景點'],
      ['hotel','🏨','住宿'],
      ['restaurant','🍴','餐廳'],
      ['activity','📚','其他']
    ].map(([type,icon,label])=>`<button class="type-tab type-${type} ${state.explore.type===type?'active':''}" data-explore-type="${type}" aria-pressed="${state.explore.type===type?'true':'false'}"><span class="type-tab-icon">${icon}</span><span class="type-tab-copy"><strong>${label}</strong><small><b>${counts[type]}</b> 筆</small></span></button>`).join('');
    return `<div class="explore-type-wrap"><div class="explore-type-tabs four" role="group" aria-label="資料類型">${main}</div></div>`;
  }

  function exploreEmptyStateHtml() {
    const type=state.explore.type;
    const counts=exploreTypeCounts();
    if(type==='restaurant' && counts.restaurant===0) return `<div class="empty-state"><div class="empty-icon">🍽</div><h3>還沒有收藏餐廳</h3><p>看到適合雙寶的親子餐廳時，用「快速收藏」先存起來。</p><div class="hero-actions" style="justify-content:center"><button class="btn primary" data-quick-capture>快速收藏</button></div></div>`;
    if(type==='activity' && counts.activity===0) return `<div class="empty-state"><div class="empty-icon">🎈</div><h3>還沒有其他收藏</h3><p>親子活動、遊戲、整理文章或其他非單一地點內容可以放在這裡。</p><div class="hero-actions" style="justify-content:center"><button class="btn primary" data-quick-capture>快速收藏</button></div></div>`;
    const label=TYPE_LABELS[type]||'資料';
    return `<div class="empty-state"><div class="empty-icon">🔎</div><h3>沒有符合條件的${label}</h3><p>可以清除地區或其他篩選條件。</p><div class="hero-actions" style="justify-content:center"><button class="btn" data-clear-filters>清除篩選</button><button class="btn primary" data-quick-capture>快速收藏</button></div></div>`;
  }

  function exploreRecommendedScore(e) {
    let score=0;
    if(!e.visited) score+=5;
    if(e.toddlerFit==='good') score+=5;
    else if(e.toddlerFit==='partial') score+=2;
    else if(e.toddlerFit==='older') score-=4;
    if(Number.isFinite(e.familyRating)) score+=e.familyRating*1.4;
    if(e.revisitIntent==='yes') score+=3;
    else if(e.revisitIntent==='no') score-=2;
    if((e.familyTags||[]).includes('toddler')) score+=2;
    if(e.favorite) score+=1;
    if(e.decisionConfidence==='A') score+=1;
    else if(e.decisionConfidence==='B') score+=0.4;
    const friction=familyFriction(e);if(friction.known>=3)score+=Math.max(-1.5,Math.min(1.5,friction.score*.22));
    const pref=familyPreferenceMatch(e);if(pref.sampleCount>=4)score+=Math.max(-1.5,Math.min(2,pref.score*1.6));
    const created=Date.parse(e.createdAt||'');
    if(Number.isFinite(created)){
      const days=(Date.now()-created)/86400000;
      if(days<=30) score+=1.2;
      else if(days<=90) score+=0.5;
    }
    return score;
  }

  function sortExploreRows(rows) {
    const f=state.explore;
    if(f.nearby && f.userPos) return rows.sort((a,b)=>distanceKm(f.userPos,a)-distanceKm(f.userPos,b));
    if(f.sort==='recent') return rows.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')) || String(a.name).localeCompare(String(b.name),'zh-Hant'));
    if(f.sort==='unvisited') return rows.sort((a,b)=>Number(a.visited)-Number(b.visited) || exploreRecommendedScore(b)-exploreRecommendedScore(a) || String(a.name).localeCompare(String(b.name),'zh-Hant'));
    if(f.sort==='rating') return rows.sort((a,b)=>(b.familyRating??-1)-(a.familyRating??-1) || exploreRecommendedScore(b)-exploreRecommendedScore(a) || String(a.name).localeCompare(String(b.name),'zh-Hant'));
    if(f.sort==='name') return rows.sort((a,b)=>String(a.name).localeCompare(String(b.name),'zh-Hant'));
    return rows.sort((a,b)=>exploreRecommendedScore(b)-exploreRecommendedScore(a) || String(b.createdAt||'').localeCompare(String(a.createdAt||'')) || String(a.name).localeCompare(String(b.name),'zh-Hant'));
  }

  function exploreSortHtml() {
    const v=state.explore.sort||'recommended';
    return `<label class="explore-sort"><span>排序</span><select id="exploreSort">
      <option value="recommended" ${v==='recommended'?'selected':''}>推薦</option>
      <option value="recent" ${v==='recent'?'selected':''}>最近收藏</option>
      <option value="unvisited" ${v==='unvisited'?'selected':''}>未去優先</option>
      <option value="rating" ${v==='rating'?'selected':''}>我家評分</option>
      <option value="name" ${v==='name'?'selected':''}>名稱</option>
    </select></label>`;
  }

  function filteredEntities() {
    const f=state.explore; let rows=applyGeoFilter(readyEntities());
    if (f.type) rows=rows.filter(e=>e.entityType===f.type);
    const theme=activeExploreTheme();if(theme)rows=rows.filter(e=>themeMatchesEntity(theme,e));
    if (f.query.trim()) {
      const q=f.query.trim().toLowerCase();
      rows=rows.filter(e=>[e.name,e.geoGroup,e.county,e.district,e.address,e.cityRaw,e.note,e.ageNote,e.familyNote,...(e.tags||[]),...(e.familyTags||[]).map(k=>FAMILY_TAGS[k]||k)].join(' ').toLowerCase().includes(q));
    }
    if (f.visited==='yes') rows=rows.filter(e=>e.visited);
    if (f.visited==='no') rows=rows.filter(e=>!e.visited);
    if (f.indoor==='yes') rows=rows.filter(e=>e.indoor===true);
    if (f.indoor==='no') rows=rows.filter(e=>e.indoor===false);
    if (f.ageOnly) rows=rows.filter(supportsAge);
    if (f.favoriteOnly) rows=rows.filter(e=>e.favorite);
    if (f.nearby && f.userPos) rows=rows.filter(e=>Number.isFinite(e.latitude)&&Number.isFinite(e.longitude));
    return sortExploreRows(rows);
  }

  function distanceKm(pos,e) {
    const toRad=x=>x*Math.PI/180, R=6371;
    const dLat=toRad(e.latitude-pos.lat), dLon=toRad(e.longitude-pos.lng);
    const a=Math.sin(dLat/2)**2+Math.cos(toRad(pos.lat))*Math.cos(toRad(e.latitude))*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(a));
  }
  function renderExplore() {
    const rows=filteredEntities();
    const hasCoords=readyEntities().some(e=>Number.isFinite(e.latitude)&&Number.isFinite(e.longitude));
    const age=currentAgeMonths();
    const typeLabel=TYPE_LABELS[state.explore.type]||'資料';
    const theme=activeExploreTheme();
    return `${offlineBanner()}<div class="page-title-row"><div><h1 class="page-title">探索</h1><p class="page-subtitle">先選景點／住宿／餐廳／其他，再用地區與條件快速縮小候選。</p></div><div class="header-actions"><button class="btn soft small" data-quick-capture>快速收藏</button><button class="btn soft small" data-add-entity>＋ 新增</button></div></div>
      <div class="search-wrap"><input id="exploreSearch" class="search-input" value="${esc(state.explore.query)}" placeholder="搜尋名稱、地區、我家實測或備註" /><button class="search-clear" data-clear-search>×</button></div>
      ${exploreTypeTabsHtml()}
      ${exploreThemesHtml()}
      ${geoFilterHtml()}
      <div class="filter-row">
        <button class="chip ${state.explore.nearby?'primary-active':''}" data-nearby ${hasCoords?'':'disabled'}>📍 附近</button>
        <button class="chip ${state.explore.ageOnly?'primary-active':''}" data-age-filter>適合目前年齡${age===null?'*':''}</button>
        <button class="chip ${state.explore.indoor==='yes'?'primary-active':''}" data-indoor-filter>室內</button>
        <button class="chip ${state.explore.favoriteOnly?'primary-active':''}" data-favorite-filter>收藏</button>
        <button class="chip" data-more-filters>更多</button>
      </div>
      <div class="result-summary explore-result-head"><div><span>${rows.length} 筆${typeLabel}</span>${theme?`<span class="result-theme-tag">${esc(theme.icon)} ${esc(theme.name)}</span>`:''}<span>${geoFilter.geoGroup!=='all'?esc(geoFilter.geoGroup):geoFilter.macroRegion!=='all'?esc(GEO_REGION_MAP[geoFilter.macroRegion]?.label||''):''}</span></div>${exploreSortHtml()}</div>
      ${rows.length?`<div class="card-grid">${rows.map(entityCard).join('')}</div>`:exploreEmptyStateHtml()}`;
  }

  function renderDetail() {
    const e=getEntity(state.selectedEntityId);
    if (!e) return `<div class="empty-state"><h3>找不到這筆資料</h3><button class="btn" data-back-explore>返回探索</button></div>`;
    if(e.captureStatus==='inbox') return `<div class="empty-state"><div class="empty-icon">📥</div><h3>這筆還在待整理</h3><p>${esc(e.sourcePlatform||'來源')} 收藏尚未完成名稱與資料確認。</p><button class="btn primary" data-inbox-resolve="${esc(e.id)}">查看自動整理</button></div>`;
    const loc=entityLocation(e), hasNav=!!e.googleMapsUrl || (Number.isFinite(e.latitude)&&Number.isFinite(e.longitude));
    const navUrl=e.googleMapsUrl || (hasNav?`https://www.google.com/maps/search/?api=1&query=${e.latitude},${e.longitude}`:'');
    const familyTags=(e.familyTags||[]).map(k=>FAMILY_TAGS[k]||k);
    return `<div class="detail-page">
      <div class="detail-topbar"><div class="left"><button class="icon-btn" data-back-explore aria-label="返回">‹</button></div><div class="right"><button class="heart-btn ${e.favorite?'on':''}" data-favorite="${esc(e.id)}">${e.favorite?'♥':'♡'}</button><button class="icon-btn" data-edit-entity="${esc(e.id)}" aria-label="編輯">✎</button></div></div>
      ${entityImage(e,'detail-hero')}
      <h1 class="detail-title">${esc(e.name)}</h1>
      ${loc?`<div class="detail-location">${esc(loc)}</div>`:''}
      <div class="badges">${typeBadge(e)}${ageBadge(e)}${familyRatingBadge(e)}${recentOpeningLabel(e)?`<span class="badge good">${esc(recentOpeningLabel(e))}</span>`:''}${e.visited?'<span class="badge visited">✓ 已去</span>':''}${e.indoor===true?'<span class="badge good">室內</span>':''}</div>
      ${e.ageNote?`<div class="info-box"><h3>適齡資料</h3><p>${esc(e.ageNote)}</p></div>`:''}
      ${e.note?`<div class="info-box"><h3>備註</h3><p>${esc(e.note)}</p></div>`:''}
      ${decisionMetadataInfo(e)}
      ${(Number.isFinite(e.familyRating)||familyTags.length||e.familyNote)?`<div class="info-box family-box"><h3>我家實測</h3>${Number.isFinite(e.familyRating)?`<p><strong>${e.familyRating} / 5 ★</strong>${e.revisitIntent?`・${e.revisitIntent==='yes'?'會再去':e.revisitIntent==='maybe'?'看情況':'不會再去'}`:''}</p>`:''}${familyTags.length?`<div class="family-tags">${familyTags.map(x=>`<span>${esc(x)}</span>`).join('')}</div>`:''}${e.familyNote?`<p style="margin-top:10px">${esc(e.familyNote)}</p>`:''}</div>`:''}
      ${(e.address||e.googleMapsUrl)?`<div class="info-box"><h3>位置</h3><p>${esc(e.address||'已儲存地圖連結')}</p>${e.googleMapsUrl?`<div class="detail-links" style="margin-top:10px"><a class="detail-link" href="${esc(e.googleMapsUrl)}" target="_blank" rel="noopener">開啟地圖</a></div>`:''}</div>`:''}
      ${(e.sourceUrls||[]).length?`<div class="info-box"><h3>來源連結</h3><div class="detail-links">${e.sourceUrls.map((u,i)=>`<a class="detail-link" href="${esc(u)}" target="_blank" rel="noopener">${esc(e.sourcePlatform||'來源')} ${i+1}</a>`).join('')}</div></div>`:''}
      <div class="info-box companion-intel"><h3>帶雙寶出遊判斷</h3>${frictionHtml(e)}${preferenceHtml(e)}</div>
      <div class="info-box"><h3>規劃工具</h3><div class="detail-tool-grid"><button class="btn" data-family-review="${esc(e.id)}">我家實測</button><button class="btn" data-smart-trip="${esc(e.id)}">智慧組行程</button><button class="btn" data-source-manager-id="${esc(e.id)}">圖片／地點來源</button></div></div>
      <div class="info-box"><h3>網路封面</h3><p>${e.coverImage?'使用自己的照片。':e.sourceCoverUrl?'優先使用來源網址的封面。':e.googlePlaceId?'使用 Google Places 備援。':'尚未找到網路封面。'}</p><button class="btn small" data-refresh-place="${esc(e.id)}">重新抓取封面</button></div>
      <div class="detail-cta"><button class="btn" data-add-to-trip="${esc(e.id)}">加入行程</button><button class="btn primary" data-nav-url="${esc(navUrl)}" ${hasNav?'':'disabled'}>導航前往</button></div>
    </div>`;
  }

  function renderTrips() {
    if (state.selectedTripId && state.tripCompanion) return renderTripCompanion();
    if (state.selectedTripId) return renderTripDetail();
    return `${offlineBanner()}<div class="page-title-row"><div><h1 class="page-title">我的行程</h1><p class="page-subtitle">把出發、景點、餐廳與住宿排成一條線。</p></div><button class="btn soft small" data-new-trip>＋ 新增</button></div>
      ${state.itineraries.length?state.itineraries.map(t=>`<div class="trip-card clickable" data-open-trip="${esc(t.id)}"><div class="trip-title">${esc(t.title)}</div><div class="trip-meta">${esc(fmtDate(t.date))}・${(t.stops||[]).length} 站</div><div class="trip-next"><span>${nextStop(t)?`下一站：${esc(stopTitle(nextStop(t)))}`:'尚未安排站點'}</span><span>›</span></div></div>`).join(''):
      `<div class="empty-state"><div class="empty-icon">🗓</div><h3>還沒有安排下一趟出遊</h3><p>先建立行程，再從探索頁加入景點。</p><div class="hero-actions" style="justify-content:center"><button class="btn primary" data-new-trip>建立行程</button><button class="btn" data-view-jump="explore">探索景點</button></div></div>`}`;
  }

  function stopRow(s, trip) {
    const current=stopPlaceObj(s),backup=backupPlaceObj(s),externalBackup=!!s.backupExternalPlace;
    const sub=[STOP_LABELS[s.type]||'站點', s.plannedDurationMinutes?`預計 ${durationText(s.plannedDurationMinutes)}`:'', !current && ['restaurant','hotel','attraction','activity'].includes(s.type)?'尚未選擇':'',s.externalPlace?'Google 臨時地點':''].filter(Boolean).join('・');
    return `<div class="stop-row" data-stop-id="${esc(s.id)}">
      <div class="stop-time">${esc(s.plannedTime||'—')}</div><div class="stop-dot"></div>
      <div class="stop-content"><div class="stop-title">${esc(stopTitle(s))}</div><div class="stop-sub">${esc(sub)}</div>${s.note?`<div class="stop-sub">${esc(s.note)}</div>`:''}${backup?`<div class="plan-b-line"><span>Plan B：${esc(placeName(backup))}${externalBackup?'・Google 新發現':''}${externalBackup&&s.backupExternalEvidence?`・${esc(externalPlanBEvidenceSummary(s.backupExternalEvidence))}`:''}</span><button class="btn tiny" data-use-backup="${esc(s.id)}">改用備案</button></div>`:''}${!backup&&s.backupNote?`<div class="stop-sub">備案：${esc(s.backupNote)}</div>`:''}</div>
      <div class="stop-actions"><div class="drag-handle" data-stop-drag="${esc(s.id)}" title="拖曳排序">≡</div><button class="kebab" data-edit-stop="${esc(s.id)}">⋯</button></div>
    </div>`;
  }

  function durationText(m) { const h=Math.floor(m/60), r=m%60; return `${h?h+'小時':''}${r?r+'分':''}` || '0分'; }
  function renderTripDetail() {
    const t=state.itineraries.find(x=>x.id===state.selectedTripId);
    if (!t) { state.selectedTripId=null; return renderTrips(); }
    const stops=[...(t.stops||[])].sort((a,b)=>(a.order||0)-(b.order||0));
    return `${offlineBanner()}<div class="page-title-row"><div><button class="btn small" data-back-trips>‹ 所有行程</button><h1 class="page-title" style="margin-top:12px">${esc(t.title)}</h1><p class="page-subtitle">${esc(fmtDate(t.date))}・${stops.length} 站</p></div><div class="trip-head-actions"><button class="btn primary small" data-trip-companion="${esc(t.id)}">出遊模式</button><button class="btn soft small" data-edit-trip="${esc(t.id)}">編輯</button></div></div>
      <div class="stat-row"><span class="stat-pill">${stops.length} 站</span><span class="stat-pill">開始 ${esc(t.startTime||'09:00')}</span>${t.notes?`<span class="stat-pill">有備註</span>`:''}</div>
      ${t.scheduleDirty?`<div class="schedule-warning"><div><strong>站點順序已變更</strong><small>目前時間可能還是舊順序。</small></div><button class="btn small" data-reschedule-trip="${esc(t.id)}">重新排時間</button></div>`:''}
      ${stops.length?`<div class="timeline" id="stopList">${stops.map(s=>stopRow(s,t)).join('')}</div><div class="helper trip-time-note">自動時間使用站點直線距離分級估算交通緩衝，不代表實際車程；手動輸入的時間會鎖定保留。</div>`:`<div class="empty-state"><div class="empty-icon">＋</div><h3>還沒有站點</h3><p>可以先加「出發」「午餐」「景點」等空站，再慢慢補資料。</p></div>`}
      <div class="trip-add-panel"><strong>快速加入</strong><div class="trip-add-grid"><button class="btn" data-trip-quick-type="attraction" data-trip-id="${esc(t.id)}">＋ 景點</button><button class="btn" data-trip-quick-type="restaurant" data-trip-id="${esc(t.id)}">＋ 餐廳</button><button class="btn" data-trip-quick-type="hotel" data-trip-id="${esc(t.id)}">＋ 住宿</button><button class="btn" data-trip-quick-simple="custom" data-trip-id="${esc(t.id)}">＋ 自訂</button></div><div class="trip-add-secondary"><button class="btn ghost small" data-add-stop="${esc(t.id)}">完整新增</button><button class="btn ghost small" data-reschedule-trip="${esc(t.id)}">自動排時間</button>${nextStop(t)?`<button class="btn" data-plan-b-search="${esc(nextStop(t).id)}">找 Plan B</button><button class="btn primary small" data-nav-next="${esc(t.id)}">導航下一站</button>`:''}</div></div>`;
  }

  function tripCompanionStopCard(s,{next=false}={}){
    const p=stopPlaceObj(s),ev=stopEvidenceObj(s),nav=placeMapsUrl(p),fr=ev?familyFriction(ev):null;
    return `<div class="companion-stop ${next?'next':''}"><div class="companion-stop-time">${esc(s.plannedTime||'時間未定')}</div><div class="companion-stop-copy"><small>${next?'下一站':(STOP_LABELS[s.type]||'站點')}</small><strong>${esc(stopTitle(s))}</strong>${p?.address?`<span>${esc(p.address)}</span>`:''}${fr&&fr.known>=2?`<span>帶娃輕鬆度：${esc(fr.label)}</span>`:''}</div><div class="companion-stop-actions">${nav?`<button class="btn primary" data-nav-url="${esc(nav)}">導航</button>`:''}<button class="btn" data-plan-b-search="${esc(s.id)}">Plan B</button>${!s.done?`<button class="btn ghost" data-complete-stop="${esc(s.id)}">完成</button>`:`<span class="badge good">✓ 完成</span>`}</div></div>`;
  }
  function renderTripCompanion(){
    const t=state.itineraries.find(x=>x.id===state.selectedTripId);if(!t){state.tripCompanion=false;return renderTrips();}
    const stops=[...(t.stops||[])].sort((a,b)=>(a.order||0)-(b.order||0)),next=stops.find(s=>!s.done),nextIndex=next?stops.findIndex(s=>s.id===next.id):-1,future=nextIndex>=0?stops.slice(nextIndex+1,nextIndex+3):[];
    return `${offlineBanner()}<div class="companion-head"><button class="btn small" data-exit-companion>‹ 行程</button><div><small>Family Trip Companion</small><h1>${esc(t.title)}</h1><span>${esc(fmtDate(t.date))}</span></div></div>
      ${next?`<section class="companion-next"><div class="section-head"><h2 class="section-title">現在先處理這一站</h2></div>${tripCompanionStopCard(next,{next:true})}</section>`:`<div class="companion-done"><strong>今天的站點都完成了</strong><p>可以回行程調整，或直接回家休息。</p></div>`}
      <section class="companion-tools"><button class="companion-tool" data-view-jump="pack"><strong>${esc(packProgressSummary(t))}</strong><span>外出包</span></button><button class="companion-tool" data-open-trip-normal="${esc(t.id)}"><strong>${stops.filter(s=>s.done).length}/${stops.length}</strong><span>行程進度</span></button>${next?`<button class="companion-tool" data-plan-b-search="${esc(next.id)}"><strong>找備案</strong><span>收藏＋Google</span></button>`:''}</section>
      ${future.length?`<section class="section"><div class="section-head"><h2 class="section-title">接下來</h2></div><div class="companion-upcoming">${future.map(s=>tripCompanionStopCard(s)).join('')}</div></section>`:''}
      <div class="helper companion-disclaimer">出遊模式只整合既有行程、導航、Plan B 與外出包；V4.4 不假裝提供即時天氣或即時車程。</div>`;
  }
  function planBTypeCompatible(stop,e){
    if(!e||e.captureStatus==='inbox')return false;const type=stop?.type||'attraction';if(['attraction','activity'].includes(type))return ['attraction','activity'].includes(e.entityType);return e.entityType===type;
  }
  function planBSavedCandidates(stop){
    const base=stopPlaceObj(stop),baseCounty=String(base?.county||''),baseDistrict=String(base?.district||''),baseGeo=String(base?.geoGroup||'');
    let rows=readyEntities().filter(e=>planBTypeCompatible(stop,e)&&e.id!==stop.entityId&&!explicitAgeConflict(e)).map(e=>{
      const d=base?distanceKmBetween(base,e):null,friction=familyFriction(e);let score=0;
      if(Number.isFinite(d))score+=Math.max(-3,8-d/5);
      else{if(baseCounty&&e.county===baseCounty)score+=8;if(baseGeo&&e.geoGroup===baseGeo)score+=4;if(baseDistrict&&e.district===baseDistrict)score+=2;}
      if(e.toddlerFit==='good')score+=3;else if(e.toddlerFit==='partial')score+=1;if(e.strollerFit==='good')score+=1;if(e.environmentType==='indoor')score+=.5;if(friction.known>=2)score+=Math.max(-2,Math.min(2,friction.score*.3));const pref=familyPreferenceMatch(e);if(pref.sampleCount>=4)score+=Math.max(-1,Math.min(1.5,pref.score));return {e,d,score,friction};
    });
    const baseHasCoords=!!base&&Number.isFinite(base.latitude)&&Number.isFinite(base.longitude);
    if(baseHasCoords){
      rows=rows.filter(x=>Number.isFinite(x.d)&&x.d<=40);
    }else if(base){
      const sameCounty=baseCounty?rows.filter(x=>x.e.county===baseCounty):[];
      const sameGeo=baseGeo?rows.filter(x=>x.e.geoGroup===baseGeo):[];
      rows=sameCounty.length?sameCounty:(sameGeo.length?sameGeo:[]);
    }else{
      rows=[];
    }
    return rows.sort((a,b)=>b.score-a.score).slice(0,8);
  }
  function planBAnchor(stop){const p=stopPlaceObj(stop);return p&&Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)?{latitude:p.latitude,longitude:p.longitude,name:placeName(p)}:null;}
  function planBKnownPlaceIds(stop){
    const ids=new Set(readyEntities().map(e=>String(e.googlePlaceId||e.placeId||'')).filter(Boolean));
    const current=stopPlaceObj(stop);if(current?.googlePlaceId)ids.add(String(current.googlePlaceId));if(current?.placeId)ids.add(String(current.placeId));
    return ids;
  }
  function filterPlanBGoogleCandidates(candidates,stop){
    const known=planBKnownPlaceIds(stop);return (candidates||[]).filter(c=>c?.placeId&&!known.has(String(c.placeId)));
  }
  async function searchNearbyPlanB(stop,{mode='nearby',query=''}={}){
    const anchor=planBAnchor(stop);if(!anchor)throw new Error('no_anchor');const key=JSON.stringify([anchor.latitude,anchor.longitude,stop.type,mode,query]);if(state.inFlightNearbyPlaces.has(key))return state.inFlightNearbyPlaces.get(key);
    const job=fetchJsonWithTimeout('/api/nearby-places',{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',body:JSON.stringify({latitude:anchor.latitude,longitude:anchor.longitude,entityType:stop.type||'attraction',mode,query,radiusKm:15})},16000).then(data=>({...data,candidates:filterPlanBGoogleCandidates(data.candidates||[],stop)})).finally(()=>state.inFlightNearbyPlaces.delete(key));state.inFlightNearbyPlaces.set(key,job);return job;
  }
  function planBCandidateCards(candidates,tripId,stopId){
    return (candidates||[]).map((c,i)=>`<button class="candidate-card plan-b-google-card" data-plan-b-google="${i}" data-trip-id="${esc(tripId)}" data-stop-id="${esc(stopId)}">${c.placeId&&c.hasPhoto?`<div class="candidate-photo remote-photo" data-place-photo="${esc(c.placeId)}" data-photo-name="${esc(c.displayName||'Google 地點')}"><span class="photo-placeholder">📍</span></div>`:''}<div class="candidate-copy"><strong>${esc(c.displayName||'未命名')}</strong><div>${esc(c.formattedAddress||'地址未提供')}</div><small>${Number.isFinite(c.distanceKm)?`約 ${c.distanceKm<10?c.distanceKm.toFixed(1):Math.round(c.distanceKm)} km・`:''}Google 新發現・尚未完整查證</small></div></button>`).join('');
  }
  async function planBModal(tripId,stopId){
    const trip=state.itineraries.find(x=>x.id===tripId),stop=trip?.stops?.find(x=>x.id===stopId);if(!trip||!stop)return;const saved=planBSavedCandidates(stop),anchor=planBAnchor(stop);
    const noAnchorNote=anchor?'':`<div class="plan-b-disabled-note"><strong>目前只能使用「我的收藏備案」</strong><span>主站點尚未綁定 Google 地點，因此無法計算真正的附近距離，也不會假裝這些收藏都在附近。請先補 Google 地點後，再搜尋附近新地點。</span></div>`;
    showModal('Plan B 2.0',`<div class="setting-block"><h3>${esc(stopTitle(stop))} 的備案</h3><p>先用自己的收藏；需要更多選擇時才查 Google Places。Google 新發現只會成為臨時 Plan B，不會自動加入收藏。</p></div><section class="plan-b-section"><div class="plan-b-section-head"><strong>我的收藏備案</strong><small>${anchor?'依距離與帶娃條件排序':'沒有座標時，只顯示同縣市／同區域優先候選'}</small></div><div class="plan-b-saved">${saved.length?saved.map(x=>{const loc=entityLocation(x.e);return `<button class="plan-b-saved-card" data-plan-b-saved="${esc(x.e.id)}" data-trip-id="${esc(trip.id)}" data-stop-id="${esc(stop.id)}"><strong>${esc(x.e.name)}</strong><small>${Number.isFinite(x.d)?`約 ${x.d<10?x.d.toFixed(1):Math.round(x.d)} km・`:loc?`${esc(loc)}・`:''}${esc(x.friction.label)}</small></button>`;}).join(''):`<div class="empty-state compact"><h3>目前沒有合適的收藏備案</h3><p>${anchor?'可以改查 Google Places。':'先補 Google 地點後，再找真正的附近備案。'}</p></div>`}</div></section><section class="plan-b-section"><div class="plan-b-section-head"><strong>附近新地點</strong><small>Google Places｜尚未完整查證</small></div>${anchor?`<div class="plan-b-google-actions"><button class="btn primary" data-plan-b-nearby="${esc(stop.id)}" data-trip-id="${esc(trip.id)}">搜尋附近新地點</button><button class="btn" data-plan-b-text="${esc(stop.id)}" data-trip-id="${esc(trip.id)}">文字搜尋</button></div><div id="planBGoogleResults" class="plan-b-google-results"></div>`:noAnchorNote}</section>`);
  }
  async function runPlanBNearbySearch(tripId,stopId){
    const trip=state.itineraries.find(x=>x.id===tripId),stop=trip?.stops?.find(x=>x.id===stopId),root=$('#planBGoogleResults');if(!stop||!root)return;root.innerHTML='<div class="capture-loading"><strong>正在搜尋 Google 附近地點…</strong><small>只拿候選必要欄位，不會一次對全部候選做 Evidence 查證。</small></div>';
    try{const data=await searchNearbyPlanB(stop,{mode:'nearby'});state.planBGoogleCandidates=data.candidates||[];root.innerHTML=state.planBGoogleCandidates.length?`<div class="helper">附近候選｜點選後只設為臨時 Plan B</div><div class="candidate-list">${planBCandidateCards(state.planBGoogleCandidates,tripId,stopId)}</div><button class="btn ghost full" data-plan-b-text="${esc(stopId)}" data-trip-id="${esc(tripId)}">附近不合適，改用文字搜尋</button>`:'<div class="empty-state compact"><h3>附近沒有找到合適結果</h3><p>可以改用文字搜尋。</p></div>';hydratePlaceImages();}catch(err){root.innerHTML=`<div class="empty-state compact"><h3>Google 附近搜尋失敗</h3><p>${esc(err?.message||'請稍後再試')}</p></div>`;}
  }
  function planBTextSearchModal(tripId,stopId){
    const trip=state.itineraries.find(x=>x.id===tripId),stop=trip?.stops?.find(x=>x.id===stopId);if(!stop)return;const anchor=planBAnchor(stop);showModal('Google 文字搜尋 Plan B',`<form id="planBTextForm" class="form-grid"><div class="field"><label>想找什麼？</label><input name="query" value="${stop.type==='restaurant'?'親子餐廳':'親子 室內景點'}" required maxlength="80"></div><div class="helper">以「${esc(anchor?.name||stopTitle(stop))}」附近為搜尋偏好，不使用一般 Google 網頁搜尋。</div><button class="btn primary">搜尋 Google Places</button><div id="planBTextResults"></div></form>`);$('#planBTextForm').addEventListener('submit',async ev=>{ev.preventDefault();const root=$('#planBTextResults'),q=String(new FormData(ev.currentTarget).get('query')||'').trim();root.innerHTML='<div class="capture-loading"><strong>搜尋中…</strong></div>';try{const data=await searchNearbyPlanB(stop,{mode:'text',query:q});state.planBGoogleCandidates=data.candidates||[];root.innerHTML=state.planBGoogleCandidates.length?`<div class="candidate-list">${planBCandidateCards(state.planBGoogleCandidates,tripId,stopId)}</div>`:'<div class="empty-state compact"><h3>沒有找到地點</h3></div>';hydratePlaceImages();}catch(err){root.innerHTML=`<div class="empty-state compact"><h3>搜尋失敗</h3><p>${esc(err?.message||'請稍後再試')}</p></div>`;}});
  }
  function externalPlanBEvidenceSummary(h={}){
    const xs=[];if(h.toddlerFit==='good')xs.push('幼兒適合');else if(h.toddlerAccess==='good')xs.push('幼兒可去');else if(h.toddlerAccess==='conditional')xs.push('幼兒有條件');if(h.strollerFit==='good')xs.push('推車佳');else if(h.strollerFit==='partial')xs.push('推車部分可用');if(h.environmentType==='indoor')xs.push('室內');if(h.nursingRoomStatus==='available')xs.push('哺乳室');if(h.babyChangingStatus==='available')xs.push('尿布台');return xs.slice(0,3).join('、')||'親子資料待確認';
  }
  async function verifyGooglePlanB(tripId,stopId,placeId){
    if(!placeId||!navigator.onLine)return;
    let website='';try{const d=await fetchJsonWithTimeout(`/api/place-details?placeId=${encodeURIComponent(placeId)}`,{},12000);website=String(d.websiteUri||'');}catch{}
    if(!website)return;
    let result;try{result=await fetchJsonWithTimeout('/api/evidence-resolve',{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',body:JSON.stringify((()=>{const p=state.itineraries.find(x=>x.id===tripId)?.stops?.find(x=>x.id===stopId)?.backupExternalPlace||{};return {name:p.name||'',officialUrl:website,sourceUrls:[],county:p.county||'',district:p.district||'',branchRisk:false};})())},48000);}catch{return;}
    if(!result?.evidenceVerified)return;
    const hints=sourceDecisionHints(result,{currentChildAgeMonths:currentAgeMonths()});
    const allowed=['environmentType','rainSuitability','toddlerFit','toddlerAccess','strollerFit','nursingRoomStatus','babyChangingStatus','familyRestroomStatus','decisionAgeNote'];const evidence={evidenceUrl:result.bestEvidenceUrl||website,verifiedAt:todayISO()};for(const k of allowed)if(hints[k]!==undefined)evidence[k]=hints[k];
    const fresh=await TwinDB.get('itineraries',tripId),stop=fresh?.stops?.find(x=>x.id===stopId);if(!fresh||!stop||String(stop.backupExternalPlace?.placeId||'')!==String(placeId))return;
    stop.backupExternalEvidence=evidence;stop.backupNote=`Google Places 新發現｜官方查證：${externalPlanBEvidenceSummary(evidence)}`;fresh.updatedAt=new Date().toISOString();await TwinDB.put('itineraries',fresh);await reloadData();render();toast(`Plan B 官方資料已補：${externalPlanBEvidenceSummary(evidence)}`,'',null,5200);
  }
  async function setSavedPlanB(tripId,stopId,entityId){
    const trip=state.itineraries.find(x=>x.id===tripId),stop=trip?.stops?.find(x=>x.id===stopId),e=getEntity(entityId);if(!trip||!stop||!e)return;stop.backupEntityId=e.id;stop.backupExternalPlace=null;stop.backupExternalEvidence=null;stop.backupNote='Plan B 2.0｜我的收藏';trip.updatedAt=new Date().toISOString();await TwinDB.put('itineraries',trip);await reloadData();closeModal();render();toast(`已把「${e.name}」設為 Plan B`);
  }
  async function setGooglePlanB(tripId,stopId,candidate){
    const trip=state.itineraries.find(x=>x.id===tripId),stop=trip?.stops?.find(x=>x.id===stopId);if(!trip||!stop||!candidate)return;stop.backupEntityId='';stop.backupExternalPlace=externalPlaceShape({...candidate,name:candidate.displayName,address:candidate.formattedAddress,source:candidate.source||'google-nearby'});stop.backupExternalEvidence=null;stop.backupNote='Google Places 新發現｜親子資料查證中';trip.updatedAt=new Date().toISOString();await TwinDB.put('itineraries',trip);await reloadData();closeModal();render();toast(`已把「${candidate.displayName}」設為臨時 Plan B；正在查證官方親子資料`,'',null,5200);verifyGooglePlanB(tripId,stopId,candidate.placeId).catch(()=>{});
  }

  function packCheckedMap() { return Object.fromEntries(state.packState.map(x=>[x.itemId,!!x.checked])); }
  function renderPack() {
    const checkedMap=packCheckedMap(), total=state.packItems.length, done=state.packItems.filter(x=>checkedMap[x.id]).length;
    const pct=total?Math.round(done/total*100):0, trip=getUpcomingTrip(), stale=packContextIsStale(trip);
    const cats=[...new Set(state.packItems.map(x=>x.cat||'其他'))];
    return `${offlineBanner()}<div class="page-title-row"><div><h1 class="page-title">外出包</h1><p class="page-subtitle">${state.packEdit?'編輯模式：可排序、刪除與新增。':'出門前只看要帶什麼。'}</p></div><div style="display:flex;gap:6px"><button class="btn soft small" data-pack-edit>${state.packEdit?'完成':'編輯'}</button><button class="kebab" data-pack-menu>⋯</button></div></div>
      ${stale?`<div class="pack-context-warning"><div><strong>這份勾選可能來自上一趟</strong><small>${trip?`目前下一趟：${esc(trip.title)}`:'尚無下一趟行程'}</small></div><div><button class="btn small" data-pack-adopt="${esc(trip?.id||'')}">沿用勾選</button><button class="btn primary small" data-pack-reset-for-trip="${esc(trip?.id||'')}">全部重置</button></div></div>`:''}
      <div class="pack-progress"><strong>${stale?'待確認外出包狀態':`已確認 ${done} / ${total}`}</strong><div class="progress-line"><span style="width:${pct}%"></span></div><div class="helper">${pct}%${done===total&&total?'・都準備好了':''}</div></div>
      ${cats.map(cat=>`<section class="pack-group"><div class="pack-group-title">${esc(cat)}（${state.packItems.filter(x=>x.cat===cat&&checkedMap[x.id]).length}/${state.packItems.filter(x=>x.cat===cat).length}）</div><div class="pack-list" data-pack-group="${esc(cat)}">${state.packItems.filter(x=>x.cat===cat).map(item=>packRow(item,checkedMap[item.id])).join('')}</div></section>`).join('')}
      ${state.packEdit?`<div class="section"><button class="btn primary full" data-add-pack>＋ 新增項目</button></div>`:''}`;
  }
  function packRow(item, checked) {
    return `<div class="pack-row ${checked?'checked':''}" data-pack-id="${esc(item.id)}">
      ${state.packEdit?`<div class="drag-handle" data-pack-drag="${esc(item.id)}">≡</div>`:`<input class="pack-check" type="checkbox" data-pack-check="${esc(item.id)}" ${checked?'checked':''} aria-label="${esc(item.label)}" />`}
      <div class="pack-label">${esc(item.label)}</div>
      ${state.packEdit?`<div class="row-actions"><button class="delete-btn" data-delete-pack="${esc(item.id)}" aria-label="刪除">⌫</button></div>`:`<span class="badge">${esc(item.cat||'其他')}</span>`}
    </div>`;
  }

  function render() {
    updateChrome();
    let html='';
    if (state.view==='home') html=renderHome();
    else if (state.view==='explore') html=renderExplore();
    else if (state.view==='detail') html=renderDetail();
    else if (state.view==='trips') html=renderTrips();
    else if (state.view==='pack') html=renderPack();
    app.innerHTML=html;
    bindDynamicInputs();
    if (state.view==='trips' && state.selectedTripId) setupStopDrag();
    if (state.view==='pack' && state.packEdit) setupPackDrag();
    queueMicrotask(hydratePlaceImages);
  }

  function bindDynamicInputs() {
    const search=$('#exploreSearch');
    if (search) search.addEventListener('input', e=>{ state.explore.query=e.target.value; renderExploreOnly(); });
  }
  function renderExploreOnly() { if (state.view==='explore') render(); }

  function showModal(title, body, {wide=false}={}) {
    modalRoot.hidden=false;
    modalRoot.innerHTML=`<section class="modal-sheet ${wide?'wide':''}" role="dialog" aria-modal="true"><div class="modal-head"><h2 class="modal-title">${esc(title)}</h2><button class="close-btn" data-close-modal aria-label="關閉">×</button></div>${body}</section>`;
    document.body.style.overflow='hidden';
  }
  function closeModal() { modalRoot.hidden=true; modalRoot.innerHTML=''; document.body.style.overflow=''; }
  function toast(message, actionLabel='', actionFn=null, timeout=3800) {
    if (state.undoTimer) clearTimeout(state.undoTimer);
    snackbar.hidden=false;
    snackbar.innerHTML=`<div class="snackbar-inner"><span>${esc(message)}</span>${actionLabel?`<button id="snackAction">${esc(actionLabel)}</button>`:''}</div>`;
    if (actionLabel && actionFn) $('#snackAction').onclick=actionFn;
    state.undoTimer=setTimeout(()=>{ snackbar.hidden=true; state.undoTimer=null; },timeout);
  }

  function moreFiltersModal() {
    const f=state.explore;
    showModal('更多篩選', `<div class="form-grid">
      <div class="field"><label>去過狀態</label><select id="fVisited"><option value="" ${!f.visited?'selected':''}>全部</option><option value="no" ${f.visited==='no'?'selected':''}>未去過</option><option value="yes" ${f.visited==='yes'?'selected':''}>已去過</option></select></div>
      <div class="field"><label>室內／室外</label><select id="fIndoor"><option value="" ${!f.indoor?'selected':''}>不限／未確認</option><option value="yes" ${f.indoor==='yes'?'selected':''}>只看已確認室內</option><option value="no" ${f.indoor==='no'?'selected':''}>只看已確認室外</option></select><div class="helper">未確認資料不會被自動判定。</div></div>
      <label class="check-line"><input id="fFavorite" type="checkbox" ${f.favoriteOnly?'checked':''}><span><strong>只看最愛</strong><small>和北中南東、縣市、類型可交叉使用。</small></span></label>
      <div class="form-actions"><button class="btn" data-reset-more>重置</button><button class="btn primary" data-apply-more>套用</button></div>
    </div>`);
  }

  function entityForm(e=null) {
    const edit=!!e; const v=e||{captureStatus:'ready',entityType:'attraction',name:'',region:'',cityRaw:'',ageNote:'',note:'',originalUrl:'',googleMapsUrl:'',visited:false,indoor:null,coverImage:'',googlePlaceId:''};
    const autoDefault=!edit || !v.googlePlaceId || !v.county || !v.environmentType || v.environmentType==='unknown';
    showModal(edit?'編輯資料':'新增資料', `<form id="entityForm" class="form-grid">
      <div class="field"><label>類型</label><select name="entityType">${Object.entries(TYPE_LABELS).map(([x,l])=>`<option value="${x}" ${v.entityType===x?'selected':''}>${l}</option>`).join('')}</select></div>
      ${v.captureStatus==='inbox'?'<div class="setting-block"><h3>待整理收藏</h3><p>補上名稱後就會進正式探索；原始網址不會消失。</p></div>':''}<div class="field"><label>名稱 *</label><input name="name" value="${esc(v.captureStatus==='inbox'&&v.name==='待整理收藏'?'':v.name)}" required maxlength="100" /></div>
      <input type="hidden" name="region" value="${esc(v.region||'')}" />
      <input type="hidden" name="cityRawLegacy" value="${esc(v.cityRaw||'')}" />
      <div class="inline-fields"><div class="field"><label>縣市</label><select name="county"><option value="">未確認</option>${allCountyOptions().map(x=>`<option value="${esc(x)}" ${canonicalCounty(v.county||'')===canonicalCounty(x)?'selected':''}>${esc(x)}</option>`).join('')}</select></div><div class="field"><label>行政區</label><input name="district" value="${esc(v.district||'')}" maxlength="40" placeholder="例如：中正區" /><div class="helper">Google 地點配對後會自動補值；必要時仍可人工修正。</div></div></div>
      ${edit?`<div class="auto-meta-strip"><div><strong>自動資料</strong><small>${esc([v.county,v.district,v.environmentType&&v.environmentType!=='unknown'?decisionLabel('environmentType',v.environmentType):'',deriveRainFromEnvironment(v)!=='unknown'?decisionLabel('rainSuitability',deriveRainFromEnvironment(v)):'',v.toddlerFit&&v.toddlerFit!=='unknown'?decisionLabel('toddlerFit',v.toddlerFit):'',v.strollerFit&&v.strollerFit!=='unknown'?decisionLabel('strollerFit',v.strollerFit):'',v.nursingRoomStatus==='available'?'哺乳室':'',v.babyChangingStatus==='available'?'尿布台':'',v.familyRestroomStatus==='available'?'親子廁所':'',v.decisionAgeNote||v.ageNote,recentOpeningLabel(v)].filter(Boolean).join('・')||'尚無可確認資料')}</small></div><button type="button" class="btn small" data-auto-metadata="${esc(v.id)}">重新自動補資料</button></div>`:''}
      <label class="check-line"><input type="checkbox" name="autoPlace" ${autoDefault?'checked':''} /><span><strong>自動補地點與可確認資料</strong><small>來源頁負責封面／文字證據；Google Places 獨立補地點身分、地址、地區與地圖。兩條都會跑，不互相阻斷。</small></span></label>
      <div class="field"><label>適齡資料</label><input name="ageNote" value="${esc(v.ageNote)}" placeholder="例如：3-7歲（只保存已確認資料）" /></div>
      <div class="field"><label>備註</label><textarea name="note">${esc(v.note)}</textarea></div>
      <div class="field"><label>來源網址</label><input name="sourceUrl" type="url" value="${esc((v.sourceUrls||[])[0]||v.originalUrl||'')}" placeholder="https://..." /></div>
      <div class="field"><label>Google Maps 連結</label><input name="googleMapsUrl" type="url" value="${esc(v.googleMapsUrl||'')}" placeholder="可留白；自動配對成功會補值" /></div>
      <div class="inline-fields"><div class="field"><label>場域類型</label><select name="environmentType"><option value="unknown" ${(v.environmentType||'unknown')==='unknown'?'selected':''}>未確認</option><option value="indoor" ${v.environmentType==='indoor'?'selected':''}>室內</option><option value="outdoor" ${v.environmentType==='outdoor'?'selected':''}>室外</option><option value="mixed" ${v.environmentType==='mixed'?'selected':''}>室內外皆有</option></select></div><div class="field"><label>去過</label><select name="visited"><option value="no" ${!v.visited?'selected':''}>未去</option><option value="yes" ${v.visited?'selected':''}>已去</option></select></div></div>
      <div class="field"><label>育兒設施</label><div class="baby-care-edit-grid"><label>哺乳室<select name="nursingRoomStatus"><option value="unknown" ${(v.nursingRoomStatus||'unknown')==='unknown'?'selected':''}>待確認</option><option value="available" ${v.nursingRoomStatus==='available'?'selected':''}>有</option><option value="unavailable" ${v.nursingRoomStatus==='unavailable'?'selected':''}>無</option></select></label><label>尿布台<select name="babyChangingStatus"><option value="unknown" ${(v.babyChangingStatus||'unknown')==='unknown'?'selected':''}>待確認</option><option value="available" ${v.babyChangingStatus==='available'?'selected':''}>有</option><option value="unavailable" ${v.babyChangingStatus==='unavailable'?'selected':''}>無</option></select></label><label>親子廁所<select name="familyRestroomStatus"><option value="unknown" ${(v.familyRestroomStatus||'unknown')==='unknown'?'selected':''}>待確認</option><option value="available" ${v.familyRestroomStatus==='available'?'selected':''}>有</option><option value="unavailable" ${v.familyRestroomStatus==='unavailable'?'selected':''}>無</option></select></label></div><div class="helper">Evidence Resolver V2 會優先從官方／政府頁面補值；不確定時保持待確認。</div></div>
      <div class="field"><label>自己的封面圖片（選填）</label><input name="coverFile" type="file" accept="image/*" /><div class="helper">自己上傳的照片優先於網路封面；不需要每筆人工上傳。</div></div>
      <div class="form-actions">${edit?`<button type="button" class="btn danger" data-delete-entity="${esc(v.id)}">刪除</button>`:''}<button class="btn primary" type="submit">${edit?'儲存':'新增'}</button></div>
    </form>`);
    $('#entityForm').addEventListener('submit', async ev=>{
      ev.preventDefault(); const fd=new FormData(ev.currentTarget); const parsed=parseSimpleAge(fd.get('ageNote'));
      let cover=v.coverImage||''; const file=fd.get('coverFile'); if (file && file.size) cover=await compressImage(file);
      const source=String(fd.get('sourceUrl')||'').trim();
      const oldSource=(v.sourceUrls||[])[0]||v.originalUrl||''; const sourceChanged=normalizedSourceUrl(source)!==normalizedSourceUrl(oldSource);
      const nextType=String(fd.get('entityType')), nextName=String(fd.get('name')).trim();
      const nameChanged=edit && normalizedPlaceName(nextName)!==normalizedPlaceName(v.name||'');
      const typeChanged=edit && nextType!==v.entityType;
      const identityChanged=!!(nameChanged||typeChanged);
      const autoPlace=fd.get('autoPlace')==='on';
      const manualEnvironment=String(fd.get('environmentType')||'unknown');
      const manualIndoor=manualEnvironment==='indoor'?true:manualEnvironment==='outdoor'?false:null;
      const manualCounty=canonicalCounty(String(fd.get('county')||''));
      const manualDistrict=String(fd.get('district')||'').trim();
      const legacyRaw=String(fd.get('cityRawLegacy')||'').trim();
      const manualMap=String(fd.get('googleMapsUrl')).trim();
      const manualNursing=String(fd.get('nursingRoomStatus')||'unknown'),manualChanging=String(fd.get('babyChangingStatus')||'unknown'),manualRestroom=String(fd.get('familyRestroomStatus')||'unknown');
      const manualAgeNote=String(fd.get('ageNote')).trim();
      const manualDecisionFields=identityChanged?{}:{...(v.manualDecisionFields||{})};
      const markManual=(field,next,prev,unknown='unknown')=>{if(String(next??'')===String(prev??''))return;if(next===unknown||next===''||next===null||next===undefined)delete manualDecisionFields[field];else manualDecisionFields[field]=true;};
      markManual('environmentType',manualEnvironment,v.environmentType||'unknown');markManual('nursingRoomStatus',manualNursing,v.nursingRoomStatus||'unknown');markManual('babyChangingStatus',manualChanging,v.babyChangingStatus||'unknown');markManual('familyRestroomStatus',manualRestroom,v.familyRestroomStatus||'unknown');markManual('ageNote',manualAgeNote,v.ageNote||'','');
      const out={...v,
        id:v.id||uuid(nextType), entityType:nextType, name:nextName, region:String(fd.get('region')), cityRaw:(manualCounty||manualDistrict)?`${manualCounty}${manualDistrict}`:legacyRaw,
        ageNote:manualAgeNote, minAgeMonths:parsed.minAgeMonths, maxAgeMonths:parsed.maxAgeMonths,
        note:String(fd.get('note')).trim(), sourceUrls:source?[source]:[], originalUrl:source,
        googleMapsUrl:manualMap, indoor:manualIndoor, visited:fd.get('visited')==='yes',
        favorite:v.favorite||false, captureStatus:'ready', captureAutoStatus:v.captureStatus==='inbox'?'confirmed':(v.captureAutoStatus||''), captureCandidates:[], sourcePlatform:sourceChanged?sourcePlatformFromUrl(source):(v.sourcePlatform||sourcePlatformFromUrl(source)), familyRating:Number.isFinite(v.familyRating)?v.familyRating:null,revisitIntent:v.revisitIntent||'',familyTags:v.familyTags||[],familyNote:v.familyNote||'',familyReviewedAt:v.familyReviewedAt||'', coverImage:cover, images:v.images||[], imageSource:cover?'user-local':(sourceChanged?'':(v.sourceCoverUrl?'source-url':(v.googlePlaceId?'google-places':''))), imageUpdatedAt:cover?new Date().toISOString():(v.imageUpdatedAt||''), updatedAt:new Date().toISOString(), createdAt:v.createdAt||new Date().toISOString(),
        county:manualCounty||((identityChanged)?'':(v.county||'')),district:manualDistrict||((identityChanged)?'':(v.district||'')),address:identityChanged?'':(v.address||''),latitude:identityChanged?null:(v.latitude??null),longitude:identityChanged?null:(v.longitude??null),tags:v.tags||[],
        sourceCoverUrl:sourceChanged?'':(v.sourceCoverUrl||''), sourceCoverStatus:sourceChanged?'':(v.sourceCoverStatus||''), sourceCoverMethod:sourceChanged?'':(v.sourceCoverMethod||''), sourceCoverDomain:sourceChanged?'':(v.sourceCoverDomain||''), sourceCoverPageUrl:sourceChanged?'':(v.sourceCoverPageUrl||''),
        googlePlaceId:identityChanged?'':(v.googlePlaceId||''), placeDisplayName:identityChanged?'':(v.placeDisplayName||''), placeMatchStatus:identityChanged?'stale-identity-changed':(v.placeMatchStatus||''),
        placeTypes:identityChanged?[]:(v.placeTypes||[]),placePrimaryType:identityChanged?'':(v.placePrimaryType||''),placeOpeningDate:identityChanged?null:(v.placeOpeningDate||null),placeAccessibilityOptions:identityChanged?null:(v.placeAccessibilityOptions||null),placeWebsiteUrl:identityChanged?'':(v.placeWebsiteUrl||''),
        environmentType:manualEnvironment!=='unknown'?manualEnvironment:(identityChanged?'unknown':(v.environmentType||'unknown')),
        rainSuitability:identityChanged?'unknown':(v.rainSuitability||'unknown'),toddlerFit:identityChanged?'unknown':(v.toddlerFit||'unknown'),toddlerAccess:identityChanged?'unknown':(v.toddlerAccess||'unknown'),strollerFit:identityChanged?'unknown':(v.strollerFit||'unknown'),waterPlay:identityChanged?'unknown':(v.waterPlay||'unknown'),visitDuration:identityChanged?'unknown':(v.visitDuration||'unknown'),nursingRoomStatus:identityChanged&&!manualDecisionFields.nursingRoomStatus?'unknown':manualNursing,babyChangingStatus:identityChanged&&!manualDecisionFields.babyChangingStatus?'unknown':manualChanging,familyRestroomStatus:identityChanged&&!manualDecisionFields.familyRestroomStatus?'unknown':manualRestroom,
        decisionMetadataVersion:identityChanged?'':(v.decisionMetadataVersion||''),decisionEligible:identityChanged?true:(v.decisionEligible??true),decisionTags:identityChanged?[]:(v.decisionTags||[]),decisionAgeNote:identityChanged?'':(v.decisionAgeNote||''),decisionMinAgeMonths:identityChanged?null:(v.decisionMinAgeMonths??null),decisionMaxAgeMonths:identityChanged?null:(v.decisionMaxAgeMonths??null),decisionConfidence:identityChanged?'U':(v.decisionConfidence||'U'),decisionEvidenceUrl:identityChanged?'':(v.decisionEvidenceUrl||''),decisionEvidenceNote:identityChanged?'':(v.decisionEvidenceNote||''),decisionVerifiedAt:identityChanged?'':(v.decisionVerifiedAt||''),manualDecisionFields,decisionFieldProvenance:identityChanged?{}:{...(v.decisionFieldProvenance||{})},decisionEvidenceConflicts:identityChanged?{}:{...(v.decisionEvidenceConflicts||{})}
      };
      out.decisionFieldProvenance={...(out.decisionFieldProvenance||{})};
      for(const field of Object.keys(manualDecisionFields)){
        const value=field==='ageNote'?out.ageNote:out[field];
        out.decisionFieldProvenance[field]={sourceType:'manual',authorityRank:100,url:'',verifiedAt:todayISO(),value};
      }
      const geoOut=inferGeoEntity(out);
      await TwinDB.put('entities',geoOut); await reloadData(); closeModal(); state.selectedEntityId=geoOut.id; setView('detail',{entityId:geoOut.id});
      if (autoPlace) {
        toast(identityChanged?'已儲存；舊地點配對已失效，正在重新辨識…':(edit?'已儲存，正在補齊地點與可確認資料…':'已新增，正在自動補齊資料…'), '', null, 6500);
        await autoEnrichEntity(geoOut,{interactive:true});
      } else toast(identityChanged?'已儲存；舊 Google 地點配對已清除':(edit?'已儲存':'已新增'));
    });
  }

  async function searchPlaceForEntity(e) {
    const payload={name:e.name,location:[e.county,e.district].filter(Boolean).join('')||e.cityRaw||'',entityType:e.entityType,branchRisk:placeBranchRisk(e)};
    const key=JSON.stringify(payload);if(state.inFlightPlaceSearch.has(key))return state.inFlightPlaceSearch.get(key);
    const job=fetchJsonWithTimeout('/api/place-search',{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',body:JSON.stringify(payload)},16000).finally(()=>state.inFlightPlaceSearch.delete(key));
    state.inFlightPlaceSearch.set(key,job);return job;
  }
  async function placeWebsiteForId(placeId=''){
    const id=String(placeId||'').trim();if(!id)return'';if(state.inFlightPlaceDetails.has(id))return state.inFlightPlaceDetails.get(id);
    const job=fetchJsonWithTimeout(`/api/place-details?placeId=${encodeURIComponent(id)}`,{cache:'no-store'},12000).then(d=>String(d.websiteUri||'')).catch(()=> '').finally(()=>state.inFlightPlaceDetails.delete(id));
    state.inFlightPlaceDetails.set(id,job);return job;
  }
  async function ensurePlaceWebsite(e){
    if(!e?.googlePlaceId||e.placeWebsiteUrl)return e;
    const website=await placeWebsiteForId(e.googlePlaceId);if(!website)return e;
    const out={...e,placeWebsiteUrl:website,updatedAt:new Date().toISOString()};await TwinDB.put('entities',out);return out;
  }

  const INDOOR_PLACE_TYPES=new Set(['museum','art_gallery','library','movie_theater','shopping_mall','children_amusement_center','amusement_center','bowling_alley']);
  const OUTDOOR_PLACE_TYPES=new Set(['park','national_park','playground','botanical_garden','hiking_area','campground','wildlife_park','zoo']);
  // V4.3.8: aquarium / amusement_park are not hard environment evidence by themselves.
  const AMBIGUOUS_ENV_PLACE_TYPES=new Set(['amusement_park','aquarium','tourist_attraction','visitor_center']);
  function autoMetadataValueMissing(field,value){
    if(value===undefined||value===null||value==='')return true;
    if(['environmentType','rainSuitability','toddlerFit','toddlerAccess','strollerFit','waterPlay','visitDuration','nursingRoomStatus','babyChangingStatus','familyRestroomStatus'].includes(field))return value==='unknown';
    return false;
  }

  function environmentHintFromPlace(c={},e={}){
    const types=new Set([c.primaryType,...(c.types||[])].filter(Boolean));
    const label=`${c.displayName||''} ${c.primaryTypeLabel||''}`;
    if(/室內(樂園|遊戲|親子|水族|展館|館|場)|室內親子|室內遊戲|全室內/.test(label)) return {value:'indoor',reason:'名稱／類型明確為室內'};
    if(/室內外|複合式/.test(label)) return {value:'mixed',reason:'名稱顯示室內外混合'};
    if([...types].some(t=>INDOOR_PLACE_TYPES.has(t))) return {value:'indoor',reason:`Google Places 類型：${[...types].find(t=>INDOOR_PLACE_TYPES.has(t))}`};
    if([...types].some(t=>OUTDOOR_PLACE_TYPES.has(t))) return {value:'outdoor',reason:`Google Places 類型：${[...types].find(t=>OUTDOOR_PLACE_TYPES.has(t))}`};
    if([...types].some(t=>AMBIGUOUS_ENV_PLACE_TYPES.has(t))) return null;
    return null;
  }

  function evidenceSentences(text=''){
    return String(text).replace(/\s+/g,' ').split(/(?<=[。；;！!？?])|[\n\r]+/).map(x=>x.trim()).filter(Boolean);
  }
  function wholeVenueAgeFragment(s=''){
    const patterns=[
      /(?:本館|全館|本園區|全園區|園區整體|本場館|全場館)[^。；;，,]{0,20}?(?:適合|建議|限定|限|年齡|對象(?:為)?)[^。；;，,]{0,12}?\d{1,2}\s*(?:(?:-|~|～|至|到)\s*\d{1,2}\s*)?歲(?:以上|以下)?/,
      /(?:入場|入園|參觀年齡)[^。；;，,]{0,18}?(?:限定|限|年齡|為|適合)?[^。；;，,]{0,8}?\d{1,2}\s*(?:(?:-|~|～|至|到)\s*\d{1,2}\s*)?歲(?:以上|以下)?/
    ];
    for(const re of patterns){const m=String(s).match(re);if(m)return m[0];}
    return '';
  }
  function hasWholeVenueAgeScope(s=''){return !!wholeVenueAgeFragment(s);}
  function isFacilityScopedAgeSentence(s=''){
    const facility=/(溜滑梯|滑梯|遊具|設施|攀爬|滑索|戲水池|水道|賽道|遊樂設施|摩天輪|雲霄飛車|碰碰車|旋轉木馬|單項|項目|體驗區|遊戲區|挑戰區|高塔|彈跳床|鞦韆|(?:[A-DＡ-Ｄa-d1-4一二三四]\s*區)|(?:[A-DＡ-Ｄa-d1-4一二三四]\s*館))/;
    return facility.test(s) && !hasWholeVenueAgeScope(s);
  }
  function structuredAgeHint(lo,hi,label){
    const a=Number(lo),b=hi===null?null:Number(hi);
    if(!Number.isFinite(a)||a<0||a>18) return null;
    if(b!==null && (!Number.isFinite(b)||b<a||b>18)) return null;
    return {ageNote:`網路明確標示：${label}`,minAgeMonths:a*12,maxAgeMonths:b===null?null:b*12};
  }
  function parseAgeHintClause(s=''){
    let m=s.match(/(?:適合|建議|限定|限|年齡|對象)[^。；;，,]{0,24}?(\d{1,2})\s*(?:-|~|～|至|到)\s*(\d{1,2})\s*歲/);
    if(!m) m=s.match(/(\d{1,2})\s*(?:-|~|～|至|到)\s*(\d{1,2})\s*歲[^。；;，,]{0,20}?(?:適合|可玩|可使用|兒童|幼兒|家庭)/);
    if(m) return structuredAgeHint(m[1],m[2],`${m[1]}-${m[2]}歲`);
    m=s.match(/(?:適合|建議|限定|限|年齡|對象)[^。；;，,]{0,24}?(\d{1,2})\s*歲以上/);
    if(m) return structuredAgeHint(m[1],null,`${m[1]}歲以上`);
    m=s.match(/(?:適合|建議|限定|限|年齡|對象)[^。；;，,]{0,24}?(\d{1,2})\s*歲以下/);
    if(m){const hi=Number(m[1]);if(hi>=0&&hi<=18)return {ageNote:`網路明確標示：${hi}歲以下`,minAgeMonths:null,maxAgeMonths:hi*12};}
    return null;
  }
  function ageHintFromSentence(s=''){
    if(!s) return null;
    // Whole-venue wording outranks local equipment and pricing clauses in the same sentence.
    const venueFragment=wholeVenueAgeFragment(s);
    if(venueFragment){const v=parseAgeHintClause(`年齡 ${venueFragment}`);if(v)return v;}
    if(isFacilityScopedAgeSentence(s)) return null;
    for(const clause of String(s).split(/[，,]/).map(x=>x.trim()).filter(Boolean)){
      if(/(免費|票價|門票|收費|優惠)/.test(clause)) continue;
      const hit=parseAgeHintClause(clause);if(hit)return hit;
    }
    return null;
  }
  function scopedNegationStatus(sentences=[],positiveRe,negativeRe,localScopeRe=null){
    let positive=false,negative=false,localNegative=false;
    for(const s of sentences){
      if(negativeRe.test(s)){
        if(localScopeRe&&localScopeRe.test(s))localNegative=true;else negative=true;
      }
      if(positiveRe.test(s))positive=true;
    }
    if(positive&&localNegative)return 'partial';
    if(negative&&positive)return 'conflict';
    if(negative)return 'unavailable';
    if(positive)return 'available';
    return null;
  }
  function strollerHintFromSentences(sentences=[]){
    let positive=false,wholePoor=false,localPoor=false;
    const localScope=/(?:高塔|遊戲區|體驗區|單項|設施|遊具|水域|展區|部分|局部|部分區域|部分路段|乘車區|月台|入口外側|(?:[A-DＡ-Ｄa-d1-4一二三四]\s*區)|(?:[A-DＡ-Ｄa-d1-4一二三四]\s*館))/;
    for(const raw of sentences){
      if(!/(推車|嬰兒車|娃娃車)/.test(raw))continue;
      const s=String(raw);
      const temporalPositive=/(?:原本|過去|先前|曾經)[^。；;]{0,18}?(?:不可|禁止|不得|不提供|無法)[^。；;]{0,18}?(?:推車|嬰兒車|娃娃車)[^。；;]{0,30}?(?:目前|現在|現已|如今|已開放|已改善)[^。；;]{0,18}?(?:可推|可使用|可進入|友善)|(?:原本|過去|先前|曾經)[^。；;]{0,18}?(?:推車|嬰兒車|娃娃車)[^。；;]{0,18}?(?:不可|禁止|不得|無法)[^。；;]{0,30}?(?:目前|現在|現已|如今|已開放|已改善)[^。；;]{0,18}?(?:可推|可使用|可進入|友善)/.test(s);
      const doubleNeg=/(?:並非|不是|非)[^。；;]{0,5}(?:不提供|不可|不能|禁止|沒有|無法)[^。；;]{0,12}?(?:推車|嬰兒車|娃娃車)|(?:推車|嬰兒車|娃娃車)[^。；;]{0,10}?(?:並非|不是)[^。；;]{0,5}(?:不可|不能|禁止|無法)/.test(s);
      const exceptionLocal=/(?:除|除了)[^。；;]{0,18}?(?:遊戲區|展區|設施|高塔|水域|月台|部分區域)[^。；;]{0,6}?(?:外|之外)[^。；;]{0,24}?(?:全園區|全館|主要區域|其他區域)?[^。；;]{0,12}?(?:可推|可使用)[^。；;]{0,8}?(?:推車|嬰兒車|娃娃車)|(?:僅|只有|只限)[^。；;]{0,10}?(?:部分|特定)[^。；;]{0,10}?(?:區域|展區|路段)[^。；;]{0,10}?(?:可推|可使用)[^。；;]{0,8}?(?:推車|嬰兒車|娃娃車)/.test(s);
      if(exceptionLocal)localPoor=true;
      const neg=!temporalPositive&&!doubleNeg&&/(推車|嬰兒車|娃娃車)[^。；;]{0,18}?(不可|禁止|不得|不建議|不適合|無法|需.*寄放|必須.*寄放|停放外側)|(?:不可|禁止|不得|不建議|不適合|無法)[^。；;]{0,18}?(推車|嬰兒車|娃娃車)|(?:請|須|需)[^。；;]{0,12}?(?:將)?(?:推車|嬰兒車|娃娃車)[^。；;]{0,12}?(?:停放|寄放)/.test(s);
      if(neg){if(localScope.test(s))localPoor=true;else wholePoor=true;}
      if(temporalPositive||doubleNeg||/(推車|嬰兒車|娃娃車)[^。；;]{0,18}?(友善|方便|可進入|可進|可推|可使用|可租借|租借|可參觀)|(?:提供|備有|免費借用)[^。；;]{0,12}?(嬰兒車|推車|娃娃車)(?![^。；;]{0,5}寄放)|(?:全館|全園區|園區|館內)?[^。；;]{0,10}?(?:可推|可使用)[^。；;]{0,10}?(?:嬰兒車|推車|娃娃車)/.test(s))positive=true;
    }
    if(wholePoor)return 'poor';
    if(localPoor)return 'partial';
    if(positive)return 'good';
    return null;
  }
  function babyCareHint(sentences=[],kind){
    const defs={
      nursing:{term:/(哺乳室|哺集乳室|哺乳空間|育嬰室|母嬰室)/,neg:/(?:無|沒有|未設|未提供|不提供|暫無)[^。；;]{0,12}(?:哺乳室|哺集乳室|哺乳空間|育嬰室|母嬰室)/},
      changing:{term:/(尿布台|尿布更換台|換尿布|尿布更換區)/,neg:/(?:無|沒有|未設|未提供|不提供|暫無)[^。；;]{0,12}(?:尿布台|尿布更換台|尿布更換區)/},
      restroom:{term:/(親子廁所|親子洗手間|家庭廁所)/,neg:/(?:無|沒有|未設|未提供|不提供|暫無)[^。；;]{0,12}(?:親子廁所|親子洗手間|家庭廁所)/}
    };
    const d=defs[kind];let pos=false,neg=false;
    for(const raw of sentences){
      const s=String(raw);if(!d.term.test(s))continue;
      const temporalPositive=/(?:原(?:本)?|過去|先前|曾經)[^。；;]{0,12}?(?:無|沒有|未設|未提供|不提供)[^。；;]{0,12}?(?:哺乳室|哺集乳室|哺乳空間|育嬰室|母嬰室|尿布台|尿布更換台|尿布更換區|親子廁所|親子洗手間|家庭廁所)[^。；;]{0,30}?(?:目前|現在|現已|如今|已新增|新增|增設|已設置|已提供)[^。；;]{0,12}?(?:哺乳室|哺集乳室|哺乳空間|育嬰室|母嬰室|尿布台|尿布更換台|尿布更換區|親子廁所|親子洗手間|家庭廁所)/.test(s);
      const temporalNegative=/(?:原(?:本)?|原先|過去|先前|曾經)[^。；;]{0,12}?(?:設有|有|提供|可使用)[^。；;]{0,12}?(?:哺乳室|哺集乳室|哺乳空間|育嬰室|母嬰室|尿布台|尿布更換台|尿布更換區|親子廁所|親子洗手間|家庭廁所)[^。；;]{0,30}?(?:目前|現在|現已|如今|已取消|已停用|不再|暫停)[^。；;]{0,12}?(?:提供|使用|開放)?/.test(s);
      const doubleNeg=/(?:並非|不是|非)[^。；;]{0,5}(?:無|沒有|未設|未提供|不提供|暫無)[^。；;]{0,12}?(?:哺乳室|哺集乳室|哺乳空間|育嬰室|母嬰室|尿布台|尿布更換台|尿布更換區|親子廁所|親子洗手間|家庭廁所)/.test(s);
      if(temporalPositive||doubleNeg){pos=true;continue;}
      if(temporalNegative){neg=true;continue;}
      if(d.neg.test(s))neg=true;else pos=true;
    }
    if(pos&&neg)return 'conflict';if(neg)return 'unavailable';if(pos)return 'available';return null;
  }
  function sourceDecisionHints(source={},e={}){
    const text=`${source.pageTitle||source.title||''} ${source.pageDescription||''} ${source.evidenceText||''}`.replace(/\s+/g,' ').trim();
    const out={};if(!text)return out;const sentences=evidenceSentences(text);
    const noTheme=text.replace(/森林主題|森林風|森林系|叢林主題|戶外風格/g,'');
    const wholeIndoor=sentences.some(s=>/(?:本館|全館|本場館|全場館|本設施|全室內)[^。；]{0,32}(?:室內|展館|館內)|全室內/.test(s));
    const wholeOutdoor=sentences.some(s=>/(?:本園區|全園區|本場域|全場域)[^。；]{0,32}(?:戶外|室外)|全戶外/.test(s));
    const eventOutdoor=sentences.some(s=>/(?:活動|期間限定|週末|展演|市集)[^。；]{0,28}(?:戶外|室外)|(?:戶外|室外)[^。；]{0,20}(?:活動|展演|市集)/.test(s));
    const indoorHit=/全室內|室內(?:親子|樂園|遊戲|遊戲區|展館|館|空間|場館|水族)|館內[^。；]{0,40}(?:展區|參觀|設施|電梯|嬰兒車|哺乳|廁所)/.test(noTheme);
    const outdoorHit=/戶外[^。；]{0,20}(?:樂園|園區|遊戲|空間|體驗|景點)|森林(?:步道|園區|公園|遊樂區)|步道|露天|戶外場域/.test(noTheme);
    if(wholeIndoor&&!wholeOutdoor)out.environmentType='indoor';
    else if(wholeOutdoor&&!wholeIndoor)out.environmentType='outdoor';
    else if(/室內外|室內、?外|戶外及室內/.test(noTheme)||(indoorHit&&outdoorHit&&!eventOutdoor))out.environmentType='mixed';
    else if(indoorHit&&!outdoorHit)out.environmentType='indoor';
    else if(outdoorHit&&!indoorHit)out.environmentType='outdoor';

    for(const sentence of sentences){
      const age=ageHintFromSentence(sentence);if(age){Object.assign(out,age);break;}
      if(isFacilityScopedAgeSentence(sentence)&&/\d{1,2}\s*(?:-|~|～|至|到)?\s*\d{0,2}\s*歲/.test(sentence))out.facilityAgeEvidence=sentence.slice(0,160);
    }
    const compositeAgeSentences=sentences.filter(s=>!isFacilityScopedAgeSentence(s));
    const matchComposite=(andMode=true)=>{for(const s of compositeAgeSentences){
      const join=andMode?'(?:且|並且|及|&|[+＋])':'(?:或|[/／])';
      // A minimum-age leg must not consume a later accompaniment clause such as
      // “12歲以下須與成人同行”. Without this boundary, “身高90cm，且12歲以下…”
      // can be misread as an eligibility rule of “12歲且90cm”.
      const minAge=`(\\d{1,2})\\s*(?:足\\s*)?歲(?!\\s*以下)(?:以上)?`;
      const a=new RegExp(`(?:須|需|必須|限)?\\s*(?:(?:年滿|滿)\\s*)?${minAge}[^。；]{0,28}?${join}[^。；]{0,28}?身高\\s*(?:滿|達|至少)?\\s*(\\d{2,3})\\s*(?:公分|cm)(?:以上)?`,'i');
      const b=new RegExp(`身高\\s*(?:滿|達|至少)?\\s*(\\d{2,3})\\s*(?:公分|cm)(?:以上)?[^。；]{0,28}?${join}[^。；]{0,28}?(?:(?:須|需|必須)?\\s*(?:年滿|滿)\\s*)?${minAge}`,'i');
      const m=s.match(a)||s.match(b);if(m)return m;
    }return null;};
    // OR is checked first because it is the less restrictive eligibility relation and
    // must not be overwritten by a later accompaniment “且…歲以下” clause.
    const ageHeight=matchComposite(false);
    const ageHeightAnd=ageHeight?null:matchComposite(true);
    if(ageHeight){let age,cm;if(Number(ageHeight[1])<=18){age=Number(ageHeight[1]);cm=Number(ageHeight[2]);}else{cm=Number(ageHeight[1]);age=Number(ageHeight[2]);}if(age<=18&&cm>=50&&cm<=220){out.decisionAgeNote=`官方條件：滿${age}歲或身高${cm}公分以上`;out.toddlerFit='partial';out.toddlerAccess='conditional';}}
    if(ageHeightAnd){let age,cm;if(Number(ageHeightAnd[1])<=18){age=Number(ageHeightAnd[1]);cm=Number(ageHeightAnd[2]);}else{cm=Number(ageHeightAnd[1]);age=Number(ageHeightAnd[2]);}if(age<=18&&cm>=50&&cm<=220){out.decisionAgeNote=`官方條件：滿${age}歲且身高${cm}公分以上`;if(Number.isFinite(e.currentChildAgeMonths)&&e.currentChildAgeMonths<age*12){out.toddlerFit='older';out.toddlerAccess='restricted';}else{out.toddlerFit='partial';out.toddlerAccess='conditional';}}}
    const multiAge=/(全齡|全年齡|各年齡|不同年齡|分齡|共融)[^。；]{0,40}(?:遊戲場|公園|園區|設施|遊具)|(?:遊戲場|公園|園區)[^。；]{0,40}(?:全齡|全年齡|各年齡|不同年齡|分齡|共融)/.test(text);
    if(multiAge&&!out.ageNote){out.toddlerFit='good';out.toddlerAccess='good';out.decisionAgeNote='分齡／全齡親子場域；個別設施限制依現場標示';}

    const stroller=strollerHintFromSentences(sentences);if(stroller)out.strollerFit=stroller;
    else if(/(?:娃娃推車|嬰兒車|推車)[^。；]{0,40}?(?:可以|可).*參觀/.test(text)&&/(?:電梯|坡道|無障礙)/.test(text))out.strollerFit='good';

    const nursing=babyCareHint(sentences,'nursing'),changing=babyCareHint(sentences,'changing'),restroom=babyCareHint(sentences,'restroom');
    if(nursing&&nursing!=='conflict')out.nursingRoomStatus=nursing;else if(nursing==='conflict')out.nursingRoomConflict=true;
    if(changing&&changing!=='conflict')out.babyChangingStatus=changing;else if(changing==='conflict')out.babyChangingConflict=true;
    if(restroom&&restroom!=='conflict')out.familyRestroomStatus=restroom;else if(restroom==='conflict')out.familyRestroomConflict=true;

    if(/(?:雨天|下雨|雨勢)[^。；;]{0,18}?(?:休園|休館|不開放|暫停|不建議|不適合|取消)/.test(text))out.rainSuitability='poor';
    else if(/(?:雨天|下雨)[^。；;]{0,18}?(?:照常|可參觀|可遊玩|也能玩|不受影響|適合)/.test(text))out.rainSuitability='good';

    const childMonths=Number.isFinite(e.currentChildAgeMonths)?e.currentChildAgeMonths:null;
    if(!out.toddlerFit&&(out.minAgeMonths!==undefined||out.maxAgeMonths!==undefined)){
      const lo=Number.isFinite(out.minAgeMonths)?out.minAgeMonths:null,hi=Number.isFinite(out.maxAgeMonths)?out.maxAgeMonths:null;
      if(Number.isFinite(childMonths)&&((lo!==null&&childMonths<lo)||(hi!==null&&childMonths>hi)))out.toddlerFit='older';else out.toddlerFit='good';
      out.toddlerAccess=out.toddlerFit==='older'?'restricted':'good';
    }
    if(!out.toddlerFit&&/(?:適合|歡迎|專為)[^。；;]{0,18}?(?:幼兒|嬰幼兒|學齡前|親子)|(?:幼兒|嬰幼兒|學齡前)[^。；;]{0,18}?(?:適合|友善|可玩|可參觀)|親子友善/.test(text)){out.toddlerFit='good';out.toddlerAccess='good';}
    else if(!out.toddlerFit&&/(?:親子|兒童)[^。；;]{0,18}?(?:參觀|遊玩|體驗|同行)|(?:未滿|未達)\s*\d{1,2}\s*歲[^。；;]{0,18}?(?:陪同|可入館|可入場)/.test(text)){out.toddlerFit='partial';out.toddlerAccess='good';}
    const youngAdmission=/(?:未滿|未達)\s*[0-6]\s*歲(?:兒童|孩童)?[^。；]{0,30}?(?:免費|免票|0\s*元|可入館|可入場)/.test(text);
    const explicitBabyVisit=/嬰兒副食品|嬰幼兒[^。；]{0,20}(?:參觀|入館|友善)|(?:館內提供|免費借用)[^。；]{0,20}嬰兒車/.test(text);
    if((youngAdmission||explicitBabyVisit)&&(out.strollerFit==='good'||out.nursingRoomStatus==='available'||out.babyChangingStatus==='available')){
      out.toddlerAccess='good';if(!out.toddlerFit)out.toddlerFit='partial';
      if(!out.decisionAgeNote)out.decisionAgeNote='官方資訊顯示幼兒可入場／可使用嬰幼兒服務；實際遊玩適配仍依場館內容判定';
    }
    return out;
  }

  const EVIDENCE_FIELD_AUTHORITY={manual:100,official:90,government:90,first_party:75,verified_source:52,web_source:40,google:35,catalog:20,derived:25,legacy_auto:25};
  const EVIDENCE_FIELDS=['environmentType','rainSuitability','toddlerFit','toddlerAccess','strollerFit','nursingRoomStatus','babyChangingStatus','familyRestroomStatus','decisionAgeNote','ageNote'];
  function evidenceRank(prov={}){return Number(prov.authorityRank??EVIDENCE_FIELD_AUTHORITY[prov.sourceType]??0);}
  function evidenceTier(prov={}){
    const t=String(prov.sourceType||'');
    if(t==='manual'||evidenceRank(prov)>=100)return 100;
    if(t==='official'||t==='government')return 90;
    if(t==='first_party')return 75;
    if(t==='verified_source')return 52;
    if(t==='web_source')return 40;
    if(t==='google')return 35;
    if(t==='derived'||t==='legacy_auto'||t==='catalog')return 20;
    const r=evidenceRank(prov);return r>=85?90:r>=70?75:r>=50?52:r>=35?40:r>0?20:0;
  }
  function parseEvidenceTime(v=''){const t=Date.parse(v||'');return Number.isFinite(t)?t:0;}
  function sourceAuthorityFromUrl(url=''){try{const h=new URL(url).hostname.toLowerCase();if(h.endsWith('.gov.tw'))return {sourceType:'government',authorityRank:90};}catch{}return {sourceType:'verified_source',authorityRank:52};}
  function evidencePageCandidates(source={},e={}){
    const pages=Array.isArray(source.evidencePages)&&source.evidencePages.length?source.evidencePages:[{url:source.bestEvidenceUrl||source.finalUrl||'',title:source.pageTitle||'',evidenceText:source.evidenceText||'',sourceType:source.sourceType||'',authorityRank:source.authorityRank,publishedAt:source.publishedAt||''}];
    const out=[];
    for(const p of pages){
      const auth=Number.isFinite(Number(p.authorityRank))?{sourceType:p.sourceType||'verified_source',authorityRank:Number(p.authorityRank)}:sourceAuthorityFromUrl(p.url||'');
      const hint=sourceDecisionHints({pageTitle:p.title||'',evidenceText:p.evidenceText||'',evidenceVerified:true},{...e,currentChildAgeMonths:currentAgeMonths()});
      for(const field of EVIDENCE_FIELDS){if(hint[field]!==undefined&&hint[field]!==null&&hint[field]!=='')out.push({field,value:hint[field],url:p.url||'',publishedAt:p.publishedAt||'',note:hint.decisionAgeNote||'',...auth});}
      if(hint.ageNote){out.push({field:'minAgeMonths',value:hint.minAgeMonths??null,url:p.url||'',publishedAt:p.publishedAt||'',...auth},{field:'maxAgeMonths',value:hint.maxAgeMonths??null,url:p.url||'',publishedAt:p.publishedAt||'',...auth});}
      if(hint.facilityAgeEvidence)out.push({field:'facilityAgeEvidence',value:hint.facilityAgeEvidence,url:p.url||'',publishedAt:p.publishedAt||'',...auth});
    }
    return out;
  }
  function chooseEvidenceCandidate(candidates=[]){
    if(!candidates.length)return null;
    const sorted=[...candidates].sort((a,b)=>evidenceTier(b)-evidenceTier(a)||parseEvidenceTime(b.publishedAt)-parseEvidenceTime(a.publishedAt)||evidenceRank(b)-evidenceRank(a));
    const topTier=evidenceTier(sorted[0]),top=sorted.filter(x=>evidenceTier(x)===topTier);
    const values=[...new Set(top.map(x=>JSON.stringify(x.value)))];
    if(values.length===1)return sorted[0];
    const allDated=top.every(x=>parseEvidenceTime(x.publishedAt)>0);
    if(allDated){const dated=[...top].sort((a,b)=>parseEvidenceTime(b.publishedAt)-parseEvidenceTime(a.publishedAt)||evidenceRank(b)-evidenceRank(a));if(dated.length&&(!dated[1]||parseEvidenceTime(dated[0].publishedAt)>parseEvidenceTime(dated[1].publishedAt)))return dated[0];}
    const topRank=Math.max(...top.map(evidenceRank));
    return {conflict:true,field:sorted[0].field,authorityRank:topRank,sourceType:sorted[0].sourceType,url:sorted[0].url||''};
  }
  function existingFieldRank(e,field){
    if(e.manualDecisionFields?.[field])return 100;
    const p=e.decisionFieldProvenance?.[field];if(p)return evidenceRank(p);
    if(!autoMetadataValueMissing(field,e[field])){
      if(String(e.decisionMetadataVersion||'').includes('catalog')||String(e.decisionMetadataVersion||'').includes('v4.3.3'))return 20;
      return 25;
    }
    return 0;
  }
  function existingFieldTier(e,field){
    if(e.manualDecisionFields?.[field])return 100;
    const p=e.decisionFieldProvenance?.[field];if(p)return evidenceTier(p);
    const r=existingFieldRank(e,field);return r>=100?100:r>=85?90:r>=70?75:r>=50?52:r>=35?40:r>0?20:0;
  }
  function applyEvidenceCandidate(out,c,notes=[]){
    if(!c||c.conflict)return false;const field=c.field;
    if(out.manualDecisionFields?.[field])return false;
    const rank=evidenceRank(c),tier=evidenceTier(c),existing=existingFieldRank(out,field),existingTier=existingFieldTier(out,field);
    const currentProv=out.decisionFieldProvenance?.[field]||{};
    const newTime=parseEvidenceTime(c.publishedAt),oldTime=parseEvidenceTime(currentProv.publishedAt||currentProv.verifiedAt||'');
    const newerSameTier=tier===existingTier&&newTime>0&&newTime>oldTime;
    if(!autoMetadataValueMissing(field,out[field])&&tier<existingTier)return false;
    if(!autoMetadataValueMissing(field,out[field])&&tier===existingTier&&JSON.stringify(out[field])!==JSON.stringify(c.value)&&!newerSameTier){out.decisionEvidenceConflicts={...(out.decisionEvidenceConflicts||{}),[field]:{status:'needs_review',sourceType:c.sourceType,url:c.url||'',verifiedAt:todayISO()}};return false;}
    if(!autoMetadataValueMissing(field,out[field])&&tier===existingTier&&!newerSameTier&&rank<existing)return false;
    out[field]=c.value;out.decisionFieldProvenance={...(out.decisionFieldProvenance||{}),[field]:{sourceType:c.sourceType,authorityRank:rank,url:c.url||'',publishedAt:c.publishedAt||'',verifiedAt:todayISO(),value:c.value}};
    if(c.url){const current=out.decisionPrimaryEvidence||{},currentTier=evidenceTier(current),currentTime=parseEvidenceTime(current.publishedAt||current.verifiedAt||'');if(tier>currentTier||(tier===currentTier&&newTime>currentTime)||(tier===currentTier&&newTime===currentTime&&rank>=evidenceRank(current)))out.decisionPrimaryEvidence={sourceType:c.sourceType,authorityRank:rank,url:c.url,publishedAt:c.publishedAt||'',verifiedAt:todayISO()};}
    notes.push(`${field}：${String(c.value)}`);return true;
  }
  function mergeEasyMetadata(e,placeCandidate=null,source=null){
    let out={...e,decisionFieldProvenance:{...(e.decisionFieldProvenance||{})}};const notes=[];
    if(placeCandidate){
      out.placeTypes=Array.isArray(placeCandidate.types)?placeCandidate.types:(out.placeTypes||[]);out.placePrimaryType=placeCandidate.primaryType||out.placePrimaryType||'';out.placeOpeningDate=placeCandidate.openingDate||out.placeOpeningDate||null;out.placeAccessibilityOptions=placeCandidate.accessibilityOptions||out.placeAccessibilityOptions||null;
      const env=environmentHintFromPlace(placeCandidate,out);if(env&&existingFieldRank(out,'environmentType')<35){applyEvidenceCandidate(out,{field:'environmentType',value:env.value,url:out.googleMapsUrl||'',sourceType:'google',authorityRank:35},notes);notes.push(env.reason);}
    }
    if(source?.evidenceVerified===true||source?.titleVerified===true||source?.bodyVerified===true){
      const candidates=evidencePageCandidates(source,out);const byField=new Map();for(const c of candidates){if(!byField.has(c.field))byField.set(c.field,[]);byField.get(c.field).push(c);}
      for(const [field,list] of byField){const chosen=chooseEvidenceCandidate(list);if(chosen?.conflict){out.decisionEvidenceConflicts={...(out.decisionEvidenceConflicts||{}),[field]:{status:'needs_review',sourceType:chosen.sourceType,url:chosen.url||'',verifiedAt:todayISO()}};continue;}applyEvidenceCandidate(out,chosen,notes);}
      const sourceUrls=(source.evidencePages||[]).map(x=>x.url).filter(Boolean);if(sourceUrls.length)out.decisionEvidenceSources=[...new Set([...(out.decisionEvidenceSources||[]),...sourceUrls])].slice(0,12);
      out.evidenceResolverPages=Number(source.pagesScanned||source.evidencePages?.length||out.evidenceResolverPages||0);
    }
    if(out.environmentType==='indoor'&&(out.indoor===null||out.indoor===undefined))out.indoor=true;
    if(out.environmentType==='outdoor'&&(out.indoor===null||out.indoor===undefined))out.indoor=false;
    if((!out.rainSuitability||out.rainSuitability==='unknown')&&out.environmentType==='indoor')applyEvidenceCandidate(out,{field:'rainSuitability',value:'good',sourceType:'derived',authorityRank:25,url:out.decisionPrimaryEvidence?.url||''},notes);
    else if((!out.rainSuitability||out.rainSuitability==='unknown')&&out.environmentType==='mixed')applyEvidenceCandidate(out,{field:'rainSuitability',value:'partial',sourceType:'derived',authorityRank:25,url:out.decisionPrimaryEvidence?.url||''},notes);
    if(notes.length){
      out.decisionMetadataVersion='v4.3.10-field-evidence';
      const topRank=Math.max(0,...Object.values(out.decisionFieldProvenance||{}).map(evidenceRank));
      out.decisionConfidence=topRank>=85?'A':topRank>=50?'B':topRank>0?'C':(out.decisionConfidence||'U');
      const bestUrl=out.decisionPrimaryEvidence?.url||source?.bestEvidenceUrl||source?.finalUrl||out.decisionEvidenceUrl||out.googleMapsUrl||'';
      if(bestUrl)out.decisionEvidenceUrl=bestUrl;
      const existingNotes=String(out.decisionEvidenceNote||'').split('；').map(x=>x.trim()).filter(Boolean);out.decisionEvidenceNote=[...new Set([...existingNotes,...notes])].join('；');
      out.decisionVerifiedAt=todayISO();if(out.decisionEligible===undefined)out.decisionEligible=true;
    }
    return out;
  }

  function openingDateText(e){
    const d=e?.placeOpeningDate;if(!d || !Number.isFinite(Number(d.year))) return '';
    const y=Number(d.year),m=Number(d.month||1),day=Number(d.day||0);return `${y}/${m}${day?`/${day}`:''}`;
  }
  function recentOpeningLabel(e){
    const d=e?.placeOpeningDate;if(!d||!Number.isFinite(Number(d.year)))return '';
    const opened=new Date(Number(d.year),Math.max(0,Number(d.month||1)-1),Number(d.day||1));if(Number.isNaN(opened.getTime())) return '';
    const months=(Date.now()-opened.getTime())/(86400000*30.44);return months>=-3&&months<=24?`近期開幕 ${openingDateText(e)}`:'';
  }

  function applyPlaceCandidateToEntity(e,c) {
    const base={...e,
      googlePlaceId:c.placeId||'', placeDisplayName:c.displayName||'', placeMatchStatus:'verified-google-places',
      county:c.county||e.county||'', district:c.district||e.district||'',
      address:c.formattedAddress||e.address||'', latitude:Number.isFinite(c.latitude)?c.latitude:(e.latitude??null), longitude:Number.isFinite(c.longitude)?c.longitude:(e.longitude??null),
      googleMapsUrl:c.googleMapsUrl||e.googleMapsUrl||'', placeWebsiteUrl:c.websiteUri||e.placeWebsiteUrl||'', imageSource:e.coverImage?'user-local':e.sourceCoverUrl?'source-url':'google-places', imageUpdatedAt:new Date().toISOString(), updatedAt:new Date().toISOString()
    };
    return mergeEasyMetadata(base,c,null);
  }

  async function savePlaceCandidate(entityId,candidate,{close=true}={}) {
    const e=getEntity(entityId) || await TwinDB.get('entities',entityId); if (!e) return;
    let out=inferGeoEntity(applyPlaceCandidateToEntity(e,candidate));
    if(out.googlePlaceId&&!out.placeWebsiteUrl){const website=await placeWebsiteForId(out.googlePlaceId);if(website)out={...out,placeWebsiteUrl:website};}
    await TwinDB.put('entities',out); state.photoSession.clear(); await reloadData();
    if (close) closeModal(); state.selectedEntityId=out.id; setView('detail',{entityId:out.id}); toast(`已連結「${candidate.displayName||out.name}」；正在補查官方親子資料…`);
    autoEnrichEntity(out,{interactive:false,silent:true,skipSource:true}).catch(()=>{});
  }

  const ENRICHMENT_COMMIT_FIELDS=['region','cityRaw','county','district','address','latitude','longitude','googleMapsUrl','googlePlaceId','placeDisplayName','placeMatchStatus','placeTypes','placePrimaryType','placeOpeningDate','placeAccessibilityOptions','placeWebsiteUrl','sourceCoverUrl','sourceCoverStatus','sourceCoverMethod','sourceCoverDomain','sourceCoverPageUrl','imageSource','imageUpdatedAt','environmentType','rainSuitability','toddlerFit','toddlerAccess','strollerFit','nursingRoomStatus','babyChangingStatus','familyRestroomStatus','waterPlay','visitDuration','indoor','ageNote','minAgeMonths','maxAgeMonths','decisionMetadataVersion','decisionEligible','decisionTags','decisionAgeNote','decisionMinAgeMonths','decisionMaxAgeMonths','decisionConfidence','decisionEvidenceUrl','decisionEvidenceNote','decisionVerifiedAt','decisionPrimaryEvidence','decisionEvidenceSources','evidenceResolverStatus','evidenceResolverPages','evidenceResolverUpdatedAt'];
  function sameJsonValue(a,b){try{return JSON.stringify(a)===JSON.stringify(b);}catch{return a===b;}}
  function enrichmentIdentityKey(e={}){const src=(e.sourceUrls||[])[0]||e.originalUrl||'';return [normalizedPlaceName(e.name||''),String(e.entityType||''),normalizedSourceUrl(src),String(e.googlePlaceId||'')].join('|');}
  function rebaseNestedEvidence(base={},enriched={},latest={},field){
    const b=base?.[field]||{},n=enriched?.[field]||{},l=latest?.[field]||{},out={...l};
    for(const k of new Set([...Object.keys(n),...Object.keys(b)])){
      if(sameJsonValue(l[k],b[k])&&!sameJsonValue(n[k],b[k])){if(n[k]===undefined)delete out[k];else out[k]=n[k];}
    }
    return out;
  }
  function rebaseEnrichmentResult(base,enriched,latest){
    if(!latest)return {entity:enriched,aborted:false};
    if(enrichmentIdentityKey(latest)!==enrichmentIdentityKey(base))return {entity:latest,aborted:true,reason:'stale-identity-or-source'};
    const out={...latest};
    for(const field of ENRICHMENT_COMMIT_FIELDS){if(sameJsonValue(latest[field],base[field])&&!sameJsonValue(enriched[field],base[field]))out[field]=enriched[field];}
    out.decisionFieldProvenance=rebaseNestedEvidence(base,enriched,latest,'decisionFieldProvenance');
    out.decisionEvidenceConflicts=rebaseNestedEvidence(base,enriched,latest,'decisionEvidenceConflicts');
    return {entity:out,aborted:false};
  }

  async function refreshEasyMetadata(e){
    if(!e||!navigator.onLine)return {status:'offline',place:'offline',source:'offline',official:'offline',evidence:'offline'};
    let current=getEntity(e.id)||e,place='none',source='none',official='none',evidence='none',evidenceResult=null;const baseline={...current,decisionFieldProvenance:{...(current.decisionFieldProvenance||{})},decisionEvidenceConflicts:{...(current.decisionEvidenceConflicts||{})}};
    const sourceUrl=(current.sourceUrls||[])[0]||current.originalUrl||'';
    const [placeAttempt,sourceAttempt]=await Promise.allSettled([
      current.googlePlaceId?Promise.resolve({skippedExisting:true,candidates:[]}):searchPlaceForEntity(current),
      sourceUrl?sourceCoverForUrl(current,sourceUrl):Promise.resolve(null)
    ]);
    if(placeAttempt.status==='fulfilled'){
      const data=placeAttempt.value;
      if(data?.skippedExisting)place='verified-existing';
      else{
        const c=!current.googlePlaceId?data.autoCandidate:null;
        if(c){current=inferGeoEntity(applyPlaceCandidateToEntity(current,c));place='updated';}
        else if(data.candidates?.length)place='needs-confirmation';else place='not-found';
      }
    }else place='error';
    if(sourceAttempt.status==='fulfilled'&&sourceAttempt.value){
      const src=sourceAttempt.value;current=mergeEasyMetadata(current,null,src);
      if(src.ok===true&&src.imageUrl&&src.titleVerified===true&&src.imageProbe===true){current={...current,sourceCoverUrl:src.imageUrl,sourceCoverStatus:'found',sourceCoverMethod:src.source||src.method||src.kind||'',sourceCoverDomain:src.domain||'',sourceCoverPageUrl:src.finalUrl||src.pageUrl||sourceUrl,imageSource:current.coverImage?'user-local':'source-url',imageUpdatedAt:new Date().toISOString()};source='updated';}
      else source=(src.evidenceVerified===true||src.titleVerified===true||src.bodyVerified===true)?'metadata-only':'no-update';
    }else if(sourceUrl)source='error';

    if(current.googlePlaceId&&!current.placeWebsiteUrl){const website=await placeWebsiteForId(current.googlePlaceId);if(website){current={...current,placeWebsiteUrl:website};official='resolved';}}
    try{
      evidenceResult=await evidenceResolverForEntity(current);
      if(evidenceResult?.evidenceVerified){current=mergeEasyMetadata(current,null,evidenceResult);current={...current,evidenceResolverStatus:'verified',evidenceResolverPages:Number(evidenceResult.pagesScanned||0),evidenceResolverUpdatedAt:new Date().toISOString()};evidence='updated';}
      else evidence=evidenceResult?.reason||'no-evidence';
    }catch(err){evidence=err?.code==='timeout'?'timeout':'error';}
    const latest=await TwinDB.get('entities',current.id);const rebased=rebaseEnrichmentResult(baseline,current,latest||baseline);
    if(rebased.aborted){await reloadData();render();current=getEntity(current.id)||rebased.entity;return {status:'stale-aborted',place,source,official,evidence,evidenceResult,entity:current};}
    current={...rebased.entity,updatedAt:new Date().toISOString()};await TwinDB.put('entities',current);await reloadData();render();current=getEntity(current.id)||current;
    const status=(place==='updated'||source==='updated'||source==='metadata-only'||official==='resolved'||evidence==='updated')?'updated':((place==='error'&&source==='error'&&evidence==='error')?'error':'done');
    return {status,place,source,official,evidence,evidenceResult,entity:current};
  }

  function placeCandidatesModal(e,candidates) {
    state.pendingPlaceMatch={entityId:e.id,candidates};
    showModal('確認地點', `<p class="modal-intro">找到多個可能地點。為避免綁錯地點與導航資料，請點選正確的一個。</p><div class="candidate-list">${candidates.map((c,i)=>`<button class="candidate-card" data-choose-place="${i}"><strong>${esc(c.displayName||'未命名')}</strong><span>${esc(c.formattedAddress||'地址未提供')}</span>${c.primaryTypeLabel?`<small>${esc(c.primaryTypeLabel)}</small>`:''}<small>名稱相似 ${Math.round((c.similarity||0)*100)}%${c.exactName?'・名稱完全符合':''}${c.locationMatch?'・地區符合':''}${c.typeMatch?'・類型符合':''}${c.hasPhoto?'・有照片':''}</small></button>`).join('')}</div><button class="btn full" data-close-modal>先不處理</button>`);
  }



  const GEO_REGION_MAP = {
    north: {
      label:'北部',
      groups:{
        '基隆':['基隆市'],
        '台北':['台北市','臺北市'],
        '新北':['新北市'],
        '桃園':['桃園市'],
        '新竹':['新竹市','新竹縣'],
        '宜蘭':['宜蘭縣']
      }
    },
    central: {
      label:'中部',
      groups:{
        '苗栗':['苗栗縣'],
        '台中':['台中市','臺中市'],
        '彰化':['彰化縣'],
        '南投':['南投縣'],
        '雲林':['雲林縣']
      }
    },
    south: {
      label:'南部',
      groups:{
        '嘉義':['嘉義市','嘉義縣'],
        '台南':['台南市','臺南市'],
        '高雄':['高雄市'],
        '屏東':['屏東縣']
      }
    },
    east: {
      label:'東部',
      groups:{
        '花蓮':['花蓮縣'],
        '台東':['台東縣','臺東縣']
      }
    },
    islands: {
      label:'離島',
      groups:{
        '澎湖':['澎湖縣'],
        '金門':['金門縣'],
        '馬祖':['連江縣']
      }
    }
  };

  const DISTRICT_ALIASES = {
    '士林':'台北市','中壢':'桃園市','龍潭':'桃園市','樹林':'新北市','八里':'新北市','淡水':'新北市','萬里':'新北市',
    '三重':'新北市','板橋':'新北市','新店':'新北市','淡水':'新北市',
    '清水':'台中市','沙鹿':'台中市','北屯':'台中市','桃園':'桃園市','台中':'台中市','臺中':'台中市',
    '台南':'台南市','臺南':'台南市','高雄':'高雄市',
    '彰化':'彰化縣','南投':'南投縣','雲林':'雲林縣','屏東':'屏東縣',
    '宜蘭':'宜蘭縣','花蓮':'花蓮縣','台東':'台東縣','臺東':'台東縣','苗栗':'苗栗縣'
  };

  function normalizeGeoText(s='') {
    return String(s)
      .replace(/臺/g,'台')
      .replace(/县/g,'縣')
      .replace(/区/g,'區')
      .replace(/乡/g,'鄉')
      .replace(/镇/g,'鎮')
      .trim();
  }

  function canonicalCounty(s='') {
    return normalizeGeoText(s);
  }

  function countyToGeo(county='') {
    const c=canonicalCounty(county);
    for(const [macroRegion,info] of Object.entries(GEO_REGION_MAP)){
      for(const [geoGroup,counties] of Object.entries(info.groups)){
        if(counties.map(canonicalCounty).includes(c)){
          return {macroRegion,geoGroup};
        }
      }
    }
    return {macroRegion:'unknown',geoGroup:'未分類'};
  }

  function parseGeoFromAddress(address='') {
    const a=normalizeGeoText(address);
    const countyMatch=a.match(/(基隆市|台北市|新北市|桃園市|新竹市|新竹縣|宜蘭縣|苗栗縣|台中市|彰化縣|南投縣|雲林縣|嘉義市|嘉義縣|台南市|高雄市|屏東縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)/);
    const county=countyMatch?countyMatch[1]:'';
    let district='';
    if(county){
      const after=a.slice(a.indexOf(county)+county.length);
      const dm=after.match(/^([^0-9\s]{1,6}(?:區|鄉|鎮|市))/);
      if(dm) district=dm[1];
    }
    return {county,district};
  }

  function inferGeoEntity(e) {
    const fromAddress=parseGeoFromAddress(e.address||'');
    let county=canonicalCounty(e.county||fromAddress.county||'');
    let district=e.district||fromAddress.district||'';
    let geoConfidence='A';

    if(!county){
      const raw=String(e.cityRaw||'').replace(/臺/g,'台').trim();
      if(raw==='新竹'){
        const out={...e,county:'',district,macroRegion:'north',geoGroup:'新竹',geoConfidence:'C'};
        return out;
      }
      if(raw==='嘉義'){
        const out={...e,county:'',district,macroRegion:'south',geoGroup:'嘉義',geoConfidence:'C'};
        return out;
      }
      if(DISTRICT_ALIASES[raw]){
        county=canonicalCounty(DISTRICT_ALIASES[raw]);
        geoConfidence='C';
      }else{
        for(const known of Object.values(GEO_REGION_MAP).flatMap(x=>Object.values(x.groups)).flat()){
          const ck=canonicalCounty(known);
          if(raw.includes(ck.replace(/[縣市]$/,''))){
            county=ck;
            geoConfidence='C';
            break;
          }
        }
      }
    }

    const {macroRegion,geoGroup}=countyToGeo(county);
    if(!county) geoConfidence='U';

    return {
      ...e,
      county,
      district,
      macroRegion,
      geoGroup,
      geoConfidence
    };
  }

  async function migrateGeographyIfNeeded() {
    let changed=0;
    const next=[];
    for(const e of state.entities){
      const n=inferGeoEntity(e);
      next.push(n);
      if(
        e.county!==n.county || e.district!==n.district ||
        e.macroRegion!==n.macroRegion || e.geoGroup!==n.geoGroup ||
        e.geoConfidence!==n.geoConfidence
      ){
        changed++;
        await TwinDB.put('entities',{...n,updatedAt:e.updatedAt||new Date().toISOString()});
      }
    }
    state.entities=next;
    return changed;
  }

  function geoGroupsForRegion(macroRegion) {
    if(!macroRegion || macroRegion==='all') return [];
    return Object.keys(GEO_REGION_MAP[macroRegion]?.groups||{});
  }

  function geoGroupCount(group) {
    return readyEntities().filter(e=>{
      if(e.geoGroup!==group) return false;
      if(state.explore.type && e.entityType!==state.explore.type) return false;
      return true;
    }).length;
  }

  let candidateQueueState = { items: [], index: 0, busy: false };
  let geoFilter={macroRegion:'all',geoGroup:'all'};



  function geoFilterHtml() {
    const macroButtons=[
      ['all','全部'],['north','北部'],['central','中部'],['south','南部'],['east','東部'],['islands','離島']
    ].map(([k,label])=>`<button class="pill ${geoFilter.macroRegion===k?'active':''}" data-geo-macro="${k}">${label}</button>`).join('');
    const groups=geoGroupsForRegion(geoFilter.macroRegion);
    const groupButtons=[
      `<button class="pill ${geoFilter.geoGroup==='all'?'active':''}" data-geo-group="all">全部</button>`,
      ...groups.map(g=>{
        const count=geoGroupCount(g);
        return `<button class="pill ${geoFilter.geoGroup===g?'active':''} ${count===0?'zero-count':''}" data-geo-group="${escapeHtml(g)}">${escapeHtml(g)} <small>${count}</small></button>`;
      })
    ].join('');
    return `<div class="geo-filter"><div class="pill-row">${macroButtons}</div>${geoFilter.macroRegion!=='all'?`<div class="pill-row geo-sub">${groupButtons}</div>`:''}</div>`;
  }

  function applyGeoFilter(list) {
    return list.filter(e=>{
      if(geoFilter.macroRegion!=='all' && e.macroRegion!==geoFilter.macroRegion) return false;
      if(geoFilter.geoGroup!=='all' && e.geoGroup!==geoFilter.geoGroup) return false;
      return true;
    });
  }

  function unresolvedCandidateEntities() {
    return state.entities.filter(e =>
      e &&
      e.captureStatus!=='inbox' &&
      e.name &&
      !e.googlePlaceId &&
      e.placeMatchStatus !== 'collection' &&
      e.placeMatchStatus !== 'none' &&
      (e.placeMatchStatus === 'ambiguous' || (Array.isArray(e.placeCandidates) && e.placeCandidates.length>0))
    );
  }

  function evidenceText(c) {
    const bits=[];
    if(c.exactName) bits.push('名稱完全符合');
    else if(Number.isFinite(c.similarity)) bits.push(`名稱相似 ${Math.round(c.similarity*100)}%`);
    if(c.locationMatch) bits.push('地區符合');
    if(c.typeMatch) bits.push('類型符合');
    if(c.hasPhoto) bits.push('有照片');
    return bits.join('・') || '待確認';
  }

  async function fetchFreshCandidates(e) {
    const data=await fetchJsonWithTimeout('/api/place-search',{
      method:'POST',headers:{'content-type':'application/json'},cache:'no-store',
      body:JSON.stringify({name:e.name,location:[e.county,e.district].filter(Boolean).join('')||e.cityRaw||'',entityType:e.entityType,branchRisk:placeBranchRisk(e)})
    },16000);
    return Array.isArray(data.candidates) ? data.candidates : [];
  }

  async function buildCandidateQueue() {
    const list=unresolvedCandidateEntities();
    candidateQueueState={items:list,index:0,busy:false};
    return list;
  }

  async function commitCandidate(e,candidate) {
    if(candidateQueueState.busy) return;
    candidateQueueState.busy=true;
    try{
      const latest=(await TwinDB.get('entities',e.id)) || e;
      if(latest.googlePlaceId) return;
      const next=inferGeoEntity(applyPlaceCandidateToEntity(latest,candidate));
      next.placeCandidates=[]; next.placeConfirmedAt=new Date().toISOString();
      await TwinDB.put('entities',next);
      const idx=state.entities.findIndex(x=>x.id===e.id);
      if(idx>=0) state.entities[idx]=next;
    } finally { candidateQueueState.busy=false; }
  }

  async function markNoCandidate(e) {
    if(candidateQueueState.busy) return;
    candidateQueueState.busy=true;
    try{
      const next={...e,placeMatchStatus:'none',placeCandidates:[],updatedAt:new Date().toISOString()};
      await TwinDB.put('entities',next);
      const idx=state.entities.findIndex(x=>x.id===e.id);
      if(idx>=0) state.entities[idx]=next;
    } finally {
      candidateQueueState.busy=false;
    }
  }

  async function showFastCandidateQueue(startIndex=0) {
    const list=await buildCandidateQueue();
    if(!list.length){
      showModal('待確認候選', '<div class="setting-block"><h3>目前沒有待人工確認的地點</h3><button class="btn primary full" data-close-modal>完成</button></div>');
      return;
    }
    candidateQueueState.index=Math.min(Math.max(startIndex,0),list.length-1);
    await renderCandidateQueueItem();
  }

  async function renderCandidateQueueItem() {
    const list=candidateQueueState.items;
    const i=candidateQueueState.index;
    const e=list[i];
    if(!e) return;

    let candidates=Array.isArray(e.placeCandidates)?e.placeCandidates.filter(x=>x?.placeId):[];
    if(!candidates.length){
      try{
        candidates=await fetchFreshCandidates(e);
        const next={...e,placeCandidates:candidates,placeMatchStatus:'ambiguous',updatedAt:new Date().toISOString()};
        await TwinDB.put('entities',next);
        const idx=state.entities.findIndex(x=>x.id===e.id);
        if(idx>=0) state.entities[idx]=next;
        candidateQueueState.items[i]=next;
      }catch{
        candidates=[];
      }
    }

    const cards=candidates.slice(0,5).map((c,ci)=>`
      <button class="candidate-card fast-candidate" data-fast-candidate="${ci}">
        ${c.placeId && c.hasPhoto ? `<div class="candidate-photo remote-photo" data-place-photo="${esc(c.placeId)}" data-photo-name="${esc(c.displayName||'候選地點')}"><span class="photo-placeholder">📍</span></div>` : '<div class="candidate-photo"><div class="candidate-placeholder">📍</div></div>'}
        <div class="candidate-copy">
          <strong>${escapeHtml(c.displayName||'未命名候選')}</strong>
          <div>${escapeHtml(c.formattedAddress||'地址未提供')}</div>
          <small>${escapeHtml(evidenceText(c))}</small>
        </div>
      </button>`).join('');

    showModal('快速確認地點', `
      <div class="setting-block fast-confirm-wrap">
        <div class="queue-progress">${i+1} / ${list.length}</div>
        <h3>${escapeHtml(e.name)}</h3>
        <p>${escapeHtml(e.cityRaw||e.county||e.district||'')}</p>
        <div class="fast-candidate-list">${cards || '<p>目前沒有可確認候選。</p>'}</div>
        <div class="fast-confirm-actions">
          <button class="btn ghost" data-fast-none>都不是</button>
          <button class="btn ghost" data-fast-skip>稍後</button>
        </div>
      </div>`);
    setTimeout(hydratePlaceImages,0);

    document.querySelectorAll('[data-fast-candidate]').forEach(btn=>{
      btn.addEventListener('click',async()=>{
        if(candidateQueueState.busy) return;
        const c=candidates[Number(btn.dataset.fastCandidate)];
        if(!c) return;
        btn.disabled=true;
        await commitCandidate(e,c);
        candidateQueueState.items.splice(i,1);
        if(candidateQueueState.index>=candidateQueueState.items.length) candidateQueueState.index=Math.max(0,candidateQueueState.items.length-1);
        render();
        if(candidateQueueState.items.length) await renderCandidateQueueItem();
        else showModal('完成','<div class="setting-block"><h3>待確認候選已處理完成</h3><button class="btn primary full" data-close-modal>完成</button></div>');
      });
    });

    document.querySelector('[data-fast-none]')?.addEventListener('click',async()=>{
      if(candidateQueueState.busy) return;
      await markNoCandidate(e);
      candidateQueueState.items.splice(i,1);
      render();
      if(candidateQueueState.items.length) await renderCandidateQueueItem();
      else showModal('完成','<div class="setting-block"><h3>待確認候選已處理完成</h3><button class="btn primary full" data-close-modal>完成</button></div>');
    });

    document.querySelector('[data-fast-skip]')?.addEventListener('click',async()=>{
      if(candidateQueueState.items.length<=1){
        showModal('待確認候選','<div class="setting-block"><p>目前只剩這一筆待確認。</p><button class="btn primary full" data-close-modal>關閉</button></div>');
        return;
      }
      candidateQueueState.index=(candidateQueueState.index+1)%candidateQueueState.items.length;
      await renderCandidateQueueItem();
    });
  }


  async function rematchGooglePlace(e) {
    const original={
      googlePlaceId:e.googlePlaceId||'',
      placeDisplayName:e.placeDisplayName||e.googlePlaceName||'',
      googleMapsUrl:e.googleMapsUrl||'',
      address:e.address||'',
      latitude:e.latitude??null,
      longitude:e.longitude??null,
      imageSource:e.imageSource||'',
      placeMatchStatus:e.placeMatchStatus||''
    };
    let candidates=[];
    try{
      candidates=await fetchFreshCandidates(e);
    }catch{
      toast('重新搜尋候選失敗');
      return;
    }
    if(!candidates.length){
      showModal('重新配對 Google 地點','<div class="setting-block"><p>目前沒有找到可確認候選。原配對保持不變。</p><button class="btn primary full" data-close-modal>關閉</button></div>');
      return;
    }
    const cards=candidates.slice(0,5).map((c,ci)=>`
      <button class="candidate-card rematch-candidate" data-rematch-candidate="${ci}">
        ${c.placeId && c.hasPhoto ? `<div class="candidate-photo remote-photo" data-place-photo="${esc(c.placeId)}" data-photo-name="${esc(c.displayName||'候選地點')}"><span class="photo-placeholder">📍</span></div>` : '<div class="candidate-photo"><div class="candidate-placeholder">📍</div></div>'}
        <div class="candidate-copy">
          <strong>${escapeHtml(c.displayName||'未命名候選')}</strong>
          <div>${escapeHtml(c.formattedAddress||'地址未提供')}</div>
          <small>${escapeHtml(evidenceText(c))}</small>
        </div>
      </button>`).join('');
    showModal('重新配對 Google 地點',`
      <div class="setting-block">
        <p>目前：${escapeHtml(original.placeDisplayName||'未配對')}</p>
        <div class="fast-candidate-list">${cards}</div>
        <div class="helper">只有確認新候選後才會覆寫舊配對。</div>
      </div>`);
    setTimeout(hydratePlaceImages,0);
    document.querySelectorAll('[data-rematch-candidate]').forEach(btn=>{
      btn.addEventListener('click',async()=>{
        const c=candidates[Number(btn.dataset.rematchCandidate)];
        if(!c) return;
        btn.disabled=true;
        const latest=(await TwinDB.get?.('entities',e.id)) || e;
        const next={
          ...latest,
          googlePlaceId:c.placeId,
          placeDisplayName:c.displayName||'',
          googlePlaceName:c.displayName||'',
          googleMapsUrl:c.googleMapsUrl||'',
          address:c.formattedAddress||latest.address||'',
          latitude:c.latitude??latest.latitude??null,
          longitude:c.longitude??latest.longitude??null,
          imageSource:'google-places',
          placeMatchStatus:'verified-google-places',
          placeConfirmedAt:new Date().toISOString(),
          updatedAt:new Date().toISOString()
        };
        const geoNext=inferGeoEntity(next);
        await TwinDB.put('entities',geoNext);
        const idx=state.entities.findIndex(x=>x.id===e.id);
        if(idx>=0) state.entities[idx]=geoNext;
        render();
        showModal('已更新','<div class="setting-block"><h3>Google 地點已重新配對</h3><button class="btn primary full" data-close-modal>完成</button></div>');
      });
    });
  }

  async function retrySourceCover(e) {
    const sourceUrl=e.originalUrl || (Array.isArray(e.sourceUrls)?e.sourceUrls[0]:'') || '';
    if(!sourceUrl){
      toast('這筆沒有來源網址');
      return;
    }
    try{
      const src=await fetchJsonWithTimeout('/api/source-cover',{
        method:'POST',
        headers:{'content-type':'application/json'},
        cache:'no-store',
        body:JSON.stringify({url:sourceUrl,name:e.name})
      },16000);
      if(!(src.ok===true && src.imageUrl && src.titleVerified===true && src.imageProbe===true)){
        toast('來源網址封面未通過驗證，原圖片保持不變');
        return;
      }
      const latest=(await TwinDB.get?.('entities',e.id)) || e;
      const next={
        ...latest,
        sourceCoverUrl:src.imageUrl,
        sourceCoverStatus:'verified',
        sourceCoverMethod:src.source||'metadata',
        sourceCoverPageUrl:src.finalUrl||sourceUrl,
        imageSource:'source-url',
        imageUpdatedAt:new Date().toISOString(),
        updatedAt:new Date().toISOString()
      };
      await TwinDB.put('entities',next);
      const idx=state.entities.findIndex(x=>x.id===e.id);
      if(idx>=0) state.entities[idx]=next;
      render();
      toast('已改用來源網址封面');
    }catch{
      toast('來源網址封面重新驗證失敗');
    }
  }

  async function clearPlaceMatch(e) {
    showModal('清除目前配對',`
      <div class="setting-block">
        <p>會清除目前 Google 地點與圖片來源，但不會刪除景點／飯店／餐廳／其他收藏本身，也不會刪除原始網址。</p>
        <button class="btn danger full" id="confirmClearPlaceMatch">確認清除</button>
        <button class="btn ghost full" data-close-modal>取消</button>
      </div>`);
    document.querySelector('#confirmClearPlaceMatch')?.addEventListener('click',async()=>{
      const latest=(await TwinDB.get?.('entities',e.id)) || e;
      const next={
        ...latest,
        googlePlaceId:'',
        placeDisplayName:'',
        googlePlaceName:'',
        googleMapsUrl:'',
        imageSource:'',
        imageUpdatedAt:'',
        placeMatchStatus:'ambiguous',
        placeCandidates:[],
        updatedAt:new Date().toISOString()
      };
      await TwinDB.put('entities',next);
      const idx=state.entities.findIndex(x=>x.id===e.id);
      if(idx>=0) state.entities[idx]=next;
      render();
      showModal('已清除','<div class="setting-block"><p>已回到待重新配對狀態。</p><button class="btn primary full" data-close-modal>完成</button></div>');
    });
  }

  function openSourceManager(e) {
    showModal('圖片與地點來源',`
      <div class="setting-block">
        <h3>${escapeHtml(e.name)}</h3>
        <p>目前來源：${escapeHtml(e.imageSource||'未設定')}</p>
        <p>Google 地點：${escapeHtml(e.placeDisplayName||e.googlePlaceName||'未配對')}</p>
        <div class="button-stack">
          <button class="btn secondary full" id="rematchGoogleBtn">重新配對 Google 地點</button>
          <button class="btn secondary full" id="retrySourceCoverBtn">重新嘗試來源網址封面</button>
          <button class="btn ghost full" id="clearPlaceMatchBtn">清除目前配對</button>
        </div>
      </div>`);
    document.querySelector('#rematchGoogleBtn')?.addEventListener('click',()=>rematchGooglePlace(e));
    document.querySelector('#retrySourceCoverBtn')?.addEventListener('click',()=>retrySourceCover(e));
    document.querySelector('#clearPlaceMatchBtn')?.addEventListener('click',()=>clearPlaceMatch(e));
  }

  async function autoEnrichEntity(e,{interactive=false,silent=false,skipSource=false}={}) {
    if(!navigator.onLine){if(!silent)toast('目前離線，之後可再自動補資料');return {status:'offline'};}
    let current=getEntity(e.id)||e;const baseline={...current,decisionFieldProvenance:{...(current.decisionFieldProvenance||{})},decisionEvidenceConflicts:{...(current.decisionEvidenceConflicts||{})}};const sourceUrl=(current.sourceUrls||[])[0]||current.originalUrl||'';
    let sourceStatus=skipSource?'skipped':'none',placeStatus=current.googlePlaceId?'existing':'pending',sourceResult=null,placeResult=null,evidenceStatus='none',evidenceResult=null;
    const collection=isCollectionEntity(current);
    const jobs=[];const jobNames=[];
    if(!skipSource&&sourceUrl){jobs.push(sourceCoverForEntity(current));jobNames.push('source');}
    if(!collection&&!current.googlePlaceId){jobs.push(searchPlaceForEntity(current));jobNames.push('place');}
    const settled=await Promise.allSettled(jobs);
    for(let i=0;i<settled.length;i++){
      const name=jobNames[i],r=settled[i];
      if(name==='source'){
        if(r.status==='fulfilled'){
          const src=r.value;sourceResult=src;const patch={...current,sourceCoverStatus:src.reason||current.sourceCoverStatus||'fallback',sourceCoverMethod:src.source||src.method||src.kind||'',sourceCoverDomain:src.domain||'',sourceCoverPageUrl:src.finalUrl||src.pageUrl||sourceUrl};
          if(src.ok===true&&src.imageUrl&&src.titleVerified===true&&src.imageProbe===true){Object.assign(patch,{sourceCoverUrl:src.imageUrl,sourceCoverStatus:'found',imageSource:current.coverImage?'user-local':'source-url',imageUpdatedAt:new Date().toISOString()});sourceStatus='found';}else sourceStatus=(src.evidenceVerified||src.titleVerified||src.bodyVerified)?'metadata-only':'fallback';
          current=mergeEasyMetadata(patch,null,src);
        }else{sourceStatus=r.reason?.code==='timeout'?'timeout':'error';current={...current,sourceCoverStatus:'fetch-error'};}
      }else if(name==='place'){
        if(r.status==='fulfilled'){
          const data=r.value;placeResult=data;
          if(current.googlePlaceId){const existing=(data.candidates||[]).find(c=>c.placeId===current.googlePlaceId);if(existing){current=inferGeoEntity(applyPlaceCandidateToEntity(current,existing));placeStatus='existing';}else if(data.candidates?.length)placeStatus='identity-preserved-needs-confirmation';else placeStatus='existing';}
          else if(data.autoCandidate){current=inferGeoEntity(applyPlaceCandidateToEntity(current,data.autoCandidate));placeStatus='matched';}
          else if(data.candidates?.length){placeStatus='ambiguous';if(interactive)placeCandidatesModal(current,data.candidates);}else placeStatus='not-found';
        }else{placeStatus='error';placeResult={error:r.reason};}
      }
    }
    if(collection){current={...current,placeMatchStatus:'collection',updatedAt:new Date().toISOString()};await TwinDB.put('entities',current);await reloadData();render();if(!silent)toast(sourceStatus==='found'?'已補來源資料；集合型收藏不綁單一 Google 地點':'這筆是集合／行程型資料，不綁定單一 Google 地點');return {status:'collection',sourceStatus,placeStatus:'collection'};}

    if(current.googlePlaceId&&!current.placeWebsiteUrl){const website=await placeWebsiteForId(current.googlePlaceId);if(website)current={...current,placeWebsiteUrl:website};}
    try{
      evidenceResult=await evidenceResolverForEntity(current);
      if(evidenceResult?.evidenceVerified){current=mergeEasyMetadata(current,null,evidenceResult);current={...current,evidenceResolverStatus:'verified',evidenceResolverPages:Number(evidenceResult.pagesScanned||0),evidenceResolverUpdatedAt:new Date().toISOString()};evidenceStatus='updated';}
      else evidenceStatus=evidenceResult?.reason||'no-evidence';
    }catch(err){evidenceStatus=err?.code==='timeout'?'timeout':'error';}
    const latest=await TwinDB.get('entities',current.id);const rebased=rebaseEnrichmentResult(baseline,current,latest||baseline);
    if(rebased.aborted){state.photoSession.clear();await reloadData();render();current=getEntity(current.id)||rebased.entity;if(!silent)toast('資料在查證期間已被修改，舊查證結果已捨棄');return {status:'stale-aborted',sourceStatus,placeStatus,evidenceStatus,evidence:evidenceResult,source:sourceResult,place:placeResult,entity:current};}
    current={...rebased.entity,updatedAt:new Date().toISOString()};await TwinDB.put('entities',current);state.photoSession.clear();await reloadData();render();current=getEntity(current.id)||current;
    if(!silent){
      if(evidenceStatus==='timeout')toast('官方資料查證逾時；已保留目前資料，可稍後再試');
      else if(placeStatus==='matched')toast(`已補齊「${current.placeDisplayName||current.name}」地點資料${sourceStatus==='found'?'與來源封面':''}`);
      else if(placeStatus==='existing'&&(sourceStatus==='found'||evidenceStatus==='updated'))toast('已更新可確認資料；Google 地點配對維持不變');
      else if(placeStatus==='ambiguous')toast('已找到可能地點，請確認正確候選');
      else if(sourceStatus==='found')toast('已補來源資料；Google 地點仍待確認');
      else if(placeStatus==='error')toast(placeResult?.error?.code==='not_configured'?'尚未設定 Google Places API Key':'地點資料補植失敗，可稍後重試');
      else toast(evidenceStatus==='updated'?'已補入官方可確認資料':'已完成自動檢查；沒有更多可可靠補值資料');
    }
    const status=placeStatus==='matched'?'matched':placeStatus==='existing'?'google-existing':placeStatus==='ambiguous'?'ambiguous':evidenceStatus==='updated'?'evidence':sourceStatus==='found'?'source':placeStatus==='error'?'error':'not_found';
    return {status,sourceStatus,placeStatus,evidenceStatus,evidence:evidenceResult,source:sourceResult,place:placeResult,entity:current};
  }

  async function checkPlaceApi() {
    try { const r=await fetch('/api/place-health',{cache:'no-store'}); if(!r.ok)return false; const d=await r.json(); return !!d.configured; } catch (_) { return false; }
  }

  async function batchEnrichPlaces() {
    if (state.batchPlaceRunning) return;
    const missing=state.entities.filter(e=>{
      if(e.captureStatus==='inbox') return false;
      const sourceUrl=(e.sourceUrls||[])[0]||e.originalUrl||'';
      const needsSource=!!sourceUrl && (!e.sourceCoverStatus || e.sourceCoverStatus==='fetch-error');
      const needsGoogle=!e.googlePlaceId && e.placeMatchStatus!=='collection';
      return needsSource || needsGoogle;
    });
    if (!missing.length) { closeModal(); toast('目前沒有需要補齊的網路資料'); return; }
    const ok=confirm(`將處理 ${missing.length} 筆資料：來源頁與 Google Places 會各自補能可靠取得的欄位，彼此不再互相阻斷。\n\n模糊 Google 候選仍不會硬配。要繼續嗎？`);
    if (!ok) return;
    state.batchPlaceRunning=true;
    showModal('批次補齊網路資料', `<div class="setting-block"><h3 id="batchTitle">準備中…</h3><div class="progress"><div id="batchBar" style="width:0%"></div></div><p id="batchText">0 / ${missing.length}</p></div>`);
    let sourceVerified=0,googleMatched=0,googleExisting=0,ambiguous=0,failed=0,excluded=0;
    for (let i=0;i<missing.length;i++) {
      const e=missing[i];
      $('#batchTitle').textContent=`正在找：${e.name}`; $('#batchText').textContent=`${i+1} / ${missing.length}｜原網址 ${sourceVerified}｜Google ${googleMatched+googleExisting}｜待確認 ${ambiguous}｜集合 ${excluded}｜失敗 ${failed}`; $('#batchBar').style.width=`${Math.round((i/missing.length)*100)}%`;
      const result=await autoEnrichEntity(e,{interactive:false,silent:true});
      if(result.sourceStatus==='found') sourceVerified++;
      if(result.placeStatus==='matched') googleMatched++;
      else if(result.placeStatus==='existing') googleExisting++;
      else if(result.placeStatus==='ambiguous') ambiguous++;
      else if(result.placeStatus==='collection') excluded++;
      else if(['error','not-found'].includes(result.placeStatus) && result.sourceStatus!=='found') failed++;
      if(result.status==='error' && result.error?.code==='not_configured') { failed += (missing.length-i-1); break; }
      await new Promise(r=>setTimeout(r,100));
    }
    await reloadData(); render(); state.batchPlaceRunning=false;
    showModal('批次完成', `<div class="setting-block"><h3>來源網址有效資料 ${sourceVerified} 筆</h3><p>Google Places 地點資料 ${googleMatched+googleExisting} 筆；待人工確認 ${ambiguous} 筆；集合／非單一地點 ${excluded} 筆；未找到／失敗 ${failed} 筆。</p><div class="helper">路由：自己的照片 → 來源網址縮圖 → Google Places → 預設圖。來源圖日後失效會自動切回 Google Places。</div><button class="btn primary full" data-close-modal>完成</button></div>`);
  }

  async function compressImage(file) {
    const data=await file.arrayBuffer(); const blob=new Blob([data],{type:file.type}); const url=URL.createObjectURL(blob);
    try {
      const img=await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=url; });
      const max=1200, scale=Math.min(1,max/Math.max(img.width,img.height)); const w=Math.round(img.width*scale),h=Math.round(img.height*scale);
      const c=document.createElement('canvas'); c.width=w;c.height=h; c.getContext('2d').drawImage(img,0,0,w,h);
      return c.toDataURL('image/jpeg',.82);
    } finally { URL.revokeObjectURL(url); }
  }

  async function compressSquareIcon(file) {
    const data=await file.arrayBuffer();const blob=new Blob([data],{type:file.type});const url=URL.createObjectURL(blob);
    try{
      const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=url;});
      const side=Math.min(img.width,img.height),sx=(img.width-side)/2,sy=(img.height-side)/2;
      const c=document.createElement('canvas');c.width=256;c.height=256;c.getContext('2d').drawImage(img,sx,sy,side,side,0,0,256,256);
      return c.toDataURL('image/png');
    }finally{URL.revokeObjectURL(url);}
  }

  function timeToMinutes(s=''){
    const m=String(s).match(/^(\d{1,2}):(\d{2})$/);if(!m)return null;
    const h=Number(m[1]),mi=Number(m[2]);if(h>23||mi>59)return null;return h*60+mi;
  }
  function minutesToTime(n){
    if(!Number.isFinite(n))return '';
    const v=((Math.round(n)%1440)+1440)%1440;return `${String(Math.floor(v/60)).padStart(2,'0')}:${String(v%60).padStart(2,'0')}`;
  }
  function stopEntityObj(s){return stopPlaceObj(s);}
  function locatable(e){return !!e&&Number.isFinite(e.latitude)&&Number.isFinite(e.longitude);}
  function tripDistanceKm(a,b){return locatable(a)&&locatable(b)?distanceKmBetween(a,b):null;}
  function travelBufferMinutes(a,b){
    const d=tripDistanceKm(a,b);if(d===null)return 30;if(d<=5)return 15;if(d<=20)return 25;if(d<=50)return 40;if(d<=100)return 70;return 120;
  }
  function lastTripEntity(trip){
    const rows=[...(trip?.stops||[])].sort((a,b)=>(a.order||0)-(b.order||0)).reverse();
    for(const st of rows){const e=stopEntityObj(st);if(locatable(e))return e;}return null;
  }
  function applyTripAutoTimeline(trip,{force=false}={}){
    const t={...trip};const rows=[...(t.stops||[])].sort((a,b)=>(a.order||0)-(b.order||0));
    let cursor=timeToMinutes(t.startTime||'09:00')??540,prevEntity=null;
    t.stops=rows.map((st,i)=>{
      const next={...st},e=stopEntityObj(next);
      if(i>0) cursor+=travelBufferMinutes(prevEntity,e);
      // Existing/legacy explicit times are treated as manual unless they were explicitly created by the auto scheduler.
      // This prevents one-click reflow from flattening a two-day itinerary's Day 2 fixed times.
      const locked=!!next.plannedTime && (next.timeLocked===true || next.timeAuto!==true);
      if(locked){cursor=timeToMinutes(next.plannedTime)??cursor;next.timeAuto=false;next.timeLocked=true;}
      else if(!next.plannedTime || next.timeAuto===true){next.plannedTime=minutesToTime(cursor);next.timeAuto=true;next.timeLocked=false;}
      const start=timeToMinutes(next.plannedTime)??cursor;cursor=start+(Number(next.plannedDurationMinutes)||0);
      if(e)prevEntity=e;return next;
    });
    t.scheduleDirty=false;t.updatedAt=new Date().toISOString();return t;
  }
  function distanceWarningForTrip(trip,e){const prev=lastTripEntity(trip),d=tripDistanceKm(prev,e);return Number.isFinite(d)?d:null;}

  function defaultDurationForEntity(e){
    const map={'1-2h':90,'half-day':180,'full-day':360,'overnight':720};
    if(e?.entityType==='restaurant') return 75;
    if(e?.entityType==='hotel') return null;
    return map[e?.visitDuration]??90;
  }

  function tripQuickEntityRows(type,query='',trip=null){
    const q=String(query||'').trim().toLowerCase(),prev=lastTripEntity(trip);
    return readyEntities().filter(e=>e.entityType===type)
      .filter(e=>!q || [e.name,e.county,e.district,e.geoGroup,e.address].join(' ').toLowerCase().includes(q))
      .sort((a,b)=>{const da=tripDistanceKm(prev,a),db=tripDistanceKm(prev,b),distA=Number.isFinite(da)?da:9999,distB=Number.isFinite(db)?db:9999;return Number(a.visited)-Number(b.visited)||(distA-distB)||Number(b.favorite)-Number(a.favorite)||exploreRecommendedScore(b)-exploreRecommendedScore(a);})
      .slice(0,24);
  }

  function quickAddStopModal(tripId,type='attraction'){
    const t=state.itineraries.find(x=>x.id===tripId);if(!t)return;
    const entityTypes=['attraction','restaurant','hotel','activity'];
    if(!entityTypes.includes(type)){addStopForm(tripId,null,type);return;}
    showModal('快速加入站點',`<div class="trip-quick-tabs">${[['attraction','景點'],['restaurant','餐廳'],['hotel','住宿'],['activity','其他收藏']].map(([v,l])=>`<button class="pill ${type===v?'active':''}" data-trip-quick-type="${v}" data-trip-id="${esc(tripId)}">${l}</button>`).join('')}</div><div class="field"><input id="tripQuickSearch" placeholder="搜尋已收藏的${esc(TYPE_LABELS[type])}" autocomplete="off" /></div><div id="tripQuickList" class="trip-quick-list"></div><div class="trip-simple-row"><button class="btn" data-trip-quick-simple="start" data-trip-id="${esc(tripId)}">＋ 出發</button><button class="btn" data-trip-quick-simple="custom" data-trip-id="${esc(tripId)}">＋ 自訂</button><button class="btn" data-trip-quick-simple="home" data-trip-id="${esc(tripId)}">＋ 回家</button></div>`,{wide:true});
    const renderList=()=>{
      const rows=tripQuickEntityRows(type,$('#tripQuickSearch')?.value||'',t);
      const root=$('#tripQuickList');if(!root)return;
      root.innerHTML=rows.length?rows.map(e=>`<button class="trip-quick-entity" data-trip-quick-entity="${esc(e.id)}" data-trip-id="${esc(tripId)}"><div>${entityImage(e,'trip-quick-thumb')}</div><div><strong>${esc(e.name)}</strong><small>${esc(entityLocation(e)||'未分類')}${e.visited?'・已去':'・未去'}</small><small>${(()=>{const d=distanceWarningForTrip(t,e);const base=e.visitDuration&&e.visitDuration!=='unknown'?`建議停留 ${decisionLabel('visitDuration',e.visitDuration)}`:'點一下直接加入';return esc(`${base}${Number.isFinite(d)?`・距上一站約 ${d<10?d.toFixed(1):Math.round(d)} km`:''}`)})()}</small></div><span>＋</span></button>`).join(''):`<div class="empty-state compact"><h3>找不到符合的收藏</h3><p>先到探索新增，或改用自訂站點。</p></div>`;
      hydratePlaceImages();
    };
    $('#tripQuickSearch')?.addEventListener('input',renderList);renderList();
  }

  async function quickAddEntityToTrip(tripId,entityId){
    let t=state.itineraries.find(x=>x.id===tripId),e=getEntity(entityId);if(!t||!e)return;
    if((t.stops||[]).some(st=>st.entityId===entityId) && !confirm(`「${e.name}」已在這趟行程裡。仍要再加入一次嗎？`)) return;
    const distance=distanceWarningForTrip(t,e);
    if(Number.isFinite(distance)&&distance>=80 && !confirm(`這個地點距上一個可定位站點約 ${Math.round(distance)} km，可能不適合同一段行程。仍要加入嗎？`)) return;
    const stops=[...(t.stops||[])],duration=defaultDurationForEntity(e);
    stops.push({id:uuid('stop'),type:e.entityType,entityId:e.id,customTitle:'',plannedTime:'',plannedDurationMinutes:duration,note:'',order:stops.length+1,done:false,timeAuto:true,timeLocked:false});
    t=applyTripAutoTimeline({...t,stops});await TwinDB.put('itineraries',t);await reloadData();closeModal();state.selectedTripId=t.id;render();
    const added=[...(t.stops||[])].sort((a,b)=>(a.order||0)-(b.order||0)).at(-1);
    toast(`已加入「${e.name}」${added?.plannedTime?`・${added.plannedTime}`:''}${duration?`・停留 ${durationText(duration)}`:''}`);
  }

  async function quickAddSimpleStop(tripId,type){
    let t=state.itineraries.find(x=>x.id===tripId);if(!t)return;
    if(type==='custom'){closeModal();return addStopForm(tripId,null,'custom');}
    const stops=[...(t.stops||[])];stops.push({id:uuid('stop'),type,entityId:'',customTitle:type==='start'?'出發':'回家',plannedTime:'',plannedDurationMinutes:null,note:'',order:stops.length+1,done:false,timeAuto:true,timeLocked:false});
    t=applyTripAutoTimeline({...t,stops});await TwinDB.put('itineraries',t);await reloadData();closeModal();state.selectedTripId=t.id;render();toast(type==='start'?'已加入出發並自動排時間':'已加入回家並自動排時間');
  }

  function tripForm(t=null) {
    const v=t||{title:'',date:todayISO(),notes:'',mode:'day',startTime:'09:00',stops:[]};
    showModal(t?'編輯行程':'建立行程', `<form id="tripForm" class="form-grid"><div class="field"><label>行程名稱 *</label><input name="title" value="${esc(v.title)}" required placeholder="例如：桃園一日遊" /></div><div class="inline-fields trip-date-time-fields"><div class="field"><label>日期</label><input name="date" type="date" value="${esc(v.date||'')}" /></div><div class="field"><label>預計開始時間</label><input name="startTime" type="time" value="${esc(v.startTime||'09:00')}" /></div></div><div class="field"><label>型態</label><select name="mode"><option value="half" ${v.mode==='half'?'selected':''}>半天</option><option value="day" ${v.mode==='day'?'selected':''}>一天</option><option value="overnight" ${v.mode==='overnight'?'selected':''}>兩天一夜</option></select></div><div class="field"><label>備註</label><textarea name="notes">${esc(v.notes||'')}</textarea></div><div class="form-actions">${t?`<button type="button" class="btn danger" data-delete-trip="${esc(t.id)}">刪除</button>`:''}<button class="btn primary">儲存</button></div></form>`);
    $('#tripForm').addEventListener('submit',async ev=>{ev.preventDefault();const fd=new FormData(ev.currentTarget);let out={...v,id:v.id||uuid('trip'),title:String(fd.get('title')).trim(),date:String(fd.get('date')),mode:String(fd.get('mode')||'day'),startTime:String(fd.get('startTime')||'09:00'),notes:String(fd.get('notes')).trim(),stops:v.stops||[],createdAt:v.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};const startChanged=!!t&&String(t.startTime||'09:00')!==String(out.startTime||'09:00');if((!t&&out.stops.length)||(startChanged&&out.stops.length))out=applyTripAutoTimeline(out,{force:startChanged});await TwinDB.put('itineraries',out);await reloadData();closeModal();state.selectedTripId=out.id;setView('trips',{tripId:out.id});toast(startChanged?'行程已儲存，時間軸已依新開始時間更新':'行程已儲存');});
  }

  function addStopForm(tripId, existing=null, presetType='attraction') {
    const t=state.itineraries.find(x=>x.id===tripId); if(!t)return;
    const v=existing||{type:presetType,entityId:'',customTitle:'',plannedTime:'',plannedDurationMinutes:'',note:'',backupEntityId:'',backupNote:''};
    const optionsFor=(type)=>readyEntities().filter(e=>e.entityType===type).map(e=>`<option value="${esc(e.id)}" ${v.entityId===e.id?'selected':''}>${esc(e.name)}${entityLocation(e)?'｜'+esc(entityLocation(e)):''}</option>`).join('');
    const backupOptions=(type)=>{
      const types=['attraction','activity'].includes(type)?['attraction','activity']:[type];
      return readyEntities().filter(e=>types.includes(e.entityType)&&e.id!==v.entityId).map(e=>`<option value="${esc(e.id)}" ${v.backupEntityId===e.id?'selected':''}>${esc(e.name)}${entityLocation(e)?'｜'+esc(entityLocation(e)):''}</option>`).join('');
    };
    showModal(existing?'編輯站點':'新增站點', `<form id="stopForm" class="form-grid"><div class="field"><label>站點類型</label><select name="type" id="stopType"><option value="start" ${v.type==='start'?'selected':''}>出發</option><option value="attraction" ${v.type==='attraction'?'selected':''}>景點</option><option value="restaurant" ${v.type==='restaurant'?'selected':''}>餐廳</option><option value="hotel" ${v.type==='hotel'?'selected':''}>住宿</option><option value="activity" ${v.type==='activity'?'selected':''}>其他收藏</option><option value="custom" ${v.type==='custom'?'selected':''}>自訂</option><option value="home" ${v.type==='home'?'selected':''}>回家</option></select></div>
      <div class="field" id="entityPickWrap"><label>已儲存資料</label><select name="entityId" id="stopEntity"><option value="">尚未選擇</option>${optionsFor(v.type)}</select><div class="helper">只顯示同一 Entity Type。</div></div>
      <div class="field"><label>自訂名稱</label><input name="customTitle" value="${esc(v.customTitle||'')}" placeholder="例如：午餐、從家裡出發" /></div>
      <div class="inline-fields trip-time-fields"><div class="field"><label>時間</label><input name="plannedTime" type="time" value="${esc(v.plannedTime||'')}" /></div><div class="field"><label>停留時間（分鐘）</label><input name="duration" type="number" min="0" step="15" value="${esc(v.plannedDurationMinutes||'')}" /></div></div>
      <div class="field" id="backupWrap"><label>Plan B 備案</label><select name="backupEntityId" id="backupEntity"><option value="">沒有備案</option>${backupOptions(v.type)}</select><div class="helper">優先用自己的收藏；儲存站點後，也可從行程按「找 Plan B」查 Google 附近新地點。</div>${existing?`<button type="button" class="btn ghost small" data-plan-b-search="${esc(existing.id)}">Plan B 2.0 搜尋</button>`:''}</div>
      <div class="field"><label>備案備註</label><input name="backupNote" value="${esc(v.backupNote||'')}" placeholder="例如：下雨時改去這裡" /></div>
      <div class="field"><label>備註</label><textarea name="note">${esc(v.note||'')}</textarea></div>
      <div class="form-actions">${existing?`<button type="button" class="btn danger" data-delete-stop="${esc(existing.id)}">刪除</button>`:''}<button class="btn primary">儲存</button></div></form>`);
    const typeSel=$('#stopType'), entitySel=$('#stopEntity'), wrap=$('#entityPickWrap'), backupSel=$('#backupEntity'), backupWrap=$('#backupWrap');
    const syncType=()=>{ const type=typeSel.value, entityTypes=['attraction','restaurant','hotel','activity']; wrap.style.display=entityTypes.includes(type)?'block':'none';backupWrap.style.display=entityTypes.includes(type)?'block':'none'; entitySel.innerHTML=`<option value="">尚未選擇</option>${optionsFor(type)}`; backupSel.innerHTML=`<option value="">沒有備案</option>${backupOptions(type)}`; };
    typeSel.addEventListener('change',syncType); syncType(); if(existing&&existing.entityId) entitySel.value=existing.entityId; if(existing&&existing.backupEntityId) backupSel.value=existing.backupEntityId;
    $('#stopForm').addEventListener('submit',async ev=>{ev.preventDefault();const fd=new FormData(ev.currentTarget);const stops=[...(t.stops||[])];const enteredTime=String(fd.get('plannedTime')||'');const out={...v,id:v.id||uuid('stop'),type:String(fd.get('type')),entityId:String(fd.get('entityId')||''),externalPlace:String(fd.get('entityId')||'')?null:(v.externalPlace||null),externalEvidence:String(fd.get('entityId')||'')?null:(v.externalEvidence||null),customTitle:String(fd.get('customTitle')||'').trim(),plannedTime:enteredTime,plannedDurationMinutes:fd.get('duration')?Number(fd.get('duration')):null,note:String(fd.get('note')||'').trim(),backupEntityId:String(fd.get('backupEntityId')||''),backupExternalPlace:String(fd.get('backupEntityId')||'')?null:(v.backupExternalPlace||null),backupExternalEvidence:String(fd.get('backupEntityId')||'')?null:(v.backupExternalEvidence||null),backupNote:String(fd.get('backupNote')||'').trim(),order:v.order||stops.length+1,done:v.done||false,timeLocked:!!enteredTime,timeAuto:!enteredTime}; if(existing){const i=stops.findIndex(s=>s.id===existing.id);stops[i]=out;}else stops.push(out);Object.assign(t,applyTripAutoTimeline({...t,stops}));await TwinDB.put('itineraries',t); await reloadData(); closeModal(); render(); toast('站點已儲存');});
  }

  function pickTripForEntity(entityId) {
    const e=getEntity(entityId); if(!e)return;
    if (!state.itineraries.length) {
      showModal('先建立行程', `<div class="empty-state"><div class="empty-icon">🗓</div><h3>目前沒有行程</h3><p>建立後即可把「${esc(e.name)}」加入。</p><button class="btn primary" data-create-trip-for-entity="${esc(entityId)}">建立行程</button></div>`); return;
    }
    showModal('加入哪個行程？', `<div class="card-grid">${state.itineraries.map(t=>`<button class="trip-card" style="text-align:left" data-pick-trip="${esc(t.id)}" data-entity="${esc(entityId)}"><div class="trip-title">${esc(t.title)}</div><div class="trip-meta">${esc(fmtDate(t.date))}</div></button>`).join('')}</div>`);
  }

  async function addEntityToTrip(tripId, entityId) {
    let t=state.itineraries.find(x=>x.id===tripId),e=getEntity(entityId);if(!t||!e)return;
    if((t.stops||[]).some(st=>st.entityId===entityId) && !confirm(`「${e.name}」已在這趟行程裡。仍要再加入一次嗎？`)) return;
    const distance=distanceWarningForTrip(t,e);if(Number.isFinite(distance)&&distance>=80&&!confirm(`距上一個可定位站點約 ${Math.round(distance)} km，仍要加入嗎？`))return;
    const duration=defaultDurationForEntity(e),stops=[...(t.stops||[])];stops.push({id:uuid('stop'),type:e.entityType,entityId:e.id,customTitle:'',plannedTime:'',plannedDurationMinutes:duration,note:'',order:stops.length+1,done:false,timeAuto:true,timeLocked:false});
    t=applyTripAutoTimeline({...t,stops});await TwinDB.put('itineraries',t);await reloadData();closeModal();toast(`已加入「${e.name}」並排入時間軸`,'查看行程',()=>{state.selectedTripId=t.id;setView('trips',{tripId:t.id});},6500);
  }

  function packItemForm() {
    showModal('新增外出包項目', `<form id="packAddForm" class="form-grid"><div class="field"><label>項目名稱 *</label><input name="label" required /></div><div class="field"><label>分類</label><input name="cat" list="catList" value="其他" /><datalist id="catList"><option>衛生</option><option>衣物</option><option>飲食</option><option>其他</option></datalist></div><button class="btn primary">新增</button></form>`);
    $('#packAddForm').addEventListener('submit',async ev=>{ev.preventDefault();const fd=new FormData(ev.currentTarget);const item={id:uuid('pack'),label:String(fd.get('label')).trim(),cat:String(fd.get('cat')).trim()||'其他',order:state.packItems.length+1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};await TwinDB.put('packItems',item);await TwinDB.put('packState',{itemId:item.id,checked:false,updatedAt:new Date().toISOString()});await reloadData();closeModal();render();toast('已新增項目');});
  }

  function packMenu() {
    showModal('外出包選單', `<div class="form-grid"><button class="btn" data-reset-pack>全部重置</button><button class="btn" data-export-json>匯出 JSON 備份</button></div>`);
  }

  const EVIDENCE_V2_ACCEPTANCE_CHILD_AGE_MONTHS=26;
  const EVIDENCE_V2_ACCEPTANCE_CASES=[
    {id:'xpark',name:'Xpark',officialUrl:'https://www.xpark.com.tw/',sourceUrls:[],expect:h=>h.environmentType==='indoor'&&h.strollerFit==='good'&&h.toddlerAccess==='good'&&['partial','good'].includes(h.toddlerFit),expectText:'室內＋推車友善＋幼兒可去'},
    {id:'iocean',name:'潮境智能海洋館',officialUrl:'https://iocean.nmmst.gov.tw/ioceanC/',sourceUrls:[],expect:h=>h.nursingRoomStatus==='available'&&h.strollerFit==='good'&&h.toddlerAccess==='good'&&['partial','good'].includes(h.toddlerFit),expectText:'哺乳室＋推車友善＋幼兒可去'},
    {id:'xinpu',name:'柿子公園-有公廁',blocking:false,officialUrl:'',sourceUrls:['https://www.hsinchu.gov.tw/News_Content.aspx?n=153&s=273298'],expect:h=>h.toddlerFit==='good'&&h.toddlerAccess==='good'&&h.familyRestroomStatus==='available',expectText:'全齡／分齡幼兒適合＋親子廁所'},
    {id:'railbike',name:'深澳鐵道自行車',officialUrl:'https://www.railbike.com.tw/',sourceUrls:[],expect:h=>h.toddlerAccess==='conditional'&&h.toddlerFit==='partial'&&/3/.test(h.decisionAgeNote||'')&&/90/.test(h.decisionAgeNote||''),expectText:'幼兒有條件＋3歲或90cm'}
  ];
  async function runEvidenceV2AcceptanceSuite(){
    showModal('Evidence Resolver V2｜LIVE Acceptance',`<div class="setting-block"><h3>四案例即時測試</h3><p>這不是假資料測試。會由目前 Netlify Function 即時抓官方網站，再用正式 Evidence V2 判讀。</p></div><div id="evidenceV2Lab" class="acceptance-lab">${EVIDENCE_V2_ACCEPTANCE_CASES.map(c=>`<div class="acceptance-row" data-lab-case="${c.id}"><strong>${esc(c.name)}</strong><span>等待測試…</span><small>${c.blocking===false?'非阻斷案例｜':''}目標：${esc(c.expectText)}</small></div>`).join('')}</div><div class="helper">核心案例 Xpark／潮境／深澳為阻斷 Gate；新埔柿子公園改列已知外部連線限制，不再阻斷版本推進。Persistence Gate 與 V4.4 LIVE smoke 仍需通過。</div>`,{wide:true});
    const results=[];
    for(const c of EVIDENCE_V2_ACCEPTANCE_CASES){
      const row=$(`[data-lab-case="${c.id}"]`);if(row)row.querySelector('span').textContent='正在即時查證…';
      let data=null,hints={},pass=false,error='';
      try{
        data=await fetchJsonWithTimeout('/api/evidence-resolve',{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',body:JSON.stringify({name:c.name,officialUrl:c.officialUrl,sourceUrls:c.sourceUrls})},50000);
        hints=sourceDecisionHints(data,{currentChildAgeMonths:EVIDENCE_V2_ACCEPTANCE_CHILD_AGE_MONTHS});pass=!!data.evidenceVerified&&!!c.expect(hints);
      }catch(err){error=String(err?.message||err);}
      results.push({id:c.id,name:c.name,pass,error,pages:data?.pagesScanned||0,hints,evidencePages:data?.evidencePages||[]});
      if(row){
        row.classList.toggle('pass',pass);row.classList.toggle('fail',!pass);
        row.querySelector('span').textContent=pass?`PASS・掃描 ${data?.pagesScanned||0} 頁`:`FAIL${error?`・${error}`:''}`;
        const diag=!pass&&data?`｜resolver:${data.reason||'unknown'}・掃描${data.pagesScanned||0}頁・fetchErr ${data.fetchErrors||0}${data.fetchErrorDetails?.[0]?`(${data.fetchErrorDetails[0].reason})`:''}${data.deadlineReached?'・deadline':''}${data.scannedPages?.[0]?`・首頁 ${data.scannedPages[0].identityScore}/${data.scannedPages[0].verified?'verified':'unverified'}`:''}`:'';
        row.querySelector('small').textContent=pass?`${c.expectText}｜證據頁：${(data?.evidencePages||[]).slice(0,2).map(x=>x.url).join('、')||'已取得'}`:`目標：${c.expectText}｜實際：${JSON.stringify(hints)}${diag}`;
      }
    }
    const blockingIds=new Set(EVIDENCE_V2_ACCEPTANCE_CASES.filter(c=>c.blocking!==false).map(c=>c.id)),corePass=results.filter(x=>blockingIds.has(x.id)).every(x=>x.pass),allPass=results.every(x=>x.pass),xinpu=results.find(x=>x.id==='xinpu');const root=$('#evidenceV2Lab');if(root)root.insertAdjacentHTML('afterend',`<div class="setting-block acceptance-gate ${corePass?'pass':'fail'}"><h3>${corePass?'EVIDENCE CORE PASS':'EVIDENCE CORE FAIL'}</h3><p>${corePass?`核心 3 / 3 通過${xinpu&&!xinpu.pass?'；新埔為 KNOWN LIMITATION／NON-BLOCKING':''}。仍須完成 Persistence、Plan B 與 Companion LIVE Gate。`:'核心案例尚未全數通過，維持 TEST BUILD。'}</p>${allPass?'':'<small>完整四案例未全 PASS，不等同 Evidence 服務全面無限制。</small>'}</div>`);
    window.__evidenceV2AcceptanceResults=results;
    return results;
  }

  const PERSISTENCE_QA_ENTITY_ID='activity-300';
  const PERSISTENCE_QA_URL='https://qa.local/evidence-v4.3.10';
  function persistenceGateSignature(e){
    return !!e && e.environmentType==='outdoor' && e.strollerFit==='good' && e.nursingRoomStatus==='available' && e.toddlerAccess==='good' && e.decisionEvidenceUrl===PERSISTENCE_QA_URL && Number(e.decisionFieldProvenance?.environmentType?.authorityRank)===90 && e.decisionFieldProvenance?.environmentType?.url===PERSISTENCE_QA_URL;
  }
  async function startPersistenceGate(){
    const catalog=await loadDecisionMetadataCatalog();const version=String(catalog?.version||'unknown'),marker=`decisionCatalogMigrated:${version}`;
    const backup=await TwinDB.get('entities',PERSISTENCE_QA_ENTITY_ID)||null;
    const now=new Date().toISOString();
    const base=backup||{id:PERSISTENCE_QA_ENTITY_ID,entityType:'activity',name:'Persistence Gate QA',captureStatus:'ready',sourceUrls:[],originalUrl:'',favorite:false,visited:false,createdAt:now};
    const prov={sourceType:'government',authorityRank:90,url:PERSISTENCE_QA_URL,publishedAt:'2026-08-17',verifiedAt:todayISO(),value:'outdoor'};
    const test={...base,name:'Persistence Gate QA',decisionEligible:false,environmentType:'outdoor',rainSuitability:'unknown',toddlerFit:'partial',toddlerAccess:'good',strollerFit:'good',nursingRoomStatus:'available',decisionMetadataVersion:'v4.3.10-persistence-test',decisionConfidence:'A',decisionEvidenceUrl:PERSISTENCE_QA_URL,decisionEvidenceNote:'Persistence Gate sentinel',decisionVerifiedAt:todayISO(),decisionFieldProvenance:{environmentType:prov,strollerFit:{...prov,value:'good'},nursingRoomStatus:{...prov,value:'available'},toddlerAccess:{...prov,value:'good'}},updatedAt:now};
    await TwinDB.put('settings',{key:'persistenceGateBackup',value:backup});
    await TwinDB.put('settings',{key:'persistenceGatePending',value:{startedAt:now,entityId:PERSISTENCE_QA_ENTITY_ID,catalogVersion:version}});
    await TwinDB.put('settings',{key:marker,value:false});
    await TwinDB.put('entities',test);
    closeModal();toast('Persistence Gate 已建立：請完全關閉 App，再重新開啟。', '', null, 9000);
  }
  async function finalizePersistenceGateIfPending(){
    const pending=state.settings.persistenceGatePending;if(!pending?.entityId)return null;
    const row=await TwinDB.get('entities',pending.entityId);const pass=persistenceGateSignature(row);const backup=state.settings.persistenceGateBackup??null;
    const result={status:pass?'PASS':'FAIL',checkedAt:new Date().toISOString(),catalogVersion:pending.catalogVersion||'',detail:pass?'Evidence 值、來源、verifiedAt/provenance 在重開與 catalog migration 後仍存在':'重開後 sentinel 被覆寫或 provenance 遺失'};
    if(backup)await TwinDB.put('entities',backup);else await TwinDB.remove('entities',pending.entityId);
    await TwinDB.put('settings',{key:'persistenceGateLastResult',value:result});
    await TwinDB.remove('settings','persistenceGatePending');await TwinDB.remove('settings','persistenceGateBackup');
    await reloadData();return result;
  }
  function persistenceGateHtml(){
    const r=state.settings.persistenceGateLastResult;const pending=state.settings.persistenceGatePending;
    const checkedLocal=r?.checkedAt?new Date(r.checkedAt).toLocaleString('zh-TW',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'';const status=pending?'等待關閉／重開驗證':r?.status?`${r.status}・${checkedLocal}`:'尚未執行';
    return `<div class="setting-block"><h3>Persistence Gate｜實際重開測試</h3><p>專門驗證：新 Evidence 寫入後，關閉／重開 App 並再次執行舊 catalog migration，資料與欄位來源不會被蓋回去。測試完成會自動還原原資料。</p><div class="acceptance-status ${r?.status==='PASS'?'pass':r?.status==='FAIL'?'fail':''}"><strong>${esc(status)}</strong>${r?.detail?`<small>${esc(r.detail)}</small>`:''}</div><button class="btn primary full" data-start-persistence-gate ${pending?'disabled':''}>${pending?'請關閉 App 後重開':'開始 Persistence Gate'}</button><div class="helper">這不是頁面重新 render 測試；按下後請從 iPhone App 切換器完全關閉，再重新開啟。</div></div>`;
  }

  const V44_AUTO_GATE_CHECKS=[
    ['version','版本／快取一致性'],
    ['data','本機資料完整性'],
    ['google-health','Google Places API Key'],
    ['place-search','Google Place Search'],
    ['place-details','Google Place Details'],
    ['nearby','Plan B Nearby 15 km'],
    ['text-search','Plan B Text Search'],
    ['evidence','Evidence Core 3/3'],
    ['planb-contract','Plan B 範圍／去重防呆'],
    ['theme-contract','自訂主題資料／篩選防呆'],
    ['companion-contract','Companion runtime contract']
  ];
  function autoGateLocalTime(v=''){const d=new Date(v);return Number.isNaN(d.getTime())?'':d.toLocaleString('zh-TW',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}
  function autoGateRowSet(id,status,detail=''){
    const row=$(`[data-auto-gate="${id}"]`);if(!row)return;
    row.classList.remove('pass','fail','running');if(status==='PASS')row.classList.add('pass');else if(status==='FAIL')row.classList.add('fail');else if(status==='RUNNING')row.classList.add('running');
    const span=row.querySelector('span'),small=row.querySelector('small');if(span)span.textContent=status==='RUNNING'?'測試中…':status;if(small)small.textContent=detail||'';
  }
  function autoGateDataIntegrity(){
    const dup=(rows,key='id')=>{const seen=new Set(),dups=[];for(const x of rows||[]){const v=String(x?.[key]||'');if(!v)continue;if(seen.has(v))dups.push(v);seen.add(v);}return [...new Set(dups)];};
    const entityDup=dup(state.entities),tripDup=dup(state.itineraries),badEntity=state.entities.filter(e=>!e?.id||!e?.entityType).length;
    if(entityDup.length||tripDup.length||badEntity)throw new Error(`entityDup=${entityDup.length}, tripDup=${tripDup.length}, badEntity=${badEntity}`);
    return `entities ${state.entities.length}、trips ${state.itineraries.length}；ID 無重複`;
  }
  async function autoGateVersionContract(){
    const v=await fetchJsonWithTimeout('./version.json',{cache:'no-store'},8000);if(String(v.version||'')!==APP_RUNTIME_VERSION)throw new Error(`version.json=${v.version||'missing'} / runtime=${APP_RUNTIME_VERSION}`);
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),8000);try{const r=await fetch(`./sw.js?gate=${Date.now()}`,{cache:'no-store',signal:ctrl.signal});if(!r.ok)throw new Error(`sw_http_${r.status}`);const text=await r.text();if(!text.includes(APP_RUNTIME_VERSION))throw new Error('service_worker_version_mismatch');}finally{clearTimeout(timer);}
    return `runtime / version.json / SW = ${APP_RUNTIME_VERSION}`;
  }
  function autoGatePlanBContract(){
    const original=state.entities;
    try{
      const common={entityType:'attraction',captureStatus:'ready',toddlerFit:'good',strollerFit:'good',familyRating:null,revisitIntent:''};
      state.entities=[
        {...common,id:'qa-base',name:'基地',county:'桃園市',district:'中壢區',geoGroup:'桃竹苗',latitude:24.95,longitude:121.22,googlePlaceId:'KNOWN_CURRENT'},
        {...common,id:'qa-near',name:'近距離',county:'桃園市',district:'中壢區',geoGroup:'桃竹苗',latitude:24.98,longitude:121.24,googlePlaceId:'KNOWN_SAVED'},
        {...common,id:'qa-far',name:'遠距離',county:'高雄市',district:'左營區',geoGroup:'南部',latitude:22.62,longitude:120.30},
        {...common,id:'qa-missing',name:'無座標',county:'桃園市',district:'桃園區',geoGroup:'桃竹苗',latitude:null,longitude:null}
      ];
      let ids=planBSavedCandidates({type:'attraction',entityId:'qa-base'}).map(x=>x.e.id);
      if(!ids.includes('qa-near')||ids.includes('qa-far')||ids.includes('qa-missing'))throw new Error(`anchored_range_fail:${ids.join(',')}`);
      const filtered=filterPlanBGoogleCandidates([{placeId:'KNOWN_SAVED'},{placeId:'NEW_PLACE'}],{type:'attraction',entityId:'qa-base'}).map(x=>x.placeId);
      if(filtered.join(',')!=='NEW_PLACE')throw new Error(`place_dedupe_fail:${filtered.join(',')}`);
      state.entities=[
        {...common,id:'qa-base2',name:'基地2',county:'桃園市',district:'中壢區',geoGroup:'桃竹苗',latitude:null,longitude:null},
        {...common,id:'qa-county',name:'同縣市',county:'桃園市',district:'桃園區',geoGroup:'桃竹苗',latitude:null,longitude:null},
        {...common,id:'qa-geo',name:'同區域',county:'新竹縣',district:'竹北市',geoGroup:'桃竹苗',latitude:null,longitude:null},
        {...common,id:'qa-none',name:'無脈絡',county:'',district:'',geoGroup:'',latitude:null,longitude:null}
      ];
      ids=planBSavedCandidates({type:'attraction',entityId:'qa-base2'}).map(x=>x.e.id);
      if(ids.join(',')!=='qa-county')throw new Error(`unanchored_scope_fail:${ids.join(',')}`);
      return '有座標：≤40 km 且排除無座標；無座標：同縣市／同區域；Google Place ID 去重 PASS';
    }finally{state.entities=original;}
  }
  function autoGateThemeContract(){
    const oldEntities=state.entities,oldSettings=state.settings,oldExplore={...state.explore},oldGeoFilter={...geoFilter};
    try{
      const base={captureStatus:'ready',entityType:'attraction',geoGroup:'桃竹苗',familyTags:[],tags:[],decisionTags:[],favorite:false,visited:false,indoor:null,environmentType:'',minAgeMonths:null,maxAgeMonths:null};
      state.entities=[
        {...base,id:'qa-theme-a',name:'室內動物館',indoor:true,environmentType:'indoor',favorite:true},
        {...base,id:'qa-theme-b',name:'戶外公園',indoor:false,environmentType:'outdoor',visited:true},
        {...base,id:'qa-theme-c',name:'動物牧場',indoor:false,environmentType:'outdoor'}
      ];
      const manual=normalizeExploreTheme({id:'m',name:'手動',mode:'manual',entityIds:['qa-theme-a','qa-theme-c']});
      if(!themeMatchesEntity(manual,state.entities[0])||themeMatchesEntity(manual,state.entities[1])||!themeMatchesEntity(manual,state.entities[2]))throw new Error('manual_membership_fail');
      const smart=normalizeExploreTheme({id:'s',name:'室內動物',mode:'smart',rules:{indoorOnly:true,keywords:'動物,牧場'}});
      if(!themeMatchesEntity(smart,state.entities[0])||themeMatchesEntity(smart,state.entities[1])||themeMatchesEntity(smart,state.entities[2]))throw new Error('smart_rule_fail');
      state.settings={...oldSettings,exploreThemes:[manual,smart]};state.explore={...oldExplore,type:'attraction',themeId:'m',query:'',visited:'',indoor:'',ageOnly:false,favoriteOnly:false,nearby:false,userPos:null,sort:'recommended'};geoFilter={macroRegion:'all',geoGroup:'all'};
      const ids=filteredEntities().map(x=>x.id).sort();if(ids.join(',')!=='qa-theme-a,qa-theme-c')throw new Error(`filtered_theme_fail:${ids.join(',')}`);
      const snap=JSON.stringify(state.settings.exploreThemes);if(JSON.parse(snap).length!==2)throw new Error('theme_serialization_fail');
      return '手動主題／條件主題／交叉篩選／JSON 保存 contract PASS';
    }finally{state.entities=oldEntities;state.settings=oldSettings;state.explore=oldExplore;geoFilter=oldGeoFilter;}
  }
  function autoGateCompanionContract(){
    const oldTrips=state.itineraries,oldSelected=state.selectedTripId,oldCompanion=state.tripCompanion;
    try{
      state.itineraries=[{id:'qa-trip',title:'QA 行程',date:todayISO(),startTime:'09:00',stops:[{id:'qa-stop',type:'attraction',entityId:'',externalPlace:{placeId:'QA_PLACE',name:'QA 景點',address:'桃園市',latitude:24.95,longitude:121.22},plannedTime:'10:00',done:false,order:1}]}];state.selectedTripId='qa-trip';state.tripCompanion=true;
      const html=renderTripCompanion();for(const needle of ['data-nav-url=','data-plan-b-search=','data-complete-stop=','外出包'])if(!html.includes(needle))throw new Error(`missing_${needle}`);
      return '導航／Plan B／完成站點／外出包 runtime contract PASS';
    }finally{state.itineraries=oldTrips;state.selectedTripId=oldSelected;state.tripCompanion=oldCompanion;}
  }
  async function autoGateEvidenceCore(){
    const blocking=EVIDENCE_V2_ACCEPTANCE_CASES.filter(c=>c.blocking!==false),out=[];
    for(const c of blocking){let data;try{data=await fetchJsonWithTimeout('/api/evidence-resolve',{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',body:JSON.stringify({name:c.name,officialUrl:c.officialUrl,sourceUrls:c.sourceUrls})},50000);}catch(err){throw new Error(`${c.name}:${err?.message||err}`);}const hints=sourceDecisionHints(data,{currentChildAgeMonths:EVIDENCE_V2_ACCEPTANCE_CHILD_AGE_MONTHS});const pass=!!data.evidenceVerified&&!!c.expect(hints);if(!pass)throw new Error(`${c.name}:${data?.reason||'evidence_mismatch'}:${JSON.stringify(hints)}`);out.push(`${c.name} ${data.pagesScanned||0}頁`);}
    return out.join('・');
  }
  async function runV44AutoGate(){
    showModal('V4.4 TEST3.4｜一鍵自動驗收',`<div class="setting-block"><h3>部署後一鍵檢查</h3><p>會即時檢查版本、Google Places、Nearby／Text Search、Evidence Core、Plan B 範圍、自訂主題與 Companion runtime。Google 查詢使用低成本必要欄位；不會新增收藏、不會修改行程。</p></div><div id="v44AutoGateLab" class="acceptance-lab">${V44_AUTO_GATE_CHECKS.map(([id,label])=>`<div class="acceptance-row" data-auto-gate="${id}"><strong>${esc(label)}</strong><span>等待測試…</span><small></small></div>`).join('')}</div><div class="helper">Persistence 必須真的關閉／重開 iPhone PWA，無法由同一頁面自動冒充；導航跳轉等實機互動仍保留人工 smoke。</div>`,{wide:true});
    const results=[];let smokePlace=null;
    const run=async(id,fn)=>{autoGateRowSet(id,'RUNNING','');try{const detail=await fn();results.push({id,status:'PASS',detail:String(detail||'')});autoGateRowSet(id,'PASS',String(detail||''));return true;}catch(err){const detail=String(err?.message||err||'unknown_error');results.push({id,status:'FAIL',detail});autoGateRowSet(id,'FAIL',detail);return false;}};
    await run('version',autoGateVersionContract);
    await run('data',async()=>autoGateDataIntegrity());
    const healthPass=await run('google-health',async()=>{const d=await fetchJsonWithTimeout('/api/place-health',{cache:'no-store'},10000);if(!d.configured)throw new Error('GOOGLE_PLACES_API_KEY 尚未設定');return 'API Key 已由 Netlify Function 讀取';});
    let searchPass=false;
    if(healthPass){searchPass=await run('place-search',async()=>{const d=await fetchJsonWithTimeout('/api/place-search',{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',body:JSON.stringify({name:'Xpark',location:'桃園市中壢區',entityType:'attraction'})},18000);smokePlace=d.autoCandidate||(d.candidates||[])[0];if(!smokePlace?.placeId||!Number.isFinite(Number(smokePlace.latitude))||!Number.isFinite(Number(smokePlace.longitude))||!smokePlace.googleMapsUrl)throw new Error('Xpark 未取得完整 Place identity／座標／Google Maps URI');const mapped=applyPlaceCandidateToEntity({id:'qa-map',entityType:'attraction',name:'Xpark',captureStatus:'ready'},smokePlace);if(mapped.googleMapsUrl!==smokePlace.googleMapsUrl)throw new Error('Google Maps URI mapping contract failed');return `${smokePlace.displayName||'Xpark'}｜Maps URI＋座標 OK`;});if(!searchPass){for(const id of ['place-details','nearby','text-search']){results.push({id,status:'FAIL',detail:'Place Search Gate 未通過'});autoGateRowSet(id,'FAIL','Place Search Gate 未通過');}}}
    else {for(const id of ['place-search','place-details','nearby','text-search']){results.push({id,status:'FAIL',detail:'Google API Key Gate 未通過'});autoGateRowSet(id,'FAIL','Google API Key Gate 未通過');}}
    if(searchPass){
      await run('place-details',async()=>{const d=await fetchJsonWithTimeout(`/api/place-details?placeId=${encodeURIComponent(smokePlace.placeId)}`,{cache:'no-store'},13000);if(d.placeId!==smokePlace.placeId)throw new Error('Place Details identity mismatch');return d.websiteUri?'Details＋official website URI OK':'Details endpoint OK（此地點未回 websiteUri）';});
      await run('nearby',async()=>{const d=await fetchJsonWithTimeout('/api/nearby-places',{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',body:JSON.stringify({latitude:Number(smokePlace.latitude),longitude:Number(smokePlace.longitude),entityType:'attraction',mode:'nearby',radiusKm:15})},16000);if(d.radiusKm!==15||!Array.isArray(d.candidates)||!d.candidates.length)throw new Error(`Nearby 結果異常：radius=${d.radiusKm}, n=${d.candidates?.length||0}`);return `15 km｜${d.candidates.length} 個候選`;});
      await run('text-search',async()=>{const d=await fetchJsonWithTimeout('/api/nearby-places',{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',body:JSON.stringify({latitude:Number(smokePlace.latitude),longitude:Number(smokePlace.longitude),entityType:'attraction',mode:'text',query:'親子 室內景點',radiusKm:15})},16000);if(d.mode!=='text'||!Array.isArray(d.candidates)||!d.candidates.length)throw new Error(`Text Search 結果異常：n=${d.candidates?.length||0}`);return `「親子 室內景點」｜${d.candidates.length} 個候選`;});
    }
    await run('evidence',autoGateEvidenceCore);
    await run('planb-contract',async()=>autoGatePlanBContract());
    await run('theme-contract',async()=>autoGateThemeContract());
    await run('companion-contract',async()=>autoGateCompanionContract());
    const fails=results.filter(x=>x.status==='FAIL'),root=$('#v44AutoGateLab'),persistence=state.settings.persistenceGateLastResult;
    if(root)root.insertAdjacentHTML('afterend',`<div class="setting-block acceptance-gate ${fails.length?'fail':'pass'}"><h3>${fails.length?'AUTO GATE FAIL':'AUTO GATE PASS'}</h3><p>${fails.length?`${fails.length} 項未通過；請先修正再進實機 Gate。`:'全部可自動驗證項目通過。接著只剩不能假自動化的實機 Gate。'}</p><div class="auto-gate-manual"><strong>人工 Gate</strong><small>Persistence：${esc(persistence?.status||'待測')}${persistence?.checkedAt?`（${esc(autoGateLocalTime(persistence.checkedAt))}）`:''}｜Companion：需實機確認導航／完成／Undo／Plan B／外出包</small></div></div>`);
    window.__v44AutoGateResults=results;return results;
  }

  function cloudStatusLabel(status){
    if(!status?.configured)return '<strong>Cloud Sync：</strong>尚未啟用設定';
    if(status.originMatch===false)return `<strong>Cloud Sync：</strong>目前網址不是正式站<br><small>目前：${esc(location.origin)}｜正式：${esc(status.siteOrigin||'未設定')}</small>`;
    if(!status?.authenticated)return `<strong>Cloud Sync：</strong>已連線 Supabase，尚未登入<br><small>正式站：${esc(status.siteOrigin||location.origin)}</small>`;
    const email=esc(status.user?.email||'已登入');
    const when=status.lastSyncAt?autoGateLocalTime(status.lastSyncAt):'尚未同步';
    return `<strong>Cloud Sync：</strong>${email}<br><small>最後同步：${esc(when)}${status.workspaceId?'｜Workspace 已建立':''}</small>`;
  }

  async function hydrateCloudSyncSettings(){
    const root=$('#cloudSyncStatus');if(!root||!window.TwinCloudSync)return;
    root.innerHTML='正在檢查 Cloud Sync…';
    try{
      const status=await TwinCloudSync.getStatus();
      root.innerHTML=cloudStatusLabel(status);
      const login=$('[data-cloud-login]'),bootstrap=$('[data-cloud-bootstrap]'),sync=$('[data-cloud-sync]'),signout=$('[data-cloud-signout]'),gate=$('[data-cloud-gate]');
      if(login)login.style.display=status.configured&&status.originMatch!==false&&!status.authenticated?'':'none';
      if(bootstrap)bootstrap.style.display=status.authenticated?'':'none';
      if(sync)sync.style.display=status.authenticated?'':'none';
      if(signout)signout.style.display=status.authenticated?'':'none';
      if(gate)gate.style.display=status.configured?'':'none';
    }catch(err){root.innerHTML=`<strong>Cloud Sync：</strong>檢查失敗<br><small>${esc(err.message||String(err))}</small>`;}
  }

  async function cloudSyncAndRefresh(){
    const result=await TwinCloudSync.syncNow();
    await reloadData();render();
    return result;
  }

  function settingsModal() {
    const counts=Object.fromEntries(Object.keys(TYPE_LABELS).map(t=>[t,state.entities.filter(e=>e.entityType===t).length]));
    const autoCount=state.entities.filter(e=>e.googlePlaceId).length;
    const missingCount=state.entities.filter(e=>!e.coverImage&&!e.googlePlaceId).length;
    showModal('設定與資料', `<div class="setting-block"><h3>App 顯示名稱</h3><p>可以把頁首「雙寶出遊」改成你自己的名稱。</p><div class="field"><input id="appTitleSetting" type="text" value="${esc(currentAppTitle())}" maxlength="20" placeholder="例如：雙寶出遊" /></div><button class="btn primary full" style="margin-top:10px" data-save-app-title>儲存名稱</button><div class="helper" style="margin-top:8px">會同步到 App 頁首與瀏覽器標題；已加入主畫面的圖示名稱可能受 PWA 安裝快取限制。</div></div>
      <div class="setting-block"><h3>頁首圖示</h3><p>可以把名稱左邊的熊改成自己的家庭圖示；只影響 App 內頁首，不會強制改手機主畫面 PWA 圖示。</p><div class="brand-icon-setting"><div class="brand-icon-preview">${state.settings.appIconImage?`<img src="${esc(state.settings.appIconImage)}" alt="目前圖示" />`:'🐻'}</div><div class="field"><input id="appIconSetting" type="file" accept="image/*" /><div class="helper">會自動裁成正方形並縮到 256×256。</div></div></div><div class="form-actions"><button class="btn" data-reset-app-icon>恢復熊圖示</button><button class="btn primary" data-save-app-icon>儲存圖示</button></div></div>
      <div class="setting-block"><h3>雙寶生日</h3><p>只有填寫後，才會啟用「適合目前年齡」；未有結構化年齡資料的景點不會被猜測。</p><div class="field"><input id="birthdateSetting" type="date" value="${esc(state.settings.childBirthdate||'')}" /></div><button class="btn primary full" style="margin-top:10px" data-save-birthdate>儲存生日</button></div>
      <div class="setting-block"><h3>V4.5｜手機・電腦 Cloud Sync</h3><p>同一個 Google 帳號可讓手機與電腦使用同一份收藏、行程、主題與外出包。IndexedDB 仍保留做離線快取。</p><div id="cloudSyncStatus" class="helper" style="margin-bottom:10px">正在檢查 Cloud Sync…</div><div class="form-grid"><button class="btn primary full" data-cloud-login>使用 Google 登入</button><button class="btn" data-cloud-bootstrap style="display:none">初始化／合併雲端</button><button class="btn primary" data-cloud-sync style="display:none">立即同步</button><button class="btn" data-cloud-gate style="display:none">Cloud Sync Gate</button><button class="btn" data-cloud-signout style="display:none">登出</button></div><div class="helper" style="margin-top:8px">首次同步前會自動留下本機完整備份；若手機與電腦同一筆資料同時修改，會停止並回報 conflict，不會靜默互相覆蓋。</div></div>
      <div class="setting-block"><h3>V4.4 TEST3.4｜一鍵自動驗收</h3><p>部署後先跑這一鍵：版本／Google Places／Nearby／Text Search／Evidence Core／Plan B 防呆／Companion runtime 一次檢查。</p><button class="btn primary full" data-v44-auto-gate>執行 V4.4 完整自動驗收</button><div class="helper">不會新增收藏或修改行程。Persistence 必須真實關閉／重開 App，因此仍保留獨立實機 Gate。</div></div>
      <div class="setting-block"><h3>Source-Aware 網路封面</h3><p>優先順序：自己的照片 → 來源網址縮圖 → Google Places → 預設圖。一般網站會讀取 og:image / twitter:image；YouTube 使用影片縮圖；Facebook、Instagram、TikTok、Threads 與 Maps 類連結直接安全 fallback，不嘗試爬圖。</p><div class="form-grid"><button class="btn" data-test-place-api>測試 Google API</button><button class="btn primary" data-batch-place>批次補齊既有資料</button><button class="btn secondary full" id="fastCandidateQueueBtn">快速確認待配對</button><button style="display:none"></button></div><div class="helper">V4.3 保留 Verified Data Only；來源網址只取該頁明確宣告的縮圖，不推測內容。Google Places 僅在必要時才呼叫。</div></div>
      <div class="setting-block"><h3>V4.4 TEST3.4｜Evidence Resolver V2（沿用 V4.3.10）</h3><p>官方／政府證據仍沿用已壓測的多頁站內探索與欄位級 provenance；V4.4 不改鬆 Evidence 安全門檻。</p><button class="btn primary full" data-evidence-v2-acceptance>執行四案例 LIVE Acceptance</button><div class="helper">核心阻斷案例：Xpark／潮境智能海洋館／深澳鐵道自行車。新埔公二柿子特色公園為非阻斷已知限制；Persistence、Plan B 與 Companion LIVE Gate 仍須完成。</div></div>
      ${persistenceGateHtml()}
      <div class="setting-block"><h3>V4.4 Family Trip Companion</h3><p>新增出遊當天模式、Plan B 2.0、帶娃輕鬆度與可解釋的家庭偏好學習。Google 新發現會明確標示尚未完整查證。</p><div class="helper">本版不加入即時天氣，也不假裝有即時車程。新 Plan B Google Nearby／Text Search 必須在部署後通過 LIVE smoke test 才能封正式版。</div></div><div class="setting-block"><h3>版本</h3><p>實際執行版本：<strong>${APP_RUNTIME_VERSION}</strong></p><div class="helper">若頁首版本與此處不同，代表舊快取尚未更新。</div></div>
      <div class="setting-block"><h3>目前資料</h3><p>景點 ${counts.attraction}・住宿 ${counts.hotel}・餐廳 ${counts.restaurant}・其他收藏 ${counts.activity}・自訂主題 ${exploreThemes().length}・外出包 ${state.packItems.length}・行程 ${state.itineraries.length}</p></div>
      <div class="setting-block"><h3>備份與還原</h3><p>V4.5 採「Supabase 雲端正式資料＋IndexedDB 離線快取」；JSON 匯出仍保留作額外人工備份。</p><div class="form-grid"><button class="btn" data-export-json>匯出 JSON</button><button class="btn" data-import-json>匯入 JSON</button></div></div>
      <div class="setting-block"><h3>離線範圍</h3><p>核心資料與行程可離線使用；重新連線後再同步雲端。Google Places 網路封面、地圖、外部網站與即時資訊需網路。</p></div>`);
    hydrateCloudSyncSettings();
  }

  async function exportJson() {
    const data=await TwinDB.snapshot();const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`雙寶出遊_V4_備份_${todayISO()}.json`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);toast('JSON 備份已產生');
  }

  async function importJsonFile(file) {
    const text=await file.text(); let raw; try{raw=JSON.parse(text);}catch(_){throw new Error('JSON 格式無法解析');}
    let data;
    if (raw.format==='twin-trip-v4' && Array.isArray(raw.entities)) data=raw;
    else if (Array.isArray(raw.attractions)||Array.isArray(raw.hotels)) data=migrateLegacyData(raw);
    else throw new Error('不支援的 JSON 格式');
    if (!Array.isArray(data.entities)||!Array.isArray(data.packItems)) throw new Error('缺少必要資料');
    await TwinDB.atomicImport(data);await reloadData();state.selectedEntityId=null;state.selectedTripId=null;setView('home');toast('匯入完成');
  }

  function setupStopDrag() {
    $$('.drag-handle[data-stop-drag]').forEach(handle=>setupPointerDrag(handle,'.stop-row','#stopList',async orderedIds=>{
      const t=state.itineraries.find(x=>x.id===state.selectedTripId);if(!t)return;
      const map=Object.fromEntries((t.stops||[]).map(s=>[s.id,s]));
      t.stops=orderedIds.map((id,i)=>({...map[id],order:i+1}));t.scheduleDirty=true;t.updatedAt=new Date().toISOString();
      await TwinDB.put('itineraries',t);await reloadData();render();toast('順序已更新；可按「重新排時間」同步時間軸');
    }));
  }
  function setupPackDrag() {
    $$('.drag-handle[data-pack-drag]').forEach(handle=>setupPointerDrag(handle,'.pack-row',`.pack-list[data-pack-group="${CSS.escape(handle.closest('.pack-group').querySelector('.pack-group-title').textContent.replace(/（.*$/,''))}"]`,async orderedIds=>{
      const moved=orderedIds.map(id=>state.packItems.find(x=>x.id===id)).filter(Boolean);const slots=state.packItems.map((x,i)=>orderedIds.includes(x.id)?i:-1).filter(i=>i>=0);const all=[...state.packItems];slots.forEach((slot,i)=>{all[slot]=moved[i];});all.forEach((x,i)=>x.order=i+1);await TwinDB.bulkPut('packItems',all);await reloadData();
    }));
  }
  function setupPointerDrag(handle,rowSel,containerSel,onSave) {
    let active=false,row=null,container=null;
    handle.addEventListener('pointerdown',ev=>{if(ev.button!==undefined&&ev.button!==0)return;row=handle.closest(rowSel);container=row.closest(containerSel)||row.parentElement;active=true;row.classList.add('dragging');handle.setPointerCapture?.(ev.pointerId);ev.preventDefault();});
    handle.addEventListener('pointermove',ev=>{if(!active)return;const target=document.elementFromPoint(ev.clientX,ev.clientY)?.closest(rowSel);if(!target||target===row||target.parentElement!==container)return;const rect=target.getBoundingClientRect();container.insertBefore(row,ev.clientY<rect.top+rect.height/2?target:target.nextSibling);});
    const end=async()=>{if(!active)return;active=false;row.classList.remove('dragging');const ids=[...container.querySelectorAll(rowSel)].map(x=>x.dataset.stopId||x.dataset.packId);await onSave(ids);};
    handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
  }

  document.addEventListener('click', async ev => {
    const t=ev.target.closest('button,a,[data-open-entity],[data-open-trip]'); if(!t)return;
    if (t.matches('[data-close-modal]')) return closeModal();
    if (t.matches('[data-view]')) return setView(t.dataset.view);
    if (t.matches('[data-view-jump]')) { state.selectedTripId=null; state.tripCompanion=false; return setView(t.dataset.viewJump); }
    if (t.matches('[data-open-entity]')) { if(ev.target.closest('[data-favorite]'))return; return setView('detail',{entityId:t.dataset.openEntity}); }
    if (t.matches('[data-back-explore]')) return setView('explore');
    if (t.matches('[data-open-trip]')) { state.selectedTripId=t.dataset.openTrip; state.tripCompanion=false; return setView('trips',{tripId:t.dataset.openTrip}); }
    if (t.matches('[data-open-trip-normal]')) { state.selectedTripId=t.dataset.openTripNormal; state.tripCompanion=false; return setView('trips',{tripId:t.dataset.openTripNormal}); }
    if (t.matches('[data-trip-companion]')) { state.selectedTripId=t.dataset.tripCompanion; state.tripCompanion=true; return setView('trips',{tripId:t.dataset.tripCompanion}); }
    if (t.matches('[data-exit-companion]')) { state.tripCompanion=false; return render(); }
    if (t.matches('[data-back-trips]')) { state.selectedTripId=null; state.tripCompanion=false; return render(); }
    if (t.matches('[data-add-entity]')) return entityForm();
    if (t.matches('[data-quick-capture]')) return quickCaptureModal();
    if (t.matches('[data-inbox-open]')) return inboxModal();
    if (t.matches('[data-inbox-edit]')) { const e=getEntity(t.dataset.inboxEdit); closeModal(); if(e)return entityForm(e); }
    if (t.matches('[data-inbox-resolve]')) { const e=getEntity(t.dataset.inboxResolve); closeModal(); if(e)return quickCaptureModal(e); }
    if (t.matches('[data-inbox-confirm-top]')) return confirmStoredInboxCandidate(t.dataset.inboxConfirmTop,0);
    if (t.matches('[data-capture-save-inbox]')) return saveQuickCaptureInbox();
    if (t.matches('[data-capture-choose]')) return saveResolvedCaptureCandidate(Number(t.dataset.captureChoose));
    if (t.matches('[data-capture-save-article]')) return saveResolvedCaptureArticle();
    if (t.matches('[data-open-capture-duplicate]')) { const e=getEntity(t.dataset.openCaptureDuplicate); closeModal(); if(e?.captureStatus==='inbox')return quickCaptureModal(e); if(e)return setView('detail',{entityId:e.id}); }
    if (t.matches('[data-family-review]')) { const e=getEntity(t.dataset.familyReview); if(e)return familyReviewModal(e); }
    if (t.matches('[data-smart-trip]')) { const e=getEntity(t.dataset.smartTrip); if(e){closeModal();return smartTripModal(e);} }
    if (t.matches('[data-decision-open]')) return decisionModal();
    if (t.matches('[data-edit-entity]')) return entityForm(getEntity(t.dataset.editEntity));
    if (t.matches('[data-refresh-place]')) { const e=getEntity(t.dataset.refreshPlace); if(e){toast('正在重新抓取封面…','',null,6000);const reset={...e,sourceCoverUrl:'',sourceCoverStatus:'',sourceCoverMethod:'',sourceCoverDomain:'',sourceCoverPageUrl:''};await TwinDB.put('entities',reset);await reloadData();await autoEnrichEntity(reset,{interactive:true});} return; }
    if (t.matches('[data-v44-auto-gate]')) { closeModal(); return runV44AutoGate(); }
    if (t.matches('[data-evidence-v2-acceptance]')) { closeModal(); return runEvidenceV2AcceptanceSuite(); }
    if (t.matches('[data-start-persistence-gate]')) return startPersistenceGate();
    if (t.matches('[data-auto-metadata]')) { const e=getEntity(t.dataset.autoMetadata); if(e){closeModal();toast('正在重新補地區與可確認的網路資料…','',null,6000);const r=await refreshEasyMetadata(e);const summary=[r.place==='updated'?'Google 地點／地區已更新':r.place==='identity-preserved-needs-confirmation'?'既有 Google 身分已保留，候選需確認':r.place==='needs-confirmation'?'Google 候選需確認':r.place==='not-found'?'Google 未找到可靠候選':'',r.evidence==='updated'?`Evidence V2 已查證（掃描 ${r.evidenceResult?.pagesScanned||0} 頁）`:r.evidence==='no_verified_evidence'?'Evidence V2 尚無可確認證據':'',r.source==='updated'?'原來源資料已更新':r.source==='metadata-only'?'原來源文字證據已讀取':r.source==='no-update'?'原來源無新增資料':''].filter(Boolean).join('；')||'沒有新的可確認資料';toast(summary,'',null,6500);const fresh=getEntity(e.id);if(fresh)entityForm(fresh);} return; }
    if (t.matches('[data-save-app-icon]')) { const file=$('#appIconSetting')?.files?.[0]; if(!file){toast('請先選擇圖片');return;} try{const value=await compressSquareIcon(file);await TwinDB.put('settings',{key:'appIconImage',value});await reloadData();closeModal();render();toast('頁首圖示已更新');}catch(_){toast('圖片無法讀取，請改用 JPG、PNG 或 WebP');}return; }
    if (t.matches('[data-reset-app-icon]')) { await TwinDB.put('settings',{key:'appIconImage',value:''});await reloadData();closeModal();render();toast('已恢復熊圖示');return; }
    if (t.matches('[data-trip-quick-type]')) { return quickAddStopModal(t.dataset.tripId,t.dataset.tripQuickType); }
    if (t.matches('[data-trip-quick-entity]')) { return quickAddEntityToTrip(t.dataset.tripId,t.dataset.tripQuickEntity); }
    if (t.matches('[data-trip-quick-simple]')) { return quickAddSimpleStop(t.dataset.tripId,t.dataset.tripQuickSimple); }
    if (t.matches('[data-reschedule-trip]')) { let trip=state.itineraries.find(x=>x.id===t.dataset.rescheduleTrip);if(!trip)return;trip=applyTripAutoTimeline(trip,{force:true});await TwinDB.put('itineraries',trip);await reloadData();render();toast('已依目前順序重新排時間；手動鎖定的時間會保留');return; }
    if (t.matches('[data-pack-adopt]')) { const id=String(t.dataset.packAdopt||'');await TwinDB.put('settings',{key:'packContextTripId',value:id});await reloadData();render();toast('已把目前勾選沿用到這趟行程');return; }
    if (t.matches('[data-pack-reset-for-trip]')) { const id=String(t.dataset.packResetForTrip||'');for(const item of state.packItems)await TwinDB.put('packState',{itemId:item.id,checked:false,updatedAt:new Date().toISOString()});await TwinDB.put('settings',{key:'packContextTripId',value:id});await reloadData();render();toast('已為這趟行程重置外出包');return; }
    if (t.matches('[data-choose-place]')) { const p=state.pendingPlaceMatch, idx=Number(t.dataset.choosePlace); const c=p?.candidates?.[idx]; if(p&&c) await savePlaceCandidate(p.entityId,c); return; }
    if (t.matches('[data-test-place-api]')) { const configured=await checkPlaceApi(); toast(configured?'Google Places API 已連線':'尚未設定或無法連線 Google Places API'); return; }
    if (t.matches('[data-batch-place]')) return batchEnrichPlaces();
    if (t.matches('[data-favorite]')) { ev.stopPropagation(); const e=getEntity(t.dataset.favorite); if(e){e.favorite=!e.favorite;e.updatedAt=new Date().toISOString();await TwinDB.put('entities',e);await reloadData();render();} return; }
    if (t.matches('[data-delete-entity]')) { const e=getEntity(t.dataset.deleteEntity); if(e&&confirm(`確定刪除「${e.name}」？`)){await TwinDB.remove('entities',e.id);await reloadData();closeModal();setView('explore');toast('已刪除');} return; }
    if (t.matches('[data-explore-type]')) { state.explore.type=t.dataset.exploreType||'attraction'; return render(); }
    if (t.matches('[data-theme-select]')) { state.explore.themeId=String(t.dataset.themeSelect||''); return render(); }
    if (t.matches('[data-theme-add]')) { closeModal(); return themeEditorModal(); }
    if (t.matches('[data-theme-manage]')) return themeManagerModal();
    if (t.matches('[data-theme-edit]')) { const id=String(t.dataset.themeEdit||'');closeModal();return themeEditorModal(id); }
    if (t.matches('[data-theme-delete]')) { const id=String(t.dataset.themeDelete||''),theme=exploreThemes().find(x=>x.id===id);if(theme&&confirm(`刪除主題「${theme.name}」？`)){await persistExploreThemes(exploreThemes().filter(x=>x.id!==id));if(state.explore.themeId===id)state.explore.themeId='';closeModal();render();toast('主題已刪除');}return; }
    if (t.matches('[data-clear-search]')) { state.explore.query=''; return render(); }
    if (t.matches('[data-clear-filters]')) { state.explore={query:'',type:'attraction',themeId:'',region:'',visited:'',indoor:'',ageOnly:false,nearby:false,userPos:null,favoriteOnly:false,sort:'recommended'}; geoFilter={macroRegion:'all',geoGroup:'all'}; return render(); }
    if (t.matches('[data-more-filters]')) return moreFiltersModal();
    if (t.matches('[data-reset-more]')) { state.explore={...state.explore,region:'',visited:'',indoor:'',ageOnly:false,nearby:false,userPos:null,favoriteOnly:false}; closeModal();return render(); }
    if (t.matches('[data-apply-more]')) { state.explore.visited=$('#fVisited').value;state.explore.indoor=$('#fIndoor').value;state.explore.favoriteOnly=!!$('#fFavorite')?.checked;closeModal();return render(); }
    if (t.matches('[data-indoor-filter]')) { state.explore.indoor=state.explore.indoor==='yes'?'':'yes';return render(); }
    if (t.matches('[data-favorite-filter]')) { state.explore.favoriteOnly=!state.explore.favoriteOnly;return render(); }
    if (t.matches('[data-age-filter]')) { if(currentAgeMonths()===null){settingsModal();toast('先在設定填寫雙寶生日');return;} state.explore.ageOnly=!state.explore.ageOnly;return render(); }
    if (t.matches('[data-paste-capture]')) { try{const txt=await navigator.clipboard.readText();if(txt)$('#quickCaptureUrl').value=txt.trim();}catch{toast('無法讀取剪貼簿，請直接貼上網址');}return; }
    if (t.matches('[data-decision-run]')) { syncDecisionFromModal(); const root=$('#decisionResults'); if(root){root.innerHTML=decisionResultsHtml();hydratePlaceImages();} return; }
    if (t.matches('[data-decision-location]')) { if(!navigator.geolocation){toast('此裝置不支援定位');return;} syncDecisionFromModal(); navigator.geolocation.getCurrentPosition(pos=>{state.decision.userPos={lat:pos.coords.latitude,lng:pos.coords.longitude};const root=$('#decisionResults');if(root){root.innerHTML=decisionResultsHtml();hydratePlaceImages();}toast('已套用目前位置');},()=>toast('無法取得定位，請檢查權限'));return; }
    if (t.matches('[data-open-decision-entity]')) { const id=t.dataset.openDecisionEntity;closeModal();return setView('detail',{entityId:id}); }
    if (t.matches('[data-use-backup]')) { const trip=state.itineraries.find(x=>x.id===state.selectedTripId),s=trip?.stops?.find(x=>x.id===t.dataset.useBackup);if(!trip||!s)return;const backup=backupPlaceObj(s);if(!backup)return;const oldEntityId=s.entityId||'',oldExternal=s.externalPlace||null,oldExternalEvidence=s.externalEvidence||null;if(s.backupEntityId){s.entityId=s.backupEntityId;s.externalPlace=null;s.externalEvidence=null;s.type=getEntity(s.entityId)?.entityType||s.type;}else{s.entityId='';s.externalPlace=externalPlaceShape(s.backupExternalPlace);s.externalEvidence=s.backupExternalEvidence||null;}s.backupEntityId=oldEntityId;s.backupExternalPlace=oldExternal;s.backupExternalEvidence=oldExternalEvidence;s.updatedAt=new Date().toISOString();trip.updatedAt=new Date().toISOString();await TwinDB.put('itineraries',trip);await reloadData();render();toast('已切換 Plan B；原站點保留為備案');return; }
    if (t.matches('[data-plan-b-search]')) { const trip=state.itineraries.find(x=>x.id===state.selectedTripId)||state.itineraries.find(x=>(x.stops||[]).some(s=>s.id===t.dataset.planBSearch));if(trip)return planBModal(trip.id,t.dataset.planBSearch);return; }
    if (t.matches('[data-plan-b-nearby]')) return runPlanBNearbySearch(t.dataset.tripId,t.dataset.planBNearby);
    if (t.matches('[data-plan-b-text]')) return planBTextSearchModal(t.dataset.tripId,t.dataset.planBText);
    if (t.matches('[data-plan-b-saved]')) return setSavedPlanB(t.dataset.tripId,t.dataset.stopId,t.dataset.planBSaved);
    if (t.matches('[data-plan-b-google]')) { const c=state.planBGoogleCandidates?.[Number(t.dataset.planBGoogle)];if(c)return setGooglePlanB(t.dataset.tripId,t.dataset.stopId,c);return; }
    if (t.matches('[data-complete-stop]')) { const trip=state.itineraries.find(x=>x.id===state.selectedTripId),s=trip?.stops?.find(x=>x.id===t.dataset.completeStop);if(!trip||!s)return;const sid=s.id;s.done=true;s.completedAt=new Date().toISOString();trip.updatedAt=new Date().toISOString();await TwinDB.put('itineraries',trip);await reloadData();render();toast('已完成這一站','復原',async()=>{const fresh=await TwinDB.get('itineraries',trip.id),row=fresh?.stops?.find(x=>x.id===sid);if(!fresh||!row)return;row.done=false;row.completedAt='';fresh.updatedAt=new Date().toISOString();await TwinDB.put('itineraries',fresh);await reloadData();render();toast('已復原');},6000);return; }
    if (t.matches('[data-nearby]')) { if(!navigator.geolocation){toast('此裝置不支援定位');return;} navigator.geolocation.getCurrentPosition(pos=>{state.explore.userPos={lat:pos.coords.latitude,lng:pos.coords.longitude};state.explore.nearby=true;render();},()=>toast('無法取得定位，請檢查瀏覽器權限')); return; }
    if (t.matches('[data-new-trip]')) return tripForm();
    if (t.matches('[data-edit-trip]')) return tripForm(state.itineraries.find(x=>x.id===t.dataset.editTrip));
    if (t.matches('[data-delete-trip]')) { const trip=state.itineraries.find(x=>x.id===t.dataset.deleteTrip); if(trip&&confirm(`刪除行程「${trip.title}」？`)){await TwinDB.remove('itineraries',trip.id);await reloadData();closeModal();state.selectedTripId=null;render();toast('行程已刪除');}return; }
    if (t.matches('[data-add-stop]')) return addStopForm(t.dataset.addStop);
    if (t.matches('[data-edit-stop]')) { const trip=state.itineraries.find(x=>x.id===state.selectedTripId);const s=trip?.stops?.find(x=>x.id===t.dataset.editStop);if(s)return addStopForm(trip.id,s); }
    if (t.matches('[data-delete-stop]')) { const trip=state.itineraries.find(x=>x.id===state.selectedTripId);if(trip){trip.stops=(trip.stops||[]).filter(x=>x.id!==t.dataset.deleteStop).map((x,i)=>({...x,order:i+1}));trip.scheduleDirty=true;trip.updatedAt=new Date().toISOString();await TwinDB.put('itineraries',trip);await reloadData();closeModal();render();toast('站點已刪除；可重新排時間');}return; }
    if (t.matches('[data-add-to-trip]')) return pickTripForEntity(t.dataset.addToTrip);
    if (t.matches('[data-pick-trip]')) return addEntityToTrip(t.dataset.pickTrip,t.dataset.entity);
    if (t.matches('[data-create-trip-for-entity]')) { const entityId=t.dataset.createTripForEntity;closeModal();tripForm();toast(`建立行程後，可再加入「${getEntity(entityId)?.name||''}」`);return; }
    if (t.matches('[data-nav-url]')) { const url=t.dataset.navUrl;if(url)window.open(url,'_blank','noopener');return; }
    if (t.matches('[data-nav-next]')) { const trip=state.itineraries.find(x=>x.id===t.dataset.navNext),s=nextStop(trip),p=stopPlaceObj(s),url=placeMapsUrl(p); if(url)window.open(url,'_blank','noopener');else toast('下一站尚未有可用地圖資料');return; }
    if (t.matches('[data-pack-edit]')) { state.packEdit=!state.packEdit;return render(); }
    if (t.matches('[data-pack-menu]')) return packMenu();
    if (t.matches('[data-add-pack]')) return packItemForm();
    if (t.matches('[data-delete-pack]')) { const item=state.packItems.find(x=>x.id===t.dataset.deletePack), ps=state.packState.find(x=>x.itemId===item?.id);if(!item)return;state.deletedPack={item,ps};await TwinDB.remove('packItems',item.id);await TwinDB.remove('packState',item.id);await reloadData();render();toast('已刪除','復原',async()=>{if(state.deletedPack){await TwinDB.put('packItems',state.deletedPack.item);if(state.deletedPack.ps)await TwinDB.put('packState',state.deletedPack.ps);state.deletedPack=null;await reloadData();render();toast('已復原');}},5000);return; }
    if (t.matches('[data-reset-pack]')) { for(const item of state.packItems) await TwinDB.put('packState',{itemId:item.id,checked:false,updatedAt:new Date().toISOString()});const trip=getUpcomingTrip();if(trip)await TwinDB.put('settings',{key:'packContextTripId',value:trip.id});await reloadData();closeModal();render();toast('外出包已全部重置');return; }
    if (t.matches('[data-cloud-login]')) { try{await TwinCloudSync.signInWithGoogle();}catch(err){toast(`Google 登入啟動失敗：${err.message||err}`);}return; }
    if (t.matches('[data-cloud-bootstrap]')) { try{const r=await TwinCloudSync.bootstrap();await reloadData();render();settingsModal();toast(r.initialized?`Cloud Sync 初始化完成｜pull ${r.pulled} / push ${r.pushed}`:'Cloud Sync 已初始化');}catch(err){toast(`Cloud Sync 初始化失敗：${err.message||err}`,'',null,8000);}return; }
    if (t.matches('[data-cloud-sync]')) { try{const r=await cloudSyncAndRefresh();settingsModal();toast(`同步完成｜pull ${r.pulled||0} / push ${r.pushed||0} / delete ${r.deleted||0}`);}catch(err){toast(`同步停止：${err.message||err}`,'',null,9000);}return; }
    if (t.matches('[data-cloud-gate]')) { try{const rows=await TwinCloudSync.cloudGate();const fail=rows.some(x=>x.status==='FAIL'),wait=rows.some(x=>x.status==='WAIT');showModal('V4.5 Cloud Sync Gate',`<div class="setting-block acceptance-gate ${fail?'fail':wait?'':'pass'}"><h3>${fail?'CLOUD GATE FAIL':wait?'CLOUD GATE WAIT':'CLOUD GATE PASS'}</h3>${rows.map(x=>`<p><strong>${esc(x.id)}</strong>｜${esc(x.status)}｜${esc(x.detail||'')}</p>`).join('')}</div>`);}catch(err){toast(`Cloud Gate 失敗：${err.message||err}`,'',null,8000);}return; }
    if (t.matches('[data-cloud-signout]')) { try{await TwinCloudSync.signOut();settingsModal();toast('已登出 Cloud Sync');}catch(err){toast(`登出失敗：${err.message||err}`);}return; }
    if (t.matches('[data-export-json]')) { closeModal(); return exportJson(); }
    if (t.matches('[data-import-json]')) { closeModal(); importInput.click(); return; }
    if (t.matches('[data-save-app-title]')) { const value=String($('#appTitleSetting')?.value||'').trim().slice(0,20)||'雙寶出遊';await TwinDB.put('settings',{key:'appTitle',value});await reloadData();closeModal();render();toast('App 顯示名稱已更新');return; }
    if (t.matches('[data-save-birthdate]')) { await TwinDB.put('settings',{key:'childBirthdate',value:$('#birthdateSetting').value});await reloadData();closeModal();render();toast('生日已儲存');return; }
  });

  document.addEventListener('change', async ev=>{
    const el=ev.target;
    if(el.matches('#exploreSort')){ state.explore.sort=el.value||'recommended'; return render(); }
    if (el.matches('[data-pack-check]')) { await TwinDB.put('packState',{itemId:el.dataset.packCheck,checked:el.checked,updatedAt:new Date().toISOString()});const trip=getUpcomingTrip();if(trip)await TwinDB.put('settings',{key:'packContextTripId',value:trip.id});await reloadData();render(); }
  });

  modalRoot.addEventListener('click',ev=>{if(ev.target===modalRoot)closeModal();});
  settingsBtn.addEventListener('click',settingsModal);
  importInput.addEventListener('change',async()=>{const file=importInput.files?.[0];if(!file)return;try{await importJsonFile(file);}catch(err){toast(`匯入失敗：${err.message}`);}finally{importInput.value='';}});
  window.addEventListener('online',()=>{render();scheduleInboxAutomation(100);}); window.addEventListener('offline',render);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible') scheduleInboxAutomation(50);});
  window.addEventListener('pageshow',()=>scheduleInboxAutomation(50));

  async function init() {
    try {
      await ensureSeeded(); await reloadData(); const persistenceResult=await finalizePersistenceGateIfPending(); render(); scheduleInboxAutomation(150); if(persistenceResult)toast(`Persistence Gate ${persistenceResult.status}`, '', null, 7000);
      if(window.TwinCloudSync){TwinCloudSync.getStatus().then(async st=>{if(!st.authenticated)return;try{await cloudSyncAndRefresh();await TwinCloudSync.subscribe(()=>{setTimeout(()=>cloudSyncAndRefresh().catch(()=>{}),250);});}catch(err){console.warn('Cloud sync startup:',err);}}).catch(()=>{});}
      if ('serviceWorker' in navigator) {
        let reloading = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (reloading) return;
          reloading = true;
          location.reload();
        });
        navigator.serviceWorker.register('./sw.js?v=4.5.0-phase1.2', { updateViaCache:'none' })
          .then(reg => reg.update().catch(()=>{}))
          .catch(()=>{});
      }
    } catch (err) {
      console.error(err); app.innerHTML=`<div class="empty-state"><div class="empty-icon">⚠️</div><h3>啟動失敗</h3><p>${esc(err.message)}</p><button class="btn" onclick="location.reload()">重新載入</button></div>`;
    }
  }
  init();

  document.addEventListener('click',(ev)=>{
    const btn=ev.target?.closest?.('[data-source-manager-id]');
    if(!btn) return;
    const e=state.entities.find(x=>x.id===btn.dataset.sourceManagerId);
    if(e) openSourceManager(e);
  }); // data-source-manager-init


  document.addEventListener('click',(ev)=>{
    const m=ev.target?.closest?.('[data-geo-macro]');
    if(m){
      geoFilter={macroRegion:m.dataset.geoMacro,geoGroup:'all'};
      render();
      return;
    }
    const g=ev.target?.closest?.('[data-geo-group]');
    if(g){
      geoFilter={...geoFilter,geoGroup:g.dataset.geoGroup};
      render();
    }
  }); // data-geo-filter-init

})();
