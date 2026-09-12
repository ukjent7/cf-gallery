import { _DATA, PAGE_SIZE, liveCache } from "./00-head.js";
import { normStr, storeOf, TAG_SETS } from "./10-match.js";
import { ADAPTERS, S } from "./15-state.js";
import { renderShowcaseGrid, updateStatsBar } from "./30-cards.js";

// --- Filtering & Sorting Pipeline ---
export function applyFilter() {
  var adapter = ADAPTERS[S.tab];
  var q = normStr(S.query);

  S.list = _DATA.filter(function (item) {
    var gid = String(item.gid);
    var st = storeOf(gid);
    var v = liveCache.get(gid) || null;

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
      for (var i = 0; i < S.tags.length; i++) {
        var tSet = TAG_SETS[S.tags[i]];
        if (!tSet || !tSet.has(gid)) return false;
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
  if (S.sort === "median") {
    S.list.sort(function (a, b) {
      return (b.median || 0) - (a.median || 0) || a.rank - b.rank;
    });
  } else if (S.sort === "count2") {
    S.list.sort(function (a, b) {
      return (b.count2 || 0) - (a.count2 || 0) || a.rank - b.rank;
    });
  } else if (S.sort === "sellday") {
    S.list.sort(function (a, b) {
      return (b.sellday || "").localeCompare(a.sellday || "") || a.rank - b.rank;
    });
  } else {
    // Default: rank
    S.list.sort(function (a, b) {
      return a.rank - b.rank;
    });
  }

  S.count = PAGE_SIZE;
  renderShowcaseGrid();
  updateStatsBar();
}
