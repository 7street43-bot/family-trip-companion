import journalBinding from './journal-browser.mjs';
import journalShell from './journal-shell.mjs';
import { extractPlaces, visibleTags, entryLabel } from './journal-ui.mjs';

const MAX_YEAR_ENTRIES=500;
const state={year:new Date().getFullYear(),report:null,sourceEntries:[],loading:false,error:'',mounted:false};

function uniq(items=[]){return [...new Set(items.filter(Boolean))];}
function countBy(items=[]){const m=new Map();for(const raw of items){const key=String(raw||'').trim();if(key)m.set(key,(m.get(key)||0)+1);}return [...m.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'zh-TW')).map(([name,count])=>({name,count}));}
function isoYear(value=''){const m=/^(\d{4})-\d{2}-\d{2}$/.exec(String(value||''));return m?Number(m[1]):null;}
function monthKey(value=''){return String(value||'').slice(0,7);}
function safeEntry(e={}){return {
  date:String(e.entry_date||''),
  title:entryLabel(e),
  summary:String(e.summary||''),
  places:extractPlaces(e),
  tags:visibleTags(e.tags),
  participants:Array.isArray(e.participants)?e.participants.map(String):[],
  tripRef:e.trip_ref==null?null:String(e.trip_ref),
  version:Number(e.version)||1
};}

export function buildYearSummary(entries=[],year=new Date().getFullYear()){
  const y=Number(year);
  const rows=(Array.isArray(entries)?entries:[]).filter(e=>!e?.deleted_at&&isoYear(e?.entry_date)===y).map(safeEntry)
    .sort((a,b)=>a.date.localeCompare(b.date)||a.title.localeCompare(b.title,'zh-TW'));
  const dates=uniq(rows.map(r=>r.date));
  const places=countBy(rows.flatMap(r=>r.places));
  const tags=countBy(rows.flatMap(r=>r.tags));
  const participants=countBy(rows.flatMap(r=>r.participants));
  const months=countBy(rows.map(r=>monthKey(r.date)));
  const tripRefs=uniq(rows.map(r=>r.tripRef).filter(Boolean));
  return {
    schemaVersion:1,year:y,entryCount:rows.length,outingDays:dates.length,
    placeCount:places.length,activeMonths:months.length,tripRefCount:tripRefs.length,
    firstDate:rows[0]?.date||null,lastDate:rows.at(-1)?.date||null,
    topPlaces:places.slice(0,12),topTags:tags.slice(0,12),participants,
    months,entries:rows,truncated:rows.length>=MAX_YEAR_ENTRIES
  };
}

function mdEscape(v=''){return String(v).replace(/[\r\n]+/g,' ').trim();}
export function buildYearMarkdown(report,generatedAt=new Date().toISOString()){
  if(!report||!Number.isInteger(Number(report.year)))throw new TypeError('year report required');
  const lines=[
    `# 雙寶出遊趣｜${report.year} 年度旅遊回顧`,
    '',
    `產生時間：${generatedAt}`,
    '',
    '## 年度摘要',
    '',
    `- 日誌：${report.entryCount} 篇`,
    `- 出遊紀錄日：${report.outingDays} 天`,
    `- 足跡地點：${report.placeCount} 個`,
    `- 有紀錄月份：${report.activeMonths} 個`,
    `- 行程標記：${report.tripRefCount} 組`
  ];
  if(report.topPlaces?.length){
    lines.push('','## 足跡',...report.topPlaces.map(x=>`- ${mdEscape(x.name)}：${x.count} 次`));
  }
  if(report.months?.length){
    lines.push('','## 月份軌跡',...report.months.map(x=>`- ${mdEscape(x.name)}：${x.count} 篇`));
  }
  if(report.entries?.length){
    lines.push('','## 日誌');
    for(const e of report.entries){
      lines.push('',`### ${mdEscape(e.date)}｜${mdEscape(e.title)}`);
      if(e.places?.length)lines.push(`地點：${e.places.map(mdEscape).join('、')}`);
      if(e.participants?.length)lines.push(`人物：${e.participants.map(mdEscape).join('、')}`);
      if(e.tags?.length)lines.push(`標籤：${e.tags.map(mdEscape).join('、')}`);
      if(e.summary)lines.push('',String(e.summary).trim());
    }
  }
  if(report.truncated)lines.push('','> 注意：年度資料達目前單次讀取上限 500 篇，此匯出可能不是完整年度資料。');
  return lines.join('\n')+'\n';
}

export function buildYearJson(report,generatedAt=new Date().toISOString()){
  return JSON.stringify({exportType:'family-trip-journal-yearly-recap',generatedAt,report},null,2)+'\n';
}

function esc(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function panel(){return document.getElementById('journalYearlyRecap');}
function reportHtml(){
  if(state.loading)return '<div class="journal-year-empty">正在整理年度回顧…</div>';
  if(state.error)return `<div class="journal-year-error">${esc(state.error)}</div>`;
  const r=state.report;
  if(!r)return '<div class="journal-year-empty">按「產生年度回顧」後，才會讀取該年度日誌；平常開啟日誌不會多抓全年資料。</div>';
  if(!r.entryCount)return `<div class="journal-year-empty">${r.year} 年目前沒有可回顧的日誌。</div>`;
  const placeChips=r.topPlaces.slice(0,8).map(x=>`<span>${esc(x.name)} <b>${x.count}</b></span>`).join('');
  const monthRows=r.months.map(x=>`<div><span>${esc(x.name.replace('-',' 年 '))} 月</span><b>${x.count} 篇</b></div>`).join('');
  return `<div class="journal-year-stats"><div><b>${r.outingDays}</b><span>出遊紀錄日</span></div><div><b>${r.entryCount}</b><span>日誌</span></div><div><b>${r.placeCount}</b><span>足跡地點</span></div><div><b>${r.activeMonths}</b><span>有紀錄月份</span></div></div>${placeChips?`<div class="journal-year-places"><strong>常去足跡</strong><div>${placeChips}</div></div>`:''}${monthRows?`<div class="journal-year-months"><strong>月份軌跡</strong>${monthRows}</div>`:''}${r.truncated?'<div class="journal-year-error">年度資料達 500 篇上限，匯出可能不完整。</div>':''}<div class="journal-year-actions"><button type="button" class="journal-secondary" data-year-export="md">下載 Markdown</button><button type="button" class="journal-secondary" data-year-export="json">下載 JSON</button><button type="button" class="journal-secondary" data-year-photo-load>開啟年度相簿</button><button type="button" class="journal-secondary" data-year-story-load>播放年度故事</button><button type="button" class="journal-secondary" data-year-map-load>年度足跡地圖</button></div><small class="journal-year-note">文字回顧可下載；年度相簿按下後才讀取照片，平常不載入全年圖片。</small><section id="journalYearlyPhotos" class="journal-year-photos"></section>`;
}
function render(){
  const el=panel();if(!el)return;
  el.innerHTML=`<div class="journal-year-head"><div><h4>年度旅遊回顧</h4><small>按需產生，不影響日誌平常載入</small></div><div class="journal-year-controls"><input type="number" min="2000" max="2100" value="${state.year}" data-year-input aria-label="回顧年份"><button type="button" class="journal-primary" data-year-generate ${state.loading?'disabled':''}>產生年度回顧</button></div></div><div class="journal-year-body">${reportHtml()}</div>`;
}
function ensurePanel(detail={}){
  if(!detail.open||detail.tab!=='history')return;
  const controls=document.querySelector('.journal-history-controls');if(!controls)return;
  let el=panel();
  if(!el){el=document.createElement('section');el.id='journalYearlyRecap';el.className='journal-yearly';controls.after(el);}
  render();
}
async function generate(){
  const input=panel()?.querySelector('[data-year-input]');
  const y=Number(input?.value||state.year);
  if(!Number.isInteger(y)||y<2000||y>2100){state.error='年份需介於 2000–2100。';return render();}
  state.year=y;state.loading=true;state.error='';state.report=null;state.sourceEntries=[];render();
  try{
    await journalBinding.init();
    const status=await journalBinding.getStatus();
    if(!status?.originMatch)throw new Error('Preview 僅驗收年度回顧介面；正式站登入後才讀取家庭日誌。');
    if(!status?.authenticated)throw new Error('請先登入家庭雲端，再產生年度回顧。');
    const rows=await journalBinding.listEntries({from:`${y}-01-01`,to:`${y}-12-31`,includeArchived:false,limit:MAX_YEAR_ENTRIES});
    state.sourceEntries=Array.isArray(rows)?rows:[];state.report=buildYearSummary(rows,y);
  }catch(err){state.error=String(err?.message||err||'年度回顧產生失敗。');}
  finally{state.loading=false;render();}
}
function downloadText(filename,mime,text){
  const blob=new Blob([text],{type:mime});const url=URL.createObjectURL(blob);const a=document.createElement('a');
  a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportReport(kind){
  if(!state.report)return;
  const y=state.report.year,stamp=new Date().toISOString();
  if(kind==='json')downloadText(`雙寶出遊趣_${y}_年度回顧.json`,'application/json;charset=utf-8',buildYearJson(state.report,stamp));
  else downloadText(`雙寶出遊趣_${y}_年度回顧.md`,'text/markdown;charset=utf-8',buildYearMarkdown(state.report,stamp));
}
function mount(){
  if(state.mounted)return;state.mounted=true;
  journalShell.on('rendered',ensurePanel);
  document.addEventListener('click',ev=>{
    const t=ev.target.closest?.('[data-year-generate],[data-year-export],[data-year-photo-load],[data-year-story-load],[data-year-map-load]');if(!t)return;
    if(t.matches('[data-year-generate]'))generate().catch(()=>{});
    else if(t.matches('[data-year-photo-load]'))import('./journal-yearly-photos.mjs').then(m=>m.loadYearAlbum()).catch(err=>{state.error=String(err?.message||err||'年度相簿載入失敗。');render();});
    else if(t.matches('[data-year-story-load]'))import('./journal-yearly-story.mjs').then(m=>m.openYearStory()).catch(err=>{state.error=String(err?.message||err||'年度故事載入失敗。');render();});
    else if(t.matches('[data-year-map-load]'))import('./journal-yearly-map.mjs').then(m=>m.openYearFootprintMap()).catch(err=>{state.error=String(err?.message||err||'年度足跡地圖載入失敗。');render();});
    else exportReport(t.dataset.yearExport);
  });
  document.addEventListener('change',ev=>{const t=ev.target.closest?.('[data-year-input]');if(t){const y=Number(t.value);if(Number.isInteger(y))state.year=y;}});
  ensurePanel({...journalShell.snapshot(),tab:journalShell.snapshot().tab});
}
export function yearlySourceSnapshot(){return {year:state.year,report:state.report,entries:[...state.sourceEntries]};}
if(typeof window!=='undefined')window.TwinJournalYearly=Object.freeze({snapshot:yearlySourceSnapshot});
if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();}
