import { webkit } from 'playwright';
import assert from 'node:assert/strict';

const baseURL = process.env.J2C_BASE_URL || 'http://127.0.0.1:4173';

function fakeRouteBody(keys = []) {
  const [a, b] = keys;
  const legs = [
    { fromKey:'origin', toKey:a, fromTitle:'家', toTitle:'A 餐廳', durationSeconds:600, distanceMeters:6000 },
    { fromKey:a, toKey:b, fromTitle:'A 餐廳', toTitle:'B 公園', durationSeconds:900, distanceMeters:9000 },
    { fromKey:b, toKey:'origin', fromTitle:'B 公園', toTitle:'家', durationSeconds:1200, distanceMeters:12000 }
  ];
  return {
    provider:'google-routes',
    matrixVersion:1,
    travelMode:'DRIVE',
    routingPreference:'TRAFFIC_UNAWARE',
    strategy:'nearest-neighbor+2opt',
    requestedStopKeys:[a,b],
    orderedStopKeys:[a,b],
    current:{orderedStopKeys:[a,b],totalDurationSeconds:2700,totalDistanceMeters:27000,legs},
    suggested:{orderedStopKeys:[a,b],totalDurationSeconds:2700,totalDistanceMeters:27000,legs},
    savingsSeconds:0,
    savingsMeters:0,
    elementCount:9,
    generatedAt:'2026-09-09T09:00:00.000Z'
  };
}

async function run(viewport, label) {
  const browser = await webkit.launch();
  const context = await browser.newContext({ viewport, serviceWorkers:'block' });
  const page = await context.newPage();
  const errors = [];
  let routeRequests = 0;

  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/api/itinerary-route-matrix', async route => {
    routeRequests += 1;
    const body = JSON.parse(route.request().postData() || '{}');
    assert.equal(body?.origin?.placeId, 'HOME_J2C', `${label}: origin missing`);
    assert.equal(body?.stops?.length, 2, `${label}: stops count mismatch`);
    await route.fulfill({
      status:200,
      contentType:'application/json',
      body:JSON.stringify(fakeRouteBody(body.stops.map(stop => stop.key)))
    });
  });

  const nav = await page.goto(baseURL, { waitUntil:'networkidle' });
  assert.ok(nav?.ok(), `${label}: navigation failed`);
  await page.waitForFunction(() => !!window.TwinDB && !!window.TwinItineraryV2 && !!window.TwinItineraryRoute && !!window.TwinItineraryTimeline && !!window.TwinItineraryTimelineInputSync && !!window.TwinItineraryDurationSmart);

  await page.evaluate(async () => {
    await TwinDB.put('itineraries', {
      id:'j2c-timeline-trip',
      model:'itinerary-v2',
      modelVersion:2,
      status:'planned',
      title:'J2C 時間軸測試',
      date:'2026-09-21',
      departureTime:'09:00',
      origin:{kind:'home',label:'家',placeId:'HOME_J2C',address:'新竹市測試路 1 號',latitude:24.80,longitude:120.99,source:'google-places'},
      destination:{kind:'home',label:'家',placeId:'HOME_J2C',address:'新竹市測試路 1 號',latitude:24.80,longitude:120.99,source:'google-places'},
      scheduleSchemaVersion:null,
      stops:[
        {id:'sA',kind:'external',candidateKey:'place:A',source:'external',placeId:'A',title:'A 餐廳',entityType:'restaurant',latitude:24.81,longitude:121.00,address:'新竹市 A 路 1 號',googleMapsUrl:'',rating:null,userRatingCount:null,plannedTime:'',note:'',order:0},
        {id:'sB',kind:'external',candidateKey:'place:B',source:'external',placeId:'B',title:'B 公園',entityType:'attraction',latitude:24.82,longitude:121.01,address:'新竹市 B 路 2 號',googleMapsUrl:'',rating:null,userRatingCount:null,plannedTime:'',note:'',order:1}
      ],
      plannerInput:null,
      createdAt:'2026-09-09T08:00:00.000Z',
      updatedAt:'2026-09-09T08:00:00.000Z'
    });
  });

  await page.click('button[data-view="trips"]');
  await page.waitForSelector('[data-it2-screen="list"]');
  await page.getByText('J2C 時間軸測試').click();
  await page.waitForSelector('[data-it2-screen="arrange"]');
  await page.waitForSelector('#j2cTimelineCard');
  assert.equal(routeRequests, 0, `${label}: timeline caused provider call before explicit route action`);
  assert.match(await page.locator('#j2cTimelineCard').innerText(), /先完成上方/, `${label}: pre-route timeline guidance missing`);

  await page.click('[data-j2b2-calc]');
  await page.waitForFunction(() => document.querySelectorAll('[data-j2c-duration]').length === 2);
  await page.waitForFunction(() => {
    const values = [...document.querySelectorAll('[data-j2c-duration]')].map(node => node.value);
    return values[0] === '75' && values[1] === '90';
  });
  assert.equal(routeRequests, 1, `${label}: explicit route call count mismatch`);
  assert.match(await page.locator('#j2cTimelineCard').innerText(), /12:30/, `${label}: smart default return ETA mismatch`);
  assert.match(await page.locator('#j2cTimelineCard').innerText(), /依景點／餐廳／活動類型/, `${label}: smart duration guidance missing`);
  assert.equal(await page.evaluate(() => TwinItineraryTimeline.isApplied()), false, `${label}: timeline applied silently before user save`);

  // Real-device path from user feedback: edit a focused number field and tap the
  // main Save directly. No separate “套用此時間軸” click is required.
  await page.evaluate(() => {
    const input = document.querySelector('[data-j2c-duration]');
    input.value = '60';
    input.dispatchEvent(new Event('input', { bubbles:true }));
  });
  await page.waitForFunction(() => document.querySelector('#j2cTimelineCard')?.innerText.includes('12:15'));

  const rowText = await page.locator('.j2c-stop-schedule').allTextContents();
  assert.match(rowText[0], /09:10 到達/, `${label}: first arrival missing`);
  assert.match(rowText[0], /10:10 離開/, `${label}: first departure missing`);
  assert.match(rowText[1], /10:25 到達/, `${label}: second arrival missing`);
  assert.match(rowText[1], /11:55 離開/, `${label}: second departure missing`);
  assert.ok(await page.locator('[data-j2c-apply]').count(), `${label}: test must cover direct-save path while Apply is still available`);

  await page.click('[data-it2-save]');
  await page.waitForSelector('[data-it2-screen="list"]');
  const saved = await page.evaluate(() => TwinDB.get('itineraries', 'j2c-timeline-trip'));
  assert.equal(saved?.modelVersion, 2, `${label}: itinerary modelVersion changed`);
  assert.equal(saved?.scheduleSchemaVersion, 1, `${label}: schedule schema not activated by direct Save`);
  assert.equal(saved?.schedulePlan?.provider, 'google-routes', `${label}: schedule provider missing`);
  assert.equal(saved?.schedulePlan?.source, 'road-time+manual-dwell', `${label}: schedule source mismatch`);
  assert.equal(saved?.schedulePlan?.returnTime, '12:15', `${label}: direct-save return ETA mismatch`);
  assert.deepEqual(saved?.schedulePlan?.stopKeys, ['place:A','place:B'], `${label}: schedule stop order mismatch`);
  assert.equal(saved?.schedulePlan?.stops?.[0]?.durationMinutes, 60, `${label}: edited first dwell reverted`);
  assert.equal(saved?.schedulePlan?.stops?.[1]?.durationMinutes, 90, `${label}: smart second dwell not persisted`);
  assert.equal(saved?.stops?.[0]?.plannedTime, '09:10', `${label}: first plannedTime not persisted`);
  assert.equal(saved?.stops?.[1]?.plannedTime, '10:25', `${label}: second plannedTime not persisted`);
  assert.equal(saved?.routePlan?.provider, 'google-routes', `${label}: J2B routePlan lost during J2C save`);

  await page.getByText('J2C 時間軸測試').click();
  await page.waitForSelector('[data-it2-screen="arrange"]');
  await page.waitForFunction(() => document.querySelector('#j2cTimelineCard')?.innerText.includes('12:15'));
  await page.waitForFunction(() => {
    const values = [...document.querySelectorAll('[data-j2c-duration]')].map(node => node.value);
    return values[0] === '60' && values[1] === '90';
  });
  assert.equal(routeRequests, 1, `${label}: persisted timeline caused an automatic provider call`);
  assert.equal(await page.evaluate(() => TwinItineraryTimeline.isApplied()), true, `${label}: persisted applied schedule not restored`);
  assert.match(await page.locator('#j2cTimelineCard').innerText(), /已套用到行程草稿/, `${label}: persisted schedule status missing`);

  if (errors.length) throw new Error(`${label}: browser errors: ${errors.join(' | ')}`);
  console.log(`${label}: smart defaults -> focused manual edit -> direct Save -> persist -> restore = PASS`);
  await context.close();
  await browser.close();
}

await run({width:390,height:844}, 'mobile');
await run({width:1280,height:900}, 'desktop');
console.log('J2C-1.2 SMART DURATION + DIRECT-SAVE REAL-DEVICE GATE = PASS');
