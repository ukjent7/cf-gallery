  // --- Card Element Factory ---
  function createCardElement(item) {
    var gid = String(item.gid);
    var st = storeOf(gid);
    var v = liveCache.get(gid) || null;
    var art = getArtworkFor(item, currentTab);

    var hasD = Boolean(dlEntry(st));
    var hasF = dmmEntries(st).length > 0;
    var hasG = Boolean(gcEntry(st));
    var hasV = Boolean(v);

    var wrap = document.createElement("div");
    wrap.className = "cardwrap";
    wrap.dataset.gid = gid;

    var article = document.createElement("article");
    article.className = "card" + (item.rank <= 10 ? " rank-top10" : "");
    article.dataset.gid = gid;

    // Rating tier class
    var medClass = getMedClass(item.median);

    // Tags list
    var itemTags = tagsOf(gid);
    var tagsHtml = "";
    if (itemTags.length > 0) {
      tagsHtml = itemTags.slice(0, 3).map(function (t) {
        return '<span class="tagbadge">' + escHtml(t) + '</span>';
      }).join("");
    }

    // Direct Store Actions
    var storeLinksHtml = "";
    if (st && st.l) {
      storeLinksHtml += '<a href="' + escHtml(dlProductUrl(st.l.id, st.l.d)) + '" target="_blank" rel="noopener">DLsite</a>';
    }
    if (st && (st.m || st.m2)) {
      var dm = st.m || st.m2;
      storeLinksHtml += '<a href="' + escHtml(dmmDetailUrl(dm.id)) + '" target="_blank" rel="noopener">FANZA</a>';
    }
    if (st && st.g) {
      storeLinksHtml += '<a href="' + escHtml(gcProductUrl(st.g.id)) + '" target="_blank" rel="noopener">Getchu</a>';
    }
    if (v) {
      storeLinksHtml += '<a href="' + escHtml(vnUrl(v.id)) + '" target="_blank" rel="noopener">VNDB</a>';
    } else {
      storeLinksHtml += '<button type="button" class="btn-fetch" data-act="fetch" data-gid="' + gid + '">匹配VNDB</button>';
    }

    // Always ensure at least 2 links and one containing erogamescape
    var egsLinkHtml = '<a href="' + escHtml(egsUrl(item.gid)) + '" target="_blank" rel="noopener">批评空间</a>';

    article.innerHTML =
      '<div class="cover" data-act="detail">' +
        '<img data-full="' + escHtml(art.full) + '" src="' + escHtml(art.thumb) + '"' +
        (art.fb ? ' data-fb="' + escHtml(art.fb) + '"' : '') +
        ' alt="' + escHtml(item.name) + '" loading="lazy" draggable="false">' +
        '<div class="scrim"></div>' +
        '<div class="rank">#' + item.rank + '</div>' +
        (item.median ? '<div class="medpill ' + medClass + '">' + item.median + '</div>' : '') +
        '<div class="storedots">' +
          '<span class="sdot' + (hasD ? ' on' : '') + '">D</span>' +
          '<span class="sdot' + (hasF ? ' on' : '') + '">F</span>' +
          '<span class="sdot' + (hasG ? ' on' : '') + '">G</span>' +
          '<span class="sdot' + (hasV ? ' on' : '') + '">V</span>' +
        '</div>' +
        '<div class="scrub-strip"></div>' +
      '</div>' +
      '<div class="cinfo">' +
        '<div class="ctitle" title="' + escHtml(item.name) + '">' + escHtml(item.name) + '</div>' +
        '<div class="cline">中央值 ' + (item.median || "-") + ' · 评分 ' + (item.count2 || "-") + '人 · POV: ' + (item.povs || "寝取") + '</div>' +
        (tagsHtml ? '<div class="cardtag">' + tagsHtml + '</div>' : '') +
        '<div class="cacts">' +
          storeLinksHtml +
          egsLinkHtml +
        '</div>' +
      '</div>';

    var coverEl = article.querySelector(".cover");

    // Click on cover opens detail drawer
    coverEl.addEventListener("click", function (e) {
      if (e.target.closest("a") || e.target.closest("button") || e.target.classList.contains("scrub-segment")) {
        return;
      }
      playBeep(520, "sine", 0.04);
      openDetail(gid);
    });

    // 3D Magnetic Tilt Physics
    article.addEventListener("mousemove", function (e) {
      var rect = article.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      var dx = (x / rect.width - 0.5) * 2;
      var dy = (y / rect.height - 0.5) * 2;
      article.style.setProperty("--rx", (-dy * 7).toFixed(2) + "deg");
      article.style.setProperty("--ry", (dx * 7).toFixed(2) + "deg");
    });
    article.addEventListener("mouseleave", function () {
      article.style.setProperty("--rx", "0deg");
      article.style.setProperty("--ry", "0deg");
    });

    // Hover Scrubbing Preview
    if (art.shots && art.shots.length > 0) {
      var scrubStrip = coverEl.querySelector(".scrub-strip");
      var imgEl = coverEl.querySelector("img");
      var scrubList = [art.thumb].concat(art.shots.slice(0, 5));
      scrubList.forEach(function (shotUrl) {
        var seg = document.createElement("div");
        seg.className = "scrub-segment";
        seg.addEventListener("mouseenter", function () {
          if (!imgEl.dataset.origSrc) {
            imgEl.dataset.origSrc = imgEl.getAttribute("src") || imgEl.src;
          }
          imgEl.dataset.scrubbing = "true";
          imgEl.setAttribute("src", shotUrl);
          imgEl.src = shotUrl;
        });
        scrubStrip.appendChild(seg);
      });

      function restoreCover() {
        imgEl.dataset.scrubbing = "false";
        var orig = imgEl.dataset.origSrc || art.thumb;
        if (orig) {
          imgEl.setAttribute("src", orig);
          imgEl.src = orig;
        }
      }

      scrubStrip.addEventListener("mouseleave", restoreCover);
      coverEl.addEventListener("mouseleave", restoreCover);
    }

    // Manual VNDB Match Button
    var fetchBtn = article.querySelector('[data-act="fetch"]');
    if (fetchBtn) {
      fetchBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        e.preventDefault();
        playBeep(650, "triangle", 0.08);
        triggerVndbFetch(gid, item);
      });
    }

    wrap.appendChild(article);
    return wrap;
  }

  // --- Showcase Grid Renderer ---
  function renderShowcaseGrid() {
    var grid = document.getElementById("grid");
    if (!grid) return;

    grid.dataset.view = currentTab;
    grid.innerHTML = "";

    var slice = filteredData.slice(0, renderCount);
    for (var i = 0; i < slice.length; i++) {
      grid.appendChild(createCardElement(slice[i]));
    }

    var moreBtn = document.getElementById("more");
    if (moreBtn) {
      if (renderCount >= filteredData.length) {
        moreBtn.style.display = "none";
      } else {
        moreBtn.style.display = "inline-block";
      }
    }

  }

  function renderNextPage() {
    if (renderCount >= filteredData.length) return;
    renderCount += PAGE_SIZE;
    renderShowcaseGrid();
    updateStatsBar();
  }

  function updateStatsBar() {
    var stats = document.getElementById("stats");
    if (!stats) return;

    var adapter = ADAPTERS[currentTab];
    var tagInfo = tagSel.length > 0 ? " · 标签AND：" + tagSel.join("+") : "";
    var medInfo = minMed > 0 ? " · 中央值≥" + minMed : "";
    var shown = Math.min(renderCount, filteredData.length);

    stats.innerHTML =
      "共 <b>" + filteredData.length + "</b> / " + _DATA.length + " 个（EROGE限定） · " +
      "视图：" + adapter.navLabel + " · " +
      "已显示 " + shown + " 个" + tagInfo + medInfo;
  }

  // --- Tag Constellation Chips Renderer ---
  function renderTagChips() {
    var container = document.getElementById("tagchips");
    var tagRow = document.getElementById("tagrow");
    if (!container || !tagRow) return;

    var tagKeys = Object.keys(_TAGS);
    if (!tagKeys.length) {
      tagRow.hidden = true;
      return;
    }
    tagRow.hidden = false;
    container.innerHTML = "";

    tagKeys.forEach(function (tag) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tagchip" + (tagSel.indexOf(tag) >= 0 ? " on" : "");
      btn.dataset.tag = tag;
      btn.innerHTML =
        '<span class="tagname">' + escHtml(tag) + '</span>' +
        '<span class="tagcount">' + _TAGS[tag].length + '</span>';

      btn.addEventListener("click", function () {
        toggleTag(tag);
      });
      container.appendChild(btn);
    });
  }

  function toggleTag(tag) {
    playBeep(480, "sine", 0.04);
    var idx = tagSel.indexOf(tag);
    if (idx >= 0) {
      tagSel.splice(idx, 1);
    } else {
      tagSel.push(tag);
    }
    persistTags();
    renderTagChips();
    applyFilter();
  }

