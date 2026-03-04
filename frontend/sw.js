const CACHE_NAME = 'paqq-v3';
const IMAGE_CACHE_NAME = 'paqq-images-v1';
const urlsToCache = [
  '/',
  'index.html',
  'manifest.json',
  'logo.svg',
  'amazon-logo.svg',
  'icons/favicon.png',
  'styles.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css',
  'default-logo.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  if (event.request.destination === 'image') {
    event.respondWith(
      caches.open(IMAGE_CACHE_NAME).then(async (imageCache) => {
        const cached = await imageCache.match(event.request);
        const networkFetch = fetch(event.request)
          .then((response) => {
            if (response && (response.ok || response.type === 'opaque')) {
              imageCache.put(event.request, response.clone());
            }
            return response;
          })
          .catch(() => undefined);

        if (cached) {
          event.waitUntil(networkFetch);
          return cached;
        }
        const fresh = await networkFetch;
        return fresh || cached || Response.error();
      })
    );
    return;
  }

  const requestUrl = new URL(event.request.url);
  const isSameOrigin = requestUrl.origin === self.location.origin;

  // Always fetch live tracking/API responses.
  if (
    isSameOrigin &&
    (requestUrl.pathname.startsWith('/api/') ||
      requestUrl.pathname === '/runtime-config.js')
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Always prefer fresh HTML so deployed UI changes appear immediately.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, copy);
            });
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        if (response) {
          return response;
        }
        return fetch(event.request)
          .then((response) => {
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            const responseToCache = response.clone();
            caches.open(CACHE_NAME)
              .then((cache) => {
                cache.put(event.request, responseToCache);
              });
            return response;
          });
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME && cacheName !== IMAGE_CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});
