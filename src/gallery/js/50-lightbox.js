  // --- Zenith Aurora Lightbox Stage ---
  var lbLoadToken = 0;

  function syncStageAspectRatio(el) {
    var vimg = document.getElementById("vimg");
    if (!vimg || !el) return;
    var w = el.naturalWidth || (el.getAttribute && Number(el.getAttribute("width"))) || el.width;
    var h = el.naturalHeight || (el.getAttribute && Number(el.getAttribute("height"))) || el.height;
    if (w && h && h > 0) {
      var r = +(w / h).toFixed(4);
      vimg.style.setProperty("--img-ratio", String(r));
    }
  }

  function setLightboxImage(fullUrl) {
    var stage = document.getElementById("lbImageStage");
    var vimg = document.getElementById("vimg");
    if (!vimg) return;

    var token = ++lbLoadToken;

    // Pre-sync aspect ratio from the active thumbnail to eliminate layout pop
    var currentImg = lbImages[lbIndex];
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
      var curImg = lbImages[lbIndex];
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

  function openLightbox(fullUrl, caption, imgs, index, item) {
    var lb = document.getElementById("lightbox");
    var vimg = document.getElementById("vimg");
    var vcap = document.getElementById("vcap");
    var vthumbs = document.getElementById("vthumbs");
    if (!lb || !vimg || !vcap || !vthumbs) return;

    lbImages = imgs ? Array.from(imgs) : [];
    lbIndex = index || 0;
    lbCurrentItem = item || null;

    setLightboxImage(fullUrl);
    vcap.textContent = caption;

    // Build Thumbnail Strip
    vthumbs.innerHTML = "";
    lbImages.forEach(function (imgEl, i) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.vi = String(i);
      if (i === lbIndex) btn.classList.add("cur");

      var thumb = document.createElement("img");
      thumb.src = imgEl.src;
      thumb.alt = "Thumb " + (i + 1);
      thumb.loading = "lazy";
      btn.appendChild(thumb);

      btn.addEventListener("click", function () {
        lbIndex = i;
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
    preloadLightboxNeighbors(lbIndex, 3);
  }

  function updateLightboxState() {
    if (!lbImages.length) return;
    var currentImg = lbImages[lbIndex];
    var full = currentImg.getAttribute("data-full") || currentImg.src;
    setLightboxImage(full);
    document.getElementById("vcap").textContent =
      (lbIndex + 1) + " / " + lbImages.length + " " + (lbCurrentItem ? lbCurrentItem.name : "");

    var thumbs = document.querySelectorAll("#vthumbs button[data-vi]");
    thumbs.forEach(function (t, i) {
      if (i === lbIndex) t.classList.add("cur");
      else t.classList.remove("cur");
    });

    // Predictively preload neighboring images around the new position
    preloadLightboxNeighbors(lbIndex, 3);
  }

  function closeLightbox() {
    var lb = document.getElementById("lightbox");
    if (!lb) return;
    lb.classList.remove("open");
    lb.setAttribute("aria-hidden", "true");
    var stage = document.getElementById("lbImageStage");
    if (stage) {
      stage.classList.remove("is-loading");
      stage.classList.remove("is-error");
    }
    var vimg = document.getElementById("vimg");
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

  function stepLightbox(delta) {
    if (!lbImages.length) return;
    lbIndex = (lbIndex + delta + lbImages.length) % lbImages.length;
    updateLightboxState();
    playBeep(450, "sine", 0.02);
  }

