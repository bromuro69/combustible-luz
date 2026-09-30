const CACHE='evolta-shell-v14';
const SHELL=['/','/index.html','/styles.css','/settings.css','/app.js','/manifest.webmanifest','/icon.svg','/icon-180.png','/icon-192.png','/evolta-wordmark.webp'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(Promise.all([
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))),
  self.clients.claim()
])));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => { const copy=r.clone(); caches.open(CACHE).then(c=>c.put(e.request, copy)); return r; }).catch(()=>caches.match(e.request)));
});