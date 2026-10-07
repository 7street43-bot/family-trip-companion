import journalBinding from './journal-browser.mjs';
import { yearlySourceSnapshot } from './journal-yearly.mjs';

const PAGE_SIZE=12;
const MAX_YEAR_MEDIA=240;
const state={year:null,album:[],signed:new Map(),visibleCount:0,loading:false,loadingMore:false,error:'',observer:null};

function esc(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function dateOnly(value=''){const s=String(value||'');return /^\d{4}-\d{2}-\d{2}/.test(s)?s.slice(0,10):'';}
function titleOf(entry={}){return String(entry.title||'').trim()||String(entry.summary||'').trim().slice(0,28)||'旅遊日誌';}

export function buildYearAlbum(media=[],entries=[]){
  const entryMap=new Map((Array.isArray(entries)?entries:[]).map(e=>[String(e.id||''),e]).filter(([id])=>id));
  return (Array.isArray(media)?media:[])
    .filter(m=>m?.upload_state==='ready'&&!m?.deleted_at&&m?.storage_path)
    .map(m=>{
      const entry=entryMap.get(String(m.entry_id||''))||{};
      const date=dateOnly(m.taken_at)||dateOnly(entry.entry_date)||dateOnly(m.created_at);
      return {
        id:String(m.id||''),entryId:String(m.entry_id||''),storagePath:String(m.storage_path||''),
        date,month:date.slice(0,7),caption:String(m.caption||'').trim(),
        entryTitle:titleOf(entry),sortOrder:Number(m.sort_order)||0
      };
    })
    .filter(x=>x.id&&x.storagePath)
    .sort((a,b)=>a.date.localeCompare(b.date)||a.sortOrder-b.sortOrder||a.id.localeCompare(b.id));
}

export function albumStats(items=[]){
  const rows=Array.isArray(items)?items:[];
  return {
    photos:rows.length,
    months:new Set(rows.map(x=>x.month).filter(Boolean)).size,
    entries:new Set(rows.map(x=>x.entryId).filter(Boolean)).size
  };
}

function section(){return document.getElementById('journalYearlyPhotos');}
function currentItems(){return state.album.slice(0,state.visibleCount);}

function cardHtml(item){
  const url=state.signed.get(item.storagePath)||'';
  const alt=item.caption||item.entryTitle||'家庭旅遊照片';
  return `<article class="journal-year-photo-card"><div class="journal-year-photo-frame">${url?`<img alt="${esc(alt)}" data-year-photo-src="${esc(url)}" loading="lazy" decoding="async">`:'<div class="journal-year-photo-placeholder">照片準備中</div>'}</div><div class="journal-year-photo-meta"><strong>${esc(item.entryTitle)}</strong>${item.date?`<small>${esc(item.date)}</small>`:''}${item.caption?`<p>${esc(item.caption)}</p>`:''}</div></article>`;
}

function render(){
  const el=section();if(!el)return;
  if(state.loading){el.innerHTML='<div class="journal-year-photo-status">正在整理年度相簿…</div>';return;}
  if(state.error){el.innerHTML=`<div class="journal-year-error">${esc(state.error)}</div>`;return;}
  if(!state.year){el.innerHTML='';return;}
  if(!state.album.length){el.innerHTML=`<div class="journal-year-photo-status">${state.year} 年目前沒有日誌照片。</div>`;return;}
  const stats=albumStats(state.album),shown=currentItems();
  el.innerHTML=`<div class="journal-year-photo-head"><div><h4>${state.year} 家庭旅遊相簿</h4><small>${stats.photos} 張照片｜${stats.entries} 篇日誌｜${stats.months} 個月份</small></div><span>每次載入 ${PAGE_SIZE} 張</span></div><div class="journal-year-photo-grid">${shown.map(cardHtml).join('')}</div>${state.visibleCount<state.album.length?`<div class="journal-year-photo-more"><button type="button" class="journal-secondary" data-year-photo-more ${state.loadingMore?'disabled':''}>${state.loadingMore?'載入中…':`再看 ${Math.min(PAGE_SIZE,state.album.length-state.visibleCount)} 張`}</button></div>`:''}${state.album.length>=MAX_YEAR_MEDIA?'<small class="journal-year-note">年度相簿目前最多載入 240 張；其餘照片仍保留在各篇私人相簿。</small>':''}`;
  activateLazyImages();
}

function activateLazyImages(){
  state.observer?.disconnect?.();state.observer=null;
  const imgs=[...(section()?.querySelectorAll('img[data-year-photo-src]')||[])];
  if(!imgs.length)return;
  const load=img=>{if(!img.getAttribute('src'))img.setAttribute('src',img.dataset.yearPhotoSrc||'');delete img.dataset.yearPhotoSrc;};
  if(!('IntersectionObserver' in globalThis)){imgs.forEach(load);return;}
  state.observer=new IntersectionObserver(entries=>{for(const e of entries){if(e.isIntersecting){load(e.target);state.observer?.unobserve(e.target);}}},{rootMargin:'240px 0px'});
  imgs.forEach(img=>state.observer.observe(img));
}

async function signRange(start,end){
  const slice=state.album.slice(start,end);
  const missing=slice.filter(x=>!state.signed.has(x.storagePath)).map(x=>x.storagePath);
  if(!missing.length)return;
  const rows=await journalBinding.mediaSignedUrls(missing,900);
  for(const row of Array.isArray(rows)?rows:[])if(row?.path&&row?.signedUrl)state.signed.set(String(row.path),String(row.signedUrl));
}

async function loadMore(){
  if(state.loadingMore||state.visibleCount>=state.album.length)return;
  state.loadingMore=true;render();
  const next=Math.min(state.album.length,state.visibleCount+PAGE_SIZE);
  try{await signRange(state.visibleCount,next);state.visibleCount=next;}
  catch(err){state.error=String(err?.message||err||'照片連結產生失敗。');}
  finally{state.loadingMore=false;render();}
}

export async function loadYearAlbum(){
  const snap=yearlySourceSnapshot(),year=Number(snap.year),entries=Array.isArray(snap.entries)?snap.entries:[];
  state.year=year;state.album=[];state.signed.clear();state.visibleCount=0;state.error='';state.loading=true;render();
  try{
    if(!entries.length)throw new Error('請先產生該年度回顧，再開啟年度相簿。');
    await journalBinding.init();
    const status=await journalBinding.getStatus();
    if(!status?.originMatch)throw new Error('Preview 只驗收年度相簿介面；正式站登入後才讀取私人照片。');
    if(!status?.authenticated)throw new Error('請先登入家庭雲端，再開啟年度相簿。');
    const ids=entries.map(e=>String(e.id||'')).filter(Boolean);
    const media=await journalBinding.listMediaForEntries(ids,{limit:MAX_YEAR_MEDIA});
    state.album=buildYearAlbum(media,entries);
    state.loading=false;
    if(state.album.length)await loadMore();else render();
  }catch(err){state.loading=false;state.error=String(err?.message||err||'年度相簿讀取失敗。');render();}
}

function mount(){
  document.addEventListener('click',ev=>{
    const t=ev.target.closest?.('[data-year-photo-more]');if(!t)return;
    loadMore().catch(()=>{});
  });
}

if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();}
export const __test={PAGE_SIZE,MAX_YEAR_MEDIA};
