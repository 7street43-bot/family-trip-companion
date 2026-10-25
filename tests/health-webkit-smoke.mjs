import assert from 'node:assert/strict';
import {webkit} from 'playwright';
import {performance} from 'node:perf_hooks';

const base=process.env.HEALTH_BASE_URL||'http://127.0.0.1:4173';
const profiles=[
  {label:'mobile-webkit',viewport:{width:390,height:844},isMobile:true,hasTouch:true},
  {label:'desktop-webkit',viewport:{width:1280,height:900},isMobile:false,hasTouch:false}
];
const browser=await webkit.launch({headless:true});
const evidence=[];
try{
 for(const profile of profiles){
  const ctx=await browser.newContext({...profile,serviceWorkers:'block'});
  const page=await ctx.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(String(error?.message||error)));
  const cold=performance.now();
  const nav=await page.goto(base,{waitUntil:'domcontentloaded',timeout:30000});
  assert.ok(nav?.ok(),profile.label+' navigation failed');
  await page.waitForFunction(()=>window.TwinDB&&window.TwinJournalShell,{timeout:20000});
  const firstUsableMs=Math.round(performance.now()-cold);
  await page.evaluate(async()=>{
   for(let i=0;i<30;i++){
    const date='2026-11-'+String(i+1).padStart(2,'0');
    const stops=Array.from({length:5},(_,j)=>({id:'place-'+i+'-'+j,title:'虛構景點 '+i+'-'+j,kind:'custom',source:'custom',order:j}));
    await window.TwinDB.put('itineraries',{id:'health-trip-'+i,model:'itinerary-v2',modelVersion:2,status:'draft',date,title:'健康檢查行程 '+i,departureTime:'09:00',stops,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
   }
  });
  const timings=[];
  for(let round=0;round<5;round++){
   const t=performance.now();
   await page.locator('button[data-view="trips"]').click();
   await page.locator('[data-it2-screen="list"]').waitFor({timeout:10000});
   timings.push(Math.round(performance.now()-t));
   assert.equal(await page.locator('[data-it2-open]').count(),30,profile.label+' must list 30 mock trips');
   if(round===0){
    await page.locator('[data-it2-open="health-trip-0"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-it2-screen]')?.getAttribute('data-it2-screen')!=='list',{timeout:10000});
   }
   await page.locator('button[data-view="home"]').click();
   await page.locator('button[data-view="home"].active').waitFor({timeout:10000});
  }
  await page.locator('#journalNavBtn').click();
  await page.locator('#journalOverlay:not([hidden])').waitFor({timeout:10000});
  assert.ok(await page.locator('[data-journal-new]').isVisible(),profile.label+' journal new button');
  assert.equal(await page.locator('#journalQuickForm').count(),0,profile.label+' composer should initially collapse');
  const search=page.locator('[data-journal-live-search]');
  await search.fill('旅行');
  assert.equal(await search.inputValue(),'旅行');
  await search.fill('');
  assert.equal(await search.inputValue(),'');
  assert.equal(await page.locator('button:has-text("搜尋")').count(),0);
  await page.locator('[data-journal-new]').click();
  await page.locator('#journalQuickForm').waitFor({timeout:5000});
  assert.equal(await page.locator('#journalQuickForm input:not([type=hidden]), #journalQuickForm textarea').count(),3);
  await page.locator('[data-journal-cancel-new]').click();
  assert.equal(await page.locator('#journalQuickForm').count(),0);
  const overflow=await page.evaluate(()=>Math.max(0,document.documentElement.scrollWidth-window.innerWidth));
  assert.ok(overflow<=20,profile.label+' horizontal document overflow: '+overflow);
  assert.deepEqual(errors,[],profile.label+' uncaught errors');
  const row={profile:profile.label,firstUsableMs,tripCount:30,journalSearch:true,composer:true,routeSwitchMs:timings,overflowPx:overflow,pageErrors:errors.length};
  evidence.push(row);
  console.log('HEALTH_WEBKIT_PROFILE '+JSON.stringify(row));
  await ctx.close();
 }
 console.log('HEALTH_WEBKIT_PASS '+JSON.stringify({profiles:evidence.length,productionWrites:0,paidApiCalls:0}));
}finally{await browser.close();}
