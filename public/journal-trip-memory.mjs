
import journalBinding from './journal-browser.mjs';
import journalShell from './journal-shell.mjs';
import { yearlySourceSnapshot } from './journal-yearly.mjs';

const PHOTO_PAGE_SIZE=8;
const MAX_TRIP_MEDIA=120;
const state={open:false,loading:false,error:'',model:null,groups:[],visiblePhotos:0,signed:new Map(),mode:'memory'};

function clean(v=''){return String(v??'').normalize('NFKC').trim().replace(/\s+/g,' ');}
function dateOnly(v=''){const s=String(v||'');return /^\d{4}-\d{2}-\d{2}/.test(s)?s.slice(0,10):'';}
function esc(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function fmtMinutes(v){const n=Math.max(0,Math.round(Number(v)||0));if(!n)return '';const h=Math.floor(n/60),m=n%60;return h?(m?(h+' 小時 '+m+' 分'):(h+' 小時')):(m+' 分');}
function fmtDistance(v){const n=Math.max(0,Number(v)||0);if(!n)return '';return n>=1000?((n/1000).toFixed(n>=10000?0:1)+' km'):(Math.round(n)+' m');}
function entryTitle(e={}){return clean(e.title)||clean(e.summary).slice(0,36)||'旅遊日誌';}

export function buildTripMemoryGroups(entries=[]){
  const map=new Map();
  for(const e of Array.isArray(entries)?entries:[]){
    if(!e?.id||e.deleted_at)continue;
    const date=dateOnly(e.entry_date),tripRef=clean(e.trip_ref);
    if(!date&&!tripRef)continue;
    const key=tripRef?('trip:'+tripRef):('date:'+date);
    if(!map.has(key))map.set(key,{key,tripRef:tripRef||null,date,entries:[]});
    const g=map.get(key);g.entries.push(e);if(!g.date&&date)g.date=date;
  }
  return [...map.values()].map(g=>({
    ...g,
    entryIds:g.entries.map(e=>String(e.id)),
    entryCount:g.entries.length,
    title:entryTitle(g.entries[0]||{})
  })).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))||a.title.localeCompare(b.title,'zh-TW'));
}

function normalizeMedia(media=[]){
  return (Array.isArray(media)?media:[])
    .filter(m=>m?.upload_state==='ready'&&!m?.deleted_at&&m?.storage_path)
    .map(m=>({
      id:String(m.id||''),entryId:String(m.entry_id||''),storagePath:String(m.storage_path||''),
      caption:clean(m.caption),takenAt:String(m.taken_at||m.created_at||''),sortOrder:Number(m.sort_order)||0
    }))
    .sort((a,b)=>a.takenAt.localeCompare(b.takenAt)||a.sortOrder-b.sortOrder||a.id.localeCompare(b.id));
}

export function buildTripMemoryModel({trip=null,entries=[],media=[]}={}){
  const rows=(Array.isArray(entries)?entries:[]).filter(e=>e&&!e.deleted_at)
    .sort((a,b)=>String(a.entry_date||'').localeCompare(String(b.entry_date||''))||String(a.created_at||'').localeCompare(String(b.created_at||'')));
  const date=dateOnly(trip?.date)||dateOnly(rows[0]?.entry_date);
  const route=trip?.routePlan?.actual||trip?.routePlan?.current||null;
  const schedule=trip?.schedulePlan||null;
  const stops=(Array.isArray(trip?.stops)?trip.stops:[]).map((s,i)=>({
    index:i,title:clean(s.title)||('地點 '+(i+1)),address:clean(s.address),
    plannedTime:clean(s.plannedTime),durationMinutes:Number(s.plannedDurationMinutes)||null,
    latitude:Number.isFinite(Number(s.latitude))?Number(s.latitude):null,
    longitude:Number.isFinite(Number(s.longitude))?Number(s.longitude):null,
    placeId:clean(s.placeId)||null,googleMapsUrl:/^https:\/\//i.test(clean(s.googleMapsUrl))?clean(s.googleMapsUrl):''
  }));
  const photos=normalizeMedia(media);
  return {
    tripId:trip?.id?String(trip.id):null,
    tripRef:clean(rows.find(e=>e?.trip_ref)?.trip_ref)||trip?.id||null,
    date,title:clean(trip?.title)||entryTitle(rows[0]||{})||'旅程回憶',
    origin:trip?.origin||null,destination:trip?.destination||null,stops,
    route,schedule,
    roadMinutes:route?Math.ceil((Number(route.totalDurationSeconds)||0)/60):0,
    roadDistanceMeters:route?Number(route.totalDistanceMeters)||0:0,
    totalMinutes:Number(schedule?.totalMinutes)||0,
    returnTime:clean(schedule?.returnTime),
    journals:rows.map(e=>({
      id:String(e.id),date:dateOnly(e.entry_date),title:entryTitle(e),
      summary:clean(e.summary),participants:Array.isArray(e.participants)?e.participants.map(String):[],
      tags:Array.isArray(e.tags)?e.tags.map(String):[]
    })),
    photos
  };
}

async function loadTrip(tripRef,date){
  if(!globalThis.TwinDB)return null;
  if(tripRef){
    const exact=await TwinDB.get('itineraries',tripRef).catch(()=>null);
    if(exact)return exact;
  }
  const rows=await TwinDB.getAll('itineraries').catch(()=>[]);
  const sameDate=(Array.isArray(rows)?rows:[]).filter(t=>t?.model==='itinerary-v2'&&dateOnly(t?.date)===date);
  if(!sameDate.length)return null;
  if(tripRef){
    const byId=sameDate.find(t=>String(t.id||'')===String(tripRef));
    if(byId)return byId;
  }
  return sameDate[0]||null;
}

async function loadEntriesFor({entryId=null,groupKey=null}={}){
  if(entryId){
    const detail=await journalBinding.getEntry(entryId,{includeRevisions:false});
    const base=detail?.entry;
    if(!base)return {entries:[],base:null};
    const tripRef=clean(base.trip_ref),date=dateOnly(base.entry_date);
    const entries=tripRef
      ? await journalBinding.listEntries({tripRef,includeArchived:false,limit:100})
      : await journalBinding.listEntries({from:date,to:date,includeArchived:false,limit:100});
    return {entries,base};
  }
  const snap=yearlySourceSnapshot(),groups=buildTripMemoryGroups(snap.entries);
  const group=groups.find(g=>g.key===groupKey);
  if(!group)return {entries:[],base:null};
  return {entries:group.entries,base:group.entries[0]||null};
}

async function loadModel(opts={}){
  await journalBinding.init();
  const status=await journalBinding.getStatus();
  if(!status?.originMatch)throw new Error('Preview 只驗收單次旅程回憶介面；正式站登入後才讀取家庭資料。');
  if(!status?.authenticated)throw new Error('請先登入家庭雲端，再開啟旅程回憶。');
  const loaded=await loadEntriesFor(opts);
  if(!loaded.entries.length)throw new Error('找不到這趟旅程的日誌。');
  const tripRef=clean(loaded.base?.trip_ref),date=dateOnly(loaded.base?.entry_date);
  const trip=await loadTrip(tripRef,date);
  const ids=loaded.entries.map(e=>String(e.id||'')).filter(Boolean);
  const media=await journalBinding.listMediaForEntries(ids,{limit:MAX_TRIP_MEDIA});
  return buildTripMemoryModel({trip,entries:loaded.entries,media});
}

function overlay(){
  let el=document.getElementById('journalTripMemory');
  if(!el&&typeof document!=='undefined'){
    el=document.createElement('div');el.id='journalTripMemory';el.className='journal-trip-memory';el.hidden=true;document.body.appendChild(el);
  }
  return el;
}

function routeHtml(m){
  if(!m.stops.length)return '<div class="trip-memory-empty">這趟沒有保存行程路線。</div>';
  const legs=Array.isArray(m.route?.legs)?m.route.legs:[];
  const rows=[];
  if(m.origin?.label||m.origin?.address)rows.push('<div class="trip-memory-route-point fixed"><span>出發</span><strong>'+esc(m.origin?.label||'出發地')+'</strong><small>'+esc(m.origin?.address||'')+'</small></div>');
  m.stops.forEach((stop,i)=>{
    const leg=legs[i]||null;
    if(leg)rows.push('<div class="trip-memory-leg">🚗 '+esc(fmtMinutes((Number(leg.durationSeconds)||0)/60))+(leg.distanceMeters?'・'+esc(fmtDistance(leg.distanceMeters)):'')+'</div>');
    rows.push('<div class="trip-memory-route-point"><span>'+(i+1)+'</span><div><strong>'+esc(stop.title)+'</strong>'+(stop.plannedTime?'<small>'+esc(stop.plannedTime)+' 到達'+(stop.durationMinutes?'・停留 '+esc(fmtMinutes(stop.durationMinutes)):'')+'</small>':'')+(stop.address?'<small>'+esc(stop.address)+'</small>':'')+'</div></div>');
  });
  const backLeg=legs[m.stops.length]||null;
  if(backLeg)rows.push('<div class="trip-memory-leg">🚗 '+esc(fmtMinutes((Number(backLeg.durationSeconds)||0)/60))+(backLeg.distanceMeters?'・'+esc(fmtDistance(backLeg.distanceMeters)):'')+'</div>');
  if(m.destination?.label||m.returnTime)rows.push('<div class="trip-memory-route-point fixed"><span>終點</span><strong>'+esc(m.destination?.label||'回程')+'</strong><small>'+(m.returnTime?'預計 '+esc(m.returnTime)+' 抵達':'')+'</small></div>');
  return '<div class="trip-memory-route">'+rows.join('')+'</div>';
}

function journalHtml(m){
  if(!m.journals.length)return '<div class="trip-memory-empty">這趟沒有日誌。</div>';
  return '<div class="trip-memory-journals">'+m.journals.map(j=>'<button type="button" data-trip-memory-entry="'+esc(j.id)+'"><small>'+esc(j.date)+'</small><strong>'+esc(j.title)+'</strong>'+(j.summary?'<p>'+esc(j.summary)+'</p>':'')+'</button>').join('')+'</div>';
}

function photoHtml(m){
  if(!m.photos.length)return '<div class="trip-memory-empty">這趟還沒有照片。</div>';
  const rows=m.photos.slice(0,state.visiblePhotos);
  const cards=rows.map(p=>{
    const url=state.signed.get(p.storagePath)||'';
    return '<figure>'+(url?'<img src="'+esc(url)+'" alt="'+esc(p.caption||m.title)+'" loading="lazy" decoding="async">':'<div class="trip-memory-photo-placeholder">照片準備中</div>')+(p.caption?'<figcaption>'+esc(p.caption)+'</figcaption>':'')+'</figure>';
  }).join('');
  const more=state.visiblePhotos<m.photos.length?'<button type="button" class="journal-secondary" data-trip-memory-more>再看 '+Math.min(PHOTO_PAGE_SIZE,m.photos.length-state.visiblePhotos)+' 張</button>':'';
  return '<div class="trip-memory-photo-grid">'+cards+'</div><div class="trip-memory-more">'+more+'</div>';
}

function selectorHtml(){
  if(!state.groups.length)return '<div class="trip-memory-empty">這一年沒有可整理成旅程回憶的日誌。</div>';
  return '<div class="trip-memory-select">'+state.groups.map(g=>'<button type="button" data-trip-memory-group="'+esc(g.key)+'"><span>'+esc(g.date||'日期未設定')+'</span><strong>'+esc(g.title)+'</strong><small>'+g.entryCount+' 篇日誌'+(g.tripRef?'・已連行程':'・日期回憶')+'</small></button>').join('')+'</div>';
}

function metricsHtml(m){const items=[[m.stops.length,'景點'],[m.journals.length,'日誌'],[m.photos.length,'照片'],[m.roadMinutes?fmtMinutes(m.roadMinutes):'—','道路移動']];return '<div class="trip-memory-metrics">'+items.map(x=>'<div><b>'+esc(x[0])+'</b><span>'+esc(x[1])+'</span></div>').join('')+'</div>';}
