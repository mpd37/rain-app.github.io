// This is the service worker script, which works behind the scenes.

// A name for our cache
const CACHE_NAME = 'rain-warning-v1';

// A list of files we want to cache.
// This is the "app shell" - the minimal files needed to run.
const urlsToCache = [
  '.', // This represents the root directory, which will cache index.html
  'manifest.json' 
  // Note: We don't cache the external CSS and JS (Tailwind, Google Fonts)
  // because they are on a different origin (CDN) and caching them is more complex.
  // The app will still work offline, just without custom fonts if they aren't already cached by the browser.
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
// If the resource isn't in the cache, it tries to get it from the network.
self.addEventListener('fetch', event => {
  // We only want to cache GET requests.
  if (event.request.method !== 'GET') {
    return;
  }
  
  // For API calls, always go to the network.
  if (event.request.url.includes('api.open-meteo.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // If we have a match in the cache, return it.
        if (response) {
          console.log('Service Worker: Fetching from cache:', event.request.url);
          return response;
        }
        
        // Otherwise, fetch from the network.
        console.log('Service Worker: Fetching from network:', event.request.url);
        return fetch(event.request);
      })
  );
});

