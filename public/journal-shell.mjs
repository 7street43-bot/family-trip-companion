const listeners=new Map();
const state={open:false,tab:'quick',pending:0,selectedEntryId:null,renderEpoch:0};
let commands={open:null,close:null};

function snapshot(){return {...state};}
function emit(type,detail={}){for(const fn of listeners.get(type)||[]){try{fn(detail,snapshot());}catch(err){console.error('Journal shell listener failed',type,err);}}}
function on(type,fn){if(typeof fn!=='function')throw new TypeError('listener must be a function');if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);return()=>listeners.get(type)?.delete(fn);}
function patch(next,type='state'){
  let changed=false;
  for(const [key,value] of Object.entries(next||{})){if(state[key]!==value){state[key]=value;changed=true;}}
  if(changed){const snap=snapshot();emit(type,snap);if(type!=='state')emit('state',snap);}
  return changed;
}
function runtimeVersion(){return String(globalThis.TwinRuntime?.version||'unknown');}
function registerCommands(next={}){commands={open:typeof next.open==='function'?next.open:commands.open,close:typeof next.close==='function'?next.close:commands.close};}
async function open(){if(!commands.open)throw new Error('journal_open_not_registered');return commands.open();}
async function close(){if(!commands.close)return false;return commands.close();}
function setOpen(open){return patch({open:!!open},'open');}
function setTab(tab){if(!['quick','history','search'].includes(tab))return false;return patch({tab},'tab');}
function setPending(pending){const n=Math.max(0,Number(pending)||0);return patch({pending:n},'pending');}
function setSelectedEntryId(id){return patch({selectedEntryId:id?String(id):null},'selection');}
function rendered(detail={}){state.renderEpoch+=1;emit('rendered',{...detail,renderEpoch:state.renderEpoch},snapshot());}

const api=Object.freeze({on,snapshot,runtimeVersion,registerCommands,open,close,setOpen,setTab,setPending,setSelectedEntryId,rendered});
if(typeof window!=='undefined')window.TwinJournalShell=api;
export default api;
export const __test={snapshot,patch};
