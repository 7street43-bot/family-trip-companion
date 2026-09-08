import journalShell from './journal-shell.mjs';

function journalBody(){return document.querySelector('#journalOverlay .journal-body');}
export function resetJournalScroll(){const body=journalBody();if(!body)return false;body.scrollTop=0;try{body.scrollTo({top:0,left:0,behavior:'auto'});}catch(_){/* scrollTop above is the fallback */}return true;}
function afterTabChange(){requestAnimationFrame(()=>requestAnimationFrame(resetJournalScroll));}
function mount(){journalShell.on('tab',afterTabChange);}
if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();}
export const __test={resetJournalScroll};
