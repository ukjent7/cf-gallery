// --- Event Wireup & Boot Initializer ---
import { storeOf } from "./10-match.js";
import { persistTags, playBeep, S } from "./15-state.js";
import { applyFilter } from "./20-filter.js";
import { chainImgErr, checkImgLoaded } from "./25-artwork.js";
import { renderNextPage, renderTagChips } from "./30-cards.js";
import { closeDetail, openDetail } from "./40-drawer.js";
import { closeLightbox, LB, setLightboxImage, stepLightbox } from "./50-lightbox.js";
import { toggleBossMode, triggerFateRoller } from "./55-vndb-chrome.js";
import { setTab } from "./65-boot.js";
export function initGallery() {
  // 0. Delegated cover-image fallback: load/error do not bubble, but a
  // capture listener on each container replaces every inline
  // onload/onerror attribute in the card, rail, and strip templates.
  // window.chainImgErr / window.checkImgLoaded stay as the testable units.
  var gridEl = document.getElementById("grid");
  var dbodyEl = document.getElementById("dbody");
  [gridEl, dbodyEl].forEach(function (root) {
    if (!root) return;
    root.addEventListener("error", function (/** @type {any} */ e) {
      if (e.target && e.target.tagName === "IMG") chainImgErr(e.target);
    }, true);
    root.addEventListener("load", function (/** @type {any} */ e) {
      if (e.target && e.target.tagName === "IMG") checkImgLoaded(e.target);
    }, true);
  });

  // 1. Data Source View Tabs
  var viewsNav = document.getElementById("views");
  if (viewsNav) {
    viewsNav.addEventListener("click", function (/** @type {any} */ e) {
      var tab = e.target.closest(".vtab");
      if (tab && tab.dataset.view) {
        playBeep(520, "sine", 0.03);
        setTab(tab.dataset.view);
      }
    });
  }

  // 2. Sort Dimension Selector
  var sortSelect = /** @type {HTMLSelectElement} */ (document.getElementById("sort"));
  if (sortSelect) {
    sortSelect.addEventListener("change", function () {
      S.sort = sortSelect.value;
      playBeep(450, "sine", 0.03);
      applyFilter();
    });
  }

  // 3. Density Cycler
  var densityBtn = document.getElementById("density");
  var grid = document.getElementById("grid");
  if (densityBtn && grid) {
    densityBtn.addEventListener("click", function () {
      S.density = (S.density + 1) % 3;
      playBeep(500, "triangle", 0.04);
      if (S.density === 0) {
        densityBtn.textContent = "密度：自动";
        grid.classList.remove("density-compact", "density-large");
      } else if (S.density === 1) {
        densityBtn.textContent = "密度：紧凑";
        grid.classList.add("density-compact");
        grid.classList.remove("density-large");
      } else if (S.density === 2) {
        densityBtn.textContent = "密度：大图";
        grid.classList.add("density-large");
        grid.classList.remove("density-compact");
      }
    });
  }

  // 4. Only Matched Checkbox
  var matchedCheck = /** @type {HTMLInputElement} */ (document.getElementById("onlyMatched"));
  if (matchedCheck) {
    matchedCheck.addEventListener("change", function () {
      S.matched = matchedCheck.checked;
      playBeep(400, "sine", 0.03);
      applyFilter();
    });
  }

  // 5. Omni Search Input
  var searchInput = /** @type {HTMLInputElement} */ (document.getElementById("omniSearch"));
  if (searchInput) {
    searchInput.addEventListener("input", function () {
      S.query = searchInput.value.trim();
      applyFilter();
    });
  }

  // 6. Median Score Filter Chips
  var medChips = document.getElementById("medchips");
  if (medChips) {
    medChips.addEventListener("click", function (/** @type {any} */ e) {
      var chip = e.target.closest(".fchip");
      if (chip && chip.dataset.med !== undefined) {
        S.med = Number(chip.dataset.med);
        playBeep(540, "sine", 0.03);
        medChips.querySelectorAll(".fchip").forEach(function (/** @type {any} */ c) {
          c.classList.toggle("on", Number(c.dataset.med) === S.med);
        });
        applyFilter();
      }
    });
  }

  // 7. Reset Filter Button
  var resetBtn = document.getElementById("reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", function () {
      playBeep(350, "square", 0.06);
      S.tags = [];
      S.med = 0;
      S.query = "";
      if (searchInput) searchInput.value = "";
      persistTags();
      renderTagChips();
      if (medChips) {
        medChips.querySelectorAll(".fchip").forEach(function (/** @type {any} */ c) {
          c.classList.toggle("on", c.dataset.med === "0");
        });
      }
      applyFilter();
    });
  }

  // 8. Load More Button & Intersection Observer
  var moreBtn = document.getElementById("more");
  if (moreBtn) {
    moreBtn.addEventListener("click", function () {
      renderNextPage();
    });

    if (typeof window.IntersectionObserver !== "undefined") {
      var observer = new window.IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting && moreBtn.style.display !== "none") {
            renderNextPage();
          }
        }
      });
      observer.observe(moreBtn);
    }
  }

  // 9. Drawer Controls
  var dclose = document.getElementById("dclose");
  if (dclose) dclose.addEventListener("click", closeDetail);

  var drawerOverlay = document.getElementById("drawer");
  if (drawerOverlay) {
    var backdrop = drawerOverlay.querySelector(".backdrop");
    if (backdrop) {
      backdrop.addEventListener("click", function (/** @type {any} */ e) {
        var sel = window.getSelection ? window.getSelection().toString().trim() : "";
        if (sel.length > 0) return;
        if (e.target === backdrop) closeDetail();
      });
    }
  }

  // 10. Lightbox Controls
  var vprev = document.getElementById("vprev");
  if (vprev) {
    vprev.addEventListener("click", function () {
      stepLightbox(-1);
    });
  }

  var vnext = document.getElementById("vnext");
  if (vnext) {
    vnext.addEventListener("click", function () {
      stepLightbox(1);
    });
  }

  var vclose = document.getElementById("vclose");
  if (vclose) vclose.addEventListener("click", closeLightbox);

  var vopen = document.getElementById("vopen");
  if (vopen) {
    vopen.addEventListener("click", function () {
      var vimg = /** @type {HTMLImageElement} */ (document.getElementById("vimg"));
      if (vimg) {
        var targetUrl = vimg.getAttribute("src") || vimg.src;
        if (targetUrl) window.open(targetUrl);
      }
    });
  }

  // Mouse wheel image switching with inertia throttle
  var lastLbWheelTime = 0;
  var lbEl = document.getElementById("lightbox");
  if (lbEl) {
    lbEl.addEventListener("wheel", function (/** @type {any} */ e) {
      if (!lbEl.classList.contains("open") || !LB.imgs.length) return;
      // Keep natural scroll on bottom thumbnail strip
      if (e.target.closest("#vthumbs")) return;

      if (e.preventDefault) e.preventDefault();

      var now = Date.now();
      if (now - lastLbWheelTime < 180) return;

      var dy = e.deltaY;
      var dx = e.deltaX;
      if (dy === undefined && dx === undefined) return;
      if (Math.abs(dy || 0) < 6 && Math.abs(dx || 0) < 6) return;

      lastLbWheelTime = now;
      if ((dy !== undefined && dy > 0) || (dx !== undefined && dx > 0)) {
        stepLightbox(1);
      } else {
        stepLightbox(-1);
      }
    }, { passive: false });

    // Allow closing lightbox by clicking backdrop/viewport outside image and controls
    lbEl.addEventListener("click", function (/** @type {any} */ e) {
      if (
        e.target.closest("#vimg") ||
        e.target.closest(".lb-nav-arrow") ||
        e.target.closest(".lightbox-controls") ||
        e.target.closest("#vthumbs") ||
        e.target.closest("#vcap") ||
        e.target.closest(".lb-error-tip") ||
        e.target.closest(".lb-spinner")
      ) {
        return;
      }
      closeLightbox();
    });

    var lbRetryBtn = document.getElementById("lbRetryBtn");
    if (lbRetryBtn) {
      lbRetryBtn.addEventListener("click", function (/** @type {any} */ e) {
        e.stopPropagation();
        if (LB.imgs && LB.imgs.length && LB.imgs[LB.idx]) {
          var curImg = LB.imgs[LB.idx];
          var full = curImg.getAttribute("data-full") || curImg.src;
          setLightboxImage(full);
        }
      });
    }
  }

  // 11. Topbar Actions: Safe Mode, Sound, Boss Key
  var safeBtn = document.getElementById("safeModeBtn");
  if (safeBtn) {
    safeBtn.addEventListener("click", function () {
      S.safe = !S.safe;
      document.body.classList.toggle("safe-mode", S.safe);
      safeBtn.classList.toggle("active", S.safe);
      playBeep(S.safe ? 320 : 640, "sine", 0.05);
    });
  }

  var audioBtn = document.getElementById("audioToggleBtn");
  var audioIcon = document.getElementById("audioIcon");
  if (audioBtn) {
    audioBtn.addEventListener("click", function () {
      S.audio = !S.audio;
      if (audioIcon) audioIcon.textContent = S.audio ? "🔊" : "🔇";
      if (S.audio) playBeep(520, "sine", 0.04);
    });
  }

  var bossBtn = document.getElementById("bossKeyBtn");
  if (bossBtn) {
    bossBtn.addEventListener("click", toggleBossMode);
  }

  // 12. Fate Roller Controls
  var fateBtn = document.getElementById("fateRollerBtn");
  if (fateBtn) fateBtn.addEventListener("click", triggerFateRoller);

  var fateClose = document.getElementById("fateCloseBtn");
  if (fateClose) {
    fateClose.addEventListener("click", function () {
      var m = document.getElementById("fateModal");
      if (m) {
        m.classList.remove("open");
        m.setAttribute("aria-hidden", "true");
      }
    });
  }

  var fateReroll = document.getElementById("fateRerollBtn");
  if (fateReroll) fateReroll.addEventListener("click", triggerFateRoller);


  // 16. Global Master Keyboard Shortcuts
  document.addEventListener("keydown", function (/** @type {any} */ e) {
    // Escape
    if (e.key === "Escape") {
      var lb = document.getElementById("lightbox");
      if (lb && lb.classList.contains("open")) {
        closeLightbox();
        return;
      }
      var dr = document.getElementById("drawer");
      if (dr && dr.classList.contains("open")) {
        closeDetail();
        return;
      }
      var fm = document.getElementById("fateModal");
      if (fm && fm.classList.contains("open")) {
        fm.classList.remove("open");
        fm.setAttribute("aria-hidden", "true");
        return;
      }
      if (S.boss) {
        toggleBossMode();
        return;
      }
    }

    // Ignore when focused in input
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT")) {
      return;
    }

    // Boss Key: B
    if (e.key === "b" || e.key === "B") {
      e.preventDefault();
      toggleBossMode();
      return;
    }

    // Omni Search Focus: /
    if (e.key === "/") {
      e.preventDefault();
      if (searchInput) searchInput.focus();
      return;
    }

    // Fate Roller: R
    if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      triggerFateRoller();
      return;
    }

    // Lightbox Navigation: Left / Right
    var lbEl = document.getElementById("lightbox");
    if (lbEl && lbEl.classList.contains("open")) {
      if (e.key === "ArrowLeft") {
        if (vprev) vprev.click();
        return;
      }
      if (e.key === "ArrowRight") {
        if (vnext) vnext.click();
        return;
      }
    }

    // Gallery J / K Navigation
    var cards = /** @type {any} */ (document.querySelectorAll("#grid .cardwrap"));
    if (!cards.length) return;

    if (e.key === "j" || e.key === "J" || e.key === "ArrowDown") {
      e.preventDefault();
      S.focus = Math.min(S.focus + 1, cards.length - 1);
      var targetCard = cards[S.focus];
      if (targetCard) {
        targetCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
        playBeep(420, "sine", 0.02);
      }
      return;
    }

    if (e.key === "k" || e.key === "K" || e.key === "ArrowUp") {
      e.preventDefault();
      S.focus = Math.max(S.focus - 1, 0);
      var tCard = cards[S.focus];
      if (tCard) {
        tCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
        playBeep(460, "sine", 0.02);
      }
      return;
    }

    // Open current focused item: Enter
    if (e.key === "Enter") {
      var curWrap = cards[S.focus];
      if (curWrap && curWrap.dataset.gid) {
        openDetail(curWrap.dataset.gid);
      }
      return;
    }

    // Direct Store Jump: D (DLsite), E (EGS)
    if (e.key === "d" || e.key === "D") {
      var dWrap = cards[S.focus];
      if (dWrap && dWrap.dataset.gid) {
        var dSt = storeOf(dWrap.dataset.gid);
        if (dSt && dSt.l) {
          window.open(dlProductUrl(dSt.l.id, dSt.l.d));
        }
      }
      return;
    }

    if (e.key === "e" || e.key === "E") {
      var eWrap = cards[S.focus];
      if (eWrap && eWrap.dataset.gid) {
        window.open(egsUrl(eWrap.dataset.gid));
      }
      return;
    }
  });

  // Boot Pipeline
  renderTagChips();
  applyFilter();

  // Register Service Worker for Cache-First offline media caching (HTTP/HTTPS only)
  if (typeof window !== "undefined" && "serviceWorker" in navigator && window.location && window.location.protocol && window.location.protocol.indexOf("http") === 0) {
    try {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    } catch (e) {}
  }
}

