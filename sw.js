// Offline support for the app itself. The model files are cached separately by WebLLM ("webllm/..." caches),
// so this worker only handles this site's own files and never touches those caches.
const VERSION = "pc-v1.0.0";
const SHELL = [
  "./", "index.html", "style.css", "app.js", "worker.js", "manifest.webmanifest",
  "vendor/web-llm.js", "vendor/marked.min.js", "vendor/purify.min.js",
  "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/favicon-32.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("pc-v") && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;  // models etc. go straight through
  // Cache first (works offline); refresh the cached copy in the background when online.
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then((r) => {
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    }).catch(() => null);
    return hit || (await fresh) || (url.pathname.endsWith("/") ? cache.match("index.html") : Response.error());
  }));
});
