import journalBinding from './journal-browser.mjs';
import { yearlySourceSnapshot } from './journal-yearly.mjs';

const MAX_STORY_MOMENTS=20;
const SIGN_WINDOW=3;
const AUTO_MS=5000;
const state={year:null,moments:[],index:0,signed:new Map(),loading:false,error:'',playing:false,timer:null,swipeX:null,styleReady:false};

function dateOnly(value=''){const s=String(value||'');return /^\d{4}-\d{2}-\d{2}/.test(s)?s.slice(0,10):'';}
function monthKey(value=''){return dateOnly(value).slice(0,7);}
function text(value=''){return String(value||'').trim();}
function tagsOf(entry={}){return Array.isArray(entry.tags)?entry.tags.map(String):[];}
function placesOf(entry={}){return tagsOf(entry).filter(t=>t.startsWith('@place:')).map(t=>t.slice(7).trim()).filter(Boolean);}
function titleOf(entry={}){return text(entry.title)||text(entry.summary).slice(0,36)||'旅遊回憶';}
function summaryOf(entry={}){return text(entry.summary).slice(0,180);}
function esc(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}

export function buildStoryMoments(entries=[],media=[],max=MAX_STORY_MOMENTS){
  const cap=Math.max(1,Math.min(Number(max)||MAX_STORY_MOMENTS,MAX_STORY_MOMENTS));
  const firstMedia=new Map();
  const mediaRows=(Array.isArray(media)?media:[])
    .filter(m=>m?.upload_state==='ready'&&!m?.deleted_at&&m?.storage_path)
    .sort((a,b)=>(Number(a.sort_order)||0)-(Number(b.sort_order)||0)||String(a.created_at||'').localeCompare(String(b.created_at||'')));
  for(const m of mediaRows){const id=String(m.entry_id||'');if(id&&!firstMedia.has(id))firstMedia.set(id,m);}
  const candidates=(Array.isArray(entries)?entries:[])
    .filter(e=>e?.id&&!e?.deleted_at&&dateOnly(e?.entry_date))
    .map(e=>{const m=firstMedia.get(String(e.id))||null;return {
      entryId:String(e.id),date:dateOnly(e.entry_date),month:monthKey(e.entry_date),
      title:titleOf(e),summary:summaryOf(e),places:placesOf(e),
      storagePath:m?String(m.storage_path||''):'',caption:m?text(m.caption):''
    };})
    .sort((a,b)=>a.date.localeCompare(b.date)||a.title.localeCompare(b.title,'zh-TW'));
  const groups=new Map();
  for(const c of candidates){if(!groups.has(c.month))groups.set(c.month,[]);groups.get(c.month).push(c);}
  const months=[...groups.keys()].sort(),chosen=[];
  let round=0;
  while(chosen.length<cap){
    let added=false;
    for(const month of months){const row=groups.get(month)?.[round];if(row){chosen.push(row);added=true;if(chosen.length>=cap)break;}}
    if(!added)break;
    round+=1;
  }
  return chosen.sort((a,b)=>a.date.localeCompare(b.date)||a.title.localeCompare(b.title,'zh-TW'));
}

function ensureStyle(){state.styleReady=true;}

function overlay(){
  let el=document.getElementById('journalYearStory');
  if(!el&&typeof document!=='undefined'){el=document.createElement('div');el.id='journalYearStory';el.className='journal-story';el.hidden=true;document.body.appendChild(el);}
  return el;
}
function clearTimer(){if(state.timer){clearTimeout(state.timer);state.timer=null;}}
function scheduleNext(){
  clearTimer();
  if(!state.playing||!state.moments.length)return;
  state.timer=setTimeout(()=>{if(state.index>=state.moments.length-1){state.playing=false;render();return;}go(state.index+1);},AUTO_MS);
}
function setPlaying(next){state.playing=!!next;clearTimer();if(state.playing)scheduleNext();render();}

async function warmWindow(){
  const rows=state.moments.slice(state.index,state.index+SIGN_WINDOW);
  const missing=rows.map(x=>x.storagePath).filter(Boolean).filter(p=>!state.signed.has(p));
  if(!missing.length)return;
  try{
    const signed=await journalBinding.mediaSignedUrls(missing,900);
    for(const row of Array.isArray(signed)?signed:[])if(row?.path&&row?.signedUrl)state.signed.set(String(row.path),String(row.signedUrl));
    render();
  }catch(_){}
}

function go(next){
  if(!state.moments.length)return;
  state.index=Math.max(0,Math.min(Number(next)||0,state.moments.length-1));
  render();warmWindow().catch(()=>{});if(state.playing)scheduleNext();
}
function progressHtml(){return `<div class="journal-story-progress">${state.moments.map((_,i)=>`<span class="${i<state.index?'done':i===state.index?'active':''}"></span>`).join('')}</div>`;}
function render(){
  const el=overlay();if(!el)return;
  if(state.loading){el.hidden=false;el.innerHTML='<div class="journal-story-loading">正在整理年度回憶…</div>';return;}
  if(state.error){el.hidden=false;el.innerHTML=`<div class="journal-story-error"><p>${esc(state.error)}</p><button type="button" data-story-close>關閉</button></div>`;return;}
  const m=state.moments[state.index];
  if(!m){el.hidden=true;el.innerHTML='';return;}
  const url=m.storagePath?state.signed.get(m.storagePath)||'':'';
  const place=m.places?.length?m.places.join('・'):'';
  el.hidden=false;
  el.innerHTML=`${progressHtml()}<div class="journal-story-top"><span>${esc(state.year)} 年度回憶</span><div><button type="button" data-story-play aria-label="${state.playing?'暫停':'播放'}">${state.playing?'暫停':'播放'}</button><button type="button" data-story-close aria-label="關閉">關閉</button></div></div><main class="journal-story-stage">${url?`<img src="${esc(url)}" alt="${esc(m.caption||m.title)}" decoding="async">`:'<div class="journal-story-no-photo">這一段回憶沒有照片</div>'}<div class="journal-story-shade"></div><div class="journal-story-copy"><small>${esc(m.date)}${place?` ・ ${esc(place)}`:''}</small><h2>${esc(m.title)}</h2>${m.caption?`<p class="journal-story-caption">${esc(m.caption)}</p>`:''}${m.summary?`<p>${esc(m.summary)}</p>`:''}<span>${state.index+1} / ${state.moments.length}</span></div></main><div class="journal-story-nav"><button type="button" data-story-prev ${state.index===0?'disabled':''}>上一段</button><button type="button" data-story-next ${state.index===state.moments.length-1?'disabled':''}>下一段</button></div>`;
}

function closeStory(){
  clearTimer();state.playing=false;state.moments=[];state.signed.clear();state.error='';state.loading=false;state.index=0;
  const el=overlay();if(el){el.hidden=true;el.innerHTML='';}
  document?.body?.classList?.remove('journal-story-open');
}

export async function openYearStory(){
  ensureStyle();
  const snap=yearlySourceSnapshot(),entries=Array.isArray(snap.entries)?snap.entries:[];
  state.year=Number(snap.year);state.loading=true;state.error='';state.moments=[];state.index=0;state.signed.clear();render();
  document?.body?.classList?.add('journal-story-open');
  try{
    if(!entries.length)throw new Error('請先產生該年度回顧，再播放年度故事。');
    await journalBinding.init();
    const status=await journalBinding.getStatus();
    if(!status?.originMatch)throw new Error('Preview 只驗收故事介面；正式站登入後才讀取私人回憶。');
    if(!status?.authenticated)throw new Error('請先登入家庭雲端，再播放年度故事。');
    const ids=entries.map(e=>String(e.id||'')).filter(Boolean);
    const media=await journalBinding.listMediaForEntries(ids,{limit:240});
    state.moments=buildStoryMoments(entries,media,MAX_STORY_MOMENTS);
    if(!state.moments.length)throw new Error('這一年目前沒有可播放的旅遊回憶。');
    state.loading=false;render();await warmWindow();
  }catch(err){state.loading=false;state.error=String(err?.message||err||'年度故事載入失敗。');render();}
}

function mount(){
  document.addEventListener('click',ev=>{
    const t=ev.target.closest?.('[data-story-close],[data-story-prev],[data-story-next],[data-story-play]');if(!t)return;
    if(t.matches('[data-story-close]'))closeStory();
    else if(t.matches('[data-story-prev]'))go(state.index-1);
    else if(t.matches('[data-story-next]'))go(state.index+1);
    else if(t.matches('[data-story-play]'))setPlaying(!state.playing);
  });
  document.addEventListener('keydown',ev=>{
    if(overlay()?.hidden!==false)return;
    if(ev.key==='Escape')closeStory();
    else if(ev.key==='ArrowLeft')go(state.index-1);
    else if(ev.key==='ArrowRight')go(state.index+1);
    else if(ev.key===' '){ev.preventDefault();setPlaying(!state.playing);}
  });
  document.addEventListener('pointerdown',ev=>{if(overlay()?.hidden===false)state.swipeX=Number(ev.clientX);});
  document.addEventListener('pointerup',ev=>{
    if(state.swipeX==null||overlay()?.hidden!==false)return;
    const dx=Number(ev.clientX)-state.swipeX;state.swipeX=null;
    if(Math.abs(dx)>=60)go(state.index+(dx<0?1:-1));
  });
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='visible'&&state.playing)setPlaying(false);});
}
if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();}
export const __test={MAX_STORY_MOMENTS,SIGN_WINDOW,AUTO_MS};
