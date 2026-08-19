// Cachea solo el armazón de la app: así abre al instante y funciona sin señal
// para consultar la cola pendiente. Los datos siempre van a la red.
const CACHE = 'dolares-v1';
const ARMAZON = ['/', '/index.html', '/estilos.css', '/app.js', '/manifest.json', '/diagnostico.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARMAZON)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((claves) => Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Solo el armazón propio: nunca la API ni las fotos firmadas de Supabase
  // (sus enlaces caducan, cachearlos daría imágenes rotas).
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copia = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
        return r;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
  );
});
