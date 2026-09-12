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
  var tabs = document.querySelectorAll("#views .vtab");
  tabs.forEach(function (/** @type {any} */ tab) {
    if (tab.dataset.view === view) tab.classList.add("on");
    else tab.classList.remove("on");
  });

  // Update grid dataset.view
  var grid = document.getElementById("grid");
  if (grid) grid.dataset.view = view;

  // Update onlyMatchedLabel
  var label = document.getElementById("onlyMatchedLabel");
  if (label) label.textContent = ADAPTERS[view].matchedLabel;

  // Update onlyMatched if checked
  var matchedCheck = document.getElementById("onlyMatched");
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
  ADAPTERS: ADAPTERS,
  liveCache: liveCache,
  LIVE_KEY: LIVE_KEY,
  LIVE_BUDGET: LIVE_BUDGET,
  PAGE_SIZE: PAGE_SIZE,
  saveLive: saveLive,
  storeOf: storeOf,
  tagsOf: tagsOf,
  dlEntry: dlEntry,
  dmmEntries: dmmEntries,
  gcEntry: gcEntry,
  relatedOf: relatedOf,
  exactPick: exactPick,
  containsPick: containsPick,
  cleanStr: cleanStr,
  setTab: setTab,
  getTab: getTab,
  getTagSel: getTagSel,
  toggleTag: toggleTag,
  openDetail: openDetail,
  closeDetail: closeDetail,
  openLightbox: openLightbox,
  closeLightbox: closeLightbox,
  stepLightbox: stepLightbox,
  preloadImageUrl: preloadImageUrl,
  preloadLightboxNeighbors: preloadLightboxNeighbors,
  preloadedUrls: preloadedUrls,
  preloadedReady: preloadedReady,
  syncStageAspectRatio: syncStageAspectRatio,
  startRelAutoScroll: startRelAutoScroll,
  stopRelAutoScroll: stopRelAutoScroll,
  chainImgErr: chainImgErr
};

