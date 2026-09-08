(() => {
  'use strict';
  const state={registration:null,refreshOnController:false,mounted:false};
  function ensureBanner(){
    let el=document.getElementById('appUpdateBanner');
    if(el)return el;
    el=document.createElement('div');
    el.id='appUpdateBanner';
    el.className='app-update-banner';
    el.hidden=true;
    el.innerHTML='<span>已有新版可用</span><button type="button" data-apply-app-update>重新載入</button>';
    document.body.appendChild(el);
    el.addEventListener('click',ev=>{if(ev.target.closest?.('[data-apply-app-update]'))applyUpdate();});
    return el;
  }
  function show(){ensureBanner().hidden=false;}
  function hide(){const el=document.getElementById('appUpdateBanner');if(el)el.hidden=true;}
  function waitingWorker(){return state.registration?.waiting||null;}
  function watchInstalling(worker){if(!worker)return;worker.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)show();});}
  async function register(){
    if(!('serviceWorker'in navigator))return null;
    if(state.registration)return state.registration;
    const reg=await navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'});
    state.registration=reg;
    if(reg.waiting&&navigator.serviceWorker.controller)show();
    reg.addEventListener('updatefound',()=>watchInstalling(reg.installing));
    navigator.serviceWorker.addEventListener('controllerchange',()=>{if(!state.refreshOnController)return;state.refreshOnController=false;location.reload();});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')reg.update().catch(()=>{});});
    window.addEventListener('online',()=>reg.update().catch(()=>{}));
    reg.update().catch(()=>{});
    return reg;
  }
  function applyUpdate(){
    const worker=waitingWorker();
    if(!worker){hide();state.registration?.update().catch(()=>{});return false;}
    state.refreshOnController=true;
    worker.postMessage({type:'SKIP_WAITING'});
    return true;
  }
  function mount(){if(state.mounted)return;state.mounted=true;ensureBanner();}
  if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();}
  window.TwinUpdateManager=Object.freeze({register,applyUpdate});
})();
