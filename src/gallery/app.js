// Gallery app. Authored as a real file; scripts/bundle.py inlines src/urls.js
// above this and the data payloads at the PAYLOAD anchor, producing the single
// self-contained public/index.html (which must stay file://-double-clickable,
// hence inlining instead of fetching JSON).
//
// Layout of this file:
//   1. cache + VNDB matching queue      (how a card learns its VNDB entry)
//   2. store adapters                   (what differs between the 5 tabs)
//   3. detail sections + renderer       (the modal)
//   4. cards, filtering, wiring
//
// Everything URL-shaped comes from urls.js. Nothing here re-derives a store
// path, floor, or stem pattern.

var liveCache = new Map(Object.entries(CACHE));
var pending = new Map();

// VNDB results the user fetched live, kept out of the baked CACHE so a rebuild
// stays authoritative. localStorage has a ~5MB quota and we serialize the whole
// map at once, so the budget is a byte count, not a row count.
var LIVE_KEY = "vndb_live_v4";
var LIVE_BUDGET = 900000;

try {
  var stored = JSON.parse(localStorage.getItem(LIVE_KEY) || "{}");
  for (var sk in stored) if (!liveCache.has(sk) && stored[sk]) liveCache.set(sk, stored[sk]);
} catch (e) {
  // Corrupt or quota-truncated value: start clean rather than crash the page.
  try { localStorage.removeItem(LIVE_KEY); } catch (e2) {}
}

// Serialize, and if that no longer fits, drop the oldest live entries until it
// does. The previous code did JSON.stringify(o).slice(0, 900000), which cut the
// JSON mid-token; the next load then failed to parse and threw the *entire*
// cache away — penalising exactly the users who had the most data.
function saveLive() {
  var kept = [];
  liveCache.forEach(function (v, k) {
    if (v && !CACHE[k]) kept.push(k);
  });
  for (;;) {
    var o = {};
    for (var i = 0; i < kept.length; i++) o[kept[i]] = liveCache.get(kept[i]);
    var s = JSON.stringify(o);
    if (s.length <= LIVE_BUDGET) {
      try { localStorage.setItem(LIVE_KEY, s); } catch (e) { /* private mode */ }
      return;
    }
    if (!kept.length) return;
    // Drop a proportional slice so this converges in a couple of passes.
    var drop = Math.max(1, Math.ceil(kept.length * (1 - LIVE_BUDGET / s.length)));
    kept = kept.slice(drop);
  }
}

// Meta lookups that already ran this session. Repeated modal opens are the main
// source of redundant /dm/meta and /gc/meta traffic, and each cold Worker lookup
// costs an upstream fetch plus a KV write. Bounded per session rather than
// persisted, so a new session still picks up store-side changes.
var asked = new Set();
try { asked = new Set(JSON.parse(sessionStorage.getItem("meta_asked_v1") || "[]")); } catch (e) {}
// True the first time a key is seen, false afterwards.
function askOnce(key) {
  if (!key || asked.has(key)) return false;
  asked.add(key);
  try { sessionStorage.setItem("meta_asked_v1", JSON.stringify(Array.from(asked).slice(-4000))); } catch (e) {}
  return true;
}

// --- VNDB queue: 2 concurrent, >=800ms apart, so the public API stays happy ---
var queue = [];
var active = 0;
var lastStart = 0;

function pump() {
  if (active >= 2) return;
  var job = queue.shift();
  if (!job) return;
  var wait = Math.max(0, 800 - (Date.now() - lastStart));
  active++;
  setTimeout(function () {
    lastStart = Date.now();
    doFetch(job.item).then(job.resolve, function () { job.resolve(null); })
      .then(function () { active--; pump(); });
  }, wait);
}

function normT(s) {
  return String(s == null ? "" : s).replace(/[～〜]/g, "~").replace(/　/g, " ").trim();
}

function normVariants(title) {
  var out = [title];
  function push(x) {
    x = String(x == null ? "" : x).trim();
    if (x && out.indexOf(x) < 0 && out.length < 6) out.push(x);
  }
  push(String(title).replace(/[((][^))]{0,30}[))]\s*$/, "").trim());
  var tails = [/\s+DVD EDITION\s*$/i, /\s+EXTENDED EDITION\s*$/i, /\s+WORLD'S END COMPLETE\s*$/i,
    /\s+COMPLETE\s*$/i, /パワーアップキット\s*$/, /限定再装版\s*$/, /\s+Re-order~?\s*$/i,
    /~chocolat second brew Re-order~\s*$/i];
  for (var ti = 0; ti < tails.length; ti++) {
    var snapshot = out.slice();
    for (var si = 0; si < snapshot.length; si++) push(snapshot[si].replace(tails[ti], ""));
  }
  var seps = ["〜", "～", " -", " "];
  for (var bi = 0; bi < out.slice().length; bi++) {
    for (var pi = 0; pi < seps.length; pi++) {
      var base = out[bi];
      if (base.indexOf(seps[pi]) >= 0 && base.length > 8) {
        var core = base.split(seps[pi])[0].trim();
        if (core.length >= 3) push(core);
        break;
      }
    }
  }
  return out;
}

function exactPick(list, queries) {
  for (var qi = 0; qi < queries.length; qi++) {
    var nq = normT(queries[qi]).toLowerCase();
    for (var ci = 0; ci < list.length; ci++) {
      var c = list[ci];
      if (normT(c.alttitle || "").toLowerCase() === nq) return c;
      if (normT(c.title || "").toLowerCase() === nq) return c;
    }
  }
  return null;
}

// Short variants only match by containment, to keep 街ヤリ-style noise out.
function containsPick(list, core) {
  var nc = normT(core).toLowerCase();
  if (nc.length < 3) return null;
  for (var ci = 0; ci < list.length; ci++) {
    var c = list[ci];
    if (normT(c.alttitle || "").toLowerCase().indexOf(nc) >= 0) return c;
    if (normT(c.title || "").toLowerCase().indexOf(nc) >= 0) return c;
  }
  return null;
}

function apiPost(path, body) {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(function (r) { return r.ok ? r.json() : null; });
}

var VN_FIELDS = "title, alttitle, image{url}, screenshots{url}, released";

function vnSearch(t) {
  return apiPost(API, { filters: ["search", "=", t], fields: VN_FIELDS, results: 3 })
    .then(function (j) { return (j && j.results) || []; });
}

function relSearch(t) {
  return apiPost("https://api.vndb.org/kana/release",
    { filters: ["search", "=", t], fields: "title, alttitle, vns{id,title}, released", results: 3 })
    .then(function (j) { return (j && j.results) || []; });
}

function vnById(vid) {
  return apiPost(API, { filters: ["id", "=", vid], fields: VN_FIELDS })
    .then(function (j) { return j && j.results && j.results[0]; });
}

// VNDB answers with {url, thumbnail} pairs; we keep the full url only, because
// vnThumb() reconstructs the thumbnail and that halves this payload.
function toUrl(u) { return u ? (typeof u === "string" ? u : u.url) : null; }

function toSlim(v, extra, release, via) {
  return {
    id: v.id, title: v.title, alttitle: v.alttitle, released: v.released,
    img: toUrl(v.image),
    shots: (v.screenshots || []).slice(0, 30).map(function (s) { return toUrl(s); }),
    extra: (extra || []).map(function (e) { return { id: e.id, title: e.title, alttitle: e.alttitle }; }),
    release: release || null, via: via || null,
  };
}

function remember(gid, s) {
  liveCache.set(gid, s);
  saveLive();
  return s;
}

function doFetch(item) {
  var variants = normVariants(item.name);
  var chain = Promise.resolve(null);

  variants.forEach(function (v) {
    chain = chain.then(function (hit) {
      if (hit) return hit;
      return vnSearch(v).then(function (list) {
        if (!list.length) return null;
        var pick = exactPick(list, [item.name, v]);
        if (pick) return remember(item.gid, toSlim(pick, null, null, "vn:" + v));
        if (v !== item.name) {
          pick = containsPick(list, v);
          if (pick && ((pick.alttitle || pick.title || "").length < 30 || v.length >= 4)) {
            return remember(item.gid, toSlim(pick, null, null, "vn-core:" + v));
          }
        }
        return null;
      }, function () { return null; });
    });
  });

  // Fall back to release search (release -> VN) only if no VN search hit.
  return chain.then(function (hit) {
    if (hit) return hit;
    var relChain = Promise.resolve(null);
    variants.forEach(function (v) {
      relChain = relChain.then(function (found) {
        if (found) return found;
        return relSearch(v).then(function (rels) {
          if (!rels.length) return null;
          var rel = rels[0];
          var ids = (rel.vns || []).slice(0, 3).map(function (x) { return x.id; });
          if (!ids.length) return null;
          var details = [];
          return ids.reduce(function (p, id) {
            return p.then(function () {
              return vnById(id).then(function (d) { if (d) details.push(d); }, function () {});
            });
          }, Promise.resolve()).then(function () {
            if (!details.length) return null;
            var primary = exactPick(details, [item.name, v]) || containsPick(details, v);
            if (!primary) return null;
            var extra = details.filter(function (d) { return d.id !== primary.id; });
            return remember(item.gid, toSlim(primary, extra, { id: rel.id, title: rel.title }, "release:" + v + ":" + rel.id));
          });
        }, function () { return null; });
      });
    });
    return relChain.then(function (found) {
      if (found) return found;
      liveCache.set(item.gid, null);
      return null;
    });
  });
}

function ensureVndb(item) {
  if (liveCache.has(item.gid)) return Promise.resolve(liveCache.get(item.gid));
  if (pending.has(item.gid)) return pending.get(item.gid);
  var p = new Promise(function (resolve) {
    queue.push({ item: item, resolve: resolve });
    pump();
  }).then(function (v) {
    pending.delete(item.gid);
    return v;
  });
  pending.set(item.gid, p);
  return p;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}

// Only same-origin proxy paths and dataset-controlled ids reach href/src today,
// but VNDB titles/ids come from a live API, so every interpolation stays escaped.
function attr(u) { return esc(u); }

// A single image cell: thumbnail, the full url the viewer opens, and the
// onerror chain to walk when the host 404s.
function imgSlot(thumb, full, fb, label) {
  return { thumb: thumb, full: full, fb: (fb || []).filter(Boolean), label: label || "" };
}

function slotHtml(s) {
  // onerror is unconditional: with no fallback left chainErr removes the tile,
  // so a 404 never stays on screen as a 裂图 (e.g. EGS products with <8 pics).
  return '<img loading="lazy" decoding="async" alt="" src="' + attr(s.thumb) + '"' +
    (s.fb.length ? ' data-fb="' + attr(s.fb.join("|")) + '"' : "") +
    ' data-full="' + attr(s.full) + '"' +
    ' onerror="chainErr(this)"' + ">";
}

// Walk the fallback chain, then vanish if the image is genuinely gone.
function chainErr(el) {
  var fb = (el.getAttribute("data-fb") || "").split("|").filter(function (u) { return u && u !== el.src; });
  if (fb.length) {
    el.setAttribute("data-fb", fb.slice(1).join("|"));
    el.setAttribute("data-full", fb[0]);
    el.src = fb[0];
  } else {
    el.remove();
  }
}
window.chainErr = chainErr;

// --- live meta: asked only when it can add information, once per session ------
function jsonFetch(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error("meta " + r.status);
    return r.json();
  });
}

function dmMeta(cid) {
  return jsonFetch(dmApiMeta(cid)).then(function (j) {
    return j && Number.isInteger(j.n) ? Math.min(j.n, DMM_SAMPLE_CAP) : null;
  }).catch(function () { return null; });
}

function dlMeta(rid, domain) {
  return jsonFetch(dlApiMeta(rid, domain)).then(function (j) {
    return j && Array.isArray(j.samples) ? j.samples : null;
  }).catch(function () { return null; });
}

// Definitive number on a definitive answer (0 = confirmed no samples via 404),
// null when the probe itself failed. Callers must handle both: leaving the
// section on "加载中…" forever is the bug this guards against.
function gcMeta(cid) {
  return fetch(gcApiMeta(cid)).then(function (r) {
    if (r.status === 404) return 0;
    if (!r.ok) throw new Error("meta " + r.status);
    return r.json();
  }).then(function (j) {
    if (j && Number.isInteger(j.n) && j.n > 0) return Math.min(j.n, GETCHU_SAMPLE_CAP);
    return 0;
  }).catch(function () { return null; });
}

// FANZA keeps a download-edition entry separate from the boxed one; only the
// download floors have images we can hotlink.
function dmmEntries(st) {
  if (!st) return [];
  var first = st.m && !isBoxed(st.m.id) ? st.m : st.m2;
  return first ? [first] : [];
}

function dlEntry(st) { return st ? st.l : null; }
function gcEntry(st) { return st ? st.g : null; }
function storeOf(gid) { return STORE[String(gid)] || null; }

// --- store adapters -----------------------------------------------------------
// Each adapter answers the same five questions for its tab. Adding a store means
// adding an entry here, not editing cardHtml + tabLink + applyFilter + openDetail.
var ADAPTERS = {
  dlsite: {
    tab: "dlsite",
    navLabel: "DLsite",
    matchedLabel: " 只看有DLsite",
    has: function (item, st) { return !!dlEntry(st); },
    cover: function (item, st) {
      var d = dlEntry(st);
      return d ? imgSlot(dlMainUrl(d), dlMainUrl(d), [dlMainThumbUrl(d)], "DLsite") : null;
    },
    sub: function (item, st) {
      var d = dlEntry(st);
      return d ? esc(d.id) : "无DLsite";
    },
    badge: function (item, st) {
      var d = dlEntry(st);
      // n is the crawled count and is known even when stem names were not, so
      // the badge must not depend on how many sample URLs we can build.
      return d && d.n ? countBadge(d.n, "张sample") : "";
    },
    link: function (item, st) {
      var d = dlEntry(st);
      return d ? { href: dlProductUrl(d.id, d.d), text: "DLsite" } : { href: vnSearchUrl(item.name), text: "DLsite" };
    },
    // DLsite sections need a stable grid id so a late-arriving stem list can
    // append without re-rendering the modal.
    sections: function (item, st) {
      var d = dlEntry(st);
      if (!d) return [hintSection("EGS无DLsite ID。")];
      return [dlSection(d, "DLsite")];
    },
  },

  dmm: {
    tab: "dmm",
    navLabel: "FANZA",
    matchedLabel: " 只看有FANZA",
    has: function (item, st) { return dmmEntries(st).length > 0; },
    cover: function (item, st) {
      var es = dmmEntries(st);
      if (!es.length) return null;
      var fb = es.map(function (e) { return dmmPkgUrl(e.id); });
      return imgSlot(fb[0], fb[0], fb.slice(1), "FANZA");
    },
    sub: function (item, st) {
      var es = dmmEntries(st);
      return es.length ? esc(es.map(function (e) { return e.id + "(" + dmmFloorLabel(e.id) + ")"; }).join(" / ")) : "无FANZA";
    },
    badge: function (item, st) {
      var es = dmmEntries(st);
      if (!es.length) return "";
      return countBadge(es.reduce(function (a, e) { return a + (e.n || 0); }, 0), "张sample");
    },
    link: function (item, st) {
      return { href: dmmSearchUrl(item.name), text: "FANZA" };
    },
    sections: function (item, st) {
      var es = dmmEntries(st);
      if (!es.length) return [hintSection("EGS无FANZA CID。")];
      return es.map(function (e) { return dmmSection(e); });
    },
  },

  getchu: {
    tab: "getchu",
    navLabel: "官方图",
    matchedLabel: " 只看Getchu收录",
    has: function (item, st) { return !!gcEntry(st); },
    cover: function (item, st) {
      var g = gcEntry(st);
      var e1 = egsImg(item.gid, 1);
      if (USE_GC && g) return imgSlot(gcApiCover(g.id), gcApiCover(g.id), [e1], "Getchu");
      return imgSlot(e1, e1, [], "official");
    },
    sub: function (item, st) {
      var g = gcEntry(st);
      return g ? "Getchu id=" + esc(g.id) : "EGS官方转存";
    },
    badge: function () { return '<span class="shotcount">官方/Getchu</span>'; },
    link: function (item, st) {
      var g = gcEntry(st);
      return { href: g ? gcProductUrl(g.id) : vnSearchUrl(item.name), text: "Getchu" };
    },
    sections: function (item, st) { return [gcSection(item, st)]; },
  },

  vndb: {
    tab: "vndb",
    navLabel: "VNDB",
    matchedLabel: " 只看已匹配VNDB",
    has: function (item, st, v) { return !!v; },
    cover: function (item, st, v) {
      if (!v || !v.img) return null;
      return imgSlot(v.img, v.img, [vnThumb(v.img)], "cover");
    },
    sub: function (item, st, v) {
      if (!v) return "未匹配";
      return esc(v.title || "") + (v.alttitle ? " / " + esc(v.alttitle) : "");
    },
    badge: function (item, st, v) {
      return v && v.shots ? countBadge(v.shots.length, "张截图") : "";
    },
    link: function (item, st, v) {
      return v ? { href: vnUrl(v.id), text: "VNDB" } : { href: vnSearchUrl(item.name), text: "VNDB搜索" };
    },
    sections: function (item, st, v) { return [vnSection(item, v)]; },
  },

  all: {
    tab: "all",
    navLabel: "综合",
    matchedLabel: " 只看有图",
    has: function (item, st, v) {
      // Same rule as before, with one fix: an item that only has the second
      // FANZA entry also counts, which the old st.dmm-only check missed.
      return !!v || !!dlEntry(st) || dmmEntries(st).length > 0;
    },
    cover: function (item, st, v) {
      // Quality order: FANZA package > EGS official mirror > VNDB > DLsite.
      var es = dmmEntries(st);
      var d = dlEntry(st);
      var g = gcEntry(st);
      var egs = egsImg(item.gid, 1);
      var vn = v && v.img ? v.img : null;
      if (es.length) {
        var src = dmmPkgUrl(es[0].id);
        return imgSlot(src, src, [egs, vn, d ? dlMainUrl(d) : null], "cover");
      }
      if (USE_GC && g) return imgSlot(gcApiCover(g.id), gcApiCover(g.id), [egs, vn], "cover");
      return imgSlot(egs, egs, [vn, d ? dlMainUrl(d) : null], "cover");
    },
    sub: function (item, st, v) {
      var parts = [];
      if (v) parts.push(esc(v.title || v.id));
      if (dlEntry(st)) parts.push(esc(dlEntry(st).id));
      dmmEntries(st).forEach(function (e) { parts.push(esc(e.id)); });
      return parts.join(" / ") || "未匹配";
    },
    badge: function (item, st, v) {
      var n = 0;
      if (v && v.shots) n += v.shots.length;
      if (dlEntry(st)) n += dlStems(dlEntry(st)).length;
      dmmEntries(st).forEach(function (e) { n += e.n || 0; });
      if (gcEntry(st)) n += gcEntry(st).n || 0;
      return countBadge(n, "张");
    },
    link: function (item, st, v) {
      var d = dlEntry(st);
      if (d) return { href: dlProductUrl(d.id, d.d), text: "商店/VNDB" };
      return { href: v ? vnUrl(v.id) : vnSearchUrl(item.name), text: "商店/VNDB" };
    },
    sections: function (item, st, v) {
      var secs = [vnSection(item, v, "VNDB截图")];
      var d = dlEntry(st);
      if (d) secs.push(dlSection(d, "DLsite"));
      dmmEntries(st).forEach(function (e) { secs.push(dmmSection(e)); });
      secs.push(gcSection(item, st));
      return secs;
    },
  },
};

function countBadge(n, unit) {
  return '<span class="shotcount">' + n + esc(unit) + "</span>";
}

function hintSection(text) {
  return { title: "", hint: text, slots: [], cover: null };
}

// --- section builders: one per store, all returning the same shape ------------
// { title, note, cover, slots, link, count, grow }
// grow is an async function returning extra imgSlots beyond what is baked.

function vnSection(item, v, title) {
  if (!v) return { title: title || "", hint: "VNDB未匹配。", slots: [], cover: null };
  // Only the full url is stored; the thumbnail is reconstructed. .t is normally
  // generated for every VNDB image, but 5 source rows had no separate thumb, so
  // the full url rides along as the onerror fallback.
  var shot = function (u, i) {
    return imgSlot(vnThumb(u), u, [u], (title ? "VNDB" : "截图") + (i + 1));
  };
  var slots = (v.shots || []).map(shot);
  return {
    title: (title || "VNDB截图") + "（" + slots.length + "张）",
    cover: v.img ? shot(v.img, 0) : null,
    slots: slots,
    link: { href: vnUrl(v.id), text: "在VNDB打开" },
  };
}

function dlSection(d, title) {
  var stems = dlStems(d);
  var slots = stems.map(function (s, i) { return dlSampleSlot(d, s, i); });
  var sec = {
    title: title + "（" + esc(d.id) + "，<span data-livecount>" + slots.length + "</span>张sample）",
    cover: imgSlot(dlMainThumbUrl(d), dlMainUrl(d), [], "主图 " + d.id),
    slots: slots,
    link: { href: dlProductUrl(d.id, d.d), text: "在DLsite打开" },
    key: "dl:" + d.id,
  };
  // The baked stems are the exact crawl result for 727 of 744 products, so meta
  // is pointless there. It matters in two cases: no stems at all, and the 11
  // products where the build knew a count but guessed the names.
  if (USE_GC && (!stems.length || d.un)) sec.grow = dlGrow(d, stems);
  return sec;
}

function dlSampleSlot(d, stem, i) {
  var full = dlSampleUrl(d, stem);
  return imgSlot(dlSampleThumbUrl(d, stem), full, [full, dlJpg(full)], "sample" + (i + 1));
}

function dlGrow(d, guessed) {
  return function () {
    return dlMeta(d.id, d.d).then(function (list) {
      if (!list || !list.length) return null;
      var slots = list.map(function (s, i) { return dlSampleSlot(d, s, i); });
      // Nothing rendered yet: this is a plain append.
      if (!guessed.length) return { slots: slots, at: 0, replace: false };
      // Compare against the stems actually rendered. If the guess was wrong from
      // stem k onwards, only that tail is replaced -- the leading images match
      // either way, and re-emitting them would churn working tiles.
      var first = -1;
      for (var i = 0; i < Math.max(list.length, guessed.length); i++) {
        if (list[i] !== guessed[i]) { first = i; break; }
      }
      if (first < 0) return null;
      return { slots: slots.slice(first), at: first, replace: true };
    });
  };
}

function dmmSection(e) {
  var fl = dmmFloorLabel(e.id);
  var n = Math.min(e.n || 0, DMM_SAMPLE_CAP);
  var slots = [];
  for (var i = 1; i <= n; i++) slots.push(dmmSampleSlot(e.id, i, fl));
  var fb = dmmPkgFallbacks(e.id);
  var sec = {
    title: "FANZA " + esc(fl) + "（" + esc(e.id) + "，<span data-livecount>" + n + "</span>张sample）",
    cover: imgSlot(dmmPkgUrl(e.id), dmmPkgUrl(e.id), fb, "包图 " + fl + " " + e.id),
    slots: slots,
    link: { href: dmmDetailUrl(e.id), text: "商品页（" + fl + "）" },
    key: "dm:" + e.id,
  };
  // Baked n comes from list pages; the detail page is a better source, so this
  // one is worth asking about -- once per session.
  if (USE_GC) {
    sec.grow = function () {
      return dmMeta(e.id).then(function (m) {
        if (!m || m <= n) return [];
        var extra = [];
        for (var k = n + 1; k <= m; k++) extra.push(dmmSampleSlot(e.id, k, fl));
        return extra;
      });
    };
  }
  return sec;
}

function dmmSampleSlot(cid, i, fl) {
  var c = dmmSampleChain(cid, i);
  return imgSlot(c.small, c.big, [c.big].concat(c.rest), (fl || "") + " sample" + i);
}

// Getchu sample tile. Deliberately no EGS fallback: EGS index n is a different
// picture set, so swapping in the wrong picture is worse than hiding the tile.
// A hole (Getchu numbering is not always contiguous, and max-index probing can
// overshoot) then removes itself via chainErr instead of staying as a 裂图.
function gcSampleSlot(cid, n) {
  var src = gcApiSample(cid, n);
  return imgSlot(src, src, [], "Getchu sample" + n);
}

// Cover only: EGS 1 is the same official cover, so it is a sane fallback.
function gcCoverSlot(cid, gid) {
  var src = gcApiCover(cid);
  return imgSlot(src, src, [egsImg(gid, 1)], "Getchu封面");
}

function gcSection(item, st) {
  var g = gcEntry(st);
  var cid = g && g.id;
  // g.n is present only when the build crawled this page: >0 = images exist,
  // 0 = confirmed "no samples". Both cases need no live probe, which is what
  // keeps the Getchu tab off KV entirely.
  var known = g && typeof g.n === "number";
  var baked = known ? Math.min(g.n, GETCHU_SAMPLE_CAP) : 0;
  var i;
  if (USE_GC && cid && baked > 0) {
    // Cover lives in `cover` (big 上方大图), samples in `slots`: the same shape
    // dlSection/dmmSection/vnSection return, so the modal排版一致.
    var slots = [];
    for (i = 1; i <= baked; i++) slots.push(gcSampleSlot(cid, i));
    return {
      title: "Getchu（Worker代理，" + baked + "张）",
      cover: gcCoverSlot(cid, item.gid),
      slots: slots,
      link: { href: gcProductUrl(cid), text: "在Getchu打开" },
      key: "gc:" + cid,
    };
  }
  // Only the Worker proxy is shown. There used to be 8 EGS-mirror placeholders
  // here while the live probe ran, but those flashed a different picture set
  // and then got swapped out, which read as flicker — so an unknown count now
  // starts empty and the probe fills the grid in place.
  var link = cid ? { href: gcProductUrl(cid), text: "在Getchu打开" } : null;
  if (USE_GC && cid && !known) {
    var sec = {
      title: "Getchu（Worker代理，加载中…）",
      cover: null,
      slots: [],
      link: link,
      key: "gc:" + cid,
    };
    sec.grow = function () {
      return gcMeta(cid).then(function (m) {
        // Terminal titles for the non-image outcomes too: returning null here
        // would leave the heading on "加载中…" forever (and askOnce blocks
        // any retry this session), which is exactly the stuck-loading report.
        if (m === null) return { slots: [], title: "Getchu（Worker代理，加载失败）" };
        if (!m) return { slots: [], title: "Getchu（Worker代理，无sample）" };
        var out = [];
        for (var k = 1; k <= m; k++) out.push(gcSampleSlot(cid, k));
        return {
          slots: out, at: 0, replace: true,
          cover: gcCoverSlot(cid, item.gid),
          title: "Getchu（Worker代理，" + m + "张）",
        };
      });
    };
    return sec;
  }
  return {
    title: "Getchu（Worker代理）",
    hint: !cid ? "EGS无Getchu ID。"
      : (!USE_GC ? "本地文件模式：Getchu 图需经 Worker 代理查看，请部署后在线打开。"
        : "Getchu无sample。"),
    slots: [],
    cover: null,
    link: link,
  };
}

// --- full-CG external links (code that lived inside the data block before) ----
function fullcgOf(gid) { return FULLCG[String(gid)] || null; }

function fullcgGoogle(site, name, alt) {
  var q = 'site:' + site + ' "' + name + '"';
  if (alt && alt !== name) q += ' OR "' + alt + '"';
  if (site.indexOf("hitomi") === 0) q = "gamecg " + q;
  return "https://www.google.com/search?q=" + encodeURIComponent(q);
}

// Brand -> group tag slug. Curated brand_group.json (JP brands via VNDB
// producer names) wins; ASCII brands fall back to a naive slug.
function slugify(s) {
  return String(s == null ? "" : s).toLowerCase()
    .replace(/-/g, "_").replace(/[^a-z0-9 _]+/g, "")
    .replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function brandSlug(brand) {
  var b = String(brand == null ? "" : brand).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.'-]{0,40}$/.test(b)) return null;
  return slugify(b) || null;
}

function groupFor(brand) {
  var k = String(brand == null ? "" : brand).trim();
  if (BRANDG[k]) {
    var s = slugify(BRANDG[k]);
    if (s) return s;
  }
  return brandSlug(brand);
}

// hitomi takes the raw query after search.html?; e-hentai uses f_search with $
// for an exact tag match.
function hitomiSiteUrl(item, alt) {
  var parts = ["type:gamecg"];
  var g = groupFor(item.brand);
  if (g) parts.push("group:" + g);
  parts.push(alt && alt !== item.name ? alt : item.name);
  return "https://hitomi.la/search.html?" + encodeURIComponent(parts.join(" "));
}

function ehSiteUrl(item, alt) {
  var parts = [];
  var g = groupFor(item.brand);
  if (g) parts.push("group:" + g + "$");
  parts.push('title:"' + (alt && alt !== item.name ? alt : item.name) + '"');
  return "https://e-hentai.org/?f_search=" + encodeURIComponent(parts.join(" ")) + "&f_apply=Apply+Filter";
}

function extLink(href, text) {
  return '<a href="' + attr(href) + '" target="_blank" rel="noopener">' + text + "</a>";
}

function fullcgHtml(item, alt) {
  var e = fullcgOf(item.gid);
  var direct = [];
  if (e && e.hitomi) direct.push(extLink(e.hitomi, "hitomi全CG直连"));
  if (e && e.ehentai) direct.push(extLink(e.ehentai, "e-hentai全CG直连"));
  var g = groupFor(item.brand);
  var keys = alt && alt !== item.name ? esc(item.name) + " / " + esc(alt) : esc(item.name);
  return "<h3>全CG（站外）</h3>" +
    (direct.length ? "<p>已核实：" + direct.join(" | ") + "</p>" : "") +
    "<p>" + [
      extLink(hitomiSiteUrl(item, alt), "hitomi站内搜" + (g ? "(group:" + esc(g) + ")" : "(标题)")),
      extLink(ehSiteUrl(item, alt), "e-hentai站内搜" + (g ? "(group:" + esc(g) + "$)" : "(标题)")),
      extLink(fullcgGoogle("hitomi.la", item.name, alt), "Google搜hitomi全CG"),
      extLink(fullcgGoogle("e-hentai.org", item.name, alt), "Google搜e-hentai全CG"),
    ].join(" | ") + "</p>" +
    '<p class="hint">站内搜关键词：' + keys +
    (g ? "＋品牌group:" + esc(g) : "（该品牌暂无group映射，只用标题搜）") +
    "。先用本页官方截图核对是否为同一作，全CG图不在本画廊内展示，对方站内需各自过年龄确认/登录。</p>";
}

// --- related recommendations --------------------------------------------------
// Deterministic, data-local, no new payload: same brand (+100) and same series
// (+60, title-core match including VNDB alt titles), tie-broken by median
// closeness then rank. Rendered as compact rows that jump straight into that
// game's detail modal via the existing delegated data-act handler.
var SERIES_TAILS = [
  /\s+DVD EDITION\s*$/i, /\s+EXTENDED EDITION\s*$/i, /\s+WORLD'S END COMPLETE\s*$/i,
  /\s+COMPLETE\s*$/i, /パワーアップキット\s*$/, /限定再装版\s*$/,
  /\s+Re-order~?\s*$/i, /~chocolat second brew Re-order~\s*$/i,
  /\s*(完全版|決定版|豪華版|廉価版|普及版)\s*$/,
  /\s*(续篇|続篇|续作|続作|外传|外伝|Fan ?Disc|ファンディスク)\s*$/i,
];

var seriesKeyCache = {};
function seriesKey(name) {
  var raw = String(name == null ? "" : name);
  if (seriesKeyCache[raw] !== undefined) return seriesKeyCache[raw];
  var t = raw.replace(/[～〜]/g, "~").replace(/　/g, " ").trim();
  t = t.replace(/\s*[（(][^（）()]{0,30}[）)]\s*$/, "").trim();
  for (var i = 0; i < SERIES_TAILS.length; i++) t = t.replace(SERIES_TAILS[i], "").trim();
  // Subtitle cut: "A 〜 B" / "A - B" / "A Vol.2" all belong to series A.
  var cut = t.search(/\s*[~～]\s*|\s+-\s+|\s+Vol\.?\s*\d+/i);
  if (cut > 0) t = t.slice(0, cut).trim();
  // Numbered sequels fold together: "ランス10" / "WHITE ALBUM2" / "D.C. III".
  t = t.replace(/\s*(Vol\.?\s*)?\d+\s*$/, "").trim();
  t = t.replace(/\s+[IVXLCDM]+\s*$/i, "").trim();
  var key = t.length >= 3 ? t : (raw.trim().length >= 3 ? raw.trim() : "");
  seriesKeyCache[raw] = key;
  return key;
}

function relatedOf(item, v) {
  var mine = {};
  [item.name, v && v.title, v && v.alttitle].forEach(function (n) {
    var k = n && seriesKey(n);
    if (k) mine[k] = 1;
  });
  var out = [];
  for (var i = 0; i < DATA.length; i++) {
    var d = DATA[i];
    if (String(d.gid) === String(item.gid)) continue;
    var sameBrand = !!(d.brand && item.brand && d.brand === item.brand);
    var dk = d.name && seriesKey(d.name);
    var sameSeries = !!(dk && mine[dk]);
    if (!sameBrand && !sameSeries) continue;
    out.push({
      d: d, s: (sameBrand ? 100 : 0) + (sameSeries ? 60 : 0),
      md: Math.abs((d.median || 0) - (item.median || 0)),
      sameBrand: sameBrand, sameSeries: sameSeries,
    });
  }
  out.sort(function (a, b) { return b.s - a.s || a.md - b.md || a.d.rank - b.d.rank; });
  return out.slice(0, 6);
}

function relCardHtml(r) {
  // One recommendation cell: cover + name, jumps into that game's modal.
  // Covers reuse the all-tab quality order (FANZA > Getchu > EGS), so every
  // cell has the best picture available without new data.
  var d = r.d;
  var cov = ADAPTERS.all.cover(d, storeOf(d.gid), liveCache.get(d.gid) || null);
  var thumb = cov
    ? slotHtml(cov).replace("<img ", '<img class="relimg" ')
    : '<span class="relnocover">暂无封面</span>';
  var tag = (r.sameBrand ? "同社" : "") + (r.sameBrand && r.sameSeries ? "·" : "") + (r.sameSeries ? "同系列" : "");
  return '<button class="relcard" data-act="detail" data-gid="' + attr(d.gid) + '">' +
    thumb +
    '<span class="relname">#' + d.rank + " " + esc(d.name) + "</span>" +
    '<span class="hint">' + esc(tag + " " + d.brand) + " · 中央值 " + d.median + "</span></button>";
}

// Side rails: recommendations flank the main content (left/right), sticky while
// the middle scrolls. Split half/half; the single heading lives on the left.
function relatedRailsHtml(rel) {
  var mid = Math.ceil(rel.length / 2);
  function rail(list, cls, head) {
    return '<aside class="relrail ' + cls + '">' +
      (head ? '<h4 class="relhead">相关推荐</h4>' : "") +
      list.map(relCardHtml).join("") + "</aside>";
  }
  return rail(rel.slice(0, mid), "left", true) + rail(rel.slice(mid), "right", false);
}

// --- state --------------------------------------------------------------------
var TAB = "all";
// file:// has no same-origin /gc|/dm|/dl backend, so fall back to direct EGS.
var USE_GC = location.protocol === "http:" || location.protocol === "https:";
var API = "https://api.vndb.org/kana/vn";
var PAGE = 36;
var filtered = DATA.slice();
var shown = 0;

// Coverage numbers for the stats line, counted from the payloads themselves
// rather than baked in by the build (the old document hardcoded 60/53 and
// substituted a couple of counts at build time, which drifted as data changed).
var STATS = (function () {
  var hit = 0;
  Object.keys(CACHE).forEach(function (k) { if (CACHE[k]) hit++; });
  var dl = 0, dm = 0, gc = 0;
  Object.keys(STORE).forEach(function (k) {
    var st = STORE[k];
    if (st.l) dl++;
    if (st.m || st.m2) dm++;
    if (st.g) gc++;
  });
  return { vn_prefetch: Object.keys(CACHE).length, vn_hit: hit, dl: dl, dm: dm, gc: gc };
})();

function adapter() { return ADAPTERS[TAB]; }

// --- cards --------------------------------------------------------------------
function cardHtml(item, v) {
  var a = adapter();
  var st = storeOf(item.gid);
  var cover = a.cover(item, st, v);
  var coverHtml = cover
    ? '<img loading="lazy" decoding="async" src="' + attr(cover.thumb) + '"' +
      (cover.fb.length ? ' data-fb="' + attr(cover.fb.join("|")) + '"' : "") +
      ' data-full="' + attr(cover.full) + '"' +
      ' onerror="chainErr(this)"' + ' alt="cover">'
    : '<div class="novndb">' + (TAB === "vndb" || TAB === "all"
      ? "暂无图片<br>进入视口后自动查VNDB，或点下方按钮"
      : "EGS无该商店ID") + "</div>";
  var manual = ((TAB === "vndb" || TAB === "all") && !v && !liveCache.has(item.gid))
    ? '<button class="loadbtn" data-act="fetch" data-gid="' + attr(item.gid) + '">查VNDB封面</button>'
    : "";
  var link = a.link(item, st, v);
  var g = gcEntry(st);
  var glink = g ? " / " + extLink(gcProductUrl(g.id), "Getchu") : "";
  var extra = ((TAB === "vndb" || TAB === "all") && v && v.extra && v.extra.length)
    ? '<br><span class="hint">合集另含：' + v.extra.map(function (e) {
        return extLink(vnUrl(e.id), esc(e.alttitle || e.title));
      }).join(" / ") + (v.release ? "（发行 " + esc(v.release.id) + "）" : "") + "</span>"
    : "";
  return '<div class="cover" data-gid="' + attr(item.gid) + '">' + coverHtml +
      '<span class="rank">#' + item.rank + "</span>" +
      '<span class="median">' + item.median + "</span>" +
      a.badge(item, st, v) + manual + "</div>" +
    '<div class="meta"><h3>' + esc(item.name) + "</h3>" +
      '<div class="sub">' + esc(item.brand) + " / " + esc(item.sellday) + "<br>" +
      "中央值 " + item.median + " / 评分 " + item.count2 + "人 / 标签 " + item.votes + "票" +
      '<br><span class="hint">' + a.sub(item, st, v) + "</span>" + extra + "</div></div>" +
    '<div class="actions">' +
      '<button data-act="detail" data-gid="' + attr(item.gid) + '">详情/截图</button>' +
      extLink(link.href, link.text) +
      extLink(egsUrl(item.gid), "EGS") + glink +
    "</div>";
}

function applyFilter() {
  var q = document.getElementById("q").value.trim().toLowerCase();
  var mm = +document.getElementById("minMedian").value;
  var om = document.getElementById("onlyMatched").checked;
  var a = adapter();
  filtered = DATA.filter(function (d) {
    if ((d.median || 0) < mm) return false;
    var v = liveCache.get(d.gid) || null;
    if (om && !a.has(d, storeOf(d.gid), v)) return false;
    if (!q) return true;
    var st = storeOf(d.gid);
    var dl = dlEntry(st);
    var hay = [
      d.name, d.brand,
      v ? v.title : "", v ? v.alttitle : "",
      dl ? dl.id : "",
    ].concat(dmmEntries(st).map(function (e) { return e.id; })).join(" ").toLowerCase();
    return hay.indexOf(q) >= 0;
  });
  shown = 0;
  document.getElementById("grid").innerHTML = "";
  renderMore();
}

function renderMore() {
  var grid = document.getElementById("grid");
  var slice = filtered.slice(shown, shown + PAGE);
  slice.forEach(function (item) {
    var div = document.createElement("div");
    div.className = "card";
    div.dataset.gid = String(item.gid);
    div.innerHTML = cardHtml(item, liveCache.get(item.gid) || null);
    grid.appendChild(div);
    bindCard(div, item);
    getObserver().observe(div);
  });
  shown += slice.length;
  document.getElementById("stats").textContent =
    "共 " + filtered.length + " / " + DATA.length + " 个（EROGE限定）。" +
    "VNDB预取" + STATS.vn_prefetch + "/匹配" + STATS.vn_hit + "，其余可视自动查（2并发/800ms）；" +
    "DLsite覆盖" + STATS.dl + "，FANZA覆盖" + STATS.dm + "，Getchu覆盖" + STATS.gc + "。" +
    "当前Tab：" + TAB + "。已显示 " + shown + " 个。";
  document.getElementById("more").style.display = shown >= filtered.length ? "none" : "block";
}

function bindCard(div, item) {
  div.querySelector(".cover").addEventListener("click", function (e) {
    if (e.target.closest('[data-act="fetch"]')) return;
    openDetail(item.gid);
  });
  var fb = div.querySelector('[data-act="fetch"]');
  if (fb) {
    fb.addEventListener("click", function (e) {
      e.stopPropagation();
      ensureVndb(item).then(function (v) { refreshCard(item.gid, v); });
    });
  }
}

function refreshCard(gid, v) {
  var div = document.querySelector('.card[data-gid="' + CSS.escape(String(gid)) + '"]');
  if (!div) return;
  var item = DATA.find(function (d) { return String(d.gid) === String(gid); });
  if (!item) return;
  div.innerHTML = cardHtml(item, v || null);
  bindCard(div, item);
}

// Lazy VNDB lookup as cards scroll into view.
var observer = null;
function getObserver() {
  if (observer) return observer;
  observer = new IntersectionObserver(function (entries) {
    if (!document.getElementById("autoFetch").checked) return;
    if (TAB !== "vndb" && TAB !== "all") return;
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      var gid = en.target.dataset.gid;
      observer.unobserve(en.target);
      if (!liveCache.has(gid)) {
        var item = DATA.find(function (d) { return String(d.gid) === String(gid); });
        if (item) ensureVndb(item).then(function (v) { refreshCard(gid, v || null); });
      }
    });
  }, { rootMargin: "400px" });
  return observer;
}

// Infinite scroll: the 加载更多 button doubles as the sentinel, so environments
// without IntersectionObserver keep working via click. Fires progressively as
// the user nears the bottom; renderMore is slice-based, so a double trigger
// just advances two pages, never duplicates.
var moreObserver = null;
function getMoreObserver() {
  if (moreObserver) return moreObserver;
  if (typeof IntersectionObserver === "undefined") return null;
  moreObserver = new IntersectionObserver(function (entries) {
    if (!document.getElementById("autoMore").checked) return;
    var hit = false;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].isIntersecting) { hit = true; break; }
    }
    if (hit && shown < filtered.length) renderMore();
  }, { rootMargin: "600px" });
  moreObserver.observe(document.getElementById("more"));
  return moreObserver;
}

// --- viewer -------------------------------------------------------------------
var vList = [];
var vIdx = 0;
// Monotonic token: rapid prev/next clicks each start a load, and only the
// latest one's callbacks may touch the UI — otherwise a slow earlier image
// landing late would clear the spinner while the newest is still loading.
var vToken = 0;

function openViewer(list, idx) {
  vList = list;
  vIdx = idx || 0;
  updateViewer();
  document.getElementById("viewer").classList.add("open");
}

function updateViewer() {
  var cur = vList[vIdx];
  if (!cur) return;
  var img = document.getElementById("vimg");
  var spin = document.getElementById("vspin");
  var my = ++vToken;
  // Caption first: the counter reacts instantly so a fast click never feels lost.
  document.getElementById("vcap").textContent =
    (vIdx + 1) + " / " + vList.length + " " + (cur.label || "");
  // Dim the outgoing picture at once: without this the old image sits unchanged
  // behind the new caption and reads as "stuck / duplicate".
  img.classList.add("loading");
  // Delayed spinner: cached pictures resolve in ms and must not flash one.
  setTimeout(function () {
    if (my === vToken && !img.complete && spin) spin.classList.add("on");
  }, 180);
  img.onload = function () {
    if (my !== vToken) return;
    img.classList.remove("loading");
    if (spin) spin.classList.remove("on");
  };
  img.onerror = function () {
    if (my !== vToken) return;
    img.classList.remove("loading");
    if (spin) spin.classList.remove("on");
  };
  if (img.getAttribute("src") !== cur.full) img.src = cur.full;
  else {
    img.classList.remove("loading");
    if (spin) spin.classList.remove("on");
  }
  preloadAround();
}

// Warm the neighbours' full-size files so rapid prev/next usually hits cache
// instead of network. Adjacent only (±1): warming the whole list would hammer
// bandwidth on 30-picture sections.
function preloadAround() {
  if (typeof Image === "undefined" || vList.length < 2) return;
  for (var d = -1; d <= 1; d += 2) {
    var it = vList[(vIdx + d + vList.length) % vList.length];
    if (it && it.full) {
      var im = new Image();
      im.src = it.full;
    }
  }
}

function closeViewer() {
  vToken++; // invalidate any in-flight load callbacks
  document.getElementById("viewer").classList.remove("open");
  var img = document.getElementById("vimg");
  img.classList.remove("loading");
  var spin = document.getElementById("vspin");
  if (spin) spin.classList.remove("on");
  img.removeAttribute("src");
}

function viewIdx(list, im) {
  var urls = [im.currentSrc, im.src, im.getAttribute("data-full")].filter(Boolean);
  for (var u = 0; u < urls.length; u++) {
    for (var k = 0; k < list.length; k++) {
      if (list[k].full === urls[u]) return k;
    }
  }
  return 0;
}

// --- modal --------------------------------------------------------------------
// One renderer for all five tabs: header, a section per store, the external
// full-CG block, then the link row. What differs between tabs stays inside the
// adapters' `sections`, so openDetail has no branches at all.
var growTargets = [];

function renderModal(item, sections) {
  var viewList = [];
  var v = liveCache.get(item.gid) || null;
  var st = storeOf(item.gid);
  growTargets = [];

  var html = "<h2>#" + item.rank + " " + esc(item.name) + "</h2>" +
    '<p class="hint">' + esc(item.brand) + " / " + esc(item.sellday) +
    " / 中央值 " + item.median + " / 评分 " + item.count2 + " / 标签 " + item.votes + "票" +
    (v ? "<br>VNDB: " + esc(v.title || "") + (v.alttitle ? " / " + esc(v.alttitle) : "") +
      " / " + esc(v.id || "") + (v.via ? "<br>匹配方式：" + esc(v.via) : "") : "") +
    "</p>";

  sections.forEach(function (sec, si) {
    if (!sec) return;
    if (sec.title) html += '<h3 id="sec-h-' + si + '">' + sec.title + "</h3>";
    if (sec.hint) {
      html += '<p class="hint">' + sec.hint + "</p>";
      if (sec.link) html += "<p>" + extLink(sec.link.href, sec.link.text) + "</p>";
      return;
    }
    if (sec.cover) {
      viewList.push(sec.cover);
      html += slotHtml(sec.cover).replace("<img ", '<img class="big" id="sec-cover-' + si + '" ');
    }
    var count = sec.slots.length;
    if (count) {
      var from = viewList.length;
      sec.slots.forEach(function (s) { viewList.push(s); });
      html += '<div class="sgrid" id="sec-' + si + '">' + sec.slots.map(slotHtml).join("") + "</div>";
      if (sec.grow) {
        growTargets.push({ si: si, from: from, count: count, grow: sec.grow, key: sec.key || "sec" + si, cover: sec.cover || null, slots: sec.slots.slice() });
      }
    } else if (sec.grow) {
      // A section that starts empty still needs a grid anchor so async content
      // has somewhere to land (e.g. a DLsite product whose stems were never
      // harvested: without this the grow below would have no target and never run).
      var fromEmpty = viewList.length;
      html += '<div class="sgrid" id="sec-' + si + '"></div>';
      growTargets.push({ si: si, from: fromEmpty, count: 0, grow: sec.grow, key: sec.key || "sec" + si, cover: sec.cover || null, slots: [] });
    }
    if (sec.link) html += "<p>" + extLink(sec.link.href, sec.link.text) + "</p>";
  });

  // Recommendations flank the content as side rails (see wrap below); only the
  // empty state renders inline in the main flow.
  var rel = relatedOf(item, v);
  if (!rel.length) html += "<h3>相关推荐</h3>" + '<p class="hint">暂无同社/系列作收录。</p>';
  html += fullcgHtml(item, v && v.alttitle);

  var links = [];
  sections.forEach(function (sec) {
    if (sec && sec.link && !links.some(function (l) { return l.href === sec.link.href; })) {
      links.push(sec.link);
    }
  });
  var g = gcEntry(st);
  if (g) links.push({ href: gcProductUrl(g.id), text: "Getchu(id=" + esc(g.id) + ")" });
  links.push({ href: egsUrl(item.gid), text: "在EGS打开" });
  if (TAB === "vndb" || TAB === "all") {
    links.push({ href: vnSearchUrl(item.name), text: "VNDB搜索" });
  }
  html += "<p>" + links.map(function (l) { return extLink(l.href, l.text); }).join(" | ");
  if (TAB === "vndb" || TAB === "all") {
    html += ' | <button data-act="refetch" data-gid="' + attr(item.gid) + '">重查VNDB</button>';
  }
  html += "</p>";

  if (rel.length) {
    html = '<div class="mwrap"><div class="mmain">' + html + "</div>" + relatedRailsHtml(rel) + "</div>";
  }

  document.getElementById("mbody").innerHTML = html;
  document.getElementById("modal").classList.add("open");
  document.querySelectorAll("#mbody img").forEach(function (im) {
    // Recommendation covers navigate (delegated data-act), they must not also
    // open the viewer: their urls are not in viewList and would land on index 0.
    if (im.closest(".relrail")) return;
    im.style.cursor = "zoom-in";
    im.addEventListener("click", function () { openViewer(viewList, viewIdx(viewList, im)); });
  });
  return viewList;
}

// Append (or, for a wrong guess, swap in) whatever a store reports beyond the
// baked data, at most once per session per product. This is the only path that
// can reach KV.
function growSections(viewList) {
  growTargets.forEach(function (t) {
    if (askOnce(t.key) !== true) return;
    var grid = document.getElementById("sec-" + t.si);
    var heading = document.getElementById("sec-h-" + t.si);
    t.grow().then(function (res) {
      if (!res) return;
      // A grow may carry the real cover/title for a section that started as
      // placeholders (Getchu unknown -> baked shape). Apply those first so the
      // modal ends up identical to the baked path: big cover on top, samples
      // in the grid, no duplicated placeholder tiles.
      if (res.title && heading) heading.textContent = res.title;
      if (res.cover) {
        var oldCover = document.getElementById("sec-cover-" + t.si);
        var coverHtml = slotHtml(res.cover).replace("<img ", '<img class="big" id="sec-cover-' + t.si + '" ');
        if (oldCover) {
          var oldFull = t.cover ? t.cover.full : null;
          var cidx = -1;
          if (oldFull) {
            for (var vi = 0; vi < viewList.length; vi++) {
              if (viewList[vi].full === oldFull) { cidx = vi; break; }
            }
          }
          if (cidx >= 0) viewList[cidx] = res.cover; else viewList.push(res.cover);
          oldCover.outerHTML = coverHtml;
        } else {
          // No baked cover: viewer lookup is URL-based, so push order is cosmetic.
          viewList.push(res.cover);
          if (grid) grid.insertAdjacentHTML("beforebegin", coverHtml);
        }
        var nc = document.getElementById("sec-cover-" + t.si);
        if (nc) {
          nc.style.cursor = "zoom-in";
          nc.addEventListener("click", function () { openViewer(viewList, viewIdx(viewList, nc)); });
        }
      }
      var extra = res.slots || res;
      if (!extra.length || !grid) return;
      if (res.replace) {
        // Swap out the guessed tail in the DOM and the viewer list together, so
        // clicking any tile still lands on the right image. Removal is by URL:
        // other sections may have appended to viewList since, so index splicing
        // to the end would eat their entries.
        var at = res.at || 0;
        var oldUrls = (t.slots || []).slice(at).map(function (s) { return s.full; });
        for (var vi2 = viewList.length - 1; vi2 >= 0; vi2--) {
          if (oldUrls.indexOf(viewList[vi2].full) >= 0) viewList.splice(vi2, 1);
        }
        var imgs = grid.querySelectorAll("img");
        for (var r = imgs.length - 1; r >= at; r--) imgs[r].remove();
        extra.forEach(function (s) { viewList.push(s); });
        grid.insertAdjacentHTML("beforeend", extra.map(slotHtml).join(""));
      } else {
        extra.forEach(function (s) {
          if (viewList.some(function (y) { return y.full === s.full; })) return;
          viewList.push(s);
          grid.insertAdjacentHTML("beforeend", slotHtml(s));
        });
      }
      grid.querySelectorAll("img").forEach(function (im) {
        im.style.cursor = "zoom-in";
        im.addEventListener("click", function () { openViewer(viewList, viewIdx(viewList, im)); });
      });
      if (heading) {
        heading.innerHTML = heading.innerHTML.replace(/<span data-livecount>\d+<\/span>/,
          '<span data-livecount>' + grid.querySelectorAll("img").length + "</span>");
      }
    });
  });
}

function openDetail(gid) {
  var item = DATA.find(function (d) { return String(d.gid) === String(gid); });
  if (!item) return;
  if ((TAB === "vndb" || TAB === "all") && liveCache.get(gid) === undefined) {
    ensureVndb(item).then(function () { openDetail(gid); });
    return;
  }
  var sections = adapter().sections(item, storeOf(gid), liveCache.get(gid) || null);
  growSections(renderModal(item, sections));
}

// --- wiring -------------------------------------------------------------------
var TABS = [["tabAll", "all"], ["tabVndb", "vndb"], ["tabDlsite", "dlsite"],
  ["tabDmm", "dmm"], ["tabGc", "getchu"]];

function setTab(t) {
  TAB = t;
  TABS.forEach(function (pair) {
    document.getElementById(pair[0]).classList.toggle("on", pair[1] === t);
  });
  var label = document.getElementById("onlyMatchedLabel");
  if (label) label.textContent = ADAPTERS[t].matchedLabel;
  applyFilter();
}

function clearLive(gid) {
  liveCache.delete(gid);
  pending.delete(gid);
  saveLive();
}

function wire() {
  TABS.forEach(function (pair) {
    document.getElementById(pair[0]).onclick = function () { setTab(pair[1]); };
  });
  var DENSITIES = [["auto", "密度：自动"], ["density-compact", "密度：紧凑"], ["density-large", "密度：大图"]];
  var dBtn = document.getElementById("density");
  var dIdx = 0;
  try { dIdx = Math.max(0, DENSITIES.findIndex(function (x) { return x[0] === localStorage.getItem("density"); })); } catch (e) {}
  function setDensity(i) {
    dIdx = i % DENSITIES.length;
    var grid = document.getElementById("grid");
    grid.classList.remove("density-compact", "density-large");
    if (DENSITIES[dIdx][0] !== "auto") grid.classList.add(DENSITIES[dIdx][0]);
    dBtn.textContent = DENSITIES[dIdx][1];
    try { localStorage.setItem("density", DENSITIES[dIdx][0]); } catch (e) {}
  }
  if (dBtn) {
    dBtn.onclick = function () { setDensity(dIdx + 1); };
    setDensity(dIdx);
  }
  document.getElementById("q").oninput = applyFilter;
  document.getElementById("minMedian").onchange = applyFilter;
  document.getElementById("onlyMatched").onchange = applyFilter;
  document.getElementById("reset").onclick = function () {
    document.getElementById("q").value = "";
    document.getElementById("minMedian").value = "0";
    document.getElementById("onlyMatched").checked = false;
    applyFilter();
  };
  document.getElementById("more").onclick = renderMore;
  getMoreObserver();
  document.getElementById("close").onclick = function () {
    document.getElementById("modal").classList.remove("open");
  };
  document.getElementById("modal").addEventListener("click", function (e) {
    if (e.target.id === "modal") e.target.classList.remove("open");
  });
  document.getElementById("vprev").onclick = function () {
    if (vList.length) { vIdx = (vIdx - 1 + vList.length) % vList.length; updateViewer(); }
  };
  document.getElementById("vnext").onclick = function () {
    if (vList.length) { vIdx = (vIdx + 1) % vList.length; updateViewer(); }
  };
  document.getElementById("vclose").onclick = closeViewer;
  document.getElementById("vopen").onclick = function () {
    var cur = vList[vIdx];
    if (cur) window.open(cur.full, "_blank", "noopener");
  };
  document.getElementById("viewer").addEventListener("click", function (e) {
    if (e.target.id === "viewer") closeViewer();
  });
  document.addEventListener("keydown", function (e) {
    if (document.getElementById("viewer").classList.contains("open")) {
      if (e.key === "Escape") closeViewer();
      if (e.key === "ArrowLeft") document.getElementById("vprev").click();
      if (e.key === "ArrowRight") document.getElementById("vnext").click();
      return;
    }
    if (e.key === "Escape") document.getElementById("modal").classList.remove("open");
  });
  // One delegated handler for card and modal buttons: re-rendering a card no
  // longer needs its listeners re-attached.
  document.addEventListener("click", function (e) {
    var b = e.target.closest('[data-act="detail"]');
    if (b) { openDetail(b.dataset.gid); return; }
    var f = e.target.closest('[data-act="fetch"]');
    if (f) {
      var item = DATA.find(function (d) { return String(d.gid) === String(f.dataset.gid); });
      if (item) ensureVndb(item).then(function (v) { refreshCard(item.gid, v); });
      return;
    }
    var rf = e.target.closest('[data-act="refetch"]');
    if (rf) {
      var gid = String(rf.dataset.gid);
      var it = DATA.find(function (d) { return String(d.gid) === gid; });
      clearLive(gid);
      if (it) ensureVndb(it).then(function (v) { refreshCard(gid, v); openDetail(gid); });
    }
  });
}

wire();
applyFilter();

// Exposed for the build-time smoke test (test/gallery.smoke.test.js). The
// payloads use const, so they are not reachable as window properties; this is
// the one place tests can read them from.
window.GALLERY = {
  DATA: DATA, STORE: STORE, CACHE: CACHE,
  STATS: STATS, LIVE_KEY: LIVE_KEY, LIVE_BUDGET: LIVE_BUDGET,
  setTab: setTab, applyFilter: applyFilter, cardHtml: cardHtml, openDetail: openDetail,
  ADAPTERS: ADAPTERS, saveLive: saveLive, storeOf: storeOf,
  liveCache: liveCache, asked: asked,
  getTab: function () { return TAB; },
  getShown: function () { return shown; },
  dmmEntries: dmmEntries, dlEntry: dlEntry, gcEntry: gcEntry,
  relatedOf: relatedOf, seriesKey: seriesKey,
};
