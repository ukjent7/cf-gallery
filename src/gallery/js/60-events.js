  // --- Event Wireup & Boot Initializer ---
  function initGallery() {
    // 0. Delegated cover-image fallback: load/error do not bubble, but a
    // capture listener on each container replaces every inline
    // onload/onerror attribute in the card, rail, and strip templates.
    // window.chainImgErr / window.checkImgLoaded stay as the testable units.
    var gridEl = document.getElementById("grid");
    var dbodyEl = document.getElementById("dbody");
    [gridEl, dbodyEl].forEach(function (root) {
      if (!root) return;
      root.addEventListener("error", function (e) {
        if (e.target && e.target.tagName === "IMG") chainImgErr(e.target);
      }, true);
      root.addEventListener("load", function (e) {
        if (e.target && e.target.tagName === "IMG") checkImgLoaded(e.target);
      }, true);
    });

    // 1. Data Source View Tabs
    var viewsNav = document.getElementById("views");
    if (viewsNav) {
      viewsNav.addEventListener("click", function (e) {
        var tab = e.target.closest(".vtab");
        if (tab && tab.dataset.view) {
          playBeep(520, "sine", 0.03);
          setTab(tab.dataset.view);
        }
      });
    }

    // 2. Sort Dimension Selector
    var sortSelect = document.getElementById("sort");
    if (sortSelect) {
      sortSelect.addEventListener("change", function () {
        currentSort = sortSelect.value;
        playBeep(450, "sine", 0.03);
        applyFilter();
      });
    }

    // 3. Density Cycler
    var densityBtn = document.getElementById("density");
    var grid = document.getElementById("grid");
    if (densityBtn && grid) {
      densityBtn.addEventListener("click", function () {
        currentDensity = (currentDensity + 1) % 3;
        playBeep(500, "triangle", 0.04);
        if (currentDensity === 0) {
          densityBtn.textContent = "密度：自动";
          grid.classList.remove("density-compact", "density-large");
        } else if (currentDensity === 1) {
          densityBtn.textContent = "密度：紧凑";
          grid.classList.add("density-compact");
          grid.classList.remove("density-large");
        } else if (currentDensity === 2) {
          densityBtn.textContent = "密度：大图";
          grid.classList.add("density-large");
          grid.classList.remove("density-compact");
        }
      });
    }

    // 4. Only Matched Checkbox
    var matchedCheck = document.getElementById("onlyMatched");
    if (matchedCheck) {
      matchedCheck.addEventListener("change", function () {
        onlyMatched = matchedCheck.checked;
        playBeep(400, "sine", 0.03);
        applyFilter();
      });
    }

    // 5. Omni Search Input
    var searchInput = document.getElementById("omniSearch");
    if (searchInput) {
      searchInput.addEventListener("input", function () {
        searchQuery = searchInput.value.trim();
        applyFilter();
      });
    }

    // 6. Median Score Filter Chips
    var medChips = document.getElementById("medchips");
    if (medChips) {
      medChips.addEventListener("click", function (e) {
        var chip = e.target.closest(".fchip");
        if (chip && chip.dataset.med !== undefined) {
          minMed = Number(chip.dataset.med);
          playBeep(540, "sine", 0.03);
          medChips.querySelectorAll(".fchip").forEach(function (c) {
            c.classList.toggle("on", Number(c.dataset.med) === minMed);
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
        tagSel = [];
        minMed = 0;
        searchQuery = "";
        if (searchInput) searchInput.value = "";
        persistTags();
        renderTagChips();
        if (medChips) {
          medChips.querySelectorAll(".fchip").forEach(function (c) {
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
        backdrop.addEventListener("click", function (e) {
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
        var vimg = document.getElementById("vimg");
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
      lbEl.addEventListener("wheel", function (e) {
        if (!lbEl.classList.contains("open") || !lbImages.length) return;
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
      lbEl.addEventListener("click", function (e) {
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
        lbRetryBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          if (lbImages && lbImages.length && lbImages[lbIndex]) {
            var curImg = lbImages[lbIndex];
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
        isSafeMode = !isSafeMode;
        document.body.classList.toggle("safe-mode", isSafeMode);
        safeBtn.classList.toggle("active", isSafeMode);
        playBeep(isSafeMode ? 320 : 640, "sine", 0.05);
      });
    }

    var audioBtn = document.getElementById("audioToggleBtn");
    var audioIcon = document.getElementById("audioIcon");
    if (audioBtn) {
      audioBtn.addEventListener("click", function () {
        audioEnabled = !audioEnabled;
        if (audioIcon) audioIcon.textContent = audioEnabled ? "🔊" : "🔇";
        if (audioEnabled) playBeep(520, "sine", 0.04);
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
    document.addEventListener("keydown", function (e) {
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
        if (isBossMode) {
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
      var cards = document.querySelectorAll("#grid .cardwrap");
      if (!cards.length) return;

      if (e.key === "j" || e.key === "J" || e.key === "ArrowDown") {
        e.preventDefault();
        focusedCardIndex = Math.min(focusedCardIndex + 1, cards.length - 1);
        var targetCard = cards[focusedCardIndex];
        if (targetCard) {
          targetCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
          playBeep(420, "sine", 0.02);
        }
        return;
      }

      if (e.key === "k" || e.key === "K" || e.key === "ArrowUp") {
        e.preventDefault();
        focusedCardIndex = Math.max(focusedCardIndex - 1, 0);
        var tCard = cards[focusedCardIndex];
        if (tCard) {
          tCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
          playBeep(460, "sine", 0.02);
        }
        return;
      }

      // Open current focused item: Enter
      if (e.key === "Enter") {
        var curWrap = cards[focusedCardIndex];
        if (curWrap && curWrap.dataset.gid) {
          openDetail(curWrap.dataset.gid);
        }
        return;
      }

      // Direct Store Jump: D (DLsite), E (EGS)
      if (e.key === "d" || e.key === "D") {
        var dWrap = cards[focusedCardIndex];
        if (dWrap && dWrap.dataset.gid) {
          var dSt = storeOf(dWrap.dataset.gid);
          if (dSt && dSt.l) {
            window.open(dlProductUrl(dSt.l.id, dSt.l.d));
          }
        }
        return;
      }

      if (e.key === "e" || e.key === "E") {
        var eWrap = cards[focusedCardIndex];
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

