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

