import { describe, expect, test } from "bun:test";
import worker, {
  dlProductUrl,
  dmmDetailUrl,
  isValidDlDomain,
  isValidDlId,
  isValidDmmCid,
  parseDlStems,
  parseDmmMax,
  parseRoute,
} from "../src/index.js";

describe("dmm/dl parseRoute", () => {
  test("meta paths", () => {
    expect(parseRoute("/dm/meta/alice_0053")).toEqual({ kind: "dmm-meta", cid: "alice_0053" });
    expect(parseRoute("/dm/meta/d_054457")).toEqual({ kind: "dmm-meta", cid: "d_054457" });
    expect(parseRoute("/dl/meta/VJ011759")).toEqual({ kind: "dl-meta", rid: "VJ011759" });
  });

  test("bad ids are null", () => {
    expect(parseRoute("/dm/meta/..")).toBeNull();
    expect(parseRoute("/dm/meta/ab")).toBeNull();
    expect(parseRoute("/dm/meta/alice_0053/")).toBeNull();
    expect(parseRoute("/dl/meta/vj011759")).toBeNull();
    expect(parseRoute("/dl/meta/VJ011759.jpg")).toBeNull();
  });
});

describe("dmm/dl validation", () => {
  test("dmm cid charset and length", () => {
    expect(isValidDmmCid("alice_0053")).toBe(true);
    expect(isValidDmmCid("505apc13729")).toBe(true);
    expect(isValidDmmCid("ab")).toBe(false);
    expect(isValidDmmCid("a/b")).toBe(false);
    expect(isValidDmmCid("")).toBe(false);
  });

  test("dlsite id and domain allowlist", () => {
    expect(isValidDlId("VJ011759")).toBe(true);
    expect(isValidDlId("RJ136119")).toBe(true);
    expect(isValidDlId("vj011759")).toBe(false);
    expect(isValidDlDomain("pro")).toBe(true);
    expect(isValidDlDomain("maniax")).toBe(true);
    expect(isValidDlDomain("evil.com")).toBe(false);
  });
});

describe("detail URL builders stay on dmm/dlsite hosts", () => {
  test("floor routing", () => {
    expect(dmmDetailUrl("alice_0053")).toBe("https://dlsoft.dmm.co.jp/detail/alice_0053/");
    expect(dmmDetailUrl("d_054457")).toBe("https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_054457/");
    expect(dlProductUrl("VJ011759", "pro")).toBe(
      "https://www.dlsite.com/pro/work/=/product_id/VJ011759.html"
    );
  });
});

describe("parseDmmMax / parseDlStems", () => {
  test("largest jp/js index wins, thumbs do not confuse it", () => {
    const html = "alice_0018jp-001.jpg alice_0018js-001.jpg alice_0018jp-010.jpg";
    expect(parseDmmMax("alice_0018", html)).toBe(10);
  });

  test("stems keep letter groups in numeric order", () => {
    const html = "VJ011759_img_smpa2.jpg VJ011759_img_smpa10.jpg VJ011759_img_smpa1.jpg";
    expect(parseDlStems("VJ011759", html)).toEqual(["smpa1", "smpa2", "smpa10"]);
  });

  test("plain smp stems and empty pages", () => {
    expect(parseDlStems("RJ136119", "RJ136119_img_smp1.jpg RJ136119_img_smp3.jpg")).toEqual([
      "smp1",
      "smp3",
    ]);
    expect(parseDlStems("RJ136119", "nothing here")).toEqual([]);
    expect(parseDmmMax("alice_0018", "nothing here")).toBe(0);
  });
});

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

describe("meta handlers with stubbed upstream", () => {
  test("/dm/meta parses, caches, and serves from KV", async () => {
    const html = "qruppo_0004jp-001.jpg qruppo_0004jp-011.jpg";
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () =>
      Promise.resolve(new Response(html, { status: 200 }));
    try {
      const kv = memKv();
      const env = { GC_META: kv };
      const r1 = await worker.fetch(new Request("https://x/dm/meta/qruppo_0004"), env, {});
      expect(r1.status).toBe(200);
      expect(await r1.json()).toEqual({ n: 11 });
      expect(calls).toBe(0);
      expect(kv.dump().has("meta:dmm:qruppo_0004")).toBe(true);
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

  test("/dl/meta honors domain allowlist and returns stems", async () => {
    const html = "VJ011759_img_smpa1.jpg VJ011759_img_smpa2.jpg";
    const realFetch = globalThis.fetch;
    let seen = "";
    globalThis.fetch = (url) => {
      seen = String(url);
      return Promise.resolve(new Response(html, { status: 200 }));
    };
    try {
      const env = { GC_META: memKv() };
      const bad = await worker.fetch(
        new Request("https://x/dl/meta/VJ011759?domain=evil.com"),
        env,
        {}
      );
      expect(bad.status).toBe(400);
      const ok = await worker.fetch(
        new Request("https://x/dl/meta/VJ011759?domain=pro"),
        env,
        {}
      );
      expect(await ok.json()).toEqual({ samples: ["smpa1", "smpa2"], n: 2 });
      expect(seen).toContain("dlsite.com/pro/work");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("/gc/meta old cache format refreshes instead of breaking", async () => {
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
