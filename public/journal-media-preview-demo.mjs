const PREVIEW_HOST='preview--comfy-heliotrope-475c71.netlify.app';
const VERSION='4.5.0-phase1.6-j1g.8';
const ACCEPTED=new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif']);
const MAX_BYTES=25*1024*1024;
const MAX_FILES=20;
const state={items:[],mounted:false};

function esc(v=''){return String(v).replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]));}
function isFixedPreview(env=globalThis){try{return String(env?.location?.hostname||'')===PREVIEW_HOST;}catch(_){return false;}}
export function classifyPreviewFiles(files=[]){const rows=[...files].slice(0,MAX_FILES);return rows.map(file=>{const type=String(file?.type||'').toLowerCase(),size=Number(file?.size||0);let reason='';if(!ACCEPTED.has(type))reason='僅支援 JPEG、PNG、WebP、HEIC、HEIF';else if(size<=0)reason='照片檔案是空的';else if(size>MAX_BYTES)reason='單張照片不可超過 25MB';return {file,ok:!reason,reason,type,size};});}
export function previewSafetyCopy(){return '照片只存在目前 Safari 記憶體；不上傳、不建立日誌，關閉日誌或重整即清除。';}

function revokeAll(){for(const item of state.items){try{URL.revokeObjectURL(item.url);}catch(_){}}state.items=[];}
function root(){return document.getElementById('journalPreviewMediaDemo');}
function syncHeaderVersion(){const small=document.querySelector('#journalOverlay .journal-head-copy small');if(!small)return;const prefix=String(small.textContent||'').split('｜')[0]||'手機紀錄與回顧';const next=`${prefix}｜${VERSION}`;if(small.textContent!==next)small.textContent=next;}
function render(){const el=root();if(!el)return;const cards=state.items.length?`<div class="journal-media-grid">${state.items.map((item,i)=>`<article class="journal-media-card"><div class="journal-media-photo"><img src="${esc(item.url)}" alt="Preview 本機照片 ${i+1}"></div><div class="journal-media-meta"><small>${esc(item.name)}｜${Math.max(1,Math.round(item.size/1024))} KB</small><label>照片說明（僅本機預覽）<input type="text" maxlength="300" placeholder="例如：第一次餵長頸鹿"></label></div></article>`).join('')}</div>`:'<div class="journal-media-empty">尚未載入照片。可直接從 iPhone 相簿選取多張。</div>';
el.innerHTML=`<div class="journal-media-head"><div><h4>Preview 相簿實機驗收</h4><small>J1G.8｜純本機、不碰雲端</small></div>${state.items.length?'<button type="button" class="journal-filter-btn" data-preview-media-clear>清除</button>':''}</div><div class="journal-media-message">${previewSafetyCopy()}</div><div class="journal-media-upload"><label>從 iPhone 選照片<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/*" multiple data-preview-media-files></label><small>最多 20 張；每張最多 25MB。選取後立即產生本機縮圖。</small></div>${cards}`;}

function ensureDemo(){if(!isFixedPreview()||document.getElementById('journalOverlay')?.hidden)return;syncHeaderVersion();const left=document.querySelector('#journalOverlay .journal-left');if(!left)return;if(root())return;const el=document.createElement('section');el.id='journalPreviewMediaDemo';el.className='journal-media-section journal-preview-media-demo';const anchor=left.querySelector('.journal-alert');if(anchor)anchor.insertAdjacentElement('afterend',el);else left.prepend(el);render();}
function clearDemo(){revokeAll();root()?.remove();}
function loadFiles(input){const rows=classifyPreviewFiles(input?.files||[]);const invalid=rows.find(x=>!x.ok);if(invalid){input.value='';alert(`${invalid.file?.name||'照片'}：${invalid.reason}`);return;}revokeAll();state.items=rows.map(({file,type,size})=>({name:String(file.name||'照片'),type,size,url:URL.createObjectURL(file)}));render();}

function mount(){if(state.mounted)return;state.mounted=true;const observer=new MutationObserver(()=>queueMicrotask(ensureDemo));observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});document.addEventListener('change',ev=>{const input=ev.target.closest?.('[data-preview-media-files]');if(input)loadFiles(input);});document.addEventListener('click',ev=>{if(ev.target.closest?.('[data-preview-media-clear]')){revokeAll();render();return;}if(ev.target.closest?.('[data-journal-close]')||ev.target?.id==='journalOverlay')setTimeout(()=>{if(document.getElementById('journalOverlay')?.hidden)clearDemo();},0);},true);document.addEventListener('keydown',ev=>{if(ev.key==='Escape')setTimeout(()=>{if(document.getElementById('journalOverlay')?.hidden)clearDemo();},0);});window.addEventListener('pagehide',revokeAll);ensureDemo();}

if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();}

export const __test={PREVIEW_HOST,VERSION,MAX_BYTES,MAX_FILES,isFixedPreview};
