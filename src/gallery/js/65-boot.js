// --- Public View Tab Switcher ---
import { _BRANDG, _CACHE, _DATA, _FULLCG, _STORE, _TAGS, liveCache, LIVE_BUDGET, LIVE_KEY, PAGE_SIZE, saveLive } from "./00-head.js";
import { cleanStr, containsPick, dlEntry, dmmEntries, exactPick, gcEntry, relatedOf, storeOf, tagsOf } from "./10-match.js";
import { ADAPTERS, S } from "./15-state.js";
import { applyFilter } from "./20-filter.js";
import { chainImgErr } from "./25-artwork.js";
import { renderTagChips, toggleTag } from "./30-cards.js";
import { closeDetail, openDetail } from "./40-drawer.js";
import { preloadedReady, preloadedUrls, preloadImageUrl, preloadLightboxNeighbors, startRelAutoScroll, stopRelAutoScroll } from "./45-rails-preload.js";
import { closeLightbox, openLightbox, stepLightbox, syncStageAspectRatio } from "./50-lightbox.js";
import { initGallery } from "./60-events.js";

export function setTab(view) {
  if (!ADAPTERS[view]) return;
  S.tab = view;

  // Update active tab button
  const tabs = document.querySelectorAll("#views .vtab");
  tabs.forEach((/** @type {any} */ tab) => {
    if (tab.dataset.view === view) tab.classList.add("on");
    else tab.classList.remove("on");
  });

  // Update grid dataset.view
  const grid = document.getElementById("grid");
  if (grid) grid.dataset.view = view;

  // Update onlyMatchedLabel
  const label = document.getElementById("onlyMatchedLabel");
  if (label) label.textContent = ADAPTERS[view].matchedLabel;

  // Update onlyMatched if checked
  const matchedCheck = document.getElementById("onlyMatched");
  if (matchedCheck) S.matched = /** @type {HTMLInputElement} */ (matchedCheck).checked;

  applyFilter();
}

export function getTab() {
  return S.tab;
}

export function getTagSel() {
  return S.tags.slice();
}

// Auto-boot on DOM ready or immediate
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initGallery);
  } else {
    initGallery();
  }
}

// --- Export Global GALLERY Contract ---
/** @type {any} */ (window).GALLERY = {
  DATA: _DATA,
  STORE: _STORE,
  CACHE: _CACHE,
  TAGS: _TAGS,
  FULLCG: _FULLCG,
  BRANDG: _BRANDG,
  ADAPTERS,
  liveCache,
  LIVE_KEY,
  LIVE_BUDGET,
  PAGE_SIZE,
  saveLive,
  storeOf,
  tagsOf,
  dlEntry,
  dmmEntries,
  gcEntry,
  relatedOf,
  exactPick,
  containsPick,
  cleanStr,
  setTab,
  getTab,
  getTagSel,
  toggleTag,
  openDetail,
  closeDetail,
  openLightbox,
  closeLightbox,
  stepLightbox,
  preloadImageUrl,
  preloadLightboxNeighbors,
  preloadedUrls,
  preloadedReady,
  syncStageAspectRatio,
  startRelAutoScroll,
  stopRelAutoScroll,
  chainImgErr
};
