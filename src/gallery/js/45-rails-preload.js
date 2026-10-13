// --- Flanking Rails Infinite Auto-Scroller Engine ---
import { LB } from "./50-lightbox.js";

let relScrollAnimationId = null;
let relAutoScrollEngines = [];

export function stopRelAutoScroll() {
  if (relScrollAnimationId) {
    cancelAnimationFrame(relScrollAnimationId);
    relScrollAnimationId = null;
  }
  relAutoScrollEngines = [];
}

export function startRelAutoScroll() {
  stopRelAutoScroll();
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const viewports = document.querySelectorAll("#dbody .relrail-viewport.has-autoscroll");
  if (!viewports.length) return;

  viewports.forEach((vp) => {
    const track = vp.querySelector(".relrail-track");
    if (!track) return;

    const engine = {
      vp,
      track,
      pos: vp.scrollTop || 0,
      paused: false,
      pauseUntil: 0
    };

    vp.addEventListener("mouseenter", () => {
      engine.paused = true;
    });
    vp.addEventListener("mouseleave", () => {
      engine.paused = false;
      engine.pauseUntil = Date.now() + 400;
      engine.pos = vp.scrollTop;
    });
    vp.addEventListener("wheel", () => {
      engine.pauseUntil = Date.now() + 1200;
      engine.pos = vp.scrollTop;
    }, { passive: true });
    vp.addEventListener("touchstart", () => {
      engine.paused = true;
    }, { passive: true });
    vp.addEventListener("touchend", () => {
      engine.paused = false;
      engine.pauseUntil = Date.now() + 600;
      engine.pos = vp.scrollTop;
    }, { passive: true });
    vp.addEventListener("scroll", () => {
      if (engine.paused || Date.now() < engine.pauseUntil) {
        engine.pos = vp.scrollTop;
      }
    }, { passive: true });

    relAutoScrollEngines.push(engine);
  });

  if (!relAutoScrollEngines.length) return;

  let lastTime = performance.now();
  const SPEED_PX_PER_SEC = 85; // brisk, engaging showcase speed (~3.8s per card)

  function tick(now) {
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt > 0.1) dt = 0.016;

    const nowMs = Date.now();
    for (const eng of relAutoScrollEngines) {
      const vp = eng.vp;
      const track = eng.track;
      if (!vp || !track) continue;

      const halfHeight = track.scrollHeight / 2;
      if (halfHeight <= 0) continue;

      if (eng.paused || nowMs < eng.pauseUntil) {
        eng.pos = vp.scrollTop;
        continue;
      }

      eng.pos += SPEED_PX_PER_SEC * dt;

      // Seamless wrap around boundary
      if (eng.pos >= halfHeight) {
        eng.pos -= halfHeight;
      } else if (eng.pos < 0) {
        eng.pos += halfHeight;
      }

      vp.scrollTop = eng.pos;
    }

    relScrollAnimationId = requestAnimationFrame(tick);
  }

  relScrollAnimationId = requestAnimationFrame(tick);
}

// --- Predictive Image Preloader System ---
// Bounded: a long session must not grow these Sets without limit. Sets
// iterate in insertion order, so evicting the oldest entry is O(1).
const PRELOAD_CAP = 500;
export const preloadedUrls = new Set();
export const preloadedReady = new Set();

export function capSet(set) {
  while (set.size > PRELOAD_CAP) {
    const oldest = set.values().next().value;
    set.delete(oldest);
  }
}

export function preloadImageUrl(url) {
  if (!url || typeof url !== "string") return;
  if (preloadedUrls.has(url)) return;
  preloadedUrls.add(url);
  capSet(preloadedUrls);

  if (typeof Image === "undefined") return;
  try {
    const img = new Image();
    img.decoding = "async";
    img.loading = "eager";

    const markReady = () => {
      preloadedReady.add(url);
      capSet(preloadedReady);
    };

    img.onload = markReady;
    img.onerror = () => {};

    if (typeof img.decode === "function") {
      img.src = url;
      img.decode().then(markReady).catch(() => {
        if (img.complete && img.naturalWidth > 0) {
          markReady();
        }
      });
    } else {
      img.src = url;
    }
  } catch {}
}

export function preloadFromLbItem(el) {
  if (!el) return;
  const fullUrl = (el.getAttribute && el.getAttribute("data-full")) || el.src;
  if (fullUrl) preloadImageUrl(fullUrl);
  const fbUrl = el.getAttribute && el.getAttribute("data-fb");
  if (fbUrl) preloadImageUrl(fbUrl);
}

export function preloadLightboxNeighbors(centerIdx, radius = 3) {
  if (!LB.imgs || !LB.imgs.length) return;
  const len = LB.imgs.length;
  if (len <= 1) return;
  const r = radius;
  const visited = new Set();
  visited.add(centerIdx);

  for (let d = 1; d <= r; d++) {
    const forward = (centerIdx + d) % len;
    if (!visited.has(forward)) {
      visited.add(forward);
      preloadFromLbItem(LB.imgs[forward]);
    }
    const backward = (centerIdx - d + len * 10) % len;
    if (!visited.has(backward)) {
      visited.add(backward);
      preloadFromLbItem(LB.imgs[backward]);
    }
  }
}
