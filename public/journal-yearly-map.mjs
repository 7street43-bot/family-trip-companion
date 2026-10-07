import journalShell from './journal-shell.mjs';
import { yearlySourceSnapshot } from './journal-yearly.mjs';

const CACHE_KEY='journalFootprintGeoV1';
const CACHE_TTL_MS=30*24*60*60*1000;
const MAX_REMOTE_RESOLVE=12;
const LEAFLET_JS='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const OSM_TILE='https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const state={year:null,places:[],resolved:[],unresolved:[],loading:false,error:'',map:null,leafletPromise:null,mounted:false};

function clean(v=''){return String(v||'').normalize('NFKC').trim().replace(/\s+/g,' ');}
function keyOf(v=''){return clean(v).toLocaleLowerCase('zh-TW');}
function dateOnly(v=''){const s=String(v||'');return /^\d{4}-\d{2}-\d{2}/.test(s)?s.slice(0,10):'';}
function finite(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function esc(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function entryTitle(e={}){return clean(e.title)||clean(e.summary).slice(0,36)||'旅遊日誌';}
function placeTags(e={}){return [...new Set((Array.isArray(e.tags)?e.tags:[]).map(String).filter(x=>x.startsWith('@place:')).map(x=>clean(x.slice(7))).filter(Boolean))];}

export function buildFootprintPlaces(entries=[]){
  const map=new Map();
  for(const e of Array.isArray(entries)?entries:[]){
    if(!e?.id||e.deleted_at)continue;
    for(const name of placeTags(e)){
      const key=keyOf(name);
      if(!key)continue;
      if(!map.has(key))map.set(key,{key,name,visits:[]});
      map.get(key).visits.push({entryId:String(e.id),date:dateOnly(e.entry_date),title:entryTitle(e)});
    }
  }
  return [...map.values()].map(row=>({
    ...row,
    visits:row.visits.sort((a,b)=>a.date.localeCompare(b.date)||a.title.localeCompare(b.title,'zh-TW'))
  })).sort((a,b)=>b.visits.length-a.visits.length||a.name.localeCompare(b.name,'zh-TW'));
}

function locationRow(name,row={},source='known'){
  const latitude=finite(row.latitude),longitude=finite(row.longitude);
  if(latitude===null||longitude===null)return null;
  const rawUrl=clean(row.googleMapsUrl||row.googleMapsUri);
  return {
    name:clean(name||row.name||row.title||row.label),
    latitude,longitude,
    placeId:clean(row.placeId||row.place_id)||null,
    address:clean(row.address||row.formattedAddress)||'',
    googleMapsUrl:/^https:\/\//i.test(rawUrl)?rawUrl:'',
    source
  };
}

export function buildKnownLocationIndex(entities=[],itineraries=[]){
  const out=new Map();
  const add=(name,row,source)=>{
    const k=keyOf(name);if(!k||out.has(k))return;
    const loc=locationRow(name,row,source);if(loc)out.set(k,loc);
  };
  for(const e of Array.isArray(entities)?entities:[])add(e?.name||e?.title,e,'entity');
  for(const trip of Array.isArray(itineraries)?itineraries:[]){
    add(trip?.origin?.label,trip?.origin,'trip-origin');
    add(trip?.destination?.label,trip?.destination,'trip-destination');
    for(const stop of Array.isArray(trip?.stops)?trip.stops:[])add(stop?.title||stop?.label,stop,'trip-stop');
  }
  return out;
}

export function mergeFootprintResolution(places=[],knownIndex=new Map(),cache={}){
  const resolved=[],unresolved=[];
  for(const place of Array.isArray(places)?places:[]){
    const known=knownIndex.get(place.key)||cache?.[place.key]?.location||null;
    const loc=known?locationRow(place.name,known,known.source||'cache'):null;
    if(loc)resolved.push({...place,...loc});
    else unresolved.push(place);
  }
  return {resolved,unresolved};
}

function readCache(now=Date.now()){
  try{
    const raw=JSON.parse(localStorage.getItem(CACHE_KEY)||'{}');
    const rows=raw&&typeof raw==='object'?raw:{};
    const fresh={};
    for(const [k,v] of Object.entries(rows)){
      const saved=Number(v?.savedAt)||0;
      if(now-saved<=CACHE_TTL_MS&&v?.location)fresh[k]=v;
    }
    return fresh;
  }catch{return {};}
}
function writeCache(rows){
  try{localStorage.setItem(CACHE_KEY,JSON.stringify(rows));}catch{}
}

async function loadKnownLocations(){
  if(!globalThis.TwinDB)return new Map();
  try{
    const [entities,itineraries]=await Promise.all([TwinDB.getAll('entities'),TwinDB.getAll('itineraries')]);
    return buildKnownLocationIndex(entities,itineraries);
  }catch{return new Map();}
}

async function resolveRemote(place){
  const res=await fetch('/api/itinerary-origin-search',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({query:place.name})
  });
  if(!res.ok)throw new Error('place_resolve_failed');
  const data=await res.json();
  const row=Array.isArray(data?.candidates)?data.candidates[0]:null;
  return row?locationRow(place.name,row,'google-places'):null;
}

async function resolvePlaces(places=[]){
  const cache=readCache(),known=await loadKnownLocations();
  let {resolved,unresolved}=mergeFootprintResolution(places,known,cache);
  const batch=unresolved.slice(0,MAX_REMOTE_RESOLVE),newCache={...cache};
  for(const place of batch){
    try{
      const loc=await resolveRemote(place);
      if(loc){
        resolved.push({...place,...loc});
        newCache[place.key]={savedAt:Date.now(),location:loc};
      }
    }catch{}
  }
  writeCache(newCache);
  const resolvedKeys=new Set(resolved.map(x=>x.key));
  unresolved=places.filter(x=>!resolvedKeys.has(x.key));
  resolved.sort((a,b)=>b.visits.length-a.visits.length||a.name.localeCompare(b.name,'zh-TW'));
  return {resolved,unresolved};
}

function ensureLeaflet(){
  if(globalThis.L?.map)return Promise.resolve(globalThis.L);
  if(state.leafletPromise)return state.leafletPromise;
  state.leafletPromise=new Promise((resolve,reject)=>{
    if(typeof document==='undefined')return reject(new Error('leaflet_document_unavailable'));
    if(!document.querySelector('link[data-leaflet-footprint]')){
      const link=document.createElement('link');
      link.rel='stylesheet';link.href=LEAFLET_CSS;link.dataset.leafletFootprint='1';
      document.head.appendChild(link);
    }
    const existing=document.querySelector('script[data-leaflet-footprint]');
    if(existing){
      existing.addEventListener('load',()=>globalThis.L?.map?resolve(globalThis.L):reject(new Error('leaflet_missing')),{once:true});
      existing.addEventListener('error',()=>reject(new Error('leaflet_load_failed')),{once:true});
      return;
    }
    const script=document.createElement('script');
    script.src=LEAFLET_JS;script.async=true;script.dataset.leafletFootprint='1';
    script.addEventListener('load',()=>globalThis.L?.map?resolve(globalThis.L):reject(new Error('leaflet_missing')),{once:true});
    script.addEventListener('error',()=>reject(new Error('leaflet_load_failed')),{once:true});
    document.head.appendChild(script);
  }).catch(err=>{state.leafletPromise=null;throw err;});
  return state.leafletPromise;
}

function overlay(){
  let el=document.getElementById('journalYearMap');
  if(!el&&typeof document!=='undefined'){
    el=document.createElement('div');
    el.id='journalYearMap';el.className='journal-map-overlay';el.hidden=true;
    document.body.appendChild(el);
  }
  return el;
}

function statusHtml(){
  if(state.loading)return '<div class="journal-map-status">正在整理年度足跡…</div>';
  if(state.error)return `<div class="journal-map-error"><p>${esc(state.error)}</p><button type="button" data-footprint-close>關閉</button></div>`;
  if(!state.resolved.length)return '<div class="journal-map-status">這一年沒有可定位的足跡。</div>';
  return '';
}

function mapShellHtml(){
  const resolved=state.resolved.length,unresolved=state.unresolved.length,total=state.places.length;
  return `<section class="journal-map-panel"><div class="journal-map-head"><div><h2>${esc(state.year)} 年度足跡地圖</h2><small>${resolved} / ${total} 個地點已定位${unresolved?`｜${unresolved} 個待確認`:''}</small></div><button type="button" data-footprint-close>關閉</button></div><div id="journalFootprintMap" class="journal-footprint-map" aria-label="${esc(state.year)} 年度旅遊足跡地圖"></div>${unresolved?`<details class="journal-map-unresolved"><summary>查看 ${unresolved} 個尚未定位地點</summary><div>${state.unresolved.map(x=>`<span>${esc(x.name)}</span>`).join('')}</div></details>`:''}<small class="journal-map-note">地圖只在你開啟時載入；點足跡可查看日期並回到該篇日誌。</small></section>`;
}

function markerPopup(place){
  const visits=place.visits.slice(0,6);
  const more=place.visits.length-visits.length;
  return `<div class="journal-map-popup"><strong>${esc(place.name)}</strong>${place.address?`<small>${esc(place.address)}</small>`:''}<div class="journal-map-popup-visits">${visits.map(v=>`<button type="button" data-footprint-entry="${esc(v.entryId)}"><span>${esc(v.date||'日期未設定')}</span><b>${esc(v.title)}</b></button>`).join('')}${more>0?`<small>另有 ${more} 筆紀錄</small>`:''}</div>${place.googleMapsUrl?`<a href="${esc(place.googleMapsUrl)}" target="_blank" rel="noopener noreferrer">在 Google Maps 開啟</a>`:''}</div>`;
}

function renderLeaflet(L){
  state.map?.remove?.();state.map=null;
  const host=document.getElementById('journalFootprintMap');if(!host||!state.resolved.length)return;
  const map=L.map(host,{zoomControl:true,attributionControl:true});
  state.map=map;
  L.tileLayer(OSM_TILE,{
    maxZoom:19,
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
  }).addTo(map);
  const latlngs=[];
  for(const place of state.resolved){
    const latlng=[place.latitude,place.longitude];latlngs.push(latlng);
    const marker=L.circleMarker(latlng,{
      radius:Math.min(13,7+Math.log2(Math.max(1,place.visits.length))*2),
      weight:2,fillOpacity:.82
    }).addTo(map);
    marker.bindPopup(markerPopup(place),{maxWidth:320,minWidth:210});
  }
  if(latlngs.length===1)map.setView(latlngs[0],12);
  else map.fitBounds(L.latLngBounds(latlngs),{padding:[32,32],maxZoom:12});
  setTimeout(()=>map.invalidateSize(),0);
}

function render(){
  const el=overlay();if(!el)return;
  el.hidden=false;
  if(state.loading||state.error||!state.resolved.length){el.innerHTML=statusHtml();return;}
  el.innerHTML=mapShellHtml();
  ensureLeaflet().then(renderLeaflet).catch(err=>{state.error='地圖元件載入失敗，請稍後再試。';render();console.error(err);});
}

function closeMap(){
  state.map?.remove?.();state.map=null;state.error='';state.loading=false;
  const el=overlay();if(el){el.hidden=true;el.innerHTML='';}
  document?.body?.classList?.remove('journal-map-open');
}

export async function openYearFootprintMap(){
  const snap=yearlySourceSnapshot(),entries=Array.isArray(snap.entries)?snap.entries:[];
  state.year=Number(snap.year);state.places=buildFootprintPlaces(entries);state.resolved=[];state.unresolved=[];state.error='';state.loading=true;
  document?.body?.classList?.add('journal-map-open');render();
  try{
    if(!entries.length)throw new Error('請先產生該年度回顧，再開啟足跡地圖。');
    if(!state.places.length)throw new Error('這一年日誌還沒有填寫地點。');
    const result=await resolvePlaces(state.places);
    state.resolved=result.resolved;state.unresolved=result.unresolved;state.loading=false;render();
  }catch(err){state.loading=false;state.error=String(err?.message||err||'年度足跡載入失敗。');render();}
}

function mount(){
  if(state.mounted)return;state.mounted=true;
  document.addEventListener('click',ev=>{
    const t=ev.target.closest?.('[data-footprint-close],[data-footprint-entry]');if(!t)return;
    if(t.matches('[data-footprint-close]'))return closeMap();
    const id=t.dataset.footprintEntry;
    if(id){closeMap();journalShell.openEntry(id).catch(err=>console.error('open journal entry failed',err));}
  });
  document.addEventListener('keydown',ev=>{if(ev.key==='Escape'&&overlay()?.hidden===false)closeMap();});
}
if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();}

export const __test={CACHE_KEY,CACHE_TTL_MS,MAX_REMOTE_RESOLVE,LEAFLET_JS,LEAFLET_CSS,OSM_TILE,keyOf,locationRow};
