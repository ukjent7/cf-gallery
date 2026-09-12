  // --- Public View Tab Switcher ---
  function setTab(view) {
    if (!ADAPTERS[view]) return;
    currentTab = view;

    // Update active tab button
    var tabs = document.querySelectorAll("#views .vtab");
    tabs.forEach(function (tab) {
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
    if (matchedCheck) onlyMatched = matchedCheck.checked;

    applyFilter();
  }

  function getTab() {
    return currentTab;
  }

  function getTagSel() {
    return tagSel.slice();
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
  window.GALLERY = {
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

})();
