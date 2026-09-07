/*
 * Tidewick service worker.
 *
 * Hand-written rather than generated, so it is small enough to read in full
 * and there is no build plugin to keep in step with Vite. It does one thing:
 * make the app open with no network.
 *
 * Strategy: the HTML shell is network-first with a cached fallback, so a new
 * deploy is picked up on the next online visit; everything under /assets/ is
 * content-hashed by Vite and is therefore cache-first forever. The workspace
 * itself never touches the network - it lives in IndexedDB - so "offline" here
 * means the code, not the data.
 *
 * Section 12 asks for offline on every target. The desktop and mobile shells
 * are Tauri and need none of this; the web build is the one that does.
 */
const VERSION = 'tidewick-v1'
const SHELL = ['/', '/index.html', '/manifest.webmanifest']

/*
 * Inside the desktop shell there is nothing for a worker to do - Tauri serves
 * the app from its own origin and it is offline by construction - and there is
 * harm in one: a fetch made from a worker on that origin fails, so an earlier
 * build's worker served its cached shell, whose hashed module no longer
 * existed, and the app opened to a blank window. On that origin this file
 * exists only to remove the previous worker, its caches, and itself, then
 * reload the window it was controlling.
 */
const DESKTOP_SHELL = self.location.hostname.endsWith('tauri.localhost') || self.location.protocol === 'tauri:'

if (DESKTOP_SHELL) {
  self.addEventListener('install', () => self.skipWaiting())
  self.addEventListener('activate', (event) => {
    event.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .then(() => self.registration.unregister())
        .then(() => self.clients.matchAll({ type: 'window' }))
        .then((clients) => clients.forEach((c) => c.navigate(c.url))),
    )
  })
} else {
  self.addEventListener('install', (event) => {
    event.waitUntil(
      caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
    )
  })
  
  self.addEventListener('activate', (event) => {
    event.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
        .then(() => self.clients.claim()),
    )
  })
  
  self.addEventListener('fetch', (event) => {
    const request = event.request
    if (request.method !== 'GET') return
    const url = new URL(request.url)
    if (url.origin !== self.location.origin) return
  
    // Hashed assets: cache first. A hash that matches is the same bytes.
    if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
      event.respondWith(
        caches.match(request).then((hit) => hit ?? fetch(request).then((response) => {
          const copy = response.clone()
          caches.open(VERSION).then((cache) => cache.put(request, copy))
          return response
        })),
      )
      return
    }
  
    // Navigations and the shell: network first, so updates land; cache when the
    // network is gone, so the isle still opens on a train.
    if (request.mode === 'navigate' || SHELL.includes(url.pathname)) {
      event.respondWith(
        fetch(request).then((response) => {
          const copy = response.clone()
          caches.open(VERSION).then((cache) => cache.put(request, copy))
          return response
        }).catch(() => caches.match(request).then((hit) => hit ?? caches.match('/index.html'))),
      )
    }
  })
}
