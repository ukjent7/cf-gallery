// --- Card Element Factory ---
import { _DATA, _TAGS, liveCache, PAGE_SIZE } from "./00-head.js";
import { dlEntry, dmmEntries, gcEntry, storeOf, tagsOf } from "./10-match.js";
import { ADAPTERS, persistTags, playBeep, S } from "./15-state.js";
import { applyFilter } from "./20-filter.js";
import { escHtml, getArtworkFor, getMedClass } from "./25-artwork.js";
import { openDetail } from "./40-drawer.js";
import { triggerVndbFetch } from "./55-vndb-chrome.js";

function createCardElement(item) {
  const gid = String(item.gid);
  const st = storeOf(gid);
  const v = liveCache.get(gid) || null;
  const art = getArtworkFor(item, S.tab);

  const hasD = Boolean(dlEntry(st));
  const hasF = dmmEntries(st).length > 0;
  const hasG = Boolean(gcEntry(st));
  const hasV = Boolean(v);

  const wrap = document.createElement("div");
  wrap.className = "cardwrap";
  wrap.dataset.gid = gid;

  const article = document.createElement("article");
  article.className = "card" + (item.rank <= 10 ? " rank-top10" : "");
  article.dataset.gid = gid;

  // Rating tier class
  const medClass = getMedClass(item.median);

  // Tags list
  const itemTags = tagsOf(gid);
  let tagsHtml = "";
  if (itemTags.length > 0) {
    tagsHtml = itemTags.slice(0, 3).map((t) =>
      '<span class="tagbadge">' + escHtml(t) + '</span>'
    ).join("");
  }

  // Direct Store Actions
  let storeLinksHtml = "";
  if (st && st.l) {
    storeLinksHtml += '<a href="' + escHtml(dlProductUrl(st.l.id, st.l.d)) + '" target="_blank" rel="noopener">DLsite</a>';
  }
  if (st && (st.m || st.m2)) {
    const dm = st.m || st.m2;
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
  const egsLinkHtml = '<a href="' + escHtml(egsUrl(item.gid)) + '" target="_blank" rel="noopener">批评空间</a>';

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

  const coverEl = article.querySelector(".cover");

  // Click on cover opens detail drawer
  coverEl.addEventListener("click", (/** @type {any} */ e) => {
    if (e.target.closest("a") || e.target.closest("button") || e.target.classList.contains("scrub-segment")) {
      return;
    }
    playBeep(520, "sine", 0.04);
    openDetail(gid);
  });

  // 3D Magnetic Tilt Physics
  article.addEventListener("mousemove", (e) => {
    const rect = article.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const dx = (x / rect.width - 0.5) * 2;
    const dy = (y / rect.height - 0.5) * 2;
    article.style.setProperty("--rx", (-dy * 7).toFixed(2) + "deg");
    article.style.setProperty("--ry", (dx * 7).toFixed(2) + "deg");
  });
  article.addEventListener("mouseleave", () => {
    article.style.setProperty("--rx", "0deg");
    article.style.setProperty("--ry", "0deg");
  });

  // Hover Scrubbing Preview
  if (art.shots && art.shots.length > 0) {
    const scrubStrip = coverEl.querySelector(".scrub-strip");
    const imgEl = coverEl.querySelector("img");
    const scrubList = [art.thumb, ...art.shots.slice(0, 5)];
    scrubList.forEach((shotUrl) => {
      const seg = document.createElement("div");
      seg.className = "scrub-segment";
      seg.addEventListener("mouseenter", () => {
        if (!imgEl.dataset.origSrc) {
          imgEl.dataset.origSrc = imgEl.getAttribute("src") || imgEl.src;
        }
        imgEl.dataset.scrubbing = "true";
        imgEl.setAttribute("src", shotUrl);
        imgEl.src = shotUrl;
      });
      scrubStrip.appendChild(seg);
    });

    const restoreCover = () => {
      imgEl.dataset.scrubbing = "false";
      const orig = imgEl.dataset.origSrc || art.thumb;
      if (orig) {
        imgEl.setAttribute("src", orig);
        imgEl.src = orig;
      }
    };

    scrubStrip.addEventListener("mouseleave", restoreCover);
    coverEl.addEventListener("mouseleave", restoreCover);
  }

  // Manual VNDB Match Button
  const fetchBtn = article.querySelector('[data-act="fetch"]');
  if (fetchBtn) {
    fetchBtn.addEventListener("click", (e) => {
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
export function renderShowcaseGrid() {
  const grid = document.getElementById("grid");
  if (!grid) return;

  grid.dataset.view = S.tab;
  grid.innerHTML = "";

  const slice = S.list.slice(0, S.count);
  for (const item of slice) {
    grid.appendChild(createCardElement(item));
  }

  const moreBtn = document.getElementById("more");
  if (moreBtn) {
    if (S.count >= S.list.length) {
      moreBtn.style.display = "none";
    } else {
      moreBtn.style.display = "inline-block";
    }
  }
}

export function renderNextPage() {
  if (S.count >= S.list.length) return;
  S.count += PAGE_SIZE;
  renderShowcaseGrid();
  updateStatsBar();
}

export function updateStatsBar() {
  const stats = document.getElementById("stats");
  if (!stats) return;

  const adapter = ADAPTERS[S.tab];
  const tagInfo = S.tags.length > 0 ? " · 标签AND：" + S.tags.join("+") : "";
  const medInfo = S.med > 0 ? " · 中央值≥" + S.med : "";
  const shown = Math.min(S.count, S.list.length);

  stats.innerHTML =
    "共 <b>" + S.list.length + "</b> / " + _DATA.length + " 个（EROGE限定） · " +
    "视图：" + adapter.navLabel + " · " +
    "已显示 " + shown + " 个" + tagInfo + medInfo;
}

// --- Tag Constellation Chips Renderer ---
export function renderTagChips() {
  const container = document.getElementById("tagchips");
  const tagRow = document.getElementById("tagrow");
  if (!container || !tagRow) return;

  const tagKeys = Object.keys(_TAGS);
  if (!tagKeys.length) {
    tagRow.hidden = true;
    return;
  }
  tagRow.hidden = false;
  container.innerHTML = "";

  tagKeys.forEach((tag) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tagchip" + (S.tags.includes(tag) ? " on" : "");
    btn.dataset.tag = tag;
    btn.innerHTML =
      '<span class="tagname">' + escHtml(tag) + '</span>' +
      '<span class="tagcount">' + _TAGS[tag].length + '</span>';

    btn.addEventListener("click", () => {
      toggleTag(tag);
    });
    container.appendChild(btn);
  });
}

export function toggleTag(tag) {
  playBeep(480, "sine", 0.04);
  const idx = S.tags.indexOf(tag);
  if (idx >= 0) {
    S.tags.splice(idx, 1);
  } else {
    S.tags.push(tag);
  }
  persistTags();
  renderTagChips();
  applyFilter();
}
