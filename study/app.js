/* BLS Leaf Scorer: UI, capture, saving and sync. */
(function () {
  "use strict";

  var E = window.BLSEngine;
  var Records = window.BLSStore.Records;
  var Settings = window.BLSStore.Settings;
  var C = window.BLSConnectors;

  var MAX_ANALYSIS_SIDE = 2048; // matches the example images (about 2048 px tall)
  var MAX_STORED_SIDE = 1600;   // photos kept on the phone and uploaded
  var APP_VERSION = "0.13.0";
  // Anonymous device count (the developer's counter, connectors/usage/Usage.gs).
  // Empty = nothing is sent. See privacy.html for exactly what is counted.
  var USAGE_URL = "";
  var GAUGE_C = 2 * Math.PI * 56;

  var $ = function (id) { return document.getElementById(id); };
  var settings = Settings.load();
  var current = null;   // { name, imageData, result, overlayData, sample }
  var gps = null;
  var syncing = false;
  var allRecords = [];  // latest copy of all records, for plot hints and progress
  var reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- helpers ----------
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }
  function scoreColor(s) { return "var(--s" + s + ")"; }
  function fmtPct(x) { return (x == null ? "–" : (Math.round(x * 10) / 10).toFixed(1) + "%"); }
  var toastTimer = null;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* not supported */ } }
  function countUp(el, to, decimals, suffix) {
    var token = {};
    el._countUp = token;   // a newer animation on the same element stops this one
    if (reduceMotion) { el.textContent = to.toFixed(decimals) + suffix; return; }
    var start = performance.now(), dur = 700;
    (function step(now) {
      if (el._countUp !== token) return;
      var t = Math.min(1, Math.max(0, (now - start) / dur)), e = 1 - Math.pow(1 - t, 3);
      el.textContent = (to * e).toFixed(decimals) + suffix;
      if (t < 1) requestAnimationFrame(step);
    })(start);
  }

  // ---------- tabs ----------
  function showTab(name) {
    ["analyze", "records", "settings"].forEach(function (t) { $("view-" + t).hidden = t !== name; });
    document.querySelectorAll(".tab").forEach(function (b) {
      if (b.dataset.tab === name) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    if (name === "records") renderRecords();
    if (name === "settings") { renderSettings(); renderPhoneInfo(); }
    window.scrollTo(0, 0);
  }
  document.querySelectorAll(".tab").forEach(function (b) {
    b.addEventListener("click", function () { showTab(b.dataset.tab); });
  });
  $("syncPill").addEventListener("click", function () { showTab("records"); });
  $("viewRecordsBtn").addEventListener("click", function () { showTab("records"); });

  // Analyze screen has four states: capture, busy, result, saved
  function analyzeState(state) {
    $("capture").hidden = !(state === "capture" || state === "example");
    $("rate").hidden = state !== "rate";
    $("busy").hidden = state !== "busy";
    $("result").hidden = !(state === "result" || state === "example");
    $("savedCard").hidden = state !== "saved";
    $("errorCard").hidden = state !== "error";
    if (state === "error") $("capture").hidden = false;
    if (state === "capture" || state === "saved") refreshResume(); else $("resumeCard").hidden = true;
  }

  // ---------- image loading ----------
  function decode(blob) {
    if (window.createImageBitmap) {
      // Respect EXIF rotation so the preview looks right. Pixel counts do not
      // depend on orientation, so scores still match the R pipeline.
      return createImageBitmap(blob, { imageOrientation: "from-image" }).catch(function () { return createImageBitmap(blob); });
    }
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("This file is not an image the phone can open.")); };
      img.src = URL.createObjectURL(blob);
    });
  }

  function toImageData(src, maxSide) {
    var w = src.width, h = src.height;
    var k = Math.min(1, maxSide / Math.max(w, h));
    var cw = Math.round(w * k), ch = Math.round(h * k);
    var c = document.createElement("canvas");
    c.width = cw; c.height = ch;
    var ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, cw, ch);
    return ctx.getImageData(0, 0, cw, ch);
  }

  // Long leaves: sections are stacked end to end into one image
  function compose(list) {
    if (list.length === 1) return list[0];
    var w = 0, h = 0;
    list.forEach(function (d) { w = Math.max(w, d.width); h += d.height; });
    var c = document.createElement("canvas"); c.width = w; c.height = h;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
    var y = 0;
    list.forEach(function (d) { ctx.putImageData(d, Math.round((w - d.width) / 2), y); y += d.height; });
    return ctx.getImageData(0, 0, w, h);
  }

  // Score one photo inside the leaf region the app found.
  // found: {roi, method, points?, labels?, leafCount?} or null (whole photo is leaf)
  function analyzeSection(sec, found) {
    var roi = found && found.roi ? found.roi : null;
    var d = sec.imageData;
    var res = E.analyze(d.data, d.width, d.height, undefined, roi || undefined, currentRules());
    sec.result = res;
    sec.roi = roi || null;
    sec.found = found || null;
    sec.segmentation = found ? found.method : "whole photo";
    sec.samPoints = found && found.points ? found.points : null;
    sec.perLeaf = res.ok && found && found.labels && found.leafCount > 1 ? E.perRegion(res.mask, found.labels, found.leafCount) : null;
    if (res.ok) {
      var px = E.overlay(d.data, res.mask, 0.45);
      // Darken everything outside the outline so it's clear what was scored
      if (roi) for (var i = 0, p = 0; i < roi.length; i++, p += 4) {
        if (!roi[i]) { px[p] *= 0.25; px[p + 1] *= 0.25; px[p + 2] *= 0.25; }
      }
      sec.overlayData = new ImageData(px, d.width, d.height);
      delete res.mask;
    }
    return sec;
  }

  function rebuildCurrent() {
    var secs = current.sections;
    current.result = secs.length > 1
      ? E.combine(secs.map(function (x) { return x.result; }))
      : Object.assign({ sections: 1 }, secs[0].result);
    current.imageData = compose(secs.map(function (x) { return x.imageData; }));
    current.overlayData = compose(secs.map(function (x) { return x.overlayData; }));
    current.result.width = current.imageData.width;
    current.result.height = current.imageData.height;
    current.name = secs.map(function (x) { return x.name; }).join(" + ");
    var segs = secs.map(function (x) { return x.segmentation; });
    current.result.segmentation = segs.every(function (v) { return v === segs[0]; }) ? segs[0] : "mixed";
    current.result.rules = secs[0].result.rules;
    var per = [];
    secs.forEach(function (x) { if (x.perLeaf) per = per.concat(x.perLeaf); });
    current.result.perLeaf = per.length > 1 ? per : null;
    // Lesions across sections: counts add up; mean size weighted by count
    var lc = 0, lsum = 0, lmax = 0;
    secs.forEach(function (x) {
      var L = x.result.lesions; if (!L) return;
      lc += L.count; lsum += L.count * L.meanSizePct * x.result.leafPixels; lmax = Math.max(lmax, L.largestPct * x.result.leafPixels);
    });
    var leafTot = secs.reduce(function (a, x) { return a + x.result.leafPixels; }, 0);
    current.result.lesions = { count: lc, meanSizePct: lc ? Math.round(lsum / lc / leafTot * 100) / 100 : 0, largestPct: Math.round(lmax / leafTot * 100) / 100 };
  }

  function handleFile(blob, name, isSample, asExample, append) {
    var appending = !!(append && current);
    // Study mode: the rater scores the original photo before the app scores it
    var blindNow = !!settings.blind && !isSample && !asExample && !appending;
    if (appending) $("busy").hidden = false; else analyzeState("busy");
    if (!isSample && !appending) requestGps();
    if (!appending) window.scrollTo(0, 0);
    if (!appending) pendingRating = null;
    // Let the spinner paint before the pixel loop runs
    setTimeout(function () {
      decode(blob).then(function (bmp) {
        var data = toImageData(bmp, MAX_ANALYSIS_SIDE);
        if (!blindNow) return scorePhoto(data);
        return askRating(data, name).then(function (locked) {
          if (!locked) return;
          analyzeState("busy");
          window.scrollTo(0, 0);
          return new Promise(function (res) { setTimeout(res, 30); }).then(function () { return scorePhoto(data); });
        });
      }).catch(function (e) {
        $("busy").hidden = true;
        if (appending) { toast("That photo could not be read. Try again."); return; }
        $("errorText").textContent = (e && e.message) || "The photo could not be read. Try again.";
        analyzeState("error");
      });
    }, 30);

    function scorePhoto(data) {
        return (isSample ? Promise.resolve({ found: null }) : findLeaf(data)).then(function (step) {
          if (asExample && userActed) return { cancelled: true, stale: true };
          $("busy").hidden = true;
          // Leaf couldn't be found automatically: let the person mark it
          return step.manual ? openTracer(data, { method: "traced", reason: step.reason }).then(function (f) { return { found: f, cancelled: !f }; }) : step;
        }).then(function (step) {
          var found = step.found;
          // The example leaf must never replace a photo the person has taken
          if (step.stale || (asExample && userActed)) return;
          if (step.cancelled) {
            if (!appending) { analyzeState("capture"); current = null; }
            if (pendingRating) { pendingRating = null; toast("Rating not saved: the leaf was not marked."); if (batch.active) nextInQueue(); }
            return;
          }
          var sec = analyzeSection({ name: name, imageData: data }, found);
          if (!sec.result.ok) {
            if (appending) { toast(sec.result.message); return; }
            $("errorText").textContent = sec.result.message + (pendingRating ? " Your rating was not saved." : "");
            analyzeState("error");
            current = null;
            pendingRating = null;
            if (batch.active) setTimeout(nextInQueue, 1800);
            return;
          }
          if (appending) current.sections.push(sec);
          else current = { sections: [sec], sample: !!isSample };
          rebuildCurrent();
          if (!appending) analyzeState(asExample ? "example" : "result");
          renderResult();
          if (!asExample) buzz(25);
          if (appending) toast("Section " + current.sections.length + " added. Score updated for the whole leaf.");
        });
    }
  }

  // ---------- study mode: blind rating before the app scores ----------
  var pendingRating = null;   // { score, pct, rater, plot, seconds, ratedAt, position }
  var rateResolve = null, rateStarted = 0, rateScore = null;
  var batch = { active: false, queue: [], total: 0, pos: 0, done: 0 };

  (function () {
    var html = "";
    for (var k = 1; k <= 9; k++) html += '<button type="button" role="radio" aria-checked="false" data-rs="' + k + '" style="background:' + scoreColor(k) + '">' + k + "</button>";
    $("rRuler").innerHTML = html;
  })();
  function setRate(k) {
    rateScore = k;
    document.querySelectorAll("#rRuler button").forEach(function (b) { b.setAttribute("aria-checked", String(+b.dataset.rs === k)); });
  }
  $("rRuler").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-rs]");
    if (!b) return;
    setRate(rateScore === +b.dataset.rs ? null : +b.dataset.rs);
    $("rateErr").textContent = "";
    buzz(8);
  });
  // ---------- phone data entry ----------
  // % by tapping: chips for the usual estimates, −1/+1 to fine-tune; typing is optional
  var PCT_CHIPS = [0, 1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 90];
  $("pctChips").innerHTML = PCT_CHIPS.map(function (v) { return '<button type="button" data-v="' + v + '" aria-pressed="false">' + v + "</button>"; }).join("");
  function readPct() { var t = $("rPct").value.trim().replace(",", "."); return t === "" ? "" : parseFloat(t); }
  function markChips() {
    var cur = readPct();
    $("pctChips").querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-pressed", String(cur !== "" && +b.dataset.v === cur)); });
  }
  function setPct(v) {
    if (v === "" || v == null || !isFinite(v)) { $("rPct").value = ""; }
    else { v = Math.max(0, Math.min(100, Math.round(v * 10) / 10)); $("rPct").value = String(v); }
    markChips();
    $("rateErr").textContent = "";
  }
  $("pctChips").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-v]"); if (!b) return;
    setPct(+b.dataset.v); buzz(8);
  });
  document.querySelectorAll("[data-pct]").forEach(function (b) {
    b.addEventListener("click", function () { var c = readPct(); setPct((c === "" ? 0 : c) + (+b.dataset.pct)); buzz(6); });
  });
  $("rPct").addEventListener("input", markChips);   // typing is left as typed (e.g. "12.5")

  // Plant ID: step the number in the ID up or down (P-0099 → P-0100), keeps zero padding
  function stepId(id, d) {
    id = String(id || "");
    if (d > 0) { var np = nextPlotAfter(id); if (np) return np.plot; }
    var m = /^(.*?)(\d+)(\D*)$/.exec(id);
    if (!m) return id;
    var n = Math.max(0, parseInt(m[2], 10) + d), s = String(n);
    while (s.length < m[2].length) s = "0" + s;
    return m[1] + s + m[3];
  }
  // The specimen label under the photo follows the plant ID as it is typed or stepped
  function updateSpecLabel() {
    $("specPlot").textContent = $("rPlot").value.trim() || "–";
    var d = new Date().toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
    $("specMeta").textContent = (settings.rater ? "Rated by " + settings.rater + ", " : "") + d;
  }
  $("rPlot").addEventListener("input", updateSpecLabel);
  $("idUp").addEventListener("click", function () { $("rPlot").value = stepId($("rPlot").value, 1); updateSpecLabel(); buzz(6); });
  $("idDown").addEventListener("click", function () { $("rPlot").value = stepId($("rPlot").value, -1); updateSpecLabel(); buzz(6); });
  // Number pad or full keyboard for IDs, remembered on this phone
  function applyIdKeyboard() {
    var num = !!settings.idNumeric;
    $("rPlot").setAttribute("inputmode", num ? "numeric" : "text");
    $("idKb").textContent = num ? "Use letter keyboard" : "Use number pad";
  }
  $("idKb").addEventListener("click", function () {
    settings.idNumeric = !settings.idNumeric; Settings.save(settings); applyIdKeyboard();
    var i = $("rPlot"); i.blur(); setTimeout(function () { i.focus(); }, 60);
  });
  applyIdKeyboard();

  // "Done" on the phone keyboard closes it
  ["rPlot", "rPct"].forEach(function (id) {
    $(id).addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); ev.target.blur(); } });
  });
  // While typing, the bottom tab bar steps aside so the keyboard does not cover the fields
  document.addEventListener("focusin", function (ev) {
    if (ev.target.matches && ev.target.matches("input[type=text], input[type=number], input:not([type]), textarea")) document.body.classList.add("typing");
  });
  document.addEventListener("focusout", function () { setTimeout(function () {
    var a = document.activeElement;
    if (!a || !a.matches || !a.matches("input, textarea")) document.body.classList.remove("typing");
  }, 50); });

  // Scan the plant label (QR code or barcode) to fill in the ID. Android Chrome and
  // Edge have a built-in barcode reader; elsewhere the button stays hidden.
  var scan = null;
  if ("BarcodeDetector" in window) $("idScan").hidden = false;
  $("idScan").addEventListener("click", function () {
    var det;
    try { det = new window.BarcodeDetector(); } catch (e) { toast("Scanning is not available on this phone"); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }).then(function (stream) {
      scan = { stream: stream, det: det, timer: null };
      var v = $("scanVideo"); v.srcObject = stream; v.play();
      $("scanner").hidden = false;
      (function look() {
        if (!scan) return;
        det.detect(v).then(function (codes) {
          if (!scan) return;
          var c = codes && codes[0] && String(codes[0].rawValue || "").trim();
          if (c) { $("rPlot").value = c.slice(0, 60); updateSpecLabel(); buzz([20, 40, 20]); closeScan(); toast("Plant ID: " + c.slice(0, 60)); return; }
          scan.timer = setTimeout(look, 200);
        }, function () { if (scan) scan.timer = setTimeout(look, 400); });
      })();
    }, function () { toast("Camera not allowed. Type the ID instead."); });
  });
  function closeScan() {
    if (!scan) { $("scanner").hidden = true; return; }
    clearTimeout(scan.timer);
    scan.stream.getTracks().forEach(function (t) { t.stop(); });
    scan = null;
    $("scanVideo").srcObject = null;
    $("scanner").hidden = true;
  }
  $("scanClose").addEventListener("click", closeScan);
  var lastRatedPlot = "";

  function drawPhoto(canvas, frame, data) {
    var rotate = data.height > data.width * 1.6;
    var tmp = document.createElement("canvas");
    tmp.width = data.width; tmp.height = data.height;
    tmp.getContext("2d").putImageData(data, 0, 0);
    canvas.width = rotate ? data.height : data.width;
    canvas.height = rotate ? data.width : data.height;
    var ctx = canvas.getContext("2d");
    if (rotate) { ctx.translate(canvas.width, 0); ctx.rotate(Math.PI / 2); }
    ctx.drawImage(tmp, 0, 0);
    frame.classList.toggle("tall", !rotate && data.height > data.width);
    frame.classList.toggle("rot", rotate);
    frame.scrollLeft = 0;
  }
  function stem(name) { return String(name || "").replace(/\.[^.]+$/, ""); }

  function askRating(data, name) {
    drawPhoto($("rateCanvas"), $("rateFrame"), data);
    // The rater ID is asked once; after that it is shown, not asked again
    $("rRater").value = settings.rater || $("fRater").value.trim() || "";
    showRaterField(!$("rRater").value);
    // In a photo set the ID is the file name; otherwise suggest the next ID after the last one
    $("rPlot").value = batch.active ? stem(name) : (lastRatedPlot ? stepId(lastRatedPlot, 1) : $("fPlot").value.trim());
    setRate(null);
    setPct("");
    updateSpecLabel();
    $("rateErr").textContent = "";
    $("rateProgress").textContent = batch.active ? "Photo " + batch.pos + " of " + batch.total + " · rate first" : "Rate first";
    analyzeState("rate");
    window.scrollTo(0, 0);
    rateStarted = Date.now();
    return new Promise(function (res) { rateResolve = res; });
  }

  function showRaterField(ask) {
    $("rRaterField").hidden = !ask;
    $("rRaterChip").hidden = ask;
    $("rIdRow").classList.toggle("one", !ask);
    $("rRaterName").textContent = $("rRater").value;
  }
  $("rRaterChange").addEventListener("click", function () { openWelcome(true); });

  $("rateLock").addEventListener("click", function () {
    var rater = $("rRater").value.trim(), plot = $("rPlot").value.trim();
    var pct = readPct();
    var err = !rater ? "Enter your rater ID." : !plot ? "Enter the plant or image ID." : !rateScore ? "Tap your 1–9 score." :
      (pct !== "" && !(pct >= 0 && pct <= 100)) ? "Diseased area must be between 0 and 100%." : "";
    if (err) { $("rateErr").textContent = err; buzz(40); return; }
    pendingRating = {
      score: rateScore, pct: pct === "" ? "" : Math.round(pct * 10) / 10, rater: rater, plot: plot,
      seconds: Math.round((Date.now() - rateStarted) / 100) / 10, ratedAt: new Date().toISOString(),
      position: batch.active ? batch.pos + "/" + batch.total : ""
    };
    // The save form picks these up; the rater ID is remembered for the next leaf
    $("fPlot").value = plot; $("fRater").value = rater;
    if (batch.active) $("fLeaf").value = "1"; else lastRatedPlot = plot;
    settings.rater = rater; Settings.save(settings);
    buzz(20);
    var r = rateResolve; rateResolve = null;
    if (r) r(true);
  });
  $("rateSkip").addEventListener("click", function () {
    pendingRating = null;
    var r = rateResolve; rateResolve = null;
    if (r) r(false);
    if (batch.active) nextInQueue(); else analyzeState("capture");
  });

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  $("batchInput").addEventListener("click", function () { userActed = true; });
  var Sets = window.BLSStore.Sets;

  // Hidden repeats: a share of the set comes back later, unannounced, so each rater's
  // consistency can be measured. Only in photo sets, never for photos taken with the camera.
  function addHiddenRepeats(items) {
    var pct = +settings.repeatPct || 0;
    if (pct <= 0 || items.length < 5) return items;
    var n = Math.max(1, Math.round(items.length * pct / 100));
    // repeat photos from the first 70% of the set, shown again at least 3 photos later
    var picks = shuffle(items.slice(0, Math.ceil(items.length * 0.7))).slice(0, n);
    var out = items.slice();
    picks.forEach(function (it) {
      var lo = Math.min(out.length, out.indexOf(it) + 4);
      out.splice(lo + Math.floor(Math.random() * (out.length - lo + 1)), 0, { name: it.name, blob: it.blob, repeat: true });
    });
    return out;
  }

  // Photos are copied into the app (at the size it scores, 2048 px) so the set
  // survives the phone locking, the app closing or the battery dying.
  $("batchInput").addEventListener("change", function (ev) {
    userActed = true;
    var files = Array.prototype.slice.call(ev.target.files || []);
    ev.target.value = "";
    if (!files.length) return;
    if (settings.shuffle) shuffle(files);
    else files.sort(function (a, b) { return natural(a.name, b.name); });
    batch.active = false;
    analyzeState("busy");
    var items = [], k = 0;
    (function prepNext() {
      if (k >= files.length) return startSet(items);
      var f = files[k++];
      busyText("Preparing your set…", "Photo " + k + " of " + files.length + ". Kept on this phone until the set is done.");
      decode(f).then(function (bmp) {
        return canvasBlob(toImageData(bmp, MAX_ANALYSIS_SIDE), MAX_ANALYSIS_SIDE);
      }).then(function (blob) { items.push({ name: f.name || ("photo-" + k + ".jpg"), blob: blob, repeat: false }); },
        function () { toast("Skipped " + (f.name || "a photo") + ": it could not be opened"); })
        .then(function () { setTimeout(prepNext, 0); });
    })();
  });
  function startSet(items) {
    if (!items.length) { analyzeState("capture"); toast("None of these photos could be opened"); return; }
    var full = addHiddenRepeats(items);
    var meta = { total: full.length, next: 0, done: 0, rater: settings.rater || "", startedAt: new Date().toISOString() };
    Sets.save(meta, full).catch(function () { toast("Not enough space to keep the set; it works until the app is closed"); });
    batch = { active: true, queue: full.slice(), total: full.length, pos: 0, done: 0, startedAt: meta.startedAt, item: null };
    $("resumeCard").hidden = true;
    nextInQueue();
  }
  function nextInQueue() {
    if (!batch.active) return;
    // Remember how far the set has got: a photo counts once it is saved, skipped or failed
    Sets.update({ total: batch.total, next: batch.pos, done: batch.done, rater: settings.rater || "", startedAt: batch.startedAt }).catch(function () {});
    var it = batch.queue.shift();
    if (!it) {
      batch.active = false;
      current = null;
      Sets.clear().catch(function () {});
      $("savedTitle").textContent = "Set finished";
      $("savedText").textContent = batch.done + " of " + batch.total + " photos rated and saved.";
      $("nextPlotBtn").hidden = true;
      analyzeState("saved");
      return;
    }
    batch.pos++;
    batch.item = it;
    handleFile(it.blob, it.name || ("photo-" + batch.pos + ".jpg"), false, false);
  }

  // A set that was interrupted is offered on the home screen
  function refreshResume() {
    if (batch.active) { $("resumeCard").hidden = true; return; }
    Sets.meta().then(function (m) {
      var show = !!(m && m.next < m.total);
      $("resumeCard").hidden = !show;
      if (!show) return;
      $("resumeTitle").textContent = "Continue your set at photo " + (m.next + 1) + " of " + m.total;
      $("resumeText").textContent = m.done + " rated so far" + (m.rater ? " by " + m.rater : "") + ", started " +
        new Date(m.startedAt).toLocaleDateString([], { day: "numeric", month: "short" }) + ".";
      delete $("resumeDiscard").dataset.armed;
      $("resumeDiscard").textContent = "Discard set";
    }).catch(function () { $("resumeCard").hidden = true; });
  }
  $("resumeGo").addEventListener("click", function () {
    Promise.all([Sets.meta(), Sets.items()]).then(function (r) {
      var m = r[0], items = r[1];
      if (!m || !items.length) { refreshResume(); return; }
      batch = { active: true, queue: items.slice(m.next), total: m.total, pos: m.next, done: m.done, startedAt: m.startedAt, item: null };
      $("resumeCard").hidden = true;
      nextInQueue();
    });
  });
  $("resumeDiscard").addEventListener("click", function () {
    var b = $("resumeDiscard");
    if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again to discard"; return; }
    Sets.clear().then(function () { $("resumeCard").hidden = true; toast("Set discarded. Saved ratings are kept."); });
  });

  // After the rating is locked: show rater vs app, keep the rating fixed
  function renderRating() {
    var cmp = $("cmpCard"), ruler = $("visRuler");
    $("discardBtn").textContent = batch.active ? "Skip" : "Retake";
    if (!pendingRating) { cmp.hidden = true; ruler.classList.remove("locked"); return; }
    var p = pendingRating, r = current.result;
    setVisual(p.score);
    ruler.classList.add("locked");
    $("visHint").textContent = "Rated blind by " + p.rater + " before the app's score was shown. Locked.";
    var d = r.score - p.score;
    cmp.innerHTML =
      '<div class="cmp"><span class="eyebrow">' + esc(p.rater) + ', by eye</span><b class="num" style="color:' + scoreColor(p.score) + '">' + p.score + '</b><span class="small">' + (p.pct === "" ? "no % given" : fmtPct(p.pct) + " diseased") + "</span></div>" +
      '<div class="cmp"><span class="eyebrow">App</span><b class="num" style="color:' + scoreColor(r.score) + '">' + r.score + '</b><span class="small">' + fmtPct(r.diseasedPct) + " diseased</span></div>" +
      '<span class="small muted cmp-note">' + (d === 0 ? "Same score." : "The app scored " + Math.abs(d) + " " + (d > 0 ? "higher" : "lower") + ".") +
      " Rating took " + p.seconds + " s. It is locked and saved with this record" + (batch.active ? " (" + p.position + ")" : "") + ".</span>";
    cmp.hidden = false;
  }

  /*
   * Automatic leaf separation:
   *  1. Board or dark cloth behind the leaf: separate by colour (instant), keeps several leaves.
   *  2. Anything else (field, hand, soil, other plants): AI leaf finder picks the leaf.
   *  3. Photo already cropped to the leaf: score the whole photo.
   *  4. Otherwise ask the person to mark the leaf.
   */
  function busyText(title, text) {
    $("busyTitle").textContent = title;
    $("busyText").textContent = text;
  }
  function findLeaf(data) {
    busyText("Finding the leaf…", "Separating the leaf from the background");
    // Same leaf finding as the Python analyzer (leaffind.js): any uniform background,
    // labels / tape / glare dropped, only leaf-shaped pieces kept
    var lf = window.BLSLeafFind ? window.BLSLeafFind.segment(data.data, data.width, data.height) : null;
    var bgFound = lf && lf.mask ? { roi: lf.mask, method: "background", labels: lf.labels, leafCount: lf.leafCount, info: lf.info } : null;
    if (bgFound && lf.confident) return Promise.resolve({ found: bgFound });
    // Background only partly uniform or the piece is not leaf-shaped: the AI leaf finder
    // decides, and the background result is kept as the fallback (as in the Python analyzer)
    return getSeg().then(function (m) {
      if (!m.isLoaded()) busyText("Getting the leaf finder ready…", "First time only: downloading about 25 MB, then it works offline");
      return m.load(function (f) { busyText("Getting the leaf finder ready…", "First time only: downloading " + Math.round(f * 100) + "% of 25 MB"); })
        .then(function () {
          busyText("Finding the leaf…", "The AI leaf finder is separating the leaf from the background");
          var cached = samCache.get(data);
          return cached ? cached : m.embed(data).then(function (h) { samCache.set(data, h); return h; });
        })
        .then(function (h) { return m.autoMask(h, data); });
    }).then(function (a) {
      if (a) { noteFinder(null); return { found: { roi: a.roi, method: "auto", points: a.points || [a.point] } }; }
      if (bgFound) return { found: bgFound };
      // Never score a field photo whole: ask the person instead
      return { manual: true, reason: "The app couldn't find a single leaf in this photo." };
    }, function (e) {
      noteFinder(e);
      if (bgFound) return { found: bgFound };
      return { manual: true, reason: "The automatic leaf finder couldn't run on this phone (" + (e && e.message ? e.message : "error") + ")." };
    });
  }

  // Remember leaf-finder problems; after a failure, use one thread next time
  function noteFinder(e) {
    settings.finderError = e ? String(e && e.message || e).slice(0, 200) : "";
    settings.finderOk = !e;
    Settings.save(settings);
    try {
      if (e) localStorage.setItem("bls-sam-threads", "1");
      else localStorage.removeItem("bls-sam-threads");   // worked: try all CPU cores again next time
    } catch (x) { /* ignore */ }
  }

  $("secInput").addEventListener("change", function (ev) {
    var f = ev.target.files && ev.target.files[0];
    if (f && current) handleFile(f, f.name || ("section-" + Date.now() + ".jpg"), false, false, true);
    ev.target.value = "";
  });

  function renderSections() {
    var secs = current.sections;
    var html = secs.length > 1 ? secs.map(function (x, i) {
      return '<span class="sec-chip">Section ' + (i + 1) + " · " + fmtPct(x.result.diseasedPct) +
        '<button type="button" data-rm="' + i + '" aria-label="Remove section ' + (i + 1) + '">×</button></span>';
    }).join("") : "";
    var last = secs[secs.length - 1];
    html += '<button class="add-sec solid" type="button" data-outline>' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 19c3-1 4-6 7-9s6-3 7-5" stroke-dasharray="3 3"/><circle cx="5" cy="19" r="2"/></svg>' +
      "Adjust leaf edges" + (secs.length > 1 ? " (section " + secs.length + ")" : "") + "</button>";
    html += '<label class="add-sec" for="secInput"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Add section</label>';
    $("sections").innerHTML = html;
  }
  // Outline (or redraw) the leaf on the latest section and re-score it
  function outlineLastSection() {
    if (!current) return;
    var sec = current.sections[current.sections.length - 1];
    openTracer(sec.imageData, { points: sec.samPoints, method: sec.segmentation, roi: sec.roi }).then(function (found) {
      if (!found) return;
      var before = { result: sec.result, roi: sec.roi, segmentation: sec.segmentation, boardFraction: sec.boardFraction, overlayData: sec.overlayData, samPoints: sec.samPoints };
      analyzeSection(sec, found);
      if (!sec.result.ok) { toast(sec.result.message); Object.assign(sec, before); return; }
      rebuildCurrent();
      renderResult();
      buzz(25);
      toast("Scored the leaf only");
    });
  }
  document.addEventListener("click", function (ev) {
    if (ev.target.closest("[data-outline]")) outlineLastSection();
  });

  $("sections").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-rm]");
    if (!b || !current || current.sections.length < 2) return;
    current.sections.splice(+b.dataset.rm, 1);
    rebuildCurrent();
    renderResult();
  });

  var userActed = false;   // once true, the app never reloads itself
  ["camInput", "fileInput", "secInput"].forEach(function (id) {
    $(id).addEventListener("click", function () { userActed = true; });
  });
  ["camInput", "fileInput"].forEach(function (id) {
    $(id).addEventListener("change", function (ev) {
      userActed = true;
      batch.active = false;   // a single photo ends any set in progress
      var f = ev.target.files && ev.target.files[0];
      if (f) handleFile(f, f.name || ("leaf-" + Date.now() + ".jpg"), false, false);
      ev.target.value = "";
    });
  });

  function loadSample(asExample) {
    return fetch("samples/BLS_02.jpg")
      .then(function (r) { if (!r.ok) throw new Error(); return r.blob(); })
      .then(function (b) { handleFile(b, "BLS_02.jpg", true, asExample); })
      .catch(function () { analyzeState("capture"); toast("The example leaf could not be loaded."); });
  }
  $("sampleBtn").addEventListener("click", function () { openGuide(); });

  // ---------- anonymous device count ----------
  // Once a day per device: a random ID (not the rater's name or the team Device_ID),
  // app version, platform, installed or browser, language and continent. Nothing else.
  function usagePing() {
    if (!USAGE_URL || settings.shareUsage === false || navigator.onLine === false) return;
    var day = new Date().toISOString().slice(0, 10);
    if (settings.usageDay === day) return;
    // the random ID is kept for good, so a device is counted once however often it opens the app
    if (!settings.usageId) { settings.usageId = uid(); Settings.save(settings); }
    var ua = navigator.userAgent || "";
    var platform = /iPhone|iPod/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : /Linux|CrOS/.test(ua) ? "Linux" : "Other";
    var region = "";
    try { region = (Intl.DateTimeFormat().resolvedOptions().timeZone || "").split("/")[0]; } catch (e) { region = ""; }
    var body = JSON.stringify({
      t: "bls-usage-1", id: settings.usageId, v: APP_VERSION, p: platform,
      m: isInstalled() ? "installed" : "browser", a: /\/study\//.test(location.pathname) ? "study" : "app",
      l: (navigator.language || "").slice(0, 12), r: region
    });
    // A beacon needs no reply (the app's cross-origin isolation would block reading one)
    // and is delivered even if the app is closed right away.
    var sent = false;
    try { sent = !!(navigator.sendBeacon && navigator.sendBeacon(USAGE_URL, new Blob([body], { type: "text/plain;charset=utf-8" }))); } catch (e) { sent = false; }
    if (!sent) {
      try { fetch(USAGE_URL, { method: "POST", mode: "no-cors", keepalive: true, headers: { "Content-Type": "text/plain;charset=utf-8" }, body: body }).catch(function () {}); sent = true; } catch (e) { sent = false; }
    }
    if (sent) { settings.usageDay = day; Settings.save(settings); }
  }
  $("dUsage").addEventListener("change", function () {
    settings.shareUsage = $("dUsage").checked;
    Settings.save(settings);
    toast(settings.shareUsage ? "This device is counted anonymously" : "This device is no longer counted");
  });

  // ---------- guided Google Sheet setup ----------
  // Walks the team leader (or a person working alone) through putting the
  // receiver script into their own Google Sheet. The team key is generated
  // here and written into the script, so nothing has to be edited by hand.
  var sw = { step: 0, tested: false, script: "" };
  function swKey() {
    var d = settings.sheetDraft || {};
    if (!d.key) {
      var cur = settings.connectors && settings.connectors.googleSheets;
      if (cur && cur.key) d.key = cur.key;
      else {
        var a = new Uint8Array(12); crypto.getRandomValues(a);
        d.key = "bls-" + Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join("");
      }
      settings.sheetDraft = d; Settings.save(settings);
    }
    return d.key;
  }
  function isPhone() { return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || ""); }
  function showSwStep(i) {
    var steps = document.querySelectorAll("#sheetWizard .sw-step"), last = steps.length - 1;
    sw.step = Math.max(0, Math.min(last, i));
    steps.forEach(function (s, k) { s.hidden = k !== sw.step; });
    document.querySelectorAll("#swDots i").forEach(function (d, k) { d.classList.toggle("on", k === sw.step); });
    $("swDots").style.visibility = sw.step === last ? "hidden" : "visible";
    $("swCount").textContent = sw.step === last ? "All set" : "Step " + (sw.step + 1) + " of " + last;
    $("swBack").style.visibility = sw.step && sw.step !== last ? "visible" : "hidden";
    var next = $("swNext");
    next.disabled = false;
    next.textContent = sw.step === last ? "Done" : sw.step === last - 1 ? "Save and finish" : "Next";
    if (sw.step === last - 1) next.disabled = !sw.tested;
    if (sw.step === 2) prepareScript();
  }
  function prepareScript() {
    var key = swKey();
    $("swKey").textContent = key;
    if (sw.script) return Promise.resolve(sw.script);
    return fetch("connectors/google-sheets/Code.gs", { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error();
      return r.text();
    }).then(function (t) {
      sw.script = t.replace(/var TEAM_KEY = "[^"]*";/, 'var TEAM_KEY = "' + key + '";   // generated by the app');
      $("swScriptText").value = sw.script;
      return sw.script;
    }).catch(function () {
      $("swScriptStatus").className = "status-line err";
      $("swScriptStatus").textContent = "The script could not be loaded. Check the internet connection and open this step again.";
    });
  }
  function openSheetWizard() {
    sw.tested = false;
    var link = location.origin + location.pathname;
    $("swAppLink").value = link;
    $("swWhere").textContent = isPhone()
      ? "You are on a phone. Open the app on a computer with this link, then go to Settings → Connect a Google Sheet."
      : "You are on a computer, so you can carry on here.";
    $("swLinkRow").hidden = !isPhone();
    var d = settings.sheetDraft || {}, cur = (settings.connectors && settings.connectors.googleSheets) || {};
    $("swUrl").value = d.url || cur.url || "";
    $("swStatus").textContent = ""; $("swScriptStatus").textContent = "";
    showSwStep(0);
    $("sheetWizard").hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeSheetWizard() { $("sheetWizard").hidden = true; document.body.style.overflow = ""; }
  function copyText(text, okMsg, el) {
    var done = function (ok) { el.className = "status-line " + (ok ? "ok" : "err"); el.textContent = ok ? okMsg : "Copying is blocked here. Open “Copy button not working?” and copy the text from the box."; };
    try { navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); }); } catch (e) { done(false); }
  }
  $("openSheetWizard").addEventListener("click", openSheetWizard);
  $("swClose").addEventListener("click", closeSheetWizard);
  $("swBack").addEventListener("click", function () { showSwStep(sw.step - 1); });
  $("swCopyLink").addEventListener("click", function () {
    var v = $("swAppLink").value;
    try { navigator.clipboard.writeText(v).then(function () { toast("Link copied. Open it on your computer."); }); } catch (e) { $("swAppLink").select(); }
  });
  $("swCopyScript").addEventListener("click", function () {
    prepareScript().then(function (s) { if (s) copyText(s, "✓ Script copied, with your team key inside. Paste it into the Apps Script editor.", $("swScriptStatus")); });
  });
  $("swUrl").addEventListener("input", function () {
    sw.tested = false; $("swNext").disabled = true; $("swStatus").textContent = "";
    var d = settings.sheetDraft || {}; d.url = $("swUrl").value.trim(); settings.sheetDraft = d; Settings.save(settings);
  });
  $("swTest").addEventListener("click", function () {
    var url = $("swUrl").value.trim(), st = $("swStatus");
    if (!/^https:\/\/script\.google\.com\/.+\/exec(\?.*)?$/.test(url)) {
      st.className = "status-line err";
      st.textContent = "That doesn't look like the Web app URL. It starts with https://script.google.com/ and ends in /exec.";
      return;
    }
    st.className = "status-line ok"; st.textContent = "Testing…";
    C.get("googleSheets").test({ url: url, key: swKey() }).then(function (msg) {
      sw.tested = true; st.className = "status-line ok"; st.textContent = "✓ " + msg; $("swNext").disabled = false; buzz(20);
    }, function (e) {
      sw.tested = false; st.className = "status-line err";
      st.textContent = /team key/i.test(e.message)
        ? "The Sheet answered, but with a different team key. Copy the script again (step 3), paste it over the old one, then Deploy → Manage deployments → Edit → Version: New version."
        : e.message + " If you just deployed, check that “Who has access” is set to Anyone.";
    });
  });
  $("swNext").addEventListener("click", function () {
    var last = document.querySelectorAll("#sheetWizard .sw-step").length - 1;
    if (sw.step === last) { closeSheetWizard(); return; }
    if (sw.step === last - 1) {
      if (!sw.tested) return;
      settings.destination = "googleSheets";
      settings.connectors.googleSheets = { url: $("swUrl").value.trim(), key: swKey() };
      settings.sheetDraft = null;
      Settings.save(settings);
      renderSettings(); renderQr();
      refreshPending().then(syncPending);
      registerUser();
    }
    showSwStep(sw.step + 1);
  });
  $("swShowQr").addEventListener("click", function () {
    closeSheetWizard();
    var q = $("qr"); if (q) q.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  });

  // ---------- how to rate: 3-step guide ----------
  var guideStep = 0;
  function showGuideStep(i) {
    var steps = document.querySelectorAll("#guide .g-step");
    guideStep = Math.max(0, Math.min(steps.length - 1, i));
    steps.forEach(function (s, k) { s.hidden = k !== guideStep; });
    document.querySelectorAll("#guide .g-dots i").forEach(function (d, k) { d.classList.toggle("on", k === guideStep); });
    $("gBack").style.visibility = guideStep ? "visible" : "hidden";
    $("gNext").textContent = guideStep === steps.length - 1 ? "Start rating" : "Next";
    $("gCount").textContent = "Step " + (guideStep + 1) + " of " + steps.length;
  }
  function openGuide() {
    showGuideStep(0);
    $("guide").hidden = false;
    document.body.style.overflow = "hidden";
    setTimeout(function () { try { $("gNext").focus(); } catch (e) { /* ignore */ } }, 60);
  }
  function closeGuide() {
    $("guide").hidden = true;
    document.body.style.overflow = "";
    if (!settings.guideSeen) { settings.guideSeen = true; Settings.save(settings); }
  }
  $("gNext").addEventListener("click", function () {
    if (guideStep >= document.querySelectorAll("#guide .g-step").length - 1) closeGuide();
    else showGuideStep(guideStep + 1);
  });
  $("gBack").addEventListener("click", function () { showGuideStep(guideStep - 1); });
  $("gSkip").addEventListener("click", closeGuide);
  // Swipe between steps on phones
  (function () {
    var x0 = null;
    $("guide").addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    $("guide").addEventListener("touchend", function (e) {
      if (x0 == null) return;
      var dx = e.changedTouches[0].clientX - x0; x0 = null;
      if (Math.abs(dx) > 50) showGuideStep(guideStep + (dx < 0 ? 1 : -1));
    }, { passive: true });
  })();

  // ---------- GPS ----------
  function requestGps() {
    gps = null;
    if (!$("fGps").checked || !navigator.geolocation) return;
    try {
      navigator.geolocation.getCurrentPosition(function (p) {
        gps = { lat: +p.coords.latitude.toFixed(6), lon: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) };
      }, function () { gps = null; }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    } catch (e) { gps = null; }
  }

  // ---------- result ----------
  var viewMode = "overlay";

  function drawLeaf() {
    if (!current) return;
    var data = viewMode === "overlay" ? current.overlayData : current.imageData;
    var canvas = $("leafCanvas"), frame = $("leafFrame");
    // Long thin leaves are shown lying across the screen so they fit
    var rotate = data.height > data.width * 1.6;
    var tmp = document.createElement("canvas");
    tmp.width = data.width; tmp.height = data.height;
    tmp.getContext("2d").putImageData(data, 0, 0);
    canvas.width = rotate ? data.height : data.width;
    canvas.height = rotate ? data.width : data.height;
    var ctx = canvas.getContext("2d");
    if (rotate) { ctx.translate(canvas.width, 0); ctx.rotate(Math.PI / 2); }
    ctx.drawImage(tmp, 0, 0);
    frame.classList.toggle("tall", !rotate && data.height > data.width);
    frame.classList.toggle("rot", rotate);
    frame.scrollLeft = 0;
    $("dims").textContent = data.width + " × " + data.height + " px · " + current.result.leafPixels.toLocaleString() + " leaf px";
  }

  document.querySelectorAll(".seg button").forEach(function (b) {
    b.addEventListener("click", function () {
      viewMode = b.dataset.view;
      document.querySelectorAll(".seg button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      drawLeaf();
    });
  });

  function buildScale(active) {
    var limits = ["≤0.5", "2", "6", "12", "25", "40", "60", "75", ">75"];
    var bar = "", ticks = "";
    for (var s = 1; s <= 9; s++) {
      bar += '<div class="' + (s === active ? "on" : "") + '" style="background:' + scoreColor(s) + '">' + s + "</div>";
      ticks += "<span>" + limits[s - 1] + "</span>";
    }
    $("scaleBar").innerHTML = bar;
    $("scaleTicks").innerHTML = ticks;
  }

  function renderResult() {
    var r = current.result;
    var arc = $("gaugeArc");
    arc.style.stroke = scoreColor(r.score);
    arc.style.strokeDashoffset = GAUGE_C;
    // next frame so the arc animates from empty
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        arc.style.strokeDashoffset = GAUGE_C * (1 - Math.min(100, Math.max(1.5, r.diseasedPct)) / 100);
      });
    });
    countUp($("scoreNum"), r.score, 0, "");
    $("scoreNum").style.color = scoreColor(r.score);
    countUp($("diseasedPct"), r.diseasedPct, 1, "%");
    $("catText").textContent = r.category;
    $("catChip").querySelector(".sw").style.background = scoreColor(r.score);
    $("resultSource").textContent = r.sections > 1 ? "Whole leaf · " + r.sections + " sections" : (current.sample ? "Example leaf · BLS_02" : "Just now");

    var warn = r.qc !== "PASS" ? "Quality check: " + r.qc + ". Pixel classes do not add up; retake the photo." : "";
    if (!warn && r.leafPixels < 20000) warn = "The leaf covers only a small part of the photo. Move closer so the leaf fills the frame.";
    $("qcWarn").textContent = warn;
    $("qcWarn").hidden = !warn;
    $("noBoardWarn").hidden = true;
    var per = r.perLeaf;
    $("perLeaf").hidden = !per;
    if (per) {
      $("perLeaf").innerHTML = '<span class="eyebrow">' + per.length + " leaves in this photo</span>" + per.map(function (q, i) {
        return '<span class="leaf-chip"><i class="mini-score num" style="background:' + scoreColor(q.score) + '">' + q.score + "</i>Leaf " + (i + 1) + ' <b class="num">' + fmtPct(q.diseasedPct) + "</b></span>";
      }).join("");
    }
    var L = r.lesions;
    $("lesionLine").innerHTML = L && L.count ? "<b>" + L.count + "</b> lesion" + (L.count === 1 ? "" : "s") + " · average size <b>" + L.meanSizePct.toFixed(2) + "%</b> of leaf · largest <b>" + L.largestPct.toFixed(1) + "%</b>" : "";
    $("methodNote").textContent = (r.rules === "taught" ? "Scored with your taught colours. " : "") + ({ background: "Leaf separated from the background automatically (labels and glare left out)", board: "Leaf separated from the board automatically", auto: "Leaf found automatically by the AI leaf finder",
      "auto + taps": "Leaf found automatically, adjusted by you", traced: "Leaf outlined by you", "whole photo": "Whole photo scored as leaf", mixed: "Sections separated in different ways" })[r.segmentation] || "";

    var parts = [["Healthy", r.healthyPct, "var(--healthy)"], ["Chlorotic", r.chloroticPct, "var(--chlorotic)"], ["Necrotic", r.necroticPct, "var(--necrotic)"]];
    $("compBar").innerHTML = parts.map(function (p) { return '<i style="width:0;background:' + p[2] + '"></i>'; }).join("");
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        $("compBar").querySelectorAll("i").forEach(function (el, i) { el.style.width = parts[i][1] + "%"; });
      });
    });
    $("compLegend").innerHTML = parts.map(function (p) {
      return '<div><span><i class="sw" style="background:' + p[2] + '"></i>' + p[0] + '</span><b>' + fmtPct(p[1]) + "</b></div>";
    }).join("");

    buildScale(r.score);
    drawLeaf();
    renderSections();
    applyPlot();

    if (!$("fTrial").value) $("fTrial").value = settings.trial || "";
    if (!$("fRater").value) $("fRater").value = settings.rater || "";
    updateContext();
    renderRating();
  }

  $("discardBtn").addEventListener("click", function () {
    current = null;
    pendingRating = null;
    if (batch.active) { nextInQueue(); return; }
    analyzeState("capture");
    $("camInput").click();
  });

  // ---------- form helpers ----------
  document.querySelectorAll("[data-step]").forEach(function (b) {
    b.addEventListener("click", function () {
      var input = $(b.dataset.step);
      input.value = String(Math.max(1, (parseInt(input.value, 10) || 1) + parseInt(b.dataset.d, 10)));
      buzz(8);
    });
  });

  function updateContext() {
    var t = $("fTrial").value.trim(), r = $("fRater").value.trim();
    var bits = [];
    if (t) bits.push("Trial " + t);
    if (r) bits.push(r);
    if (!$("fGps").checked) bits.push("no GPS");
    $("contextText").textContent = bits.length ? bits.join(" · ") : "Add trial, rater and notes";
  }
  ["fTrial", "fRater", "fGps"].forEach(function (id) { $(id).addEventListener("input", updateContext); $(id).addEventListener("change", updateContext); });
  $("moreBtn").addEventListener("click", function () {
    var open = $("moreFields").hidden;
    $("moreFields").hidden = !open;
    $("moreBtn").textContent = open ? "Done" : "Edit";
    $("moreBtn").setAttribute("aria-expanded", String(open));
  });

  // ---------- saving ----------
  function canvasBlob(imageData, maxSide) {
    var k = Math.min(1, maxSide / Math.max(imageData.width, imageData.height));
    var src = document.createElement("canvas");
    src.width = imageData.width; src.height = imageData.height;
    src.getContext("2d").putImageData(imageData, 0, 0);
    var c = document.createElement("canvas");
    c.width = Math.round(imageData.width * k); c.height = Math.round(imageData.height * k);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return new Promise(function (resolve) { c.toBlob(resolve, "image/jpeg", 0.85); });
  }

  $("metaForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!current) return;
    var btn = $("saveBtn");
    btn.disabled = true;
    var r = current.result;
    var meta = {
      trial: $("fTrial").value.trim(), plot: $("fPlot").value.trim(), genotype: $("fGenotype").value.trim(),
      rep: $("fRep").value.trim(), leaf: $("fLeaf").value.trim(), rater: $("fRater").value.trim(), notes: $("fNotes").value.trim(),
      visualScore: visualScore || "",
      visualPct: pendingRating ? pendingRating.pct : "",
      ratingMode: pendingRating ? "blind" : (visualScore ? "after app score" : ""),
      rateSeconds: pendingRating ? pendingRating.seconds : "",
      ratedAt: pendingRating ? pendingRating.ratedAt : "",
      setPosition: pendingRating ? pendingRating.position : (batch.active ? batch.pos + "/" + batch.total : ""),
      hiddenRepeat: !!(batch.active && batch.item && batch.item.repeat),
      deviceId: settings.deviceId || ""
    };
    if (pendingRating && !meta.rater) meta.rater = pendingRating.rater;
    // Remember trial and rater for the next leaf
    settings.trial = meta.trial; settings.rater = meta.rater;
    Settings.save(settings); updateHeader();

    var storeSide = Math.min(4096, MAX_STORED_SIDE * current.sections.length);
    Promise.all([canvasBlob(current.imageData, storeSide), canvasBlob(current.overlayData, storeSide)])
      .then(function (blobs) {
        return Records.put({
          id: uid(), createdAt: new Date().toISOString(), imageName: current.name, meta: meta,
          gps: $("fGps").checked ? gps : null,
          result: {
            leafPixels: r.leafPixels, healthyPixels: r.healthyPixels, chloroticPixels: r.chloroticPixels,
            necroticPixels: r.necroticPixels, healthyPct: r.healthyPct, chloroticPct: r.chloroticPct,
            necroticPct: r.necroticPct, diseasedPct: r.diseasedPct, score: r.score, category: r.category,
            qc: r.qc, width: r.width, height: r.height, sections: r.sections || 1,
            segmentation: r.segmentation || "whole photo", rules: r.rules || "v2",
            perLeaf: r.perLeaf ? r.perLeaf.map(function (q) { return { diseasedPct: q.diseasedPct, score: q.score }; }) : null,
            lesions: r.lesions || null
          },
          engine: E.VERSION, photo: blobs[0], overlay: blobs[1],
          sync: settings.destination === "local" ? "local" : "pending", syncError: null, remote: {}
        });
      })
      .then(function () {
        buzz([15, 60, 15]);
        var where = settings.destination === "local" ? "Saved on this phone." :
          (navigator.onLine === false ? "Saved on this phone. It will sync to " + C.get(settings.destination).name + " when you're online." :
            "Saved on this phone and syncing to " + C.get(settings.destination).name + ".");
        $("savedTitle").textContent = (meta.plot || "Leaf") + " saved";
        $("savedText").textContent = [meta.rep && "Rep " + meta.rep, meta.leaf && "Leaf " + meta.leaf, "Score " + r.score, fmtPct(r.diseasedPct) + " diseased"].filter(Boolean).join(" · ") + ". " + where;
        $("fNotes").value = "";
        pendingRating = null;
        $("visRuler").classList.remove("locked");
        setVisual(null);
        if (batch.active) {
          // Rating a set: go straight to the next photo
          batch.done++;
          current = null;
          refreshPending(); syncPending(); protectStorage();
          toast((meta.plot || "Leaf") + " saved · " + batch.done + " of " + batch.total);
          nextInQueue();
          return;
        }
        // Ready for the next leaf from the same plot: keep plot, trial, rater; bump leaf no.
        $("fLeaf").value = String((parseInt($("fLeaf").value, 10) || 0) + 1);
        $("nextLeafLabel").textContent = "Next leaf (" + $("fLeaf").value + ")";
        var np = nextPlotAfter(meta.plot);
        $("nextPlotBtn").hidden = !np;
        if (np) { $("nextPlotBtn").textContent = "Next plot in list: " + np.plot + " →"; $("nextPlotBtn").dataset.plot = np.plot; }
        current = null;
        analyzeState("saved");
        window.scrollTo(0, 0);
        refreshPending();
        syncPending();
        protectStorage();
      })
      .catch(function (e) { toast("Could not save: " + (e && e.message ? e.message : "storage is full or blocked")); })
      .then(function () { btn.disabled = false; });
  });

  // ---------- rows, CSV, sync ----------
  function toRow(rec) {
    var r = rec.result, m = rec.meta, g = rec.gps || {};
    return {
      Record_ID: rec.id, Timestamp: rec.createdAt, Trial: m.trial, Plot_ID: m.plot, Genotype: m.genotype,
      Rep: m.rep, Leaf_No: m.leaf, Rater: m.rater, Image_File: rec.imageName,
      Leaf_Pixels: r.leafPixels, Healthy_Pixels: r.healthyPixels, Chlorotic_Pixels: r.chloroticPixels,
      Necrotic_Pixels: r.necroticPixels, Healthy_Percent: r.healthyPct, Chlorotic_Percent: r.chloroticPct,
      Necrotic_Percent: r.necroticPct, Total_Diseased_Percent: r.diseasedPct, BLS_Score: r.score,
      Disease_Response: r.category, QC_Status: r.qc,
      Latitude: g.lat == null ? "" : g.lat, Longitude: g.lon == null ? "" : g.lon, GPS_Accuracy_m: g.acc == null ? "" : g.acc,
      Notes: m.notes, Image_Width: r.width, Image_Height: r.height, Engine_Version: rec.engine,
      Device: "BLS Leaf Scorer " + APP_VERSION,
      Photo_URL: (rec.remote && rec.remote.photoUrl) || "", Overlay_URL: (rec.remote && rec.remote.overlayUrl) || "",
      Sections: r.sections || 1, Edited_At: rec.editedAt || "", Segmentation: r.segmentation || "whole photo",
      Rules: r.rules === "r1" ? "R script v1.0" : r.rules === "taught" ? "taught colours" : "calibrated v2", Leaf_Count: r.perLeaf ? r.perLeaf.length : 1,
      Per_Leaf_Diseased_Percent: r.perLeaf ? r.perLeaf.map(function (q) { return q.diseasedPct; }).join("; ") : "",
      Per_Leaf_BLS_Score: r.perLeaf ? r.perLeaf.map(function (q) { return q.score; }).join("; ") : "",
      Lesion_Count: r.lesions ? r.lesions.count : "", Mean_Lesion_Size_Percent: r.lesions ? r.lesions.meanSizePct : "",
      Visual_BLS_Score: m.visualScore || "",
      Visual_Diseased_Percent: m.visualPct === 0 ? 0 : (m.visualPct || ""),
      Rating_Mode: m.ratingMode || (m.visualScore ? "after app score" : ""),
      Rating_Seconds: m.rateSeconds || "", Rated_At: m.ratedAt || "", Set_Position: m.setPosition || "",
      Device_ID: m.deviceId || "", Hidden_Repeat: m.hiddenRepeat ? "yes" : ""
    };
  }

  // Small JPEG for the in-cell thumbnail in Google Sheets
  function thumbBase64(blob, side) {
    if (!blob) return Promise.resolve(null);
    return decode(blob).then(function (bmp) {
      var k = Math.min(1, side / Math.max(bmp.width, bmp.height));
      var c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.75).split(",")[1];
    }).catch(function () { return null; });
  }

  function csvCell(v) {
    var s = String(v == null ? "" : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function blobToBase64(blob) {
    if (!blob) return Promise.resolve(null);
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).split(",")[1]); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  function syncPending() {
    if (syncing || settings.destination === "local") return Promise.resolve();
    if (navigator.onLine === false) { refreshPending(); return Promise.resolve(); }
    var conn = C.get(settings.destination);
    var cfg = settings.connectors[conn.id] || {};
    syncing = true;
    setPill("pending", "Syncing…");
    return Records.all().then(function (all) {
      var queue = all.filter(function (r) { return r.sync !== "synced"; }).reverse();
      var chain = Promise.resolve();
      queue.forEach(function (rec) {
        chain = chain.then(function () {
          var withPhotos = settings.uploadPhotos;
          return Promise.all([withPhotos ? blobToBase64(rec.photo) : null, withPhotos ? blobToBase64(rec.overlay) : null, withPhotos ? thumbBase64(rec.photo, 240) : null])
            .then(function (b) { return conn.send({ event: rec.editedAt ? "update" : "record", row: toRow(rec), photo: b[0], overlay: b[1], thumb: b[2] }, cfg); })
            .then(function (resp) {
              rec.sync = "synced"; rec.syncError = null;
              rec.remote = { photoUrl: resp.photoUrl || "", overlayUrl: resp.overlayUrl || "" };
              return Records.put(rec);
            }, function (err) {
              rec.sync = "error"; rec.syncError = err.message;
              return Records.put(rec).then(function () { throw err; });
            });
        });
      });
      return chain;
    }).then(function () {
      syncing = false; refreshPending();
    }, function (err) {
      syncing = false; refreshPending();
      toast("Sync stopped: " + err.message);
    }).then(function () {
      if (!$("view-records").hidden) renderRecords();
    });
  }
  window.addEventListener("online", syncPending);
  window.addEventListener("offline", function () { refreshPending(); });

  function setPill(state, text) {
    $("syncPill").dataset.state = state;
    $("syncText").textContent = text;
  }

  function refreshPending() {
    return Records.all().then(function (all) {
      allRecords = all;
      applyPlot();
      var dest = settings.destination;
      var unsynced = dest === "local" ? 0 : all.filter(function (r) { return r.sync !== "synced"; }).length;
      var errors = all.some(function (r) { return r.sync === "error"; });
      $("pendingBadge").hidden = !unsynced;
      $("pendingBadge").textContent = unsynced;
      if (syncing) return;
      if (dest === "local") setPill("ok", all.length ? all.length + " on phone" : "This phone");
      else if (!unsynced) setPill("ok", "All synced");
      else if (navigator.onLine === false) setPill("pending", unsynced + " waiting");
      else setPill(errors ? "error" : "pending", unsynced + " to sync");
    });
  }

  function updateHeader() {
    $("trialLabel").textContent = settings.trial ? "Trial · " + settings.trial : "No trial set";
    $("userBtn").textContent = settings.rater || "Sign in";
  }

  // ---------- who is using the app ----------
  // Asked once before the app starts; switch from the name in the top bar.
  function openWelcome(switching) {
    $("wTitle").textContent = switching ? "Who’s rating now?" : "Who’s rating today?";
    $("wName").value = switching ? "" : (settings.rater || "");
    $("wErr").textContent = "";
    $("welcome").hidden = false;
    document.body.style.overflow = "hidden";
    setTimeout(function () { try { $("wName").focus(); } catch (e) { /* ignore */ } }, 60);
  }
  function startAs(name) {
    var changed = name !== settings.rater;
    settings.rater = name;
    if (!settings.deviceId) settings.deviceId = uid();
    Settings.save(settings);
    $("fRater").value = name;
    $("rRater").value = name;
    if (!$("rate").hidden) showRaterField(false);
    $("dRater").value = name;
    updateHeader(); updateContext(); renderQr();
    $("welcome").hidden = true;
    document.body.style.overflow = "";
    if (changed && settings.guideSeen) toast("Rating as " + name);
    registerUser();
    if (!settings.guideSeen) openGuide();
  }
  $("wForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var name = $("wName").value.trim().replace(/\s+/g, " ");
    if (name.length < 2) { $("wErr").textContent = "Enter your name or rater ID (at least 2 characters)."; buzz(40); return; }
    startAs(name.slice(0, 60));
  });
  $("userBtn").addEventListener("click", function () { openWelcome(true); });

  function deviceName() {
    var ua = navigator.userAgent || "";
    var os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : "Other";
    var br = /Edg\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
    return os + (br ? " · " + br : "");
  }
  // Tells the team's storage (Google Sheet "Users" tab) who uses the app, so
  // the organiser can see how many people are rating. No storage set up: nothing is sent.
  function registerUser() {
    if (!settings.rater || settings.destination === "local" || navigator.onLine === false) return Promise.resolve();
    var conn = C.get(settings.destination);
    if (!conn.hello) return Promise.resolve();
    if (!settings.deviceId) { settings.deviceId = uid(); Settings.save(settings); }
    return conn.hello({ Rater: settings.rater, Device_ID: settings.deviceId, App_Version: APP_VERSION, Device: deviceName(), Trial: settings.trial || "" },
      settings.connectors[conn.id] || {}).then(function (d) {
      if (d && d.users != null) { settings.teamUsers = d.users; settings.teamUsersAt = new Date().toISOString(); Settings.save(settings); }
      renderTeamUsers();
    }, function () { /* offline or not set up yet: try again next start */ });
  }
  function renderTeamUsers() {
    var el = $("teamUsers");
    if (settings.destination === "local") {
      el.textContent = "To see who uses the app, connect a Google Sheet above. Each person's name, device and last use then appear in its Users tab.";
    } else if (settings.teamUsers != null) {
      el.textContent = settings.teamUsers + " " + (settings.teamUsers === 1 ? "person has" : "people have") + " used the app with your team's storage (checked " +
        new Date(settings.teamUsersAt).toLocaleDateString() + "). Open the Users tab in the Sheet to see who.";
    } else {
      el.textContent = "Who uses the app is listed in the Users tab of your team's Sheet.";
    }
  }

  // ---------- records view ----------
  var thumbUrls = [];
  var listCache = [];

  function filtered(all) {
    var trial = $("trialFilter").value;
    var q = $("recSearch").value.trim().toLowerCase();
    return all.filter(function (r) {
      if (trial && r.meta.trial !== trial) return false;
      if (!q) return true;
      return [r.meta.plot, r.meta.genotype, r.meta.notes, r.meta.rater, r.imageName].join(" ").toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderRecords() {
    return Records.all().then(function (all) {
      var sel = $("trialFilter");
      var trials = Array.from(new Set(all.map(function (r) { return r.meta.trial; }).filter(Boolean))).sort();
      var keep = sel.value;
      sel.innerHTML = '<option value="">All trials</option>' + trials.map(function (t) {
        return '<option' + (t === keep ? " selected" : "") + ">" + esc(t) + "</option>";
      }).join("");
      var list = filtered(all);
      listCache = list;
      renderProgress(all);
      $("leavesPane").hidden = recMode !== "leaves";
      $("summaryPane").hidden = recMode !== "summary";
      if (recMode === "summary") { renderSummary(list); renderAgreement(list); }

      var n = list.length;
      $("stN").textContent = n;
      $("stMean").textContent = n ? (list.reduce(function (a, r) { return a + r.result.score; }, 0) / n).toFixed(1) : "–";
      $("stDis").textContent = n ? fmtPct(list.reduce(function (a, r) { return a + r.result.diseasedPct; }, 0) / n) : "–";
      var counts = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      list.forEach(function (r) { counts[r.result.score - 1]++; });
      var maxC = Math.max.apply(null, counts.concat([1]));
      $("hist").innerHTML = counts.map(function (c, i) {
        return '<div title="Score ' + (i + 1) + ": " + c + ' leaves"><span class="num">' + (c || "") + '</span><i style="height:' + (c / maxC * 62) + 'px;background:' + scoreColor(i + 1) + '"></i><span>' + (i + 1) + "</span></div>";
      }).join("");

      thumbUrls.forEach(URL.revokeObjectURL); thumbUrls = [];
      $("recEmpty").hidden = n > 0;
      $("emptyTitle").textContent = all.length ? "No matching records" : "No records yet";
      $("emptyText").textContent = all.length ? "Try a different search or trial." : "Score a leaf on the Analyze tab and tap Save record. Records stay on this phone and sync when you're online.";
      $("recList").innerHTML = list.map(function (r, i) {
        var url = r.overlay ? URL.createObjectURL(r.overlay) : "";
        if (url) thumbUrls.push(url);
        var title = r.meta.plot || r.imageName;
        var sub = [r.meta.genotype, r.meta.rep && "Rep " + r.meta.rep, r.meta.leaf && "Leaf " + r.meta.leaf].filter(Boolean).join(" · ");
        var when = new Date(r.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
        return '<li><button class="rec" type="button" data-i="' + i + '">' +
          '<span class="thumb" style="background-image:url(' + url + ')"></span>' +
          '<span class="meta"><b>' + esc(title) + '</b><span>' + esc(sub || r.meta.trial || "–") + '</span>' +
          '<span class="num">' + esc(when) + " · " + fmtPct(r.result.diseasedPct) + "</span></span>" +
          '<span class="right"><span class="mini-score num" style="background:' + scoreColor(r.result.score) + '">' + r.result.score + "</span>" +
          '<span class="sync-tag" data-s="' + esc(r.sync) + '">' + syncLabel(r.sync) + "</span></span></button></li>";
      }).join("");
    });
  }
  function syncLabel(s) { return { synced: "Synced", pending: "Waiting", error: "Failed", local: "On phone" }[s] || s; }
  $("trialFilter").addEventListener("change", renderRecords);
  $("recSearch").addEventListener("input", renderRecords);

  // ---------- record detail sheet ----------
  var sheetUrl = null;
  function closeSheet() {
    $("sheetRoot").innerHTML = "";
    if (sheetUrl) { URL.revokeObjectURL(sheetUrl); sheetUrl = null; }
    document.removeEventListener("keydown", escClose);
  }
  function escClose(e) { if (e.key === "Escape") closeSheet(); }

  function openSheet(rec) {
    closeSheet();
    var r = rec.result, m = rec.meta;
    var tall = r.height > r.width * 1.6;
    var kv = [
      ["Plot", m.plot], ["Genotype", m.genotype], ["Rep", m.rep], ["Leaf", m.leaf], ["Trial", m.trial], ["Rater", m.rater],
      ["Healthy", fmtPct(r.healthyPct)], ["Chlorotic", fmtPct(r.chloroticPct)], ["Necrotic", fmtPct(r.necroticPct)], ["QC", r.qc],
      ["Saved", new Date(rec.createdAt).toLocaleString()], ["GPS", rec.gps ? rec.gps.lat + ", " + rec.gps.lon : "–"]
    ];
    if (m.notes) kv.push(["Notes", m.notes]);
    if (r.sections > 1) kv.push(["Photographed in", r.sections + " sections"]);
    kv.push(["Leaf separated by", segLabel(r.segmentation)]);
    kv.push(["Scoring rules", r.rules === "r1" ? "R script v1.0" : r.rules === "taught" ? "Taught colours" : "Calibrated v2"]);
    if (r.lesions) kv.push(["Lesions", r.lesions.count + " · average " + r.lesions.meanSizePct + "% of leaf"]);
    if (m.visualScore) kv.push(["Visual BLS score", String(m.visualScore) + (m.ratingMode ? " (" + m.ratingMode + ")" : "")]);
    if (m.visualPct !== "" && m.visualPct != null) kv.push(["Visual diseased area", fmtPct(+m.visualPct)]);
    if (m.rateSeconds) kv.push(["Rating time", m.rateSeconds + " s" + (m.setPosition ? " · photo " + m.setPosition : "")]);
    if (r.perLeaf) kv.push(["Per leaf", r.perLeaf.map(function (q, i) { return "Leaf " + (i + 1) + ": " + fmtPct(q.diseasedPct) + " (BLS " + q.score + ")"; }).join(" · ")]);
    if (rec.editedAt) kv.push(["Edited", new Date(rec.editedAt).toLocaleString()]);
    if (rec.sync === "error") kv.push(["Sync error", rec.syncError]);
    var wrap = document.createElement("div");
    wrap.className = "sheet-backdrop";
    wrap.innerHTML =
      '<div class="sheet" role="dialog" aria-modal="true" aria-label="Record details">' +
      '<div class="grabber"></div>' +
      '<div class="sheet-head"><span class="mini-score num" style="width:52px;height:52px;font-size:28px;border-radius:15px;background:' + scoreColor(r.score) + '">' + r.score + "</span>" +
      '<div><h3>' + esc(m.plot || rec.imageName) + '</h3><div class="small muted">' + fmtPct(r.diseasedPct) + " diseased · " + esc(r.category) + "</div></div></div>" +
      (rec.overlay ? '<div class="sheet-img' + (tall ? "" : " upright") + '"><canvas aria-label="Classified leaf"></canvas></div>' : "") +
      '<dl class="kv">' + kv.map(function (p) { return "<div><dt>" + esc(p[0]) + "</dt><dd>" + esc(p[1] || "–") + "</dd></div>"; }).join("") + "</dl>" +
      '<div class="sheet-actions">' +
      '<button class="btn btn-primary" type="button" data-act="edit">Edit</button>' +
      (rec.sync === "error" || rec.sync === "pending" ? '<button class="btn btn-soft" type="button" data-act="retry">Retry sync</button>' : '<button class="btn btn-soft" type="button" data-act="close">Close</button>') +
      '<button class="btn btn-danger" type="button" data-act="delete">Delete</button></div></div>';
    wrap.addEventListener("click", function (e) {
      if (e.target === wrap) return closeSheet();
      var b = e.target.closest("[data-act]");
      if (!b) return;
      if (b.dataset.act === "close") closeSheet();
      if (b.dataset.act === "edit") return showEditForm(wrap.querySelector(".sheet"), rec);
      if (b.dataset.act === "retry") { closeSheet(); syncPending(); }
      if (b.dataset.act === "delete") {
        // Two taps (browser confirm dialogs aren't available everywhere)
        if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again to delete"; return; }
        Records.remove(rec.id).then(function () { closeSheet(); toast("Record deleted from this phone"); renderRecords(); refreshPending(); });
      }
    });
    $("sheetRoot").appendChild(wrap);
    var cv = wrap.querySelector(".sheet-img canvas");
    if (cv) decode(rec.overlay).then(function (bmp) {
      cv.width = tall ? bmp.height : bmp.width; cv.height = tall ? bmp.width : bmp.height;
      var cx = cv.getContext("2d");
      if (tall) { cx.translate(cv.width, 0); cx.rotate(Math.PI / 2); }
      cx.drawImage(bmp, 0, 0);
    }).catch(function () { cv.parentNode.remove(); });
    document.addEventListener("keydown", escClose);
    var first = wrap.querySelector("[data-act]");
    if (first) first.focus({ preventScroll: true });
  }

  $("recList").addEventListener("click", function (ev) {
    var b = ev.target.closest(".rec");
    if (b) openSheet(listCache[+b.dataset.i]);
  });

  function buildCsv(list) {
    var lines = [C.COLUMNS.join(",")].concat(list.map(function (rec) {
      var row = toRow(rec);
      return C.COLUMNS.map(function (k) { return csvCell(row[k]); }).join(",");
    }));
    return "﻿" + lines.join("\r\n");
  }

  // On phones the share sheet sends files to Drive, email, WhatsApp…; elsewhere download
  function shareOrDownload(blob, name, type, doneMsg) {
    var file = null;
    try { file = new File([blob], name, { type: type }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: name }).catch(function () {});
    }
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    if (doneMsg) toast(doneMsg);
  }
  function today() { return new Date().toISOString().slice(0, 10); }
  function trialTag() { var t = $("trialFilter").value; return t ? t.replace(/[^\w-]+/g, "_") + "_" : ""; }

  $("exportCsv").addEventListener("click", function () {
    Records.all().then(function (all) {
      var list = filtered(all).slice().reverse();
      if (!list.length) { toast("No records to export yet"); return; }
      shareOrDownload(new Blob([buildCsv(list)], { type: "text/csv" }), "BLS_results_" + trialTag() + today() + ".csv", "text/csv", "Exported " + list.length + " records");
    });
  });

  $("syncNow").addEventListener("click", function () {
    if (settings.destination === "local") { toast("Choose where to save records in Settings first"); showTab("settings"); return; }
    if (navigator.onLine === false) { toast("You're offline. Records will sync when you're back online."); return; }
    syncPending();
  });

  // ---------- settings view ----------
  var pickedDest = settings.destination;

  function renderSettings() {
    pickedDest = settings.destination;
    $("destList").innerHTML = C.list.map(function (c) {
      return '<label class="dest' + (c.soon ? " soon" : "") + '"><input type="radio" name="dest" value="' + c.id + '"' +
        (c.id === pickedDest ? " checked" : "") + (c.soon ? " disabled" : "") + '><span><b>' + esc(c.name) +
        (c.soon ? '<span class="soon-tag">Coming next</span>' : "") + '</b><span class="small">' + esc(c.blurb) + "</span></span></label>";
    }).join("");
    renderDestFields();
    $("dTrial").value = settings.trial || "";
    $("dRater").value = settings.rater || "";
    $("dPhotos").checked = !!settings.uploadPhotos;
    $("dShuffle").checked = !!settings.shuffle;
    $("dRepeat").value = String(settings.repeatPct == null ? 15 : settings.repeatPct);
    $("dUsage").checked = settings.shareUsage !== false;
    renderTeamUsers();
    $("destStatus").textContent = "";
    renderPlotSettings();
    renderQr();
  }

  function renderDestFields() {
    var conn = C.get(pickedDest);
    var cfg = settings.connectors[conn.id] || {};
    $("destFields").innerHTML = conn.fields.map(function (f) {
      return '<div class="field"><label for="cf_' + f.key + '">' + esc(f.label) + '</label>' +
        '<input id="cf_' + f.key + '" data-key="' + f.key + '" type="' + f.type + '" placeholder="' + esc(f.placeholder || "") + '" value="' + esc(cfg[f.key] || "") + '">' +
        (f.hint ? '<span class="hint">' + esc(f.hint) + "</span>" : "") + "</div>";
    }).join("");
    $("testDest").hidden = !conn.fields.length;
  }

  $("destList").addEventListener("change", function (ev) {
    if (ev.target.name !== "dest") return;
    pickedDest = ev.target.value;
    renderDestFields();
    $("destStatus").textContent = "";
  });

  function readDestFields() {
    var cfg = {};
    $("destFields").querySelectorAll("input[data-key]").forEach(function (i) { cfg[i.dataset.key] = i.value.trim(); });
    return cfg;
  }

  function status(msg, ok) {
    var s = $("destStatus");
    s.textContent = msg;
    s.className = "status-line " + (ok ? "ok" : "err");
  }

  $("testDest").addEventListener("click", function () {
    status("Testing…", true);
    C.get(pickedDest).test(readDestFields()).then(function (m) { status("✓ " + m, true); }, function (e) { status(e.message, false); });
  });

  $("saveDest").addEventListener("click", function () {
    settings.destination = pickedDest;
    settings.connectors[pickedDest] = readDestFields();
    Settings.save(settings);
    renderQr();
    status("✓ Saved. New records go to " + C.get(pickedDest).name + ".", true);
    refreshPending().then(syncPending);
    registerUser(); renderTeamUsers();
  });

  document.querySelectorAll('input[name="rules"]').forEach(function (r) {
    r.addEventListener("change", function () {
      if (r.value === "taught" && !taughtModel) {
        toast("Teach the colours first: under any result, tap Teach colours");
        if (settings.rules === "taught" && !taughtModel) settings.rules = "v2";
  $("rules-" + (settings.rules === "r1" ? "r1" : settings.rules === "taught" ? "taught" : "v2")).checked = true;
  renderTaughtInfo();
        return;
      }
      settings.rules = r.value;
      Settings.save(settings);
      toast(r.value === "r1" ? "New photos use the R script v1.0 rules" : r.value === "taught" ? "New photos use your taught colours" : "New photos use the calibrated v2 rules");
    });
  });

  $("saveDefaults").addEventListener("click", function () {
    settings.trial = $("dTrial").value.trim();
    var newName = $("dRater").value.trim();
    if (newName.length < 2) { toast("Your name or rater ID is needed"); $("dRater").value = settings.rater || ""; return; }
    var renamed = newName !== settings.rater;
    settings.rater = newName;
    settings.uploadPhotos = $("dPhotos").checked;
    Settings.save(settings);
    if (renamed) registerUser();
    updateHeader();
    renderQr();
    // Carry new defaults into an open, unsaved form
    $("fTrial").value = settings.trial;
    $("fRater").value = settings.rater;
    updateContext();
    toast("Defaults saved");
  });

  // Rating mode is always on in this app: rate first, then the app scores
  settings.blind = true;
  $("saveStudy").addEventListener("click", function () {
    settings.shuffle = $("dShuffle").checked;
    settings.repeatPct = +$("dRepeat").value || 0;
    Settings.save(settings);
    renderQr(); updateStudyLine();
    toast((settings.shuffle ? "Random order" : "Name order") + ", " + (settings.repeatPct ? settings.repeatPct + "% hidden repeats" : "no hidden repeats") + " in photo sets");
  });
  function updateStudyLine() {
    $("studyLineText").textContent = (settings.shuffle ? "Pick many photos; they come one by one in random order" : "Pick many photos; they come one by one in name order") +
      (settings.blind ? ". You rate each before the app does." : ".");
  }
  updateStudyLine();

  // ---------- team setup link + QR ----------
  function b64url(s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  function unb64url(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); return decodeURIComponent(escape(atob(s))); }

  function setupLink() {
    var payload = { v: 1, d: settings.destination, c: settings.connectors[settings.destination] || {}, t: settings.trial, p: settings.uploadPhotos, b: !!settings.blind, s: !!settings.shuffle, h: +settings.repeatPct || 0 };
    if (settings.palette && taughtModel) { payload.k = packPalette(settings.palette); payload.r = settings.rules; }
    return location.origin + location.pathname + "#setup-" + b64url(JSON.stringify(payload));
  }

  function renderQr() {
    var box = $("qr");
    box.innerHTML = "";
    try {
      var qr = window.qrcode(0, "L");
      qr.addData(setupLink());
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true });
    } catch (e) { box.innerHTML = '<span class="small">QR unavailable</span>'; }
  }

  $("copySetup").addEventListener("click", function () {
    var link = setupLink();
    try {
      navigator.clipboard.writeText(link).then(function () { $("copyNote").textContent = "Link copied. Send it to your team."; },
        function () { $("copyNote").textContent = link; });
    } catch (e) { $("copyNote").textContent = link; }
  });

  // Opening a team link asks before changing anything
  function checkSetupHash() {
    var m = /^#setup-(.+)$/.exec(location.hash || "");
    if (!m) return;
    var cfg;
    try { cfg = JSON.parse(unb64url(m[1])); } catch (e) { return; }
    var conn = C.get(cfg.d);
    var host = "";
    try { host = cfg.c && cfg.c.url ? new URL(cfg.c.url).host : ""; } catch (e) { host = ""; }
    var card = document.createElement("div");
    card.className = "card reveal";
    card.innerHTML = "<h3>Join this team?</h3><p class=\"small muted\" style=\"margin:0\">Records will be sent to <b>" + esc(conn.name) + "</b>" +
      (host ? " at <span class=\"num\">" + esc(host) + "</span>" : "") + (cfg.t ? ", trial <b>" + esc(cfg.t) + "</b>" : "") +
      (cfg.b ? ", with <b>study mode</b> (rate before seeing the app's score)" : "") +
      ". Only accept a link from someone you trust.</p><div style=\"display:flex;gap:8px\"><button class=\"btn btn-primary\" type=\"button\">Join team</button><button class=\"btn btn-ghost\" type=\"button\">Ignore</button></div>";
    var btns = card.querySelectorAll("button");
    btns[0].addEventListener("click", function () {
      settings.destination = conn.id;
      settings.connectors[conn.id] = cfg.c || {};
      if (cfg.t) settings.trial = cfg.t;
      if (typeof cfg.p === "boolean") settings.uploadPhotos = cfg.p;
      if (typeof cfg.s === "boolean") settings.shuffle = cfg.s;
      if (typeof cfg.h === "number") settings.repeatPct = cfg.h;
      updateStudyLine();
      Settings.save(settings); updateHeader(); refreshPending(); card.remove();
      toast("Joined. Records now go to " + conn.name);
    });
    btns[1].addEventListener("click", function () { card.remove(); });
    $("view-analyze").prepend(card);
    try { history.replaceState(null, "", location.pathname); } catch (e) { /* ignore */ }
  }

  // ---------- find the leaf (field photos) ----------
  // Auto-find: SlimSAM model (segment.js) proposes the leaf from the centre of
  // the photo; taps add leaf (+) or background (−) points. Draw-by-hand is the
  // fallback for old phones or when the model can't be loaded.
  var tr = null;
  var segModule = null;
  var samCache = new WeakMap();   // imageData -> image embedding, so re-opening is instant

  function segLabel(v) {
    return { "background": "Separated from the background automatically", "board": "Separated from the board automatically", "whole photo": "Whole photo (already cropped)", "auto": "Found automatically", "auto + taps": "Found automatically, corrected by taps",
      "traced": "Outline traced by hand", "mixed": "Mixed methods", "black board": "Black board" }[v] || v || "Black board";
  }
  function getSeg() { return segModule ? Promise.resolve(segModule) : import("./segment.js").then(function (m) { return (segModule = m); }); }

  function openTracer(imageData, prev) {
    return new Promise(function (resolve) {
      var W = imageData.width, H = imageData.height;
      var base = document.createElement("canvas");
      base.width = W; base.height = H;
      base.getContext("2d").putImageData(imageData, 0, 0);
      tr = { W: W, H: H, base: base, imageData: imageData, polys: [], cur: null, resolve: resolve,
        mode: "auto", sign: 1, points: [], roi: null, layer: null, handle: null, busy: false, prev: prev || null,
        autoError: prev && prev.reason ? prev.reason : null };
      $("tracer").hidden = false;
      document.body.style.overflow = "hidden";
      requestAnimationFrame(function () {
        var stage = $("traceStage"), cv = $("traceCanvas");
        var k = Math.min((stage.clientWidth - 12) / W, (stage.clientHeight - 12) / H);
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        cv.style.width = Math.round(W * k) + "px";
        cv.style.height = Math.round(H * k) + "px";
        cv.width = Math.round(W * k * dpr);
        cv.height = Math.round(H * k * dpr);
        tr.k = k;
        drawTrace();
      });
      setTraceMode(prev && prev.method === "traced" ? "draw" : "auto", prev);
    });
  }

  function closeTracer(found) {
    $("tracer").hidden = true;
    document.body.style.overflow = "";
    var done = tr && tr.resolve;
    tr = null;
    if (done) done(found || null);
  }

  function traceBusy(text) {
    $("trBusy").hidden = !text;
    if (text) $("trBusyText").textContent = text;
  }
  function traceHint(text) { $("tracerHint").textContent = text; }

  function setTraceMode(mode, prev) {
    if (!tr) return;
    tr.mode = mode;
    document.querySelectorAll("#trMode button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.m === mode)); });
    $("trSign").hidden = mode !== "auto";
    if (mode === "auto") startAuto(prev);
    else {
      traceBusy(null);
      traceHint(tr.autoError ? tr.autoError + " Trace around the leaf with your finger." : "Trace around the leaf with your finger. Only what is inside the outline is scored.");
    }
    drawTrace();
    updateTraceButtons();
  }

  // Load the model and analyse this photo once (cached), then call back
  function ensureHandle() {
    var mine = tr;
    if (tr.handle) return Promise.resolve(tr.handle);
    tr.busy = true;
    updateTraceButtons();
    traceBusy("Starting the leaf finder…");
    return getSeg().then(function (m) {
      if (!m.isLoaded()) traceBusy("Downloading the leaf finder (first time only)…");
      return m.load(function (f) { if (tr === mine) traceBusy("Downloading the leaf finder (first time only)… " + Math.round(f * 100) + "%"); }).then(function () { return m; });
    }).then(function (m) {
      var cached = samCache.get(mine.imageData);
      if (cached) return cached;
      traceBusy("Finding the leaf…");
      return m.embed(mine.imageData).then(function (h) { samCache.set(mine.imageData, h); return h; });
    }).then(function (h) {
      if (tr === mine) { tr.handle = h; tr.busy = false; }
      return h;
    });
  }

  function startAuto(prev) {
    var mine = tr;
    if (tr.handle) { if (!tr.roi) runMask(); return; }
    // Show the region the app already found; the model only loads if the person taps
    if (prev && prev.roi && !(prev.points && prev.points.length)) {
      tr.roi = prev.roi;
      tr.area = 1;
      buildMaskLayer();
      traceHint("Leaf area found automatically. Tap the leaf to re-detect it, or tap − Not leaf and then background to remove it.");
      drawTrace();
      updateTraceButtons();
      return;
    }
    tr.busy = true;
    traceHint("Finding the leaf edges…");
    traceBusy("Starting the leaf finder…");
    getSeg().then(function (m) {
      if (!m.isLoaded()) traceBusy("Downloading the leaf finder (first time only)…");
      return m.load(function (f) { if (tr === mine) traceBusy("Downloading the leaf finder (first time only)… " + Math.round(f * 100) + "%"); }).then(function () { return m; });
    }).then(function (m) {
      if (tr !== mine) return null;
      var cached = samCache.get(mine.imageData);
      if (cached) return cached;
      traceBusy("Finding the leaf…");
      return m.embed(mine.imageData).then(function (h) { samCache.set(mine.imageData, h); return h; });
    }).then(function (h) {
      if (tr !== mine || !h) return;
      tr.handle = h;
      if (prev && prev.points && prev.points.length) { tr.points = prev.points.slice(); return runMask(); }
      // No earlier points: let the leaf finder pick the leaf itself
      traceBusy("Finding the leaf…");
      return segModule.autoMask(h, mine.imageData).then(function (a) {
        if (tr !== mine) return;
        if (a) { tr.points = [a.point]; tr.autoPoint = a.point; return runMask(); }
        tr.busy = false; traceBusy(null); tr.points = [];
        traceHint((prev && prev.reason ? prev.reason + " " : "") + "Tap on the leaf, or use Draw by hand.");
        updateTraceButtons();
      });
    }).catch(function (e) {
      if (tr !== mine) return;
      tr.busy = false;
      tr.autoError = "Automatic leaf finding isn't available here" + (e && e.message ? " (" + e.message + ")" : "") + ".";
      setTraceMode("draw");
    });
  }

  function runMask() {
    var mine = tr;
    tr.busy = true;
    traceBusy("Finding the leaf…");
    updateTraceButtons();
    return segModule.mask(tr.handle, tr.points).then(function (r) {
      if (tr !== mine) return;
      tr.roi = r.roi;
      var area = 0;
      for (var i = 0; i < r.roi.length; i++) area += r.roi[i];
      tr.area = area / r.roi.length;
      buildMaskLayer();
      tr.busy = false;
      traceBusy(null);
      traceHint(tr.area < 0.01
        ? "No leaf found at the centre. Tap on the leaf."
        : "Leaf found. Missed a part? Tap it. Background included? Choose − Not leaf and tap it.");
      drawTrace();
      updateTraceButtons();
    }).catch(function (e) {
      if (tr !== mine) return;
      tr.busy = false;
      traceBusy(null);
      traceHint("Something went wrong finding the leaf (" + e.message + "). Try again or draw by hand.");
      updateTraceButtons();
    });
  }

  // Dim everything that is not leaf and draw a green edge around the leaf
  function buildMaskLayer() {
    var W = tr.W, H = tr.H, roi = tr.roi;
    var c = document.createElement("canvas");
    c.width = W; c.height = H;
    var ctx = c.getContext("2d");
    var img = ctx.createImageData(W, H), d = img.data;
    var e = Math.max(1, Math.round(Math.max(W, H) / 400));   // edge thickness in image pixels
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var i = y * W + x, p = i * 4;
        if (!roi[i]) { d[p + 3] = 160; continue; }
        var edge = (x < e || !roi[i - e]) || (x >= W - e || !roi[i + e]) || (y < e || !roi[i - e * W]) || (y >= H - e || !roi[i + e * W]);
        if (edge) { d[p] = 143; d[p + 1] = 209; d[p + 2] = 158; d[p + 3] = 255; }
      }
    }
    ctx.putImageData(img, 0, 0);
    tr.layer = c;
  }

  function drawTrace() {
    if (!tr) return;
    var cv = $("traceCanvas"), ctx = cv.getContext("2d");
    var sx = cv.width / tr.W, sy = cv.height / tr.H;
    var dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(tr.base, 0, 0, cv.width, cv.height);
    if (tr.mode === "auto") {
      if (tr.layer) ctx.drawImage(tr.layer, 0, 0, cv.width, cv.height);
      tr.points.forEach(function (pt) {
        if (pt.auto && tr.points.length > 1) return;
        ctx.beginPath();
        ctx.arc(pt.x * sx, pt.y * sy, 9 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = pt.label ? "#8fd19e" : "#ff8a6b";
        ctx.fill();
        ctx.lineWidth = 2 * dpr; ctx.strokeStyle = "#0b1a10"; ctx.stroke();
        ctx.fillStyle = "#0b1a10";
        ctx.font = "bold " + Math.round(14 * dpr) + "px system-ui";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(pt.label ? "+" : "−", pt.x * sx, pt.y * sy + dpr);
      });
      return;
    }
    var path = function (pts) {
      ctx.beginPath();
      pts.forEach(function (q, i) { if (i) ctx.lineTo(q[0] * sx, q[1] * sy); else ctx.moveTo(q[0] * sx, q[1] * sy); });
    };
    if (tr.polys.length) {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, cv.width, cv.height);
      tr.polys.forEach(function (pts) { pts.forEach(function (q, i) { if (i) ctx.lineTo(q[0] * sx, q[1] * sy); else ctx.moveTo(q[0] * sx, q[1] * sy); }); ctx.closePath(); });
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fill("evenodd");
      ctx.restore();
    }
    ctx.lineWidth = Math.max(2, 3 * dpr);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    tr.polys.forEach(function (pts) { path(pts); ctx.closePath(); ctx.strokeStyle = "#8fd19e"; ctx.stroke(); });
    if (tr.cur && tr.cur.length > 1) { path(tr.cur); ctx.strokeStyle = "#f0c330"; ctx.stroke(); }
  }

  function updateTraceButtons() {
    if (!tr) return;
    var auto = tr.mode === "auto";
    var userPts = tr.points.filter(function (p) { return !p.auto; }).length;
    $("trUse").disabled = tr.busy || (auto ? !(tr.roi && tr.area >= 0.002) : !tr.polys.length);
    $("trUndo").disabled = tr.busy || (auto ? !userPts : !tr.polys.length);
    $("trClear").disabled = tr.busy || (auto ? !userPts : !tr.polys.length);
    $("trClear").textContent = auto ? "Reset" : "Clear";
  }

  function tracePoint(ev) {
    var rect = $("traceCanvas").getBoundingClientRect();
    return [
      Math.max(0, Math.min(tr.W, (ev.clientX - rect.left) / rect.width * tr.W)),
      Math.max(0, Math.min(tr.H, (ev.clientY - rect.top) / rect.height * tr.H))
    ];
  }
  $("traceCanvas").addEventListener("pointerdown", function (ev) {
    if (!tr) return;
    ev.preventDefault();
    try { $("traceCanvas").setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    tr.down = [ev.clientX, ev.clientY];
    if (tr.mode === "draw") tr.cur = [tracePoint(ev)];
  });
  $("traceCanvas").addEventListener("pointermove", function (ev) {
    if (!tr || tr.mode !== "draw" || !tr.cur) return;
    var q = tracePoint(ev), last = tr.cur[tr.cur.length - 1];
    if (Math.abs(q[0] - last[0]) + Math.abs(q[1] - last[1]) >= 2 / (tr.k || 1)) { tr.cur.push(q); drawTrace(); }
  });
  function endStroke(ev) {
    if (!tr) return;
    if (tr.mode === "auto") {
      // a tap (not a drag) adds a + or − point and re-runs the decoder
      if (!tr.down || tr.busy) return;
      var moved = Math.abs(ev.clientX - tr.down[0]) + Math.abs(ev.clientY - tr.down[1]);
      tr.down = null;
      if (moved > 14) return;
      var q = tracePoint(ev), mine = tr;
      buzz(10);
      var hadHandle = !!tr.handle;
      ensureHandle().then(function () {
        if (tr !== mine) return;
        // First tap on a region found by colour: start the AI from this tap
        if (!hadHandle && !tr.points.length && !tr.sign) { traceHint("Tap the leaf first (+ Leaf), then remove background."); tr.busy = false; updateTraceButtons(); return; }
        tr.points.push({ x: q[0], y: q[1], label: tr.sign });
        drawTrace();
        runMask();
      }).catch(function (e) {
        if (tr !== mine) return;
        tr.busy = false; traceBusy(null);
        tr.autoError = "Automatic leaf finding isn't available here (" + e.message + ").";
        setTraceMode("draw");
      });
      return;
    }
    if (!tr.cur) return;
    var xs = tr.cur.map(function (q) { return q[0]; }), ys = tr.cur.map(function (q) { return q[1]; });
    var span = (Math.max.apply(null, xs) - Math.min.apply(null, xs)) + (Math.max.apply(null, ys) - Math.min.apply(null, ys));
    if (tr.cur.length >= 6 && span * (tr.k || 1) > 30) { tr.polys.push(tr.cur); buzz(10); }
    tr.cur = null;
    drawTrace();
    updateTraceButtons();
  }
  $("traceCanvas").addEventListener("pointerup", endStroke);
  $("traceCanvas").addEventListener("pointercancel", function () { if (tr) { tr.cur = null; tr.down = null; drawTrace(); } });

  document.querySelectorAll("#trMode button").forEach(function (b) {
    b.addEventListener("click", function () { if (tr && tr.mode !== b.dataset.m) setTraceMode(b.dataset.m); });
  });
  document.querySelectorAll("#trSign button").forEach(function (b) {
    b.addEventListener("click", function () {
      if (!tr) return;
      tr.sign = +b.dataset.s;
      document.querySelectorAll("#trSign button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
    });
  });
  $("trUndo").addEventListener("click", function () {
    if (!tr) return;
    if (tr.mode === "auto") {
      for (var i = tr.points.length - 1; i >= 0; i--) if (!tr.points[i].auto) { tr.points.splice(i, 1); break; }
      if (!tr.points.length && tr.autoPoint) tr.points = [tr.autoPoint];
      if (tr.points.length) runMask();
    } else { tr.polys.pop(); drawTrace(); updateTraceButtons(); }
  });
  $("trClear").addEventListener("click", function () {
    if (!tr) return;
    if (tr.mode === "auto") { tr.points = tr.autoPoint ? [tr.autoPoint] : []; if (tr.points.length) runMask(); }
    else { tr.polys = []; drawTrace(); updateTraceButtons(); }
  });
  $("trCancel").addEventListener("click", function () { closeTracer(null); });
  $("trWhole").addEventListener("click", function () { if (tr) closeTracer({ roi: null, method: "whole photo", points: null }); });
  $("trUse").addEventListener("click", function () {
    if (!tr) return;
    if (tr.mode === "auto") {
      if (!tr.roi) return;
      var tapped = tr.points.some(function (p) { return !p.auto; });
      // Nothing changed: keep the earlier result (including per-leaf scores)
      if (!tapped && tr.prev && tr.prev.roi && tr.prev.method !== "traced") return closeTracer(null);
      var pts = tr.points.map(function (p) { return { x: p.x, y: p.y, label: p.label, auto: p.auto }; });
      return closeTracer({ roi: tr.roi, method: tapped ? "auto + taps" : "auto", points: pts });
    }
    if (!tr.polys.length) return;
    // Rasterise the hand-drawn outline(s) at analysis resolution: 1 = inside
    var c = document.createElement("canvas");
    c.width = tr.W; c.height = tr.H;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    tr.polys.forEach(function (pts) {
      ctx.beginPath();
      pts.forEach(function (q, i) { if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
      ctx.closePath();
      ctx.fill();
    });
    var a = ctx.getImageData(0, 0, tr.W, tr.H).data;
    var roi = new Uint8Array(tr.W * tr.H);
    for (var i = 0, p = 3; i < roi.length; i++, p += 4) roi[i] = a[p] > 127 ? 1 : 0;
    closeTracer({ roi: roi, method: "traced", points: null });
  });
  document.addEventListener("keydown", function (e) { if (tr && e.key === "Escape") closeTracer(null); });

  // ---------- taught colours (pliman / PlantCV style) ----------
  // Not offered in the rating app: scoring uses calibrated v2 (or the R script rules)
  var taughtModel = null;
  if (settings.rules === "taught") { settings.rules = "v2"; Settings.save(settings); }
  function currentRules() {
    if (settings.rules === "r1") return "r1";
    return "v2";
  }
  // Compact form for the team link: only non-zero histogram bins
  function packPalette(pal) {
    var out = {};
    Object.keys(pal.classes).forEach(function (k) {
      var c = pal.classes[k];
      out[k] = { n: c.n, h: sparse(c.h), s: sparse(c.s), v: sparse(c.v) };
    });
    return { p: pal.photos, c: out };
  }
  function sparse(a) { var o = []; a.forEach(function (x, i) { if (x) o.push(i, x); }); return o; }
  function unpackPalette(o) {
    var pal = E.emptyPalette();
    pal.photos = o.p || 0;
    Object.keys(o.c).forEach(function (k) {
      var c = pal.classes[k], src = o.c[k];
      if (!c) return;
      c.n = src.n;
      ["h", "s", "v"].forEach(function (ch) { for (var i = 0; i < src[ch].length; i += 2) c[ch][src[ch][i]] = src[ch][i + 1]; });
    });
    return pal;
  }
  function renderTaughtInfo() {
    var pal = settings.palette, row = $("rules-taught");
    row.disabled = !taughtModel;
    $("resetTaught").hidden = !pal;
    if (!pal) return;
    var c = pal.classes;
    $("taughtInfo").textContent = "Learned from " + pal.photos + " photo" + (pal.photos === 1 ? "" : "s") + ": " +
      (c[1].n).toLocaleString() + " healthy, " + (c[2].n).toLocaleString() + " chlorotic, " + (c[3].n).toLocaleString() + " necrotic pixels." +
      (taughtModel ? "" : " Add at least two classes to use them.");
  }
  $("resetTaught").addEventListener("click", function () {
    var b = $("resetTaught");
    if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again to forget them"; setTimeout(function () { delete b.dataset.armed; b.textContent = "Forget taught colours"; }, 3000); return; }
    settings.palette = null; taughtModel = null;
    if (settings.rules === "taught") settings.rules = "v2";
    Settings.save(settings);
    $("rules-v2").checked = settings.rules === "v2";
    renderTaughtInfo(); renderQr();
    toast("Taught colours forgotten");
  });

  var tc = null;   // teach-screen state
  var CLASS_RGB = { 1: [92, 192, 116], 2: [240, 195, 48], 3: [226, 104, 60] };

  function openTeach() {
    if (!current) return;
    var sec = current.sections[current.sections.length - 1];
    var d = sec.imageData, W = d.width, H = d.height;
    var base = document.createElement("canvas");
    base.width = W; base.height = H;
    var px = new Uint8ClampedArray(d.data);
    if (sec.roi) for (var i = 0, p = 0; i < sec.roi.length; i++, p += 4) if (!sec.roi[i]) { px[p] *= 0.3; px[p + 1] *= 0.3; px[p + 2] *= 0.3; }
    base.getContext("2d").putImageData(new ImageData(px, W, H), 0, 0);
    tc = { sec: sec, W: W, H: H, base: base, strokes: [], cls: 1, view: "photo", painting: null, preview: null };
    $("teach").hidden = false;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(function () {
      var stage = $("teachStage"), cv = $("teachCanvas");
      // long thin leaves lie across the screen so they are big enough to brush
      tc.rot = H > W * 1.6;
      var dw = tc.rot ? H : W, dh = tc.rot ? W : H;
      var k = Math.min((stage.clientWidth - 12) / dw, (stage.clientHeight - 12) / dh);
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.style.width = Math.round(dw * k) + "px"; cv.style.height = Math.round(dh * k) + "px";
      cv.width = Math.round(dw * k * dpr); cv.height = Math.round(dh * k * dpr);
      tc.k = k;
      drawTeach();
    });
    setTeachClass(1);
    updateTeach();
  }
  function closeTeach() { $("teach").hidden = true; document.body.style.overflow = ""; tc = null; }

  function setTeachClass(c) {
    if (!tc) return;
    tc.cls = c;
    document.querySelectorAll("#tcClass button").forEach(function (b) { b.setAttribute("aria-pressed", String(+b.dataset.c === c)); });
  }
  document.querySelectorAll("#tcClass button").forEach(function (b) { b.addEventListener("click", function () { setTeachClass(+b.dataset.c); if (tc.view !== "photo") setTeachView("photo"); }); });
  function setTeachView(v) {
    if (!tc) return;
    tc.view = v;
    document.querySelectorAll("#tcView button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === v)); });
    if (v === "result") previewTeach();
    drawTeach();
  }
  document.querySelectorAll("#tcView button").forEach(function (b) { b.addEventListener("click", function () { setTeachView(b.dataset.v); }); });

  // Saved palette plus what was brushed on this photo
  function teachPalette() {
    var pal = settings.palette ? JSON.parse(JSON.stringify(settings.palette)) : E.emptyPalette();
    var d = tc.sec.imageData;
    tc.strokes.forEach(function (st) { E.addSamples(pal, d.data, st.idx, st.cls); });
    return pal;
  }
  function previewTeach() {
    var model = E.buildModel(teachPalette());
    if (!model) { tc.preview = null; tc.previewText = "Brush at least two kinds of tissue to see a result."; return; }
    var d = tc.sec.imageData;
    var res = E.analyze(d.data, d.width, d.height, undefined, tc.sec.roi || undefined, model);
    if (!res.ok) { tc.preview = null; tc.previewText = res.message; return; }
    var px = E.overlay(d.data, res.mask, 0.55);
    if (tc.sec.roi) for (var i = 0, p = 0; i < tc.sec.roi.length; i++, p += 4) if (!tc.sec.roi[i]) { px[p] *= 0.25; px[p + 1] *= 0.25; px[p + 2] *= 0.25; }
    var c = document.createElement("canvas"); c.width = d.width; c.height = d.height;
    c.getContext("2d").putImageData(new ImageData(px, d.width, d.height), 0, 0);
    tc.preview = c;
    tc.previewText = "With these colours: " + fmtPct(res.diseasedPct) + " diseased (chlorotic " + fmtPct(res.chloroticPct) + ", necrotic " + fmtPct(res.necroticPct) + "), BLS " + res.score + ".";
  }

  function drawTeach() {
    if (!tc) return;
    var cv = $("teachCanvas"), ctx = cv.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (tc.rot) { ctx.translate(cv.width, 0); ctx.rotate(Math.PI / 2); }
    var w = tc.rot ? cv.height : cv.width, h = tc.rot ? cv.width : cv.height;
    var src = tc.view === "result" && tc.preview ? tc.preview : tc.base;
    ctx.drawImage(src, 0, 0, w, h);
    if (tc.view === "photo") {
      var sx = w / tc.W;
      tc.strokes.concat(tc.painting ? [tc.painting] : []).forEach(function (st) {
        var c = CLASS_RGB[st.cls];
        ctx.strokeStyle = "rgba(" + c.join(",") + ",0.6)";
        ctx.lineWidth = st.r * 2 * sx; ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.beginPath();
        st.pts.forEach(function (q, i) { if (i) ctx.lineTo(q[0] * sx, q[1] * sx); else ctx.moveTo(q[0] * sx, q[1] * sx); });
        if (st.pts.length === 1) ctx.lineTo(st.pts[0][0] * sx + 0.1, st.pts[0][1] * sx);
        ctx.stroke();
      });
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function updateTeach() {
    if (!tc) return;
    var cnt = { 1: 0, 2: 0, 3: 0 };
    tc.strokes.forEach(function (st) { cnt[st.cls] += st.idx.length; });
    var pal = settings.palette;
    var names = { 1: "Healthy", 2: "Chlorotic", 3: "Necrotic" };
    var html = [1, 2, 3].map(function (k) {
      return '<span><i style="background:rgb(' + CLASS_RGB[k].join(",") + ')"></i>' + names[k] + " <b>" + cnt[k].toLocaleString() + "</b>" +
        (pal && pal.classes[k].n ? " (+" + pal.classes[k].n.toLocaleString() + " earlier)" : "") + "</span>";
    }).join("");
    if (tc.view === "result" && tc.previewText) html += '<span style="width:100%;color:#eef4ec">' + esc(tc.previewText) + "</span>";
    $("tcCounts").innerHTML = html;
    var model = E.buildModel(teachPalette());
    $("tcSave").disabled = !tc.strokes.length || !model;
    $("tcUndo").disabled = !tc.strokes.length;
    $("tcClear").disabled = !tc.strokes.length;
  }

  function teachPoint(ev) {
    var rect = $("teachCanvas").getBoundingClientRect();
    var fx = (ev.clientX - rect.left) / rect.width, fy = (ev.clientY - rect.top) / rect.height;
    // undo the on-screen rotation
    return tc.rot ? [fy * tc.W, (1 - fx) * tc.H] : [fx * tc.W, fy * tc.H];
  }
  $("teachCanvas").addEventListener("pointerdown", function (ev) {
    if (!tc || tc.view !== "photo") return;
    ev.preventDefault();
    try { $("teachCanvas").setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    var r = Math.max(2, 9 / (tc.k || 1));   // about 9 screen pixels
    tc.painting = { cls: tc.cls, r: r, pts: [teachPoint(ev)] };
    drawTeach();
  });
  $("teachCanvas").addEventListener("pointermove", function (ev) {
    if (!tc || !tc.painting) return;
    tc.painting.pts.push(teachPoint(ev));
    drawTeach();
  });
  function endTeachStroke() {
    if (!tc || !tc.painting) return;
    var st = tc.painting; tc.painting = null;
    // collect leaf pixels under the brush
    var W = tc.W, H = tc.H, roi = tc.sec.roi, set = new Set(), r = st.r, r2 = r * r;
    st.pts.forEach(function (q) {
      for (var y = Math.max(0, Math.floor(q[1] - r)); y <= Math.min(H - 1, Math.ceil(q[1] + r)); y++) {
        for (var x = Math.max(0, Math.floor(q[0] - r)); x <= Math.min(W - 1, Math.ceil(q[0] + r)); x++) {
          var dx = x - q[0], dy = y - q[1];
          if (dx * dx + dy * dy <= r2) { var i = y * W + x; if (!roi || roi[i]) set.add(i); }
        }
      }
    });
    if (set.size) { st.idx = Array.from(set); tc.strokes.push(st); buzz(8); }
    drawTeach();
    updateTeach();
  }
  $("teachCanvas").addEventListener("pointerup", endTeachStroke);
  $("teachCanvas").addEventListener("pointercancel", function () { if (tc) { tc.painting = null; drawTeach(); } });
  $("tcUndo").addEventListener("click", function () { if (tc) { tc.strokes.pop(); if (tc.view === "result") previewTeach(); drawTeach(); updateTeach(); } });
  $("tcClear").addEventListener("click", function () { if (tc) { tc.strokes = []; if (tc.view === "result") previewTeach(); drawTeach(); updateTeach(); } });
  $("tcClose").addEventListener("click", closeTeach);
  document.querySelectorAll("#tcView button").forEach(function (b) { b.addEventListener("click", updateTeach); });
  $("tcSave").addEventListener("click", function () {
    if (!tc) return;
    var pal = teachPalette();
    pal.photos = (pal.photos || 0) + 1;
    var model = E.buildModel(pal);
    if (!model) return;
    settings.palette = pal;
    taughtModel = model;
    settings.rules = "taught";
    Settings.save(settings);
    closeTeach();
    // re-score the photo on screen with the taught colours
    current.sections.forEach(function (sec) { analyzeSection(sec, sec.found); });
    rebuildCurrent();
    renderResult();
    $("rules-taught").checked = true;
    renderTaughtInfo(); renderQr();
    toast("Colours taught. Photos are now scored with your colours.");
  });
  document.addEventListener("click", function (ev) { if (ev.target.closest("[data-teach]")) openTeach(); });

  // ---------- agreement with visual estimates (Lin's concordance) ----------
  function linCCC(x, y) {
    var n = x.length, mx = 0, my = 0;
    for (var i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    var sxx = 0, syy = 0, sxy = 0;
    for (i = 0; i < n; i++) { sxx += (x[i] - mx) * (x[i] - mx); syy += (y[i] - my) * (y[i] - my); sxy += (x[i] - mx) * (y[i] - my); }
    sxx /= n; syy /= n; sxy /= n;
    var r = sxy / Math.sqrt(sxx * syy);
    var ccc = 2 * sxy / (sxx + syy + (mx - my) * (mx - my));
    return { ccc: ccc, r: r, cb: ccc / r, bias: mx - my, n: n };
  }
  function renderAgreement(list) {
    var pairs = list.filter(function (r) { return r.meta.visualScore >= 1 && r.meta.visualScore <= 9; });
    var card = $("agreeCard");
    card.hidden = !pairs.length;
    if (!pairs.length) return;
    if (pairs.length < 5) {
      card.innerHTML = '<span class="eyebrow">Agreement with visual scores</span><span class="small muted">' + pairs.length + " leaf" + (pairs.length === 1 ? "" : " records") + " with a visual 1–9 score so far. Add at least 5 to see how well the app agrees with your raters.</span>";
      return;
    }
    var app = pairs.map(function (r) { return r.result.score; }), eye = pairs.map(function (r) { return +r.meta.visualScore; });
    var a = linCCC(app, eye);
    var exact = 0, within1 = 0;
    app.forEach(function (x, i) { var d = Math.abs(x - eye[i]); if (!d) exact++; if (d <= 1) within1++; });
    var pc = function (k) { return Math.round(100 * k / app.length) + "%"; };
    var ccc = isFinite(a.ccc) ? a.ccc : 0;
    var verdict = ccc >= 0.9 ? "strong" : ccc >= 0.75 ? "good" : ccc >= 0.5 ? "moderate" : "poor";
    card.innerHTML = '<span class="eyebrow">Agreement with visual 1–9 scores</span>' +
      '<div class="agree-top"><b class="num">' + pc(exact) + '</b><span class="small">same score · <b>' + pc(within1) + "</b> within one score · " + a.n + " leaves</span></div>" +
      '<span class="small">Lin\'s concordance ρc = <b class="num">' + ccc.toFixed(2) + "</b> (" + verdict + ")</span>" +
      '<span class="small muted">Compares the app\'s BLS score with the score your raters gave by eye (ρc = 1 is perfect). ' +
      (isFinite(a.r) ? "Precision r = " + a.r.toFixed(2) + ", accuracy Cb = " + a.cb.toFixed(2) + ". " : "") +
      "On average the app scores " + Math.abs(a.bias).toFixed(1) + " " + (a.bias >= 0 ? "higher" : "lower") + " than the raters." +
      "</span>" + pctAgreement(list);
  }
  // Same check on diseased area (%), for raters who gave a % estimate
  function pctAgreement(list) {
    var p = list.filter(function (r) { var v = r.meta.visualPct; return v !== "" && v != null && isFinite(+v); });
    if (p.length < 5) return "";
    var a = linCCC(p.map(function (r) { return r.result.diseasedPct; }), p.map(function (r) { return +r.meta.visualPct; }));
    var blind = list.filter(function (r) { return /^blind/.test(r.meta.ratingMode || ""); }).length;
    var mae = p.reduce(function (s, r) { return s + Math.abs(r.result.diseasedPct - r.meta.visualPct); }, 0) / p.length;
    return '<span class="small">Diseased area: ρc = <b class="num">' + (isFinite(a.ccc) ? a.ccc.toFixed(2) : "–") + "</b>, mean difference " + mae.toFixed(1) +
      " points, app " + Math.abs(a.bias).toFixed(1) + " points " + (a.bias >= 0 ? "higher" : "lower") + " on average · " + p.length + " leaves" +
      (blind ? " (" + blind + " rated blind)" : "") + "</span>";
  }

  // ---------- visual 1-9 score ruler on the save form ----------
  var visualScore = null;
  (function () {
    var html = "";
    for (var k = 1; k <= 9; k++) html += '<button type="button" role="radio" aria-checked="false" data-vs="' + k + '" style="background:' + scoreColor(k) + '">' + k + "</button>";
    $("visRuler").innerHTML = html;
  })();
  function setVisual(k) {
    visualScore = k;
    document.querySelectorAll("#visRuler button").forEach(function (b) { b.setAttribute("aria-checked", String(+b.dataset.vs === k)); });
    $("visHint").textContent = k ? "Your score: " + k + " (" + E.category(k) + "). Tap again to clear." : "Tap the score you would give this leaf by eye. Tap again to clear.";
  }
  $("visRuler").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-vs]");
    if (!b) return;
    if (pendingRating) { toast("This rating was made blind and is locked."); return; }
    var k = +b.dataset.vs;
    setVisual(visualScore === k ? null : k);
    buzz(8);
  });

  // ---------- edit a saved record ----------
  function showEditForm(sheet, rec) {
    var m = rec.meta;
    var f = function (id, label, val, type) {
      return '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" type="' + (type || "text") + '" value="' + esc(val || "") + '"' + (type === "number" ? ' min="1" inputmode="numeric"' : "") + "></div>";
    };
    sheet.innerHTML = '<div class="grabber"></div><h3>Edit record</h3>' +
      '<p class="small muted" style="margin:0">Score ' + rec.result.score + " · " + fmtPct(rec.result.diseasedPct) + " diseased. The score comes from the photo and cannot be edited.</p>" +
      '<div class="form">' + f("ePlot", "Plot / sample ID", m.plot) +
      '<div class="row2">' + f("eRep", "Rep", m.rep, "number") + f("eLeaf", "Leaf no.", m.leaf, "number") + "</div>" +
      f("eGenotype", "Genotype / entry", m.genotype) +
      '<div class="row2">' + f("eVisual", "Visual BLS score (1–9)", m.visualScore, "number") + f("ePct", "Visual diseased %", m.visualPct, "number") + "</div>" +
      '<div class="row2">' + f("eTrial", "Trial", m.trial) + f("eRater", "Rater", m.rater) + "</div>" +
      '<div class="field"><label for="eNotes">Notes</label><textarea id="eNotes">' + esc(m.notes || "") + "</textarea></div></div>" +
      '<div class="sheet-actions"><button class="btn btn-primary" type="button" id="eSave">Save changes</button><button class="btn btn-ghost" type="button" id="eCancel">Cancel</button></div>';
    sheet.querySelector("#eCancel").addEventListener("click", closeSheet);
    sheet.querySelector("#eSave").addEventListener("click", function () {
      var v = function (id) { return sheet.querySelector("#" + id).value.trim(); };
      if (!v("ePlot")) { sheet.querySelector("#ePlot").focus(); toast("Plot ID is required"); return; }
      var vs = /^[1-9]$/.test(v("eVisual")) ? +v("eVisual") : "";
      var vp = v("ePct") === "" ? "" : parseFloat(v("ePct"));
      if (vp !== "" && !(vp >= 0 && vp <= 100)) { sheet.querySelector("#ePct").focus(); toast("Visual % must be between 0 and 100"); return; }
      // Study fields are kept; a rating changed after the app's score was seen is marked as edited
      var mode = m.ratingMode || "";
      if ((vs !== (m.visualScore || "") || vp !== (m.visualPct === undefined ? "" : m.visualPct)) && /^blind/.test(mode)) mode = "blind, edited after";
      if (!mode && vs) mode = "after app score";
      rec.meta = Object.assign({}, m, { plot: v("ePlot"), rep: v("eRep"), leaf: v("eLeaf"), genotype: v("eGenotype"), trial: v("eTrial"), rater: v("eRater"), notes: v("eNotes"), visualScore: vs, visualPct: vp, ratingMode: mode });
      rec.editedAt = new Date().toISOString();
      if (settings.destination !== "local") rec.sync = "pending";
      Records.put(rec).then(function () {
        closeSheet(); toast("Changes saved"); renderRecords(); refreshPending(); syncPending();
      });
    });
    sheet.querySelector("#ePlot").focus({ preventScroll: true });
  }

  // ---------- plot list ----------
  function parseCsv(text) {
    text = text.replace(/^﻿/, "");
    var first = text.split(/\r?\n/)[0] || "";
    var delim = [",", ";", "\t"].sort(function (a, b) { return first.split(b).length - first.split(a).length; })[0];
    var rows = [], row = [], field = "", q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') q = false;
        else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some(function (c) { return c.trim(); })) rows.push(row);
        row = [];
      } else field += ch;
    }
    row.push(field);
    if (row.some(function (c) { return c.trim(); })) rows.push(row);
    return rows;
  }

  function readPlotList(text) {
    var rows = parseCsv(text);
    if (!rows.length) throw new Error("The file is empty.");
    var head = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    var find = function (re) { for (var i = 0; i < head.length; i++) if (re.test(head[i])) return i; return -1; };
    var iPlot = find(/plot|sample|^id$|^entry_?id$/);
    var hasHeader = iPlot !== -1 || head.some(function (h) { return /genotype|entry|variety|rep|trial/.test(h); });
    if (iPlot === -1) iPlot = 0;
    var iGen = find(/genotype|entry|variety|line|cultivar|accession|pedigree|hybrid/);
    var iRep = find(/^rep|replicat|block/);
    var iTrial = find(/trial|experiment|location|site/);
    var seen = {}, out = [];
    rows.slice(hasHeader ? 1 : 0).forEach(function (r) {
      var plot = (r[iPlot] || "").trim();
      if (!plot || seen[plot.toLowerCase()]) return;
      seen[plot.toLowerCase()] = 1;
      out.push({
        plot: plot,
        genotype: iGen >= 0 && iGen !== iPlot ? (r[iGen] || "").trim() : "",
        rep: iRep >= 0 ? (r[iRep] || "").trim() : "",
        trial: iTrial >= 0 ? (r[iTrial] || "").trim() : ""
      });
    });
    if (!out.length) throw new Error("No plot IDs found. The file needs a column named plot.");
    return out;
  }

  function plotList() { return settings.plots || []; }
  function findPlot(id) {
    var k = String(id || "").trim().toLowerCase();
    if (!k) return null;
    var list = plotList();
    for (var i = 0; i < list.length; i++) if (list[i].plot.toLowerCase() === k) return list[i];
    return null;
  }
  function nextPlotAfter(id) {
    var list = plotList();
    if (!list.length) return null;
    var k = String(id || "").trim().toLowerCase();
    for (var i = 0; i < list.length; i++) if (list[i].plot.toLowerCase() === k) return list[i + 1] || null;
    return null;
  }

  function fillPlotOptions() {
    $("plotOptions").innerHTML = plotList().slice(0, 3000).map(function (p) {
      return '<option value="' + esc(p.plot) + '">' + esc([p.genotype, p.rep && "Rep " + p.rep].filter(Boolean).join(" · ")) + "</option>";
    }).join("");
  }

  var autoGenotype = "";
  function applyPlot() {
    var hint = $("plotHint");
    var id = $("fPlot").value.trim();
    var p = findPlot(id);
    var done = id ? allRecords.filter(function (r) { return (r.meta.plot || "").toLowerCase() === id.toLowerCase(); }).length : 0;
    var bits = [];
    if (p) {
      // Fill from the plot list, but never overwrite something the person typed
      if (p.genotype && (!$("fGenotype").value || $("fGenotype").value === autoGenotype)) { $("fGenotype").value = p.genotype; autoGenotype = p.genotype; }
      if (p.rep && /^\d+$/.test(p.rep) && document.activeElement !== $("fRep")) $("fRep").value = p.rep;
      if (p.trial && !$("fTrial").value) { $("fTrial").value = p.trial; updateContext(); }
      bits.push("✓ In plot list" + (p.genotype ? " · " + p.genotype : "") + (p.rep ? " · Rep " + p.rep : ""));
    } else if (id && plotList().length) {
      bits.push("Not in your plot list. Check the ID.");
    }
    if (done) bits.push(done + (done === 1 ? " leaf" : " leaves") + " already saved for this plot");
    hint.textContent = bits.join(" · ");
    hint.className = "hint" + (p ? " ok" : (id && plotList().length ? " warn" : ""));
    hint.hidden = !bits.length;
  }
  $("fPlot").addEventListener("input", applyPlot);
  $("fPlot").addEventListener("change", applyPlot);

  $("nextPlotBtn").addEventListener("click", function () {
    $("fPlot").value = $("nextPlotBtn").dataset.plot || "";
    $("fLeaf").value = "1";
    applyPlot();
    $("camInput").click();
  });

  function renderPlotSettings() {
    var list = plotList();
    $("plotListInfo").innerHTML = list.length
      ? "<b>" + list.length + " plots</b> loaded from <span class=\"num\">" + esc(settings.plotFile || "CSV") + "</span>" +
        (list.some(function (p) { return p.genotype; }) ? " · with genotypes" : "") + (list.some(function (p) { return p.rep; }) ? " · with reps" : "")
      : '<span class="muted">No plot list loaded.</span>';
    $("clearPlots").hidden = !list.length;
  }

  $("plotFile").addEventListener("change", function (ev) {
    var f = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    f.text().then(function (text) {
      var list = readPlotList(text);
      settings.plots = list; settings.plotFile = f.name;
      Settings.save(settings);
      fillPlotOptions(); renderPlotSettings(); applyPlot();
      toast(list.length + " plots loaded");
    }).catch(function (e) { toast("Could not read the plot list: " + e.message); });
  });
  $("clearPlots").addEventListener("click", function () {
    settings.plots = []; settings.plotFile = "";
    Settings.save(settings);
    fillPlotOptions(); renderPlotSettings(); applyPlot();
    toast("Plot list removed");
  });

  function renderProgress(all) {
    var list = plotList();
    var trial = $("trialFilter").value;
    if (trial) list = list.filter(function (p) { return !p.trial || p.trial === trial; });
    $("plotProgress").hidden = !list.length;
    if (!list.length) return;
    var scored = {};
    all.forEach(function (r) { if (!trial || r.meta.trial === trial) scored[(r.meta.plot || "").toLowerCase()] = 1; });
    var missing = list.filter(function (p) { return !scored[p.plot.toLowerCase()]; });
    var done = list.length - missing.length;
    $("progText").textContent = done + " / " + list.length;
    $("progBar").style.width = (done / list.length * 100) + "%";
    $("missingList").textContent = missing.length ? missing.slice(0, 300).map(function (p) { return p.plot; }).join(", ") + (missing.length > 300 ? " … and " + (missing.length - 300) + " more" : "") : "All plots scored.";
  }
  $("missingBtn").addEventListener("click", function () {
    var open = $("missingList").hidden;
    $("missingList").hidden = !open;
    $("missingBtn").textContent = open ? "Hide list" : "Show plots not scored yet";
  });

  // ---------- summary by genotype / plot ----------
  var recMode = "leaves", groupBy = "genotype", lastSummary = [];
  function mean(a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; }
  function stderr(a) {
    if (a.length < 2) return null;
    var m = mean(a);
    return Math.sqrt(a.reduce(function (x, y) { return x + (y - m) * (y - m); }, 0) / (a.length - 1)) / Math.sqrt(a.length);
  }
  function natural(a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" }); }

  function summarizeRecords(list, by) {
    var plots = {};
    list.forEach(function (r) {
      var key = (r.meta.trial || "") + "|" + (r.meta.plot || r.id);
      var p = plots[key] || (plots[key] = { plot: r.meta.plot || "(no plot ID)", genotype: r.meta.genotype || "", rep: r.meta.rep || "", trial: r.meta.trial || "", scores: [], dis: [] });
      if (!p.genotype && r.meta.genotype) p.genotype = r.meta.genotype;
      p.scores.push(r.result.score); p.dis.push(r.result.diseasedPct);
    });
    var plotRows = Object.keys(plots).map(function (k) {
      var p = plots[k];
      return { label: p.plot, genotype: p.genotype, rep: p.rep, trial: p.trial, plots: 1, leaves: p.scores.length,
        score: mean(p.scores), scoreSe: stderr(p.scores), dis: mean(p.dis), disSe: stderr(p.dis) };
    });
    if (by === "plot") return plotRows.sort(function (a, b) { return natural(a.label, b.label); });
    var gen = {};
    plotRows.forEach(function (p) {
      var g = gen[p.genotype || "(no genotype)"] || (gen[p.genotype || "(no genotype)"] = { s: [], d: [], leaves: 0 });
      g.s.push(p.score); g.d.push(p.dis); g.leaves += p.leaves;
    });
    return Object.keys(gen).map(function (k) {
      var g = gen[k];
      return { label: k, plots: g.s.length, leaves: g.leaves, score: mean(g.s), scoreSe: stderr(g.s), dis: mean(g.d), disSe: stderr(g.d) };
    }).sort(function (a, b) { return a.score - b.score || natural(a.label, b.label); });
  }

  function fmtSe(v, d) { return v == null ? "" : ' <span class="se">±' + v.toFixed(d) + "</span>"; }
  function renderSummary(list) {
    var rows = lastSummary = summarizeRecords(list, groupBy);
    var dot = function (sc) { return '<span class="score-dot" style="background:' + scoreColor(Math.min(9, Math.max(1, Math.round(sc)))) + '"></span>'; };
    var head = groupBy === "genotype"
      ? "<tr><th>Genotype</th><th>Plots</th><th>Leaves</th><th>Score</th><th>Diseased %</th></tr>"
      : "<tr><th>Plot</th><th>Genotype</th><th>Rep</th><th>Leaves</th><th>Score</th><th>Diseased %</th></tr>";
    $("sumTable").innerHTML = "<thead>" + head + "</thead><tbody>" + (rows.length ? rows.map(function (r) {
      var cells = groupBy === "genotype"
        ? [esc(r.label), r.plots, r.leaves]
        : [esc(r.label), '<span style="font-family:var(--font-body)">' + esc(r.genotype || "–") + "</span>", esc(r.rep || "–"), r.leaves];
      return "<tr><td>" + cells.join("</td><td>") + "</td><td>" + dot(r.score) + r.score.toFixed(1) + fmtSe(r.scoreSe, 1) + "</td><td>" + r.dis.toFixed(1) + fmtSe(r.disSe, 1) + "</td></tr>";
    }).join("") : '<tr><td colspan="6" class="muted">No records match.</td></tr>') + "</tbody>";
    $("sumNote").textContent = groupBy === "genotype"
      ? "Leaves are averaged within each plot first; genotype values are means of plot means, ± standard error across plots. Sorted from most resistant. Uses the search and trial filter above."
      : "Mean of the leaves scored in each plot, ± standard error across leaves. Uses the search and trial filter above.";
  }

  document.querySelectorAll("#recMode button").forEach(function (b) {
    b.addEventListener("click", function () {
      recMode = b.dataset.mode;
      document.querySelectorAll("#recMode button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      renderRecords();
    });
  });
  document.querySelectorAll("#groupBy button").forEach(function (b) {
    b.addEventListener("click", function () {
      groupBy = b.dataset.group;
      document.querySelectorAll("#groupBy button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      renderRecords();
    });
  });
  $("exportSummary").addEventListener("click", function () {
    if (!lastSummary.length) { toast("Nothing to export yet"); return; }
    var cols = groupBy === "genotype"
      ? ["Genotype", "Plots", "Leaves", "Mean_BLS_Score", "SE_BLS_Score", "Mean_Diseased_Percent", "SE_Diseased_Percent"]
      : ["Plot_ID", "Genotype", "Rep", "Trial", "Leaves", "Mean_BLS_Score", "SE_BLS_Score", "Mean_Diseased_Percent", "SE_Diseased_Percent"];
    var r2 = function (v) { return v == null ? "" : (Math.round(v * 100) / 100); };
    var lines = [cols.join(",")].concat(lastSummary.map(function (r) {
      var v = groupBy === "genotype" ? [r.label, r.plots, r.leaves] : [r.label, r.genotype, r.rep, r.trial, r.leaves];
      return v.concat([r2(r.score), r2(r.scoreSe), r2(r.dis), r2(r.disSe)]).map(csvCell).join(",");
    }));
    shareOrDownload(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv" }), "BLS_summary_by_" + groupBy + "_" + trialTag() + today() + ".csv", "text/csv", "Summary exported");
  });

  // ---------- backup + restore ----------
  function backupStatus(msg, ok) { var s2 = $("backupStatus"); s2.textContent = msg; s2.className = "status-line " + (ok ? "ok" : "err"); }

  $("backupBtn").addEventListener("click", function () {
    if (!window.JSZip) { backupStatus("Backup is not available in this browser.", false); return; }
    backupStatus("Preparing backup…", true);
    Records.all().then(function (all) {
      if (!all.length) { backupStatus("There are no records to back up yet.", false); return null; }
      var zip = new JSZip();
      var list = all.slice().reverse();
      zip.file("BLS_results.csv", buildCsv(list));
      zip.file("backup.json", JSON.stringify({
        app: "BLS Leaf Scorer", appVersion: APP_VERSION, engineVersion: E.VERSION, exportedAt: new Date().toISOString(),
        records: list.map(function (r) {
          var c = Object.assign({}, r);
          delete c.photo; delete c.overlay;
          c.photoFile = r.photo ? "photos/" + r.id + "_photo.jpg" : null;
          c.overlayFile = r.overlay ? "overlays/" + r.id + "_overlay.jpg" : null;
          return c;
        })
      }, null, 1));
      list.forEach(function (r) {
        if (r.photo) zip.file("photos/" + r.id + "_photo.jpg", r.photo);
        if (r.overlay) zip.file("overlays/" + r.id + "_overlay.jpg", r.overlay);
      });
      // JPEGs are already compressed, so store them as they are (much faster)
      return zip.generateAsync({ type: "blob", compression: "STORE", mimeType: "application/zip" }).then(function (blob) {
        backupStatus("✓ Backup of " + list.length + " records (" + (blob.size / 1e6).toFixed(1) + " MB) ready.", true);
        return shareOrDownload(blob, "BLS_backup_" + today() + ".zip", "application/zip");
      });
    }).catch(function (e) { backupStatus("Backup failed: " + e.message, false); });
  });

  $("restoreFile").addEventListener("change", function (ev) {
    var f = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    if (!window.JSZip) { backupStatus("Restore is not available in this browser.", false); return; }
    backupStatus("Reading backup…", true);
    var added = 0, skipped = 0;
    JSZip.loadAsync(f).then(function (zip) {
      var j = zip.file("backup.json");
      if (!j) throw new Error("this is not a BLS Leaf Scorer backup (backup.json is missing)");
      return j.async("string").then(function (txt) {
        var data = JSON.parse(txt);
        return Records.all().then(function (existing) {
          var have = {};
          existing.forEach(function (r) { have[r.id] = 1; });
          var chain = Promise.resolve();
          (data.records || []).forEach(function (r) {
            if (!r || !r.id || !r.result || !r.meta) return;
            if (have[r.id]) { skipped++; return; }
            chain = chain.then(function () {
              var get = function (path) {
                var zf = path && zip.file(path);
                return zf ? zf.async("blob").then(function (b) { return new Blob([b], { type: "image/jpeg" }); }) : Promise.resolve(null);
              };
              return Promise.all([get(r.photoFile), get(r.overlayFile)]).then(function (b) {
                var rec = Object.assign({}, r, { photo: b[0], overlay: b[1] });
                delete rec.photoFile; delete rec.overlayFile;
                if (rec.sync !== "synced") rec.sync = settings.destination === "local" ? "local" : "pending";
                added++;
                return Records.put(rec);
              });
            });
          });
          return chain;
        });
      });
    }).then(function () {
      backupStatus("✓ Restored " + added + " record" + (added === 1 ? "" : "s") + (skipped ? " (" + skipped + " were already on this phone)" : "") + ".", true);
      refreshPending(); syncPending();
    }).catch(function (e) { backupStatus("Could not restore: " + e.message, false); });
  });

  // ---------- method table ----------
  function renderMethod() {
    $("engVer").textContent = E.VERSION;
    var lo = 0;
    $("scaleTable").innerHTML = E.SCALE.concat([[100, 9]]).map(function (row) {
      var range = row[1] === 1 ? "0–0.5%" : row[1] === 9 ? ">75%" : ">" + lo + "–" + row[0] + "%";
      lo = row[0];
      return '<tr><td><span class="mini-score num" style="width:26px;height:26px;font-size:14px;border-radius:8px;background:' + scoreColor(row[1]) + '">' + row[1] + "</span></td><td class=\"num\">" + range + "</td><td>" + E.category(row[1]) + "</td></tr>";
    }).join("");
  }

  // ---------- install (Android + iPhone) ----------
  var ua = navigator.userAgent || "";
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  var isAndroid = /android/i.test(ua);
  var inFrame = false;
  try { inFrame = window.self !== window.top; } catch (e) { inFrame = true; }
  function isInstalled() {
    return (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  }
  var deferredPrompt = null;
  var SNOOZE_KEY = "bls-install-snooze";

  function snoozed() {
    try { return Date.now() < +(localStorage.getItem(SNOOZE_KEY) || 0); } catch (e) { return false; }
  }

  function showInstallCard() {
    if (inFrame || isInstalled() || snoozed()) { $("installCard").hidden = true; return; }
    if (deferredPrompt) {
      // Android Chrome / Edge / Samsung Internet: one-tap install
      $("installBtn").hidden = false;
      $("iosSteps").hidden = true;
      $("installText").textContent = "Install it on this phone. It opens like an app and works without internet.";
      $("installCard").hidden = false;
    } else if (isIOS) {
      $("installBtn").hidden = true;
      $("iosSteps").hidden = false;
      $("installText").textContent = /crios|fxios|edgios/i.test(ua)
        ? "Add it to your Home Screen. If you don't see the option, open this page in Safari."
        : "Add it to your Home Screen. It opens like an app, works without internet, and keeps your records safe.";
      $("installCard").hidden = false;
    } else if (isAndroid) {
      $("installBtn").hidden = true;
      $("iosSteps").hidden = true;
      $("installText").textContent = "Open the browser menu (⋮) and tap Install app or Add to Home screen.";
      $("installCard").hidden = false;
    }
  }

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    showInstallCard();
  });
  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    $("installCard").hidden = true;
    toast("Installed. Open BLS Scorer from your home screen.");
    protectStorage();
  });
  $("installBtn").addEventListener("click", function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function () { deferredPrompt = null; showInstallCard(); });
  });
  $("installLater").addEventListener("click", function () {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + 3 * 864e5)); } catch (e) { /* ignore */ }
    $("installCard").hidden = true;
  });

  // Ask the phone not to clear our records when space runs low
  function protectStorage() {
    if (navigator.storage && navigator.storage.persist) {
      return navigator.storage.persisted().then(function (p) { return p || navigator.storage.persist(); }).catch(function () { return false; });
    }
    return Promise.resolve(false);
  }

  function renderPhoneInfo() {
    var lines = [];
    lines.push(isInstalled() ? "✓ Installed as an app" : "Running in the browser. Install it from the Analyze tab for offline use.");
    lines.push(navigator.onLine === false ? "Offline: records will sync when you're back online" : "Online");
    lines.push("App version " + APP_VERSION + " · engine " + E.VERSION);
    lines.push(settings.finderOk ? "✓ AI leaf finder worked on this phone" : settings.finderError ? "✗ AI leaf finder failed last time: " + settings.finderError : "AI leaf finder not used yet. Tap Check the leaf finder.");
    var box = $("phoneInfo");
    var paint = function () { box.innerHTML = lines.map(function (l) { return "<span>" + esc(l) + "</span>"; }).join(""); };
    paint();
    if (navigator.storage && navigator.storage.estimate) {
      Promise.all([navigator.storage.estimate(), navigator.storage.persisted ? navigator.storage.persisted() : false]).then(function (r) {
        var mb = (r[0].usage || 0) / 1e6;
        lines.push("Using " + (mb < 1 ? "under 1" : mb.toFixed(0)) + " MB of storage" + (r[0].quota ? " (" + Math.round(r[0].quota / 1e9) + " GB available to the app)" : ""));
        lines.push(r[1] ? "✓ Records are protected from automatic clean-up" : "Export a CSV now and then as a backup");
        paint();
      }).catch(function () {});
    }
  }

  // Settings → Check the leaf finder: load the model and find the leaf in a test photo
  $("checkFinder").addEventListener("click", function () {
    var out = $("finderStatus"), btn = $("checkFinder");
    btn.disabled = true;
    out.className = "status-line ok";
    out.textContent = "Loading the leaf finder…";
    var t0 = performance.now();
    var img;
    fetch("samples/field_check.jpg").then(function (r) { return r.blob(); }).then(decode).then(function (bmp) {
      img = toImageData(bmp, MAX_ANALYSIS_SIDE);
      return getSeg();
    }).then(function (m) {
      return m.load(function (f) { out.textContent = "Downloading the leaf finder… " + Math.round(f * 100) + "% of 25 MB"; }).then(function () { return m; });
    }).then(function (m) {
      out.textContent = "Finding the leaf in a test photo…";
      var t1 = performance.now();
      return m.embed(img).then(function (h) { return m.autoMask(h, img); }).then(function (a) {
        if (!a) throw new Error("no leaf found in the test photo");
        var res = E.analyze(img.data, img.width, img.height, undefined, a.roi, "v2");
        noteFinder(null);
        out.textContent = "✓ Leaf finder works: found the leaf in " + ((performance.now() - t1) / 1000).toFixed(1) + " s using " + m.threads() +
          " CPU thread" + (m.threads() === 1 ? "" : "s") + " (test leaf scored " + fmtPct(res.diseasedPct) + " diseased).";
      });
    }).catch(function (e) {
      noteFinder(e);
      out.className = "status-line err";
      out.textContent = "✗ Leaf finder failed: " + (e && e.message ? e.message : e) + ". Tap again to retry with one CPU thread (reload the app first).";
    }).then(function () { btn.disabled = false; renderPhoneInfo(); });
  });

  // Read-only hook for automated tests and troubleshooting
  window.BLSDebug = { current: function () { return current; }, version: APP_VERSION };

  // ---------- start ----------
  $("rules-" + (settings.rules === "r1" ? "r1" : "v2")).checked = true;
  fillPlotOptions();
  updateHeader();
  renderMethod();
  updateContext();
  checkSetupHash();
  renderTeamUsers();
  // Name first: the app starts once the person has said who they are
  if (!settings.rater) openWelcome(false); else registerUser();
  showInstallCard();
  if (isInstalled()) protectStorage();
  refreshPending();
  syncPending();
  // The rating app opens on the camera panel only: no example result. New people get the
  // 3-step guide after they enter their name (see startAs); people who had a name already see it once here.
  if (settings.rater && !settings.guideSeen) openGuide();
  refreshResume();
  usagePing();
  window.addEventListener("online", usagePing);

  if ("serviceWorker" in navigator && window.isSecureContext && !inFrame) {
    try {
      navigator.serviceWorker.register("sw.js").catch(function () {});
      // The service worker adds the headers that let the leaf finder use several
      // CPU cores. They apply from the next page load, so reload once when it
      // first takes control (before the person has done anything).
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        var did = false;
        try { did = sessionStorage.getItem("bls-coi-reload") === "1"; sessionStorage.setItem("bls-coi-reload", "1"); } catch (e) { did = true; }
        if (!self.crossOriginIsolated && !did && !userActed && (!current || current.sample) && $("tracer").hidden && $("busy").hidden) location.reload();
      });
    } catch (e) { /* not available here */ }
  }
})();
