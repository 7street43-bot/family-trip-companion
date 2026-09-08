import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const outDir = path.join(publicDir, 'lib');
await mkdir(outDir, { recursive: true });

for (const name of [
  'journal-client.mjs',
  'journal-supabase-transport.mjs',
  'journal-media-client.mjs',
  'journal-media-supabase-transport.mjs'
]) {
  await copyFile(path.join(root, 'shared', name), path.join(outDir, name));
}

const versionPath = path.join(publicDir, 'version.json');
const versionInfo = JSON.parse(await readFile(versionPath, 'utf8'));
if (!versionInfo?.version || !versionInfo?.cache || !versionInfo?.channel) throw new Error('version.json is incomplete');
const runtime = {
  version:String(versionInfo.version),
  cache:String(versionInfo.cache),
  channel:String(versionInfo.channel),
  builtAt:String(versionInfo.builtAt||'')
};
await writeFile(path.join(publicDir, 'runtime-config.js'),
  `globalThis.TwinRuntime=Object.freeze(${JSON.stringify(runtime)});\n`, 'utf8');

// app.js is a legacy classic-script bundle. Its deployed version identity and SW
// ownership are generated from version.json so the source bundle cannot drift.
const appPath = path.join(publicDir, 'app.js');
let app = await readFile(appPath, 'utf8');
const versionPattern = /const APP_RUNTIME_VERSION = '[^']*';/;
if (!versionPattern.test(app)) throw new Error('app.js runtime version anchor missing');
app = app.replace(versionPattern, `const APP_RUNTIME_VERSION = '${runtime.version}';`);

// J2A-3 fast start: initial reload reads only local state. Legacy normalization
// is deferred until after the first interaction window instead of blocking Home.
const reloadSignature = '  async function reloadData() {';
if (!app.includes(reloadSignature)) throw new Error('app.js reloadData signature missing');
app = app.replace(reloadSignature, '  async function reloadData({runMigrations=true}={}) {');
const migrationBlock = `    await migrateGeographyIfNeeded();\n    await migrateDecisionFieldsIfNeeded();\n    await migrateDecisionMetadataIfNeeded();\n    await migrateDecisionConsistencyIfNeeded();`;
if (!app.includes(migrationBlock)) throw new Error('app.js migration block missing');
app = app.replace(migrationBlock, `    if (runMigrations) {\n      await migrateGeographyIfNeeded();\n      await migrateDecisionFieldsIfNeeded();\n      await migrateDecisionMetadataIfNeeded();\n      await migrateDecisionConsistencyIfNeeded();\n    }`);

// Never let legacy background refresh replace an active V2 itinerary or Journal
// surface. Those modules own #app while active.
const cloudRefresh = `  async function cloudSyncAndRefresh(){\n    const result=await TwinCloudSync.syncNow();\n    await reloadData();render();\n    return result;\n  }`;
if (!app.includes(cloudRefresh)) throw new Error('app.js cloud refresh anchor missing');
app = app.replace(cloudRefresh, `  function auxiliarySurfaceActive(){\n    return !!document.querySelector('[data-it2-screen]') || !!document.querySelector('#journalNavBtn.active');\n  }\n\n  async function cloudSyncAndRefresh(){\n    const result=await TwinCloudSync.syncNow();\n    await reloadData();\n    if(!auxiliarySurfaceActive()) render();\n    return result;\n  }`);

// Startup/background work is idle-scheduled. pageshow/visibility no longer pull
// inbox automation into the first 50ms and overwrite an interaction in progress.
const startupListeners = `  window.addEventListener('online',()=>{render();scheduleInboxAutomation(100);}); window.addEventListener('offline',render);\n  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible') scheduleInboxAutomation(50);});\n  window.addEventListener('pageshow',()=>scheduleInboxAutomation(50));\n\n  async function init() {`;
if (!app.includes(startupListeners)) throw new Error('app.js startup listeners anchor missing');
app = app.replace(startupListeners, `  function scheduleIdleTask(task,{delay=600,timeout=2500}={}){\n    const run=()=>Promise.resolve().then(task).catch(err=>console.warn('Background startup:',err));\n    setTimeout(()=>{\n      if('requestIdleCallback' in window) requestIdleCallback(run,{timeout});\n      else setTimeout(run,0);\n    },delay);\n  }\n\n  function scheduleInboxAutomationWhenSafe(delayMs=1200){\n    setTimeout(()=>{\n      if(auxiliarySurfaceActive()) return;\n      scheduleInboxAutomation(0);\n    },Math.max(0,delayMs));\n  }\n\n  window.addEventListener('online',()=>{if(!auxiliarySurfaceActive())render();scheduleInboxAutomationWhenSafe(1000);}); window.addEventListener('offline',()=>{if(!auxiliarySurfaceActive())render();});\n  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible') scheduleInboxAutomationWhenSafe(1200);});\n  window.addEventListener('pageshow',()=>scheduleInboxAutomationWhenSafe(1500));\n\n  async function init() {`);

const initLine = `      await ensureSeeded(); await reloadData(); const persistenceResult=await finalizePersistenceGateIfPending(); render(); scheduleInboxAutomation(150); if(persistenceResult)toast(\`Persistence Gate \${persistenceResult.status}\`, '', null, 7000);`;
if (!app.includes(initLine)) throw new Error('app.js init line anchor missing');
app = app.replace(initLine, `      await ensureSeeded(); await reloadData({runMigrations:false}); const persistenceResult=await finalizePersistenceGateIfPending(); render(); if(persistenceResult)toast(\`Persistence Gate \${persistenceResult.status}\`, '', null, 7000);\n      scheduleIdleTask(async()=>{\n        await reloadData();\n        if(state.view==='home' && !auxiliarySurfaceActive()) render();\n        scheduleInboxAutomationWhenSafe(500);\n      },{delay:700,timeout:3000});`);

// Cloud Sync remains automatic, but starts outside the first interaction window.
const cloudStartup = `      if(window.TwinCloudSync){TwinCloudSync.getStatus().then(async st=>{if(!st.authenticated)return;try{await cloudSyncAndRefresh();await TwinCloudSync.subscribe(()=>{setTimeout(()=>cloudSyncAndRefresh().catch(()=>{}),250);});}catch(err){console.warn('Cloud sync startup:',err);}}).catch(()=>{});}`;
if (!app.includes(cloudStartup)) throw new Error('app.js cloud startup anchor missing');
app = app.replace(cloudStartup, `      if(window.TwinCloudSync) scheduleIdleTask(()=>TwinCloudSync.getStatus().then(async st=>{if(!st.authenticated)return;try{await cloudSyncAndRefresh();await TwinCloudSync.subscribe(()=>{setTimeout(()=>cloudSyncAndRefresh().catch(()=>{}),250);});}catch(err){console.warn('Cloud sync startup:',err);}}),{delay:900,timeout:3500});`);

const legacySwBlock = `      if ('serviceWorker' in navigator) {\n        let reloading = false;\n        navigator.serviceWorker.addEventListener('controllerchange', () => {\n          if (reloading) return;\n          reloading = true;\n          location.reload();\n        });\n        navigator.serviceWorker.register('./sw.js?v=4.5.0-phase1.2', { updateViaCache:'none' })\n          .then(reg => reg.update().catch(()=>{}))\n          .catch(()=>{});\n      }`;
if (!app.includes(legacySwBlock)) throw new Error('app.js legacy service-worker block missing');
app = app.replace(legacySwBlock, `      scheduleIdleTask(()=>window.TwinUpdateManager?.register?.(),{delay:1200,timeout:4000});`);
await writeFile(appPath, app, 'utf8');

console.log(`Prepared site runtime ${runtime.version} from public/version.json.`);
