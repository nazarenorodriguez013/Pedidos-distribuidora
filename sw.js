// Service worker: la app (y las librerías de Excel/PDF) se abren sin señal; se actualizan en segundo plano.
const CACHE = 'pedidos-v3';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/manifest.json', '/icon-192.png', '/logo.png', '/logo-marca.png'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).pathname.startsWith('/api/')) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(r, { ignoreSearch: true });
    const red = fetch(r).then(res => { if (res && (res.ok || res.type === 'opaque')) c.put(r, res.clone()); return res; }).catch(() => null);
    return hit || (await red) || (r.mode === 'navigate' ? c.match('/') : Response.error());
  }));
});
