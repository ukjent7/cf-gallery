  // --- Normalization & Matching Algorithms ---
  function normStr(s) {
    if (!s) return "";
    return String(s)
      .replace(/[\s\u3000]*[~～〜-][\s\u3000]*/g, "~")
      .trim()
      .toLowerCase();
  }

  function cleanStr(s) {
    if (!s) return "";
    return String(s)
      .replace(/[\s\u3000~～〜\-_・:：!！?？「」『』()[\]【】―—]+/g, " ")
      .trim()
      .toLowerCase();
  }

  function exactPick(candidates, titles, item) {
    if (!candidates || !candidates.length || !titles || !titles.length) return null;
    var targetNorms = titles.map(normStr);
    var targetCleans = titles.map(cleanStr);
    var matched = [];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var cT = normStr(c.title);
      var cA = normStr(c.alttitle);
      var cTClean = cleanStr(c.title);
      var cAClean = cleanStr(c.alttitle);
      if (
        targetNorms.indexOf(cT) >= 0 || (c.alttitle && targetNorms.indexOf(cA) >= 0) ||
        targetCleans.indexOf(cTClean) >= 0 || (c.alttitle && targetCleans.indexOf(cAClean) >= 0)
      ) {
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
    var qClean = cleanStr(coreTitle);
    var matched = [];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var cT = normStr(c.title);
      var cA = normStr(c.alttitle);
      var cTClean = cleanStr(c.title);
      var cAClean = cleanStr(c.alttitle);
      if (
        cT.indexOf(q) >= 0 || (c.alttitle && cA.indexOf(q) >= 0) ||
        (qClean && (cTClean.indexOf(qClean) >= 0 || (c.alttitle && cAClean.indexOf(qClean) >= 0)))
      ) {
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

  // Inverted tag index: the AND filter and tag badges run per card, so
  // membership must be O(1), not indexOf over the 534-entry 堕ちる過程 array.
  // TAGS is build-time data and never mutates at runtime.
  var TAG_SETS = {};
  var GID_TAGS = new Map();
  var TAG_KEYS = Object.keys(_TAGS);
  for (var _ti = 0; _ti < TAG_KEYS.length; _ti++) {
    var _tag = TAG_KEYS[_ti];
    var _set = new Set(_TAGS[_tag].map(String));
    TAG_SETS[_tag] = _set;
    _set.forEach(function (gid) {
      var list = GID_TAGS.get(gid);
      if (list) list.push(_tag);
      else GID_TAGS.set(gid, [_tag]);
    });
  }

  function tagsOf(gid) {
    var list = GID_TAGS.get(String(gid));
    return list ? list.slice() : [];
  }

  function cleanGameTitle(name) {
    if (!name) return "";
    return name
      .replace(/\([^)]*(?:DOS|Win|Windows|CD|DVD|FD|PC-?98|DL|APP|Mac|PS|SS)[^)]*\)/gi, " ")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/[0-9０-９一二三四五六七八九十IVXLCDMivxlcdm\s～〜\-:：!！?？・.+*★☆♡❤︎/／#＃&＆]+/g, " ")
      .trim();
  }

  function getSignificantTokens(name) {
    var cleaned = cleanGameTitle(name);
    var matches = cleaned.match(/[a-zA-Z]{3,}|[\u30a0-\u30ff]{2,}|[\u4e00-\u9fa5]{2,}/g) || [];
    var stopWords = {
      "完全版": 1, "通常版": 1, "初回版": 1, "劇場版": 1, "外伝": 1, "前編": 1, "後編": 1, "特别版": 1, "体验版": 1, "リメイク": 1,
      "dos": 1, "win": 1, "remake": 1, "edition": 1, "version": 1, "plus": 1, "special": 1, "fandisc": 1, "disc": 1
    };
    return matches.filter(function (t) { return !stopWords[t.toLowerCase()]; });
  }

  function isSeriesMatch(nameA, nameB) {
    if (!nameA || !nameB) return false;
    var crossMap = {
      "rance": "ランス", "ランス": "rance",
      "white album": "ホワイトアルバム",
      "toheart": "トゥハート",
      "dc": "ダ・カーポ"
    };
    var tokensA = getSignificantTokens(nameA);
    var tokensB = getSignificantTokens(nameB);

    for (var i = 0; i < tokensA.length; i++) {
      var tA = tokensA[i];
      var lowA = tA.toLowerCase();
      var crossA = crossMap[lowA];
      for (var j = 0; j < tokensB.length; j++) {
        var tB = tokensB[j];
        var lowB = tB.toLowerCase();
        if (lowA === lowB) return true;
        if (crossA && lowB.indexOf(crossA) !== -1) return true;
        if (crossMap[lowB] && lowA.indexOf(crossMap[lowB]) !== -1) return true;
        if (tA.length >= 3 && tB.length >= 3) {
          if (tA.indexOf(tB) !== -1 || tB.indexOf(tA) !== -1) return true;
        }
      }
    }
    return false;
  }

  function relatedOf(item, vndbItem) {
    if (!item || !item.brand) return [];
    var bg = _BRANDG[item.brand] || item.brand;
    var rel = [];
    var sid = String(item.gid);
    for (var i = 0; i < DATA.length; i++) {
      var d = DATA[i];
      if (String(d.gid) === sid) continue;
      var dbg = _BRANDG[d.brand] || d.brand;
      if (dbg === bg) {
        var isSeries = isSeriesMatch(item.name, d.name);
        rel.push(Object.assign({}, d, { sameBrand: true, sameSeries: isSeries }));
      }
    }
    // Prioritize series siblings first, then rank by highest median
    rel.sort(function (a, b) {
      if (a.sameSeries && !b.sameSeries) return -1;
      if (!a.sameSeries && b.sameSeries) return 1;
      return (b.median || 0) - (a.median || 0);
    });
    return rel.slice(0, 8);
  }

