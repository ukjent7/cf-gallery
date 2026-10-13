// --- Normalization & Matching Algorithms ---
import { _BRANDG, _DATA, _STORE, _TAGS } from "./00-head.js";

export function normStr(s) {
  if (!s) return "";
  return String(s)
    .replace(/[\s\u3000]*[~～〜-][\s\u3000]*/g, "~")
    .trim()
    .toLowerCase();
}

export function cleanStr(s) {
  if (!s) return "";
  return String(s)
    .replace(/[\s\u3000~～〜\-_・:：!！?？「」『』()[\]【】―—]+/g, " ")
    .trim()
    .toLowerCase();
}

export function exactPick(candidates, titles, item) {
  if (!candidates?.length || !titles?.length) return null;
  const targetNorms = titles.map(normStr);
  const targetCleans = titles.map(cleanStr);
  const matched = [];
  for (const c of candidates) {
    const cT = normStr(c.title);
    const cA = normStr(c.alttitle);
    const cTClean = cleanStr(c.title);
    const cAClean = cleanStr(c.alttitle);
    if (
      targetNorms.includes(cT) || (c.alttitle && targetNorms.includes(cA)) ||
      targetCleans.includes(cTClean) || (c.alttitle && targetCleans.includes(cAClean))
    ) {
      matched.push(c);
    }
  }
  if (!matched.length) return null;
  if (matched.length === 1) return matched[0];
  if (item && item.sellday) {
    const y = item.sellday.slice(0, 4);
    const yMatch = matched.find((c) => c.released && c.released.startsWith(y));
    if (yMatch) return yMatch;
  }
  return matched[0];
}

export function containsPick(candidates, coreTitle, item) {
  if (!candidates?.length || !coreTitle) return null;
  const q = normStr(coreTitle);
  const qClean = cleanStr(coreTitle);
  const matched = [];
  for (const c of candidates) {
    const cT = normStr(c.title);
    const cA = normStr(c.alttitle);
    const cTClean = cleanStr(c.title);
    const cAClean = cleanStr(c.alttitle);
    if (
      cT.includes(q) || (c.alttitle && cA.includes(q)) ||
      (qClean && (cTClean.includes(qClean) || (c.alttitle && cAClean.includes(qClean))))
    ) {
      matched.push(c);
    }
  }
  if (!matched.length) return null;
  if (item && item.sellday) {
    const y = item.sellday.slice(0, 4);
    const yMatch = matched.find((c) => c.released && c.released.startsWith(y));
    if (yMatch) return yMatch;
  }
  return matched[0];
}

// --- Entity Lookup Helpers ---
export function storeOf(gid) {
  return _STORE[String(gid)] || null;
}

export function dlEntry(st) {
  return st && st.l ? st.l : null;
}

export function dmmEntries(st) {
  const out = [];
  if (st) {
    if (st.m) out.push(st.m);
    if (st.m2) out.push(st.m2);
  }
  return out;
}

export function gcEntry(st) {
  return st && st.g ? st.g : null;
}

// Inverted tag index: the AND filter and tag badges run per card, so
// membership must be O(1), not indexOf over the 534-entry 堕ちる過程 array.
// TAGS is build-time data and never mutates at runtime.
export const TAG_SETS = {};
const GID_TAGS = new Map();
const TAG_KEYS = Object.keys(_TAGS);
for (const _tag of TAG_KEYS) {
  const _set = new Set(_TAGS[_tag].map(String));
  TAG_SETS[_tag] = _set;
  _set.forEach((gid) => {
    const list = GID_TAGS.get(gid);
    if (list) list.push(_tag);
    else GID_TAGS.set(gid, [_tag]);
  });
}

export function tagsOf(gid) {
  const list = GID_TAGS.get(String(gid));
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
  const cleaned = cleanGameTitle(name);
  const matches = cleaned.match(/[a-zA-Z]{3,}|[\u30a0-\u30ff]{2,}|[\u4e00-\u9fa5]{2,}/g) || [];
  const stopWords = {
    "完全版": 1, "通常版": 1, "初回版": 1, "劇場版": 1, "外传": 1, "外伝": 1, "前編": 1, "後編": 1, "特别版": 1, "体验版": 1, "リメイク": 1,
    "dos": 1, "win": 1, "remake": 1, "edition": 1, "version": 1, "plus": 1, "special": 1, "fandisc": 1, "disc": 1
  };
  return matches.filter((t) => !stopWords[t.toLowerCase()]);
}

function isSeriesMatch(nameA, nameB) {
  if (!nameA || !nameB) return false;
  const crossMap = {
    "rance": "ランス", "ランス": "rance",
    "white album": "ホワイトアルバム",
    "toheart": "トゥハート",
    "dc": "ダ・カーポ"
  };
  const tokensA = getSignificantTokens(nameA);
  const tokensB = getSignificantTokens(nameB);

  for (const tA of tokensA) {
    const lowA = tA.toLowerCase();
    const crossA = crossMap[lowA];
    for (const tB of tokensB) {
      const lowB = tB.toLowerCase();
      if (lowA === lowB) return true;
      if (crossA && lowB.includes(crossA)) return true;
      if (crossMap[lowB] && lowA.includes(crossMap[lowB])) return true;
      if (tA.length >= 3 && tB.length >= 3) {
        if (tA.includes(tB) || tB.includes(tA)) return true;
      }
    }
  }
  return false;
}

export function relatedOf(item, vndbItem) {
  if (!item || !item.brand) return [];
  const bg = _BRANDG[item.brand] || item.brand;
  const rel = [];
  const sid = String(item.gid);
  for (const d of _DATA) {
    if (String(d.gid) === sid) continue;
    const dbg = _BRANDG[d.brand] || d.brand;
    if (dbg === bg) {
      const isSeries = isSeriesMatch(item.name, d.name);
      rel.push({ ...d, sameBrand: true, sameSeries: isSeries });
    }
  }
  // Prioritize series siblings first, then rank by highest median
  rel.sort((a, b) => {
    if (a.sameSeries && !b.sameSeries) return -1;
    if (!a.sameSeries && b.sameSeries) return 1;
    return (b.median || 0) - (a.median || 0);
  });
  return rel.slice(0, 8);
}
