  // --- Detail Drawer System ---
  function openDetail(gid) {
    var item = _DATA.find(function (d) { return String(d.gid) === String(gid); });
    if (!item) return;

    var drawer = document.getElementById("drawer");
    var dhead = document.getElementById("dhead");
    var dbody = document.getElementById("dbody");
    if (!drawer || !dhead || !dbody) return;

    // Reset scroll position immediately so previous scroll offset doesn't stick
    dbody.scrollTop = 0;
    if (dbody.scrollTo) dbody.scrollTo(0, 0);

    var st = storeOf(gid) || {};
    var v = liveCache.get(String(gid)) || (_CACHE[String(gid)] || null);
    var itemTags = tagsOf(gid);

    // Auto-fetch VNDB live if not cached yet
    if (!v && item && !sessionMetaCache.has("vn:" + gid)) {
      sessionMetaCache.add("vn:" + gid);
      triggerVndbFetch(gid, item, false);
    }

    // Populate Header
    dhead.querySelector("h2").textContent = "#" + item.rank + " " + item.name;

    var hintText =
      "社团：" + (item.brand || "未知") + " · 发售日：" + (item.sellday || "未知") + "\n" +
      "中央值 " + (item.median || "-") + " · 评分 " + (item.count2 || "-") + "人 · POV: " + (item.povs || "寝取") + "\n" +
      "注册标签: " + (itemTags.length ? itemTags.join(" / ") : "无") + "\n" +
      "VNDB: " + (v ? (v.id + (v.title ? " (" + v.title + ")" : "")) : "未匹配");
    dhead.querySelector(".hint").textContent = hintText;

    var mainSections = [];

    // 1. DLsite Section
    var dlHtml = "";
    var dlCount = 0;
    if (st && st.l) {
      var dlSt = st.l;
      var stems = dlStems(dlSt);
      dlCount = stems.length;
      dlHtml =
        '<div class="drawer-section drawer-store-section dsec-dl" data-store="dl">' +
          '<h3 id="dsec-h-dl">DLsite 样本原画 (<span data-livecount="dl">' + stems.length + '</span>)</h3>' +
          '<div class="drawer-meta-links">' +
            '<a href="' + escHtml(dlProductUrl(dlSt.id, dlSt.d)) + '" target="_blank" rel="noopener">DLsite 商品页面 (' + escHtml(dlSt.id) + ')</a>' +
          '</div>' +
          '<div class="strip">' +
            stems.map(function (s) {
              return '<img src="' + escHtml(dlSampleThumbUrl(dlSt, s)) + '" data-full="' + escHtml(dlSampleUrl(dlSt, s)) + '" alt="DLsite sample" loading="lazy" decoding="async">';
            }).join("") +
          '</div>' +
        '</div>';

      // Live DLsite meta check if unharvested
      if (dlSt.un) {
        refreshLiveMeta("dl:" + dlSt.id, dlApiMeta(dlSt.id, dlSt.d), function (res) {
        if (!(res && res.stems && res.stems.length)) return false;
        dlSt.sm = res.stems;
        delete dlSt.un;
        return true;
      }, ".dsec-dl", "dl", function () {
        return dlStems(dlSt).map(function (s) {
          return '<img src="' + escHtml(dlSampleThumbUrl(dlSt, s)) + '" data-full="' + escHtml(dlSampleUrl(dlSt, s)) + '" alt="DLsite sample" loading="lazy" decoding="async">';
        }).join("");
      }, item);
      }
    }

    // 2. FANZA Section
    var dmmHtml = "";
    var dmmCount = 0;
    var dmmList = dmmEntries(st);
    if (dmmList.length > 0) {
      var dmmSamples = [];
      dmmList.forEach(function (dm) {
        var n = Math.min(dm.n || 0, DMM_SAMPLE_CAP);
        for (var i = 1; i <= n; i++) {
          dmmSamples.push({
            big: dmmSampleBig(dm.id, i),
            small: dmmSampleSmall(dm.id, i)
          });
        }
      });
      dmmCount = dmmSamples.length;

      if (dmmSamples.length > 0) {
        dmmHtml =
          '<div class="drawer-section drawer-store-section dsec-dmm" data-store="dmm">' +
            '<h3 id="dsec-h-dmm">FANZA 截帧图集 (<span data-livecount="dmm">' + dmmCount + '</span>)</h3>' +
            '<div class="drawer-meta-links">' +
              dmmList.map(function (dm) {
                return '<a href="' + escHtml(dmmDetailUrl(dm.id)) + '" target="_blank" rel="noopener">FANZA ' + escHtml(dmmFloorLabel(dm.id)) + ' (' + escHtml(dm.id) + ')</a>';
              }).join("") +
            '</div>' +
            '<div class="strip">' +
              dmmSamples.map(function (s) {
                return '<img src="' + escHtml(s.small) + '" data-full="' + escHtml(s.big) + '" alt="FANZA sample" loading="lazy" decoding="async">';
              }).join("") +
            '</div>' +
          '</div>';
      }

      // Live DMM meta check (only if count unknown)
      if (typeof dmmList[0].n !== "number" || dmmList[0].n <= 0) {
        refreshLiveMeta("dm:" + dmmList[0].id, dmApiMeta(dmmList[0].id), function (res) {
          if (!(res && typeof res.n === "number" && res.n > 0)) return false;
          dmmList[0].n = res.n;
          return true;
        }, ".dsec-dmm", "dmm", function () {
          var out = [];
          for (var k = 1; k <= Math.min(dmmList[0].n, DMM_SAMPLE_CAP); k++) {
            out.push('<img src="' + escHtml(dmmSampleSmall(dmmList[0].id, k)) + '" data-full="' + escHtml(dmmSampleBig(dmmList[0].id, k)) + '" alt="FANZA sample" loading="lazy" decoding="async">');
          }
          return out.join("");
        }, item);
      }
    }

    // 3. Getchu Section
    var gcHtml = "";
    var gcCount = 0;
    if (st && st.g) {
      var gc = st.g;
      var gcSamples = [];
      var gn = Math.min(gc.n || 0, GETCHU_SAMPLE_CAP);
      // Sample 1 is the package cover; promotional samples start from sample 2
      if (USE_GC && gn > 1) {
        for (var gi = 2; gi <= gn; gi++) {
          gcSamples.push(gcApiSample(gc.id, gi));
        }
      }
      gcCount = gcSamples.length;

      if (gcSamples.length > 0) {
        gcHtml =
          '<div class="drawer-section drawer-store-section dsec-gc" data-store="gc">' +
            '<h3 id="dsec-h-gc">Getchu 宣传册样本 (<span data-livecount="gc">' + gcCount + '</span>)</h3>' +
            '<div class="drawer-meta-links">' +
              '<a href="' + escHtml(gcProductUrl(gc.id)) + '" target="_blank" rel="noopener">Getchu 作品页 (' + escHtml(gc.id) + ')</a>' +
            '</div>' +
            (!USE_GC ? '<p class="drawer-hint" style="font-size:0.84rem;color:var(--text-muted);">本地文件模式：Getchu 官方图片受防盗链保护，需在部署后的站点（通过 Worker 代理）在线鉴赏原画。</p>' : '') +
            '<div class="strip">' +
              gcSamples.map(function (u) {
                return '<img src="' + escHtml(u) + '" data-full="' + escHtml(u) + '" alt="Getchu sample" loading="lazy" decoding="async">';
              }).join("") +
            '</div>' +
          '</div>';
      }

      // Live Getchu meta check (only if count unknown)
      if (typeof gc.n !== "number" || gc.n <= 0) {
        refreshLiveMeta("gc:" + gc.id, gcApiMeta(gc.id), function (res) {
          if (!(res && typeof res.n === "number" && res.n > 1)) return false;
          gc.n = res.n;
          return true;
        }, ".dsec-gc", "gc", function () {
          var out = [];
          for (var k = 2; k <= Math.min(gc.n, GETCHU_SAMPLE_CAP); k++) {
            var su = gcApiSample(gc.id, k);
            out.push('<img src="' + escHtml(su) + '" data-full="' + escHtml(su) + '" alt="Getchu sample" loading="lazy" decoding="async">');
          }
          return out.join("");
        }, item);
      }
    }

    // 4. VNDB Section
    var vndbHtml = "";
    var vndbShots = v && v.shots ? v.shots : [];
    var vndbCount = vndbShots.length;
    vndbHtml =
      '<div class="drawer-section drawer-store-section dsec-vndb" data-store="vndb">' +
        '<h3 id="dsec-h-vndb">VNDB 视觉小说画廊 (<span data-livecount="vndb">' + vndbCount + '</span>)</h3>' +
        '<div class="drawer-meta-links">' +
          (v ? '<a href="' + escHtml(vnUrl(v.id)) + '" target="_blank" rel="noopener">VNDB 典藏页 (' + escHtml(v.id) + ')</a>' : '') +
          '<a href="' + escHtml(vnSearchUrl(item.name)) + '" target="_blank" rel="noopener">VNDB搜索</a>' +
          '<button type="button" data-act="refetch" data-gid="' + gid + '">重查VNDB</button>' +
        '</div>' +
        (vndbShots.length > 0 ? (
          '<div class="strip">' +
            vndbShots.map(function (u) {
              return '<img src="' + escHtml(vnThumb(u)) + '" data-full="' + escHtml(u) + '" alt="VNDB shot" loading="lazy" decoding="async">';
            }).join("") +
          '</div>'
        ) : '') +
      '</div>';

    // Store Tabs Navigation (On-demand viewing & network deferral)
    var storeTabs = [];
    if (dmmHtml) storeTabs.push({ id: "dmm", label: "FANZA", icon: "💎", count: dmmCount });
    if (dlHtml) storeTabs.push({ id: "dl", label: "DLsite", icon: "🔷", count: dlCount });
    if (gcHtml) storeTabs.push({ id: "gc", label: "Getchu", icon: "🔶", count: gcCount });
    if (vndbShots.length > 0) storeTabs.push({ id: "vndb", label: "VNDB", icon: "🌐", count: vndbShots.length });

    var defaultStoreTab = "all";
    if (storeTabs.length >= 2) {
      if (currentTab === "dmm" && dmmHtml) defaultStoreTab = "dmm";
      else if (currentTab === "dlsite" && dlHtml) defaultStoreTab = "dl";
      else if (currentTab === "getchu" && gcHtml) defaultStoreTab = "gc";
      else if (currentTab === "vndb" && vndbShots.length > 0) defaultStoreTab = "vndb";
      else if (dmmHtml) defaultStoreTab = "dmm";
      else if (dlHtml) defaultStoreTab = "dl";
      else if (gcHtml) defaultStoreTab = "gc";
      else if (vndbShots.length > 0) defaultStoreTab = "vndb";
    }

    var tabsBarHtml = "";
    if (storeTabs.length >= 2) {
      tabsBarHtml =
        '<div class="drawer-store-tabs" role="tablist" aria-label="画册图源筛选">' +
          '<span class="drawer-tabs-label">画册图源</span>' +
          storeTabs.map(function (tb) {
            var isAct = tb.id === defaultStoreTab;
            return '<button type="button" class="drawer-tab' + (isAct ? ' active' : '') + '" data-store-tab="' + tb.id + '">' +
              '<span class="tab-icon">' + tb.icon + '</span> ' + tb.label + ' <span class="tab-badge">' + tb.count + '</span>' +
            '</button>';
          }).join("") +
          '<button type="button" class="drawer-tab tab-all' + (defaultStoreTab === 'all' ? ' active' : '') + '" data-store-tab="all">全部展开</button>' +
        '</div>';
    }

    var mainSections = [];
    if (tabsBarHtml) mainSections.push(tabsBarHtml);
    if (dmmHtml) mainSections.push(dmmHtml);
    if (dlHtml) mainSections.push(dlHtml);
    if (gcHtml) mainSections.push(gcHtml);
    if (vndbHtml) mainSections.push(vndbHtml);

    // 5. Full CG Section
    var fullcg = _FULLCG[gid];
    var g = groupFor(item.brand);
    var fullRomaji = romajiTitle(item, v);
    var searchTitle = coreTitle(fullRomaji);
    var hitomiUrl = hitomiSiteUrl(item, v);
    var ehUrl = ehSiteUrl(item, v);

    var fullcgLinks = [];
    if (fullcg && fullcg.hitomi) {
      fullcgLinks.push('<a href="' + escHtml(fullcg.hitomi) + '" target="_blank" rel="noopener" class="fullcg-btn-direct">Hitomi 全CG 直连</a>');
    }
    if (fullcg && fullcg.ehentai) {
      fullcgLinks.push('<a href="' + escHtml(fullcg.ehentai) + '" target="_blank" rel="noopener" class="fullcg-btn-direct">E-Hentai 全CG 直连</a>');
    }

    fullcgLinks.push('<a href="' + escHtml(hitomiUrl) + '" target="_blank" rel="noopener" class="fullcg-btn-hitomi">Hitomi 站内搜索 ' + (g ? '(group:' + escHtml(g) + ')' : '(罗马字)') + '</a>');
    fullcgLinks.push('<a href="' + escHtml(ehUrl) + '" target="_blank" rel="noopener" class="fullcg-btn-eh">E-Hentai 站内搜索 ' + (g ? '(group:' + escHtml(g) + '$)' : '(罗马字)') + '</a>');
    fullcgLinks.push('<a href="' + escHtml(fullcgGoogleUrl("hitomi.la", item, v)) + '" target="_blank" rel="noopener">Google 搜 Hitomi</a>');
    fullcgLinks.push('<a href="' + escHtml(fullcgGoogleUrl("e-hentai.org", item, v)) + '" target="_blank" rel="noopener">Google 搜 E-Hentai</a>');

    mainSections.push(
      '<div class="drawer-section dsec-fullcg">' +
        '<h3 id="dsec-h-fullcg">全CG / 原画鉴赏' + (fullcg ? '<span class="status-chip chip-gilded">已核实直连</span>' : '') + '</h3>' +
        '<div class="drawer-meta-links">' +
          fullcgLinks.join("") +
        '</div>' +
        '<div class="drawer-fullcg-hint">' +
          '<div class="drawer-fullcg-meta">' +
            '<span>检索罗马字: <b style="color:#FFFFFF;">' + escHtml(searchTitle) + '</b></span>' +
            (g ? '<span>社团参数: <code>group:' + escHtml(g) + '</code></span>' : '<span style="color:var(--text-dark);">品牌未入社团映射库 (使用标题精准检索)</span>') +
          '</div>' +
          '<p class="fullcg-subtext">全CG原画由第三方图库收录。已采用罗马字与社团 Group 参数以保证最高命中率，请对照上方官方原版截图鉴赏比对。</p>' +
        '</div>' +
      '</div>'
    );

    // Side Rails: Related Games (Flanking Left & Right Rails with Large Covers)
    var related = relatedOf(item, v);
    var relRailLeftHtml = "";
    var relRailRightHtml = "";

    function createRelCardHtml(r, isClone) {
      var rArt = getArtworkFor(r, currentTab);
      var tagLabel = r.sameSeries ? "系列" : (r.sameBrand ? "同社" : "");
      var medClass = getMedClass(r.median);
      var cardClass = isClone ? "relclone" : "relcard";

      return (
        '<div class="' + cardClass + '" role="button" tabindex="0" data-act="detail" data-gid="' + r.gid + '" title="' + escHtml(r.name) + '">' +
          '<div class="relcover">' +
            (rArt.thumb
              ? '<img class="relimg" src="' + escHtml(rArt.thumb) + '"' + (rArt.fb ? ' data-fb="' + escHtml(rArt.fb) + '"' : '') + ' alt="' + escHtml(r.name) + '" loading="lazy" decoding="async" draggable="false">'
              : '<div class="relnocover">无封面</div>') +
            '<div class="relrank">#' + r.rank + '</div>' +
            (r.median ? '<div class="relmed ' + medClass + '">' + r.median + '</div>' : '') +
          '</div>' +
          '<div class="relmeta">' +
            '<div class="relname">' + escHtml(r.name) + '</div>' +
            '<div class="hint">' + (tagLabel ? '<span class="reltag' + (r.sameSeries ? ' reltag-series' : '') + '">' + escHtml(tagLabel) + '</span> ' : '') + escHtml(r.brand || "未知") + (r.sellday ? ' · ' + escHtml(r.sellday.slice(0, 4)) : '') + '</div>' +
          '</div>' +
        '</div>'
      );
    }

    if (related.length > 0) {
      var mid = related.length <= 3 ? related.length : Math.ceil(related.length / 2);
      var leftList = related.slice(0, mid);
      var rightList = related.slice(mid);

      var leftScroll = leftList.length >= 3;
      var rightScroll = rightList.length >= 3;

      var hasSeries = leftList.some(function (r) { return r.sameSeries; });
      var leftTitle = hasSeries ? "同系列 / 关联作" : "同社代表作";
      var rightTitle = "同社更多作品";

      relRailLeftHtml =
        '<aside class="relrail left' + (leftScroll ? ' has-scroll' : '') + '" aria-label="左侧同社/系列推荐">' +
          '<h4 class="relhead"><span class="relhead-title">' + escHtml(leftTitle) + '</span>' + (leftScroll ? '<span class="relhead-badge">自动循环</span>' : '') + '</h4>' +
          '<div class="relrail-viewport' + (leftScroll ? ' has-autoscroll' : '') + '" data-rail="left">' +
            '<div class="relrail-track">' +
              leftList.map(function (r) { return createRelCardHtml(r, false); }).join("") +
              (leftScroll ? leftList.map(function (r) { return createRelCardHtml(r, true); }).join("") : "") +
            '</div>' +
          '</div>' +
        '</aside>';

      if (rightList.length > 0) {
        relRailRightHtml =
          '<aside class="relrail right' + (rightScroll ? ' has-scroll' : '') + '" aria-label="右侧关联作品">' +
            '<h4 class="relhead"><span class="relhead-title">' + escHtml(rightTitle) + '</span>' + (rightScroll ? '<span class="relhead-badge">自动循环</span>' : '') + '</h4>' +
            '<div class="relrail-viewport' + (rightScroll ? ' has-autoscroll' : '') + '" data-rail="right">' +
              '<div class="relrail-track">' +
                rightList.map(function (r) { return createRelCardHtml(r, false); }).join("") +
                (rightScroll ? rightList.map(function (r) { return createRelCardHtml(r, true); }).join("") : "") +
              '</div>' +
            '</div>' +
          '</aside>';
      }
    }

    var bodyHtml =
      '<div class="relstrip pavilion-layout' + (related.length === 0 ? ' no-rel' : (related.length === 1 ? ' single-rel' : '')) + '">' +
        relRailLeftHtml +
        '<div class="pavilion-main">' + mainSections.join("") + '</div>' +
        relRailRightHtml +
      '</div>';

    dbody.innerHTML = bodyHtml;
    dbody.scrollTop = 0;
    if (dbody.scrollTo) dbody.scrollTo(0, 0);

    // Drawer Store Tabs switching logic (On-demand gallery filtering & bandwidth protection)
    function applyStoreTab(targetTab, shouldScroll) {
      var storeSections = dbody.querySelectorAll(".drawer-store-section");
      storeSections.forEach(function (sec) {
        if (targetTab === "all" || sec.getAttribute("data-store") === targetTab) {
          sec.classList.remove("dsec-hidden");
        } else {
          sec.classList.add("dsec-hidden");
        }
      });
      dbody.querySelectorAll(".drawer-tab").forEach(function (btn) {
        btn.classList.toggle("active", btn.getAttribute("data-store-tab") === targetTab);
      });
      if (shouldScroll) {
        var targetEl = targetTab === "all"
          ? dbody.querySelector(".drawer-store-tabs")
          : dbody.querySelector('.drawer-store-section[data-store="' + targetTab + '"]');
        if (targetEl && targetEl.scrollIntoView) {
          targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
    }

    if (storeTabs.length >= 2 && defaultStoreTab !== "all") {
      applyStoreTab(defaultStoreTab, false);
    }

    dbody.querySelectorAll(".drawer-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var target = btn.getAttribute("data-store-tab");
        playBeep(640, "sine", 0.03);
        applyStoreTab(target, true);
      });
    });

    // Attach Lightbox click triggers on strip images & predictive hover prefetch
    var stripImages = dbody.querySelectorAll(".strip img");
    attachStripListeners(stripImages, item);

    // Background prefetch first 2 full screenshots on opening detail
    for (var pi = 0; pi < Math.min(stripImages.length, 2); pi++) {
      preloadImageUrl(stripImages[pi].getAttribute("data-full") || stripImages[pi].src);
    }

    // Attach Recommendation card click triggers (supports original cards and infinite loop clones)
    dbody.querySelectorAll(".relcard[data-act='detail'], .relclone[data-act='detail']").forEach(function (cardEl) {
      cardEl.addEventListener("click", function () {
        var sel = window.getSelection ? window.getSelection().toString().trim() : "";
        if (sel.length > 0) return;
        playBeep(520, "sine", 0.04);
        openDetail(cardEl.dataset.gid);
      });
      cardEl.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          playBeep(520, "sine", 0.04);
          openDetail(cardEl.dataset.gid);
        }
      });
    });

    // Re-query VNDB button trigger
    var refetchBtn = dbody.querySelector('[data-act="refetch"]');
    if (refetchBtn) {
      refetchBtn.addEventListener("click", function () {
        triggerVndbFetch(gid, item, true);
      });
    }

    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    document.body.classList.add("locked");

    startRelAutoScroll();
  }

  function closeDetail() {
    stopRelAutoScroll();
    var drawer = document.getElementById("drawer");
    if (!drawer) return;
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    var dbody = document.getElementById("dbody");
    if (dbody) {
      dbody.scrollTop = 0;
      if (dbody.scrollTo) dbody.scrollTo(0, 0);
    }
    var lb = document.getElementById("lightbox");
    if (!lb || !lb.classList.contains("open")) {
      document.body.classList.remove("locked");
    }
  }

