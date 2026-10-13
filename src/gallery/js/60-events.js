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
  const gridEl = document.getElementById("grid");
  const dbodyEl = document.getElementById("dbody");
  [gridEl, dbodyEl].forEach((root) => {
    if (!root) return;
    root.addEventListener("error", (/** @type {any} */ e) => {
      if (e.target && e.target.tagName === "IMG") chainImgErr(e.target);
    }, true);
    root.addEventListener("load", (/** @type {any} */ e) => {
      if (e.target && e.target.tagName === "IMG") checkImgLoaded(e.target);
    }, true);
  });

  // 1. Data Source View Tabs
  const viewsNav = document.getElementById("views");
  if (viewsNav) {
    viewsNav.addEventListener("click", (/** @type {any} */ e) => {
      const tab = e.target.closest(".vtab");
      if (tab && tab.dataset.view) {
        playBeep(520, "sine", 0.03);
        setTab(tab.dataset.view);
      }
    });
  }

  // 2. Sort Dimension Selector
  const sortSelect = /** @type {HTMLSelectElement} */ (document.getElementById("sort"));
  if (sortSelect) {
    sortSelect.addEventListener("change", () => {
      S.sort = sortSelect.value;
      playBeep(450, "sine", 0.03);
      applyFilter();
    });
  }

  // 3. Density Cycler
  const densityBtn = document.getElementById("density");
  const grid = document.getElementById("grid");
  if (densityBtn && grid) {
    densityBtn.addEventListener("click", () => {
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
  const matchedCheck = /** @type {HTMLInputElement} */ (document.getElementById("onlyMatched"));
  if (matchedCheck) {
    matchedCheck.addEventListener("change", () => {
      S.matched = matchedCheck.checked;
      playBeep(400, "sine", 0.03);
      applyFilter();
    });
  }

  // 5. Omni Search Input
  const searchInput = /** @type {HTMLInputElement} */ (document.getElementById("omniSearch"));
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      S.query = searchInput.value.trim();
      applyFilter();
    });
  }

  // 6. Median Score Filter Chips
  const medChips = document.getElementById("medchips");
  if (medChips) {
    medChips.addEventListener("click", (/** @type {any} */ e) => {
      const chip = e.target.closest(".fchip");
      if (chip && chip.dataset.med !== undefined) {
        S.med = Number(chip.dataset.med);
        playBeep(540, "sine", 0.03);
        medChips.querySelectorAll(".fchip").forEach((/** @type {any} */ c) => {
          c.classList.toggle("on", Number(c.dataset.med) === S.med);
        });
        applyFilter();
      }
    });
  }

  // 7. Reset Filter Button
  const resetBtn = document.getElementById("reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      playBeep(350, "square", 0.06);
      S.tags = [];
      S.med = 0;
      S.query = "";
      if (searchInput) searchInput.value = "";
      persistTags();
      renderTagChips();
      if (medChips) {
        medChips.querySelectorAll(".fchip").forEach((/** @type {any} */ c) => {
          c.classList.toggle("on", c.dataset.med === "0");
        });
      }
      applyFilter();
    });
  }

  // 8. Load More Button & Intersection Observer
  const moreBtn = document.getElementById("more");
  if (moreBtn) {
    moreBtn.addEventListener("click", () => {
      renderNextPage();
    });

    if (typeof window.IntersectionObserver !== "undefined") {
      const observer = new window.IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && moreBtn.style.display !== "none") {
            renderNextPage();
          }
        }
      });
      observer.observe(moreBtn);
    }
  }

  // 9. Drawer Controls
  const dclose = document.getElementById("dclose");
  if (dclose) dclose.addEventListener("click", closeDetail);

  const drawerOverlay = document.getElementById("drawer");
  if (drawerOverlay) {
    const backdrop = drawerOverlay.querySelector(".backdrop");
    if (backdrop) {
      backdrop.addEventListener("click", (/** @type {any} */ e) => {
        const sel = window.getSelection ? window.getSelection().toString().trim() : "";
        if (sel.length > 0) return;
        if (e.target === backdrop) closeDetail();
      });
    }
  }

  // 10. Lightbox Controls
  const vprev = document.getElementById("vprev");
  if (vprev) {
    vprev.addEventListener("click", () => {
      stepLightbox(-1);
    });
  }

  const vnext = document.getElementById("vnext");
  if (vnext) {
    vnext.addEventListener("click", () => {
      stepLightbox(1);
    });
  }

  const vclose = document.getElementById("vclose");
  if (vclose) vclose.addEventListener("click", closeLightbox);

  const vopen = document.getElementById("vopen");
  if (vopen) {
    vopen.addEventListener("click", () => {
      const vimg = /** @type {HTMLImageElement} */ (document.getElementById("vimg"));
      if (vimg) {
        const targetUrl = vimg.getAttribute("src") || vimg.src;
        if (targetUrl) window.open(targetUrl);
      }
    });
  }

  // Mouse wheel image switching with inertia throttle
  let lastLbWheelTime = 0;
  const lbEl = document.getElementById("lightbox");
  if (lbEl) {
    lbEl.addEventListener("wheel", (/** @type {any} */ e) => {
      if (!lbEl.classList.contains("open") || !LB.imgs.length) return;
      // Keep natural scroll on bottom thumbnail strip
      if (e.target.closest("#vthumbs")) return;

      if (e.preventDefault) e.preventDefault();

      const now = Date.now();
      if (now - lastLbWheelTime < 180) return;

      const dy = e.deltaY;
      const dx = e.deltaX;
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
    lbEl.addEventListener("click", (/** @type {any} */ e) => {
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

    const lbRetryBtn = document.getElementById("lbRetryBtn");
    if (lbRetryBtn) {
      lbRetryBtn.addEventListener("click", (/** @type {any} */ e) => {
        e.stopPropagation();
        if (LB.imgs && LB.imgs.length && LB.imgs[LB.idx]) {
          const curImg = LB.imgs[LB.idx];
          const full = curImg.getAttribute("data-full") || curImg.src;
          setLightboxImage(full);
        }
      });
    }
  }

  // 11. Topbar Actions: Safe Mode, Sound, Boss Key
  const safeBtn = document.getElementById("safeModeBtn");
  if (safeBtn) {
    safeBtn.addEventListener("click", () => {
      S.safe = !S.safe;
      document.body.classList.toggle("safe-mode", S.safe);
      safeBtn.classList.toggle("active", S.safe);
      playBeep(S.safe ? 320 : 640, "sine", 0.05);
    });
  }

  const audioBtn = document.getElementById("audioToggleBtn");
  const audioIcon = document.getElementById("audioIcon");
  if (audioBtn) {
    audioBtn.addEventListener("click", () => {
      S.audio = !S.audio;
      if (audioIcon) audioIcon.textContent = S.audio ? "🔊" : "🔇";
      if (S.audio) playBeep(520, "sine", 0.04);
    });
  }

  const bossBtn = document.getElementById("bossKeyBtn");
  if (bossBtn) {
    bossBtn.addEventListener("click", toggleBossMode);
  }

  // 12. Fate Roller Controls
  const fateBtn = document.getElementById("fateRollerBtn");
  if (fateBtn) fateBtn.addEventListener("click", triggerFateRoller);

  const fateClose = document.getElementById("fateCloseBtn");
  if (fateClose) {
    fateClose.addEventListener("click", () => {
      const m = document.getElementById("fateModal");
      if (m) {
        m.classList.remove("open");
        m.setAttribute("aria-hidden", "true");
      }
    });
  }

  const fateReroll = document.getElementById("fateRerollBtn");
  if (fateReroll) fateReroll.addEventListener("click", triggerFateRoller);

  // 16. Global Master Keyboard Shortcuts
  document.addEventListener("keydown", (/** @type {any} */ e) => {
    // Escape
    if (e.key === "Escape") {
      const lb = document.getElementById("lightbox");
      if (lb && lb.classList.contains("open")) {
        closeLightbox();
        return;
      }
      const dr = document.getElementById("drawer");
      if (dr && dr.classList.contains("open")) {
        closeDetail();
        return;
      }
      const fm = document.getElementById("fateModal");
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
    const lbEl = document.getElementById("lightbox");
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
    const cards = /** @type {any} */ (document.querySelectorAll("#grid .cardwrap"));
    if (!cards.length) return;

    if (e.key === "j" || e.key === "J" || e.key === "ArrowDown") {
      e.preventDefault();
      S.focus = Math.min(S.focus + 1, cards.length - 1);
      const targetCard = cards[S.focus];
      if (targetCard) {
        targetCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
        playBeep(420, "sine", 0.02);
      }
      return;
    }

    if (e.key === "k" || e.key === "K" || e.key === "ArrowUp") {
      e.preventDefault();
      S.focus = Math.max(S.focus - 1, 0);
      const tCard = cards[S.focus];
      if (tCard) {
        tCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
        playBeep(460, "sine", 0.02);
      }
      return;
    }

    // Open current focused item: Enter
    if (e.key === "Enter") {
      const curWrap = cards[S.focus];
      if (curWrap && curWrap.dataset.gid) {
        openDetail(curWrap.dataset.gid);
      }
      return;
    }

    // Direct Store Jump: D (DLsite), E (EGS)
    if (e.key === "d" || e.key === "D") {
      const dWrap = cards[S.focus];
      if (dWrap && dWrap.dataset.gid) {
        const dSt = storeOf(dWrap.dataset.gid);
        if (dSt && dSt.l) {
          window.open(dlProductUrl(dSt.l.id, dSt.l.d));
        }
      }
      return;
    }

    if (e.key === "e" || e.key === "E") {
      const eWrap = cards[S.focus];
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
  if (typeof window !== "undefined" && "serviceWorker" in navigator && window.location && window.location.protocol && window.location.protocol.startsWith("http")) {
    try {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    } catch {}
  }
}
