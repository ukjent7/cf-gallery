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

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const ADULT_COOKIE = "getchu_adalt_flag=getchu.com";
const DMM_COOKIE = "age_check_done=1";
const THROTTLE_MS = 700;
const META_TTL_S = 2592000; // 30 days: hits live long, so refetches stay rare
const MISS_EDGE_TTL_S = 86400; // 24h negative cache at the edge, no KV write
const HIT_EDGE_TTL_S = 3600;
const INFLIGHT_TTL_MS = 30000;

let lastUpstreamAt = 0;
const inflight = new Map();

// Worker-level validation contract, used by the route table and the tests.
// The id shapes delegate to the shared rules in src/urls.js; the sample
// range additionally encodes this worker's display cap policy.
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

// Route table: one place mapping path -> what to do with it. Every ok()
// handler takes the parsed params (and the raw match when needed), so the
// next route addition does not have to guess the convention.
const ROUTES = [
  {
    re: /^\/gc\/meta\/([A-Za-z0-9_.-]+)$/,
    kind: "meta",
    idOf: (m) => ({ cid: m[1] }),
    ok: (p) => isGetchuCid(p.cid),
  },
  {
    re: /^\/gc\/cover\/([A-Za-z0-9_.-]+)\.jpg$/,
    kind: "cover",
    idOf: (m) => ({ cid: m[1] }),
    ok: (p) => isGetchuCid(p.cid),
  },
  {
    re: /^\/gc\/sample\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.jpg$/,
    kind: "sample",
    idOf: (m) => ({ cid: m[1], n: Number(m[2]) }),
    ok: (p) => isGetchuCid(p.cid) && isValidSampleN(p.n),
  },
  {
    re: /^\/dm\/meta\/([A-Za-z0-9_.-]+)$/,
    kind: "dmm-meta",
    idOf: (m) => ({ cid: m[1] }),
    ok: (p) => isDmmCid(p.cid),
  },
  {
    re: /^\/dl\/meta\/([A-Za-z0-9_.-]+)$/,
    kind: "dl-meta",
    idOf: (m) => ({ rid: m[1] }),
    ok: (p) => isDlId(p.rid),
  },
];

export function parseRoute(pathname) {
  for (const r of ROUTES) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    const params = r.idOf(m);
    if (!r.ok(params, m)) return null;
    return { kind: r.kind, ...params };
  }
  return null;
}

function json(data, status, maxAge) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=" + maxAge,
    },
  });
}

async function throttle() {
  const wait = THROTTLE_MS - (Date.now() - lastUpstreamAt);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastUpstreamAt = Date.now();
}

// Deduplicate concurrent identical lookups within this isolate. Without this a
// single 综合 modal open (Getchu + DLsite + FANZA, each possibly retried) can
// issue several upstream fetches for the same key and multiply KV writes.
function singleFlight(key, work) {
  const now = Date.now();
  const existing = inflight.get(key);
  if (existing && now - existing.at < INFLIGHT_TTL_MS) return existing.p;
  const p = (async () => {
    try {
      return await work();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, { p, at: now });
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
async function handleLazyMeta(config, env) {
  const kv = env && env.GC_META ? env.GC_META : null;

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
        "cache-control":
          "public, max-age=60, s-maxage=" +
          MISS_EDGE_TTL_S +
          ", stale-while-revalidate=3600",
      },
    });
  }

  async function readKv() {
    if (!kv) return null;
    try {
      const cached = await kv.get(config.key);
      if (!cached) return null;
      const obj = JSON.parse(cached);
      return obj && typeof obj.hit === "boolean" ? obj : null;
    } catch {
      return null;
    }
  }

  async function fromUpstream() {
    return singleFlight(config.key, async () => {
      // Re-check KV inside the flight: deduplicated callers must not each
      // refetch after the first one already populated the key.
      const fresh = await readKv();
      if (fresh) return fresh.hit ? respondHit(fresh.data) : respondMiss();

      await throttle();
      let up;
      try {
        const headers = { "user-agent": UA, ...config.headers };
        up = await fetch(config.upstreamUrl, { headers });
      } catch {
        return json({ error: "bad gateway" }, 502, 60);
      }

      if (!up.ok) return json({ error: "upstream " + up.status }, 502, 60);

      try {
        const html = await up.text();
        const data = config.parse(html);
        const hit =
          data !== null &&
          data !== undefined &&
          data !== 0 &&
          !(Array.isArray(data) && data.length === 0);

        if (!hit || !kv) return hit ? respondHit(data) : respondMiss();

        const value = JSON.stringify({ data, hit: true, ts: Date.now() });
        // Write only when the key was empty, which readKv() just proved.
        // An existing hit is up to META_TTL_S old, so rewriting it costs a
        // write and buys nothing.
        try {
          await kv.put(config.key, value, { expirationTtl: META_TTL_S });
        } catch {
          // write failure does not prevent serving
        }
        return respondHit(data);
      } catch {
        return json({ error: "bad gateway" }, 502, 60);
      }
    });
  }

  try {
    const obj = await readKv();
    if (obj) return obj.hit ? respondHit(obj.data) : respondMiss();
  } catch {
    // fallback to upstream
  }
  return fromUpstream();
}

function handleMeta(route, env) {
  return handleLazyMeta(
    {
      key: "meta:" + route.cid,
      upstreamUrl: gcProductUrl(route.cid),
      headers: { cookie: ADULT_COOKIE },
      parse: (html) => parseSampleMax(route.cid, html),
      toResponse: (n) => ({ n: Math.min(n, GETCHU_SAMPLE_CAP) }),
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
      parse: (html) => parseDmmMax(route.cid, html),
      toResponse: (n) => ({ n: Math.min(n, DMM_SAMPLE_CAP) }),
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
      parse: (html) => parseDlStems(route.rid, html),
      toResponse: (samples) => ({ samples, n: samples.length }),
    },
    env
  );
}

function imageHeaders(up) {
  const headers = new Headers(up.headers);
  headers.set(
    "cache-control",
    "public, max-age=2592000, s-maxage=2592000, immutable"
  );
  // A cached Set-Cookie would poison the edge cache entry.
  headers.delete("set-cookie");
  return headers;
}

async function handleImage(route, request, ctx) {
  const upstreamUrl =
    route.kind === "cover"
      ? gcCoverUrl(route.cid)
      : gcSampleUrl(route.cid, route.n);
  const cacheKey = new Request(request.url, { method: "GET" });
  const cache = typeof caches !== "undefined" ? caches.default : null;

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const h = new Headers(hit.headers);
      h.set(
        "cache-control",
        "public, max-age=2592000, s-maxage=2592000, immutable"
      );
      return new Response(hit.body, { status: hit.status, headers: h });
    }
  }

  await throttle();

  let up;
  try {
    // Referer must stay on www.getchu.com or upstream returns 403.
    up = await fetch(upstreamUrl, {
      headers: {
        "user-agent": UA,
        cookie: ADULT_COOKIE,
        referer: gcProductUrl(route.cid),
      },
    });
  } catch {
    return json({ error: "bad gateway" }, 502, 60);
  }

  if (!up.ok) {
    const code = up.status === 404 ? 404 : 502;
    return json({ error: code === 404 ? "not found" : "bad gateway" }, code, 60);
  }

  // If cover is nowprinting placeholder, treat as 404 so client falls back to other platforms
  if (route.kind === "cover") {
    const upUrl = up.url || "";
    const cl = up.headers.get("content-length");
    if (upUrl.includes("nowprinting") || cl === "5372") {
      return json({ error: "not found" }, 404, 60);
    }
  }

  const res = new Response(up.body, { status: 200, headers: imageHeaders(up) });
  if (cache && ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
  }
  return res;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405, 60);
    }
    const url = new URL(request.url);
    const route = parseRoute(url.pathname);
    if (!route) {
      if (env && env.ASSETS) return env.ASSETS.fetch(request);
      return json({ error: "not found" }, 404, 60);
    }
    if (route.kind === "meta") return handleMeta(route, env);
    if (route.kind === "dmm-meta") return handleDmmMeta(route, env);
    if (route.kind === "dl-meta") {
      const domain = url.searchParams.get("domain") || "maniax";
      if (!isValidDlDomain(domain)) {
        return json({ error: "bad domain" }, 400, 60);
      }
      return handleDlMeta(route, domain, env);
    }
    return handleImage(route, request, ctx);
  },
};
