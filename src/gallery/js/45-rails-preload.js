// --- Flanking Rails Infinite Auto-Scroller Engine ---
import { LB } from "./50-lightbox.js";
var relScrollAnimationId = null;
var relAutoScrollEngines = [];

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

  var viewports = document.querySelectorAll("#dbody .relrail-viewport.has-autoscroll");
  if (!viewports.length) return;

  viewports.forEach(function (vp) {
    var track = vp.querySelector(".relrail-track");
    if (!track) return;

    var engine = {
      vp: vp,
      track: track,
      pos: vp.scrollTop || 0,
      paused: false,
      pauseUntil: 0
    };

    vp.addEventListener("mouseenter", function () {
      engine.paused = true;
    });
    vp.addEventListener("mouseleave", function () {
      engine.paused = false;
      engine.pauseUntil = Date.now() + 400;
      engine.pos = vp.scrollTop;
    });
    vp.addEventListener("wheel", function () {
      engine.pauseUntil = Date.now() + 1200;
      engine.pos = vp.scrollTop;
    }, { passive: true });
    vp.addEventListener("touchstart", function () {
      engine.paused = true;
    }, { passive: true });
    vp.addEventListener("touchend", function () {
      engine.paused = false;
      engine.pauseUntil = Date.now() + 600;
      engine.pos = vp.scrollTop;
    }, { passive: true });
    vp.addEventListener("scroll", function () {
      if (engine.paused || Date.now() < engine.pauseUntil) {
        engine.pos = vp.scrollTop;
      }
    }, { passive: true });

    relAutoScrollEngines.push(engine);
  });

  if (!relAutoScrollEngines.length) return;

  var lastTime = performance.now();
  var SPEED_PX_PER_SEC = 85; // brisk, engaging showcase speed (~3.8s per card)

  function tick(now) {
    var dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt > 0.1) dt = 0.016;

    var nowMs = Date.now();
    relAutoScrollEngines.forEach(function (eng) {
      var vp = eng.vp;
      var track = eng.track;
      if (!vp || !track) return;

      var halfHeight = track.scrollHeight / 2;
      if (halfHeight <= 0) return;

      if (eng.paused || nowMs < eng.pauseUntil) {
        eng.pos = vp.scrollTop;
        return;
      }

      eng.pos += SPEED_PX_PER_SEC * dt;

      // Seamless wrap around boundary
      if (eng.pos >= halfHeight) {
        eng.pos -= halfHeight;
      } else if (eng.pos < 0) {
        eng.pos += halfHeight;
      }

      vp.scrollTop = eng.pos;
    });

    relScrollAnimationId = requestAnimationFrame(tick);
  }

  relScrollAnimationId = requestAnimationFrame(tick);
}

// --- Predictive Image Preloader System ---
// Bounded: a long session must not grow these Sets without limit. Sets
// iterate in insertion order, so evicting the oldest entry is O(1).
var PRELOAD_CAP = 500;
export var preloadedUrls = new Set();
export var preloadedReady = new Set();

export function capSet(set) {
  while (set.size > PRELOAD_CAP) {
    var oldest = set.values().next().value;
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
    var img = new Image();
    img.decoding = "async";
    img.loading = "eager";

    var markReady = function () {
      preloadedReady.add(url);
      capSet(preloadedReady);
    };

    img.onload = markReady;
    img.onerror = function () {};

    if (typeof img.decode === "function") {
      img.src = url;
      img.decode().then(markReady).catch(function () {
        if (img.complete && img.naturalWidth > 0) {
          markReady();
        }
      });
    } else {
      img.src = url;
    }
  } catch (e) {}
}

export function preloadFromLbItem(el) {
  if (!el) return;
  var fullUrl = (el.getAttribute && el.getAttribute("data-full")) || el.src;
  if (fullUrl) preloadImageUrl(fullUrl);
  var fbUrl = el.getAttribute && el.getAttribute("data-fb");
  if (fbUrl) preloadImageUrl(fbUrl);
}

export function preloadLightboxNeighbors(centerIdx, radius) {
  if (!LB.imgs || !LB.imgs.length) return;
  var len = LB.imgs.length;
  if (len <= 1) return;
  var r = radius || 3;
  var visited = new Set();
  visited.add(centerIdx);

  for (var d = 1; d <= r; d++) {
    var forward = (centerIdx + d) % len;
    if (!visited.has(forward)) {
      visited.add(forward);
      preloadFromLbItem(LB.imgs[forward]);
    }
    var backward = (centerIdx - d + len * 10) % len;
    if (!visited.has(backward)) {
      visited.add(backward);
      preloadFromLbItem(LB.imgs[backward]);
    }
  }
}

