self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function(event) {
  event.respondWith(
    caches.open('pdfspliter-cache-v1').then(function(cache) {
      return cache.match(event.request).then(function(response) {
        return response || fetch(event.request).then(function(networkResponse) {
          if (event.request.method === 'GET' && networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        });
      });
    })
  );
});
