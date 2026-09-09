import { webkit } from 'playwright';
import assert from 'node:assert/strict';

const baseURL = process.env.J2B_BASE_URL || 'http://127.0.0.1:4173';

async function run(viewport,label){
  const browser=await webkit.launch();
  const context=await browser.newContext({viewport,serviceWorkers:'block'});
  const page=await context.newPage();
  const errors=[];
  let originRequests=0;
  page.on('pageerror',err=>errors.push(String(err)));
  page.route('**/api/itinerary-origin-search',async route=>{
    originRequests++;
    const body=JSON.parse(route.request().postData()||'{}');
    assert.ok(String(body.query||'').includes('富春居'),`${label}: origin query missing`);
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({provider:'google-places',query:body.query,candidates:[{
      placeId:'HOME_001',displayName:'富春居',address:'新竹市東區測試路 100 號',latitude:24.80,longitude:120.99,googleMapsUrl:'https://maps.google.com/?q=HOME_001',primaryType:'premise',rank:0
    }]})});
  });

  const nav=await page.goto(baseURL,{waitUntil:'networkidle'});
  assert.ok(nav?.ok(),`${label}: navigation failed`);
  await page.waitForFunction(()=>!!window.TwinDB&&!!window.TwinItineraryV2&&!!window.TwinItineraryOrigin);

  await page.click('#settingsBtn');
  await page.waitForSelector('#it2SettingsOriginBlock');
  await page.fill('#it2SettingsOriginQuery','富春居');
  await page.click('[data-it2-settings-origin-search]');
  await page.waitForSelector('[data-it2-settings-origin-pick="0"]');
  assert.equal(originRequests,1,`${label}: origin provider call count mismatch`);
  await page.click('[data-it2-settings-origin-pick="0"]');
  await page.waitForFunction(()=>document.querySelector('#it2SettingsOriginBlock')?.innerText.includes('新竹市東區測試路 100 號'));

  const savedSetting=await page.evaluate(()=>TwinDB.get('settings','defaultOrigin'));
  assert.equal(savedSetting?.value?.placeId,'HOME_001',`${label}: defaultOrigin not persisted`);
  assert.equal(savedSetting?.value?.kind,'home',`${label}: defaultOrigin kind mismatch`);

  await page.click('[data-close-modal]');
  await page.click('button[data-view="trips"]');
  await page.waitForSelector('[data-it2-screen="list"]');
  await page.click('[data-it2-new]');
  await page.waitForSelector('[data-it2-screen="create"]');
  await page.waitForFunction(()=>document.querySelector('#it2TripOriginHint')?.innerText.includes('新竹市東區測試路 100 號'));
  await page.fill('#it2Title','J2B 起點測試');
  await page.click('[data-it2-to-pick]');
  await page.fill('#it2Custom','測試景點');
  await page.click('[data-it2-add-custom]');
  await page.click('[data-it2-to-arrange]');
  await page.waitForSelector('[data-it2-screen="arrange"]');
  const arrangeText=await page.locator('.it2-timeline').innerText();
  assert.match(arrangeText,/家/,`${label}: arrange origin label missing`);
  assert.match(arrangeText,/新竹市東區測試路 100 號/,`${label}: arrange origin address missing`);
  await page.click('[data-it2-save]');
  await page.waitForSelector('[data-it2-screen="list"]');

  const savedTrip=await page.evaluate(async()=>{
    const rows=await TwinDB.getAll('itineraries');
    return rows.find(x=>x.model==='itinerary-v2'&&x.title==='J2B 起點測試');
  });
  assert.equal(savedTrip?.modelVersion,2,`${label}: model version changed`);
  assert.equal(savedTrip?.origin?.placeId,'HOME_001',`${label}: trip origin not persisted`);
  assert.equal(savedTrip?.destination?.placeId,'HOME_001',`${label}: trip destination not persisted`);
  assert.equal(savedTrip?.scheduleSchemaVersion,null,`${label}: route scheduler activated too early`);

  await page.evaluate(async()=>{
    await TwinDB.put('settings',{key:'defaultOrigin',value:{kind:'home',label:'新家',placeId:'HOME_002',address:'新竹市另一條路 2 號',latitude:24.81,longitude:121.01,source:'manual'}});
    await TwinItineraryOrigin.reload();
  });
  await page.getByText('J2B 起點測試').click();
  await page.waitForSelector('[data-it2-screen="arrange"]');
  const reopened=await page.locator('.it2-timeline').innerText();
  assert.match(reopened,/新竹市東區測試路 100 號/,`${label}: existing trip origin was silently replaced`);
  assert.doesNotMatch(reopened,/新竹市另一條路 2 號/,`${label}: existing trip leaked new default origin`);

  if(errors.length) throw new Error(`${label}: browser errors: ${errors.join(' | ')}`);
  console.log(`${label}: J2B-1 origin settings -> new trip persistence -> no retrofit = PASS`);
  await context.close();
  await browser.close();
}

await run({width:390,height:844},'mobile');
await run({width:1280,height:900},'desktop');
console.log('J2B-1 WEBKIT ORIGIN UX GATE = PASS');
