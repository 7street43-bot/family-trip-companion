const VERSION='4.5.0-phase1.6-j1g.7';

function journalBody(){return document.querySelector('#journalOverlay .journal-body');}
function setTextIfChanged(el,text){if(el&&el.textContent!==text)el.textContent=text;}

export function resetJournalScroll(){
  const body=journalBody();
  if(!body)return false;
  body.scrollTop=0;
  try{body.scrollTo({top:0,left:0,behavior:'auto'});}catch(_){/* scrollTop above is the fallback */}
  return true;
}

function syncVisibleVersion(){
  const subtitle=document.getElementById('brandSubtitle');
  setTextIfChanged(subtitle,`家庭出遊小幫手 ${VERSION}`);
  const small=document.querySelector('#journalOverlay .journal-head-copy small');
  setTextIfChanged(small,`手機紀錄與回顧｜${VERSION}`);
}

function afterTabChange(){
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    resetJournalScroll();
    syncVisibleVersion();
  }));
}

function mount(){
  document.addEventListener('click',ev=>{
    if(ev.target.closest?.('[data-journal-tab]'))setTimeout(afterTabChange,0);
  });
  // J1G.7: body mutations may include our own version text updates. Only writing
  // when text actually differs prevents a MutationObserver self-trigger loop
  // from starving the main App async boot/render path on iOS Safari.
  const observer=new MutationObserver(()=>queueMicrotask(syncVisibleVersion));
  observer.observe(document.body,{childList:true,subtree:true});
  syncVisibleVersion();
}

if(typeof document!=='undefined'){
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});
  else mount();
}

export const __test={VERSION,setTextIfChanged};
