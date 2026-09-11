// Frontend smoke test: loads the *built* document the way a browser does and
// drives every view, the filter controls, the detail drawer and the lightbox.
// This is the test that would have caught the FANZA-tab crash (applyFilter
// read `st` above its own declaration), which no unit test could see because
// the JS only existed inside a Python string.
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
  // The real observers fire on scroll; here they just record what they were given.
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

const VIEWS = ["all", "vndb", "dlsite", "dmm", "getchu"];

describe("built document", () => {
  test("is a single self-contained file with no external requests", () => {
    // Everything must be inline: the artifact has to work from file:// too.
    expect(html).not.toMatch(/<link[^>]+href=["'](?!data:)/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    for (const name of ["DATA", "STORE", "CACHE", "TAGS"]) {
      expect(html).toContain(`const ${name}`);
    }
  });

  test("inlined payload cannot break out of the script tag", () => {
    expect(scriptBody).not.toMatch(/<\/script/i);
  });
});

describe("app boot", () => {
  test("runs without throwing, renders the first page and asks for nothing", () => {
    const { doc, window, calls } = loadGallery();
    expect(window.GALLERY).toBeDefined();
    expect(doc.querySelectorAll("#grid .cardwrap").length, "first page must render PAGE cards").toBe(36);
    const stats = doc.getElementById("stats");
    expect(stats.textContent.trim().length, "stats line is empty").toBeGreaterThan(0);
    expect(stats.innerHTML, "stats line lost its 共 N / M lead").toMatch(/^共 <b>\d+<\/b> \/ \d+ 个（EROGE限定）/);
    expect(stats.textContent).toContain("视图：综合");
    expect(stats.textContent).toContain("已显示 36 个");
    expect(calls, "boot must not touch the network").toHaveLength(0);
  });

  test("every view renders with 只看有图 enabled and mirrors itself in the shell", () => {
    // Regression guard: the old code threw ReferenceError here on the FANZA tab.
    for (const view of VIEWS) {
      const { doc, window } = loadGallery();
      const G = window.GALLERY;
      doc.getElementById("onlyMatched").checked = true;
      let err = null;
      try {
        G.setTab(view);
      } catch (e) {
        err = e;
      }
      expect(err, `setTab("${view}") with 只看有图 threw: ${err && err.message}`).toBeNull();
      expect(G.getTab()).toBe(view);
      const active = doc.querySelector("#views .vtab.on");
      expect(active && active.dataset.view, `view ${view}: no active vtab`).toBe(view);
      expect(doc.getElementById("grid").dataset.view, `view ${view}: grid did not follow`).toBe(view);
      expect(doc.getElementById("onlyMatchedLabel").textContent,
        `view ${view}: matched label did not follow`).toBe(G.ADAPTERS[view].matchedLabel);
      expect(doc.getElementById("stats").textContent).toContain(`视图：${G.ADAPTERS[view].navLabel}`);
    }
  });

  test("只看有图 keeps exactly the products the adapter claims to match", () => {
    for (const view of VIEWS) {
      const { doc, window } = loadGallery();
      const G = window.GALLERY;
      doc.getElementById("onlyMatched").checked = true;
      G.setTab(view);
      const a = G.ADAPTERS[view];

      const shownGids = [...doc.querySelectorAll("#grid .cardwrap")].map((c) => c.dataset.gid);
      expect(shownGids.length, `${view}: matched filter emptied the grid`).toBeGreaterThan(0);

      // Rendered cards must all satisfy the predicate.
      for (const gid of shownGids) {
        const item = G.DATA.find((d) => String(d.gid) === gid);
        expect(item, `${view}: rendered card ${gid} is not in DATA`).toBeTruthy();
        expect(a.has(item, G.storeOf(gid), G.liveCache.get(gid) || null),
          `${view}: card ${gid} rendered but has() is false`).toBe(true);
      }

      // And the total count must equal a full pass over DATA, not just page 1.
      const expected = G.DATA.filter((d) => a.has(d, G.storeOf(d.gid), G.liveCache.get(d.gid) || null)).length;
      const total = +doc.getElementById("stats").textContent.match(/共 (\d+)/)[1];
      expect(total, `${view}: filtered count disagrees with adapter.has()`).toBe(expected);
    }
  });

  test("covers file:// mode where the Worker proxy is unavailable", () => {
    const { window, calls } = loadGallery({ url: "file:///index.html" });
    expect(window.eval("USE_GC")).toBe(false);
    // No same-origin /gc|/dm|/dl traffic should be attempted without a Worker.
    expect(calls.filter((c) => /^\/(gc|dm|dl)\//.test(c.url))).toHaveLength(0);
  });
});

describe("cards", () => {
  test("wrap an article with cover, store dots and the identity line", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    const wrap = doc.querySelector("#grid .cardwrap");
    expect(wrap, "no cardwrap rendered").toBeTruthy();
    expect(wrap.dataset.gid, "wrapper has no gid").toBeTruthy();
    const card = wrap.querySelector("article.card");
    expect(card, "cardwrap must wrap an article.card").toBeTruthy();
    expect(card.dataset.gid, "card must carry the same gid as its wrapper").toBe(wrap.dataset.gid);
    const item = G.DATA.find((d) => String(d.gid) === wrap.dataset.gid);
    expect(item, "first card is not in DATA").toBeTruthy();

    const cover = card.querySelector(".cover");
    expect(cover.querySelector("img[data-full]"), "cover img lost its full url").toBeTruthy();
    expect(cover.querySelector(".scrim"), "cover scrim missing").toBeTruthy();
    expect(cover.querySelector(".rank").textContent, "rank badge").toBe("#" + item.rank);
    expect(cover.querySelector(".medpill")?.textContent || "", "median pill")
      .toBe(item.median ? String(item.median) : "");
    const dots = [...cover.querySelectorAll(".storedots .sdot")];
    const st = G.storeOf(item.gid);
    const avail = {
      D: !!G.dlEntry(st),
      F: G.dmmEntries(st).length > 0,
      G: !!G.gcEntry(st),
      V: !!G.liveCache.get(item.gid),
    };
    expect(dots.map((d) => d.textContent), "store dots must read D/F/G/V").toEqual(["D", "F", "G", "V"]);
    for (const dot of dots) {
      expect(dot.classList.contains("on"), `store dot ${dot.textContent} availability is wrong`)
        .toBe(avail[dot.textContent]);
    }

    expect(card.querySelector(".ctitle").textContent, "card title").toBe(item.name);
    const line = card.querySelector(".cline").textContent;
    for (const part of ["中央值", "评分", "POV"]) {
      expect(line, `card identity line misses ${part}`).toContain(part);
    }
    if (G.tagsOf(item.gid).length) {
      expect(card.querySelector(".cardtag"), "tagged card lost its .cardtag").toBeTruthy();
    }
    const hrefs = [...card.querySelectorAll(".cacts a")].map((a) => a.href);
    expect(hrefs.length, "card actions need a store link plus EGS").toBeGreaterThanOrEqual(2);
    expect(hrefs.some((h) => h.includes("erogamescape")), "EGS link missing from .cacts").toBe(true);
  });

  test("cover click opens the drawer; store links and the fetch button do not", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    const cards = [...doc.querySelectorAll("#grid article.card")];
    // A cached match opens synchronously; an uncached one defers to the
    // (stub-failed) VNDB lookup, so the positive case must use a cached card.
    const cached = cards.find((c) => G.liveCache.get(c.dataset.gid));
    expect(cached, "no rendered card has a cached VNDB match").toBeTruthy();
    cached.querySelector(".cover").click();
    expect(doc.getElementById("drawer").classList.contains("open"), "cover click did not open the drawer").toBe(true);
    doc.getElementById("dclose").click();

    // Activating a store link must stay on the grid.
    const link = cached.querySelector(".cacts a");
    link.addEventListener("click", (e) => e.preventDefault()); // keep happy-dom from navigating
    link.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(doc.getElementById("drawer").classList.contains("open"), "store link opened the drawer").toBe(false);

    // The manual 匹配VNDB button queues a lookup, it never opens the drawer.
    // Page 1 is fully covered by the baked top-60 CACHE, so walk forward until
    // an uncached card (and with it the button) exists.
    for (let page = 0; page < 4 && !cards.find((c) => c.querySelector('[data-act="fetch"]')); page++) {
      doc.getElementById("more").click();
    }
    const uncached = [...doc.querySelectorAll("#grid article.card")].find((c) => c.querySelector('[data-act="fetch"]'));
    expect(uncached, "no card offers 匹配VNDB on the all view").toBeTruthy();
    uncached.querySelector('[data-act="fetch"]').click();
    expect(doc.getElementById("drawer").classList.contains("open"), "fetch button opened the drawer").toBe(false);
  });

  test("cards provide fallback chain including full VNDB and store covers for degenerate items (YU-NO, etc.)", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;

    // YU-NO (gid 2093, rank 5) is on page 1
    const yunoCard = doc.querySelector('#grid article.card[data-gid="2093"]');
    expect(yunoCard, "YU-NO card must be rendered in first page").toBeTruthy();
    const yunoImg = yunoCard.querySelector(".cover img");
    expect(yunoImg, "YU-NO cover img must exist").toBeTruthy();
    const yunoFb = yunoImg.getAttribute("data-fb") || "";
    expect(yunoFb).toContain("https://t.vndb.org/cv/29/59029.jpg");

    // Simulating chainImgErr on error recovers to the full cover without failing
    window.chainImgErr(yunoImg);
    expect(yunoImg.getAttribute("src")).toBe("https://t.vndb.org/cv/29/59029.jpg");
    expect(yunoImg.classList.contains("img-load-failed")).toBe(false);

    // クロスブリードジョーカー (gid 28137, rank 45) -> click more to paginate
    doc.getElementById("more").click();
    const cbCard = doc.querySelector('#grid article.card[data-gid="28137"]');
    expect(cbCard, "クロスブリードジョーカー card must exist").toBeTruthy();
    const cbImg = cbCard.querySelector(".cover img");
    // Priority 1 is FANZA
    expect(cbImg.getAttribute("src")).toContain("d_141361");
    const cbFb = cbImg.getAttribute("data-fb") || "";
    // DLsite and VNDB are in fallback chain
    expect(cbFb).toContain("RJ241070");
    expect(cbFb).toContain("https://t.vndb.org/cv/90/39590.jpg");
    window.chainImgErr(cbImg);
    expect(cbImg.getAttribute("src")).toContain("RJ241070");
    expect(cbImg.classList.contains("img-load-failed")).toBe(false);
  });

  test("scrub-strip errors do not corrupt cover fallback chain or mark cover as failed", () => {
    const { doc, window } = loadGallery();
    const card = [...doc.querySelectorAll("#grid article.card")].find((c) => c.querySelector(".scrub-segment"));
    expect(card, "card with scrub strip must exist").toBeTruthy();
    const coverEl = card.querySelector(".cover");
    const img = coverEl.querySelector("img");
    const origSrc = img.getAttribute("src");
    const origFb = img.getAttribute("data-fb");

    // Hover first scrub segment
    const seg = coverEl.querySelector(".scrub-segment");
    seg.dispatchEvent(new window.Event("mouseenter"));
    expect(img.dataset.scrubbing).toBe("true");

    // Simulate error during scrubbing
    window.chainImgErr(img);
    expect(img.classList.contains("img-load-failed"), "scrub error marked cover as failed").toBe(false);
    expect(img.getAttribute("data-fb"), "scrub error consumed fallback chain").toBe(origFb);

    // Mouse leaves scrub strip
    coverEl.querySelector(".scrub-strip").dispatchEvent(new window.Event("mouseleave"));
    expect(img.dataset.scrubbing).toBe("false");
    expect(img.getAttribute("src"), "cover was not restored after scrubbing").toBe(origSrc);
  });
});

describe("sort", () => {
  test("median puts the top median first without changing the count", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    const sel = doc.getElementById("sort");
    const before = +doc.getElementById("stats").textContent.match(/共 (\d+)/)[1];
    sel.value = "median";
    sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    const firstGid = doc.querySelector("#grid .cardwrap").dataset.gid;
    const first = G.DATA.find((d) => String(d.gid) === firstGid);
    const maxMedian = Math.max(...G.DATA.map((d) => d.median || 0));
    expect(first.median, "median sort did not put the top median first").toBe(maxMedian);
    const after = +doc.getElementById("stats").textContent.match(/共 (\d+)/)[1];
    expect(after, "sorting must not change the filtered count").toBe(before);
    sel.value = "rank";
    sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(doc.querySelector("#grid .cardwrap").dataset.gid, "rank order was lost").toBe(String(G.DATA[0].gid));
    expect(G.DATA[0].rank, "DATA[0] must be rank 1").toBe(1);
  });
});

describe("density", () => {
  test("the button cycles the three labels and toggles the grid classes", () => {
    const { doc } = loadGallery();
    const grid = doc.getElementById("grid");
    const btn = doc.getElementById("density");
    expect(btn.textContent).toBe("密度：自动");
    expect(grid.classList.contains("density-compact")).toBe(false);
    expect(grid.classList.contains("density-large")).toBe(false);
    btn.click();
    expect(btn.textContent, "first density step").toBe("密度：紧凑");
    expect(grid.classList.contains("density-compact"), "compact class missing").toBe(true);
    btn.click();
    expect(btn.textContent, "second density step").toBe("密度：大图");
    expect(grid.classList.contains("density-large"), "large class missing").toBe(true);
    expect(grid.classList.contains("density-compact")).toBe(false);
    btn.click();
    expect(btn.textContent, "density cycle must wrap").toBe("密度：自动");
    expect(grid.classList.contains("density-large")).toBe(false);
  });
});

describe("load more", () => {
  test("#more is observed, paginates on click and hides when exhausted", () => {
    const { doc, window, observed } = loadGallery();
    const G = window.GALLERY;
    expect(doc.querySelector(".loadzone #more"), "#more must live inside .loadzone").toBeTruthy();
    expect(observed.some((el) => el.id === "more"), "#more was never observed").toBe(true);
    expect(doc.querySelectorAll("#grid .cardwrap").length).toBe(36);
    doc.getElementById("more").click();
    expect(doc.querySelectorAll("#grid .cardwrap").length, "#more click did not render the next page").toBe(72);
    expect(doc.getElementById("more").style.display).toBe("inline-block");
    // A tag with fewer members than a page exhausts the list: hide the button.
    const tag = Object.keys(G.TAGS).find((t) => G.TAGS[t].length <= 36);
    expect(tag, "no shipped tag smaller than a page").toBeTruthy();
    chipFor(doc, tag).click();
    expect(doc.querySelectorAll("#grid .cardwrap").length, "tag filter did not re-render the grid")
      .toBe(G.TAGS[tag].length);
    expect(doc.getElementById("more").style.display, "exhausted #more stayed visible").toBe("none");
  });
});

describe("tag filter", () => {
  // toggleTag() re-renders #tagchips on every toggle/reset, so a chip node
  // captured earlier is stale; always look it up fresh.
  test("tagrow renders one chip per shipped tag with the dataset count", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    const chips = [...doc.querySelectorAll("#tagchips .tagchip")];
    expect(chips.length, "chip count must match the TAGS payload").toBe(Object.keys(G.TAGS).length);
    expect(doc.getElementById("tagrow").hidden, "#tagrow stayed hidden with tags present").toBe(false);
    for (const chip of chips) {
      expect(chip.querySelector(".tagcount").textContent,
        `chip "${chip.dataset.tag}" shows the wrong count`)
        .toBe(String(G.TAGS[chip.dataset.tag].length));
    }
  });

  test("寝取り is the dataset itself and never becomes a chip", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    expect("寝取り" in G.TAGS, "寝取り must stay excluded from TAGS").toBe(false);
    expect([...doc.querySelectorAll("#tagchips .tagchip")].some((c) => c.dataset.tag === "寝取り"),
      "寝取り must not render as a chip").toBe(false);
  });

  test("selecting a chip via real click ANDs the grid down to tag members", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    const tag = Object.keys(G.TAGS)[0];
    const chip = chipFor(doc, tag);
    expect(chip, `no chip rendered for "${tag}"`).toBeTruthy();
    chip.click();
    expect(chipFor(doc, tag).classList.contains("on"), "clicked chip is not marked on").toBe(true);
    const total = +doc.getElementById("stats").textContent.match(/共 (\d+)/)[1];
    expect(total, "stats count disagrees with TAGS[tag].length").toBe(G.TAGS[tag].length);
    const shownGids = [...doc.querySelectorAll("#grid .cardwrap")].map((c) => c.dataset.gid);
    expect(shownGids.length, "AND filter emptied the grid").toBeGreaterThan(0);
    for (const gid of shownGids) {
      expect(G.TAGS[tag].includes(gid), `rendered card ${gid} does not carry tag "${tag}"`).toBe(true);
    }
    const stored = JSON.parse(window.localStorage.getItem("ui_v1"));
    expect(stored.tags, "selection was not persisted in ui_v1.tags").toContain(tag);
  });

  test("medchips combine with the tag filter", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    const tag = Object.keys(G.TAGS)[0];
    chipFor(doc, tag).click();
    const chip80 = doc.querySelector('#medchips .fchip[data-med="80"]');
    chip80.click();
    expect(chip80.classList.contains("on"), "clicked medchip is not marked on").toBe(true);
    const expected = G.DATA.filter((d) => G.TAGS[tag].includes(String(d.gid)) && (d.median || 0) >= 80).length;
    const total = +doc.getElementById("stats").textContent.match(/共 (\d+)/)[1];
    expect(total, "AND+median count disagrees with a full pass over DATA").toBe(expected);
    doc.querySelector('#medchips .fchip[data-med="0"]').click();
    const total2 = +doc.getElementById("stats").textContent.match(/共 (\d+)/)[1];
    expect(total2, "clearing the medchip lost tag members").toBe(G.TAGS[tag].length);
    expect(doc.querySelector('#medchips .fchip[data-med="0"]').classList.contains("on"),
      "the 0 medchip did not regain .on").toBe(true);
  });

  test("two chips AND to the intersection of their tag arrays", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    const keys = Object.keys(G.TAGS);
    expect(keys.length, "need two shipped tags to AND").toBeGreaterThanOrEqual(2);
    const [a, b] = keys;
    chipFor(doc, a).click();
    chipFor(doc, b).click();
    const inter = G.TAGS[a].filter((gid) => G.TAGS[b].includes(gid));
    const total = +doc.getElementById("stats").textContent.match(/共 (\d+)/)[1];
    expect(total, "two selected chips must AND, not OR").toBe(inter.length);
    expect(chipFor(doc, a).classList.contains("on") && chipFor(doc, b).classList.contains("on"),
      "both chips must be on").toBe(true);
    expect(doc.getElementById("stats").textContent).toContain(`标签AND：${a}+${b}`);
  });

  test("reset clears everything", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    const tag = Object.keys(G.TAGS)[0];
    chipFor(doc, tag).click();
    doc.getElementById("reset").click();
    expect(G.getTagSel(), "reset left a selection behind").toEqual([]);
    const total = +doc.getElementById("stats").textContent.match(/共 (\d+)/)[1];
    expect(total, "reset did not restore the full dataset").toBe(G.DATA.length);
    expect(chipFor(doc, tag).classList.contains("on"), "chip is still on after reset").toBe(false);
    expect(JSON.parse(window.localStorage.getItem("ui_v1")).tags,
      "reset did not persist an empty selection").toEqual([]);
  });

  test("a stored ui_v1 selection survives reload", () => {
    // Same pattern as the weak-migration regression: seed storage before the
    // document exists, then boot. "親子丼" is the shipped tag pinned by the
    // build test; TAGS itself is only readable after boot.
    const tag = "親子丼";
    const window = new Window({ url: "http://localhost/" });
    window.localStorage.setItem("ui_v1", JSON.stringify({ tags: [tag] }));
    window.document.write(markupOnly);
    window.fetch = () => Promise.resolve({ ok: false, status: 599, json: () => Promise.resolve(null) });
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.eval(scriptBody);
    const G = window.GALLERY;
    expect(G.getTagSel(), "stored selection did not survive the reload").toEqual([tag]);
    expect(chipFor(window.document, tag).classList.contains("on"), "restored chip is not on").toBe(true);
    expect(window.document.getElementById("stats").textContent, "stats missed the AND note").toContain("标签AND：");
  });

  test("unknown tags in a stored selection are dropped", () => {
    // v1 dropped unknown names on load rather than emptying the whole grid:
    // a tag renamed by a data rebuild must not brick the filter.
    const tag = "親子丼";
    const window = new Window({ url: "http://localhost/" });
    window.localStorage.setItem("ui_v1", JSON.stringify({ tags: [tag, "已消失的标签"] }));
    window.document.write(markupOnly);
    window.fetch = () => Promise.resolve({ ok: false, status: 599, json: () => Promise.resolve(null) });
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.eval(scriptBody);
    expect(window.GALLERY.getTagSel(), "unknown stored tag was not dropped").toEqual([tag]);
  });

  test("a corrupted ui_v1 is discarded, not fatal", () => {
    const window = new Window({ url: "http://localhost/" });
    window.localStorage.setItem("ui_v1", "{bad json");  // truncated on purpose
    window.document.write(markupOnly);
    window.fetch = () => Promise.resolve({ ok: false, status: 599, json: () => Promise.resolve(null) });
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    let err = null;
    try {
      window.eval(scriptBody);
    } catch (e) {
      err = e;
    }
    expect(err, `boot threw on a corrupt ui_v1: ${err && err.message}`).toBeNull();
    expect(window.GALLERY.getTagSel(), "corrupt selection survived as junk").toEqual([]);
  });
});

describe("detail drawer", () => {
  test("opens synchronously for a suitable product of every view", () => {
    for (const view of VIEWS) {
      const { doc, window } = loadGallery();
      const G = window.GALLERY;
      G.setTab(view);
      const gid = openableGid(window, doc, view);
      expect(gid, `${view}: no product to open synchronously`).toBeTruthy();
      let err = null;
      try {
        G.openDetail(gid);
      } catch (e) {
        err = e;
      }
      expect(err, `openDetail on ${view} threw: ${err && err.message}`).toBeNull();
      const drawer = doc.getElementById("drawer");
      expect(drawer.classList.contains("open"), `${view}: drawer did not open`).toBe(true);
      expect(drawer.getAttribute("aria-hidden"), `${view}: aria-hidden did not follow`).toBe("false");
      expect(doc.body.classList.contains("locked"), `${view}: body was not locked`).toBe(true);
      expect(doc.querySelectorAll("#dbody img").length, `${view}: drawer has no images`).toBeGreaterThan(0);
      expect(doc.getElementById("dbody").textContent).toContain("全CG");
      expect(doc.getElementById("dbody").textContent).toContain("Hitomi");
      expect(doc.getElementById("dbody").textContent).toContain("E-Hentai");
      const fullcgLinks = Array.from(doc.querySelectorAll(".dsec-fullcg a")).map((a) => a.getAttribute("href") || "");
      expect(fullcgLinks.some((h) => h.includes("hitomi.la/search.html"))).toBe(true);
      expect(fullcgLinks.some((h) => h.includes("e-hentai.org/?f_search="))).toBe(true);
      expect(fullcgLinks.some((h) => h.includes("%20CG") || h.includes("+CG"))).toBe(false);
    }
  });

  test("dhead carries rank/name, the identity line, 注册标签 and the VNDB match", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    G.setTab("all");
    const item = G.DATA.find((d) => {
      const v = G.liveCache.get(d.gid);
      return v && (v.img || (v.shots || []).length) && G.tagsOf(d.gid).length > 0;
    });
    expect(item, "no cached+tagged product to check the header with").toBeTruthy();
    G.openDetail(String(item.gid));
    const head = doc.getElementById("dhead");
    expect(head.querySelector("h2").textContent).toContain(`#${item.rank} ${item.name}`);
    const hint = head.querySelector(".hint").textContent;
    for (const part of [item.brand, item.sellday, "中央值", "评分", "POV"]) {
      expect(hint, `dhead hint misses ${part}`).toContain(part);
    }
    const itemTags = G.tagsOf(item.gid);
    expect(hint, "dhead missed the 注册标签 line").toContain("注册标签");
    expect(hint, "dhead missed the tag names").toContain(itemTags[0]);
    expect(hint, "dhead missed the VNDB match line").toContain("VNDB: ");
  });

  test("the rich drawer keeps per-store strips and store links on their hosts", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    const gid = richGid(window);
    expect(gid, "no cached product has all three stores").toBeTruthy();
    G.setTab("all");
    G.openDetail(gid);
    const strips = [...doc.querySelectorAll("#dbody .strip")];
    expect(strips.length, "sections lost their own strips").toBeGreaterThanOrEqual(3);
    expect(doc.querySelectorAll("#dbody img").length).toBeGreaterThan(5);
    // Section headings carry the grow-contract ids; sample counts are live.
    expect(doc.querySelector('#dbody h3[id^="dsec-h-"]'), "section headings lost their ids").toBeTruthy();
    expect(doc.querySelector("#dbody [data-livecount]"), "no live sample counter").toBeTruthy();
    // Store links must point at their own hosts, never at each other.
    const hrefs = [...doc.querySelectorAll("#dbody a")].map((a) => a.href);
    expect(hrefs.some((h) => h.includes("dlsite.com"))).toBe(true);
    expect(hrefs.some((h) => h.includes("dmm.co.jp"))).toBe(true);
    expect(hrefs.some((h) => h.includes("getchu.com"))).toBe(true);
    // Getchu images when USE_GC is true must route through /gc/ proxy to bypass hotlink blocking
    const gcImgs = [...doc.querySelectorAll(".dsec-gc img")].map((img) => img.getAttribute("src") || "");
    expect(gcImgs.length).toBeGreaterThan(0);
    expect(gcImgs.some((s) => s.startsWith("/gc/"))).toBe(true);
    // DLsite images in strip must use lightweight 100x100 thumbnails for fast loading
    const dlImgs = [...doc.querySelectorAll(".dsec-dl img")];
    expect(dlImgs.length).toBeGreaterThan(0);
    expect(dlImgs.every((img) => (img.getAttribute("src") || "").includes("_100x100.jpg"))).toBe(true);
    expect(dlImgs.every((img) => (img.getAttribute("data-full") || "").endsWith(".webp"))).toBe(true);
    // vndb/all views close with a VNDB search and a re-query button.
    expect(doc.querySelector('#dbody [data-act="refetch"]'), "no 重查VNDB button").toBeTruthy();
    expect(doc.getElementById("dbody").textContent).toContain("VNDB搜索");
  });

  test("drawer store tabs switch active gallery section and support show all", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    const gid = richGid(window);
    G.setTab("all");
    G.openDetail(gid);
    const tabs = [...doc.querySelectorAll(".drawer-store-tabs .drawer-tab")];
    expect(tabs.length).toBeGreaterThanOrEqual(3);
    const activeTab = doc.querySelector(".drawer-store-tabs .drawer-tab.active");
    expect(activeTab).toBeTruthy();

    // Click a different store tab
    const targetTab = tabs.find((t) => t.dataset.storeTab && t.dataset.storeTab !== "all" && t !== activeTab);
    expect(targetTab).toBeTruthy();
    targetTab.click();
    expect(targetTab.classList.contains("active")).toBe(true);
    const targetStoreId = targetTab.dataset.storeTab;
    const targetSec = doc.querySelector(`.drawer-store-section[data-store="${targetStoreId}"]`);
    expect(targetSec.classList.contains("dsec-hidden")).toBe(false);

    // Click "all" tab
    const allTab = doc.querySelector('.drawer-store-tabs .drawer-tab[data-store-tab="all"]');
    expect(allTab).toBeTruthy();
    allTab.click();
    expect(allTab.classList.contains("active")).toBe(true);
    const hiddenSecs = doc.querySelectorAll(".drawer-store-section.dsec-hidden");
    expect(hiddenSecs.length).toBe(0);
  });

  test("媚肉の香り (gid 10035) renders FANZA screenshots with correct sample URLs", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    G.setTab("all");
    G.openDetail("10035");
    const dsec = doc.querySelector(".dsec-dmm");
    expect(dsec, "FANZA section must exist for 媚肉の香り").toBeTruthy();
    const imgs = [...dsec.querySelectorAll(".strip img")];
    expect(imgs.length, "FANZA screenshots must have 10 images").toBe(10);
    expect(imgs[4].getAttribute("src")).toContain("elf_0032/elf_0032js-005.jpg");
    expect(imgs[4].getAttribute("data-full")).toBe("https://pics.dmm.co.jp/digital/pcgame/elf_0032/elf_0032jp-005.jpg");
  });

  test("巨乳家族催眠 (gid 19189 / rank 508) matches DLsite VJ008382 with 9 sample stems", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    const st = G.storeOf("19189");
    expect(st).toBeTruthy();
    expect(st.l).toBeTruthy();
    expect(st.l.id).toBe("VJ008382");
    expect(st.l.d).toBe("pro");
    expect(st.l.n).toBe(9);
    expect(st.l.sm).toEqual(["smpa1", "smpa2", "smpa3", "smpa4", "smpa5", "smpa6", "smpa7", "smpa8", "smpa9"]);

    G.setTab("all");
    G.openDetail("19189");
    const dlSec = doc.querySelector(".dsec-dl");
    expect(dlSec, "DLsite section must exist in drawer").toBeTruthy();
    const imgs = [...dlSec.querySelectorAll(".strip img")];
    expect(imgs.length).toBe(9);
    expect(imgs[0].getAttribute("src")).toContain("VJ008382_img_smpa1_100x100.jpg");
    expect(imgs[0].getAttribute("data-full")).toContain("VJ008382_img_smpa1.webp");
    expect(dlSec.querySelector("a").href).toContain("dlsite.com/pro/work/=/product_id/VJ008382.html");
  });

  test("催眠学習 Secret Desire (gid 30195 / rank 500) matches DLsite VJ015151 and FANZA next_0304", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    const st = G.storeOf("30195");
    expect(st).toBeTruthy();
    expect(st.l).toBeTruthy();
    expect(st.l.id).toBe("VJ015151");
    expect(st.l.d).toBe("pro");
    expect(st.l.n).toBe(5);
    expect(st.l.sm).toEqual(["smpa1", "smpa2", "smpa3", "smpa4", "smpa5"]);
    expect(st.m).toBeTruthy();
    expect(st.m.id).toBe("next_0304");
    expect(st.m.n).toBe(5);

    G.setTab("all");
    G.openDetail("30195");
    const dlSec = doc.querySelector(".dsec-dl");
    expect(dlSec, "DLsite section must exist in drawer").toBeTruthy();
    const dlImgs = [...dlSec.querySelectorAll(".strip img")];
    expect(dlImgs.length).toBe(5);
    expect(dlImgs[0].getAttribute("src")).toContain("VJ015151_img_smpa1_100x100.jpg");
    expect(dlSec.querySelector("a").href).toContain("dlsite.com/pro/work/=/product_id/VJ015151.html");

    const dmSec = doc.querySelector(".dsec-dmm");
    expect(dmSec, "FANZA section must exist in drawer").toBeTruthy();
    const dmImgs = [...dmSec.querySelectorAll(".strip img")];
    expect(dmImgs.length).toBe(5);
    expect(dmImgs[0].getAttribute("src")).toContain("next_0304/next_0304js-001.jpg");
    expect(dmSec.querySelector("a").href).toContain("dlsoft.dmm.co.jp/detail/next_0304/");
  });

  test("催眠性指導 -Secret Lesson- (gid 35655 / rank 126) matches FANZA next_0407 and Getchu 1274775", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    const st = G.storeOf("35655");
    expect(st).toBeTruthy();
    expect(st.m).toBeTruthy();
    expect(st.m.id).toBe("next_0407");
    expect(st.m.n).toBe(12);
    expect(st.g).toBeTruthy();
    expect(st.g.id).toBe("1274775");
    expect(st.g.n).toBe(10);

    G.setTab("all");
    G.openDetail("35655");

    const dmSec = doc.querySelector(".dsec-dmm");
    expect(dmSec, "FANZA section must exist in drawer").toBeTruthy();
    const dmImgs = [...dmSec.querySelectorAll(".strip img")];
    expect(dmImgs.length, "all 12 FANZA frames render, no display cap").toBe(12);
    expect(dmImgs[0].getAttribute("src")).toContain("next_0407/next_0407js-001.jpg");
    expect(dmSec.querySelector("a").href).toContain("dlsoft.dmm.co.jp/detail/next_0407/");

    const gcSec = doc.querySelector(".dsec-gc");
    expect(gcSec, "Getchu section must exist in drawer").toBeTruthy();
    const gcImgs = [...gcSec.querySelectorAll(".strip img")];
    expect(gcImgs.length).toBe(9);
    expect(gcImgs[0].getAttribute("src")).toContain("/gc/sample/1274775/2.jpg");
    expect(gcSec.querySelector("a").href).toContain("getchu.com/soft.phtml?id=1274775");
  });

  test("搾精病棟 (gid 32809 / rank 291) matches FANZA next_0353 and Getchu 1185921", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    const st = G.storeOf("32809");
    expect(st).toBeTruthy();
    expect(st.m).toBeTruthy();
    expect(st.m.id).toBe("next_0353");
    expect(st.m.n).toBe(4);
    expect(st.g).toBeTruthy();
    expect(st.g.id).toBe("1185921");
    expect(st.g.n).toBe(12);

    G.setTab("all");
    G.openDetail("32809");

    const dmSec = doc.querySelector(".dsec-dmm");
    expect(dmSec, "FANZA section must exist in drawer").toBeTruthy();
    const dmImgs = [...dmSec.querySelectorAll(".strip img")];
    expect(dmImgs.length).toBe(4);
    expect(dmImgs[0].getAttribute("src")).toContain("next_0353/next_0353js-001.jpg");
    expect(dmSec.querySelector("a").href).toContain("dlsoft.dmm.co.jp/detail/next_0353/");

    const gcSec = doc.querySelector(".dsec-gc");
    expect(gcSec, "Getchu section must exist in drawer").toBeTruthy();
    const gcImgs = [...gcSec.querySelectorAll(".strip img")];
    expect(gcImgs.length, "samples 2..12 all render, no display cap").toBe(11);
    expect(gcImgs[0].getAttribute("src")).toContain("/gc/sample/1185921/2.jpg");
    expect(gcSec.querySelector("a").href).toContain("getchu.com/soft.phtml?id=1185921");
  });

  test("related strip stays inside #dbody, never links to itself and opens targets", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    // A cached product that actually has same-brand/series siblings, so the
    // drawer opens synchronously (no live VNDB lookup) and the rows render.
    const item = G.DATA.find((d) =>
      G.liveCache.get(d.gid) && G.relatedOf(d, G.liveCache.get(d.gid)).length > 0);
    expect(item, "no cached product has any related siblings").toBeTruthy();
    G.setTab("all");
    G.openDetail(String(item.gid));
    const strip = doc.querySelector("#dbody .relstrip");
    expect(strip, "related strip must render inside #dbody").toBeTruthy();
    const cards = [...strip.querySelectorAll(".relcard")];
    expect(cards.length, "related strip is empty").toBeGreaterThan(0);
    expect(cards.length, "related strip overflowed 8").toBeLessThanOrEqual(8);
    for (const c of cards) {
      expect(c.dataset.act).toBe("detail");
      expect(c.dataset.gid, "recommendation card has no gid").toBeTruthy();
      expect(c.dataset.gid, "recommendation links to itself").not.toBe(String(item.gid));
      expect(c.querySelector(".relimg") || c.querySelector(".relnocover"),
        "card has neither cover nor placeholder").toBeTruthy();
    }
    // Clicking a recommendation jumps straight into that game's drawer.
    const target = G.DATA.find((d) => String(d.gid) === cards[0].dataset.gid);
    cards[0].click();
    expect(doc.getElementById("drawer").classList.contains("open"), "drawer closed on relcard click").toBe(true);
    expect(doc.getElementById("dhead").textContent, "relcard click did not open the target").toContain(target.name);
  });

  test("related flanking rails support infinite autoscroll with viewport, clones and clickable targets", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    // Find a game whose brand has >= 6 items so leftList has >= 3 items (triggers autoscroll)
    const item = G.DATA.find((d) =>
      G.liveCache.get(d.gid) && G.relatedOf(d, G.liveCache.get(d.gid)).length >= 5);
    expect(item, "no cached product has >= 5 related siblings").toBeTruthy();

    G.setTab("all");
    G.openDetail(String(item.gid));

    const vp = doc.querySelector("#dbody .relrail-viewport.has-autoscroll");
    expect(vp, "overflowing rail must have .has-autoscroll viewport").toBeTruthy();

    const clones = [...vp.querySelectorAll(".relclone")];
    expect(clones.length, "autoscroll viewport must contain clones for infinite loop").toBeGreaterThanOrEqual(3);

    // Clicking a cloned card also seamlessly opens that game's drawer
    const cloneTarget = G.DATA.find((d) => String(d.gid) === clones[0].dataset.gid);
    clones[0].click();
    expect(doc.getElementById("drawer").classList.contains("open"), "drawer closed on clone click").toBe(true);
    expect(doc.getElementById("dhead").textContent, "clone click did not open target").toContain(cloneTarget.name);

    // Stop and restart autoscroll cleanly
    expect(typeof G.startRelAutoScroll).toBe("function");
    expect(typeof G.stopRelAutoScroll).toBe("function");
    G.stopRelAutoScroll();
  });

  test("closes via Esc, #dclose and the backdrop", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    const gid = richGid(window);
    // Esc
    G.openDetail(gid);
    doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(doc.getElementById("drawer").classList.contains("open"), "Esc did not close the drawer").toBe(false);
    expect(doc.body.classList.contains("locked"), "Esc left body locked").toBe(false);
    // #dclose
    G.openDetail(gid);
    doc.getElementById("dclose").click();
    expect(doc.getElementById("drawer").classList.contains("open"), "#dclose did not close the drawer").toBe(false);
    // backdrop
    G.openDetail(gid);
    doc.querySelector("#drawer .backdrop").click();
    expect(doc.getElementById("drawer").classList.contains("open"), "backdrop did not close the drawer").toBe(false);
  });

  test("openDetail resets scroll position to top", () => {
    const { doc, window } = loadGallery();
    const G = window.GALLERY;
    const gid = richGid(window);
    G.setTab("all");
    G.openDetail(gid);
    const dbody = doc.getElementById("dbody");
    dbody.scrollTop = 450;
    // Open detail again
    G.openDetail(gid);
    expect(dbody.scrollTop, "dbody.scrollTop must be reset to 0 after opening").toBe(0);
  });
});

describe("lightbox", () => {
  // A cached product with enough screenshots to page through.
  function openWithImages() {
    const ctx = loadGallery();
    const G = ctx.window.GALLERY;
    const gid = Object.keys(G.CACHE).find((k) => G.CACHE[k] && (G.CACHE[k].shots || []).length >= 2);
    expect(gid, "no cached product with two screenshots").toBeTruthy();
    G.setTab("all");
    G.openDetail(gid);
    return ctx;
  }

  test("a strip image opens the lightbox with thumbs, caption and the full url", () => {
    const { doc, window } = openWithImages();
    const first = doc.querySelector("#dbody .strip img");
    first.click();
    const lb = doc.getElementById("lightbox");
    expect(lb.classList.contains("open"), "lightbox did not open").toBe(true);
    expect(doc.getElementById("vimg").getAttribute("src"), "vimg must show the clicked full url")
      .toBe(first.getAttribute("data-full"));
    expect(doc.getElementById("lbSpinner"), "lbSpinner element must exist").toBeTruthy();
    expect(doc.getElementById("vcap").textContent, "caption must read i / N label").toMatch(/^1 \/ \d+ /);
    const thumbs = [...doc.querySelectorAll("#vthumbs button[data-vi]")];
    const stripImgs = [...doc.querySelectorAll("#dbody .strip img")];
    expect(thumbs.length, "thumbstrip must mirror the strips").toBe(stripImgs.length);
    expect(thumbs.every((b) => b.querySelector("img")), "thumbs must be lazy imgs").toBe(true);
    expect(thumbs[0].classList.contains("cur"), "first thumb not marked current").toBe(true);
  });

  test("vprev/vnext cycle modulo and thumbstrip buttons jump", () => {
    const { doc } = openWithImages();
    doc.querySelector("#dbody .strip img").click(); // open the lightbox first
    const n = doc.querySelectorAll("#dbody .strip img").length;
    doc.getElementById("vnext").click();
    expect(doc.getElementById("vcap").textContent, "#vnext did not advance").toMatch(/^2 \/ /);
    doc.getElementById("vprev").click();
    expect(doc.getElementById("vcap").textContent, "#vprev did not step back").toMatch(/^1 \/ /);
    doc.getElementById("vprev").click();
    expect(doc.getElementById("vcap").textContent, "#vprev must wrap to the last image")
      .toMatch(new RegExp(`^${n} \\/ `));
    const btn = doc.querySelector('#vthumbs button[data-vi="1"]');
    btn.click();
    expect(doc.getElementById("vcap").textContent, "thumb click did not jump").toMatch(/^2 \/ /);
    expect(btn.classList.contains("cur"), "jumped thumb not marked current").toBe(true);
  });

  test("closing the lightbox keeps body.locked while the drawer is open", () => {
    const { doc, window } = openWithImages();
    const lb = doc.getElementById("lightbox");
    doc.querySelector("#dbody .strip img").click(); // open the lightbox
    // Esc with the lightbox open closes ONLY the lightbox.
    doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(lb.classList.contains("open"), "Esc did not close the lightbox").toBe(false);
    expect(doc.getElementById("drawer").classList.contains("open"), "Esc closed the drawer too").toBe(true);
    expect(doc.body.classList.contains("locked"), "drawer still open: body must stay locked").toBe(true);
    // #vclose behaves the same.
    doc.querySelector("#dbody .strip img").click();
    expect(lb.classList.contains("open")).toBe(true);
    doc.getElementById("vclose").click();
    expect(lb.classList.contains("open"), "#vclose did not close the lightbox").toBe(false);
    expect(doc.body.classList.contains("locked"), "#vclose unlocked the open drawer").toBe(true);
    // With the lightbox closed, Esc closes the drawer and unlocks the body.
    doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(doc.getElementById("drawer").classList.contains("open")).toBe(false);
    expect(doc.body.classList.contains("locked")).toBe(false);
  });

  test("原图 opens the current full url in a new tab", () => {
    const { doc, window } = openWithImages();
    doc.querySelector("#dbody .strip img").click();
    const opened = [];
    window.open = (u) => { opened.push(String(u)); return null; };
    doc.getElementById("vopen").click();
    expect(opened, "#vopen did not open the current image").toEqual([doc.getElementById("vimg").getAttribute("src")]);
  });

  test("clicking outside image on lightbox closes it, clicking image keeps it open", () => {
    const { doc } = openWithImages();
    const lb = doc.getElementById("lightbox");
    doc.querySelector("#dbody .strip img").click(); // open
    expect(lb.classList.contains("open")).toBe(true);

    // Clicking image keeps it open
    doc.getElementById("vimg").click();
    expect(lb.classList.contains("open"), "clicking image should not close lightbox").toBe(true);

    // Clicking viewport backdrop closes it
    doc.getElementById("lbViewport").click();
    expect(lb.classList.contains("open"), "clicking viewport backdrop should close lightbox").toBe(false);
  });

  test("mouse wheel switches images in lightbox", () => {
    const { doc, window } = openWithImages();
    doc.querySelector("#dbody .strip img").click(); // open
    expect(doc.getElementById("vcap").textContent).toMatch(/^1 \/ /);

    const lb = doc.getElementById("lightbox");
    // Scroll down (deltaY > 0) -> advance to image 2
    const wheelDown = new window.Event("wheel", { bubbles: true, cancelable: true });
    wheelDown.deltaY = 100;
    lb.dispatchEvent(wheelDown);
    expect(doc.getElementById("vcap").textContent, "wheel down did not advance").toMatch(/^2 \/ /);
  });

  test("predictively preloads neighboring images and on hover", () => {
    const { doc, window } = openWithImages();
    const G = window.GALLERY;
    expect(G.preloadedUrls, "preloadedUrls Set must exist").toBeTruthy();

    const stripImgs = doc.querySelectorAll("#dbody .strip img");
    expect(stripImgs.length).toBeGreaterThanOrEqual(2);

    // Initial drawer open should have prefetched the first 2 screenshots
    expect(G.preloadedUrls.has(stripImgs[0].getAttribute("data-full"))).toBe(true);
    if (stripImgs.length >= 2) {
      expect(G.preloadedUrls.has(stripImgs[1].getAttribute("data-full"))).toBe(true);
    }

    // Hovering a strip image triggers preloading
    if (stripImgs.length >= 3) {
      const targetUrl = stripImgs[2].getAttribute("data-full");
      stripImgs[2].dispatchEvent(new window.Event("mouseenter"));
      expect(G.preloadedUrls.has(targetUrl)).toBe(true);
    }

    // Opening lightbox preloads neighboring images (+1, -1, +2, -2, etc.)
    stripImgs[0].click();
    expect(G.preloadedUrls.has(stripImgs[1].getAttribute("data-full"))).toBe(true);

    // Hovering a thumbnail button in #vthumbs triggers preloading
    const thumbs = doc.querySelectorAll("#vthumbs button[data-vi]");
    if (thumbs.length >= 3) {
      const lastThumb = thumbs[thumbs.length - 1];
      const lastImg = stripImgs[thumbs.length - 1];
      lastThumb.dispatchEvent(new window.Event("mouseenter"));
      expect(G.preloadedUrls.has(lastImg.getAttribute("data-full"))).toBe(true);
    }
  });

  test("lightbox loading transition, stale image suppression and error fallback", () => {
    const { doc, window } = openWithImages();
    const G = window.GALLERY;
    const stripImgs = doc.querySelectorAll("#dbody .strip img");
    stripImgs[0].click();

    const stage = doc.getElementById("lbImageStage");
    const vimg = doc.getElementById("vimg");
    expect(stage.classList.contains("is-loading"), "stage must have is-loading on cold load").toBe(true);
    expect(vimg.classList.contains("is-loading"), "vimg must have is-loading so stale image does not show").toBe(true);

    // Simulate successful load event
    vimg.dispatchEvent(new window.Event("load"));
    expect(stage.classList.contains("is-loading"), "stage must clear is-loading after load").toBe(false);
    expect(vimg.dataset.loadedUrl, "vimg must track loadedUrl").toBe(stripImgs[0].getAttribute("data-full"));

    // Step to next image: should immediately enter loading state and suppress old image
    doc.getElementById("vnext").click();
    expect(stage.classList.contains("is-loading"), "stage must enter loading state on switch").toBe(true);
    expect(vimg.classList.contains("is-loading"), "vimg must hide old image on switch").toBe(true);

    // Simulate error event on missing fallback
    vimg.dispatchEvent(new window.Event("error"));
    expect(stage.classList.contains("is-error"), "stage must enter is-error on failed image").toBe(true);
    expect(doc.getElementById("lbRetryBtn"), "retry button must be available in DOM").toBeTruthy();

    // Close lightbox: must clean up src and dataset to prevent leaking to next session
    G.closeLightbox();
    expect(vimg.getAttribute("src") || "", "vimg src must be reset on close").toBe("");
    expect(vimg.dataset.loadedUrl, "loadedUrl must be reset on close").toBeUndefined();
  });
});

describe("vndb matching guards", () => {
  // Regression fixtures for gid 31868 (妻の母 ～傲慢女社長と同居の日々～):
  // the correct v32745 lost its exact hit on tilde spacing, then the core
  // query matched the wrong same-prefix v2076 (妻の母さゆり, 2008).
  const V2076 = { id: "v2076", title: "Tsuma no Haha Sayuri", alttitle: "妻の母さゆり", released: "2008-04-25" };
  const V32745 = {
    id: "v32745", title: "Tsuma no Haha ~Gouman Onna Shachou to Doukyo no Hibi~",
    alttitle: "妻の母～傲慢女社長と同居の日々～", released: "2022-01-16",
  };
  const ITEM = { gid: "31868", name: "妻の母 ～傲慢女社長と同居の日々～", sellday: "2022-01-16" };

  function fns() {
    return loadGallery().window.GALLERY;
  }

  test("exact match ignores spacing around tildes", () => {
    expect(fns().exactPick([V32745], [ITEM.name], ITEM).id).toBe("v32745");
  });

  test("exact match handles hyphens and punctuation differences (v29779 for 催眠学習 Secret Desire)", () => {
    const G = fns();
    const V29779 = {
      id: "v29779",
      title: "Saimin Gakushuu -Secret Desire-",
      alttitle: "催眠学習 -Secret Desire-",
      released: "2021-03-26"
    };
    const item500 = { gid: "30195", name: "催眠学習 Secret Desire", sellday: "2021-03-26" };
    expect(G.exactPick([V29779], [item500.name], item500)?.id).toBe("v29779");
    expect(G.containsPick([V29779], item500.name, item500)?.id).toBe("v29779");
  });

  test("exact match handles hyphens and punctuation differences (v41351 for 催眠性指導 -Secret Lesson-)", () => {
    const G = fns();
    const V41351 = {
      id: "v41351",
      title: "Saimin Seishidou -Secret Lesson-",
      alttitle: "催眠性指導 -Secret Lesson-",
      released: "2024-12-20"
    };
    const item126 = { gid: "35655", name: "催眠性指導 -Secret Lesson-", sellday: "2024-12-20" };
    expect(G.exactPick([V41351], [item126.name], item126)?.id).toBe("v41351");
    expect(G.containsPick([V41351], item126.name, item126)?.id).toBe("v41351");
  });

  test("contains skips a wrong-year first hit", () => {
    expect(fns().containsPick([V2076, V32745], "妻の母", ITEM).id).toBe("v32745");
  });

  test("contains without dates keeps the old first-hit behavior", () => {
    expect(fns().containsPick([V2076, V32745], "妻の母", { sellday: "" }).id).toBe("v2076");
  });

  test("exact prefers the year-matching duplicate title", () => {
    const G = fns();
    const remake = { id: "vR", title: "Remake", alttitle: "同名", released: "2017-03-16" };
    const orig = { id: "vO", title: "Original", alttitle: "同名", released: "1996-12-26" };
    expect(G.exactPick([remake, orig], ["同名"], { sellday: "1996-12-26" }).id).toBe("vO");
  });

  test("weak live matches are migrated away on load", () => {
    const window = new Window({ url: "http://localhost/" });
    window.localStorage.setItem("vndb_live_v4", JSON.stringify({
      "31868": { id: "v2076", title: "x", via: "vn-core:妻の母" },
      "999": { id: "v999", title: "y", via: "release:foo:r1" },
      "7": { id: "v7", title: "z", via: "vn:exact title" },
    }));
    window.document.write(markupOnly);
    window.fetch = () => Promise.resolve({ ok: false, status: 599, json: () => Promise.resolve(null) });
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.eval(scriptBody);
    const live = window.GALLERY.liveCache;
    expect(live.get("31868"), "stale contains-pick survived migration").toBeUndefined();
    expect(live.get("999"), "stale release-pick survived migration").toBeUndefined();
    expect(live.get("7").id, "exact hit was wrongly migrated").toBe("v7");
  });
});

describe("live meta discipline", () => {
  test("one drawer open asks the Worker at most once per store product", () => {
    const { window, calls } = loadGallery();
    const G = window.GALLERY;
    const gid = richGid(window);
    G.setTab("all");
    G.openDetail(gid);
    const metaCalls = () => calls.filter((c) => /^\/(gc|dm|dl)\/meta\//.test(c.url));
    const first = metaCalls().length;
    // Re-open several times: nothing new should be requested. The DMM section
    // legitimately asks /dm/meta once per session for a better count, so only
    // growth is a failure.
    for (let i = 0; i < 4; i++) G.openDetail(gid);
    expect(metaCalls().length, "repeat drawer opens re-asked for meta").toBe(first);
  });

  test("products whose baked Getchu count is already known never hit /gc/meta", () => {
    const { window, calls } = loadGallery();
    const G = window.GALLERY;
    const gid = Object.keys(G.STORE).find(
      (k) => G.STORE[k].g && typeof G.STORE[k].g.n === "number" && G.STORE[k].g.n > 0
    );
    expect(gid).toBeTruthy();
    G.setTab("getchu");
    G.openDetail(gid);
    expect(calls.some((c) => /^\/gc\/meta\//.test(c.url))).toBe(false);
  });

  test("products whose baked DMM count is already known never hit /dm/meta", () => {
    const { window, calls } = loadGallery();
    const G = window.GALLERY;
    const gid = Object.keys(G.STORE).find(
      (k) => (G.STORE[k].m || G.STORE[k].m2) && typeof (G.STORE[k].m || G.STORE[k].m2).n === "number" && (G.STORE[k].m || G.STORE[k].m2).n > 0
    );
    expect(gid).toBeTruthy();
    G.setTab("dmm");
    G.openDetail(gid);
    expect(calls.some((c) => /^\/dm\/meta\//.test(c.url))).toBe(false);
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
    expect(doc.querySelectorAll("#grid .cardwrap").length).toBeGreaterThan(0);
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

// The chip for a shipped tag. toggleTag() re-renders #tagchips, so a node
// captured before a toggle is stale -- look the chip up fresh each time.
function chipFor(doc, tag) {
  return [...doc.querySelectorAll("#tagchips .tagchip")].find((c) => c.dataset.tag === tag);
}

// A product present in the baked CACHE. Without one, openDetail on the
// vndb/all views legitimately defers while VNDB is looked up, and a
// synchronous test cannot observe the drawer.
function cachedGid(window, predicate) {
  const G = window.GALLERY;
  return Object.keys(G.CACHE).find(
    (k) => G.CACHE[k] && (!predicate || predicate(G.storeOf(k) || {}, G.CACHE[k]))
  );
}

// A product with DLsite + FANZA + Getchu ids, so the drawer renders every section.
function richGid(window) {
  return cachedGid(window, (st) => st.l && (st.m || st.m2) && st.g);
}

// First rendered card that opens synchronously *and* has images for the view:
// the adapter must claim it, and on vndb/all a VNDB match must already exist
// (otherwise openDetail legitimately defers while it is looked up).
function openableGid(window, doc, view) {
  const G = window.GALLERY;
  // The Getchu section only renders baked Worker images synchronously;
  // products with an unknown count start as an empty grid until live meta
  // arrives (which the stubbed fetch never provides), so pick a baked one.
  if (view === "getchu") {
    const hit = G.DATA.find((d) => {
      const st = G.storeOf(d.gid);
      return st && st.g && typeof st.g.n === "number" && st.g.n > 0;
    });
    if (hit) return String(hit.gid);
  }
  const a = G.ADAPTERS[view];
  for (const wrap of doc.querySelectorAll("#grid .cardwrap")) {
    const gid = wrap.dataset.gid;
    const item = G.DATA.find((d) => String(d.gid) === gid);
    const v = G.liveCache.get(gid) || null;
    if (!item || !a.has(item, G.storeOf(gid), v)) continue;
    if ((view === "vndb" || view === "all") && !(v && (v.img || (v.shots || []).length))) continue;
    return gid;
  }
  return null;
}
