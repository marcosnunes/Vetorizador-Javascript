const CACHE_NAME = 'pdfspliter-cache-v2';

self.addEventListener('install', function() {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil((async function() {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith('pdfspliter-cache-') && name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function(event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  event.respondWith((async function() {
    const cache = await caches.open(CACHE_NAME);
    try {
      const networkResponse = await fetch(request);
      if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    } catch {
      const cached = await cache.match(request);
      if (cached) return cached;
      throw new Error('Recurso indisponível (offline e sem cache).');
    }
  })());
});
