importScripts('./runtime-config.js');
const CACHE = globalThis.TwinRuntime?.cache;
if(!CACHE) throw new Error('runtime cache identity missing');
const CORE_PATHS = new Set([
  '/', '/index.html', '/runtime-config.js', '/update-manager.js', '/update-manager.css', '/app.css', '/journal.css', '/journal-media.css', '/journal-nav.css', '/journal-stable.css', '/db.js', '/cloud-sync.js', '/journal-shell.mjs', '/journal-browser.mjs', '/journal-ui.mjs', '/journal-nav-bridge.mjs', '/journal-media-ui.mjs', '/journal-media-preview-demo.mjs', '/journal-stable-layout.mjs',
  '/lib/journal-client.mjs', '/lib/journal-supabase-transport.mjs', '/lib/journal-media-client.mjs', '/lib/journal-media-supabase-transport.mjs',
  '/app.js', '/manifest.webmanifest', '/seed-data.json', '/version.json', '/decision-metadata.json'
]);
const PRECACHE = [
  './index.html', './runtime-config.js', './update-manager.js', './update-manager.css', './app.css', './journal.css', './journal-media.css', './journal-nav.css', './journal-stable.css', './db.js', './cloud-sync.js', './journal-shell.mjs', './journal-browser.mjs', './journal-ui.mjs', './journal-nav-bridge.mjs', './journal-media-ui.mjs', './journal-media-preview-demo.mjs', './journal-stable-layout.mjs',
  './lib/journal-client.mjs', './lib/journal-supabase-transport.mjs', './lib/journal-media-client.mjs', './lib/journal-media-supabase-transport.mjs', './app.js',
  './manifest.webmanifest', './seed-data.json', './version.json', './decision-metadata.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE))); });
self.addEventListener('message', event => { if(event.data?.type==='SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
async function networkFirst(req){const cache=await caches.open(CACHE);try{const res=await fetch(req,{cache:'no-store'});if(res&&res.ok)await cache.put(req,res.clone());return res;}catch(err){const cached=await cache.match(req,{ignoreSearch:true});if(cached)return cached;throw err;}}
async function cacheFirst(req){const cache=await caches.open(CACHE),cached=await cache.match(req,{ignoreSearch:true});if(cached)return cached;const res=await fetch(req);if(res&&res.ok)await cache.put(req,res.clone());return res;}
self.addEventListener('fetch', event => {const req=event.request;if(req.method!=='GET')return;const url=new URL(req.url);if(url.origin!==self.location.origin)return;if(url.pathname.startsWith('/api/')||url.pathname.includes('/.netlify/functions/')){event.respondWith(fetch(req,{cache:'no-store'}));return;}if(req.mode==='navigate'){event.respondWith(networkFirst(req).catch(()=>caches.match('./index.html')));return;}if(CORE_PATHS.has(url.pathname)){event.respondWith(networkFirst(req));return;}event.respondWith(cacheFirst(req));});
