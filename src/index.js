// Zero-dependency Cloudflare Worker: serves gallery static assets and
// proxies Getchu hotlink-protected images (browser can't set Referer).

var UPSTREAM_HOST = "www.getchu.com";
var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
var ADULT_COOKIE = "getchu_adalt_flag=getchu.com";
var THROTTLE_MS = 700;
var MAX_SAMPLE_N = 40;
var MAX_CID_LEN = 10;
var META_TTL_S = 2592000; // 30 days
var MISS_TTL_S = 604800; // 7 days, failure sentinel so misses are not refetched every time

var lastUpstreamAt = 0;

export function isValidCid(cid) {
  return typeof cid === "string" && /^[0-9]+$/.test(cid) && cid.length <= MAX_CID_LEN;
}

export function isValidSampleN(n) {
  return Number.isInteger(n) && n >= 1 && n <= MAX_SAMPLE_N;
}

export function productUrl(cid) {
  return "https://" + UPSTREAM_HOST + "/soft.phtml?id=" + cid;
}

export function coverUrl(cid) {
  return "https://" + UPSTREAM_HOST + "/brandnew/" + cid + "/rc" + cid + "package.jpg";
}

export function sampleUrl(cid, n) {
  return "https://" + UPSTREAM_HOST + "/brandnew/" + cid + "/c" + cid + "sample" + n + ".jpg";
}

// Max preview index parsed from the product page HTML.
export function parseSampleMax(cid, html) {
  var re = new RegExp("c" + cid + "sample(\\d+)\\.jpg", "g");
  var m;
  var max = 0;
  while ((m = re.exec(html)) !== null) {
    var v = parseInt(m[1], 10);
    if (v > max) max = v;
  }
  return max;
}

// Route the three same-origin paths used by vndb_gallery.html.
export function parseRoute(pathname) {
  var m;
  if ((m = /^\/gc\/meta\/([A-Za-z0-9_.-]+)$/.exec(pathname))) {
    return isValidCid(m[1]) ? { kind: "meta", cid: m[1] } : null;
  }
  if ((m = /^\/gc\/cover\/([A-Za-z0-9_.-]+)\.jpg$/.exec(pathname))) {
    return isValidCid(m[1]) ? { kind: "cover", cid: m[1] } : null;
  }
  if ((m = /^\/gc\/sample\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.jpg$/.exec(pathname))) {
    var n = Number(m[2]);
    return isValidCid(m[1]) && isValidSampleN(n) ? { kind: "sample", cid: m[1], n: n } : null;
  }
  return null;
}

function json(data, status, maxAge) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=" + maxAge,
    },
  });
}

function throttle() {
  var wait = THROTTLE_MS - (Date.now() - lastUpstreamAt);
  if (wait <= 0) {
    lastUpstreamAt = Date.now();
    return Promise.resolve();
  }
  return new Promise(function (resolve) {
    setTimeout(function () {
      lastUpstreamAt = Date.now();
      resolve();
    }, wait);
  });
}

function handleMeta(route, env) {
  var key = "meta:" + route.cid;
  var kv = env && env.GC_META ? env.GC_META : null;
  function fromUpstream() {
    return throttle()
      .then(function () {
        return fetch(productUrl(route.cid), {
          headers: { "user-agent": UA, cookie: ADULT_COOKIE },
        });
      })
      .then(function (up) {
        if (!up.ok) return json({ error: "upstream " + up.status }, 502, 60);
        return up.text().then(function (html) {
          var n = parseSampleMax(route.cid, html);
          // n<=0 (page has no samples) is cached as a miss sentinel so the
          // same cid is not refetched on every request; KV hits with n<=0
          // answer 404, same as a fresh miss.
          var value = JSON.stringify({ n: n, ts: Date.now() });
          var ttl = n > 0 ? META_TTL_S : MISS_TTL_S;
          var done = kv
            ? kv.put(key, value, { expirationTtl: ttl }).catch(function () {})
            : Promise.resolve();
          return done.then(function () {
            if (!n) return json({ error: "not found" }, 404, 60);
            return json({ n: n }, 200, 3600);
          });
        });
      })
      .catch(function () {
        return json({ error: "bad gateway" }, 502, 60);
      });
  }
  if (!kv) return fromUpstream();
  return kv
    .get(key)
    .then(function (cached) {
      if (cached) {
        try {
          var obj = JSON.parse(cached);
          if (obj && Number.isInteger(obj.n)) {
            if (obj.n > 0) return json({ n: obj.n }, 200, 3600);
            return json({ error: "not found" }, 404, 60);
          }
        } catch (e) {
          // Fall through to upstream on corrupt entry.
        }
      }
      return fromUpstream();
    })
    .catch(function () {
      return fromUpstream();
    });
}

function handleImage(route, request, ctx) {
  var upstreamUrl = route.kind === "cover" ? coverUrl(route.cid) : sampleUrl(route.cid, route.n);
  var cacheKey = new Request(request.url, { method: "GET" });
  var cache = caches.default;
  return cache.match(cacheKey).then(function (hit) {
    if (hit) {
      var h = new Headers(hit.headers);
      h.set("cache-control", "public, max-age=86400");
      return new Response(hit.body, { status: hit.status, headers: h });
    }
    return throttle()
      .then(function () {
        // Referer must stay on www.getchu.com or upstream returns 403.
        return fetch(upstreamUrl, {
          headers: {
            "user-agent": UA,
            cookie: ADULT_COOKIE,
            referer: productUrl(route.cid),
          },
        });
      })
      .then(function (up) {
        if (!up.ok) {
          var code = up.status === 404 ? 404 : 502;
          return json({ error: code === 404 ? "not found" : "bad gateway" }, code, 60);
        }
        var headers = new Headers(up.headers);
        headers.set("cache-control", "public, max-age=86400");
        // A cached Set-Cookie would poison the edge cache entry.
        headers.delete("set-cookie");
        var res = new Response(up.body, { status: 200, headers: headers });
        ctx.waitUntil(
          cache.put(cacheKey, res.clone()).catch(function () {})
        );
        return res;
      })
      .catch(function () {
        return json({ error: "bad gateway" }, 502, 60);
      });
  });
}

export default {
  fetch: function (request, env, ctx) {
    if (request.method !== "GET") {
      return Promise.resolve(json({ error: "method not allowed" }, 405, 60));
    }
    var url = new URL(request.url);
    var route = parseRoute(url.pathname);
    if (!route) {
      if (env && env.ASSETS) return env.ASSETS.fetch(request);
      return Promise.resolve(json({ error: "not found" }, 404, 60));
    }
    if (route.kind === "meta") return handleMeta(route, env);
    return handleImage(route, request, ctx);
  },
};
