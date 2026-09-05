// Minimal service worker — required for "Add to Home Screen" to count this
// as an installable PWA. No offline caching yet by design: call state needs
// to always be live/current, so caching screens would risk showing stale
// call status.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
