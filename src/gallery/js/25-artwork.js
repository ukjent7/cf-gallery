  // --- Artwork Resolver ---
  // Each store is described once; views only declare a priority order.
  // The fallback chain and shot list then fall out of the table instead of
  // five copy-pasted branches.
  function artworkSources(item, st, v) {
    var dmEntry = st && (st.m || st.m2);
    var dl = st && st.l;
    var gc = st && st.g;
    var dmmFull = dmEntry ? dmmPkgUrl(dmEntry.id) : "";
    var dlFull = dl ? dlMainUrl(dl) : "";
    var dlJpgUrl = dl ? dlJpg(dlFull) : "";
    var gcCover = gc ? (USE_GC ? gcApiCover(gc.id) : egsImg(item.gid, 1)) : "";
    var vndbCover = v && v.img ? v.img : "";
    return {
      dmm: dmEntry ? {
        thumb: dmmFull,
        full: dmmFull,
        extras: dmmPkgFallbacks(dmEntry.id),
        shots: function () {
          var out = [];
          var n = Math.min(dmEntry.n || 0, DMM_SAMPLE_CAP);
          for (var i = 1; i <= n; i++) out.push(dmmSampleBig(dmEntry.id, i));
          return out;
        }
      } : null,
      dl: dl ? {
        thumb: dlFull,
        full: dlFull,
        extras: dlJpgUrl && dlJpgUrl !== dlFull ? [dlJpgUrl] : [],
        shots: function () { return dlSamples(dl); }
      } : null,
      gc: gc ? {
        thumb: gcCover || egsImg(item.gid, 1),
        full: gcCover || egsImg(item.gid, 1),
        extras: (gc && USE_GC) ? [gcApiSample(gc.id, 1)] : [],
        shots: function () {
          var out = [];
          var n = Math.min(gc.n || 0, GETCHU_SAMPLE_CAP);
          if (USE_GC && n > 1) {
            for (var i = 2; i <= n; i++) out.push(gcApiSample(gc.id, i));
          }
          return out;
        }
      } : null,
      vndb: vndbCover ? {
        thumb: vnThumb(vndbCover) || vndbCover,
        full: vndbCover,
        extras: [],
        shots: function () { return (v && v.shots) || []; }
      } : null
    };
  }

  // Fallback order after the primary cover, per view. Names refer to
  // artworkSources() keys; "dlJpg" is the dl extras entry kept in place so
  // the dlsite-first order differs from the dmm-first order exactly as before.
  function fallbackOrder(view, primary) {
    if (view === "dmm") return ["dl", "dmmExtras", "dlJpg", "gc", "gcSample", "vndb"];
    if (view === "dlsite") return ["dlJpg", "dmm", "dmmExtras", "gc", "gcSample", "vndb"];
    if (view === "getchu") return ["gcSample", "vndb", "dmm", "dmmExtras", "dl", "dlJpg"];
    if (view === "vndb") return ["dmm", "dmmExtras", "dl", "dlJpg", "gc", "gcSample"];
    if (primary === "dmm") return ["dl", "dmmExtras", "dlJpg", "gc", "gcSample", "vndb"];
    if (primary === "dl") return ["dlJpg", "gc", "gcSample", "vndb"];
    if (primary === "gc") return ["gcSample", "vndb", "dmm", "dmmExtras", "dl", "dlJpg"];
    return [];
  }

  function getArtworkFor(item, view) {
    var gid = String(item.gid);
    var st = storeOf(gid);
    var v = liveCache.get(gid) || (_CACHE[gid] || null);
    var src = artworkSources(item, st, v);
    var egsCover = egsImg(item.gid, 1);

    // Primary cover: the requested view when available, else
    // FANZA -> DLsite -> Getchu -> VNDB -> EGS.
    var primary = null;
    if (view === "dmm" && src.dmm) primary = "dmm";
    else if (view === "dlsite" && src.dl) primary = "dl";
    else if (view === "getchu" && src.gc) primary = "gc";
    else if (view === "vndb" && src.vndb) primary = "vndb";
    else if (view === "dmm" || view === "dlsite" || view === "getchu" || view === "vndb") primary = null;
    else if (src.dmm) primary = "dmm";
    else if (src.dl) primary = "dl";
    else if (src.gc) primary = "gc";
    else if (src.vndb) primary = "vndb";

    var thumb = "";
    var full = "";
    var fbList = [];
    var shots = [];
    if (primary && src[primary]) {
      var p = src[primary];
      thumb = p.thumb;
      full = p.full;
      // VNDB thumb differs from its full art; keep the full art behind it.
      if (primary === "vndb" && thumb !== full) fbList.push(full);
      var order = fallbackOrder(view === "all" ? "all" : view, primary);
      for (var oi = 0; oi < order.length; oi++) {
        var key = order[oi];
        if (key === primary) continue;
        if (key === "dmmExtras") {
          if (src.dmm) fbList.push.apply(fbList, src.dmm.extras);
        } else if (key === "dlJpg") {
          if (src.dl) fbList.push.apply(fbList, src.dl.extras);
        } else if (key === "gcSample") {
          if (src.gc) fbList.push.apply(fbList, src.gc.extras);
        } else if (key === "dl" && src.dl) {
          if (src.dl.thumb) fbList.push(src.dl.thumb);
        } else if (key === "dmm" && src.dmm) {
          if (src.dmm.thumb) fbList.push(src.dmm.thumb);
        } else if (key === "gc" && src.gc) {
          if (src.gc.thumb) fbList.push(src.gc.thumb);
        } else if (key === "vndb" && src.vndb) {
          if (src.vndb.full) fbList.push(src.vndb.full);
        }
      }
      shots = p.shots();
      // The "all" view backfills empty shot lists from the next source,
      // exactly as the old branches did; single-store views do not.
      if (view !== "dmm" && view !== "dlsite" && view !== "getchu" && view !== "vndb") {
        if (shots.length === 0 && primary === "dmm" && src.dl) shots = src.dl.shots();
        if (shots.length === 0 && v && v.shots) shots = v.shots;
      }
    }

    if (!full) {
      full = egsCover;
      thumb = full;
    }
    if (!thumb) thumb = full;

    fbList.push(egsCover);
    var fb = fbList
      .filter(function (u, idx, arr) {
        return u && !sameUrl(u, thumb) && arr.indexOf(u) === idx;
      })
      .join("|");

    return { thumb: thumb, full: full, shots: shots, fb: fb || null };
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

  function getMedClass(med) {
    var m = med || 0;
    if (m >= 85) return "med-ex";
    if (m >= 80) return "med-s";
    if (m >= 75) return "med-a";
    if (m >= 70) return "med-b";
    return "med-c";
  }

  function sameUrl(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    try {
      var base = typeof location !== "undefined" ? location.href : "http://localhost/";
      return new URL(a, base).href === new URL(b, base).href;
    } catch (e) {
      return a === b;
    }
  }

  // Walk the fallback chain, then hide/remove if the image is genuinely gone so it never stays as a 裂图.
  function chainImgErr(el) {
    if (!el) return;
    // Scrubbing error isolation: do not corrupt the card's cover fallback chain if a preview sample fails
    if (el.dataset && el.dataset.scrubbing === "true") {
      if (el.dataset.origSrc) {
        el.setAttribute("src", el.dataset.origSrc);
        el.src = el.dataset.origSrc;
      }
      return;
    }

    var currentSrc = el.getAttribute("src") || el.src || "";
    var rawFb = el.getAttribute("data-fb") || "";
    var fb = rawFb.split("|").filter(function (u) {
      return u && !sameUrl(u, currentSrc);
    });

    if (fb.length > 0) {
      var nextUrl = fb[0];
      el.setAttribute("data-fb", fb.slice(1).join("|"));
      el.setAttribute("data-full", nextUrl);
      el.setAttribute("src", nextUrl);
      el.src = nextUrl;
      if (el.dataset) el.dataset.origSrc = nextUrl;
    } else {
      var strip = el.closest(".strip");
      if (strip) {
        el.style.display = "none";
      } else {
        el.classList.add("img-load-failed");
      }
    }
  }
  window.chainImgErr = chainImgErr;

  // Detect Getchu nowprinting placeholder: 200x200 or containing nowprinting, and trigger fallback
  function checkImgLoaded(el) {
    if (!el) return;
    var src = el.getAttribute("src") || el.src || "";
    if (src.indexOf("nowprinting") !== -1 || (el.naturalWidth === 200 && el.naturalHeight === 200 && (src.indexOf("/gc/") !== -1 || src.indexOf("getchu.com") !== -1))) {
      chainImgErr(el);
      return;
    }
    if (el.dataset && el.dataset.scrubbing !== "true") {
      el.dataset.origSrc = src;
    }
    el.classList.remove("img-load-failed");
  }
  window.checkImgLoaded = checkImgLoaded;

