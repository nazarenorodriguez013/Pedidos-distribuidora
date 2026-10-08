// Service worker: la app (y las librerías de Excel/PDF) se abren sin señal; se actualizan en segundo plano.
const CACHE = 'pedidos-v5';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/manifest.json', '/icon-192.png', '/logo.png', '/logo-marca.png'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).pathname.startsWith('/api/')) return;
  const u = new URL(r.url);
  if (r.mode === 'navigate' || u.pathname === '/' || u.pathname === '/index.html') {   // la app: con señal siempre la versión nueva; sin señal (o muy lenta), la guardada
    e.respondWith(caches.open(CACHE).then(async c => {
      try {
        const res = await Promise.race([fetch(r), new Promise((_, no) => setTimeout(() => no(new Error('lento')), 5000))]);
        if (res && res.ok) c.put(r.mode === 'navigate' ? '/' : r, res.clone());
        return res;
      } catch { return (await c.match(r, { ignoreSearch: true })) || (await c.match('/')) || Response.error(); }
    }));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(r, { ignoreSearch: true });
    const red = fetch(r).then(res => { if (res && (res.ok || res.type === 'opaque')) c.put(r, res.clone()); return res; }).catch(() => null);
    return hit || (await red) || (r.mode === 'navigate' ? c.match('/') : Response.error());
  }));
});

// Notificaciones push: se muestran aunque la app esté cerrada; al tocarlas se abre la app
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(d.titulo || 'Distribuidora Don Luis', { body: d.cuerpo || '', tag: d.tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(l => { for (const c of l) if ('focus' in c) return c.focus(); return self.clients.openWindow((e.notification.data && e.notification.data.url) || '/'); }));
});
