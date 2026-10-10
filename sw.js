// Offline support for the app itself. The model files are cached separately by WebLLM ("webllm/..." caches),
// so this worker only handles this site's own files and never touches those caches.
const VERSION = "pc-v1.2.0";
const SHELL = [
  "./", "index.html", "style.css", "app.js", "worker.js", "manifest.webmanifest",
  "vendor/web-llm.js", "vendor/marked.min.js", "vendor/purify.min.js",
  "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/favicon-32.png",
];
const NETWORK_TIMEOUT_MS = 2500;

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
  // Big libraries and icons never change within a version: cache first. The app's own small files: network
  // first (so fixes arrive on the next open), falling back to the cache when offline or slow.
  const stable = url.pathname.includes("/vendor/") || url.pathname.includes("/icons/");
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const cached = () => cache.match(e.request, { ignoreSearch: true })
      .then((hit) => hit || (e.request.mode === "navigate" ? cache.match("index.html") : undefined));
    if (stable) return (await cached()) || fetch(e.request);
    try {
      const r = await Promise.race([
        fetch(e.request),
        new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), NETWORK_TIMEOUT_MS)),
      ]);
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    } catch (err) {
      return (await cached()) || Response.error();
    }
  }));
});
