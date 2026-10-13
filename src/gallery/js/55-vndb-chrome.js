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
  .then((r) => r.json())
  .then((res) => {
    if (res && res.results && res.results.length > 0) {
      const pick = exactPick(res.results, [item.name], item) || containsPick(res.results, item.name, item);
      if (pick) {
        const entry = {
          id: pick.id,
          title: pick.title,
          alttitle: pick.alttitle,
          released: pick.released,
          img: pick.image ? pick.image.url : null,
          shots: (pick.screenshots || []).map((s) => s.url),
          via: "vn:" + pick.title
        };
        liveCache.set(String(gid), entry);
        saveLive();
        applyFilter();

        // If detail drawer is currently open for this game, refresh its VNDB display live
        const drawer = document.getElementById("drawer");
        if (drawer && drawer.classList.contains("open")) {
          const dhead = document.getElementById("dhead");
          if (dhead && dhead.querySelector("h2") && dhead.querySelector("h2").textContent.startsWith("#" + item.rank + " ")) {
            openDetail(gid);
          }
        }
      }
    }
  })
  .catch(() => {});
}

// --- Boss-Key Mode Toggle ---
export function toggleBossMode() {
  S.boss = !S.boss;
  const shield = document.getElementById("bossShield");
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
  const modal = document.getElementById("fateModal");
  const reel = document.getElementById("fateReel");
  const result = document.getElementById("fateResult");
  if (!modal || !reel || !result) return;

  // Use current filtered pool (respects user search/tag/view filters), fallback to full dataset
  const pool = S.list && S.list.length ? S.list : _DATA;
  if (!pool || !pool.length) return;

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  playBeep(600, "sawtooth", 0.2);

  let count = 0;
  const interval = setInterval(() => {
    const rand = pool[Math.floor(Math.random() * pool.length)];
    reel.textContent = rand.name;
    count++;
    if (count >= 12) {
      clearInterval(interval);
      const finalPick = pool[Math.floor(Math.random() * pool.length)];
      reel.textContent = finalPick.name;

      const mc = getMedClass(finalPick.median);
      const medBadge = finalPick.median
        ? '<span class="medpill ' + mc + '" style="position:static;display:inline-block;margin-left:6px;vertical-align:middle;">' + finalPick.median + '</span>'
        : '<span style="color:var(--text-muted);margin-left:6px;">暂无评分</span>';

      result.innerHTML =
        '<div style="font-family:var(--font-serif);font-size:1.15rem;font-weight:700;color:#FFFFFF;margin-bottom:6px;">#' + finalPick.rank + ' ' + escHtml(finalPick.name) + '</div>' +
        '<div style="font-family:var(--font-sans);font-size:0.92rem;color:#E2E8F0;line-height:1.6;">' +
          '社团：' + escHtml(finalPick.brand || "未知") + ' · 发售：' + escHtml(finalPick.sellday || "未知") + '<br>' +
          '中央值：' + medBadge + ' · 评分人数：' + (finalPick.count2 || "-") + '人 · POV: ' + escHtml(finalPick.povs || "寝取") +
        '</div>';

      const confirmBtn = document.getElementById("fateConfirmBtn");
      if (confirmBtn) {
        confirmBtn.onclick = () => {
          modal.classList.remove("open");
          modal.setAttribute("aria-hidden", "true");
          openDetail(finalPick.gid);
        };
      }
    }
  }, 60);
}
