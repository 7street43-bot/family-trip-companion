import { webkit } from 'playwright';
import assert from 'node:assert/strict';

const baseURL = process.env.J2A_BASE_URL || 'http://127.0.0.1:4173';
const CRITICAL_PATHS = new Set([
  '/', '/index.html', '/runtime-config.js', '/db.js', '/app.js',
  '/itinerary-v2.css', '/itinerary-v2-core.mjs', '/itinerary-v2.mjs'
]);

async function run(viewport, label) {
  const browser = await webkit.launch();
  const page = await browser.newPage({ viewport });
  const errors = [];
  const nonCritical404 = [];
  page.on('pageerror', err => errors.push(`pageerror:${String(err)}`));
  page.on('response', response => {
    const status = response.status();
    if (status < 400) return;
    const url = new URL(response.url());
    const item = `${status}:${url.pathname}`;
    if (url.origin === new URL(baseURL).origin && CRITICAL_PATHS.has(url.pathname)) errors.push(`critical-http:${item}`);
    else nonCritical404.push(item);
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
  await page.fill('#it2Title', 'J2A 三站測試');
  await page.fill('#it2Departure', '09:00');
  await page.click('[data-it2-to-pick]');
  await page.waitForSelector('[data-it2-screen="pick"]');

  const places = page.locator('[data-it2-place]');
  const count = await places.count();
  assert.ok(count >= 3, `${label}: seed data has fewer than 3 selectable places (${count})`);
  for (let i = 0; i < 3; i++) await places.nth(i).click();
  assert.match(await page.locator('.it2-sticky-action').innerText(), /已選\s*3\s*個/);

  await page.click('[data-it2-to-arrange]');
  await page.waitForSelector('[data-it2-screen="arrange"]');
  assert.equal(await page.locator('.it2-stop-row').count(), 3, `${label}: exactly three stops expected`);

  const firstBefore = await page.locator('.it2-stop-row').nth(0).locator('strong').innerText();
  const secondBefore = await page.locator('.it2-stop-row').nth(1).locator('strong').innerText();
  await page.locator('.it2-stop-row').nth(1).locator('[data-it2-move="up"]').click();
  assert.equal(await page.locator('.it2-stop-row').nth(0).locator('strong').innerText(), secondBefore, `${label}: reorder did not move stop`);
  assert.equal(await page.locator('.it2-stop-row').nth(1).locator('strong').innerText(), firstBefore, `${label}: reorder did not preserve former first`);

  await page.click('[data-it2-save]');
  await page.waitForSelector('[data-it2-screen="list"]');
  assert.equal(await page.getByText('J2A 三站測試').count(), 1, `${label}: saved V2 trip not listed`);

  await page.click('button[data-view="home"]');
  await page.waitForTimeout(100);
  await page.click('button[data-view="trips"]');
  await page.waitForSelector('[data-it2-screen="list"]');
  assert.equal(await page.getByText('J2A 三站測試').count(), 1, `${label}: V2 trip not persistent after navigation`);
  assert.equal(await page.getByText('LEGACY SHOULD STAY HIDDEN').count(), 0, `${label}: legacy trip visible after revisit`);

  const dbCheck = await page.evaluate(async () => {
    const rows = await TwinDB.getAll('itineraries');
    return {
      legacy: rows.some(x => x.id === 'legacy-e2e'),
      v2: rows.filter(x => x.model === 'itinerary-v2' && x.title === 'J2A 三站測試').length
    };
  });
  assert.equal(dbCheck.legacy, true, `${label}: legacy trip was modified/deleted`);
  assert.equal(dbCheck.v2, 1, `${label}: V2 persistence count mismatch`);

  if (errors.length) throw new Error(`${label}: critical browser errors: ${errors.join(' | ')}`);
  console.log(`${label}: non-critical HTTP failures observed=${[...new Set(nonCritical404)].join(',') || 'none'}`);
  await browser.close();
}

await run({ width:390, height:844 }, 'mobile');
await run({ width:1280, height:900 }, 'desktop');
console.log('J2A WEBKIT 3-STOP FIRST-USE FLOW = PASS');
