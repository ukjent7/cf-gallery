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
          var tSet = TAG_SETS[tagSel[i]];
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

