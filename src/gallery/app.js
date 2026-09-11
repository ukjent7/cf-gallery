// PROJECT AURA // NOCTURNE VAULT (夜幕缪斯档案馆)
// CF-Gallery Client Application & Telemetry Engine v2.0

var USE_GC = typeof window !== "undefined" && window.location && window.location.protocol !== "file:";

(function () {
  "use strict";

  // Global Datasets & Fallbacks
  var _DATA = typeof DATA !== "undefined" ? DATA : [];
  var _STORE = typeof STORE !== "undefined" ? STORE : {};
  var _CACHE = typeof CACHE !== "undefined" ? CACHE : {};
  var _TAGS = typeof TAGS !== "undefined" ? TAGS : {};
  var _FULLCG = typeof FULLCG !== "undefined" ? FULLCG : {};
  var _BRANDG = typeof BRANDG !== "undefined" ? BRANDG : {};

  var PAGE_SIZE = 36;
  var LIVE_KEY = "vndb_live_v4";
  var LIVE_BUDGET = 900000;

  // --- Live Cache Storage & Eviction ---
  var liveCache = new Map();

  // Seed baked CACHE
  for (var cKey of Object.keys(_CACHE)) {
    if (_CACHE[cKey]) liveCache.set(String(cKey), _CACHE[cKey]);
  }

  // Restore and migrate localStorage
  try {
    var rawLive = typeof localStorage !== "undefined" ? localStorage.getItem(LIVE_KEY) : null;
    if (rawLive) {
      var parsedLive = JSON.parse(rawLive);
      if (parsedLive && typeof parsedLive === "object") {
        for (var pKey of Object.keys(parsedLive)) {
          var entry = parsedLive[pKey];
          if (!entry) continue;
          // Migration guard: weak matches must be dropped
          if (entry.via && (entry.via.indexOf("vn-core:") === 0 || entry.via.indexOf("release:") === 0)) {
            continue;
          }
          liveCache.set(String(pKey), entry);
        }
      }
    }
  } catch (e) {
    if (typeof localStorage !== "undefined") {
      try { localStorage.removeItem(LIVE_KEY); } catch (_) {}
    }
  }

  function saveLive() {
    if (typeof localStorage === "undefined") return;
    var obj = {};
    for (var [k, v] of liveCache.entries()) {
      obj[k] = v;
    }
    var str = JSON.stringify(obj);
    if (str.length > LIVE_BUDGET) {
      var keys = Object.keys(obj);
      while (str.length > LIVE_BUDGET && keys.length > 0) {
        var evict = keys.shift();
        delete obj[evict];
        str = JSON.stringify(obj);
      }
    }
    try {
      localStorage.setItem(LIVE_KEY, str);
    } catch (err) {
      console.warn("saveLive warning:", err);
    }
  }

  // --- Normalization & Matching Algorithms ---
  function normStr(s) {
    if (!s) return "";
    return String(s)
      .replace(/[\s\u3000]*[~～〜-][\s\u3000]*/g, "~")
      .trim()
      .toLowerCase();
  }

  function exactPick(candidates, titles, item) {
    if (!candidates || !candidates.length || !titles || !titles.length) return null;
    var targetNorms = titles.map(normStr);
    var matched = [];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var cT = normStr(c.title);
      var cA = normStr(c.alttitle);
      if (targetNorms.indexOf(cT) >= 0 || (c.alttitle && targetNorms.indexOf(cA) >= 0)) {
        matched.push(c);
      }
    }
    if (!matched.length) return null;
    if (matched.length === 1) return matched[0];
    if (item && item.sellday) {
      var y = item.sellday.slice(0, 4);
      var yMatch = matched.find(function (c) { return c.released && c.released.indexOf(y) === 0; });
      if (yMatch) return yMatch;
    }
    return matched[0];
  }

  function containsPick(candidates, coreTitle, item) {
    if (!candidates || !candidates.length || !coreTitle) return null;
    var q = normStr(coreTitle);
    var matched = [];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var cT = normStr(c.title);
      var cA = normStr(c.alttitle);
      if (cT.indexOf(q) >= 0 || (c.alttitle && cA.indexOf(q) >= 0)) {
        matched.push(c);
      }
    }
    if (!matched.length) return null;
    if (item && item.sellday) {
      var y = item.sellday.slice(0, 4);
      var yMatch = matched.find(function (c) { return c.released && c.released.indexOf(y) === 0; });
      if (yMatch) return yMatch;
    }
    return matched[0];
  }

  // --- Entity Lookup Helpers ---
  function storeOf(gid) {
    return _STORE[String(gid)] || null;
  }

  function dlEntry(st) {
    return st && st.l ? st.l : null;
  }

  function dmmEntries(st) {
    var out = [];
    if (st) {
      if (st.m) out.push(st.m);
      if (st.m2) out.push(st.m2);
    }
    return out;
  }

  function gcEntry(st) {
    return st && st.g ? st.g : null;
  }

  function tagsOf(gid) {
    var sid = String(gid);
    var res = [];
    for (var tag of Object.keys(_TAGS)) {
      if (_TAGS[tag].indexOf(sid) >= 0) {
        res.push(tag);
      }
    }
    return res;
  }

  function relatedOf(item, vndbItem) {
    if (!item || !item.brand) return [];
    var bg = _BRANDG[item.brand] || item.brand;
    var rel = [];
    var sid = String(item.gid);
    for (var i = 0; i < _DATA.length; i++) {
      var d = _DATA[i];
      if (String(d.gid) === sid) continue;
      var dbg = _BRANDG[d.brand] || d.brand;
      if (dbg === bg) {
        rel.push(d);
        if (rel.length >= 8) break;
      }
    }
    return rel;
  }

  // --- Multi-Source Adapters ---
  var ADAPTERS = {
    all: {
      navLabel: "综合",
      matchedLabel: "只看有图",
      has: function (item, st, v) {
        var hasVndb = Boolean(v && (v.img || (v.shots && v.shots.length)));
        var hasStore = Boolean(st && (st.l || st.m || st.m2 || st.g));
        return hasVndb || hasStore;
      }
    },
    vndb: {
      navLabel: "VNDB",
      matchedLabel: "只看已匹配",
      has: function (item, st, v) {
        return Boolean(v && (v.img || (v.shots && v.shots.length)));
      }
    },
    dlsite: {
      navLabel: "DLsite",
      matchedLabel: "只看DLsite",
      has: function (item, st, v) {
        return Boolean(st && st.l);
      }
    },
    dmm: {
      navLabel: "FANZA",
      matchedLabel: "只看FANZA",
      has: function (item, st, v) {
        return Boolean(st && (st.m || st.m2));
      }
    },
    getchu: {
      navLabel: "Getchu",
      matchedLabel: "只看Getchu",
      has: function (item, st, v) {
        return Boolean(st && st.g);
      }
    }
  };

  // --- State Variables ---
  var currentTab = "all";
  var currentSort = "rank";
  var currentDensity = 0; // 0: auto, 1: compact, 2: large
  var currentMode = "A"; // A: Stream, B: Split, C: Runway
  var minMed = 0;
  var tagSel = [];
  var onlyMatched = false;
  var searchQuery = "";
  var renderCount = PAGE_SIZE;
  var filteredData = [];
  var sessionMetaCache = new Set();
  var isSafeMode = false;
  var isBossMode = false;
  var origDocTitle = typeof document !== "undefined" ? document.title : "";
  var audioEnabled = true;
  var audioCtx = null;
  var focusedCardIndex = 0;

  // Lightbox State
  var lbImages = [];
  var lbIndex = 0;
  var lbCurrentItem = null;

  // --- Sound Effects Synthesis ---
  function playBeep(freq, type, dur) {
    if (!audioEnabled || typeof window === "undefined") return;
    try {
      if (!audioCtx) {
        var AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) audioCtx = new AudioContext();
      }
      if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume();
      }
      if (!audioCtx) return;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = type || "sine";
      osc.frequency.setValueAtTime(freq || 440, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.03, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + (dur || 0.05));
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + (dur || 0.05));
    } catch (_) {}
  }

  // --- UI State Restoration ---
  try {
    var rawUi = typeof localStorage !== "undefined" ? localStorage.getItem("ui_v1") : null;
    if (rawUi) {
      var parsedUi = JSON.parse(rawUi);
      if (parsedUi && Array.isArray(parsedUi.tags)) {
        tagSel = parsedUi.tags.filter(function (t) { return t in _TAGS; });
      }
    }
  } catch (_) {
    tagSel = [];
  }

  function persistTags() {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem("ui_v1", JSON.stringify({ tags: tagSel }));
    } catch (_) {}
  }

  // --- Filtering & Sorting Pipeline ---
  function applyFilter() {
    var adapter = ADAPTERS[currentTab];
    var q = normStr(searchQuery);

    filteredData = _DATA.filter(function (item) {
      var gid = String(item.gid);
      var st = storeOf(gid);
      var v = liveCache.get(gid) || null;

      // Only Matched Checkbox
      if (onlyMatched) {
        if (!adapter.has(item, st, v)) return false;
      }

      // Median Score Tier Filter
      if (minMed > 0 && (item.median || 0) < minMed) {
        return false;
      }

      // Tag Constellation (AND Intersection)
      if (tagSel.length > 0) {
        for (var i = 0; i < tagSel.length; i++) {
          var tList = _TAGS[tagSel[i]];
          if (!tList || tList.indexOf(gid) < 0) return false;
        }
      }

      // Omni Search Query
      if (q) {
        var matchTitle = normStr(item.name).indexOf(q) >= 0;
        var matchBrand = normStr(item.brand).indexOf(q) >= 0;
        var matchGid = gid === q;
        if (!matchTitle && !matchBrand && !matchGid) {
          return false;
        }
      }

      return true;
    });

    // Sort Pipeline
    if (currentSort === "median") {
      filteredData.sort(function (a, b) {
        return (b.median || 0) - (a.median || 0) || a.rank - b.rank;
      });
    } else if (currentSort === "count2") {
      filteredData.sort(function (a, b) {
        return (b.count2 || 0) - (a.count2 || 0) || a.rank - b.rank;
      });
    } else if (currentSort === "sellday") {
      filteredData.sort(function (a, b) {
        return (b.sellday || "").localeCompare(a.sellday || "") || a.rank - b.rank;
      });
    } else {
      // Default: rank
      filteredData.sort(function (a, b) {
        return a.rank - b.rank;
      });
    }

    renderCount = PAGE_SIZE;
    renderShowcaseGrid();
    updateStatsBar();
  }

  // --- Artwork Resolver ---
  function getArtworkFor(item, view) {
    var gid = String(item.gid);
    var st = storeOf(gid);
    var v = liveCache.get(gid) || (_CACHE[gid] || null);

    var thumb = "";
    var full = "";
    var shots = [];

    if (view === "vndb" && v) {
      if (v.img) {
        full = v.img;
        thumb = vnThumb(v.img);
      }
      if (v.shots && v.shots.length) shots = v.shots;
    } else if (view === "dlsite" && st && st.l) {
      full = dlMainUrl(st.l);
      thumb = dlMainThumbUrl(st.l);
      shots = dlSamples(st.l);
    } else if (view === "dmm" && st && (st.m || st.m2)) {
      var m = st.m || st.m2;
      full = dmmPkgUrl(m.id);
      thumb = dmmPkgThumb(m.id);
      var dn = Math.min(m.n || 0, 10);
      for (var di = 1; di <= dn; di++) shots.push(dmmSampleBig(m.id, di));
    } else if (view === "getchu" && st && st.g) {
      full = gcCoverUrl(st.g.id);
      thumb = gcCoverUrl(st.g.id);
      var gn = Math.min(st.g.n || 0, 10);
      for (var gi = 1; gi <= gn; gi++) shots.push(gcSampleUrl(st.g.id, gi));
    } else {
      // View: all
      if (v && v.img) {
        full = v.img;
        thumb = vnThumb(v.img);
        shots = v.shots || [];
      } else if (st && st.l) {
        full = dlMainUrl(st.l);
        thumb = dlMainThumbUrl(st.l);
        shots = dlSamples(st.l);
      } else if (st && (st.m || st.m2)) {
        var dm = st.m || st.m2;
        full = dmmPkgUrl(dm.id);
        thumb = dmmPkgThumb(dm.id);
        var dmn = Math.min(dm.n || 0, 10);
        for (var dmi = 1; dmi <= dmn; dmi++) shots.push(dmmSampleBig(dm.id, dmi));
      } else if (st && st.g) {
        full = gcCoverUrl(st.g.id);
        thumb = gcCoverUrl(st.g.id);
        var gcn = Math.min(st.g.n || 0, 10);
        for (var gci = 1; gci <= gcn; gci++) shots.push(gcSampleUrl(st.g.id, gci));
      } else {
        full = egsImg(item.gid, 1);
        thumb = full;
      }
    }

    if (!full) {
      full = egsImg(item.gid, 1);
      thumb = full;
    }
    if (!thumb) thumb = full;

    return { thumb: thumb, full: full, shots: shots };
  }

  function escHtml(s) {
    if (!s) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // --- Card Element Factory ---
  function createCardElement(item) {
    var gid = String(item.gid);
    var st = storeOf(gid);
    var v = liveCache.get(gid) || null;
    var art = getArtworkFor(item, currentTab);

    var hasD = Boolean(dlEntry(st));
    var hasF = dmmEntries(st).length > 0;
    var hasG = Boolean(gcEntry(st));
    var hasV = Boolean(v);

    var wrap = document.createElement("div");
    wrap.className = "cardwrap";
    wrap.dataset.gid = gid;

    var article = document.createElement("article");
    article.className = "card" + (item.rank <= 10 ? " rank-top10" : "");
    article.dataset.gid = gid;

    // Rating tier class
    var medClass = "med-c";
    var med = item.median || 0;
    if (med >= 85) medClass = "med-ex";
    else if (med >= 80) medClass = "med-s";
    else if (med >= 75) medClass = "med-a";
    else if (med >= 70) medClass = "med-b";

    // Tags list
    var itemTags = tagsOf(gid);
    var tagsHtml = "";
    if (itemTags.length > 0) {
      tagsHtml = itemTags.slice(0, 3).map(function (t) {
        return '<span class="tagbadge">' + escHtml(t) + '</span>';
      }).join("");
    }

    // Direct Store Actions
    var storeLinksHtml = "";
    if (st && st.l) {
      storeLinksHtml += '<a href="' + escHtml(dlProductUrl(st.l.id, st.l.d)) + '" target="_blank" rel="noopener">DLsite</a>';
    }
    if (st && (st.m || st.m2)) {
      var dm = st.m || st.m2;
      storeLinksHtml += '<a href="' + escHtml(dmmDetailUrl(dm.id)) + '" target="_blank" rel="noopener">FANZA</a>';
    }
    if (st && st.g) {
      storeLinksHtml += '<a href="' + escHtml(gcProductUrl(st.g.id)) + '" target="_blank" rel="noopener">Getchu</a>';
    }
    if (v) {
      storeLinksHtml += '<a href="' + escHtml(vnUrl(v.id)) + '" target="_blank" rel="noopener">VNDB</a>';
    } else {
      storeLinksHtml += '<button type="button" class="btn-fetch" data-act="fetch" data-gid="' + gid + '">匹配VNDB</button>';
    }

    // Always ensure at least 2 links and one containing erogamescape
    var egsLinkHtml = '<a href="' + escHtml(egsUrl(item.gid)) + '" target="_blank" rel="noopener">批评空间</a>';

    article.innerHTML =
      '<div class="cover" data-act="detail">' +
        '<img data-full="' + escHtml(art.full) + '" src="' + escHtml(art.thumb) + '" alt="' + escHtml(item.name) + '" loading="lazy">' +
        '<div class="scrim"></div>' +
        '<div class="rank">#' + item.rank + '</div>' +
        (item.median ? '<div class="medpill ' + medClass + '">' + item.median + '</div>' : '') +
        '<div class="storedots">' +
          '<span class="sdot' + (hasD ? ' on' : '') + '">D</span>' +
          '<span class="sdot' + (hasF ? ' on' : '') + '">F</span>' +
          '<span class="sdot' + (hasG ? ' on' : '') + '">G</span>' +
          '<span class="sdot' + (hasV ? ' on' : '') + '">V</span>' +
        '</div>' +
        '<div class="scrub-strip"></div>' +
      '</div>' +
      '<div class="cinfo">' +
        '<div class="ctitle" title="' + escHtml(item.name) + '">' + escHtml(item.name) + '</div>' +
        '<div class="cline">中央值 ' + (item.median || "-") + ' · 评分 ' + (item.count2 || "-") + '人 · POV: ' + (item.povs || "寝取") + '</div>' +
        (tagsHtml ? '<div class="cardtag">' + tagsHtml + '</div>' : '') +
        '<div class="cacts">' +
          storeLinksHtml +
          egsLinkHtml +
        '</div>' +
      '</div>';

    var coverEl = article.querySelector(".cover");

    // Click on cover opens detail drawer
    coverEl.addEventListener("click", function (e) {
      if (e.target.closest("a") || e.target.closest("button") || e.target.classList.contains("scrub-segment")) {
        return;
      }
      playBeep(520, "sine", 0.04);
      openDetail(gid);
    });

    // 3D Magnetic Tilt Physics
    article.addEventListener("mousemove", function (e) {
      var rect = article.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      var dx = (x / rect.width - 0.5) * 2;
      var dy = (y / rect.height - 0.5) * 2;
      article.style.setProperty("--rx", (-dy * 7).toFixed(2) + "deg");
      article.style.setProperty("--ry", (dx * 7).toFixed(2) + "deg");
    });
    article.addEventListener("mouseleave", function () {
      article.style.setProperty("--rx", "0deg");
      article.style.setProperty("--ry", "0deg");
    });

    // Hover Scrubbing Preview
    if (art.shots && art.shots.length > 0) {
      var scrubStrip = coverEl.querySelector(".scrub-strip");
      var imgEl = coverEl.querySelector("img");
      var scrubList = [art.thumb].concat(art.shots.slice(0, 5));
      scrubList.forEach(function (shotUrl) {
        var seg = document.createElement("div");
        seg.className = "scrub-segment";
        seg.addEventListener("mouseenter", function () {
          imgEl.src = shotUrl;
        });
        scrubStrip.appendChild(seg);
      });
      coverEl.addEventListener("mouseleave", function () {
        imgEl.src = art.thumb;
      });
    }

    // Manual VNDB Match Button
    var fetchBtn = article.querySelector('[data-act="fetch"]');
    if (fetchBtn) {
      fetchBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        e.preventDefault();
        playBeep(650, "triangle", 0.08);
        triggerVndbFetch(gid, item);
      });
    }

    wrap.appendChild(article);
    return wrap;
  }

  // --- Showcase Grid Renderer ---
  function renderShowcaseGrid() {
    var grid = document.getElementById("grid");
    if (!grid) return;

    grid.dataset.view = currentTab;
    grid.innerHTML = "";

    var slice = filteredData.slice(0, renderCount);
    for (var i = 0; i < slice.length; i++) {
      grid.appendChild(createCardElement(slice[i]));
    }

    var moreBtn = document.getElementById("more");
    if (moreBtn) {
      if (renderCount >= filteredData.length) {
        moreBtn.style.display = "none";
      } else {
        moreBtn.style.display = "inline-block";
      }
    }

    // Update Cockpit in Mode B
    if (currentMode === "B" && slice.length > 0) {
      renderCockpit(slice[0]);
    }
  }

  function renderNextPage() {
    if (renderCount >= filteredData.length) return;
    renderCount += PAGE_SIZE;
    renderShowcaseGrid();
    updateStatsBar();
  }

  function updateStatsBar() {
    var stats = document.getElementById("stats");
    if (!stats) return;

    var adapter = ADAPTERS[currentTab];
    var tagInfo = tagSel.length > 0 ? " · 标签AND：" + tagSel.join("+") : "";
    var medInfo = minMed > 0 ? " · 中央值≥" + minMed : "";
    var shown = Math.min(renderCount, filteredData.length);

    stats.innerHTML =
      "共 <b>" + filteredData.length + "</b> / " + _DATA.length + " 个（EROGE限定） · " +
      "视图：" + adapter.navLabel + " · " +
      "已显示 " + shown + " 个" + tagInfo + medInfo;
  }

  // --- Tag Constellation Chips Renderer ---
  function renderTagChips() {
    var container = document.getElementById("tagchips");
    var tagRow = document.getElementById("tagrow");
    if (!container || !tagRow) return;

    var tagKeys = Object.keys(_TAGS);
    if (!tagKeys.length) {
      tagRow.hidden = true;
      return;
    }
    tagRow.hidden = false;
    container.innerHTML = "";

    tagKeys.forEach(function (tag) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tagchip" + (tagSel.indexOf(tag) >= 0 ? " on" : "");
      btn.dataset.tag = tag;
      btn.innerHTML =
        '<span class="tagname">' + escHtml(tag) + '</span>' +
        '<span class="tagcount">' + _TAGS[tag].length + '</span>';

      btn.addEventListener("click", function () {
        toggleTag(tag);
      });
      container.appendChild(btn);
    });
  }

  function toggleTag(tag) {
    playBeep(480, "sine", 0.04);
    var idx = tagSel.indexOf(tag);
    if (idx >= 0) {
      tagSel.splice(idx, 1);
    } else {
      tagSel.push(tag);
    }
    persistTags();
    renderTagChips();
    applyFilter();
  }

  // --- Detail Drawer System ---
  function openDetail(gid) {
    var item = _DATA.find(function (d) { return String(d.gid) === String(gid); });
    if (!item) return;

    var drawer = document.getElementById("drawer");
    var dhead = document.getElementById("dhead");
    var dbody = document.getElementById("dbody");
    if (!drawer || !dhead || !dbody) return;

    var st = storeOf(gid) || {};
    var v = liveCache.get(String(gid)) || (_CACHE[String(gid)] || null);
    var itemTags = tagsOf(gid);

    // Populate Header
    dhead.querySelector("h2").textContent = "#" + item.rank + " " + item.name;

    var hintText =
      "社团：" + (item.brand || "未知") + " · 发售日：" + (item.sellday || "未知") + "\n" +
      "中央值 " + (item.median || "-") + " · 评分 " + (item.count2 || "-") + "人 · POV: " + (item.povs || "寝取") + "\n" +
      "注册标签: " + (itemTags.length ? itemTags.join(" / ") : "无") + "\n" +
      "VNDB: " + (v ? (v.id + (v.title ? " (" + v.title + ")" : "")) : "未匹配");
    dhead.querySelector(".hint").textContent = hintText;

    // Collect Store Image Strips
    var bodyHtml = "";

    // 1. DLsite Section
    if (st && st.l) {
      var dlSt = st.l;
      var dlImgs = dlSamples(dlSt);
      bodyHtml +=
        '<div class="drawer-section dsec-dl">' +
          '<h3 id="dsec-h-dl">DLsite 样本原画 (<span data-livecount="dl">' + dlImgs.length + '</span>)</h3>' +
          '<div class="drawer-meta-links">' +
            '<a href="' + escHtml(dlProductUrl(dlSt.id, dlSt.d)) + '" target="_blank" rel="noopener">DLsite 商品页面 (' + escHtml(dlSt.id) + ')</a>' +
          '</div>' +
          '<div class="strip">' +
            dlImgs.map(function (u) {
              return '<img src="' + escHtml(dlJpg(u)) + '" data-full="' + escHtml(u) + '" alt="DLsite sample" loading="lazy">';
            }).join("") +
          '</div>' +
        '</div>';

      // Live DLsite meta check if unharvested
      if (USE_GC && dlSt.un && !sessionMetaCache.has("dl:" + dlSt.id)) {
        sessionMetaCache.add("dl:" + dlSt.id);
        fetch(dlApiMeta(dlSt.id, dlSt.d)).then(function (r) { return r.json(); }).catch(function () { return null; });
      }
    }

    // 2. FANZA Section
    var dmmList = dmmEntries(st);
    if (dmmList.length > 0) {
      var dmmSamples = [];
      dmmList.forEach(function (dm) {
        var n = Math.min(dm.n || 0, 10);
        for (var i = 1; i <= n; i++) {
          dmmSamples.push({
            big: dmmSampleBig(dm.id, i),
            small: dmmSampleSmall(dm.id, i)
          });
        }
      });
      bodyHtml +=
        '<div class="drawer-section dsec-dmm">' +
          '<h3 id="dsec-h-dmm">FANZA 截帧图集 (<span data-livecount="dmm">' + dmmSamples.length + '</span>)</h3>' +
          '<div class="drawer-meta-links">' +
            dmmList.map(function (dm) {
              return '<a href="' + escHtml(dmmDetailUrl(dm.id)) + '" target="_blank" rel="noopener">FANZA ' + escHtml(dmmFloorLabel(dm.id)) + ' (' + escHtml(dm.id) + ')</a>';
            }).join("") +
          '</div>' +
          '<div class="strip">' +
            dmmSamples.map(function (s) {
              return '<img src="' + escHtml(s.small) + '" data-full="' + escHtml(s.big) + '" alt="FANZA sample" loading="lazy">';
            }).join("") +
          '</div>' +
        '</div>';

      // Live DMM meta check
      if (USE_GC && !sessionMetaCache.has("dm:" + dmmList[0].id)) {
        sessionMetaCache.add("dm:" + dmmList[0].id);
        fetch(dmApiMeta(dmmList[0].id)).then(function (r) { return r.json(); }).catch(function () { return null; });
      }
    }

    // 3. Getchu Section
    if (st && st.g) {
      var gc = st.g;
      var gcSamples = [];
      var gn = Math.min(gc.n || 0, 10);
      for (var gi = 1; gi <= gn; gi++) {
        gcSamples.push(gcSampleUrl(gc.id, gi));
      }
      bodyHtml +=
        '<div class="drawer-section dsec-gc">' +
          '<h3 id="dsec-h-gc">Getchu 宣传册样本 (<span data-livecount="gc">' + (gcSamples.length || 1) + '</span>)</h3>' +
          '<div class="drawer-meta-links">' +
            '<a href="' + escHtml(gcProductUrl(gc.id)) + '" target="_blank" rel="noopener">Getchu 作品页 (' + escHtml(gc.id) + ')</a>' +
          '</div>' +
          '<div class="strip">' +
            (gcSamples.length ? gcSamples : [gcCoverUrl(gc.id)]).map(function (u) {
              return '<img src="' + escHtml(u) + '" data-full="' + escHtml(u) + '" alt="Getchu sample" loading="lazy">';
            }).join("") +
          '</div>' +
        '</div>';

      // Live Getchu meta check (only if count unknown)
      if (USE_GC && (typeof gc.n !== "number" || gc.n <= 0) && !sessionMetaCache.has("gc:" + gc.id)) {
        sessionMetaCache.add("gc:" + gc.id);
        fetch(gcApiMeta(gc.id)).then(function (r) { return r.json(); }).catch(function () { return null; });
      }
    }

    // 4. VNDB Section
    var vndbShots = v && v.shots ? v.shots : [];
    bodyHtml +=
      '<div class="drawer-section dsec-vndb">' +
        '<h3 id="dsec-h-vndb">VNDB 视觉小说画廊 (<span data-livecount="vndb">' + vndbShots.length + '</span>)</h3>' +
        '<div class="drawer-meta-links">' +
          (v ? '<a href="' + escHtml(vnUrl(v.id)) + '" target="_blank" rel="noopener">VNDB 典藏页 (' + escHtml(v.id) + ')</a>' : '') +
          '<a href="' + escHtml(vnSearchUrl(item.name)) + '" target="_blank" rel="noopener">VNDB搜索</a>' +
          '<button type="button" data-act="refetch" data-gid="' + gid + '">重查VNDB</button>' +
        '</div>' +
        (vndbShots.length > 0 ? (
          '<div class="strip">' +
            vndbShots.map(function (u) {
              return '<img src="' + escHtml(vnThumb(u)) + '" data-full="' + escHtml(u) + '" alt="VNDB shot" loading="lazy">';
            }).join("") +
          '</div>'
        ) : '') +
      '</div>';

    // 5. Full CG Section
    var fullcg = _FULLCG[gid];
    bodyHtml +=
      '<div class="drawer-section dsec-fullcg">' +
        '<h3 id="dsec-h-fullcg">全CG / 原画鉴赏</h3>' +
        '<div class="drawer-meta-links">' +
          (fullcg && fullcg.ehentai ? '<a href="' + escHtml(fullcg.ehentai) + '" target="_blank" rel="noopener">E-Hentai 全CG 图库</a>' : '') +
          (fullcg && fullcg.hitomi ? '<a href="' + escHtml(fullcg.hitomi) + '" target="_blank" rel="noopener">Hitomi 全CG 图库</a>' : '') +
          '<a href="https://e-hentai.org/?f_search=' + encodeURIComponent(item.name + ' CG') + '" target="_blank" rel="noopener">全CG 在线索引</a>' +
        '</div>' +
      '</div>';

    // 6. Related Games Strip
    var related = relatedOf(item, v);
    if (related.length > 0) {
      bodyHtml +=
        '<div class="drawer-section dsec-rel">' +
          '<h3 id="dsec-h-rel">同社团 / 系列藏品推荐 (' + related.length + ')</h3>' +
          '<div class="relstrip">' +
            related.map(function (r) {
              var rArt = getArtworkFor(r, currentTab);
              return (
                '<div class="relcard" data-act="detail" data-gid="' + r.gid + '">' +
                  '<div class="relimg-wrap">' +
                    (rArt.thumb ? '<img class="relimg" src="' + escHtml(rArt.thumb) + '" alt="' + escHtml(r.name) + '" loading="lazy">' : '<div class="relnocover">无封面</div>') +
                  '</div>' +
                  '<div class="reltitle">' + escHtml(r.name) + '</div>' +
                '</div>'
              );
            }).join("") +
          '</div>' +
        '</div>';
    }

    dbody.innerHTML = bodyHtml;

    // Attach Lightbox click triggers on strip images
    var stripImages = dbody.querySelectorAll(".strip img");
    stripImages.forEach(function (imgEl, i) {
      imgEl.addEventListener("click", function () {
        openLightbox(imgEl.getAttribute("data-full"), (i + 1) + " / " + stripImages.length + " " + item.name, stripImages, i, item);
      });
    });

    // Attach Recommendation card click triggers
    dbody.querySelectorAll(".relcard[data-act='detail']").forEach(function (cardEl) {
      cardEl.addEventListener("click", function () {
        playBeep(520, "sine", 0.04);
        openDetail(cardEl.dataset.gid);
      });
    });

    // Re-query VNDB button trigger
    var refetchBtn = dbody.querySelector('[data-act="refetch"]');
    if (refetchBtn) {
      refetchBtn.addEventListener("click", function () {
        triggerVndbFetch(gid, item, true);
      });
    }

    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    document.body.classList.add("locked");
  }

  function closeDetail() {
    var drawer = document.getElementById("drawer");
    if (!drawer) return;
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    var lb = document.getElementById("lightbox");
    if (!lb || !lb.classList.contains("open")) {
      document.body.classList.remove("locked");
    }
  }

  // --- Mode B: Sticky Inspector Cockpit ---
  function renderCockpit(item) {
    var cockpit = document.getElementById("cockpitContent");
    if (!cockpit) return;
    var gid = String(item.gid);
    var art = getArtworkFor(item, currentTab);
    var st = storeOf(gid) || {};
    var v = liveCache.get(gid) || null;

    cockpit.innerHTML =
      '<div class="cockpit-hero">' +
        '<div class="cockpit-cover-wrap">' +
          '<img src="' + escHtml(art.full) + '" alt="' + escHtml(item.name) + '">' +
        '</div>' +
        '<div class="cockpit-meta">' +
          '<div class="cockpit-rank">#' + item.rank + '</div>' +
          '<h2 class="cockpit-title">' + escHtml(item.name) + '</h2>' +
          '<div class="cockpit-brand">' + escHtml(item.brand) + ' · ' + escHtml(item.sellday) + '</div>' +
          '<div class="cockpit-stats">' +
            '<div>中央值: <b>' + (item.median || "-") + '</b></div>' +
            '<div>评分人数: <b>' + (item.count2 || "-") + '</b></div>' +
            '<div>POV: <b>' + escHtml(item.povs || "寝取") + '</b></div>' +
          '</div>' +
          '<div class="cockpit-actions">' +
            '<button type="button" class="btn-load-more" id="cockpitDetailBtn">进入全屏检视</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    var btn = cockpit.querySelector("#cockpitDetailBtn");
    if (btn) {
      btn.addEventListener("click", function () {
        openDetail(gid);
      });
    }
  }

  // --- Zenith Aurora Lightbox Stage ---
  function openLightbox(fullUrl, caption, imgs, index, item) {
    var lb = document.getElementById("lightbox");
    var vimg = document.getElementById("vimg");
    var vcap = document.getElementById("vcap");
    var vthumbs = document.getElementById("vthumbs");
    if (!lb || !vimg || !vcap || !vthumbs) return;

    lbImages = imgs ? Array.from(imgs) : [];
    lbIndex = index || 0;
    lbCurrentItem = item || null;

    vimg.src = fullUrl;
    vcap.textContent = caption;

    // Build Thumbnail Strip
    vthumbs.innerHTML = "";
    lbImages.forEach(function (imgEl, i) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.vi = String(i);
      if (i === lbIndex) btn.classList.add("cur");

      var thumb = document.createElement("img");
      thumb.src = imgEl.src;
      thumb.alt = "Thumb " + (i + 1);
      thumb.loading = "lazy";
      btn.appendChild(thumb);

      btn.addEventListener("click", function () {
        lbIndex = i;
        updateLightboxState();
      });
      vthumbs.appendChild(btn);
    });

    lb.classList.add("open");
    lb.setAttribute("aria-hidden", "false");
    document.body.classList.add("locked");
  }

  function updateLightboxState() {
    if (!lbImages.length) return;
    var currentImg = lbImages[lbIndex];
    var full = currentImg.getAttribute("data-full") || currentImg.src;
    document.getElementById("vimg").src = full;
    document.getElementById("vcap").textContent =
      (lbIndex + 1) + " / " + lbImages.length + " " + (lbCurrentItem ? lbCurrentItem.name : "");

    var thumbs = document.querySelectorAll("#vthumbs button[data-vi]");
    thumbs.forEach(function (t, i) {
      if (i === lbIndex) t.classList.add("cur");
      else t.classList.remove("cur");
    });
  }

  function closeLightbox() {
    var lb = document.getElementById("lightbox");
    if (!lb) return;
    lb.classList.remove("open");
    lb.setAttribute("aria-hidden", "true");
    var drawer = document.getElementById("drawer");
    if (!drawer || !drawer.classList.contains("open")) {
      document.body.classList.remove("locked");
    }
  }

  // --- VNDB Live Lookup Stub/Handler ---
  function triggerVndbFetch(gid, item, force) {
    if (!item) return;
    // Query upstream VNDB API
    fetch("https://api.vndb.org/kana/vn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filters: ["search", "=", item.name],
        fields: "id,title,alttitle,released,image.url,screenshots.url"
      })
    })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (res && res.results && res.results.length > 0) {
        var pick = exactPick(res.results, [item.name], item) || containsPick(res.results, item.name, item);
        if (pick) {
          var entry = {
            id: pick.id,
            title: pick.title,
            alttitle: pick.alttitle,
            released: pick.released,
            img: pick.image ? pick.image.url : null,
            shots: (pick.screenshots || []).map(function (s) { return s.url; }),
            via: "vn:" + pick.title
          };
          liveCache.set(String(gid), entry);
          saveLive();
          applyFilter();
        }
      }
    })
    .catch(function () {});
  }

  // --- Boss-Key Mode Toggle ---
  function toggleBossMode() {
    isBossMode = !isBossMode;
    var shield = document.getElementById("bossShield");
    if (shield) {
      if (isBossMode) {
        shield.classList.add("open");
        shield.setAttribute("aria-hidden", "false");
        document.title = "IEEE Transactions on Computational Narrative Dynamics";
      } else {
        shield.classList.remove("open");
        shield.setAttribute("aria-hidden", "true");
        document.title = origDocTitle;
      }
    }
  }

  // --- Fate Roller Holographic Matrix ---
  function triggerFateRoller() {
    var modal = document.getElementById("fateModal");
    var reel = document.getElementById("fateReel");
    var result = document.getElementById("fateResult");
    if (!modal || !reel || !result) return;

    var pool = filteredData.filter(function (d) { return (d.median || 0) >= 80; });
    if (!pool.length) pool = filteredData;
    if (!pool.length) pool = _DATA;

    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    playBeep(600, "sawtooth", 0.2);

    var count = 0;
    var interval = setInterval(function () {
      var rand = pool[Math.floor(Math.random() * pool.length)];
      reel.textContent = rand.name;
      count++;
      if (count >= 12) {
        clearInterval(interval);
        var finalPick = pool[Math.floor(Math.random() * pool.length)];
        reel.textContent = finalPick.name;
        result.innerHTML =
          '<b>#' + finalPick.rank + ' ' + escHtml(finalPick.name) + '</b><br>' +
          '社团：' + escHtml(finalPick.brand) + ' · 中央值：<span style="color:var(--accent-gilded);font-weight:bold;">' + finalPick.median + '</span>';

        var confirmBtn = document.getElementById("fateConfirmBtn");
        if (confirmBtn) {
          confirmBtn.onclick = function () {
            modal.classList.remove("open");
            modal.setAttribute("aria-hidden", "true");
            openDetail(finalPick.gid);
          };
        }
      }
    }, 60);
  }

  // --- View Mode Switcher (A: Stream, B: Split, C: Runway) ---
  function setViewMode(mode) {
    currentMode = mode;
    document.body.classList.remove("mode-a", "mode-b", "mode-c");
    if (mode === "A") document.body.classList.add("mode-a");
    else if (mode === "B") document.body.classList.add("mode-b");
    else if (mode === "C") document.body.classList.add("mode-c");

    var modeTabs = document.querySelectorAll("#modeSwitcher .mode-tab");
    modeTabs.forEach(function (tab) {
      if (tab.dataset.mode === mode) tab.classList.add("on");
      else tab.classList.remove("on");
    });

    renderShowcaseGrid();
  }

  // --- Event Wireup & Boot Initializer ---
  function initGallery() {
    // 1. Data Source View Tabs
    var viewsNav = document.getElementById("views");
    if (viewsNav) {
      viewsNav.addEventListener("click", function (e) {
        var tab = e.target.closest(".vtab");
        if (tab && tab.dataset.view) {
          playBeep(520, "sine", 0.03);
          setTab(tab.dataset.view);
        }
      });
    }

    // 2. Sort Dimension Selector
    var sortSelect = document.getElementById("sort");
    if (sortSelect) {
      sortSelect.addEventListener("change", function () {
        currentSort = sortSelect.value;
        playBeep(450, "sine", 0.03);
        applyFilter();
      });
    }

    // 3. Density Cycler
    var densityBtn = document.getElementById("density");
    var grid = document.getElementById("grid");
    if (densityBtn && grid) {
      densityBtn.addEventListener("click", function () {
        currentDensity = (currentDensity + 1) % 3;
        playBeep(500, "triangle", 0.04);
        if (currentDensity === 0) {
          densityBtn.textContent = "密度：自动";
          grid.classList.remove("density-compact", "density-large");
        } else if (currentDensity === 1) {
          densityBtn.textContent = "密度：紧凑";
          grid.classList.add("density-compact");
          grid.classList.remove("density-large");
        } else if (currentDensity === 2) {
          densityBtn.textContent = "密度：大图";
          grid.classList.add("density-large");
          grid.classList.remove("density-compact");
        }
      });
    }

    // 4. Only Matched Checkbox
    var matchedCheck = document.getElementById("onlyMatched");
    if (matchedCheck) {
      matchedCheck.addEventListener("change", function () {
        onlyMatched = matchedCheck.checked;
        playBeep(400, "sine", 0.03);
        applyFilter();
      });
    }

    // 5. Omni Search Input
    var searchInput = document.getElementById("omniSearch");
    if (searchInput) {
      searchInput.addEventListener("input", function () {
        searchQuery = searchInput.value.trim();
        applyFilter();
      });
    }

    // 6. Median Score Filter Chips
    var medChips = document.getElementById("medchips");
    if (medChips) {
      medChips.addEventListener("click", function (e) {
        var chip = e.target.closest(".fchip");
        if (chip && chip.dataset.med !== undefined) {
          minMed = Number(chip.dataset.med);
          playBeep(540, "sine", 0.03);
          medChips.querySelectorAll(".fchip").forEach(function (c) {
            c.classList.toggle("on", Number(c.dataset.med) === minMed);
          });
          applyFilter();
        }
      });
    }

    // 7. Reset Filter Button
    var resetBtn = document.getElementById("reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        playBeep(350, "square", 0.06);
        tagSel = [];
        minMed = 0;
        searchQuery = "";
        if (searchInput) searchInput.value = "";
        persistTags();
        renderTagChips();
        if (medChips) {
          medChips.querySelectorAll(".fchip").forEach(function (c) {
            c.classList.toggle("on", c.dataset.med === "0");
          });
        }
        applyFilter();
      });
    }

    // 8. Load More Button & Intersection Observer
    var moreBtn = document.getElementById("more");
    if (moreBtn) {
      moreBtn.addEventListener("click", function () {
        renderNextPage();
      });

      if (typeof window.IntersectionObserver !== "undefined") {
        var observer = new window.IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting && moreBtn.style.display !== "none") {
              renderNextPage();
            }
          }
        });
        observer.observe(moreBtn);
      }
    }

    // 9. Drawer Controls
    var dclose = document.getElementById("dclose");
    if (dclose) dclose.addEventListener("click", closeDetail);

    var drawerOverlay = document.getElementById("drawer");
    if (drawerOverlay) {
      var backdrop = drawerOverlay.querySelector(".backdrop");
      if (backdrop) backdrop.addEventListener("click", closeDetail);
    }

    // 10. Lightbox Controls
    var vprev = document.getElementById("vprev");
    if (vprev) {
      vprev.addEventListener("click", function () {
        if (!lbImages.length) return;
        lbIndex = (lbIndex - 1 + lbImages.length) % lbImages.length;
        updateLightboxState();
      });
    }

    var vnext = document.getElementById("vnext");
    if (vnext) {
      vnext.addEventListener("click", function () {
        if (!lbImages.length) return;
        lbIndex = (lbIndex + 1) % lbImages.length;
        updateLightboxState();
      });
    }

    var vclose = document.getElementById("vclose");
    if (vclose) vclose.addEventListener("click", closeLightbox);

    var vopen = document.getElementById("vopen");
    if (vopen) {
      vopen.addEventListener("click", function () {
        var vimg = document.getElementById("vimg");
        if (vimg && vimg.src) window.open(vimg.src);
      });
    }

    // 11. Topbar Actions: Safe Mode, Sound, Boss Key
    var safeBtn = document.getElementById("safeModeBtn");
    if (safeBtn) {
      safeBtn.addEventListener("click", function () {
        isSafeMode = !isSafeMode;
        document.body.classList.toggle("safe-mode", isSafeMode);
        safeBtn.classList.toggle("active", isSafeMode);
        playBeep(isSafeMode ? 320 : 640, "sine", 0.05);
      });
    }

    var audioBtn = document.getElementById("audioToggleBtn");
    var audioIcon = document.getElementById("audioIcon");
    if (audioBtn) {
      audioBtn.addEventListener("click", function () {
        audioEnabled = !audioEnabled;
        if (audioIcon) audioIcon.textContent = audioEnabled ? "🔊" : "🔇";
        if (audioEnabled) playBeep(520, "sine", 0.04);
      });
    }

    var bossBtn = document.getElementById("bossKeyBtn");
    if (bossBtn) {
      bossBtn.addEventListener("click", toggleBossMode);
    }

    // 12. Fate Roller Controls
    var fateBtn = document.getElementById("fateRollerBtn");
    if (fateBtn) fateBtn.addEventListener("click", triggerFateRoller);

    var fateClose = document.getElementById("fateCloseBtn");
    if (fateClose) {
      fateClose.addEventListener("click", function () {
        var m = document.getElementById("fateModal");
        if (m) {
          m.classList.remove("open");
          m.setAttribute("aria-hidden", "true");
        }
      });
    }

    var fateReroll = document.getElementById("fateRerollBtn");
    if (fateReroll) fateReroll.addEventListener("click", triggerFateRoller);

    // 13. View Mode Switcher
    var modeSwitcher = document.getElementById("modeSwitcher");
    if (modeSwitcher) {
      modeSwitcher.addEventListener("click", function (e) {
        var btn = e.target.closest(".mode-tab");
        if (btn && btn.dataset.mode) {
          playBeep(560, "sine", 0.04);
          setViewMode(btn.dataset.mode);
        }
      });
    }

    // 14. Tag Drawer Toggle Button
    var tagDrawerBtn = document.getElementById("tagDrawerBtn");
    var tagRow = document.getElementById("tagrow");
    if (tagDrawerBtn && tagRow) {
      tagDrawerBtn.addEventListener("click", function () {
        tagRow.hidden = !tagRow.hidden;
        playBeep(450, "sine", 0.03);
      });
    }

    // 15. Global Master Keyboard Shortcuts
    document.addEventListener("keydown", function (e) {
      // Escape
      if (e.key === "Escape") {
        var lb = document.getElementById("lightbox");
        if (lb && lb.classList.contains("open")) {
          closeLightbox();
          return;
        }
        var dr = document.getElementById("drawer");
        if (dr && dr.classList.contains("open")) {
          closeDetail();
          return;
        }
        var fm = document.getElementById("fateModal");
        if (fm && fm.classList.contains("open")) {
          fm.classList.remove("open");
          fm.setAttribute("aria-hidden", "true");
          return;
        }
        if (isBossMode) {
          toggleBossMode();
          return;
        }
      }

      // Ignore when focused in input
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT")) {
        return;
      }

      // Boss Key: B
      if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        toggleBossMode();
        return;
      }

      // Omni Search Focus: /
      if (e.key === "/") {
        e.preventDefault();
        if (searchInput) searchInput.focus();
        return;
      }

      // View Modes: 1, 2, 3
      if (e.key === "1") { setViewMode("A"); return; }
      if (e.key === "2") { setViewMode("B"); return; }
      if (e.key === "3") { setViewMode("C"); return; }

      // Fate Roller: R
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        triggerFateRoller();
        return;
      }

      // Lightbox Navigation: Left / Right
      var lbEl = document.getElementById("lightbox");
      if (lbEl && lbEl.classList.contains("open")) {
        if (e.key === "ArrowLeft") {
          if (vprev) vprev.click();
          return;
        }
        if (e.key === "ArrowRight") {
          if (vnext) vnext.click();
          return;
        }
      }

      // Gallery J / K Navigation
      var cards = document.querySelectorAll("#grid .cardwrap");
      if (!cards.length) return;

      if (e.key === "j" || e.key === "J" || e.key === "ArrowDown") {
        e.preventDefault();
        focusedCardIndex = Math.min(focusedCardIndex + 1, cards.length - 1);
        var targetCard = cards[focusedCardIndex];
        if (targetCard) {
          targetCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
          playBeep(420, "sine", 0.02);
          if (currentMode === "B") {
            var g = targetCard.dataset.gid;
            var itm = _DATA.find(function (d) { return String(d.gid) === g; });
            if (itm) renderCockpit(itm);
          }
        }
        return;
      }

      if (e.key === "k" || e.key === "K" || e.key === "ArrowUp") {
        e.preventDefault();
        focusedCardIndex = Math.max(focusedCardIndex - 1, 0);
        var tCard = cards[focusedCardIndex];
        if (tCard) {
          tCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
          playBeep(460, "sine", 0.02);
          if (currentMode === "B") {
            var tg = tCard.dataset.gid;
            var tItm = _DATA.find(function (d) { return String(d.gid) === tg; });
            if (tItm) renderCockpit(tItm);
          }
        }
        return;
      }

      // Open current focused item: Enter
      if (e.key === "Enter") {
        var curWrap = cards[focusedCardIndex];
        if (curWrap && curWrap.dataset.gid) {
          openDetail(curWrap.dataset.gid);
        }
        return;
      }

      // Direct Store Jump: D (DLsite), E (EGS)
      if (e.key === "d" || e.key === "D") {
        var dWrap = cards[focusedCardIndex];
        if (dWrap && dWrap.dataset.gid) {
          var dSt = storeOf(dWrap.dataset.gid);
          if (dSt && dSt.l) {
            window.open(dlProductUrl(dSt.l.id, dSt.l.d));
          }
        }
        return;
      }

      if (e.key === "e" || e.key === "E") {
        var eWrap = cards[focusedCardIndex];
        if (eWrap && eWrap.dataset.gid) {
          window.open(egsUrl(eWrap.dataset.gid));
        }
        return;
      }
    });

    // Boot Pipeline
    renderTagChips();
    applyFilter();
  }

  // --- Public View Tab Switcher ---
  function setTab(view) {
    if (!ADAPTERS[view]) return;
    currentTab = view;

    // Update active tab button
    var tabs = document.querySelectorAll("#views .vtab");
    tabs.forEach(function (tab) {
      if (tab.dataset.view === view) tab.classList.add("on");
      else tab.classList.remove("on");
    });

    // Update grid dataset.view
    var grid = document.getElementById("grid");
    if (grid) grid.dataset.view = view;

    // Update onlyMatchedLabel
    var label = document.getElementById("onlyMatchedLabel");
    if (label) label.textContent = ADAPTERS[view].matchedLabel;

    // Update onlyMatched if checked
    var matchedCheck = document.getElementById("onlyMatched");
    if (matchedCheck) onlyMatched = matchedCheck.checked;

    applyFilter();
  }

  function getTab() {
    return currentTab;
  }

  function getTagSel() {
    return tagSel.slice();
  }

  // Auto-boot on DOM ready or immediate
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initGallery);
    } else {
      initGallery();
    }
  }

  // --- Export Global GALLERY Contract ---
  window.GALLERY = {
    DATA: _DATA,
    STORE: _STORE,
    CACHE: _CACHE,
    TAGS: _TAGS,
    FULLCG: _FULLCG,
    BRANDG: _BRANDG,
    ADAPTERS: ADAPTERS,
    liveCache: liveCache,
    LIVE_KEY: LIVE_KEY,
    LIVE_BUDGET: LIVE_BUDGET,
    saveLive: saveLive,
    storeOf: storeOf,
    tagsOf: tagsOf,
    dlEntry: dlEntry,
    dmmEntries: dmmEntries,
    gcEntry: gcEntry,
    relatedOf: relatedOf,
    exactPick: exactPick,
    containsPick: containsPick,
    setTab: setTab,
    getTab: getTab,
    getTagSel: getTagSel,
    toggleTag: toggleTag,
    openDetail: openDetail,
    closeDetail: closeDetail,
    openLightbox: openLightbox,
    closeLightbox: closeLightbox
  };

})();
