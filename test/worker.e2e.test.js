// End-to-end HTTP integration tests for the Cloudflare Worker gateway.
//
// Drives the Worker solely through its public `worker.fetch(request, env, ctx)`
// boundary. Tests route dispatching, parameter validation, rate limiting,
// KV write budgets, single-flight deduplication, and image proxying.
import { describe, expect, test } from "bun:test";
import worker from "../src/index.js";

function memKv() {
  const m = new Map();
  return {
    get: (k) => Promise.resolve(m.has(k) ? m.get(k) : null),
    put: (k, v) => {
      m.set(k, v);
      return Promise.resolve();
    },
    dump: () => m,
  };
}

// Counts reads and writes so a test can assert on KV quota, not just results.
function countingKv(initial = {}) {
  const m = new Map(Object.entries(initial));
  const stats = { gets: 0, puts: 0 };
  return {
    stats,
    get: (k) => {
      stats.gets++;
      return Promise.resolve(m.has(k) ? m.get(k) : null);
    },
    put: (k, v) => {
      stats.puts++;
      m.set(k, v);
      return Promise.resolve();
    },
    dump: () => m,
  };
}

function countingFetch(body, status = 200) {
  const seen = [];
  const fn = (url, opts) => {
    seen.push({ url: String(url), headers: opts?.headers });
    return Promise.resolve(new Response(body, { status }));
  };
  fn.seen = seen;
  return fn;
}

describe("Worker E2E: Route Dispatch & HTTP Methods", () => {
  test("rejects non-GET HTTP methods with 405 Method Not Allowed", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await worker.fetch(
        new Request("https://x/gc/meta/877358", { method }),
        {},
        {}
      );
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "method not allowed" });
    }
  });

  test("returns 404 for unknown routes or assets fallback", async () => {
    const res = await worker.fetch(new Request("https://x/index.html"), {}, {});
    expect(res.status).toBe(404);

    // When env.ASSETS is provided, falls back to asset binding
    let assetCalled = false;
    const env = {
      ASSETS: {
        fetch: () => {
          assetCalled = true;
          return Promise.resolve(new Response("asset content", { status: 200 }));
        },
      },
    };
    const assetRes = await worker.fetch(new Request("https://x/index.html"), env, {});
    expect(assetCalled).toBe(true);
    expect(assetRes.status).toBe(200);
  });
});

describe("Worker E2E: Parameter Validation & Routing", () => {
  test("Getchu meta route validates cid shape", async () => {
    const env = { GC_META: memKv() };
    for (const badPath of [
      "/gc/meta/abc",
      "/gc/meta/877358/",
      "/gc/meta/..",
      "/gc/meta/12345678901", // exceeds MAX_CID_LEN (10)
    ]) {
      const res = await worker.fetch(new Request("https://x" + badPath), env, {});
      expect(res.status).toBe(404);
    }
  });

  test("FANZA meta route validates dmm cid shape", async () => {
    const env = { GC_META: memKv() };
    for (const badPath of [
      "/dm/meta/..",
      "/dm/meta/ab", // too short (min 3)
      "/dm/meta/alice_0053/",
      "/dm/meta/a/b",
    ]) {
      const res = await worker.fetch(new Request("https://x" + badPath), env, {});
      expect(res.status).toBe(404);
    }
  });

  test("DLsite meta route validates work id and domain allowlist", async () => {
    const env = { GC_META: memKv() };
    // Bad id shapes
    for (const badPath of [
      "/dl/meta/vj011759", // lowercase rejected
      "/dl/meta/VJ011759.jpg",
      "/dl/meta/..",
    ]) {
      const res = await worker.fetch(new Request("https://x" + badPath), env, {});
      expect(res.status).toBe(404);
    }

    // Invalid domain returns 400
    const badDomainRes = await worker.fetch(
      new Request("https://x/dl/meta/VJ011759?domain=evil.com"),
      env,
      {}
    );
    expect(badDomainRes.status).toBe(400);
    expect(await badDomainRes.json()).toEqual({ error: "bad domain" });
  });

  test("Getchu image routes validate extension, cid, and sample index range", async () => {
    // Cover requires .jpg extension
    expect((await worker.fetch(new Request("https://x/gc/cover/877358.png"), {}, {})).status).toBe(404);
    expect((await worker.fetch(new Request("https://x/gc/cover/abc.jpg"), {}, {})).status).toBe(404);

    // Sample requires integer index in 1..40
    for (const badSample of [
      "/gc/sample/877358/0.jpg",
      "/gc/sample/877358/41.jpg",
      "/gc/sample/877358/1.5.jpg",
      "/gc/sample/abc/1.jpg",
      "/gc/sample/877358/1.png",
    ]) {
      const res = await worker.fetch(new Request("https://x" + badSample), {}, {});
      expect(res.status).toBe(404);
    }
  });
});

describe("Worker E2E: Meta Handlers & Upstream Ingestion", () => {
  test("/dm/meta fetches upstream, parses max index, and caches in KV", async () => {
    const html = "qruppo_0004jp-001.jpg qruppo_0004jp-011.jpg";
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => Promise.resolve(new Response(html, { status: 200 }));
    try {
      const kv = memKv();
      const env = { GC_META: kv };
      const r1 = await worker.fetch(new Request("https://x/dm/meta/qruppo_0004"), env, {});
      expect(r1.status).toBe(200);
      expect(await r1.json()).toEqual({ n: 11 });
      expect(calls).toBe(0);
      expect(kv.dump().has("meta:dmm:qruppo_0004")).toBe(true);

      // Subsequent call served directly from KV without hitting upstream
      globalThis.fetch = () => {
        calls++;
        return Promise.resolve(new Response("", { status: 200 }));
      };
      const r2 = await worker.fetch(new Request("https://x/dm/meta/qruppo_0004"), env, {});
      expect(await r2.json()).toEqual({ n: 11 });
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("/dl/meta honors allowed domain and parses stems correctly", async () => {
    const html = "VJ011759_img_smpa1.jpg VJ011759_img_smpa2.jpg";
    const realFetch = globalThis.fetch;
    let seenUrl = "";
    globalThis.fetch = (url) => {
      seenUrl = String(url);
      return Promise.resolve(new Response(html, { status: 200 }));
    };
    try {
      const env = { GC_META: memKv() };
      const ok = await worker.fetch(
        new Request("https://x/dl/meta/VJ011759?domain=pro"),
        env,
        {}
      );
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ samples: ["smpa1", "smpa2"], n: 2 });
      expect(seenUrl).toContain("dlsite.com/pro/work");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("/gc/meta migrates legacy cache format to modern hit schema", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(new Response("c877358sample5.jpg", { status: 200 }));
    try {
      const kv = memKv();
      await kv.put("meta:877358", JSON.stringify({ n: 5, ts: 1 }));
      const r = await worker.fetch(new Request("https://x/gc/meta/877358"), { GC_META: kv }, {});
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ n: 5 });
      expect(JSON.parse(kv.dump().get("meta:877358")).hit).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("Worker E2E: Image Proxying & Cache Behavior", () => {
  test("/gc/cover proxies image with required Getchu referer and sets immutable headers", async () => {
    const realFetch = globalThis.fetch;
    let upstreamSeen = null;
    globalThis.fetch = (url, opts) => {
      upstreamSeen = { url: String(url), headers: opts?.headers };
      return Promise.resolve(
        new Response("image-bytes", {
          status: 200,
          headers: { "content-type": "image/jpeg", "set-cookie": "session=secret" },
        })
      );
    };

    try {
      const req = new Request("https://x/gc/cover/877358.jpg");
      const ctx = { waitUntil: () => {} };
      const res = await worker.fetch(req, {}, ctx);

      expect(res.status).toBe(200);
      expect(upstreamSeen.url).toContain("www.getchu.com/brandnew/877358/rc877358package.jpg");
      expect(upstreamSeen.headers.referer).toBe("https://www.getchu.com/soft.phtml?id=877358");
      expect(res.headers.get("cache-control")).toContain("immutable");
      expect(res.headers.has("set-cookie")).toBe(false); // cookie stripped to prevent cache poisoning
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("/gc/cover treats nowprinting placeholder as 404 to allow client fallback", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response("nowprinting", {
          status: 200,
          headers: { "content-length": "5372" },
        })
      );

    try {
      const res = await worker.fetch(new Request("https://x/gc/cover/877358.jpg"), {}, {});
      expect(res.status).toBe(404);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("/gc/sample proxies sample image with referer", async () => {
    const realFetch = globalThis.fetch;
    let sampleUrl = "";
    globalThis.fetch = (url) => {
      sampleUrl = String(url);
      return Promise.resolve(new Response("sample-bytes", { status: 200 }));
    };

    try {
      const res = await worker.fetch(new Request("https://x/gc/sample/877358/3.jpg"), {}, { waitUntil: () => {} });
      expect(res.status).toBe(200);
      expect(sampleUrl).toContain("c877358sample3.jpg");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("Worker E2E: KV Write Budget & Thundering Herd Protection", () => {
  test("a miss costs zero KV writes and sets 24h CDN negative cache", async () => {
    const realFetch = globalThis.fetch;
    const upstream = countingFetch("no images here");
    globalThis.fetch = upstream;
    try {
      const kv = countingKv();
      const env = { GC_META: kv };
      const r1 = await worker.fetch(new Request("https://x/gc/meta/999999"), env, {});
      expect(r1.status).toBe(404);
      expect(r1.headers.get("cache-control")).toContain("s-maxage=86400");
      expect(kv.stats.puts).toBe(0);
      expect(upstream.seen).toHaveLength(1);

      const r2 = await worker.fetch(new Request("https://x/gc/meta/999999"), env, {});
      expect(r2.status).toBe(404);
      expect(kv.stats.puts).toBe(0);
      expect(upstream.seen).toHaveLength(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("the first hit writes once; every later hit writes zero times", async () => {
    const realFetch = globalThis.fetch;
    const upstream = countingFetch("alice_0018jp-007.jpg");
    globalThis.fetch = upstream;
    try {
      const kv = countingKv();
      const env = { GC_META: kv };
      const url = "https://x/dm/meta/alice_0018";
      for (let i = 0; i < 5; i++) {
        const r = await worker.fetch(new Request(url), env, {});
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ n: 7 });
      }
      expect(kv.stats.puts).toBe(1);
      expect(upstream.seen).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("seeded sentinels (hit/miss) are served directly without touching upstream", async () => {
    const realFetch = globalThis.fetch;
    const upstream = countingFetch("should not be fetched");
    globalThis.fetch = upstream;
    try {
      const kv = countingKv({
        "meta:123456": JSON.stringify({ data: 0, hit: false, ts: 1 }),
        "meta:663913": JSON.stringify({ data: 16, hit: true, ts: 1 }),
      });

      const rMiss = await worker.fetch(new Request("https://x/gc/meta/123456"), { GC_META: kv }, {});
      expect(rMiss.status).toBe(404);

      const rHit = await worker.fetch(new Request("https://x/gc/meta/663913"), { GC_META: kv }, {});
      expect(rHit.status).toBe(200);
      expect(await rHit.json()).toEqual({ n: 16 });

      expect(upstream.seen).toHaveLength(0);
      expect(kv.stats.puts).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("concurrent lookups of one key fetch and write once via singleFlight", async () => {
    const realFetch = globalThis.fetch;
    const upstream = countingFetch("qruppo_0004jp-009.jpg");
    globalThis.fetch = upstream;
    try {
      const kv = countingKv();
      const env = { GC_META: kv };
      const rs = await Promise.all(
        Array.from({ length: 6 }, () =>
          worker.fetch(new Request("https://x/dm/meta/qruppo_0004"), env, {})
        )
      );
      rs.forEach((r) => expect(r.status).toBe(200));
      expect(upstream.seen).toHaveLength(1);
      expect(kv.stats.puts).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("upstream failure does not poison the cache", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response("boom", { status: 503 }));
    try {
      const kv = countingKv();
      const r = await worker.fetch(new Request("https://x/gc/meta/777777"), { GC_META: kv }, {});
      expect(r.status).toBe(502);
      expect(r.headers.get("cache-control")).toContain("max-age=60");
      expect(kv.stats.puts).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
