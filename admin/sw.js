self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// Purchase alerts. An admin subscribes from this page, so the subscription
// belongs to THIS service worker (scope /admin/), not the app's: without these
// two handlers the alert arrives and nothing is shown.
self.addEventListener('push', (e) => {
  let data = { title: 'Emysa admin', body: 'New activity' };
  try { data = { ...data, ...e.data.json() }; } catch (err) { /* plain-text or empty push: show the default */ }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '../icon-192.png',
      badge: '../icon-192.png',
      tag: data.tag || undefined,
      data: { url: data.url || '/admin/' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/admin/', self.location.origin).href;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const here = open.find((c) => c.url.startsWith(new URL('/admin/', self.location.origin).href));
    if (here) { await here.focus(); return; }
    await self.clients.openWindow(url);
  })());
});
