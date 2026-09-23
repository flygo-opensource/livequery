// App shell service worker (generated into dist/ by vite.config.ts). The API and the WebSocket are
// never touched: offline reads and writes are the SharedWorker's job, with IndexedDB and its outbox.
const VERSION = '__VERSION__'
const FILES = __FILES__
const CACHE = `chat-shell-${VERSION}`

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(key => key.startsWith('chat-shell-') && key !== CACHE).map(key => caches.delete(key))))
        .then(() => self.clients.claim()))
})

self.addEventListener('fetch', event => {
    const request = event.request
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.origin !== self.location.origin) return
    if (url.pathname.startsWith('/livequery/') || url.pathname === '/health' || url.pathname === '/sw.js') return
    // Every page of the app is index.html; the router picks the screen.
    const key = request.mode === 'navigate' ? '/index.html' : url.pathname
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(key)) ?? fetch(request)))
})
