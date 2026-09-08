import assert from 'node:assert/strict';
import { webkit } from 'playwright';

const base=process.env.J1K_BASE_URL||'http://127.0.0.1:4173';
const cases=[
  {name:'mobile-webkit',viewport:{width:430,height:932},isMobile:true},
  {name:'desktop-webkit',viewport:{width:1280,height:900},isMobile:false}
];
const browser=await webkit.launch({headless:true});
try{
  for(const c of cases){
    const context=await browser.newContext({viewport:c.viewport,isMobile:c.isMobile,hasTouch:c.isMobile});
    const page=await context.newPage();
    const pageErrors=[];
    page.on('pageerror',e=>pageErrors.push(String(e?.message||e)));
    await page.goto(base,{waitUntil:'domcontentloaded',timeout:20000});
    await page.waitForFunction(()=>document.querySelector('#app')?.textContent?.trim().length>10,{timeout:15000});
    await page.waitForFunction(()=>window.TwinJournalShell&&document.getElementById('journalOverlay'),{timeout:10000});
    assert.equal(await page.locator('#bottomNav .nav-item').count(),5,`${c.name}: five nav items`);

    await page.locator('[data-view="trips"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-view="trips"]')?.classList.contains('active'));

    for(let round=0;round<8;round++){
      await page.locator('#journalNavBtn').click();
      await page.waitForFunction(()=>!document.getElementById('journalOverlay')?.hidden);
      assert.equal(await page.locator('#bottomNav').isVisible(),true,`${c.name}: nav remains visible in Journal`);
      for(const tab of ['history','search','quick']){
        await page.locator(`[data-journal-tab="${tab}"]`).click();
        await page.waitForFunction(t=>document.querySelector(`[data-journal-tab="${t}"]`)?.classList.contains('active'),tab);
        const lag=await page.evaluate(async()=>{const a=performance.now();await new Promise(r=>setTimeout(r,40));return performance.now()-a;});
        assert.ok(lag<700,`${c.name}: event loop responsive after ${tab}: ${lag}ms`);
      }
      await page.locator('[data-view="home"]').click();
      await page.waitForFunction(()=>document.getElementById('journalOverlay')?.hidden===true);
      await page.waitForFunction(()=>document.querySelector('[data-view="home"]')?.classList.contains('active'));
    }
    assert.deepEqual(pageErrors,[],`${c.name}: no uncaught page errors`);
    await context.close();
  }
  console.log('J1K WEBKIT NAV + JOURNAL INTERACTION = PASS');
} finally {
  await browser.close();
}
