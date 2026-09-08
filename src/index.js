// Zero-dependency Cloudflare Worker: serves gallery static assets and proxies
// Getchu hotlink-protected images (the browser can't set Referer).
//
// All store URL rules live in src/urls.js so the Worker, the browser bundle, and
// the Python data scripts agree.
//
// KV write budget (free tier: 1,000 writes/day) drives three deliberate choices:
//   1. Hits are cached in KV (durable, cheap, amortised over 30 days).
//   2. Misses are NOT written to KV. They are negative-cached via the CDN
//      edge cache with a long s-maxage instead, so a storm of misses costs
//      zero KV writes.
//   3. In-flight requests are deduplicated per isolate, so one page view that
//      opens three stores issues at most one upstream fetch each.

import {
  DMM_SAMPLE_CAP,
  GETCHU_SAMPLE_CAP,
  dlProductUrl,
  dmmDetailUrl,
  gcCoverUrl,
  gcProductUrl,
  gcSampleUrl,
  isDlDomain,
  isDlId,
  isDmmCid,
  isGetchuCid,
  parseDlStems,
  parseDmmMax,
  parseSampleMax,
} from "./urls.js";

var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
var ADULT_COOKIE = "getchu_adalt_flag=getchu.com";
var DMM_COOKIE = "age_check_done=1";
var THROTTLE_MS = 700;
var META_TTL_S = 2592000; // 30 days: hits live long, so refetches stay rare
var MISS_EDGE_TTL_S = 86400; // 24h negative cache at the edge, no KV write
var HIT_EDGE_TTL_S = 3600;
var INFLIGHT_TTL_MS = 30000;

var lastUpstreamAt = 0;
var inflight = new Map();

// Thin validation wrappers over the shared rules, kept as named exports so the
// route table and the tests speak one language.
export function isValidCid(cid) {
  return isGetchuCid(cid);
}

export function isValidSampleN(n) {
  return Number.isInteger(n) && n >= 1 && n <= GETCHU_SAMPLE_CAP;
}

export function isValidDmmCid(cid) {
  return isDmmCid(cid);
}

export function isValidDlId(rid) {
  return isDlId(rid);
}

export function isValidDlDomain(d) {
  return isDlDomain(d);
}

export { dlProductUrl, dmmDetailUrl, gcCoverUrl, gcProductUrl, gcSampleUrl };
export { parseDlStems, parseDmmMax, parseSampleMax };

// Route table: one place mapping path -> what to do with it.
var ROUTES = [
  { re: /^\/gc\/meta\/([A-Za-z0-9_.-]+)$/, kind: "meta", idOf: function (m) { return { cid: m[1] }; }, ok: isGetchuCid },
  { re: /^\/gc\/cover\/([A-Za-z0-9_.-]+)\.jpg$/, kind: "cover", idOf: function (m) { return { cid: m[1] }; }, ok: isGetchuCid },
  {
    re: /^\/gc\/sample\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.jpg$/,
    kind: "sample",
    idOf: function (m) { return { cid: m[1], n: Number(m[2]) }; },
    ok: function (params, m) { return isGetchuCid(m[1]) && isValidSampleN(Number(m[2])); },
  },
  { re: /^\/dm\/meta\/([A-Za-z0-9_.-]+)$/, kind: "dmm-meta", idOf: function (m) { return { cid: m[1] }; }, ok: isDmmCid },
  { re: /^\/dl\/meta\/([A-Za-z0-9_.-]+)$/, kind: "dl-meta", idOf: function (m) { return { rid: m[1] }; }, ok: isDlId },
];

export function parseRoute(pathname) {
  for (var i = 0; i < ROUTES.length; i++) {
    var r = ROUTES[i];
    var m = r.re.exec(pathname);
    if (!m) continue;
    var params = r.idOf(m);
    var key = Object.keys(params)[0];
    if (!r.ok(params[key], m)) return null;
    return Object.assign({ kind: r.kind }, params);
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

// Deduplicate concurrent identical lookups within this isolate. Without this a
// single 综合 modal open (Getchu + DLsite + FANZA, each possibly retried) can
// issue several upstream fetches for the same key and multiply KV writes.
function singleFlight(key, work) {
  var now = Date.now();
  var existing = inflight.get(key);
  if (existing && now - existing.at < INFLIGHT_TTL_MS) return existing.p;
  var p = work().then(
    function (v) {
      inflight.delete(key);
      return v;
    },
    function (e) {
      inflight.delete(key);
      throw e;
    }
  );
  inflight.set(key, { p: p, at: now });
  return p;
}

// KV-backed lazy meta.
//
// Cached shape: {"data": <parsed>, "hit": <boolean>, "ts": <ms>}
//   hit:true  -> serve data, no upstream call.
//   hit:false -> serve 404, no upstream call. Only created by the seed file:
//                writing runtime misses to KV is what burned the write budget.
// Anything else (legacy {"n":..} entries, corrupt JSON) counts as absent and is
// refetched, which rewrites it in the current shape.
function handleLazyMeta(config, env) {
  var kv = env && env.GC_META ? env.GC_META : null;

  function respondHit(data) {
    return json(config.toResponse(data), 200, HIT_EDGE_TTL_S);
  }
  function respondMiss() {
    // Long s-maxage: the CDN absorbs repeat misses and the Worker never re-runs,
    // so a miss costs nothing without needing a KV write.
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=60, s-maxage=" + MISS_EDGE_TTL_S + ", stale-while-revalidate=3600",
      },
    });
  }

  function readKv() {
    if (!kv) return Promise.resolve(null);
    return kv.get(config.key).then(function (cached) {
      if (!cached) return null;
      try {
        var obj = JSON.parse(cached);
        return obj && typeof obj.hit === "boolean" ? obj : null;
      } catch (e) {
        return null;
      }
    });
  }

  function fromUpstream() {
    return singleFlight(config.key, function () {
      // Re-check KV inside the flight: deduplicated callers must not each
      // refetch after the first one already populated the key.
      return readKv().then(function (fresh) {
        if (fresh) return fresh.hit ? respondHit(fresh.data) : respondMiss();
        return throttle()
          .then(function () {
            var headers = { "user-agent": UA };
            for (var k in config.headers) headers[k] = config.headers[k];
            return fetch(config.upstreamUrl, { headers: headers });
          })
          .then(function (up) {
            if (!up.ok) return json({ error: "upstream " + up.status }, 502, 60);
            return up.text().then(function (html) {
              var data = config.parse(html);
              var hit = data !== null && data !== undefined && data !== 0 &&
                !(data instanceof Array && data.length === 0);
              if (!hit || !kv) return hit ? respondHit(data) : respondMiss();
              var value = JSON.stringify({ data: data, hit: true, ts: Date.now() });
              // Write only when the key was empty, which readKv() just proved.
              // An existing hit is up to META_TTL_S old, so rewriting it costs a
              // write and buys nothing.
              return kv.put(config.key, value, { expirationTtl: META_TTL_S })
                .catch(function () {})
                .then(function () {
                  return respondHit(data);
                });
            });
          })
          .catch(function () {
            return json({ error: "bad gateway" }, 502, 60);
          });
      });
    });
  }

  return readKv().then(function (obj) {
    if (obj) return obj.hit ? respondHit(obj.data) : respondMiss();
    return fromUpstream();
  }, function () {
    return fromUpstream();
  });
}

function handleMeta(route, env) {
  return handleLazyMeta(
    {
      key: "meta:" + route.cid,
      upstreamUrl: gcProductUrl(route.cid),
      headers: { cookie: ADULT_COOKIE },
      parse: function (html) { return parseSampleMax(route.cid, html); },
      toResponse: function (n) { return { n: Math.min(n, GETCHU_SAMPLE_CAP) }; },
    },
    env
  );
}

function handleDmmMeta(route, env) {
  return handleLazyMeta(
    {
      key: "meta:dmm:" + route.cid,
      upstreamUrl: dmmDetailUrl(route.cid),
      headers: { cookie: DMM_COOKIE },
      parse: function (html) { return parseDmmMax(route.cid, html); },
      toResponse: function (n) { return { n: Math.min(n, DMM_SAMPLE_CAP) }; },
    },
    env
  );
}

function handleDlMeta(route, domain, env) {
  return handleLazyMeta(
    {
      key: "meta:dlsite:" + route.rid,
      upstreamUrl: dlProductUrl(route.rid, domain),
      headers: {},
      parse: function (html) { return parseDlStems(route.rid, html); },
      toResponse: function (samples) { return { samples: samples, n: samples.length }; },
    },
    env
  );
}

function imageHeaders(up) {
  var headers = new Headers(up.headers);
  headers.set("cache-control", "public, max-age=86400");
  // A cached Set-Cookie would poison the edge cache entry.
  headers.delete("set-cookie");
  return headers;
}

function handleImage(route, request, ctx) {
  var upstreamUrl = route.kind === "cover" ? gcCoverUrl(route.cid) : gcSampleUrl(route.cid, route.n);
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
            referer: gcProductUrl(route.cid),
          },
        });
      })
      .then(function (up) {
        if (!up.ok) {
          var code = up.status === 404 ? 404 : 502;
          return json({ error: code === 404 ? "not found" : "bad gateway" }, code, 60);
        }
        var res = new Response(up.body, { status: 200, headers: imageHeaders(up) });
        ctx.waitUntil(cache.put(cacheKey, res.clone()).catch(function () {}));
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
    if (route.kind === "dmm-meta") return handleDmmMeta(route, env);
    if (route.kind === "dl-meta") {
      var domain = url.searchParams.get("domain") || "maniax";
      if (!isValidDlDomain(domain)) {
        return Promise.resolve(json({ error: "bad domain" }, 400, 60));
      }
      return handleDlMeta(route, domain, env);
    }
    return handleImage(route, request, ctx);
  },
};
