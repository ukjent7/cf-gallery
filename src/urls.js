// Single source of truth for store ID formats, product URLs, and image paths.
//
// Imported by the Worker (src/index.js) and inlined verbatim into the gallery
// bundle by scripts/bundle.ts. Python data scripts read the same rules out of
// this file rather than re-deriving them, so the three layers cannot drift
// apart again.

// --- validation limits -------------------------------------------------------
var MAX_CID_LEN = 10;      // Getchu numeric id
var MAX_DMM_CID_LEN = 32;
var MAX_DL_ID_LEN = 12;
var GETCHU_SAMPLE_CAP = 40; // per-store display caps: deliberate, not a mismatch
var DMM_SAMPLE_CAP = 60;
var DL_SAMPLE_CAP = 40;

// --- ID shape rules ----------------------------------------------------------
var DOUJIN_RE = /^d_/i;
// FANZA boxed (mono floor) ids are digits + brand letters + digits, e.g.
// 676apc14679, 1272tdi10. The optional trailing letter covers variants like
// 123abc456x. Verified against all 908 cids in the dataset: identical results
// to the stricter form, so the tolerant one is kept.
var BOXED_RE = /^[0-9]+[a-z]+[0-9]+[a-z]?$/i;

function isGetchuCid(cid) {
  return typeof cid === "string" && cid.length >= 1 && cid.length <= MAX_CID_LEN && /^[0-9]+$/.test(cid);
}

function isDmmCid(cid) {
  return typeof cid === "string" && cid.length >= 3 && cid.length <= MAX_DMM_CID_LEN &&
    /^[A-Za-z0-9_]+$/.test(cid);
}

function isDlId(rid) {
  return typeof rid === "string" && rid.length <= MAX_DL_ID_LEN && /^[A-Z]+\d+$/.test(rid);
}

// Domains seen in the dataset (pro 464, maniax 276, home 2, aix 1, bl 1) plus
// the other DLsite storefronts. An unknown/missing domain falls back per work
// type, but a stored domain is always honoured -- rewriting VJ works to maniax
// would 404.
var DL_DOMAINS = ["maniax", "pro", "home", "soft", "bookgirl", "manga", "aix", "bl"];

function isDlDomain(d) {
  return DL_DOMAINS.indexOf(d) >= 0;
}

function isDoujin(cid) { return DOUJIN_RE.test(cid || ""); }
function isBoxed(cid) { return !isDoujin(cid) && BOXED_RE.test(cid || ""); }

// Which FANZA floor a cid belongs to. Used for BOTH the display label and the
// CDN path, so a product can never be labeled 盒装版 while its pictures are
// fetched off the download-floor path.
function dmmFloor(cid) {
  if (isDoujin(cid)) return "doujin";
  if (isBoxed(cid)) return "boxed";
  return "digital";
}

var FLOOR_LABEL = { doujin: "同人", boxed: "盒装版", digital: "下载版" };
function dmmFloorLabel(cid) { return FLOOR_LABEL[dmmFloor(cid)]; }

// --- Getchu ------------------------------------------------------------------
var GC_HOST = "https://www.getchu.com";

function gcProductUrl(cid) { return GC_HOST + "/soft.phtml?id=" + cid; }
function gcCoverUrl(cid) { return GC_HOST + "/brandnew/" + cid + "/rc" + cid + "package.jpg"; }
function gcSampleUrl(cid, n) { return GC_HOST + "/brandnew/" + cid + "/c" + cid + "sample" + n + ".jpg"; }

// --- FANZA -------------------------------------------------------------------
function dmmDetailUrl(cid) {
  var floor = dmmFloor(cid);
  if (floor === "doujin") return "https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=" + cid + "/";
  if (floor === "boxed") return "https://www.dmm.co.jp/mono/pcgame/-/detail/=/cid=" + cid + "/";
  return "https://dlsoft.dmm.co.jp/detail/" + cid + "/";
}

// Image host per floor. doujin lives on its own host; boxed on mono/game;
// download edition on digital/pcgame.
function dmmImageBase(cid) {
  var floor = dmmFloor(cid);
  if (floor === "doujin") return "https://doujin-assets.dmm.co.jp/digital/game/" + cid;
  if (floor === "boxed") return "https://pics.dmm.co.jp/mono/game/" + cid;
  return "https://pics.dmm.co.jp/digital/pcgame/" + cid;
}

// Every floor a cid could plausibly live on, primary first. Used as the
// onerror fallback chain so a misclassified cid still renders.
var DMM_FLOORS = ["digital", "boxed", "doujin"];
function dmmImageBases(cid) {
  var here = dmmFloor(cid);
  var out = [];
  for (var i = 0; i < DMM_FLOORS.length; i++) {
    var floor = DMM_FLOORS[i];
    if (floor === "doujin") out.push("https://doujin-assets.dmm.co.jp/digital/game/" + cid);
    else if (floor === "boxed") out.push("https://pics.dmm.co.jp/mono/game/" + cid);
    else out.push("https://pics.dmm.co.jp/digital/pcgame/" + cid);
  }
  // rotate so the classified floor leads
  var k = out.splice(DMM_FLOORS.indexOf(here), 1)[0];
  return [k].concat(out);
}

function dmmPkgUrl(cid) { return dmmImageBase(cid) + "/" + cid + "pl.jpg"; }
function dmmPkgFallbacks(cid) {
  return dmmImageBases(cid).slice(1).map(function (b) { return b + "/" + cid + "pl.jpg"; });
}
// ps.jpg is the small package thumb on the digital/boxed floors; doujin has none.
function dmmPkgThumb(cid) {
  if (isDoujin(cid)) return dmmPkgUrl(cid);
  return dmmImageBase(cid) + "/" + cid + "ps.jpg";
}
function dmmSampleBig(cid, i) {
  return dmmImageBase(cid) + "/" + cid + "jp-" + String(i).padStart(3, "0") + ".jpg";
}
function dmmSampleSmall(cid, i) {
  return dmmImageBase(cid) + "/" + cid + "js-" + String(i).padStart(3, "0") + ".jpg";
}
// big = full sample for the viewer, small = 120x90 tile for the grid,
// rest = onerror chain (other floors' big then small, primary excluded).
function dmmSampleChain(cid, i) {
  var z = String(i).padStart(3, "0");
  var bases = dmmImageBases(cid);
  var primary = bases[0];
  var rest = [];
  for (var k = 1; k < bases.length; k++) {
    rest.push(bases[k] + "/" + cid + "jp-" + z + ".jpg");
    rest.push(bases[k] + "/" + cid + "js-" + z + ".jpg");
  }
  return {
    big: primary + "/" + cid + "jp-" + z + ".jpg",
    small: primary + "/" + cid + "js-" + z + ".jpg",
    rest: rest
  };
}
function dmmSearchUrl(q) {
  return "https://www.dmm.co.jp/search/=/searchstr=" + encodeURIComponent(q);
}

// --- DLsite ------------------------------------------------------------------
var DL_IMG = "https://img.dlsite.jp";

// RJxxxxxx -> VJ00xxxxxx style grouping folder: id digits rounded up to the
// next thousand, zero padded to the same width.
function dlFolder(rid) {
  var m = /^([A-Z]+)(\d+)$/.exec(rid || "");
  if (!m) return "RJ00000000";
  var digits = m[2];
  var g = (Math.floor((parseInt(digits, 10) - 1) / 1000) + 1) * 1000;
  return m[1] + String(g).padStart(digits.length, "0");
}

function dlWorkType(rid) {
  return String(rid || "").indexOf("VJ") === 0 ? "professional" : "doujin";
}

// DLsite mirrors every work under its canonical domain and falls back to
// maniax for adult doujin.
function dlDomainFor(rid, domain) {
  if (isDlDomain(domain)) return domain;
  return dlWorkType(rid) === "professional" ? "pro" : "maniax";
}

function dlProductUrl(rid, domain) {
  return "https://www.dlsite.com/" + dlDomainFor(rid, domain) + "/work/=/product_id/" + rid + ".html";
}

function dlPath(d) {
  return dlWorkType(d.id) + "/" + dlFolder(d.id) + "/" + d.id;
}

function dlMainUrl(d) { return DL_IMG + "/modpub/images2/work/" + dlPath(d) + "_img_main.webp"; }
function dlMainThumbUrl(d) { return DL_IMG + "/resize/images2/work/" + dlPath(d) + "_img_main_240x240.webp"; }
function dlSampleUrl(d, stem) { return DL_IMG + "/modpub/images2/work/" + dlPath(d) + "_img_" + stem + ".webp"; }
function dlSampleThumbUrl(d, stem) { return DL_IMG + "/resize/images2/work/" + dlPath(d) + "_img_" + stem + "_100x100.jpg"; }
function dlJpg(u) { return String(u).replace(/\.webp$/, ".jpg"); }

// Sample stems. Only stored when not the plain smp1..smpN run, because that run
// is already implied by n. d.un marks products where the build knew a count but
// never harvested the names: the plain run is then a *guess* (verified right for
// 10 of the 11 such products), so the gallery renders it but also asks live meta
// once and replaces the grid if the real names differ.
function dlStems(d) {
  if (!d) return [];
  if (d.sm && d.sm.length) return d.sm.slice(0, DL_SAMPLE_CAP);
  var n = Math.min(d.n || 0, DL_SAMPLE_CAP);
  var out = [];
  for (var i = 1; i <= n; i++) out.push("smp" + i);
  return out;
}

function dlSamples(d) { return dlStems(d).map(function (s) { return dlSampleUrl(d, s); }); }
function dlSampleThumbs(d) { return dlStems(d).map(function (s) { return dlSampleThumbUrl(d, s); }); }

// --- ErogameScape ------------------------------------------------------------
function egsUrl(gid) {
  return "https://erogamescape.dyndns.org/~ap2/ero/toukei_kaiseki/game.php?game=" + gid;
}
function egsImg(gid, n) {
  return "https://ap2.sakura.ne.jp/erogamescape/img_official/" +
    Math.floor(Number(gid) / 1000) + "/" + gid + "/" + String(n).padStart(3, "0") + ".jpg";
}

// --- VNDB --------------------------------------------------------------------
function vnThumb(url) {
  return String(url || "").replace(/(t\.vndb\.org\/)([a-z]+)\//, "$1$2.t/");
}
function vnUrl(vid) { return "https://vndb.org/" + vid; }
function vnSearchUrl(name) { return "https://vndb.org/v?sq=" + encodeURIComponent(name); }

// --- Worker proxy paths ------------------------------------------------------
// Always rooted, so the gallery works under a non-root base path too.
// (The export list the Worker and tests need lives at the bottom of this
// file; scripts/bundle.ts strips ESM export statements when inlining the
// file into the gallery, which runs without a module loader.)
function gcApiMeta(cid) { return "/gc/meta/" + encodeURIComponent(cid); }
function gcApiCover(cid) { return "/gc/cover/" + cid + ".jpg"; }
function gcApiSample(cid, n) { return "/gc/sample/" + cid + "/" + n + ".jpg"; }
function dmApiMeta(cid) { return "/dm/meta/" + encodeURIComponent(cid); }
function dlApiMeta(rid, domain) {
  return "/dl/meta/" + encodeURIComponent(rid) + "?domain=" + encodeURIComponent(domain || "maniax");
}

// --- HTML scrapers -----------------------------------------------------------
// Shared with the Python crawl scripts, which mirror these regexes. Parity is
// verified at the data level: test/build.test.js checks that the JS functions
// reproduce the Python-crawled facts in data/store_cache.json across the
// whole dataset, and the fixture test at the bottom of that file pins the
// regex shapes.

function reEscape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Largest sample index on a Getchu product page.
function parseSampleMax(cid, html) {
  var re = new RegExp("c" + reEscape(cid) + "sample(\\d+)\\.jpg", "g");
  var m;
  var max = 0;
  while ((m = re.exec(html)) !== null) {
    var v = parseInt(m[1], 10);
    if (v > max) max = v;
  }
  return max;
}

// Largest sample index on a FANZA detail page. jp- is full size, js- is the
// 120x90 thumbnail; both carry the same index.
function parseDmmMax(cid, html) {
  var re = new RegExp(reEscape(cid) + "(js|jp)-(\\d+)\\.jpg", "g");
  var m;
  var max = 0;
  while ((m = re.exec(html)) !== null) {
    var v = parseInt(m[2], 10);
    if (v > max) max = v;
  }
  return max;
}

// Sample stems on a DLsite product page. Stems vary per product (smp1 vs
// smpa1) and cannot be derived from the id, which is why non-default stems are
// stored in the payload.
function parseDlStems(rid, html) {
  var re = new RegExp(reEscape(rid) + "_img_(smp[a-z]*\\d+)\\.(?:jpg|webp)", "g");
  var m;
  var seen = {};
  var out = [];
  while ((m = re.exec(html)) !== null) {
    if (!seen[m[1]]) {
      seen[m[1]] = true;
      out.push(m[1]);
    }
  }
  out.sort(function (a, b) {
    var ma = /^smp([a-z]*)(\d+)$/.exec(a);
    var mb = /^smp([a-z]*)(\d+)$/.exec(b);
    if (ma[1] !== mb[1]) return ma[1] < mb[1] ? -1 : 1;
    return parseInt(ma[2], 10) - parseInt(mb[2], 10);
  });
  return out;
}

export {
  BOXED_RE,
  DL_SAMPLE_CAP,
  DMM_SAMPLE_CAP,
  DOUJIN_RE,
  GETCHU_SAMPLE_CAP,
  MAX_CID_LEN,
  MAX_DL_ID_LEN,
  MAX_DMM_CID_LEN,
  dlApiMeta,
  dlDomainFor,
  dlFolder,
  dlJpg,
  dlMainThumbUrl,
  dlMainUrl,
  dlProductUrl,
  dlSampleThumbUrl,
  dlSampleUrl,
  dlSamples,
  dlStems,
  dlWorkType,
  dmApiMeta,
  dmmDetailUrl,
  dmmFloor,
  dmmFloorLabel,
  dmmImageBase,
  dmmImageBases,
  dmmPkgFallbacks,
  dmmPkgThumb,
  dmmPkgUrl,
  dmmSampleBig,
  dmmSampleChain,
  dmmSampleSmall,
  dmmSearchUrl,
  egsImg,
  egsUrl,
  gcApiCover,
  gcApiMeta,
  gcApiSample,
  gcCoverUrl,
  gcProductUrl,
  gcSampleUrl,
  isBoxed,
  isDoujin,
  isDlDomain,
  isDlId,
  isDmmCid,
  isGetchuCid,
  parseDlStems,
  parseDmmMax,
  parseSampleMax,
  reEscape,
  vnThumb,
  vnUrl,
  vnSearchUrl,
};
