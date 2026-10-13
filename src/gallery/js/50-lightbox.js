// --- Zenith Aurora Lightbox Stage ---
import { playBeep } from "./15-state.js";
import { capSet, preloadedReady, preloadFromLbItem, preloadLightboxNeighbors } from "./45-rails-preload.js";

// Lightbox session state, shared with the rails preloader.
export const LB = { imgs: [], idx: 0, item: null };
let lbLoadToken = 0;

export function syncStageAspectRatio(el) {
  const vimg = /** @type {HTMLImageElement} */ (document.getElementById("vimg"));
  if (!vimg || !el) return;
  const w = el.naturalWidth || (el.getAttribute && Number(el.getAttribute("width"))) || el.width;
  const h = el.naturalHeight || (el.getAttribute && Number(el.getAttribute("height"))) || el.height;
  if (w && h && h > 0) {
    const r = +(w / h).toFixed(4);
    vimg.style.setProperty("--img-ratio", String(r));
  }
}

export function setLightboxImage(fullUrl) {
  const stage = document.getElementById("lbImageStage");
  const vimg = /** @type {HTMLImageElement} */ (document.getElementById("vimg"));
  if (!vimg) return;

  const token = ++lbLoadToken;

  // Pre-sync aspect ratio from the active thumbnail to eliminate layout pop
  const currentImg = LB.imgs[LB.idx];
  if (currentImg) syncStageAspectRatio(currentImg);

  if (stage) stage.classList.remove("is-error");

  // Check if this exact image is already confirmed loaded on this element
  const isAlreadyLoaded = (vimg.dataset.loadedUrl === fullUrl && vimg.getAttribute("src") === fullUrl && vimg.naturalWidth > 0);

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

  const cleanup = () => {
    vimg.removeEventListener("load", onLoaded);
    vimg.removeEventListener("error", onError);
  };

  const onLoaded = () => {
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
    requestAnimationFrame(() => {
      vimg.classList.remove("is-loading");
      vimg.classList.remove("is-switching");
    });
  };

  const onError = () => {
    cleanup();
    if (token !== lbLoadToken) return;
    const curImg = LB.imgs[LB.idx];
    const fb = curImg && curImg.getAttribute("data-fb");
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
      vimg.decode().then(() => {
        if (token === lbLoadToken) onLoaded();
      }).catch(() => {
        // let normal onload fire
      });
    }
  }
}

export function openLightbox(fullUrl, caption, imgs, index = 0, item = null) {
  const lb = document.getElementById("lightbox");
  const vimg = /** @type {HTMLImageElement} */ (document.getElementById("vimg"));
  const vcap = document.getElementById("vcap");
  const vthumbs = document.getElementById("vthumbs");
  if (!lb || !vimg || !vcap || !vthumbs) return;

  LB.imgs = imgs ? Array.from(imgs) : [];
  LB.idx = index || 0;
  LB.item = item || null;

  setLightboxImage(fullUrl);
  vcap.textContent = caption;

  // Build Thumbnail Strip
  vthumbs.innerHTML = "";
  LB.imgs.forEach((imgEl, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.vi = String(i);
    if (i === LB.idx) btn.classList.add("cur");

    const thumb = document.createElement("img");
    thumb.src = imgEl.src;
    thumb.alt = "Thumb " + (i + 1);
    thumb.loading = "lazy";
    btn.appendChild(thumb);

    btn.addEventListener("click", () => {
      LB.idx = i;
      updateLightboxState();
    });
    // Predictive hover prefetch when hovering thumb
    btn.addEventListener("mouseenter", () => {
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
  const currentImg = LB.imgs[LB.idx];
  const full = currentImg.getAttribute("data-full") || currentImg.src;
  setLightboxImage(full);
  document.getElementById("vcap").textContent =
    (LB.idx + 1) + " / " + LB.imgs.length + " " + (LB.item ? LB.item.name : "");

  const thumbs = document.querySelectorAll("#vthumbs button[data-vi]");
  thumbs.forEach((t, i) => {
    if (i === LB.idx) t.classList.add("cur");
    else t.classList.remove("cur");
  });

  // Predictively preload neighboring images around the new position
  preloadLightboxNeighbors(LB.idx, 3);
}

export function closeLightbox() {
  const lb = document.getElementById("lightbox");
  if (!lb) return;
  lb.classList.remove("open");
  lb.setAttribute("aria-hidden", "true");
  const stage = document.getElementById("lbImageStage");
  if (stage) {
    stage.classList.remove("is-loading");
    stage.classList.remove("is-error");
  }
  const vimg = /** @type {HTMLImageElement} */ (document.getElementById("vimg"));
  if (vimg) {
    vimg.classList.remove("is-switching");
    vimg.classList.remove("is-loading");
    vimg.src = "";
    delete vimg.dataset.loadedUrl;
  }
  const drawer = document.getElementById("drawer");
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
