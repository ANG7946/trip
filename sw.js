// sw.js — 只快取網站資產（app shell）；行程資料存在 IndexedDB，不經過這裡
const VERSION = '1.2.0';
const CACHE = `tc-shell-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './css/styles.css?v=1.2.0',
  './js/app.js?v=1.2.0',
  './js/core.js?v=1.2.0',
  './js/db.js?v=1.2.0',
  './js/csv.js?v=1.2.0',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './data/demo-trip.json',
  './data/trip-template.csv',
  './data/trip-template.json',
  './data/ai-prompt.txt',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' 確保拿到伺服器上的最新檔案，而非 HTTP 快取
    await cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })));
    // 第一次安裝時立即啟用；更新版本則等使用者按「重新載入」
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('tc-shell-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => c.postMessage({ type: 'CACHED', version: VERSION }));
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部連結（地圖等）一律不攔截

  if (req.mode === 'navigate') {
    // 頁面導覽：快取優先，確保離線時從主畫面也能開啟
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match('./index.html');
      if (cached) return cached;
      try {
        return await fetch(req);
      } catch {
        return new Response('<h1>離線中，且尚未完成快取</h1><p>請連網後重新開啟一次。</p>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      return await fetch(req);
    } catch {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});
