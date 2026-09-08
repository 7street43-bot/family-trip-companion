import { normalizeTripLocation } from './itinerary-v2-core.mjs';

const root = document.getElementById('app');
const settingsButton = document.getElementById('settingsBtn');
const modalRoot = document.getElementById('modalRoot');

const state = {
  loaded: false,
  defaultOrigin: null,
  search: { query:'', loading:false, error:'', candidates:[] },
  activeTripId: undefined,
  newDraftActive: false,
  renderSeq: 0
};

function esc(value='') {
  return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function setGlobalOrigin(origin) {
  state.defaultOrigin = normalizeTripLocation(origin, 'home');
  globalThis.TwinTripDefaultOrigin = state.defaultOrigin ? { ...state.defaultOrigin } : null;
}

async function loadDefaultOrigin() {
  if (!window.TwinDB) return null;
  const row = await TwinDB.get('settings', 'defaultOrigin').catch(() => null);
  setGlobalOrigin(row?.value || null);
  state.loaded = true;
  return state.defaultOrigin;
}

function resetSearch() {
  state.search = { query:'', loading:false, error:'', candidates:[] };
}

function candidateHtml(candidate,index) {
  return `<button class="it2-origin-result" data-it2-settings-origin-pick="${index}">
    <span>⌂</span>
    <span><strong>${esc(candidate.displayName || candidate.address || '地址')}</strong><small>${esc(candidate.address || '')}</small></span>
    <span>設為家</span>
  </button>`;
}

function settingsBlockHtml() {
  const saved=state.defaultOrigin, s=state.search;
  return `<div class="setting-block it2-settings-origin" id="it2SettingsOriginBlock">
    <h3>J2B｜預設出發地</h3>
    <p>設定一次「家」，之後建立的新行程會保存真正的起點與終點。舊行程不會自動改寫；J2B-2 才會用這個位置計算道路路線。</p>
    <div class="it2-origin-current"><div><span>目前預設</span><strong>${esc(saved?.label || '尚未設定')}</strong><small>${esc(saved?.address || '請搜尋住家地址、社區或附近地標')}</small></div></div>
    <div class="it2-origin-search-row"><input id="it2SettingsOriginQuery" value="${esc(s.query)}" placeholder="輸入住家地址、社區或附近地標" autocomplete="street-address" /><button class="btn primary" data-it2-settings-origin-search ${s.loading?'disabled':''}>${s.loading?'搜尋中…':'搜尋地址'}</button></div>
    ${s.error?`<div class="it2-smart-error">${esc(s.error)}</div>`:''}
    ${s.candidates.length?`<div class="it2-origin-results">${s.candidates.map(candidateHtml).join('')}</div>`:''}
    <div class="helper">地址直接在 App 內設定即可，不需要貼到 Chat。若已啟用既有 Cloud Sync，此 setting 會依既有同步機制同步到同一家庭 workspace。</div>
    ${saved?'<button class="btn ghost" data-it2-settings-origin-clear>清除預設出發地</button>':''}
  </div>`;
}

async function injectSettingsBlock() {
  if (!modalRoot || modalRoot.hidden) return;
  if (modalRoot.querySelector('.modal-title')?.textContent?.trim() !== '設定與資料') return;
  await loadDefaultOrigin();
  const head=modalRoot.querySelector('.modal-head');
  if(!head) return;
  modalRoot.querySelector('#it2SettingsOriginBlock')?.remove();
  head.insertAdjacentHTML('afterend',settingsBlockHtml());
}

function refreshSettingsBlock() {
  const block=modalRoot?.querySelector('#it2SettingsOriginBlock');
  if(block) block.outerHTML=settingsBlockHtml();
}

async function searchOrigin() {
  if(state.search.loading) return;
  const query=String(document.getElementById('it2SettingsOriginQuery')?.value ?? state.search.query).trim();
  state.search.query=query;
  if(query.length<2){state.search.error='請輸入至少 2 個字的地址、社區或地標。';refreshSettingsBlock();return;}
  state.search.loading=true;state.search.error='';state.search.candidates=[];refreshSettingsBlock();
  try{
    const response=await fetch('/api/itinerary-origin-search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query})});
    const body=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(body.message||body.error||`地址搜尋失敗 (${response.status})`);
    state.search.candidates=Array.isArray(body.candidates)?body.candidates:[];
    if(!state.search.candidates.length) state.search.error='沒有找到可定位的地址，請改用完整地址或附近地標。';
  }catch(error){state.search.error=`目前無法搜尋出發地：${error.message||'請稍後再試'}`;}
  finally{state.search.loading=false;refreshSettingsBlock();}
}

async function chooseOrigin(index) {
  const c=state.search.candidates?.[Number(index)];if(!c)return;
  const origin=normalizeTripLocation({kind:'home',label:'家',placeId:c.placeId,address:c.address,latitude:c.latitude,longitude:c.longitude,googleMapsUrl:c.googleMapsUrl,source:'google-places'},'home');
  if(!origin)return;
  await TwinDB.put('settings',{key:'defaultOrigin',value:origin});
  setGlobalOrigin(origin);resetSearch();refreshSettingsBlock();decorateCurrentScreen();
}

async function clearOrigin() {
  await TwinDB.remove('settings','defaultOrigin');
  setGlobalOrigin(null);resetSearch();refreshSettingsBlock();decorateCurrentScreen();
}

function createHintHtml() {
  const o=state.defaultOrigin;
  return `<div class="it2-origin-card" id="it2TripOriginHint">
    <div class="it2-origin-current"><div><span>這趟出發地</span><strong>${esc(o?.label||'尚未設定')}</strong><small>${esc(o?.address||'請先從右上角「設定」建立預設出發地')}</small></div></div>
    <div class="it2-origin-helper">J2B-1 只保存真實起點／終點；尚未計算道路車程或最佳順序。${o?'新行程會自動帶入這個位置。':'設定後請重新建立新行程，舊行程不會被自動改寫。'}</div>
  </div>`;
}

function decorateCreate() {
  const screen=root?.querySelector('[data-it2-screen="create"]');if(!screen)return;
  screen.querySelector('#it2TripOriginHint')?.remove();
  const form=screen.querySelector('.it2-form-card');
  if(form) form.insertAdjacentHTML('afterend',createHintHtml());
}

async function originForActiveArrange() {
  if(state.newDraftActive) return {origin:state.defaultOrigin,destination:state.defaultOrigin};
  if(!state.activeTripId) return {origin:null,destination:null};
  const trip=await TwinDB.get('itineraries',state.activeTripId).catch(()=>null);
  return {
    origin:normalizeTripLocation(trip?.origin,'home'),
    destination:normalizeTripLocation(trip?.destination,trip?.origin?.kind||'home')
  };
}

async function decorateArrange() {
  const screen=root?.querySelector('[data-it2-screen="arrange"]');if(!screen)return;
  const seq=++state.renderSeq;
  const {origin,destination}=await originForActiveArrange();
  if(seq!==state.renderSeq || !root?.querySelector('[data-it2-screen="arrange"]'))return;
  const fixed=[...screen.querySelectorAll('.it2-fixed-stop')];if(fixed.length<2)return;
  const firstStrong=fixed[0].querySelector('strong'),firstSmall=fixed[0].querySelector('small');
  const lastStrong=fixed.at(-1).querySelector('strong'),lastSmall=fixed.at(-1).querySelector('small');
  const time=(firstStrong?.textContent||'09:00').match(/\b\d{1,2}:\d{2}\b/)?.[0]||'09:00';
  if(firstStrong) firstStrong.textContent=`${time} 出發｜${origin?.label||'出發地未設定'}`;
  if(firstSmall) firstSmall.textContent=origin?.address||'J2B-1 尚未設定實際出發位置';
  if(lastStrong) lastStrong.textContent=destination?.label||'終點未設定';
  if(lastSmall) lastSmall.textContent=destination?.address||'J2B-2 才會參與返程路線計算';
  const note=screen.querySelector('.it2-builder-note');
  if(note) note.textContent='目前 J2B-1 已保存真實起點／終點，但還沒有計算道路車程或最佳順序；J2B-2 才會接 Route Matrix。';
}

function decorateCurrentScreen(){
  if(root?.querySelector('[data-it2-screen="create"]')) decorateCreate();
  if(root?.querySelector('[data-it2-screen="arrange"]')) void decorateArrange();
}

// Itinerary V2 swaps the whole #app surface per screen. Observe only those root-level
// swaps so our own origin decorations cannot recursively trigger the observer.
const observer=new MutationObserver(()=>decorateCurrentScreen());
if(root) observer.observe(root,{childList:true});

settingsButton?.addEventListener('click',()=>{resetSearch();setTimeout(()=>void injectSettingsBlock(),0);});

document.addEventListener('input',event=>{
  if(event.target?.id==='it2SettingsOriginQuery') state.search.query=event.target.value||'';
},true);

document.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.matches('[data-it2-settings-origin-search]')){event.preventDefault();return void searchOrigin();}
  if(button.matches('[data-it2-settings-origin-pick]')){event.preventDefault();return void chooseOrigin(button.dataset.it2SettingsOriginPick);}
  if(button.matches('[data-it2-settings-origin-clear]')){event.preventDefault();return void clearOrigin();}

  if(button.matches('[data-it2-new]')){
    state.activeTripId=undefined;state.newDraftActive=true;
    if(!state.loaded){
      event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
      void loadDefaultOrigin().finally(()=>button.click());
    }
    return;
  }
  if(button.matches('[data-it2-open]')){state.activeTripId=button.dataset.it2Open;state.newDraftActive=false;return;}
  if(button.matches('[data-it2-back-list]')){state.activeTripId=undefined;state.newDraftActive=false;return;}
},true);

void loadDefaultOrigin().then(()=>decorateCurrentScreen());

window.TwinItineraryOrigin=Object.freeze({
  version:'J2B-1',
  reload:loadDefaultOrigin,
  getDefault:()=>state.defaultOrigin?{...state.defaultOrigin}:null
});
