import journalBinding from './journal-browser.mjs';

const VERSION='4.5.0-phase1.6-j1g.1';
const state={entryId:null,media:[],urls:new Map(),loading:false,message:'',messageType:'',showHidden:false,seq:0};
const ACCEPTED=new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif']);
const MAX_BYTES=25*1024*1024;

function esc(v=''){return String(v).replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]));}
function fmtTaken(v){if(!v)return '';const d=new Date(v);return Number.isNaN(d.getTime())?'':new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(d);}
export function safeTakenAt(file){const n=Number(file?.lastModified||0);if(!Number.isFinite(n)||n<Date.UTC(2000,0,1))return null;const d=new Date(n);return Number.isNaN(d.getTime())?null:d.toISOString();}
export function visibleMedia(items=[],showHidden=false){return (Array.isArray(items)?items:[]).filter(m=>m?.upload_state==='ready'&&(showHidden||!m?.deleted_at)).sort((a,b)=>(Number(a.sort_order)||0)-(Number(b.sort_order)||0)||String(a.created_at||'').localeCompare(String(b.created_at||'')));}
export function pendingMediaCount(items=[]){return (Array.isArray(items)?items:[]).filter(m=>m?.upload_state==='pending'&&!m?.deleted_at).length;}
export function validatePhotoFile(file){if(!file)return {ok:false,reason:'沒有選到照片'};const type=String(file.type||'').toLowerCase();if(!ACCEPTED.has(type))return {ok:false,reason:'僅支援 JPEG、PNG、WebP、HEIC、HEIF'};if(Number(file.size||0)<=0)return {ok:false,reason:'照片檔案是空的'};if(Number(file.size)>MAX_BYTES)return {ok:false,reason:'單張照片不可超過 25MB'};return {ok:true,type};}

function editor(){return document.getElementById('journalEditForm');}
function section(){return document.getElementById('journalMediaSection');}
function selectedEntryId(){return String(editor()?.dataset?.id||'');}
function statusMessage(text,type=''){state.message=String(text||'');state.messageType=type;renderSection();}
function syncHeaderVersion(){const small=document.querySelector('#journalOverlay .journal-head-copy small');if(!small)return;const prefix=String(small.textContent||'').split('｜')[0]||'手機紀錄與回顧';small.textContent=`${prefix}｜${VERSION}`;}
function captionInput(mediaId){return [...(section()?.querySelectorAll('[data-media-caption-input]')||[])].find(el=>el.dataset.mediaCaptionInput===mediaId)||null;}

async function status(){try{await journalBinding.init();return await journalBinding.getStatus();}catch(err){return {configured:false,authenticated:false,originMatch:false,error:err?.message||String(err)};}}

async function hydrateUrls(items,token){const next=new Map();for(const m of items){if(token!==state.seq)return;try{next.set(m.id,await journalBinding.mediaSignedUrl(m.storage_path,900));}catch(_){next.set(m.id,'');}}if(token===state.seq)state.urls=next;}

async function loadAlbum(entryId=selectedEntryId()){
  if(!entryId)return;
  const token=++state.seq;state.entryId=entryId;state.loading=true;renderSection();
  try{
    const s=await status();
    if(token!==state.seq)return;
    if(!s.originMatch||!s.authenticated){state.media=[];state.urls=new Map();return;}
    const detail=await journalBinding.getEntry(entryId,{includeRevisions:false});
    if(token!==state.seq)return;
    state.media=Array.isArray(detail?.media)?detail.media:[];
    await hydrateUrls(visibleMedia(state.media,state.showHidden),token);
  }catch(err){if(token===state.seq){state.message=err?.message||'讀取照片失敗。';state.messageType='error';}}
  finally{if(token===state.seq){state.loading=false;renderSection();}}
}

function albumCards(){const items=visibleMedia(state.media,state.showHidden);if(!items.length)return `<div class="journal-media-empty">目前還沒有照片。</div>`;return `<div class="journal-media-grid">${items.map(m=>{const url=state.urls.get(m.id)||'';const hidden=!!m.deleted_at;return `<article class="journal-media-card ${hidden?'hidden-media':''}" data-media-id="${esc(m.id)}"><div class="journal-media-photo">${url?`<img src="${esc(url)}" alt="${esc(m.caption||'旅遊日誌照片')}" loading="lazy">`:`<div class="journal-media-no-preview">照片預覽暫時不可用</div>`}${hidden?'<span>已收起</span>':''}</div><div class="journal-media-meta">${m.taken_at?`<small>${esc(fmtTaken(m.taken_at))}</small>`:''}<label>照片說明<input type="text" maxlength="300" value="${esc(m.caption||'')}" data-media-caption-input="${esc(m.id)}" placeholder="例如：第一次餵長頸鹿"></label><div class="journal-media-actions"><button type="button" class="journal-secondary" data-media-caption-save="${esc(m.id)}" data-version="${Number(m.version)||1}">更新說明</button>${hidden?`<button type="button" class="journal-secondary" data-media-restore="${esc(m.id)}" data-version="${Number(m.version)||1}">恢復顯示</button>`:`<button type="button" class="journal-danger" data-media-archive="${esc(m.id)}" data-version="${Number(m.version)||1}">收起照片</button>`}</div></div></article>`;}).join('')}</div>`;}

function renderSection(){const el=section();if(!el)return;const count=visibleMedia(state.media,false).length,hidden=state.media.filter(m=>m?.upload_state==='ready'&&m?.deleted_at).length,pending=pendingMediaCount(state.media);el.innerHTML=`<div class="journal-media-head"><div><h4>照片／相簿</h4><small>${count} 張${hidden?`｜${hidden} 張已收起`:''}${pending?`｜${pending} 張待完成`:''}</small></div>${hidden?`<button type="button" class="journal-filter-btn ${state.showHidden?'active':''}" data-media-hidden>${state.showHidden?'只看一般照片':'查看已收起照片'}</button>`:''}</div>${state.message?`<div class="journal-media-message ${esc(state.messageType)}">${esc(state.message)}</div>`:''}<div class="journal-media-upload"><label>加入照片<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/*" multiple data-journal-media-files></label><small>可一次選多張；每張最多 25MB。照片只存在私人家庭相簿。</small><button type="button" class="journal-primary" data-journal-media-upload ${state.loading?'disabled':''}>${state.loading?'處理中…':'上傳選取照片'}</button></div>${state.loading?'<div class="journal-media-empty">正在讀取／處理照片…</div>':albumCards()}`;}

function ensureSection(){syncHeaderVersion();const form=editor();if(!form){state.entryId=null;state.media=[];state.urls=new Map();return;}let el=section();if(!el){el=document.createElement('section');el.id='journalMediaSection';el.className='journal-media-section';const actions=form.querySelector('.journal-actions');form.insertBefore(el,actions||null);renderSection();}const id=String(form.dataset.id||'');if(id&&id!==state.entryId){state.message='';state.messageType='';state.showHidden=false;loadAlbum(id).catch(()=>{});}}

let scheduled=false;function scheduleEnhance(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;ensureSection();});}

async function uploadSelected(){const id=selectedEntryId();const input=section()?.querySelector('[data-journal-media-files]');const files=[...(input?.files||[])];if(!id||!files.length)return statusMessage('請先選擇至少一張照片。','error');const s=await status();if(!s.originMatch)return statusMessage('Preview 安全模式只驗收相簿介面，不會上傳正式照片。','error');if(!s.authenticated)return statusMessage('請先登入家庭雲端，再上傳照片。','error');if(!navigator.onLine)return statusMessage('照片上傳需要網路連線；文字日誌仍可離線使用。','error');const invalid=files.map(f=>({f,v:validatePhotoFile(f)})).find(x=>!x.v.ok);if(invalid)return statusMessage(`${invalid.f.name||'照片'}：${invalid.v.reason}`,'error');state.loading=true;state.message='';renderSection();let ok=0,failed=0;let order=Math.max(0,...state.media.map(m=>Number(m.sort_order)||0))+100;for(const file of files.slice(0,20)){try{const r=await journalBinding.uploadPhoto(id,file,{takenAt:safeTakenAt(file),sortOrder:order});if(r?.result?.status==='applied'||r?.result?.status==='replayed')ok++;else failed++;}catch(_){failed++;}order+=100;}if(input)input.value='';state.loading=false;await loadAlbum(id);statusMessage(failed?`已加入 ${ok} 張；${failed} 張未完成，可重新選取再試。`:`已加入 ${ok} 張照片。`,failed?'error':'good');}

async function saveCaption(button){const id=selectedEntryId(),mediaId=String(button.dataset.mediaCaptionSave||''),version=Number(button.dataset.version),input=captionInput(mediaId);if(!id||!mediaId||!input)return;const nextCaption=String(input.value||'').trim()||null;const s=await status();if(!s.originMatch)return statusMessage('Preview 安全模式不修改正式照片。','error');state.loading=true;renderSection();try{const r=await journalBinding.updateMedia(id,mediaId,version,{caption:nextCaption});if(r?.status==='conflict')statusMessage('照片版本已更新，已重新載入，請再確認一次。','error');else statusMessage('照片說明已更新。','good');}catch(err){statusMessage(err?.message||'更新照片說明失敗。','error');}finally{state.loading=false;await loadAlbum(id);}}

async function setMediaHidden(button,hidden){const id=selectedEntryId(),mediaId=String(hidden?button.dataset.mediaArchive:button.dataset.mediaRestore),version=Number(button.dataset.version);if(!id||!mediaId)return;const s=await status();if(!s.originMatch)return statusMessage('Preview 安全模式不修改正式照片。','error');if(hidden&&!confirm('收起這張照片？之後可用「查看已收起照片」找回。'))return;state.loading=true;renderSection();try{const r=hidden?await journalBinding.archiveMedia(id,mediaId,version):await journalBinding.restoreMedia(id,mediaId,version);if(r?.status==='conflict')statusMessage('照片版本已更新，請重新確認。','error');else statusMessage(hidden?'照片已收起。':'照片已恢復顯示。','good');}catch(err){statusMessage(err?.message||'照片操作失敗。','error');}finally{state.loading=false;await loadAlbum(id);}}

function mount(){const observer=new MutationObserver(scheduleEnhance);observer.observe(document.body,{childList:true,subtree:true});document.addEventListener('click',ev=>{const t=ev.target.closest?.('[data-journal-media-upload],[data-media-caption-save],[data-media-archive],[data-media-restore],[data-media-hidden]');if(!t)return;if(t.matches('[data-journal-media-upload]'))uploadSelected().catch(err=>statusMessage(err?.message||'照片上傳失敗。','error'));else if(t.dataset.mediaCaptionSave)saveCaption(t).catch(()=>{});else if(t.dataset.mediaArchive)setMediaHidden(t,true).catch(()=>{});else if(t.dataset.mediaRestore)setMediaHidden(t,false).catch(()=>{});else if(t.matches('[data-media-hidden]')){state.showHidden=!state.showHidden;loadAlbum().catch(()=>{});}});scheduleEnhance();}

if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();}
