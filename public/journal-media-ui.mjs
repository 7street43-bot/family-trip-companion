import journalBinding from './journal-browser.mjs';
import journalShell from './journal-shell.mjs';

const state={entryId:null,media:[],urls:new Map(),loading:false,message:'',messageType:'',seq:0};
const ACCEPTED=new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif']);
const MAX_BYTES=25*1024*1024;

function esc(v=''){return String(v).replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]));}
function fmtTaken(v){if(!v)return '';const d=new Date(v);return Number.isNaN(d.getTime())?'':new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(d);}
export function safeTakenAt(file){const n=Number(file?.lastModified||0);if(!Number.isFinite(n)||n<Date.UTC(2000,0,1))return null;const d=new Date(n);return Number.isNaN(d.getTime())?null:d.toISOString();}
export function visibleMedia(items=[],showHidden=false){return (Array.isArray(items)?items:[]).filter(m=>m?.upload_state==='ready'&&(showHidden||!m?.deleted_at)).sort((a,b)=>(Number(a.sort_order)||0)-(Number(b.sort_order)||0)||String(a.created_at||'').localeCompare(String(b.created_at||'')));}
export function pendingMediaCount(items=[]){return (Array.isArray(items)?items:[]).filter(m=>m?.upload_state==='pending'&&!m?.deleted_at).length;}
export function validatePhotoFile(file){if(!file)return {ok:false,reason:'沒有選到照片'};const type=String(file.type||'').toLowerCase();if(!ACCEPTED.has(type))return {ok:false,reason:'僅支援 JPEG、PNG、WebP、HEIC、HEIF'};if(Number(file.size||0)<=0)return {ok:false,reason:'照片檔案是空的'};if(Number(file.size)>MAX_BYTES)return {ok:false,reason:'單張照片不可超過 25MB'};return {ok:true,type};}

function section(){return document.getElementById('journalMediaSection');}
function selectedEntryId(){return String(journalShell.snapshot().selectedEntryId||section()?.dataset?.entryId||'');}
function statusMessage(text,type=''){state.message=String(text||'');state.messageType=type;renderSection();}
async function status(){try{await journalBinding.init();return await journalBinding.getStatus();}catch(err){return {configured:false,authenticated:false,originMatch:false,error:err?.message||String(err)};}}
async function hydrateUrls(items,token){const next=new Map();for(const m of items){if(token!==state.seq)return;try{next.set(m.id,await journalBinding.mediaSignedUrl(m.storage_path,900));}catch(_){next.set(m.id,'');}}if(token===state.seq)state.urls=next;}
async function loadAlbum(entryId=selectedEntryId()){if(!entryId)return;const token=++state.seq;state.entryId=entryId;state.loading=true;renderSection();try{const s=await status();if(token!==state.seq)return;if(!s.originMatch||!s.authenticated){state.media=[];state.urls=new Map();return;}const detail=await journalBinding.getEntry(entryId,{includeRevisions:false});if(token!==state.seq)return;state.media=Array.isArray(detail?.media)?detail.media:[];await hydrateUrls(visibleMedia(state.media,false),token);}catch(err){if(token===state.seq){state.message=err?.message||'讀取照片失敗。';state.messageType='error';}}finally{if(token===state.seq){state.loading=false;renderSection();}}}
function albumCards(){
  const items=visibleMedia(state.media,false);
  if(!items.length)return '<div class="journal-media-empty">目前還沒有照片。</div>';
  return '<div class="journal-media-grid">'+items.map(m=>{
    const url=state.urls.get(m.id)||'';
    return '<article class="journal-media-card" data-media-id="'+esc(m.id)+'"><div class="journal-media-photo">'+
      (url?'<img src="'+esc(url)+'" alt="旅遊日誌照片" loading="lazy">':'<div class="journal-media-no-preview">照片預覽暫時不可用</div>')+
      '</div><div class="journal-media-actions"><button type="button" class="journal-danger" data-media-delete="'+esc(m.id)+'" data-version="'+(Number(m.version)||1)+'">刪除照片</button></div></article>';
  }).join('')+'</div>';
}
function renderSection(){
  const el=section();if(!el)return;
  const count=visibleMedia(state.media,false).length;
  el.innerHTML='<div class="journal-media-head"><div><h4>照片</h4><small>'+count+' 張</small></div></div>'+
    (state.message?'<div class="journal-media-message '+esc(state.messageType)+'">'+esc(state.message)+'</div>':'')+
    '<div class="journal-media-upload"><label>加入照片<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/*" multiple data-journal-media-files></label><button type="button" class="journal-primary" data-journal-media-upload '+(state.loading?'disabled':'')+'>'+(state.loading?'處理中…':'加入照片')+'</button></div>'+
    (state.loading?'<div class="journal-media-empty">正在處理照片…</div>':albumCards());
}
function syncFromRender(detail={}){if(!detail.open){state.entryId=null;state.media=[];state.urls=new Map();return;}const id=String(detail.selectedEntryId||'');if(!id)return;if(id!==state.entryId){state.message='';state.messageType='';loadAlbum(id).catch(()=>{});}else renderSection();}

async function uploadSelected(){const id=selectedEntryId(),input=section()?.querySelector('[data-journal-media-files]'),files=[...(input?.files||[])];if(!id||!files.length)return statusMessage('請先選擇至少一張照片。','error');const s=await status();if(!s.originMatch)return statusMessage('Preview 安全模式只驗收相簿介面，不會上傳正式照片。','error');if(!s.authenticated)return statusMessage('請先登入家庭雲端，再上傳照片。','error');if(!navigator.onLine)return statusMessage('照片上傳需要網路連線；文字日誌仍可離線使用。','error');const invalid=files.map(f=>({f,v:validatePhotoFile(f)})).find(x=>!x.v.ok);if(invalid)return statusMessage(`${invalid.f.name||'照片'}：${invalid.v.reason}`,'error');state.loading=true;state.message='';renderSection();let ok=0,failed=0,order=Math.max(0,...state.media.map(m=>Number(m.sort_order)||0))+100;for(const file of files.slice(0,20)){try{const r=await journalBinding.uploadPhoto(id,file,{takenAt:safeTakenAt(file),sortOrder:order});if(r?.result?.status==='applied'||r?.result?.status==='replayed')ok++;else failed++;}catch(_){failed++;}order+=100;}if(input)input.value='';state.loading=false;await loadAlbum(id);statusMessage(failed?`已加入 ${ok} 張；${failed} 張未完成，可重新選取再試。`:`已加入 ${ok} 張照片。`,failed?'error':'good');}
async function deleteMedia(button){
  const id=selectedEntryId(),mediaId=String(button.dataset.mediaDelete||''),version=Number(button.dataset.version);
  if(!id||!mediaId)return;
  const s=await status();
  if(!s.originMatch)return statusMessage('Preview 安全模式不修改正式照片。','error');
  if(!confirm('刪除這張照片？'))return;
  state.loading=true;renderSection();
  try{
    const r=await journalBinding.archiveMedia(id,mediaId,version);
    if(r?.status==='conflict')statusMessage('照片已被更新，請重新確認。','error');
    else statusMessage('照片已刪除。','good');
  }catch(err){statusMessage(err?.message||'刪除照片失敗。','error');}
  finally{state.loading=false;await loadAlbum(id);}
}
function mount(){
  journalShell.on('rendered',syncFromRender);
  document.addEventListener('click',ev=>{
    const t=ev.target.closest?.('[data-journal-media-upload],[data-media-delete]');
    if(!t)return;
    if(t.matches('[data-journal-media-upload]'))uploadSelected().catch(err=>statusMessage(err?.message||'照片上傳失敗。','error'));
    else if(t.dataset.mediaDelete)deleteMedia(t).catch(()=>{});
  });
  syncFromRender(journalShell.snapshot());
}
if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();}
