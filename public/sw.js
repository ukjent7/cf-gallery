// Service Worker for POV559 Nocturne Vault Gallery
// Strategy: Cache-First for media assets & store proxy routes with LRU control.
// Enables 0ms repeat loads, offline viewing, and removes upstream load.

const CACHE_NAME = "nocturne-vault-v1";
const MAX_CACHED_ITEMS = 600;

const UPSTREAM_ASSET_HOSTS = new Set([
  "pics.dmm.co.jp",
  "doujin-assets.dmm.co.jp",
  "img.dlsite.jp",
  "t.vndb.org",
  "ecimages.getchu.com"
]);

const CACHEABLE_PROXIES = /^\/(gc\/(cover|sample)|(dm|dl|gc)\/meta)\//;

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((k) => {
          if (k !== CACHE_NAME) return caches.delete(k);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Enforce LRU item limit to stay respectful of user disk space
async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_CACHED_ITEMS) {
    const toDelete = keys.slice(0, keys.length - MAX_CACHED_ITEMS);
    for (const req of toDelete) {
      await cache.delete(req);
    }
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const isUpstreamMedia = UPSTREAM_ASSET_HOSTS.has(url.hostname);
  const isCacheableProxy = url.origin === self.location.origin && CACHEABLE_PROXIES.test(url.pathname);

  if (isUpstreamMedia || isCacheableProxy) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;

        try {
          const res = await fetch(req);
          if (res && res.status === 200) {
            cache.put(req, res.clone());
            trimCache(cache);
          }
          return res;
        } catch (err) {
          return cached || new Response("Network error", { status: 504 });
        }
      })
    );
  }
});
