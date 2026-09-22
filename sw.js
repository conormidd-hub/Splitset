// Service worker: lets the installed app open with no signal (at the gym, say) and open
// fast everywhere else.
//
//   the page itself   network first, but give up after a few seconds and show the saved
//                     copy - the network request keeps going and refreshes that copy for
//                     next time, so a Sync now is still picked up on reload
//   icons, manifest,  cache first (the page warms the illustration cache after it loads)
//   exercise art
//   CDN libraries     cache first (Leaflet, fonts)
//   /api/*            never cached; the page keeps its own offline copy of the plan and gym log
//   map tiles         not cached - there are thousands of them

const VERSION = "v64ded7fa";
const PAGES = `pages-${VERSION}`;
const STATIC = `static-${VERSION}`;
const PAGE_TIMEOUT_MS = 4000;
const PRECACHE = ["./", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png",
  "icons/apple-touch-icon.png", "icons/favicon-32.png", "icons/mark-96.png", "icons/badge-96.png"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC);
    // one at a time and ignoring failures: behind Cloudflare Access a request can bounce
    // to the login page, and that mustn't stop the worker installing
    for (const url of PRECACHE) {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (res.ok && res.type === "basic") await cache.put(url, res);
      } catch (e) { /* offline during install */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (![PAGES, STATIC].includes(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// only store real copies of our own pages - never a redirect to the Access login
const storable = (res) => res && res.ok && res.type === "basic";

async function pageFirst(request) {
  const cache = await caches.open(PAGES);
  const key = new URL(request.url);
  key.hash = "";
  key.search = "";
  const network = fetch(request).then(async (res) => {
    if (storable(res)) await cache.put(key.href, res.clone());
    return res;
  });
  const saved = await cache.match(key.href) || await (await caches.open(STATIC)).match("./");
  if (!saved) return network;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(saved), PAGE_TIMEOUT_MS));
  try {
    return await Promise.race([network.catch(() => saved), timeout]);
  } catch (e) {
    return saved;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // CDN files come back "cors" or "opaque"; both are fine to reuse
  if (res && (res.ok || res.type === "opaque")) await cache.put(request, res.clone());
  return res;
}

/* Gym timers: the page hands the finish time over so a rest that ends while you're out of the
   app still tells you. waitUntil keeps this worker alive until it fires; the page cancels on
   pause or stop, and shows the same notification itself if it's still awake, which collapses
   into one because they share a tag. */
let timerJob = null;
self.addEventListener("message", (event) => {
  const m = event.data || {};
  if (m.type === "skip-waiting") return void self.skipWaiting();
  if (m.type === "timer-arm") {
    if (timerJob) { clearTimeout(timerJob.t); timerJob.done(); }
    event.waitUntil(new Promise((done) => {
      const t = setTimeout(async () => {
        timerJob = null;
        await self.registration.showNotification(m.title || "Timer finished", {
          body: m.body || "",
          icon: "icons/icon-192.png",
          badge: "icons/badge-96.png",
          tag: "gym-timer",
          renotify: true,
          vibrate: [120, 60, 120, 60, 240],
          data: { url: m.url || "./" },
        });
        done();
      }, Math.max(0, (m.at || 0) - Date.now()));
      timerJob = { t, done };
    }));
  }
  if (m.type === "timer-cancel" && timerJob) {
    clearTimeout(timerJob.t);
    timerJob.done();
    timerJob = null;
  }
});

// notifications: the morning brief and what's on today, sent by send_push.py after the build
self.addEventListener("push", (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch (e) { m = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(m.title || "Running dashboard", {
    body: m.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/badge-96.png",
    tag: m.tag || "dashboard",        // same tag replaces rather than stacks up
    renotify: true,
    data: { url: m.url || "./" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "./", self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // bring an open copy to the front rather than opening a second one
    for (const c of all) {
      if (c.url.startsWith(self.location.origin)) {
        await c.focus();
        if ("navigate" in c) await c.navigate(url).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/api/")) return;
    if (req.mode === "navigate") return event.respondWith(pageFirst(req));
    if (/\/(icons\/|exercise-art\/|manifest\.webmanifest$)/.test(url.pathname)) return event.respondWith(cacheFirst(req));
    return;
  }
  if (["cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname)) {
    event.respondWith(cacheFirst(req));
  }
});
