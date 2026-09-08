import journalShell from './journal-shell.mjs';

const state={previous:null,mounted:false};
function nav(){return document.getElementById('journalNavBtn');}
function appNavButtons(){return [...document.querySelectorAll('#bottomNav .nav-item')];}
function currentAppNav(){return appNavButtons().find(b=>b!==nav()&&b.classList.contains('active'))||null;}
function syncPending(pending=journalShell.snapshot().pending){const n=nav();if(!n)return;const p=Number(pending)||0;if(p){const s=String(p);if(n.dataset.pending!==s)n.dataset.pending=s;}else if(n.dataset.pending!==undefined){delete n.dataset.pending;}}
function setJournalActive(active){const n=nav();if(!n)return;if(active){if(!state.previous)state.previous=currentAppNav();appNavButtons().forEach(b=>b.classList.toggle('active',b===n));}else{n.classList.remove('active');const restore=state.previous&&document.contains(state.previous)?state.previous:currentAppNav();if(restore)restore.classList.add('active');state.previous=null;}}
async function openJournal(){state.previous=currentAppNav();return journalShell.open();}
function closeJournalForAppNav(target){const btn=target?.closest?.('#bottomNav .nav-item'),n=nav();if(!btn||btn===n||!journalShell.snapshot().open)return false;state.previous=null;journalShell.close().catch(()=>{});return true;}

function mount(){
  if(state.mounted)return;state.mounted=true;
  const n=nav();if(!n)return;
  n.disabled=false;
  n.addEventListener('click',async ev=>{ev.preventDefault();ev.stopPropagation();n.setAttribute('aria-busy','true');try{await openJournal();}catch(err){n.dataset.error='journal-not-ready';console.error('Journal UI open failed',err);}finally{n.removeAttribute('aria-busy');}});
  document.getElementById('bottomNav')?.addEventListener('click',ev=>{closeJournalForAppNav(ev.target);},true);
  journalShell.on('open',(_,snap)=>setJournalActive(snap.open));
  journalShell.on('pending',(_,snap)=>syncPending(snap.pending));
  const snap=journalShell.snapshot();syncPending(snap.pending);setJournalActive(snap.open);
}

if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();}
export const __test={setJournalActive,openJournal,syncPending,closeJournalForAppNav};
