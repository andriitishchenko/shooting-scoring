// Service worker: keeps the files of the home page and of the practice page on the
// device. It touches no other request. When the network works, the page loads
// from the network and the copy is renewed. Without a network, the copy is used.
'use strict';

const CACHE = 'practice-v1';
const NETWORK_WAIT_MS = 3000;
const FILES = [
    './',
    'index.html',
    'practice.html',
    'css/reset.css',
    'css/variables.css',
    'css/main.css',
    'css/client.css',
    'js/config.js',
    'js/storage.js',
    'js/scoring.js',
    'js/actions.js',
    'js/practice.js',
    'js/offline.js',
];
const URLS = new Set(FILES.map(file => new URL(file, self.registration.scope).href));

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    url.search = '';
    url.hash = '';
    if (!URLS.has(url.href)) return;
    // The network answers, or the copy answers: after a few seconds without an
    // answer (a weak signal on a shooting range), the page opens from the copy.
    // The request goes on, and the copy is renewed when the answer arrives.
    const network = fetch(request).then(response => {
        if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
    });
    // A server error (for example 502 when the server is down) is not a page: use the copy.
    const usable = response => response && (response.ok || response.status < 500);
    const cached = () => caches.match(request, { ignoreSearch: true });
    const slow = new Promise(resolve => setTimeout(() => resolve(null), NETWORK_WAIT_MS));
    event.waitUntil(network.catch(() => {}));
    event.respondWith(
        Promise.race([network, slow])
            .then(response => (usable(response) ? response : cached().then(copy => copy || response || network)))
            .catch(() => cached())
    );
});
