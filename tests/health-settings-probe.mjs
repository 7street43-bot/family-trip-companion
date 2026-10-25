import assert from 'node:assert/strict';
import {webkit} from 'playwright';

const base=process.env.HEALTH_BASE_URL||'http://127.0.0.1:4173';
const browser=await webkit.launch();
let failures=0;
try {
 for(const p of [
  {name:'mobile',viewport:{width:390,height:844},isMobile:true},
  {name:'desktop',viewport:{width:1280,height:900},isMobile:false}
 ]){
  const context=await browser.newContext({viewport:p.viewport,isMobile:p.isMobile,hasTouch:p.isMobile,serviceWorkers:'block'});
  const page=await context.newPage();
  const errors=[];
  const clickStages=[];
  page.on('console',msg=>{if(msg.text().startsWith('HEALTH_CLICK_') || msg.text().startsWith('HEALTH_SETTING_'))clickStages.push(msg.text());});
  page.on('dialog',dialog=>{clickStages.push('DIALOG:'+dialog.type());dialog.dismiss().catch(()=>{});});
  await page.addInitScript(()=>{
    document.addEventListener('pointerdown',event=>{if(event.target.closest?.('#settingsBtn'))console.log('HEALTH_CLICK_POINTER');},true);
    document.addEventListener('click',event=>{if(event.target.closest?.('#settingsBtn'))console.log('HEALTH_CLICK_CAPTURE');},true);
    document.addEventListener('click',event=>{if(event.target.closest?.('#settingsBtn'))console.log('HEALTH_CLICK_BUBBLE');});
  });
  page.on('pageerror',e=>errors.push(String(e?.message||e)));
  await page.goto(base,{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForFunction(()=>!!window.TwinDB,{timeout:20000});
  await page.waitForFunction(()=>document.querySelector('#app')?.children.length>0 && !!document.querySelector('button[data-view="home"].active'),null,{timeout:20000});
  let outcome='PASS',extra=null;
  try{
   await page.locator('#settingsBtn').click({timeout:6500,noWaitAfter:true});
   await page.locator('#modalRoot:not([hidden])').waitFor({timeout:4000});
   const text=await page.locator('#modalRoot').innerText();
   assert.ok(text.includes('設定與資料'),'settings modal has wrong title');
   await page.locator('#modalRoot [data-close-modal]').first().click({timeout:4000,noWaitAfter:true});
  }catch(e){
   failures++;
   outcome='FAIL';
   extra=String(e?.message||e).slice(0,420);
  }
  let modalState='unread';
  try {
    modalState=await Promise.race([
      page.evaluate(()=>({
        hidden:document.getElementById('modalRoot')?.hidden,
        hasTitle:document.getElementById('modalRoot')?.innerText?.includes('設定與資料'),
        bodyOverflow:document.body.style.overflow
      })),
      new Promise(resolve=>setTimeout(()=>resolve('probe-timeout'),1500))
    ]);
  } catch(e) {modalState='probe-error:'+String(e?.message||e).slice(0,100);}
  const evidence={profile:p.name,outcome,error:extra,modalState,clickStages,pageErrors:errors.slice(0,4)};
  console.log('HEALTH_SETTINGS_PROBE '+JSON.stringify(evidence));
  await context.close();
 }
}finally{await browser.close();}
if(failures)process.exitCode=1;
else console.log('HEALTH_SETTINGS_PASS');
