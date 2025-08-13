// This is the service worker script, which works behind the scenes.

// A name for our cache
const CACHE_NAME = 'rain-warning-v4'; // IMPORTANT: Increment this version number

// A list of files we want to cache.
const urlsToCache = [
  '.', // This represents the root directory, which will cache index.html
  'manifest.json' 
];

// Install event: opens the cache and adds the app shell files to it.
self.addEventListener('install', event => {
  console.log('Service Worker: Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Service Worker: Caching app shell');
        return cache.addAll(urlsToCache);
      })
      .then(() => {
        console.log('Service Worker: Installation complete');
        return self.skipWaiting();
      })
  );
});

// Activate event: cleans up old caches.
self.addEventListener('activate', event => {
  console.log('Service Worker: Activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            console.log('Service Worker: Clearing old cache', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => {
        console.log('Service Worker: Activation complete');
        return self.clients.claim();
    })
  );
});


// Fetch event: serves assets from the cache first.
self.addEventListener('fetch', event => {
  // We only want to cache GET requests.
  if (event.request.method !== 'GET') {
    return;
  }
  
  // For API calls (weather, geocoding, reverse geocoding), always go to the network.
  const isApiCall = event.request.url.includes('api.open-meteo.com') || 
                    event.request.url.includes('geocoding-api.open-meteo.com') ||
                    event.request.url.includes('nominatim.openstreetmap.org');
  
  if (isApiCall) {
    event.respondWith(fetch(event.request));
    return;
  }

  // For other requests, use cache-first strategy.
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // If we have a match in the cache, return it.
        if (response) {
          return response;
        }
        
        // Otherwise, fetch from the network.
        return fetch(event.request);
      })
  );
});
