// Minimal service worker — required for "Add to Home Screen" to count this
// as an installable PWA. Screens and app code are deliberately NOT cached: call
// state needs to always be live/current. Only static media and the Supabase
// library are cached (see the fetch handler below).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
// Runtime cache for things that never carry live state: the hero/login media
// (uuid-named uploads, immutable) and the Supabase library from esm.sh. App
// code, version.json and all API/database calls still go straight to the network.
const MEDIA_CACHE = 'emysa-media-v1';
function cacheable(url) {
  if (url.hostname === 'esm.sh') return 'swr';
  if (url.pathname.includes('/storage/v1/object/public/app-assets/')) return 'cache-first';
  return null;
}
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const mode = cacheable(new URL(req.url));
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
