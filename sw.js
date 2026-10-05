// Minimal service worker — required for "Add to Home Screen" to count this
// as an installable PWA. No offline caching yet by design: call state needs
// to always be live/current, so caching screens would risk showing stale
// call status.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

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
