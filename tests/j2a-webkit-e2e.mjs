import { webkit } from 'playwright';
import assert from 'node:assert/strict';

const baseURL = process.env.J2A_BASE_URL || 'http://127.0.0.1:4173';
const CRITICAL_PATHS = new Set([
  '/', '/index.html', '/runtime-config.js', '/db.js', '/app.js',
  '/itinerary-v2.css', '/itinerary-v2-core.mjs', '/itinerary-candidates-core.mjs', '/itinerary-v2.mjs'
]);

const mockCandidates = [
  { placeId:'mock1', title:'斑比山丘', formattedAddress:'宜蘭縣冬山鄉', latitude:24.64, longitude:121.73, entityType:'activity', rating:4.7, userRatingCount:1200, sourceRank:0 },
  { placeId:'mock2', title:'張美阿嬤農場', formattedAddress:'宜蘭縣三星鄉', latitude:24.67, longitude:121.67, entityType:'activity', rating:4.6, userRatingCount:900, sourceRank:1 },
  { placeId:'mock3', title:'宜蘭傳藝園區', formattedAddress:'宜蘭縣五結鄉', latitude:24.68, longitude:121.82, entityType:'attraction', rating:4.5, userRatingCount:3000, sourceRank:2 },
  { placeId:'mock4', title:'蘭陽博物館', formattedAddress:'宜蘭縣頭城鎮', latitude:24.86, longitude:121.83, entityType:'attraction', rating:4.6, userRatingCount:5000, sourceRank:3 }
];

async function run(viewport, label) {
  const browser = await webkit.launch();
  const context = await browser.newContext({ viewport, serviceWorkers:'block' });
  const page = await context.newPage();
  const errors = [];
  const nonCritical404 = [];
  let candidateRequests = 0;
  page.on('pageerror', err => errors.push(`pageerror:${String(err)}`));
  page.on('response', response => {
    const status = response.status();
    if (status < 400) return;
    const url = new URL(response.url());
    const item = `${status}:${url.pathname}`;
    if (url.origin === new URL(baseURL).origin && CRITICAL_PATHS.has(url.pathname)) errors.push(`critical-http:${item}`);
    else nonCritical404.push(item);
  });
  await page.route('**/api/itinerary-candidates', async route => {
    candidateRequests += 1;
    const request = route.request();
    const body = JSON.parse(request.postData() || '{}');
    assert.ok(body.request || body.location || body.anchor || body.themes?.length, `${label}: smart planner payload empty`);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        planner: { version:'candidate-planner-v1', strategy:'places-query-expansion', aiAdapterReady:true },
        queriesTried: ['宜蘭 親子 動物 景點', '斑比山丘 附近 室內 景點'],
        candidates: mockCandidates
      })
    });
  });

  const nav = await page.goto(baseURL, { waitUntil:'networkidle' });
  assert.ok(nav && nav.ok(), `${label}: navigation failed`);
  await page.waitForFunction(() => !!window.TwinDB && !!window.TwinItineraryV2);

  await page.evaluate(async () => {
    await TwinDB.put('itineraries', { id:'legacy-e2e', date:'2026-09-20', title:'LEGACY SHOULD STAY HIDDEN', stops:[] });
  });

  await page.click('button[data-view="trips"]');
  await page.waitForSelector('[data-it2-screen="list"]');
  assert.equal(await page.getByText('LEGACY SHOULD STAY HIDDEN').count(), 0, `${label}: legacy trip leaked into V2`);

  await page.click('[data-it2-new]');
  await page.waitForSelector('[data-it2-screen="create"]');
  await page.fill('#it2Date', '2026-09-20');
  await page.fill('#it2Title', 'J2A 候選池測試');
  await page.fill('#it2Departure', '09:00');
  await page.click('[data-it2-to-pick]');
  await page.waitForSelector('[data-it2-screen="pick"]');
  assert.ok(await page.locator('[data-it2-source="smart"].active').count(), `${label}: smart source must be default`);

  await page.fill('#it2SmartRequest', '帶小孩去宜蘭一日，不想一直開車，想看動物，也要雨天備案');
  await page.fill('#it2SmartLocation', '宜蘭');
  await page.fill('#it2SmartAnchor', '斑比山丘');
  await page.fill('#it2SmartThemes', '動物、室內');
  await page.click('[data-it2-smart-search]');
  await page.waitForFunction(() => document.querySelectorAll('[data-it2-candidate^="place:"]').length >= 4);
  assert.equal(candidateRequests, 1, `${label}: candidate endpoint request count mismatch`);

  const dbBeforeConfirm = await page.evaluate(async () => (await TwinDB.getAll('itineraries')).filter(x => x.model === 'itinerary-v2' && x.title === 'J2A 候選池測試').length);
  assert.equal(dbBeforeConfirm, 0, `${label}: candidate search must never write an itinerary`);

  for (const key of ['place:mock1', 'place:mock2', 'place:mock3']) await page.click(`[data-it2-candidate="${key}"]`);
  assert.match(await page.locator('.it2-sticky-action').innerText(), /候選池\s*3\s*個/);

  const dbBeforeArrange = await page.evaluate(async () => (await TwinDB.getAll('itineraries')).filter(x => x.model === 'itinerary-v2' && x.title === 'J2A 候選池測試').length);
  assert.equal(dbBeforeArrange, 0, `${label}: selected candidate pool must stay transient before final save`);

  await page.click('[data-it2-to-arrange]');
  await page.waitForSelector('[data-it2-screen="arrange"]');
  assert.equal(await page.locator('.it2-stop-row').count(), 3, `${label}: exactly three confirmed stops expected`);
  assert.deepEqual(await page.locator('.it2-stop-row strong').allTextContents(), ['斑比山丘', '張美阿嬤農場', '宜蘭傳藝園區']);

  await page.locator('.it2-stop-row').nth(1).locator('[data-it2-move="up"]').click();
  assert.deepEqual(await page.locator('.it2-stop-row strong').allTextContents(), ['張美阿嬤農場', '斑比山丘', '宜蘭傳藝園區'], `${label}: reorder failed`);

  await page.click('[data-it2-back-pick]');
  await page.waitForSelector('[data-it2-screen="pick"]');
  await page.click('[data-it2-candidate="place:mock4"]');
  assert.match(await page.locator('.it2-sticky-action').innerText(), /候選池\s*4\s*個/);
  await page.click('[data-it2-to-arrange]');
  await page.waitForSelector('[data-it2-screen="arrange"]');
  assert.deepEqual(await page.locator('.it2-stop-row strong').allTextContents(), ['張美阿嬤農場', '斑比山丘', '宜蘭傳藝園區', '蘭陽博物館'], `${label}: returning to pool destroyed confirmed order`);

  await page.click('[data-it2-save]');
  await page.waitForSelector('[data-it2-screen="list"]');
  assert.equal(await page.getByText('J2A 候選池測試').count(), 1, `${label}: saved V2 trip not listed`);

  await page.click('button[data-view="home"]');
  await page.waitForTimeout(100);
  await page.click('button[data-view="trips"]');
  await page.waitForSelector('[data-it2-screen="list"]');
  assert.equal(await page.getByText('J2A 候選池測試').count(), 1, `${label}: V2 trip not persistent after navigation`);
  assert.equal(await page.getByText('LEGACY SHOULD STAY HIDDEN').count(), 0, `${label}: legacy trip visible after revisit`);

  const dbCheck = await page.evaluate(async () => {
    const rows = await TwinDB.getAll('itineraries');
    const v2 = rows.find(x => x.model === 'itinerary-v2' && x.title === 'J2A 候選池測試');
    return {
      legacy: rows.some(x => x.id === 'legacy-e2e'),
      v2Count: rows.filter(x => x.model === 'itinerary-v2' && x.title === 'J2A 候選池測試').length,
      stops: v2?.stops?.map(s => ({ title:s.title, source:s.source, placeId:s.placeId })) || [],
      plannerInput: v2?.plannerInput || null
    };
  });
  assert.equal(dbCheck.legacy, true, `${label}: legacy trip was modified/deleted`);
  assert.equal(dbCheck.v2Count, 1, `${label}: V2 persistence count mismatch`);
  assert.equal(dbCheck.stops.length, 4, `${label}: confirmed stops persistence mismatch`);
  assert.ok(dbCheck.stops.every(s => s.source === 'external' && s.placeId), `${label}: external candidate provenance missing`);
  assert.equal(dbCheck.plannerInput.location, '宜蘭', `${label}: planner input not retained with trip`);

  if (errors.length) throw new Error(`${label}: critical browser errors: ${errors.join(' | ')}`);
  console.log(`${label}: candidate API mock requests=${candidateRequests}; non-critical HTTP failures observed=${[...new Set(nonCritical404)].join(',') || 'none'}`);
  await context.close();
  await browser.close();
}

await run({ width:390, height:844 }, 'mobile');
await run({ width:1280, height:900 }, 'desktop');
console.log('J2A WEBKIT CANDIDATE POOL + CONFIRMATION FLOW = PASS');
