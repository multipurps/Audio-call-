// Service worker: makes the app installable, lets it open with no connection, and keeps media cached.
// App code and pages are network-first: whenever there is a connection the newest build is used (and saved), so
// updates always arrive. The saved copy is only used when the network is down or very slow. API and database calls
// and version.json are never cached here; saved data lives in the app itself (see app.js, "local copy").
const SHELL_CACHE = 'emysa-shell-v1';
const SHELL_PRECACHE = ['/index.html', '/app.js', '/styles.css', '/manifest.json', '/icon-192.png'];
const SHELL_SLOW_MS = 4000; // after this long with no answer, use the saved copy while the network keeps trying

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL_CACHE).then((cache) => Promise.all(SHELL_PRECACHE.map((u) =>
    fetch(u).then((r) => (r.ok && !r.redirected ? cache.put(u, r) : null)).catch(() => {})))));
});
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter((n) => n.startsWith('emysa-shell-') && n !== SHELL_CACHE).map((n) => caches.delete(n)));
  await self.clients.claim();
})()));

function isShellRequest(req, url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  if (p.startsWith('/api/') || p.startsWith('/anam-llm') || p === '/version.json' || p.startsWith('/assets/call/')) return false;
  if (req.mode === 'navigate') return true;
  if (['script', 'style', 'image', 'font', 'manifest'].includes(req.destination)) return true;
  return /\.(js|css|json|png|svg|webp|ico|woff2?)$/i.test(p);
}

async function shellResponse(e, req) {
  const cache = await caches.open(SHELL_CACHE);
  const network = fetch(req).then((resp) => {
    if (resp && resp.ok && !resp.redirected && resp.type === 'basic') cache.put(req, resp.clone());
    return resp;
  });
  e.waitUntil(network.catch(() => {}));
  const nav = req.mode === 'navigate';
  const saved = (await cache.match(req, { ignoreSearch: nav })) || (nav ? await cache.match('/index.html') : null);
  if (!saved) return network;
  const slow = new Promise((resolve) => setTimeout(() => resolve(saved), SHELL_SLOW_MS));
  return Promise.race([network, slow]).catch(() => saved);
}

// The page sends the list of files it just used; save any we do not have yet so the whole app opens offline.
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type !== 'cache-shell' || !Array.isArray(d.urls)) return;
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    for (const u of d.urls.slice(0, 200)) {
      try {
        const url = new URL(u, self.location.origin);
        if (!isShellRequest({ mode: 'no-cors', destination: 'script' }, url)) continue;
        if (await cache.match(url.href)) continue;
        const r = await fetch(url.href);
        if (r.ok && !r.redirected) await cache.put(url.href, r);
      } catch { /* skip this file */ }
    }
  })());
});

// Runtime cache for things that never carry live state: the hero/login media
// (uuid-named uploads, immutable) and the Supabase library from esm.sh. App
// code is handled above (network-first); version.json and all API/database calls go straight to the network.
const MEDIA_CACHE = 'emysa-media-v1';
function cacheable(url) {
  if (url.hostname === 'esm.sh') return 'swr';
  if (url.pathname.includes('/storage/v1/object/public/app-assets/')) return 'cache-first';
  return null;
}
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Video/audio and any Range request go straight to the network: Safari needs real 206 partial responses,
  // and a worker answering them with 200 or opaque bodies leaves the player black on iPhone.
  if (req.headers.has('range') || req.destination === 'video' || req.destination === 'audio') return;
  const reqUrl = new URL(req.url);
  if (isShellRequest(req, reqUrl)) { e.respondWith(shellResponse(e, req)); return; }
  const mode = cacheable(reqUrl);
  if (!mode) return;
  e.respondWith((async () => {
    const cache = await caches.open(MEDIA_CACHE);
    const hit = await cache.match(req);
    const refresh = fetch(req).then((resp) => {
      if (resp && (resp.ok || resp.type === 'opaque')) cache.put(req, resp.clone());
      return resp;
    });
    if (hit) {
      if (mode === 'swr') e.waitUntil(refresh.catch(() => {}));
      return hit;
    }
    return refresh;
  })());
});

self.addEventListener('push', (e) => {
  let data = { title: 'Emysa', body: 'New announcement' };
  try { data = e.data.json(); } catch (err) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: data.tag || undefined,
      data: { url: data.url || './index.html' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './index.html';
  e.waitUntil(clients.openWindow(url));
});
