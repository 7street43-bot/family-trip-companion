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

function ensureStyle(){
  if(state.styleReady||typeof document==='undefined')return;
  if(!document.querySelector('link[data-journal-story-style]')){
    const link=document.createElement('link');
    link.rel='stylesheet';link.href='./journal-yearly-story.css';link.dataset.journalStoryStyle='1';document.head.appendChild(link);
  }
  state.styleReady=true;
}

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