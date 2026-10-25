import journalBinding from './journal-browser.mjs';
import journalShell from './journal-shell.mjs';

const QUEUE_KEY='journalJ1FQueue';
const PLACE_PREFIX='@place:';
const state={open:false,status:null,recent:[],searchCorpus:[],searchResults:[],selected:null,pending:[],loading:false,message:'',messageType:'',searchQuery:'',draft:null,composing:false};

export function splitCsv(value=''){return [...new Set(String(value).split(/[，,]/).map(x=>x.trim()).filter(Boolean))].slice(0,30);}
export function todayLocal(d=new Date()){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${day}`;}
export function entryLabel(entry={}){return String(entry.title||'').trim()||String(entry.summary||'').trim().slice(0,32)||'未命名日誌';}
export function queueRecord(input,mutationId,now=new Date().toISOString()){return {id:mutationId,mutationId,createdAt:now,input:{entryDate:String(input.entryDate||''),timezone:String(input.timezone||'Asia/Taipei'),title:input.title==null?null:String(input.title),summary:input.summary==null?null:String(input.summary),tags:Array.isArray(input.tags)?input.tags.map(String):[],participants:Array.isArray(input.participants)?input.participants.map(String):[],tripRef:input.tripRef??null}};}
export function encodePlaceTags(places=[],tags=[]){const normal=(Array.isArray(tags)?tags:[]).map(String).map(x=>x.trim()).filter(x=>x&&!x.startsWith(PLACE_PREFIX));const placeTags=(Array.isArray(places)?places:[]).map(String).map(x=>x.trim()).filter(Boolean).map(x=>`${PLACE_PREFIX}${x}`);return [...new Set([...normal,...placeTags])].slice(0,60);}
export function extractPlaces(entry={}){return [...new Set((Array.isArray(entry.tags)?entry.tags:[]).map(String).filter(x=>x.startsWith(PLACE_PREFIX)).map(x=>x.slice(PLACE_PREFIX.length).trim()).filter(Boolean))];}
export function visibleTags(tags=[]){return (Array.isArray(tags)?tags:[]).map(String).filter(x=>!x.startsWith(PLACE_PREFIX));}
export function periodBounds(kind='thisMonth',now=new Date()){const ds=d=>todayLocal(d),y=now.getFullYear(),m=now.getMonth();if(kind==='thisMonth')return {from:ds(new Date(y,m,1)),to:ds(new Date(y,m+1,0)),label:'本月'};if(kind==='lastMonth')return {from:ds(new Date(y,m-1,1)),to:ds(new Date(y,m,0)),label:'上月'};if(kind==='thisYear')return {from:ds(new Date(y,0,1)),to:ds(new Date(y,11,31)),label:'今年'};if(kind==='lastYear')return {from:ds(new Date(y-1,0,1)),to:ds(new Date(y-1,11,31)),label:'去年'};return {from:null,to:null,label:'全部'};}
export function groupHistory(entries=[]){const map=new Map();for(const e of Array.isArray(entries)?entries:[]){const key=String(e.entry_date||'').slice(0,7)||'unknown';if(!map.has(key))map.set(key,[]);map.get(key).push(e);}return [...map.entries()].map(([key,items])=>({key,items,places:[...new Set(items.flatMap(extractPlaces))]}));}
export function searchEntriesLocal(entries=[],query=''){const q=String(query||'').trim().toLocaleLowerCase('zh-TW');if(!q)return [];return (Array.isArray(entries)?entries:[]).filter(e=>{const hay=[e.entry_date,e.title,e.summary,...visibleTags(e.tags),...(Array.isArray(e.participants)?e.participants:[]),...extractPlaces(e)].filter(Boolean).join(' ').toLocaleLowerCase('zh-TW');return hay.includes(q);});}
export function normalizeTripDraft(input={}){
  const places=[...new Set((Array.isArray(input.places)?input.places:[]).map(String).map(x=>x.trim()).filter(Boolean))].slice(0,20);
  const tags=[...new Set((Array.isArray(input.tags)?input.tags:[]).map(String).map(x=>x.trim()).filter(Boolean))].slice(0,30);
  const participants=[...new Set((Array.isArray(input.participants)?input.participants:[]).map(String).map(x=>x.trim()).filter(Boolean))].slice(0,20);
  return {
    entryDate:String(input.entryDate||todayLocal()),
    title:String(input.title||'').trim(),
    summary:String(input.summary||'').trim(),
    places,tags,participants,
    tripRef:input.tripRef==null||String(input.tripRef).trim()===''?null:String(input.tripRef).trim()
  };
}

function esc(v=''){return String(v).replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]));}
function fmtDate(s=''){if(!s)return '';const d=new Date(`${s}T12:00:00`);return Number.isNaN(d.getTime())?s:new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'numeric',day:'numeric',weekday:'short'}).format(d);}
function uuid(){return globalThis.crypto?.randomUUID?.()||`j-${Date.now()}-${Math.random().toString(16).slice(2)}`;}
function isDesktop(){return globalThis.matchMedia?.('(pointer:fine)')?.matches&&globalThis.innerWidth>=900;}
function canRead(){return !!state.status?.originMatch&&!!state.status?.authenticated;}

async function readQueue(){if(!window.TwinDB)return [];const row=await TwinDB.get('meta',QUEUE_KEY).catch(()=>null);return Array.isArray(row?.value)?row.value:[];}
async function writeQueue(rows){if(!window.TwinDB)throw new Error('local_db_unavailable');await TwinDB.put('meta',{key:QUEUE_KEY,value:rows,savedAt:new Date().toISOString()});state.pending=rows;syncFab();}
async function enqueue(input,mutationId=uuid()){const rows=await readQueue();const rec=queueRecord(input,mutationId);rows.push(rec);await writeQueue(rows);return rec;}

function setMessage(text,type=''){state.message=String(text||'');state.messageType=type;render();}
function clearMessage(){state.message='';state.messageType='';}
function root(){return document.getElementById('journalOverlay');}
function syncFab(){const n=state.pending.length;journalShell.setPending(n);const fab=document.getElementById('journalFab');if(!fab)return;const p=n?String(n):'';if(p){if(fab.dataset.pending!==p)fab.dataset.pending=p;}else if(fab.dataset.pending!==undefined){delete fab.dataset.pending;}}

async function refreshStatus(){try{state.status=await journalBinding.init();state.status=await journalBinding.getStatus();}catch(err){state.status={configured:false,authenticated:false,originMatch:false,error:err?.message||String(err)};}return state.status;}
async function loadRecent(){if(!canRead()){state.recent=[];return;}state.recent=await journalBinding.listEntries({limit:50,includeArchived:false});}
async function loadSearch(){if(!canRead()){state.searchCorpus=[];state.searchResults=[];return;}state.searchCorpus=await journalBinding.listEntries({includeArchived:false,limit:500});state.searchResults=searchEntriesLocal(state.searchCorpus,state.searchQuery);}
async function loadActive(){state.loading=true;render();try{await loadRecent();if(state.searchQuery)await loadSearch();}finally{state.loading=false;render();}}
async function flushQueue(){const status=await refreshStatus();state.pending=await readQueue();syncFab();if(!status.originMatch||!status.authenticated||!navigator.onLine||!state.pending.length)return {flushed:0,pending:state.pending.length};const keep=[];let flushed=0;for(const rec of state.pending){try{const r=await journalBinding.createEntry(rec.input,{mutationId:rec.mutationId});if(r?.ok)flushed++;else keep.push(rec);}catch{keep.push(rec);}}await writeQueue(keep);if(flushed){state.searchCorpus=[];await loadActive();}return {flushed,pending:keep.length};}

function statusHtml(){const s=state.status||{};if(!s.configured)return `<div class="journal-alert error">Journal 雲端設定尚未就緒。${s.error?` ${esc(s.error)}`:''}</div>`;if(!s.originMatch)return `<div class="journal-alert">目前是 Preview。可以驗收新增、搜尋、編輯與照片介面，但不讀寫正式家庭日誌。</div>`;if(!s.authenticated)return `<div class="journal-alert">尚未登入家庭雲端。可以先離線記錄，登入後再同步。<div class="journal-actions"><button class="journal-primary" data-journal-login>使用 Google 登入</button></div></div>`;return state.pending.length?`<div class="journal-alert good"><span class="journal-pending">${state.pending.length} 筆待同步</span></div>`:'';}
function quickForm(){
  const d=state.draft||normalizeTripDraft({});
  return `<form id="journalQuickForm" class="journal-quick">
    <h3>${state.draft?'行程日誌草稿':'新增日誌'}</h3>
    ${state.draft?'<div class="journal-alert good">已從行程帶入日期與景點；補寫內容後再儲存。</div>':''}
    <input name="tripRef" type="hidden" value="${esc(d.tripRef||'')}">
    <input name="places" type="hidden" value="${esc(d.places.join(', '))}">
    <input name="tags" type="hidden" value="${esc(d.tags.join(', '))}">
    <input name="participants" type="hidden" value="${esc(d.participants.join(', '))}">
    <div class="journal-fields">
      <div class="journal-field"><label>日期</label><input name="entryDate" type="date" value="${esc(d.entryDate||todayLocal())}" required></div>
      <div class="journal-field"><label>標題 <small>可不填</small></label><input name="title" maxlength="120" value="${esc(d.title)}" placeholder="例如：六福村的一天"></div>
      <div class="journal-field"><label>內容</label><textarea name="summary" maxlength="12000" placeholder="今天發生了什麼？" required>${esc(d.summary)}</textarea></div>
    </div>
    <div class="journal-actions"><button class="journal-primary" type="submit">儲存日誌</button><button class="journal-secondary" type="button" data-journal-cancel-new>取消</button></div>
  </form>`;
}
function entryButton(e){const places=extractPlaces(e);return `<button class="journal-item ${state.selected?.entry?.id===e.id?'active':''}" data-journal-select="${esc(e.id)}"><div class="journal-item-title"><strong>${esc(entryLabel(e))}</strong></div><small>${esc(fmtDate(e.entry_date))}</small>${places.length?`<div class="journal-place-line">📍 ${places.map(esc).join('、')}</div>`:''}${e.summary?`<p>${esc(e.summary)}</p>`:''}</button>`;}
function searchResultsHtml(){
  const result=state.searchQuery?state.searchResults:state.recent;
  let body='';
  if(!state.status?.originMatch)body='<div class="journal-empty">Preview 不讀正式日誌資料。</div>';
  else if(!state.status?.authenticated)body='<div class="journal-empty">登入後會顯示你的日誌。</div>';
  else if(!result.length)body=state.searchQuery?'<div class="journal-empty">找不到符合的日誌。</div>':'<div class="journal-empty">還沒有日誌。先新增第一篇。</div>';
  else body='<div class="journal-list">'+result.map(entryButton).join('')+'</div>';
  return '<div class="journal-section-title"><h3>'+(state.searchQuery?'搜尋結果':'最近日誌')+'</h3><span>'+result.length+' 篇</span></div>'+body;
}
function simpleSearchHtml(){
  return '<div class="journal-search-simple"><input type="search" data-journal-live-search value="'+esc(state.searchQuery)+'" placeholder="搜尋日誌" autocomplete="off"></div><div id="journalSearchResults">'+searchResultsHtml()+'</div>';
}
function refreshSearchResults(){
  const el=document.getElementById('journalSearchResults');
  if(el)el.innerHTML=searchResultsHtml();
}
function applyLiveSearch(value){
  state.searchQuery=String(value||'').trim();
  const corpus=state.searchCorpus.length?state.searchCorpus:state.recent;
  state.searchResults=state.searchQuery?searchEntriesLocal(corpus,state.searchQuery):[];
  refreshSearchResults();
}
async function primeSearchCorpus(){
  if(!canRead()||state.searchCorpus.length)return;
  state.searchCorpus=await journalBinding.listEntries({includeArchived:false,limit:500});
  if(state.searchQuery)state.searchResults=searchEntriesLocal(state.searchCorpus,state.searchQuery);
  refreshSearchResults();
}
function mainHtml(){if(state.composing||state.draft)return quickForm();return '<button class="journal-new-btn" type="button" data-journal-new>＋ 新增日誌</button>'+simpleSearchHtml();}

function editorHtml(){
  const e=state.selected?.entry;
  if(!e)return `<div class="journal-editor"><div class="journal-empty">點一篇日誌即可查看或修改。</div></div>`;
  const places=extractPlaces(e),tags=visibleTags(e.tags);
  return `<form id="journalEditForm" class="journal-editor" data-id="${esc(e.id)}" data-version="${Number(e.version)||1}">
    <div class="journal-editor-head"><button class="journal-back-btn" type="button" data-journal-back>返回日誌</button><h3>編輯日誌</h3></div>
    <input name="places" type="hidden" value="${esc(places.join(', '))}">
    <input name="tags" type="hidden" value="${esc(tags.join(', '))}">
    <input name="participants" type="hidden" value="${esc((e.participants||[]).join(', '))}">
    <div class="journal-fields">
      <div class="journal-field"><label>日期</label><input name="entryDate" type="date" value="${esc(e.entry_date||'')}" required></div>
      <div class="journal-field"><label>標題 <small>可不填</small></label><input name="title" maxlength="120" value="${esc(e.title||'')}"></div>
      <div class="journal-field"><label>內容</label><textarea name="summary" maxlength="12000">${esc(e.summary||'')}</textarea></div>
    </div>
    <section id="journalMediaSection" class="journal-media-section" data-entry-id="${esc(e.id)}"></section>
    <div class="journal-actions">
      <button class="journal-primary" type="submit">儲存修改</button>
    </div>
  </form>`;
}

function render(){
  const r=root();if(!r)return;
  r.hidden=!state.open;journalShell.setOpen(state.open);
  if(!state.open){journalShell.rendered({open:false,tab:'quick',selectedEntryId:null,pending:state.pending.length,loading:false});return;}
  r.classList.toggle('journal-loading',state.loading);
  const panelClass='journal-panel'+(state.selected?' has-selection':'')+((state.composing||state.draft)?' has-composer':'');
  r.innerHTML=`<section class="${panelClass}" role="dialog" aria-modal="true" aria-labelledby="journalTitle">
    <div class="journal-head">
      <div class="journal-head-copy"><h2 id="journalTitle">旅遊日誌</h2></div>
      <button class="journal-close" type="button" data-journal-close aria-label="關閉">×</button>
    </div>
    <div class="journal-body">
      <div class="journal-left">${state.message?`<div class="journal-alert ${esc(state.messageType)}">${esc(state.message)}</div>`:''}${statusHtml()}${mainHtml()}</div>
      <div class="journal-right">${editorHtml()}</div>
    </div>
  </section>`;
  journalShell.rendered({open:true,tab:'quick',selectedEntryId:state.selected?.entry?.id||null,pending:state.pending.length,loading:state.loading});
}

async function openJournal(){state.open=true;journalShell.setOpen(true);clearMessage();state.pending=await readQueue();syncFab();await refreshStatus();render();if(canRead()){await flushQueue();await loadActive();}else render();return true;}
async function openDraft(input={}){
  state.draft=normalizeTripDraft(input);
  state.composing=true;
  state.selected=null;
  journalShell.setSelectedEntryId(null);
  clearMessage();
  if(!state.open)return openJournal();
  render();
  return true;
}
function closeJournal(){state.open=false;state.composing=false;state.draft=null;state.selected=null;journalShell.setSelectedEntryId(null);journalShell.setOpen(false);render();document.getElementById('journalNavBtn')?.focus?.();return true;}
function formInput(fd){const places=splitCsv(fd.get('places')),tags=splitCsv(fd.get('tags')),tripRef=String(fd.get('tripRef')||'').trim();return {entryDate:String(fd.get('entryDate')||todayLocal()),timezone:'Asia/Taipei',title:String(fd.get('title')||'').trim()||null,summary:String(fd.get('summary')||'').trim(),tags:encodePlaceTags(places,tags),participants:splitCsv(fd.get('participants')),tripRef:tripRef||null};}
function resetQuickForm(form){state.draft=null;state.composing=false;form.reset();if(form.elements.entryDate)form.elements.entryDate.value=todayLocal();if(form.elements.tripRef)form.elements.tripRef.value='';}
async function saveQuick(form){const fd=new FormData(form),input=formInput(fd);if(!input.summary)return setMessage('請先輸入想記的內容。','error');const status=await refreshStatus();if(!status.originMatch)return setMessage('Preview 安全模式不會寫入或排入正式日誌。','error');const mutationId=uuid();if(!status.authenticated||!navigator.onLine){await enqueue(input,mutationId);resetQuickForm(form);return setMessage('已先存到手機待同步；登入且有網路時會自動送出。','good');}try{const r=await journalBinding.createEntry(input,{mutationId});if(!r?.ok)return setMessage('儲存未完成，請重新整理後再試。','error');resetQuickForm(form);await loadRecent();setMessage(r.status==='replayed'?'這筆已存在，未重複新增。':'已儲存。','good');}catch(err){if(err?.retryable||err?.category==='transport'){await enqueue(input,mutationId);resetQuickForm(form);setMessage('網路不穩，已先保留為待同步。','good');}else setMessage(err?.message||'儲存失敗。','error');}}
async function selectEntry(id){state.composing=false;state.draft=null;state.loading=true;render();try{state.selected=await journalBinding.getEntry(id,{includeRevisions:false});journalShell.setSelectedEntryId(state.selected?.entry?.id||id);}catch(err){setMessage(err?.message||'讀取日誌失敗。','error');}finally{state.loading=false;render();}}
async function saveEdit(form){const id=form.dataset.id,version=Number(form.dataset.version),fd=new FormData(form),input=formInput(fd),patch={entryDate:input.entryDate,title:input.title,summary:input.summary,tags:input.tags,participants:input.participants};state.loading=true;render();try{const r=await journalBinding.updateEntry(id,version,patch);if(r.status==='conflict'){state.selected=await journalBinding.getEntry(id,{includeRevisions:false});setMessage(`另一個介面已先更新這篇（目前 v${r.conflict?.serverVersion||'?'}），已載入最新版，請確認後再存。`,'error');}else{state.selected=await journalBinding.getEntry(id,{includeRevisions:false});await loadActive();setMessage('修改已儲存。','good');}journalShell.setSelectedEntryId(state.selected?.entry?.id||id);}catch(err){setMessage(err?.message||'修改失敗。','error');}finally{state.loading=false;render();}}
function startNew(){
  state.composing=true;state.draft=null;state.selected=null;
  journalShell.setSelectedEntryId(null);clearMessage();render();
}
function cancelNew(){
  state.composing=false;state.draft=null;clearMessage();render();
}
function backToList(){
  state.selected=null;journalShell.setSelectedEntryId(null);clearMessage();render();
}
async function login(){if(!state.status?.originMatch)return setMessage('Preview 不允許啟動正式 OAuth 登入。','error');if(!window.TwinCloudSync?.signInWithGoogle)return setMessage('Google 登入模組尚未就緒。','error');try{await TwinCloudSync.signInWithGoogle();}catch(err){setMessage(err?.message||'登入啟動失敗。','error');}}

function mount(){if(document.getElementById('journalFab'))return;const fab=document.createElement('button');fab.id='journalFab';fab.className='journal-fab';fab.type='button';fab.textContent='✎ 日誌';fab.setAttribute('aria-label','開啟旅遊日誌');document.body.appendChild(fab);const overlay=document.createElement('div');overlay.id='journalOverlay';overlay.className='journal-overlay';overlay.hidden=true;document.body.appendChild(overlay);journalShell.registerCommands({open:openJournal,close:closeJournal,openEntry:async id=>{if(!state.open)await openJournal();await selectEntry(id);return true;},openDraft});fab.addEventListener('click',()=>journalShell.open());overlay.addEventListener('click',async ev=>{if(ev.target===overlay)return closeJournal();const t=ev.target.closest('[data-journal-close],[data-journal-login],[data-journal-select],[data-journal-new],[data-journal-cancel-new],[data-journal-back]');if(!t)return;if(t.matches('[data-journal-close]'))return closeJournal();if(t.matches('[data-journal-login]'))return login();if(t.matches('[data-journal-new]'))return startNew();if(t.matches('[data-journal-cancel-new]'))return cancelNew();if(t.matches('[data-journal-back]'))return backToList();if(t.dataset.journalSelect)return selectEntry(t.dataset.journalSelect);});overlay.addEventListener('submit',async ev=>{if(ev.target.id==='journalQuickForm'){ev.preventDefault();await saveQuick(ev.target);}else if(ev.target.id==='journalEditForm'){ev.preventDefault();await saveEdit(ev.target);}});overlay.addEventListener('focusin',ev=>{const t=ev.target.closest?.('[data-journal-live-search]');if(t)primeSearchCorpus().catch(()=>{});});overlay.addEventListener('input',ev=>{const t=ev.target.closest?.('[data-journal-live-search]');if(t)applyLiveSearch(t.value);});document.addEventListener('keydown',ev=>{if(ev.key==='Escape'&&state.open)closeJournal();});window.addEventListener('online',()=>flushQueue().catch(()=>{}));readQueue().then(rows=>{state.pending=rows;syncFab();}).catch(()=>{});journalShell.setTab('quick');journalShell.setOpen(false);}

if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();}

export const __test={splitCsv,todayLocal,entryLabel,queueRecord,encodePlaceTags,extractPlaces,visibleTags,periodBounds,searchEntriesLocal,groupHistory,normalizeTripDraft};