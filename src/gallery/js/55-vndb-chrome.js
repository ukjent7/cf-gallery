// --- VNDB Live Lookup Stub/Handler ---
import { _DATA, liveCache, saveLive } from "./00-head.js";
import { containsPick, exactPick } from "./10-match.js";
import { origDocTitle, playBeep, S } from "./15-state.js";
import { applyFilter } from "./20-filter.js";
import { escHtml, getMedClass } from "./25-artwork.js";
import { openDetail } from "./40-drawer.js";
export function triggerVndbFetch(gid, item, force) {
  if (!item) return;
  // Query upstream VNDB API
  fetch("https://api.vndb.org/kana/vn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filters: ["search", "=", item.name],
      fields: "id,title,alttitle,released,image.url,screenshots.url"
    })
  })
  .then(function (r) { return r.json(); })
  .then(function (res) {
    if (res && res.results && res.results.length > 0) {
      var pick = exactPick(res.results, [item.name], item) || containsPick(res.results, item.name, item);
      if (pick) {
        var entry = {
          id: pick.id,
          title: pick.title,
          alttitle: pick.alttitle,
          released: pick.released,
          img: pick.image ? pick.image.url : null,
          shots: (pick.screenshots || []).map(function (s) { return s.url; }),
          via: "vn:" + pick.title
        };
        liveCache.set(String(gid), entry);
        saveLive();
        applyFilter();

        // If detail drawer is currently open for this game, refresh its VNDB display live
        var drawer = document.getElementById("drawer");
        if (drawer && drawer.classList.contains("open")) {
          var dhead = document.getElementById("dhead");
          if (dhead && dhead.querySelector("h2") && dhead.querySelector("h2").textContent.indexOf("#" + item.rank + " ") === 0) {
            openDetail(gid);
          }
        }
      }
    }
  })
  .catch(function () {});
}

// --- Boss-Key Mode Toggle ---
export function toggleBossMode() {
  S.boss = !S.boss;
  var shield = document.getElementById("bossShield");
  if (shield) {
    if (S.boss) {
      shield.classList.add("open");
      shield.setAttribute("aria-hidden", "false");
      document.title = "IEEE Transactions on Computational Narrative Dynamics";
    } else {
      shield.classList.remove("open");
      shield.setAttribute("aria-hidden", "true");
      document.title = origDocTitle;
    }
  }
}

// --- Fate Roller Holographic Matrix ---
export function triggerFateRoller() {
  var modal = document.getElementById("fateModal");
  var reel = document.getElementById("fateReel");
  var result = document.getElementById("fateResult");
  if (!modal || !reel || !result) return;

  // Use current filtered pool (respects user search/tag/view filters), fallback to full dataset
  var pool = S.list && S.list.length ? S.list : _DATA;
  if (!pool || !pool.length) return;

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  playBeep(600, "sawtooth", 0.2);

  var count = 0;
  var interval = setInterval(function () {
    var rand = pool[Math.floor(Math.random() * pool.length)];
    reel.textContent = rand.name;
    count++;
    if (count >= 12) {
      clearInterval(interval);
      var finalPick = pool[Math.floor(Math.random() * pool.length)];
      reel.textContent = finalPick.name;

      var mc = getMedClass(finalPick.median);
      var medBadge = finalPick.median
        ? '<span class="medpill ' + mc + '" style="position:static;display:inline-block;margin-left:6px;vertical-align:middle;">' + finalPick.median + '</span>'
        : '<span style="color:var(--text-muted);margin-left:6px;">暂无评分</span>';

      result.innerHTML =
        '<div style="font-family:var(--font-serif);font-size:1.15rem;font-weight:700;color:#FFFFFF;margin-bottom:6px;">#' + finalPick.rank + ' ' + escHtml(finalPick.name) + '</div>' +
        '<div style="font-family:var(--font-sans);font-size:0.92rem;color:#E2E8F0;line-height:1.6;">' +
          '社团：' + escHtml(finalPick.brand || "未知") + ' · 发售：' + escHtml(finalPick.sellday || "未知") + '<br>' +
          '中央值：' + medBadge + ' · 评分人数：' + (finalPick.count2 || "-") + '人 · POV: ' + escHtml(finalPick.povs || "寝取") +
        '</div>';

      var confirmBtn = document.getElementById("fateConfirmBtn");
      if (confirmBtn) {
        confirmBtn.onclick = function () {
          modal.classList.remove("open");
          modal.setAttribute("aria-hidden", "true");
          openDetail(finalPick.gid);
        };
      }
    }
  }, 60);
}

