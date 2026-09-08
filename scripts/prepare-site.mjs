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

// iOS fast-start: paint the Home view, then yield two animation frames before
// legacy IndexedDB migrations continue. A synchronous render alone is not enough
// because WebKit can defer the actual screen paint until the current task yields.
const earlyHomePaintPattern = /(    state\.settings = Object\.fromEntries\(settings\.map\(x=>\[x\.key,x\.value\]\)\);\n    syncAppTitle\(\);\n)(    await migrateGeographyIfNeeded\(\);)/;
if (!earlyHomePaintPattern.test(app)) throw new Error('app.js early-home-paint anchor missing');
app = app.replace(earlyHomePaintPattern, `$1    if (!app.childElementCount && state.view === 'home') {\n      render();\n      await new Promise(resolve => {\n        const raf = window.requestAnimationFrame || (cb => setTimeout(cb, 16));\n        raf(() => raf(resolve));\n      });\n    }\n$2`);

// Keep capture automation away from the first interaction window. It still runs
// automatically, just after the initial UI has settled.
const inboxStartupPattern = 'render(); scheduleInboxAutomation(150);';
if (!app.includes(inboxStartupPattern)) throw new Error('app.js inbox startup anchor missing');
app = app.replace(inboxStartupPattern, 'render(); scheduleInboxAutomation(1200);');

const legacySwBlock = `      if ('serviceWorker' in navigator) {\n        let reloading = false;\n        navigator.serviceWorker.addEventListener('controllerchange', () => {\n          if (reloading) return;\n          reloading = true;\n          location.reload();\n        });\n        navigator.serviceWorker.register('./sw.js?v=4.5.0-phase1.2', { updateViaCache:'none' })\n          .then(reg => reg.update().catch(()=>{}))\n          .catch(()=>{});\n      }`;
if (!app.includes(legacySwBlock)) throw new Error('app.js legacy service-worker block missing');
app = app.replace(legacySwBlock, `      const startUpdateManager=()=>window.TwinUpdateManager?.register?.().catch(()=>{});\n      if('requestIdleCallback' in window) requestIdleCallback(startUpdateManager,{timeout:1500});\n      else setTimeout(startUpdateManager,500);`);
await writeFile(appPath, app, 'utf8');

console.log(`Prepared site runtime ${runtime.version} from public/version.json.`);
