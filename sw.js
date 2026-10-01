const CACHE='evolta-shell-v18';
const SHELL=['/','/index.html','/styles.css?v=18','/settings.css?v=18','/app.js?v=18','/manifest.webmanifest','/icon.svg','/icon-180.png','/icon-192.png','/evolta-wordmark-header-v3.png?v=18'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(Promise.all([
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))),
  self.clients.claim()
])));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;
  if (u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request, {cache:'no-store'}).then(r => {
    const copy=r.clone();
    caches.open(CACHE).then(c=>c.put(e.request, copy));
    return r;
  }).catch(()=>caches.match(e.request)));
});