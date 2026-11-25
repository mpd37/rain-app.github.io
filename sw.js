// Service worker for Rain Warning PWA

const CACHE_NAME = 'rain-warning-cache-v9';
const APP_SHELL_URLS = [
    './',
    'index.html',
    'style.css',
    'app.js',
    'manifest.json',
    'icon-192.png',
    'icon-512.png',
];
const CDN_URLS = [
    'https://cdn.jsdelivr.net/npm/chart.js',
    'https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.0.1/dist/chartjs-plugin-annotation.min.js',
    'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll([...APP_SHELL_URLS, ...CDN_URLS]))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) =>
                Promise.all(
                    cacheNames
                        .filter((name) => name !== CACHE_NAME)
                        .map((name) => caches.delete(name))
                )
            )
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    const isSameOrigin = url.origin === self.location.origin;

    if (isSameOrigin) {
        // Network-first for app shell so updates apply immediately, with cache fallback offline.
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    if (response && response.ok && response.type === 'basic') {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                    }
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    // Cache-first only for pre-cached CDN assets; live weather API calls bypass the cache.
    if (CDN_URLS.includes(event.request.url)) {
        event.respondWith(
            caches.match(event.request).then((cached) => cached || fetch(event.request))
        );
    }
});
