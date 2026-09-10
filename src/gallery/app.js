// Gallery app v2 — full rewrite of the presentation layer on top of the same
// battle-tested engine: live VNDB matching queue, once-per-session meta
// probes, the store adapter table, and the section grow contract. The document
// stays one self-contained file (scripts/bundle.py inlines payloads, urls and
// this file), still double-clickable from file://.
//
// Layout of this file:
//   1. payload state + persisted ui prefs
//   2. live VNDB cache + matching queue      (engine, ported)
//   3. image slots + live meta probes        (engine, ported)
//   4. store accessors + adapter table       (logic ported, presentation new)
//   5. section builders (strip renderer + grow contract)
//   6. full-CG links + related strip
//   7. cards, filtering, rendering
//   8. detail drawer + grow patching
//   9. lightbox with thumbstrip
//  10. wiring

var liveCache = new Map(Object.entries(CACHE));
var pending = new Map();

// VNDB results the user fetched live, kept out of the baked CACHE so a rebuild
// stays authoritative. localStorage has a ~5MB quota and we serialize the whole
// map at once, so the budget is a byte count, not a row count.
var LIVE_KEY = "vndb_live_v4";
var LIVE_BUDGET = 900000;

// Drop live matches made by the old weak methods: "vn-core:" (contains-pick,
// first partial hit, no date check) and "release:" (primary could likewise be
// a contains-pick). They re-match under the fixed rules on next open; exact
// "vn:" hits stay exact under the tightened normalization, so they are kept.
function isWeakVia(e) {
  var via = e && typeof e.via === "string" ? e.via : "";
  return via.indexOf("vn-core:") === 0 || via.indexOf("release:") === 0;
}

try {
  var stored = JSON.parse(localStorage.getItem(LIVE_KEY) || "{}");
  var droppedWeak = 0;
  for (var sk in stored) {
    if (liveCache.has(sk) || !stored[sk]) continue;
    if (isWeakVia(stored[sk])) { droppedWeak++; continue; }
    liveCache.set(sk, stored[sk]);
  }
  if (droppedWeak) saveLive();
} catch (e) {
  // Corrupt or quota-truncated value: start clean rather than crash the page.
  try { localStorage.removeItem(LIVE_KEY); } catch (e2) {}
}

// Serialize, and if that no longer fits, drop the oldest live entries until it
// does. Eviction keeps the newest work; a truncated JSON would destroy the
// entire cache on next load, so size is checked, never sliced.
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
    var drop = Math.max(1, Math.ceil(kept.length * (1 - LIVE_BUDGET / s.length)));
    kept = kept.slice(drop);
  }
}

// Meta lookups that already ran this session. Repeated drawer opens are the
// main source of redundant /dm/meta and /gc/meta traffic, and each cold Worker
// lookup costs an upstream fetch plus a KV write.
var asked = new Set();
try { asked = new Set(JSON.parse(sessionStorage.getItem("meta_asked_v1") || "[]")); } catch (e) {}
function askOnce(key) {
  if (!key || asked.has(key)) return false;
  asked.add(key);
  try { sessionStorage.setItem("meta_asked_v1", JSON.stringify(Array.from(asked).slice(-4000))); } catch (e) {}
  return true;
}

// --- persisted ui prefs (one blob; legacy tag selection migrates in) ----------
var PREFS_KEY = "ui_v1";
var prefs = { sort: "rank", median: 0, tags: [] };
try {
  var savedPrefs = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  if (typeof savedPrefs.sort === "string") prefs.sort = savedPrefs.sort;
  if (typeof savedPrefs.median === "number") prefs.median = savedPrefs.median;
  if (typeof savedPrefs.view === "string") prefs.view = savedPrefs.view;
  if (Array.isArray(savedPrefs.tags)) {
    // Unknown names are dropped, not kept: an unknown selected tag would turn
    // into an empty tagSet and reject every game, blanking the grid.
    prefs.tags = savedPrefs.tags.filter(function (t) { return t && TAGS[t]; });
  }
  if (prefs.tags.length === 0) {
    // One-time migration from the v1 tag key so nobody's filters vanish.
    var legacyTags = JSON.parse(localStorage.getItem("tagfilter_v1") || "[]");
    if (Array.isArray(legacyTags)) prefs.tags = legacyTags.filter(function (t) { return t && TAGS[t]; });
  }
} catch (e) { /* corrupt prefs: defaults */ }

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* private mode */ }
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
  // Whitespace-insensitive: EGS writes " ～ " spaced, VNDB often "～" glued.
  return String(s == null ? "" : s).replace(/[～〜]/g, "~").replace(/　/g, " ").replace(/\s+/g, "");
}

function yearOf(s) {
  var m = /^(\d{4})/.exec(String(s == null ? "" : s));
  return m ? parseInt(m[1], 10) : 0;
}

// A missing year on either side means "no information", not disagreement.
// Tolerance is ±1 for Dec/Jan boundary releases.
function yearOk(cand, item) {
  if (!item) return true;
  var cy = yearOf(cand && cand.released);
  var iy = yearOf(item.sellday);
  if (!cy || !iy) return true;
  return Math.abs(cy - iy) <= 1;
}

function normVariants(title) {
  var out = [title];
  function push(x) {
    x = String(x == null ? "" : x).trim();
    if (x && out.indexOf(x) < 0 && out.length < 6) out.push(x);
  }
  push(String(title).replace(/[（(][^（）()]{0,30}[）)]\s*$/, "").trim());
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

function exactPick(list, queries, item) {
  // Same normalized title can still be two entries (original + same-titled
  // remake/port). Prefer the one whose release year agrees with the EGS
  // sellday; fall back to the first exact hit rather than a contains-guess.
  var fallback = null;
  for (var qi = 0; qi < queries.length; qi++) {
    var nq = normT(queries[qi]).toLowerCase();
    for (var ci = 0; ci < list.length; ci++) {
      var c = list[ci];
      if (normT(c.alttitle || "").toLowerCase() === nq ||
          normT(c.title || "").toLowerCase() === nq) {
        if (!fallback) fallback = c;
        if (yearOk(c, item)) return c;
      }
    }
  }
  return fallback;
}

// Short variants only match by containment, to keep 街ヤリ-style noise out.
// Containment alone grabs same-prefix different games, so candidates whose
// release year contradicts the EGS sellday are skipped.
function containsPick(list, core, item) {
  var nc = normT(core).toLowerCase();
  if (nc.length < 3) return null;
  for (var ci = 0; ci < list.length; ci++) {
    var c = list[ci];
    if (normT(c.alttitle || "").toLowerCase().indexOf(nc) < 0 &&
        normT(c.title || "").toLowerCase().indexOf(nc) < 0) continue;
    if (!yearOk(c, item)) continue;
    return c;
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
        var pick = exactPick(list, [item.name, v], item);
        if (pick) return remember(item.gid, toSlim(pick, null, null, "vn:" + v));
        if (v !== item.name) {
          pick = containsPick(list, v, item);
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
            var primary = exactPick(details, [item.name, v], item) || containsPick(details, v, item);
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

// --- escaping + image slots ----------------------------------------------------
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
  // so a 404 never stays on screen as a 裂图.
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
// Each adapter answers the same five questions for its view. Adding a store
// means adding an entry here, not touching the card or drawer renderers.
var ADAPTERS = {
  dlsite: {
    tab: "dlsite",
    navLabel: "DLsite",
    matchedLabel: "只看有DLsite",
    has: function (item, st) { return !!dlEntry(st); },
    cover: function (item, st) {
      var d = dlEntry(st);
      return d ? imgSlot(dlMainUrl(d), dlMainUrl(d), [dlMainThumbUrl(d)], "DLsite") : null;
    },
    sub: function (item, st) {
      var d = dlEntry(st);
      return d ? esc(d.id) : "无DLsite";
    },
    link: function (item, st) {
      var d = dlEntry(st);
      return d ? { href: dlProductUrl(d.id, d.d), text: "DLsite" } : { href: vnSearchUrl(item.name), text: "DLsite" };
    },
    sections: function (item, st) {
      var d = dlEntry(st);
      if (!d) return [hintSection("EGS无DLsite ID。")];
      return [dlSection(d, "DLsite")];
    },
  },

  dmm: {
    tab: "dmm",
    navLabel: "FANZA",
    matchedLabel: "只看有FANZA",
    has: function (item, st) { return dmmEntries(st).length > 0; },
    cover: function (item, st) {
      var es = dmmEntries(st);
      if (!es.length) return null;
      var fb = es.map(function (e) { return dmmPkgUrl(e.id); });
      return imgSlot(dmmPkgThumb(es[0].id), fb[0], fb.slice(1), "FANZA");
    },
    sub: function (item, st) {
      var es = dmmEntries(st);
      return es.length ? esc(es.map(function (e) { return e.id + "(" + dmmFloorLabel(e.id) + ")"; }).join(" / ")) : "无FANZA";
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
    matchedLabel: "只看Getchu收录",
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
    link: function (item, st) {
      var g = gcEntry(st);
      return { href: g ? gcProductUrl(g.id) : vnSearchUrl(item.name), text: "Getchu" };
    },
    sections: function (item, st) { return [gcSection(item, st)]; },
  },

  vndb: {
    tab: "vndb",
    navLabel: "VNDB",
    matchedLabel: "只看已匹配VNDB",
    has: function (item, st, v) { return !!v; },
    cover: function (item, st, v) {
      if (!v || !v.img) return null;
      return imgSlot(vnThumb(v.img), v.img, [vnThumb(v.img)], "cover");
    },
    sub: function (item, st, v) {
      if (!v) return "未匹配";
      return esc(v.title || "") + (v.alttitle ? " / " + esc(v.alttitle) : "");
    },
    link: function (item, st, v) {
      return v ? { href: vnUrl(v.id), text: "VNDB" } : { href: vnSearchUrl(item.name), text: "VNDB搜索" };
    },
    sections: function (item, st, v) { return [vnSection(item, v)]; },
  },

  all: {
    tab: "all",
    navLabel: "综合",
    matchedLabel: "只看有图",
    has: function (item, st, v) {
      return !!v || !!dlEntry(st) || dmmEntries(st).length > 0;
    },
    cover: function (item, st, v) {
      // Quality order: FANZA package > Getchu official > EGS mirror > VNDB > DLsite.
      var es = dmmEntries(st);
      var d = dlEntry(st);
      var g = gcEntry(st);
      var egs = egsImg(item.gid, 1);
      var vn = v && v.img ? v.img : null;
      if (es.length) {
        var src = dmmPkgUrl(es[0].id);
        return imgSlot(dmmPkgThumb(es[0].id), src, [egs, vn, d ? dlMainUrl(d) : null], "cover");
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
// { title, hint?, cover, slots, link?, key?, grow? }
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
    cover: imgSlot(dmmPkgThumb(e.id), dmmPkgUrl(e.id), fb, "包图 " + fl + " " + e.id),
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
  // 0 = confirmed "no samples". Both cases need no live probe.
  var known = g && typeof g.n === "number";
  var baked = known ? Math.min(g.n, GETCHU_SAMPLE_CAP) : 0;
  var i;
  if (USE_GC && cid && baked > 0) {
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
  // Unknown count starts empty and the probe fills the grid in place.
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

// --- full-CG external links ----------------------------------------------------
function fullcgOf(gid) { return FULLCG[String(gid)] || null; }

function fullcgGoogle(site, name, alt) {
  var q = 'site:' + site + ' "' + name + '"';
  if (alt && alt !== name) q += ' OR "' + alt + '"';
  if (site.indexOf("hitomi") === 0) q = "gamecg " + q;
  return "https://www.google.com/search?q=" + encodeURIComponent(q);
}

// Curated brand_group.json (JP brands via VNDB producer names) wins; ASCII
// brands fall back to a naive slug.
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
  return '<a class="gbtn" href="' + attr(href) + '" target="_blank" rel="noopener">' + text + "</a>";
}

function fullcgHtml(item, alt) {
  var e = fullcgOf(item.gid);
  var direct = [];
  if (e && e.hitomi) direct.push(extLink(e.hitomi, "hitomi全CG直连"));
  if (e && e.ehentai) direct.push(extLink(e.ehentai, "e-hentai全CG直连"));
  var g = groupFor(item.brand);
  var keys = alt && alt !== item.name ? esc(item.name) + " / " + esc(alt) : esc(item.name);
  return "<h3>全CG（站外）</h3>" +
    (direct.length ? '<p class="links">已核实：' + direct.join(" | ") + "</p>" : "") +
    '<p class="links">' + [
      extLink(hitomiSiteUrl(item, alt), "hitomi站内搜" + (g ? "(group:" + esc(g) + ")" : "(标题)")),
      extLink(ehSiteUrl(item, alt), "e-hentai站内搜" + (g ? "(group:" + esc(g) + "$)" : "(标题)")),
      extLink(fullcgGoogle("hitomi.la", item.name, alt), "Google搜hitomi全CG"),
      extLink(fullcgGoogle("e-hentai.org", item.name, alt), "Google搜e-hentai全CG"),
    ].join(" | ") + "</p>" +
    '<p class="hint">站内搜关键词：' + keys +
    (g ? "＋品牌group:" + esc(g) : "（该品牌暂无group映射，只用标题搜）") +
    "。先用本页官方截图核对是否为同一作，全CG图不在本画廊内展示，对方站内需各自过年龄确认/登录。</p>";
}

// --- related recommendations ----------------------------------------------------
// Deterministic, data-local, no new payload: same brand (+100) and same series
// (+60, title-core match including VNDB alt titles), tie-broken by median
// closeness then rank. Rendered as a horizontal strip that jumps straight into
// that game's drawer.
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
  return out.slice(0, 8);
}

function relCardHtml(r) {
  var d = r.d;
  var cov = ADAPTERS.all.cover(d, storeOf(d.gid), liveCache.get(d.gid) || null);
  var thumb = cov
    ? slotHtml(cov).replace("<img ", '<img class="relimg" ')
    : '<span class="relnocover">暂无封面</span>';
  var tag = (r.sameBrand ? "同社" : "") + (r.sameBrand && r.sameSeries ? "·" : "") + (r.sameSeries ? "同系列" : "");
  return '<button class="relcard" data-act="detail" data-gid="' + attr(d.gid) + '">' +
    thumb +
    '<span class="relname">#' + d.rank + " " + esc(d.name) + "</span>" +
    '<span class="relmeta">' + esc(tag + " " + d.brand) + " · 中值" + d.median + "</span></button>";
}

// --- state ----------------------------------------------------------------------
var TAB = "all";
// file:// has no same-origin /gc|/dm|/dl backend, so fall back to direct EGS.
var USE_GC = location.protocol === "http:" || location.protocol === "https:";
var API = "https://api.vndb.org/kana/vn";
var PAGE = 36;
var filtered = DATA.slice();
var shown = 0;

var SORTS = {
  rank: null, // keep the EGS ranking order the payload ships in
  median: function (a, b) { return (b.median || 0) - (a.median || 0) || a.rank - b.rank; },
  count2: function (a, b) { return (b.count2 || 0) - (a.count2 || 0) || a.rank - b.rank; },
  sellday: function (a, b) {
    return String(b.sellday || "").localeCompare(String(a.sellday || "")) || a.rank - b.rank;
  },
};

// Coverage numbers for the stats line, counted from the payloads themselves.
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

// --- cards -----------------------------------------------------------------------
function storeDotsHtml(st, v) {
  var dots = [
    ["D", !!dlEntry(st), "DLsite"],
    ["F", dmmEntries(st).length > 0, "FANZA"],
    ["G", !!gcEntry(st), "Getchu"],
    ["V", !!v, "VNDB"],
  ];
  return '<span class="storedots">' + dots.map(function (dot) {
    return '<span class="sdot' + (dot[1] ? " on" : "") + '" title="' + dot[2] + '">' + dot[0] + "</span>";
  }).join("") + "</span>";
}

function cardHtml(item, v) {
  var a = adapter();
  var st = storeOf(item.gid);
  var cover = a.cover(item, st, v);
  var isGalleryView = TAB === "vndb" || TAB === "all";
  var coverHtml = cover
    ? '<img loading="lazy" decoding="async" src="' + attr(cover.thumb) + '"' +
      (cover.fb.length ? ' data-fb="' + attr(cover.fb.join("|")) + '"' : "") +
      ' data-full="' + attr(cover.full) + '"' +
      ' onerror="chainErr(this)"' + ' alt="cover">'
    : '<div class="novndb">' + (isGalleryView
      ? "暂无图片<br>滚进视口自动匹配 VNDB"
      : "EGS无该商店ID") + "</div>";
  var manual = (isGalleryView && !v && !liveCache.has(item.gid))
    ? '<button class="loadbtn" data-act="fetch" data-gid="' + attr(item.gid) + '">匹配VNDB</button>'
    : "";
  var itemTags = tagsOf(item.gid);
  var tagsHtml = itemTags.length
    ? ' <span class="cardtag" title="EGS注册标签">' + itemTags.map(esc).join("・") + "</span>"
    : "";
  var link = a.link(item, st, v);
  return '<div class="cover">' + coverHtml + '<div class="scrim"></div>' +
      '<span class="rank">#' + item.rank + "</span>" +
      (item.median ? '<span class="medpill" title="中央值">' + item.median + "</span>" : "") +
      storeDotsHtml(st, v) + manual + "</div>" +
    '<div class="cmeta"><h3 class="ctitle">' + esc(item.name) + "</h3>" +
      '<p class="csub">' + esc(item.brand) + " · " + esc(item.sellday) + "</p>" +
      '<p class="cline"><span>中央值 ' + (item.median || "–") + "</span><span>评分 " + item.count2 + "</span><span>POV " + item.votes + "票</span>" + tagsHtml + "</p>" +
      '<div class="cacts">' + extLink(link.href, link.text) + extLink(egsUrl(item.gid), "EGS") + "</div>" +
    "</div>";
}

// Full card element. cardInner (above) is what refreshCard swaps in place, so
// the observed wrapper and its listeners survive the swap.
function cardEl(item, v) {
  return '<article class="card" data-gid="' + attr(item.gid) + '">' + cardHtml(item, v) + "</article>";
}

// --- filtering --------------------------------------------------------------------
var TAGSEL = prefs.tags;

function tagSet(t) {
  tagSetCache[t] = tagSetCache[t] || new Set(TAGS[t] || []);
  return tagSetCache[t];
}
var tagSetCache = {};

var tagsOfCache = {};
function tagsOf(gid) {
  var k = String(gid);
  if (tagsOfCache[k] === undefined) {
    tagsOfCache[k] = Object.keys(TAGS).filter(function (t) { return tagSet(t).has(k); });
  }
  return tagsOfCache[k];
}

function toggleTag(t) {
  if (!TAGS[t]) return;
  var i = TAGSEL.indexOf(t);
  if (i >= 0) TAGSEL.splice(i, 1); else TAGSEL.push(t);
  prefs.tags = TAGSEL;
  savePrefs();
  renderTagbar();
  applyFilter();
}

function renderTagbar() {
  var row = document.getElementById("tagrow");
  var box = document.getElementById("tagchips");
  if (!row || !box) return;
  var keys = Object.keys(TAGS);
  if (!keys.length) { row.hidden = true; box.innerHTML = ""; return; }
  row.hidden = false;
  box.innerHTML = keys.map(function (t) {
    return '<button class="tagchip' + (TAGSEL.indexOf(t) >= 0 ? " on" : "") +
      '" data-tag="' + attr(t) + '" title="与其它选中标签及搜索条件同时满足（AND）">' +
      esc(t) + '<span class="tagcount">' + tagSet(t).size + "</span></button>";
  }).join("");
}

function applyFilter() {
  var q = document.getElementById("q").value.trim().toLowerCase();
  var om = document.getElementById("onlyMatched").checked;
  var a = adapter();
  var sortFn = SORTS[prefs.sort] || SORTS.rank;
  filtered = DATA.filter(function (d) {
    if ((d.median || 0) < prefs.median) return false;
    var v = liveCache.get(d.gid) || null;
    if (om && !a.has(d, storeOf(d.gid), v)) return false;
    for (var ti = 0; ti < TAGSEL.length; ti++) {
      if (!tagSet(TAGSEL[ti]).has(d.gid)) return false;
    }
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
  if (sortFn) filtered = filtered.slice().sort(sortFn);
  shown = 0;
  document.getElementById("grid").innerHTML = "";
  renderMore();
}

function renderMore() {
  var grid = document.getElementById("grid");
  var slice = filtered.slice(shown, shown + PAGE);
  slice.forEach(function (item) {
    var div = document.createElement("div");
    div.className = "cardwrap";
    div.dataset.gid = String(item.gid);
    div.innerHTML = cardEl(item, liveCache.get(item.gid) || null);
    grid.appendChild(div);
    bindCard(div.firstElementChild, item);
    // The wrapper is the observed element: swapping the card's innerHTML on a
    // late VNDB match keeps the observer attached (an outerHTML swap would
    // detach it and silently stop auto-matching for that card).
    getObserver().observe(div);
  });
  shown += slice.length;
  document.getElementById("stats").innerHTML =
    "共 <b>" + filtered.length + "</b> / " + DATA.length + " 个（EROGE限定）" +
    " · VNDB预取" + STATS.vn_prefetch + "/匹配" + STATS.vn_hit +
    " · DLsite覆盖" + STATS.dl + " · FANZA覆盖" + STATS.dm + " · Getchu覆盖" + STATS.gc +
    (TAGSEL.length ? " · 标签AND：" + TAGSEL.map(esc).join("+") : "") +
    " · 视图：" + ADAPTERS[TAB].navLabel +
    " · 已显示 <b>" + shown + "</b> 个";
  document.getElementById("more").style.display = shown >= filtered.length ? "none" : "inline-block";
}

function refreshCard(gid, v) {
  var wrap = document.querySelector('.cardwrap[data-gid="' + CSS.escape(String(gid)) + '"]');
  if (!wrap) return;
  var item = DATA.find(function (d) { return String(d.gid) === String(gid); });
  if (!item) return;
  var card = wrap.firstElementChild;
  card.innerHTML = cardHtml(item, v || null);
  bindCard(card, item);
}

function bindCard(card, item) {
  card.addEventListener("click", function (e) {
    if (e.target.closest('[data-act="fetch"]')) return;
    if (e.target.closest("a")) return;
    openDetail(item.gid);
  });
  var fb = card.querySelector('[data-act="fetch"]');
  if (fb) {
    fb.addEventListener("click", function (e) {
      e.stopPropagation();
      ensureVndb(item).then(function (v) { refreshCard(item.gid, v); });
    });
  }
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
// without IntersectionObserver keep working via click.
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

// --- detail drawer ---------------------------------------------------------------
var growTargets = [];

function renderDetail(item, sections) {
  var viewList = [];
  var v = liveCache.get(item.gid) || null;
  var st = storeOf(item.gid);
  var itemTags = tagsOf(item.gid);
  growTargets = [];

  document.getElementById("dhead").innerHTML =
    "<h2>#" + item.rank + " " + esc(item.name) + "</h2>" +
    '<p class="hint">' + esc(item.brand) + " / " + esc(item.sellday) +
    " / 中央值 " + (item.median || "–") + " / 评分 " + item.count2 + " / POV " + item.votes + "票" +
    (itemTags.length ? " · 注册标签 " + itemTags.map(esc).join("、") : "") +
    (v ? "<br>VNDB: " + esc(v.title || "") + (v.alttitle ? " / " + esc(v.alttitle) : "") +
      " / " + esc(v.id || "") + (v.via ? " · " + esc(v.via) : "") : "") + "</p>";

  var html = "";
  sections.forEach(function (sec, si) {
    if (!sec) return;
    if (sec.title) html += '<h3 id="dsec-h-' + si + '">' + sec.title + "</h3>";
    if (sec.hint) {
      html += '<p class="hint">' + sec.hint + "</p>";
      if (sec.link) html += '<p class="links">' + extLink(sec.link.href, sec.link.text) + "</p>";
      return;
    }
    var from = viewList.length;
    var tiles = [];
    if (sec.cover) {
      viewList.push(sec.cover);
      tiles.push(slotHtml(sec.cover).replace("<img ", '<img class="big" '));
    }
    sec.slots.forEach(function (s) { viewList.push(s); tiles.push(slotHtml(s)); });
    html += '<div class="strip" id="dsec-' + si + '">' + tiles.join("") + "</div>";
    if (sec.grow) {
      growTargets.push({ si: si, from: from, count: sec.slots.length, grow: sec.grow, key: sec.key || "dsec" + si, cover: sec.cover || null, slots: sec.slots.slice() });
    }
    if (sec.link) html += '<p class="links">' + extLink(sec.link.href, sec.link.text) + "</p>";
  });

  var rel = relatedOf(item, v);
  html += "<h3>相关推荐（同社 / 同系列）</h3>";
  html += rel.length
    ? '<div class="relstrip">' + rel.map(relCardHtml).join("") + "</div>"
    : '<p class="hint">暂无同社/系列作收录。</p>';
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
  html += '<p class="links">' + links.map(function (l) { return extLink(l.href, l.text); }).join(" | ");
  if (TAB === "vndb" || TAB === "all") {
    html += ' | <button class="gbtn" data-act="refetch" data-gid="' + attr(item.gid) + '">重查VNDB</button>';
  }
  html += "</p>";

  document.getElementById("dbody").innerHTML = html;
  document.getElementById("drawer").classList.add("open");
  document.getElementById("drawer").setAttribute("aria-hidden", "false");
  document.body.classList.add("locked");
  document.querySelectorAll("#dbody img").forEach(function (im) {
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
    var grid = document.getElementById("dsec-" + t.si);
    var heading = document.getElementById("dsec-h-" + t.si);
    t.grow().then(function (res) {
      if (!res) return;
      if (res.title && heading) heading.textContent = res.title;
      if (res.cover) {
        var oldCover = grid ? grid.querySelector("img.big") : null;
        var coverHtml = slotHtml(res.cover).replace("<img ", '<img class="big" ');
        var cidx = -1;
        if (t.cover && t.cover.full) {
          for (var vi = 0; vi < viewList.length; vi++) {
            if (viewList[vi].full === t.cover.full) { cidx = vi; break; }
          }
        }
        if (cidx >= 0) viewList[cidx] = res.cover; else viewList.push(res.cover);
        if (oldCover) oldCover.outerHTML = coverHtml;
        else if (grid) grid.insertAdjacentHTML("afterbegin", coverHtml);
      }
      var extra = res.slots || res;
      if (!extra.length || !grid) return;
      if (res.replace) {
        // Swap out the guessed tail in the DOM and the viewer list together, so
        // clicking any tile still lands on the right image. Removal is by URL:
        // other sections may have appended to viewList since.
        var at = res.at || 0;
        var oldUrls = (t.slots || []).slice(at).map(function (s) { return s.full; });
        for (var vi2 = viewList.length - 1; vi2 >= 0; vi2--) {
          if (oldUrls.indexOf(viewList[vi2].full) >= 0) viewList.splice(vi2, 1);
        }
        var imgs = grid.querySelectorAll("img:not(.big)");
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
        im.addEventListener("click", function () { openViewer(viewList, viewIdx(viewList, im)); });
      });
      var heading2 = document.getElementById("dsec-h-" + t.si);
      if (heading2) {
        heading2.innerHTML = heading2.innerHTML.replace(/<span data-livecount>\d+<\/span>/,
          '<span data-livecount>' + grid.querySelectorAll("img:not(.big)").length + "</span>");
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
  growSections(renderDetail(item, sections));
}

function closeDrawer() {
  document.getElementById("drawer").classList.remove("open");
  document.getElementById("drawer").setAttribute("aria-hidden", "true");
  document.body.classList.remove("locked");
}

// --- lightbox -----------------------------------------------------------------------
var vList = [];
var vIdx = 0;
// Monotonic token: rapid prev/next clicks each start a load, and only the
// latest one's callbacks may touch the UI.
var vToken = 0;

function openViewer(list, idx) {
  vList = list;
  vIdx = idx || 0;
  buildThumbs();
  updateViewer();
  var lb = document.getElementById("lightbox");
  lb.classList.add("open");
  lb.setAttribute("aria-hidden", "false");
  document.body.classList.add("locked");
}

function buildThumbs() {
  var strip = document.getElementById("vthumbs");
  if (!strip) return;
  strip.innerHTML = vList.map(function (it, i) {
    return '<button data-vi="' + i + '" title="' + attr(it.label || "") + '">' +
      '<img loading="lazy" decoding="async" src="' + attr(it.thumb) + '" alt=""></button>';
  }).join("");
}

function updateViewer() {
  var cur = vList[vIdx];
  if (!cur) return;
  var img = document.getElementById("vimg");
  var spin = document.getElementById("vspin");
  var my = ++vToken;
  document.getElementById("vcap").textContent =
    (vIdx + 1) + " / " + vList.length + " " + (cur.label || "");
  img.classList.add("loading");
  var strip = document.getElementById("vthumbs");
  if (strip) {
    strip.querySelectorAll("button").forEach(function (b) {
      var curBtn = +b.dataset.vi === vIdx;
      b.classList.toggle("cur", curBtn);
      if (curBtn && b.scrollIntoView) try { b.scrollIntoView({ block: "nearest", inline: "center" }); } catch (e) {}
    });
  }
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

// Warm the neighbours' full-size files so rapid prev/next usually hits cache.
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
  var lb = document.getElementById("lightbox");
  lb.classList.remove("open");
  lb.setAttribute("aria-hidden", "true");
  var img = document.getElementById("vimg");
  img.classList.remove("loading");
  var spin = document.getElementById("vspin");
  if (spin) spin.classList.remove("on");
  img.removeAttribute("src");
  if (!document.getElementById("drawer").classList.contains("open")) {
    document.body.classList.remove("locked");
  }
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

// --- wiring --------------------------------------------------------------------------
function setTab(t) {
  TAB = t;
  document.querySelectorAll("#views .vtab").forEach(function (b) {
    b.classList.toggle("on", b.dataset.view === t);
  });
  document.getElementById("grid").dataset.view = t;
  var label = document.getElementById("onlyMatchedLabel");
  if (label) label.textContent = ADAPTERS[t].matchedLabel;
  prefs.view = t;
  savePrefs();
  applyFilter();
}

var DENSITIES = [["auto", "密度：自动"], ["density-compact", "密度：紧凑"], ["density-large", "密度：大图"]];

function setDensity(i) {
  var grid = document.getElementById("grid");
  grid.classList.remove("density-compact", "density-large");
  if (DENSITIES[i % DENSITIES.length][0] !== "auto") grid.classList.add(DENSITIES[i % DENSITIES.length][0]);
  document.getElementById("density").textContent = DENSITIES[i % DENSITIES.length][1];
  try { localStorage.setItem("density", DENSITIES[i % DENSITIES.length][0]); } catch (e) {}
}

function wire() {
  document.querySelectorAll("#views .vtab").forEach(function (b) {
    b.onclick = function () { setTab(b.dataset.view); };
  });
  document.getElementById("brand").onclick = function (e) {
    e.preventDefault();
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e2) { window.scrollTo(0, 0); }
  };
  var dBtn = document.getElementById("density");
  var dIdx = 0;
  try { dIdx = Math.max(0, DENSITIES.findIndex(function (x) { return x[0] === localStorage.getItem("density"); })); } catch (e) {}
  setDensity(dIdx);
  dBtn.onclick = function () { dIdx = (dIdx + 1) % DENSITIES.length; setDensity(dIdx); };

  var sortSel = document.getElementById("sort");
  sortSel.value = prefs.sort;
  sortSel.onchange = function () {
    prefs.sort = sortSel.value;
    savePrefs();
    applyFilter();
  };
  document.getElementById("medchips").addEventListener("click", function (e) {
    var chip = e.target.closest(".fchip");
    if (!chip) return;
    prefs.median = +chip.dataset.med || 0;
    savePrefs();
    document.querySelectorAll("#medchips .fchip").forEach(function (c) {
      c.classList.toggle("on", c === chip);
    });
    applyFilter();
  });
  document.getElementById("tagrow").addEventListener("click", function (e) {
    var chip = e.target.closest(".tagchip");
    if (chip) toggleTag(chip.getAttribute("data-tag"));
  });
  document.getElementById("q").oninput = applyFilter;
  document.getElementById("onlyMatched").onchange = applyFilter;
  document.getElementById("reset").onclick = function () {
    document.getElementById("q").value = "";
    prefs.median = 0;
    prefs.sort = "rank";
    sortSel.value = "rank";
    TAGSEL.length = 0;
    prefs.tags = TAGSEL;
    document.getElementById("onlyMatched").checked = false;
    document.querySelectorAll("#medchips .fchip").forEach(function (c) {
      c.classList.toggle("on", c.dataset.med === "0");
    });
    savePrefs();
    renderTagbar();
    applyFilter();
  };
  document.getElementById("more").onclick = renderMore;
  getMoreObserver();
  document.getElementById("dclose").onclick = closeDrawer;
  document.getElementById("drawer").addEventListener("click", function (e) {
    if (e.target.dataset && e.target.dataset.act === "drawer-close") closeDrawer();
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
  document.getElementById("vthumbs").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-vi]");
    if (b) { vIdx = +b.dataset.vi; updateViewer(); }
  });
  document.addEventListener("keydown", function (e) {
    if (document.getElementById("lightbox").classList.contains("open")) {
      if (e.key === "Escape") closeViewer();
      if (e.key === "ArrowLeft") document.getElementById("vprev").click();
      if (e.key === "ArrowRight") document.getElementById("vnext").click();
      return;
    }
    if (e.key === "Escape" && document.getElementById("drawer").classList.contains("open")) {
      closeDrawer();
      return;
    }
    if (e.key === "/" && document.activeElement &&
        !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      document.getElementById("q").focus();
    }
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

function clearLive(gid) {
  liveCache.delete(gid);
  pending.delete(gid);
  saveLive();
}

function boot() {
  if (!SORTS[prefs.sort]) prefs.sort = "rank";
  if (!ADAPTERS[prefs.view]) prefs.view = "all";
  var sortSel = document.getElementById("sort");
  sortSel.value = prefs.sort;
  document.getElementById("q").value = "";
  wire();
  renderTagbar();
  setTab(prefs.view);
}

// Exposed for the build-time smoke test (test/gallery.smoke.test.js). The
// payloads use const, so they are not reachable as window properties; this is
// the one place tests can read them from.
window.GALLERY = {
  DATA: DATA, STORE: STORE, CACHE: CACHE,
  STATS: STATS, LIVE_KEY: LIVE_KEY, LIVE_BUDGET: LIVE_BUDGET,
  setTab: setTab, applyFilter: applyFilter, cardHtml: cardHtml, cardEl: cardEl, openDetail: openDetail,
  ADAPTERS: ADAPTERS, saveLive: saveLive, storeOf: storeOf,
  liveCache: liveCache, asked: asked,
  TAGS: TAGS, tagSet: tagSet, tagsOf: tagsOf, toggleTag: toggleTag, renderTagbar: renderTagbar,
  getTagSel: function () { return TAGSEL.slice(); },
  getTab: function () { return TAB; },
  getShown: function () { return shown; },
  dmmEntries: dmmEntries, dlEntry: dlEntry, gcEntry: gcEntry,
  relatedOf: relatedOf, seriesKey: seriesKey,
  normT: normT, normVariants: normVariants, exactPick: exactPick, containsPick: containsPick,
};

boot();
