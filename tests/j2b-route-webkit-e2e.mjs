import { webkit } from 'playwright';
import assert from 'node:assert/strict';

const baseURL = process.env.J2B2_BASE_URL || 'http://127.0.0.1:4173';

function fakeRouteBody(requestedStopKeys = []) {
  const [a,b,c] = requestedStopKeys;
  const currentLegs = [
    { fromKey:'origin', toKey:a, fromTitle:'家', toTitle:'A 景點', durationSeconds:600, distanceMeters:6000 },
    { fromKey:a, toKey:b, fromTitle:'A 景點', toTitle:'B 景點', durationSeconds:900, distanceMeters:9000 },
    { fromKey:b, toKey:c, fromTitle:'B 景點', toTitle:'C 景點', durationSeconds:600, distanceMeters:6000 },
    { fromKey:c, toKey:'origin', fromTitle:'C 景點', toTitle:'家', durationSeconds:600, distanceMeters:6000 }
  ];
  const suggestedLegs = [
    { fromKey:'origin', toKey:b, fromTitle:'家', toTitle:'B 景點', durationSeconds:300, distanceMeters:3000 },
    { fromKey:b, toKey:a, fromTitle:'B 景點', toTitle:'A 景點', durationSeconds:300, distanceMeters:3000 },
    { fromKey:a, toKey:c, fromTitle:'A 景點', toTitle:'C 景點', durationSeconds:300, distanceMeters:3000 },
    { fromKey:c, toKey:'origin', fromTitle:'C 景點', toTitle:'家', durationSeconds:300, distanceMeters:3000 }
  ];
  return {
    provider:'google-routes',
    matrixVersion:1,
    travelMode:'DRIVE',
    routingPreference:'TRAFFIC_UNAWARE',
    strategy:'nearest-neighbor+2opt',
    requestedStopKeys:[a,b,c],
    orderedStopKeys:[b,a,c],
    current:{orderedStopKeys:[a,b,c],totalDurationSeconds:2700,totalDistanceMeters:27000,legs:currentLegs},
    suggested:{orderedStopKeys:[b,a,c],totalDurationSeconds:1200,totalDistanceMeters:12000,legs:suggestedLegs},
    savingsSeconds:1500,
    savingsMeters:15000,
    elementCount:16,
    generatedAt:'2026-09-08T14:00:00.000Z'
  };
}

async function run(viewport,label){
  const browser=await webkit.launch();
  const context=await browser.newContext({viewport,serviceWorkers:'block'});
  const page=await context.newPage();
  const errors=[];
  let routeRequests=0;

  page.on('pageerror',err=>errors.push(String(err)));
  await page.route('**/api/itinerary-route-matrix',async route=>{
    routeRequests++;
    const body=JSON.parse(route.request().postData()||'{}');
    assert.equal(body?.origin?.placeId,'HOME_ROUTE',`${label}: origin missing`);
    assert.equal(body?.destination?.placeId,'HOME_ROUTE',`${label}: destination missing`);
    assert.equal(body?.stops?.length,3,`${label}: stops count mismatch`);
    const keys=body.stops.map(stop=>stop.key);
    await route.fulfill({
      status:200,
      contentType:'application/json',
      body:JSON.stringify(fakeRouteBody(keys))
    });
  });

  const nav=await page.goto(baseURL,{waitUntil:'networkidle'});
  assert.ok(nav?.ok(),`${label}: navigation failed`);
  await page.waitForFunction(()=>!!window.TwinDB&&!!window.TwinItineraryV2&&!!window.TwinItineraryOrigin&&!!window.TwinItineraryRoute);

  await page.evaluate(async()=>{
    await TwinDB.put('itineraries',{
      id:'j2b2-route-trip',
      model:'itinerary-v2',
      modelVersion:2,
      status:'planned',
      title:'J2B-2 路線測試',
      date:'2026-09-20',
      departureTime:'09:00',
      origin:{kind:'home',label:'家',placeId:'HOME_ROUTE',address:'新竹市測試路 1 號',latitude:24.80,longitude:120.99,source:'google-places'},
      destination:{kind:'home',label:'家',placeId:'HOME_ROUTE',address:'新竹市測試路 1 號',latitude:24.80,longitude:120.99,source:'google-places'},
      scheduleSchemaVersion:null,
      stops:[
        {id:'sA',kind:'external',candidateKey:'place:A',source:'external',placeId:'A',title:'A 景點',entityType:'attraction',latitude:24.81,longitude:121.00,address:'新竹市 A 路 1 號',googleMapsUrl:'',rating:null,userRatingCount:null,plannedTime:'',note:'',order:0},
        {id:'sB',kind:'external',candidateKey:'place:B',source:'external',placeId:'B',title:'B 景點',entityType:'attraction',latitude:24.82,longitude:121.01,address:'新竹市 B 路 2 號',googleMapsUrl:'',rating:null,userRatingCount:null,plannedTime:'',note:'',order:1},
        {id:'sC',kind:'external',candidateKey:'place:C',source:'external',placeId:'C',title:'C 景點',entityType:'attraction',latitude:24.83,longitude:121.02,address:'新竹市 C 路 3 號',googleMapsUrl:'',rating:null,userRatingCount:null,plannedTime:'',note:'',order:2}
      ],
      plannerInput:null,
      createdAt:'2026-09-08T13:00:00.000Z',
      updatedAt:'2026-09-08T13:00:00.000Z'
    });
  });

  await page.click('button[data-view="trips"]');
  await page.waitForSelector('[data-it2-screen="list"]');
  await page.getByText('J2B-2 路線測試').click();
  await page.waitForSelector('[data-it2-screen="arrange"]');
  await page.waitForSelector('#j2b2RouteCard');

  assert.equal(routeRequests,0,`${label}: route API called before explicit user action`);
  const initialOrder=await page.locator('.it2-stop-copy strong').allTextContents();
  assert.deepEqual(initialOrder,['A 景點','B 景點','C 景點'],`${label}: initial stop order mismatch`);

  await page.click('[data-j2b2-calc]');
  await page.waitForSelector('[data-j2b2-apply]');
  assert.equal(routeRequests,1,`${label}: route API call count mismatch`);
  const summary=await page.locator('#j2b2RouteCard').innerText();
  assert.match(summary,/Google Routes/,`${label}: provider label missing`);
  assert.match(summary,/25 分/,`${label}: savings summary missing`);

  await page.click('[data-j2b2-apply]');
  await page.waitForFunction(()=>[...document.querySelectorAll('.it2-stop-copy strong')].map(x=>x.textContent).join('|')==='B 景點|A 景點|C 景點');
  const appliedOrder=await page.locator('.it2-stop-copy strong').allTextContents();
  assert.deepEqual(appliedOrder,['B 景點','A 景點','C 景點'],`${label}: suggested order not applied`);
  assert.match(await page.locator('#j2b2RouteCard').innerText(),/已套用建議順序/,`${label}: applied state missing`);
  assert.equal(await page.locator('.j2b2-leg').count(),4,`${label}: leg decorations missing`);

  await page.click('[data-it2-save]');
  await page.waitForSelector('[data-it2-screen="list"]');
  const saved=await page.evaluate(()=>TwinDB.get('itineraries','j2b2-route-trip'));
  assert.equal(saved?.modelVersion,2,`${label}: model version changed`);
  assert.equal(saved?.scheduleSchemaVersion,null,`${label}: route scheduler schema activated unexpectedly`);
  assert.equal(saved?.routePlan?.provider,'google-routes',`${label}: routePlan provider not persisted`);
  assert.equal(saved?.routePlan?.schemaVersion,1,`${label}: routePlan schema mismatch`);
  assert.equal(saved?.routePlan?.applied,true,`${label}: applied routePlan state missing`);
  assert.deepEqual(saved?.routePlan?.stopKeys,['place:B','place:A','place:C'],`${label}: persisted order mismatch`);
  assert.equal(saved?.routePlan?.actual?.totalDurationSeconds,1200,`${label}: persisted route total mismatch`);

  await page.getByText('J2B-2 路線測試').click();
  await page.waitForSelector('[data-it2-screen="arrange"]');
  await page.waitForFunction(()=>document.querySelector('#j2b2RouteCard')?.innerText.includes('Google Routes'));
  assert.equal(routeRequests,1,`${label}: persisted routePlan caused an automatic provider call`);
  assert.equal(await page.locator('.j2b2-leg').count(),4,`${label}: persisted leg summary not restored`);

  if(errors.length) throw new Error(`${label}: browser errors: ${errors.join(' | ')}`);
  console.log(`${label}: explicit route call -> suggestion -> apply -> persist -> restore = PASS`);
  await context.close();
  await browser.close();
}

await run({width:390,height:844},'mobile');
await run({width:1280,height:900},'desktop');
console.log('J2B-2 WEBKIT ROUTE MATRIX UX GATE = PASS');