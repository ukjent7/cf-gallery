// --- Zenith Aurora Lightbox Stage ---
import { playBeep } from "./15-state.js";
import { capSet, preloadedReady, preloadFromLbItem, preloadLightboxNeighbors } from "./45-rails-preload.js";

// Lightbox session state, shared with the rails preloader.
export var LB = { imgs: [], idx: 0, item: null };
var lbLoadToken = 0;

export function syncStageAspectRatio(el) {
  var vimg = /** @type {HTMLImageElement} */ (document.getElementById("vimg"));
  if (!vimg || !el) return;
  var w = el.naturalWidth || (el.getAttribute && Number(el.getAttribute("width"))) || el.width;
  var h = el.naturalHeight || (el.getAttribute && Number(el.getAttribute("height"))) || el.height;
  if (w && h && h > 0) {
    var r = +(w / h).toFixed(4);
    vimg.style.setProperty("--img-ratio", String(r));
  }
}

export function setLightboxImage(fullUrl) {
  var stage = document.getElementById("lbImageStage");
  var vimg = /** @type {HTMLImageElement} */ (document.getElementById("vimg"));
  if (!vimg) return;

  var token = ++lbLoadToken;

  // Pre-sync aspect ratio from the active thumbnail to eliminate layout pop
  var currentImg = LB.imgs[LB.idx];
  if (currentImg) syncStageAspectRatio(currentImg);

  if (stage) stage.classList.remove("is-error");

  // Check if this exact image is already confirmed loaded on this element
  var isAlreadyLoaded = (vimg.dataset.loadedUrl === fullUrl && vimg.getAttribute("src") === fullUrl && vimg.naturalWidth > 0);

  if (isAlreadyLoaded) {
    syncStageAspectRatio(vimg);
    if (stage) stage.classList.remove("is-loading");
    vimg.classList.remove("is-loading");
    vimg.classList.remove("is-switching");
    return;
  }

  // Immediately mark stage as loading and fade out old image so it never lingers
  if (stage) stage.classList.add("is-loading");
  vimg.classList.add("is-loading");
  vimg.classList.add("is-switching");

  // Synchronously set src so attributes and synchronous tests stay in sync
  vimg.src = fullUrl;

  var cleanup = function () {
    vimg.removeEventListener("load", onLoaded);
    vimg.removeEventListener("error", onError);
  };

  var onLoaded = function () {
    cleanup();
    if (token !== lbLoadToken) return;
    preloadedReady.add(fullUrl);
    capSet(preloadedReady);
    vimg.dataset.loadedUrl = fullUrl;
    syncStageAspectRatio(vimg);
    if (stage) {
      stage.classList.remove("is-loading");
      stage.classList.remove("is-error");
    }
    requestAnimationFrame(function () {
      vimg.classList.remove("is-loading");
      vimg.classList.remove("is-switching");
    });
  };

  var onError = function () {
    cleanup();
    if (token !== lbLoadToken) return;
    var curImg = LB.imgs[LB.idx];
    var fb = curImg && curImg.getAttribute("data-fb");
    if (fb && fb !== fullUrl) {
      setLightboxImage(fb);
      return;
    }
    if (stage) {
      stage.classList.remove("is-loading");
      stage.classList.add("is-error");
    }
    vimg.classList.remove("is-loading");
    vimg.classList.add("is-switching");
  };

  vimg.addEventListener("load", onLoaded);
  vimg.addEventListener("error", onError);

  // If preloaded, decode asynchronously for instant presentation
  if (preloadedReady.has(fullUrl)) {
    if (typeof vimg.decode === "function") {
      vimg.decode().then(function () {
        if (token === lbLoadToken) onLoaded();
      }).catch(function () {
        // let normal onload fire
      });
    }
  }
}

export function openLightbox(fullUrl, caption, imgs, index, item) {
  var lb = document.getElementById("lightbox");
  var vimg = /** @type {HTMLImageElement} */ (document.getElementById("vimg"));
  var vcap = document.getElementById("vcap");
  var vthumbs = document.getElementById("vthumbs");
  if (!lb || !vimg || !vcap || !vthumbs) return;

  LB.imgs = imgs ? Array.from(imgs) : [];
  LB.idx = index || 0;
  LB.item = item || null;

  setLightboxImage(fullUrl);
  vcap.textContent = caption;

  // Build Thumbnail Strip
  vthumbs.innerHTML = "";
  LB.imgs.forEach(function (imgEl, i) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.vi = String(i);
    if (i === LB.idx) btn.classList.add("cur");

    var thumb = document.createElement("img");
    thumb.src = imgEl.src;
    thumb.alt = "Thumb " + (i + 1);
    thumb.loading = "lazy";
    btn.appendChild(thumb);

    btn.addEventListener("click", function () {
      LB.idx = i;
      updateLightboxState();
    });
    // Predictive hover prefetch when hovering thumb
    btn.addEventListener("mouseenter", function () {
      preloadFromLbItem(imgEl);
    });
    vthumbs.appendChild(btn);
  });

  lb.classList.add("open");
  lb.setAttribute("aria-hidden", "false");
  document.body.classList.add("locked");

  // Predictively preload neighboring full-res images (+1, -1, +2, -2, +3, -3)
  preloadLightboxNeighbors(LB.idx, 3);
}

function updateLightboxState() {
  if (!LB.imgs.length) return;
  var currentImg = LB.imgs[LB.idx];
  var full = currentImg.getAttribute("data-full") || currentImg.src;
  setLightboxImage(full);
  document.getElementById("vcap").textContent =
    (LB.idx + 1) + " / " + LB.imgs.length + " " + (LB.item ? LB.item.name : "");

  var thumbs = document.querySelectorAll("#vthumbs button[data-vi]");
  thumbs.forEach(function (t, i) {
    if (i === LB.idx) t.classList.add("cur");
    else t.classList.remove("cur");
  });

  // Predictively preload neighboring images around the new position
  preloadLightboxNeighbors(LB.idx, 3);
}

export function closeLightbox() {
  var lb = document.getElementById("lightbox");
  if (!lb) return;
  lb.classList.remove("open");
  lb.setAttribute("aria-hidden", "true");
  var stage = document.getElementById("lbImageStage");
  if (stage) {
    stage.classList.remove("is-loading");
    stage.classList.remove("is-error");
  }
  var vimg = /** @type {HTMLImageElement} */ (document.getElementById("vimg"));
  if (vimg) {
    vimg.classList.remove("is-switching");
    vimg.classList.remove("is-loading");
    vimg.src = "";
    delete vimg.dataset.loadedUrl;
  }
  var drawer = document.getElementById("drawer");
  if (!drawer || !drawer.classList.contains("open")) {
    document.body.classList.remove("locked");
  }
}

export function stepLightbox(delta) {
  if (!LB.imgs.length) return;
  LB.idx = (LB.idx + delta + LB.imgs.length) % LB.imgs.length;
  updateLightboxState();
  playBeep(450, "sine", 0.02);
}

