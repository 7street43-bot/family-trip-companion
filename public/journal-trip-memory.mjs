
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
