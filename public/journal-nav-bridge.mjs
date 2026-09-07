const state={previous:null,mounted:false};

function nav(){return document.getElementById('journalNavBtn');}
function fab(){return document.getElementById('journalFab');}
function overlay(){return document.getElementById('journalOverlay');}
function appNavButtons(){return [...document.querySelectorAll('#bottomNav .nav-item')];}
function currentAppNav(){return appNavButtons().find(b=>b!==nav()&&b.classList.contains('active'))||null;}
function syncPending(){const n=nav(),f=fab();if(!n||!f)return;const p=f.dataset.pending;if(p)n.dataset.pending=p;else delete n.dataset.pending;}
function setJournalActive(active){const n=nav();if(!n)return;if(active){if(!state.previous)state.previous=currentAppNav();appNavButtons().forEach(b=>b.classList.toggle('active',b===n));}else{n.classList.remove('active');const restore=state.previous&&document.contains(state.previous)?state.previous:currentAppNav();if(restore)restore.classList.add('active');state.previous=null;}}
function syncOverlay(){const o=overlay();setJournalActive(!!o&&!o.hidden);}
function openJournal(){const f=fab();if(!f)return false;state.previous=currentAppNav();f.click();queueMicrotask(syncOverlay);return true;}

function mount(){if(state.mounted)return;state.mounted=true;const n=nav();if(!n)return;n.disabled=!fab();n.addEventListener('click',()=>{if(!openJournal())n.disabled=true;});const observer=new MutationObserver(()=>{n.disabled=!fab();syncPending();syncOverlay();});observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','data-pending']});syncPending();syncOverlay();}

if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();}

export const __test={setJournalActive,openJournal};
