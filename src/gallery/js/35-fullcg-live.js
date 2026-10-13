// --- Group / Circle Mapping & Romaji Search Helpers for External Full-CG ---
import { _BRANDG, USE_GC } from "./00-head.js";
import { storeOf } from "./10-match.js";
import { sessionMetaCache } from "./15-state.js";
import { preloadImageUrl } from "./45-rails-preload.js";
import { openLightbox } from "./50-lightbox.js";

function slugify(s) {
  return String(s == null ? "" : s).toLowerCase()
    .replace(/-/g, "_").replace(/[^a-z0-9 _]+/g, "")
    .replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function brandSlug(brand) {
  const b = String(brand == null ? "" : brand).trim().replace(/・/g, " ");
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.'-]{0,40}$/.test(b)) return null;
  return slugify(b) || null;
}

export function groupFor(brand) {
  const k = String(brand == null ? "" : brand).trim();
  if (_BRANDG[k]) {
    const s = slugify(_BRANDG[k]);
    if (s) return s;
  }
  return brandSlug(brand);
}

function isLatin(s) {
  return typeof s === "string" && s.trim().length > 0 && !/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(s);
}

export function romajiTitle(item, v) {
  if (v) {
    if (isLatin(v.title)) return v.title.trim();
    if (isLatin(v.alttitle)) return v.alttitle.trim();
  }
  if (isLatin(item.name)) return item.name.trim();
  return (v && (v.title || v.alttitle)) ? (v.title || v.alttitle).trim() : item.name.trim();
}

export function coreTitle(title) {
  if (!title) return "";
  const m = title.match(/^([^~～:\-–—]+?)(?:\s+[-–—~～:]|\s*~|\s*～)/);
  return (m && m[1].trim().length >= 2) ? m[1].trim() : title.trim();
}

function cleanSearchTitle(title) {
  if (!title) return "";
  return title.replace(/"/g, "").replace(/\bCG\b/gi, "").replace(/\s+/g, " ").trim();
}

export function hitomiSiteUrl(item, v) {
  const parts = ["type:gamecg"];
  const g = groupFor(item.brand);
  if (g) parts.push("group:" + g);
  const t = cleanSearchTitle(coreTitle(romajiTitle(item, v)))
    .replace(/[~:!?,/\\()[\]{}*+^$#@|<>]/g, " ")
    .replace(/(^|\s)-+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (t) parts.push(t);
  return "https://hitomi.la/search.html?" + encodeURIComponent(parts.join(" "));
}

export function ehSiteUrl(item, v) {
  const parts = [];
  const g = groupFor(item.brand);
  if (g) parts.push("group:" + g + "$");
  const t = cleanSearchTitle(coreTitle(romajiTitle(item, v)));
  if (t) parts.push('title:"' + t + '"');
  return "https://e-hentai.org/?f_search=" + encodeURIComponent(parts.join(" ")) + "&f_apply=Apply+Filter";
}

export function fullcgGoogleUrl(site, item, v) {
  const raw = cleanSearchTitle(coreTitle(romajiTitle(item, v)));
  let q = 'site:' + site + ' "' + raw + '"';
  if (item.name && item.name !== raw) {
    q += ' OR "' + cleanSearchTitle(item.name) + '"';
  }
  if (site.startsWith("hitomi")) q = "gamecg " + q;
  return "https://www.google.com/search?q=" + encodeURIComponent(q);
}

// Attach lightbox + prefetch listeners to every image in a rebuilt strip.
export function attachStripListeners(imgs, item) {
  imgs.forEach((imgEl, idx) => {
    imgEl.addEventListener("click", () => {
      openLightbox(imgEl.getAttribute("data-full"), (idx + 1) + " / " + imgs.length + " " + item.name, imgs, idx, item);
    });
    imgEl.addEventListener("mouseenter", () => {
      preloadImageUrl(imgEl.getAttribute("data-full") || imgEl.src);
    });
  });
}

// One plumbing path for the DLsite/FANZA/Getchu live-count refreshes:
// guarded single-flight fetch, count written back onto the store entry by
// update(), strip rebuilt by render(), listeners re-attached.
export function refreshLiveMeta(cacheKey, url, update, sectionSel, countName, render, item) {
  if (!USE_GC || sessionMetaCache.has(cacheKey)) return;
  sessionMetaCache.add(cacheKey);

  fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .then((res) => {
      if (!update(res)) return;
      const sec = document.querySelector(sectionSel);
      if (!sec) return;
      const cnt = sec.querySelector('[data-livecount="' + countName + '"]');
      const st = (storeOf(item.gid) || {})[countName === "dl" ? "l" : countName === "gc" ? "g" : "m"];
      const n = (st && st.n) || (st && st.sm ? st.sm.length : 0);
      if (cnt && n) cnt.textContent = String(n);
      const strip = sec.querySelector(".strip");
      if (strip) {
        strip.innerHTML = render();
        attachStripListeners(strip.querySelectorAll("img"), item);
      }
    })
    .catch(() => {});
}
