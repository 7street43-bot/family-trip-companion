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
  return {
    name:clean(name||row.name||row.title||row.label),
    latitude,longitude,
    placeId:clean(row.placeId||row.place_id)||null,
    address:clean(row.address||row.formattedAddress)||'',
    googleMapsUrl:clean(row.googleMapsUrl||row.googleMapsUri)||'',
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
