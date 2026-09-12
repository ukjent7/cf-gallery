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
    var kept = [];
    liveCache.forEach(function (v, k) {
      if (v && !_CACHE[k]) kept.push(k);
    });
    // Bounded eviction: one proportional cut is enough in practice (entries
    // are similarly sized), with a second pass only to verify. Never loop
    // full 900KB serializations unboundedly.
    for (var attempt = 0; attempt < 3; attempt++) {
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

