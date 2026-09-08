// Frontend smoke test: loads the *built* document the way a browser does and
// drives every tab. This is the test that would have caught the FANZA-tab crash
// (applyFilter read `st` above its own declaration), which no unit test could
// see because the JS only existed inside a Python string.
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import fs from "fs";
import path from "path";

const DOC = path.join(import.meta.dir, "..", "public", "index.html");
const html = fs.readFileSync(DOC, "utf8");

// Pull the inline script out and keep the markup, so the app can be started
// with stubs already installed instead of racing the document's own fetches.
const scriptBody = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
const markupOnly = html.slice(0, html.indexOf("<script>")) + html.slice(html.lastIndexOf("</script>") + 9);

function loadGallery({ url = "http://localhost/" } = {}) {
  const window = new Window({ url, width: 1280, height: 800 });
  window.document.write(markupOnly);

  const calls = [];
  window.fetch = (u, opts) => {
    calls.push({ url: String(u), method: (opts && opts.method) || "GET" });
    return Promise.resolve({ ok: false, status: 599, json: () => Promise.resolve(null) });
  };
  // The real observer fires on scroll; here it just records what it was given.
  const observed = [];
  window.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(el) { observed.push(el); }
    unobserve() {}
    disconnect() {}
  };
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) window.CSS.escape = (s) => String(s).replace(/[^\w-]/g, "\\$&");

  window.eval(scriptBody);
  return { window, doc: window.document, calls, observed };
}

const TABS = ["all", "vndb", "dlsite", "dmm", "getchu"];

describe("built document", () => {
  test("is a single self-contained file with no external requests", () => {
    // Everything must be inline: the artifact has to work from file:// too.
    expect(html).not.toMatch(/<link[^>]+href=["'](?!data:)/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).toContain("const STORE");
  });

  test("inlined payload cannot break out of the script tag", () => {
    expect(scriptBody).not.toMatch(/<\/script/i);
  });
});

describe("app boot", () => {
  test("runs without throwing and renders the first page", () => {
    const { doc, window } = loadGallery();
    expect(window.GALLERY).toBeDefined();
    expect(doc.querySelectorAll("#grid .card").length).toBe(36);
    expect(doc.getElementById("stats").textContent).toContain("当前Tab：all");
  });

  test("every shipped tab renders with 只看有图 enabled", () => {
    // Regression guard: the old code threw ReferenceError here on the FANZA tab.
    for (const tab of TABS) {
      const { doc, window } = loadGallery();
      const box = doc.getElementById("onlyMatched");
      box.checked = true;
      let err = null;
      try {
        window.GALLERY.setTab(tab);
      } catch (e) {
        err = e;
      }
      expect(err, `setTab("${tab}") with onlyMatched threw: ${err && err.message}`).toBeNull();
      expect(doc.getElementById("stats").textContent).toContain(`当前Tab：${tab}`);
    }
  });

  test("只看有图 keeps exactly the products the adapter claims to match", () => {
    for (const tab of TABS) {
      const { doc, window } = loadGallery();
      doc.getElementById("onlyMatched").checked = true;
      window.GALLERY.setTab(tab);
      const a = window.GALLERY.ADAPTERS[tab];

      const shownGids = [...doc.querySelectorAll("#grid .card")].map((c) => c.dataset.gid);
      expect(shownGids.length, `${tab}: matched filter emptied the grid`).toBeGreaterThan(0);

      // Rendered cards must all satisfy the predicate.
      for (const gid of shownGids) {
        const item = window.GALLERY.DATA.find((d) => String(d.gid) === gid);
        expect(item, `${tab}: rendered card ${gid} is not in DATA`).toBeTruthy();
        const st = window.GALLERY.storeOf(gid);
        const v = window.GALLERY.liveCache.get(gid) || null;
        expect(a.has(item, st, v), `${tab}: card ${gid} rendered but has() is false`).toBe(true);
      }

      // And the total count must equal a full pass over DATA, not just page 1.
      const G = window.GALLERY;
      const expected = G.DATA.filter((d) => G.ADAPTERS[tab].has(d, G.storeOf(d.gid), G.liveCache.get(d.gid) || null)).length;
      const total = +doc.getElementById("stats").textContent.match(/共 (\d+)/)[1];
      expect(total, `${tab}: filtered count disagrees with adapter.has()`).toBe(expected);
    }
  });

  test("covers file:// mode where the Worker proxy is unavailable", () => {
    const { window, calls } = loadGallery({ url: "file:///index.html" });
    expect(window.eval("USE_GC")).toBe(false);
    // No same-origin /gc|/dm|/dl traffic should be attempted without a Worker.
    expect(calls.filter((c) => /^\/(gc|dm|dl)\//.test(c.url))).toHaveLength(0);
  });
});

describe("detail modal", () => {
  test("opens for the first matched product of every tab", () => {
    for (const tab of TABS) {
      const { doc, window } = loadGallery();
      window.GALLERY.setTab(tab);
      const gid = openableGid(window, doc, tab);
      let err = null;
      try {
        window.GALLERY.openDetail(gid);
      } catch (e) {
        err = e;
      }
      expect(err, `openDetail on ${tab} threw: ${err && err.message}`).toBeNull();
      expect(doc.getElementById("modal").classList.contains("open"), `${tab}: modal did not open`).toBe(true);
      expect(doc.querySelectorAll("#mbody img").length, `${tab}: modal has no images`).toBeGreaterThan(0);
      expect(doc.getElementById("mbody").textContent).toContain("全CG");
    }
  });

  test("more button is observed for infinite scroll", () => {
    const { observed } = loadGallery();
    expect(observed.some((el) => el.id === "more"), "#more was never observed").toBe(true);
  });

  test("detail modal shows related recommendations without self", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    // A cached product that actually has same-brand/series siblings, so the
    // modal opens synchronously (no live VNDB lookup) and the rows render.
    const item = G.DATA.find((d) =>
      G.liveCache.get(d.gid) && G.relatedOf(d, G.liveCache.get(d.gid)).length > 0);
    expect(item, "no cached product has any related siblings").toBeTruthy();
    window.GALLERY.setTab("all");
    window.GALLERY.openDetail(String(item.gid));
    expect(doc.getElementById("mbody").textContent).toContain("相关推荐");
    const cards = [...doc.querySelectorAll("#mbody .relcard")];
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThanOrEqual(6);
    cards.forEach((c) => {
      expect(c.dataset.gid, "recommendation card has no gid").toBeTruthy();
      expect(c.dataset.gid, "recommendation links to itself").not.toBe(String(item.gid));
      expect(c.querySelector("img") || c.querySelector(".relnocover"), "card has neither cover nor placeholder").toBeTruthy();
      expect(c.textContent).toContain("中央值");
    });
  });

  test("each store section keeps its own image grid", () => {
    const { doc, window } = loadGallery();
    const gid = richGid(window);
    expect(gid, "no cached product has all three stores").toBeTruthy();
    window.GALLERY.setTab("all");
    window.GALLERY.openDetail(gid);
    const grids = [...doc.querySelectorAll("#mbody .sgrid")];
    expect(grids.length).toBeGreaterThanOrEqual(2);
    expect(doc.querySelectorAll("#mbody img").length).toBeGreaterThan(5);
    // Store links must point at their own hosts, never at each other.
    const hrefs = [...doc.querySelectorAll("#mbody a")].map((a) => a.href);
    expect(hrefs.some((h) => h.includes("dlsite.com"))).toBe(true);
    expect(hrefs.some((h) => h.includes("dmm.co.jp"))).toBe(true);
    expect(hrefs.some((h) => h.includes("getchu.com"))).toBe(true);
  });
});

describe("live meta discipline", () => {
  test("one modal open asks the Worker at most once per store product", () => {
    const { window, calls } = loadGallery();
    const gid = richGid(window);
    window.GALLERY.setTab("all");
    window.GALLERY.openDetail(gid);
    const metaCalls = () => calls.filter((c) => /^\/(gc|dm|dl)\/meta\//.test(c.url));
    const first = metaCalls().length;
    // Re-open several times: nothing new should be requested.
    for (let i = 0; i < 4; i++) window.GALLERY.openDetail(gid);
    expect(metaCalls().length, "repeat modal opens re-asked for meta").toBe(first);
  });

  test("products whose baked Getchu count is already known never hit /gc/meta", () => {
    const { window, calls } = loadGallery();
    const gid = Object.keys(window.GALLERY.STORE).find(
      (k) => window.GALLERY.STORE[k].g && typeof window.GALLERY.STORE[k].g.n === "number" && window.GALLERY.STORE[k].g.n > 0
    );
    expect(gid).toBeTruthy();
    window.GALLERY.setTab("getchu");
    window.GALLERY.openDetail(gid);
    expect(calls.some((c) => /^\/gc\/meta\//.test(c.url))).toBe(false);
  });
});

describe("localStorage cache safety", () => {
  test("an oversized live cache evicts instead of writing truncated JSON", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    // Fill well past the budget with distinct entries.
    for (let i = 0; i < 4000; i++) {
      G.liveCache.set(String(900000 + i), {
        id: "v" + i,
        title: "x".repeat(300),
        shots: ["u".repeat(60)],
      });
    }
    G.saveLive();
    const raw = window.localStorage.getItem(G.LIVE_KEY);
    expect(raw, "nothing was persisted").toBeTruthy();
    let parsed = null;
    let err = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      err = e;
    }
    // The old code sliced the JSON string at 900000 chars, guaranteeing this
    // threw on the next load and destroying the entire cache.
    expect(err, `persisted value is not parseable (${raw.length} chars)`).toBeNull();
    expect(raw.length).toBeLessThanOrEqual(G.LIVE_BUDGET);
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
    // Eviction keeps the newest work, not the oldest.
    const kept = Object.keys(parsed);
    expect(kept[kept.length - 1]).toBe("903999");
    expect(doc.querySelectorAll("#grid .card").length).toBeGreaterThan(0);
  });

  test("a corrupt stored cache is discarded rather than crashing the page", () => {
    const window = new Window({ url: "http://localhost/" });
    window.localStorage.setItem("vndb_live_v4", '{"1":{"id":"v1"');  // truncated on purpose
    window.document.write(markupOnly);
    window.fetch = () => Promise.resolve({ ok: false, status: 599, json: () => Promise.resolve(null) });
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    let err = null;
    try {
      window.eval(scriptBody);
    } catch (e) {
      err = e;
    }
    expect(err).toBeNull();
    expect(window.localStorage.getItem("vndb_live_v4")).toBeNull();
  });
});

function storeOf(window, gid) {
  return window.GALLERY.storeOf(gid);
}

// A product present in the baked CACHE. Without one, openDetail on the
// vndb/all tabs legitimately defers while VNDB is looked up, and a synchronous
// test cannot observe the modal.
function cachedGid(window, predicate) {
  const S = window.GALLERY.STORE;
  return Object.keys(window.GALLERY.CACHE).find(
    (k) => window.GALLERY.CACHE[k] && (!predicate || predicate(S[k] || {}))
  );
}

// A product with DLsite + FANZA + Getchu ids, so the modal renders every section.
function richGid(window) {
  return cachedGid(window, (st) => st.l && (st.m || st.m2) && st.g);
}

// First rendered card that opens synchronously *and* has content for the tab:
// the adapter must claim it, and on vndb/all a VNDB match must already exist
// (otherwise openDetail legitimately defers while it is looked up).
function openableGid(window, doc, tab) {
  const G = window.GALLERY;
  const a = G.ADAPTERS[tab];
  // The Getchu section only renders baked Worker images synchronously;
  // products with an unknown count start as an empty grid until live meta
  // arrives (which the stubbed fetch never provides), so pick a baked one.
  if (tab === "getchu") {
    const hit = G.DATA.find((d) => {
      const st = G.storeOf(d.gid);
      return st && st.g && typeof st.g.n === "number" && st.g.n > 0;
    });
    if (hit) return String(hit.gid);
  }
  const cards = [...doc.querySelectorAll("#grid .card")];
  for (const c of cards) {
    const gid = c.dataset.gid;
    const v = G.liveCache.get(gid);
    const item = G.DATA.find((d) => String(d.gid) === gid);
    if (!item || !a.has(item, G.storeOf(gid), v || null)) continue;
    if ((tab === "vndb" || tab === "all") && !v) continue;
    return gid;
  }
  return cards[0].dataset.gid;
}
