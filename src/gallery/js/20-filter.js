import { _DATA, PAGE_SIZE, liveCache } from "./00-head.js";
import { normStr, storeOf, TAG_SETS } from "./10-match.js";
import { ADAPTERS, S } from "./15-state.js";
import { renderShowcaseGrid, updateStatsBar } from "./30-cards.js";

// --- Filtering & Sorting Pipeline ---
export function applyFilter() {
  const adapter = ADAPTERS[S.tab];
  const q = normStr(S.query);

  S.list = _DATA.filter((item) => {
    const gid = String(item.gid);
    const st = storeOf(gid);
    const v = liveCache.get(gid) || null;

    // Only Matched Checkbox
    if (S.matched) {
      if (!adapter.has(item, st, v)) return false;
    }

    // Median Score Tier Filter
    if (S.med > 0 && (item.median || 0) < S.med) {
      return false;
    }

    // Tag Constellation (AND Intersection)
    if (S.tags.length > 0) {
      for (const tag of S.tags) {
        const tSet = TAG_SETS[tag];
        if (!tSet || !tSet.has(gid)) return false;
      }
    }

    // Omni Search Query
    if (q) {
      const matchTitle = normStr(item.name).includes(q);
      const matchBrand = normStr(item.brand).includes(q);
      const matchGid = gid === q;
      if (!matchTitle && !matchBrand && !matchGid) {
        return false;
      }
    }

    return true;
  });

  // Sort Pipeline
  if (S.sort === "median") {
    S.list.sort((a, b) => (b.median || 0) - (a.median || 0) || a.rank - b.rank);
  } else if (S.sort === "count2") {
    S.list.sort((a, b) => (b.count2 || 0) - (a.count2 || 0) || a.rank - b.rank);
  } else if (S.sort === "sellday") {
    S.list.sort((a, b) => (b.sellday || "").localeCompare(a.sellday || "") || a.rank - b.rank);
  } else {
    // Default: rank
    S.list.sort((a, b) => a.rank - b.rank);
  }

  S.count = PAGE_SIZE;
  renderShowcaseGrid();
  updateStatsBar();
}
