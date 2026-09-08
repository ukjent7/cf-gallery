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

// FANZA product id: brand prefix plus digits, e.g. alice_0053, d_054457.
export function isValidDmmCid(cid) {
  return typeof cid === "string" && /^[A-Za-z0-9_]+$/.test(cid) && cid.length >= 3 && cid.length <= 32;
}

// DLsite work id: RJ/VJ prefix plus digits.
export function isValidDlId(rid) {
  return typeof rid === "string" && /^[A-Z]+\d+$/.test(rid) && rid.length <= 12;
}

var DL_DOMAINS = ["maniax", "pro", "home"];

export function isValidDlDomain(d) {
  return DL_DOMAINS.indexOf(d) >= 0;
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

// Max sample index parsed from a FANZA detail page.
export function parseDmmMax(cid, html) {
  var re = new RegExp(cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(js|jp)-(\\d+)\\.jpg", "g");
  var m;
  var max = 0;
  while ((m = re.exec(html)) !== null) {
    var v = parseInt(m[2], 10);
    if (v > max) max = v;
  }
  return max;
}

// Sample stems parsed from a DLsite product page, e.g. ["smpa1", ...].
// Stems differ per product (smp1 vs smpa1) and cannot be derived from the id.
export function parseDlStems(rid, html) {
  var re = new RegExp(rid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "_img_(smp[a-z]*\\d+)\\.(?:jpg|webp)", "g");
  var m;
  var seen = {};
  var out = [];
  while ((m = re.exec(html)) !== null) {
    if (!seen[m[1]]) {
      seen[m[1]] = true;
      out.push(m[1]);
    }
  }
  out.sort(function (a, b) {
    var ma = /^smp([a-z]*)(\d+)$/.exec(a);
    var mb = /^smp([a-z]*)(\d+)$/.exec(b);
    if (ma[1] !== mb[1]) return ma[1] < mb[1] ? -1 : 1;
    return parseInt(ma[2], 10) - parseInt(mb[2], 10);
  });
  return out;
}

export function dmmDetailUrl(cid) {
  if (/^d_/i.test(cid)) return "https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=" + cid + "/";
  if (/^[0-9]+[a-z]+[0-9]+[a-z]?$/i.test(cid)) {
    return "https://www.dmm.co.jp/mono/pcgame/-/detail/=/cid=" + cid + "/";
  }
  return "https://dlsoft.dmm.co.jp/detail/" + cid + "/";
}

export function dlProductUrl(rid, domain) {
  return "https://www.dlsite.com/" + domain + "/work/=/product_id/" + rid + ".html";
}

// Route the same-origin paths used by the gallery.
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
  if ((m = /^\/dm\/meta\/([A-Za-z0-9_.-]+)$/.exec(pathname))) {
    return isValidDmmCid(m[1]) ? { kind: "dmm-meta", cid: m[1] } : null;
  }
  if ((m = /^\/dl\/meta\/([A-Za-z0-9_.-]+)$/.exec(pathname))) {
    return isValidDlId(m[1]) ? { kind: "dl-meta", rid: m[1] } : null;
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

// Generic KV-backed lazy meta: serve cached JSON, otherwise fetch one
// upstream page, parse it, cache the result. Misses are cached as a
// sentinel so they are not refetched on every request.
function handleLazyMeta(key, upstreamUrl, extraHeaders, parse, toResponse, env) {
  var kv = env && env.GC_META ? env.GC_META : null;
  function respond(obj) {
    if (obj && obj.hit) return json(toResponse(obj.data), 200, 3600);
    return json({ error: "not found" }, 404, 60);
  }
  function fromUpstream() {
    return throttle()
      .then(function () {
        var headers = { "user-agent": UA };
        for (var k in extraHeaders) headers[k] = extraHeaders[k];
        return fetch(upstreamUrl, { headers: headers });
      })
      .then(function (up) {
        if (!up.ok) return json({ error: "upstream " + up.status }, 502, 60);
        return up.text().then(function (html) {
          var data = parse(html);
          var hit = data !== null && data !== undefined && data !== 0 &&
            !(data instanceof Array && data.length === 0);
          var value = JSON.stringify({ data: hit ? data : 0, hit: hit, ts: Date.now() });
          var done = kv
            ? kv.put(key, value, { expirationTtl: hit ? META_TTL_S : MISS_TTL_S }).catch(function () {})
            : Promise.resolve();
          return done.then(function () {
            return respond({ data: data, hit: hit });
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
          if (obj && typeof obj.hit === "boolean") return respond(obj);
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

function handleMeta(route, env) {
  return handleLazyMeta(
    "meta:" + route.cid,
    productUrl(route.cid),
    { cookie: ADULT_COOKIE },
    function (html) { return parseSampleMax(route.cid, html); },
    function (n) { return { n: n }; },
    env
  );
}

function handleDmmMeta(route, env) {
  return handleLazyMeta(
    "meta:dmm:" + route.cid,
    dmmDetailUrl(route.cid),
    { cookie: "age_check_done=1" },
    function (html) { return parseDmmMax(route.cid, html); },
    function (n) { return { n: n }; },
    env
  );
}

function handleDlMeta(route, domain, env) {
  return handleLazyMeta(
    "meta:dlsite:" + route.rid,
    dlProductUrl(route.rid, domain),
    {},
    function (html) { return parseDlStems(route.rid, html); },
    function (samples) { return { samples: samples, n: samples.length }; },
    env
  );
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
