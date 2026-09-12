import { _TAGS, PAGE_SIZE } from "./00-head.js";

// --- Multi-Source Adapters ---
// One predicate over a declarative spec; views only declare labels plus
// which evidence counts, so the five branches cannot drift apart.
function hasVndbArt(v) {
  return Boolean(v && (v.img || (v.shots && v.shots.length)));
}

function hasStoreRow(st) {
  return Boolean(st && (st.l || st.m || st.m2 || st.g));
}

var ADAPTER_SPECS = {
  all: { navLabel: "综合", matchedLabel: "只看有图", any: true },
  vndb: { navLabel: "VNDB", matchedLabel: "只看已匹配", vndb: true },
  dlsite: { navLabel: "DLsite", matchedLabel: "只看DLsite", stores: ["l"] },
  dmm: { navLabel: "FANZA", matchedLabel: "只看FANZA", stores: ["m", "m2"] },
  getchu: { navLabel: "Getchu", matchedLabel: "只看Getchu", stores: ["g"] }
};

function specHas(spec, item, st, v) {
  if (spec.vndb) return hasVndbArt(v);
  if (spec.stores) return spec.stores.some(function (k) { return Boolean(st && st[k]); });
  return hasVndbArt(v) || hasStoreRow(st);
}

export var ADAPTERS = {};
Object.keys(ADAPTER_SPECS).forEach(function (key) {
  var spec = ADAPTER_SPECS[key];
  ADAPTERS[key] = { navLabel: spec.navLabel, matchedLabel: spec.matchedLabel, has: specHas.bind(null, spec) };
});

// --- State Variables ---
// One shared object: ESM bindings are read-only in consumers, so cross-file
// updates go through property assignment, never rebinding.
export var S = {
  tab: "all",
  sort: "rank",
  density: 0, // 0: auto, 1: compact, 2: large
  med: 0,
  tags: [],
  matched: false,
  query: "",
  count: PAGE_SIZE,
  list: [],
  safe: false,
  boss: false,
  audio: true,
  focus: 0
};
export var sessionMetaCache = new Set();
export var origDocTitle = typeof document !== "undefined" ? document.title : "";
var audioCtx = null;

// --- Sound Effects Synthesis ---
export function playBeep(freq, type, dur) {
  if (!S.audio || typeof window === "undefined") return;
  try {
    if (!audioCtx) {
      var AudioContext = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
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
      S.tags = parsedUi.tags.filter(function (t) { return t in _TAGS; });
    }
  }
} catch (_) {
  S.tags = [];
}

export function persistTags() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem("ui_v1", JSON.stringify({ tags: S.tags }));
  } catch (_) {}
}

