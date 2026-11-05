/* Service worker: network first, so the phone always gets the latest version, with a cached copy
   of the app shell to fall back on when there's no signal. The MQTT connection and the weather
   lookup always go to the network. */
const CACHE = "x3-remote-v1";
const SHELL = [
  "./", "./index.html", "./app.css", "./app.js", "./manifest.webmanifest", "./vendor/mqtt.min.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png", "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    try {
      const r = await fetch(e.request, { cache: "no-cache" });
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  }));
});
