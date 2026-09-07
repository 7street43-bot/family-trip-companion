const state={previous:null,mounted:false};

function nav(){return document.getElementById('journalNavBtn');}
function fab(){return document.getElementById('journalFab');}
function overlay(){return document.getElementById('journalOverlay');}
function appNavButtons(){return [...document.querySelectorAll('#bottomNav .nav-item')];}
function currentAppNav(){return appNavButtons().find(b=>b!==nav()&&b.classList.contains('active'))||null;}
function syncPending(){const n=nav(),f=fab();if(!n)return;const p=f?.dataset?.pending;if(p)n.dataset.pending=p;else delete n.dataset.pending;}
function setJournalActive(active){const n=nav();if(!n)return;if(active){if(!state.previous)state.previous=currentAppNav();appNavButtons().forEach(b=>b.classList.toggle('active',b===n));}else{n.classList.remove('active');const restore=state.previous&&document.contains(state.previous)?state.previous:currentAppNav();if(restore)restore.classList.add('active');state.previous=null;}}
function syncOverlay(){const o=overlay();setJournalActive(!!o&&!o.hidden);}
function waitForFab(timeoutMs=2000){return new Promise(resolve=>{const existing=fab();if(existing)return resolve(existing);const started=Date.now();const timer=setInterval(()=>{const f=fab();if(f){clearInterval(timer);resolve(f);return;}if(Date.now()-started>=timeoutMs){clearInterval(timer);resolve(null);}},25);});}
async function openJournal(){const f=await waitForFab();if(!f)return false;state.previous=currentAppNav();f.click();queueMicrotask(syncOverlay);return true;}

function mount(){if(state.mounted)return;state.mounted=true;const n=nav();if(!n)return;n.disabled=false;n.addEventListener('click',async ev=>{ev.preventDefault();ev.stopPropagation();n.setAttribute('aria-busy','true');try{if(!(await openJournal())){n.dataset.error='journal-not-ready';console.error('Journal UI did not become ready within 2 seconds.');}}finally{n.removeAttribute('aria-busy');}});const observer=new MutationObserver(()=>{syncPending();syncOverlay();});observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','data-pending']});syncPending();syncOverlay();}

if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();}

export const __test={setJournalActive,openJournal,waitForFab};
