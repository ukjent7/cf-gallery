// PROJECT AURA // NOCTURNE VAULT (夜幕缪斯档案馆)
// CF-Gallery Client Application & Telemetry Engine v2.0

export const USE_GC = typeof window !== "undefined" && window.location && window.location.protocol !== "file:";
/** @type {any} */ (window).USE_GC = USE_GC; // file:// probe reads it via window.eval

// Global Datasets & Fallbacks
export const _DATA = typeof DATA !== "undefined" ? DATA : [];
export const _STORE = typeof STORE !== "undefined" ? STORE : {};
export const _CACHE = typeof CACHE !== "undefined" ? CACHE : {};
export const _TAGS = typeof TAGS !== "undefined" ? TAGS : {};
export const _FULLCG = typeof FULLCG !== "undefined" ? FULLCG : {};
export const _BRANDG = typeof BRANDG !== "undefined" ? BRANDG : {};

export const PAGE_SIZE = 36;
export const LIVE_KEY = "vndb_live_v4";
export const LIVE_BUDGET = 900000;

// --- Live Cache Storage & Eviction ---
export const liveCache = new Map();

// Seed baked CACHE
for (const [cKey, val] of Object.entries(_CACHE)) {
  if (val) liveCache.set(String(cKey), val);
}

// Restore and migrate localStorage
try {
  const rawLive = typeof localStorage !== "undefined" ? localStorage.getItem(LIVE_KEY) : null;
  if (rawLive) {
    const parsedLive = JSON.parse(rawLive);
    if (parsedLive && typeof parsedLive === "object") {
      for (const [pKey, entry] of Object.entries(parsedLive)) {
        if (!entry) continue;
        // Migration guard: weak matches must be dropped
        if (entry.via && (entry.via.startsWith("vn-core:") || entry.via.startsWith("release:"))) {
          continue;
        }
        liveCache.set(String(pKey), entry);
      }
    }
  }
} catch {
  if (typeof localStorage !== "undefined") {
    try { localStorage.removeItem(LIVE_KEY); } catch {}
  }
}

export function saveLive() {
  if (typeof localStorage === "undefined") return;
  let kept = [];
  liveCache.forEach((v, k) => {
    if (v && !_CACHE[k]) kept.push(k);
  });
  // Bounded eviction: one proportional cut is enough in practice (entries
  // are similarly sized), with a second pass only to verify. Never loop
  // full 900KB serializations unboundedly.
  for (let attempt = 0; attempt < 3; attempt++) {
    const o = {};
    for (let i = 0; i < kept.length; i++) o[kept[i]] = liveCache.get(kept[i]);
    const s = JSON.stringify(o);
    if (s.length <= LIVE_BUDGET) {
      try { localStorage.setItem(LIVE_KEY, s); } catch {}
      return;
    }
    if (!kept.length) return;
    const drop = Math.max(1, Math.ceil(kept.length * (1 - LIVE_BUDGET / s.length)));
    kept = kept.slice(drop);
  }
}
