/* Pilot service worker. App shell: cache-first, refreshed on each new version.
   Deck files: network-first, cached copy when offline. Fonts: cache-first.
   The Claude API (POST to api.anthropic.com) is never touched. */
const VERSION = '1.0.8-2bccc20b';
const SHELL = 'pilot-shell-' + VERSION;
const DATA = 'pilot-data';
const FONTS = 'pilot-fonts';
const SHELL_FILES = ['./', 'index.html', 'app.js', 'engine.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(SHELL_FILES.map(u => new Request(u, {cache: 'reload'})));
    // pre-cache the bundled decks so a fresh install works offline
    try {
      const r = await fetch('decks/index.json', {cache: 'reload'});
      const idx = await r.clone().json();
      const d = await caches.open(DATA);
      await d.put('decks/index.json', r);
      await Promise.all(idx.map(x => fetch('decks/' + x.file, {cache: 'reload'}).then(res => res.ok && d.put('decks/' + x.file, res))));
    } catch (err) { /* offline install: decks load on first online start */ }
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('pilot-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      const res = await fetch(req); if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res;
    }).catch(() => new Response('', {status: 504})));
    return;
  }
  if (url.origin !== self.location.origin) return;
  const rel = url.pathname.slice(self.registration.scope.length - self.location.origin.length);
  if (rel.startsWith('decks/')) {
    e.respondWith((async () => {
      const c = await caches.open(DATA); const key = rel;
      try { const res = await fetch(req); if (res.ok) c.put(key, res.clone()); return res; }
      catch (err) { const hit = await c.match(key); if (hit) return hit; throw err; }
    })());
    return;
  }
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    const hit = await c.match(req, {ignoreSearch: true}) || (req.mode === 'navigate' ? await c.match('index.html') : null);
    return hit || fetch(req);
  })());
});
