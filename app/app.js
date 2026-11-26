/* BLS Leaf Scorer: UI, capture, saving and sync. */
(function () {
  "use strict";

  var E = window.BLSEngine;
  var Records = window.BLSStore.Records;
  var Settings = window.BLSStore.Settings;
  var C = window.BLSConnectors;

  var MAX_ANALYSIS_SIDE = 2048; // matches the example images (about 2048 px tall)
  var MAX_STORED_SIDE = 1600;   // photos kept on the phone and uploaded
  var APP_VERSION = "0.4.0";
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
    if (reduceMotion) { el.textContent = to.toFixed(decimals) + suffix; return; }
    var start = performance.now(), dur = 700;
    (function step(now) {
      var t = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - t, 3);
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
    $("busy").hidden = state !== "busy";
    $("result").hidden = !(state === "result" || state === "example");
    $("savedCard").hidden = state !== "saved";
    $("errorCard").hidden = state !== "error";
    if (state === "error") $("capture").hidden = false;
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
  }

  function handleFile(blob, name, isSample, asExample, append) {
    var appending = !!(append && current);
    if (appending) $("busy").hidden = false; else analyzeState("busy");
    if (!isSample && !appending) requestGps();
    if (!appending) window.scrollTo(0, 0);
    // Let the spinner paint before the pixel loop runs
    setTimeout(function () {
      decode(blob).then(function (bmp) {
        var data = toImageData(bmp, MAX_ANALYSIS_SIDE);
        var res = E.analyze(data.data, data.width, data.height);
        $("busy").hidden = true;
        if (!res.ok) {
          if (appending) { toast("No leaf found in that photo. Try the section again."); return; }
          $("errorText").textContent = res.message;
          analyzeState("error");
          current = null;
          return;
        }
        var sec = {
          name: name, imageData: data, result: res,
          overlayData: new ImageData(E.overlay(data.data, res.mask, 0.45), data.width, data.height)
        };
        delete res.mask;
        if (appending) current.sections.push(sec);
        else current = { sections: [sec], sample: !!isSample };
        rebuildCurrent();
        if (!appending) analyzeState(asExample ? "example" : "result");
        renderResult();
        if (!asExample) buzz(25);
        if (appending) toast("Section " + current.sections.length + " added. Score updated for the whole leaf.");
      }).catch(function (e) {
        $("busy").hidden = true;
        if (appending) { toast("That photo could not be read. Try again."); return; }
        $("errorText").textContent = (e && e.message) || "The photo could not be read. Try again.";
        analyzeState("error");
      });
    }, 30);
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
    html += '<label class="add-sec" for="secInput"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Add section</label>';
    $("sections").innerHTML = html;
  }
  $("sections").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-rm]");
    if (!b || !current || current.sections.length < 2) return;
    current.sections.splice(+b.dataset.rm, 1);
    rebuildCurrent();
    renderResult();
  });

  ["camInput", "fileInput"].forEach(function (id) {
    $(id).addEventListener("change", function (ev) {
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
  $("sampleBtn").addEventListener("click", function () { loadSample(false); });

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
  }

  $("discardBtn").addEventListener("click", function () {
    current = null;
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
      rep: $("fRep").value.trim(), leaf: $("fLeaf").value.trim(), rater: $("fRater").value.trim(), notes: $("fNotes").value.trim()
    };
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
            qc: r.qc, width: r.width, height: r.height, sections: r.sections || 1
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
        // Ready for the next leaf from the same plot: keep plot, trial, rater; bump leaf no.
        $("fNotes").value = "";
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
      Sections: r.sections || 1, Edited_At: rec.editedAt || ""
    };
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
          return Promise.all([withPhotos ? blobToBase64(rec.photo) : null, withPhotos ? blobToBase64(rec.overlay) : null])
            .then(function (b) { return conn.send({ event: rec.editedAt ? "update" : "record", row: toRow(rec), photo: b[0], overlay: b[1] }, cfg); })
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
      if (recMode === "summary") renderSummary(list);

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
  });

  $("saveDefaults").addEventListener("click", function () {
    settings.trial = $("dTrial").value.trim();
    settings.rater = $("dRater").value.trim();
    settings.uploadPhotos = $("dPhotos").checked;
    Settings.save(settings);
    updateHeader();
    renderQr();
    // Carry new defaults into an open, unsaved form
    $("fTrial").value = settings.trial;
    $("fRater").value = settings.rater;
    updateContext();
    toast("Defaults saved");
  });

  // ---------- team setup link + QR ----------
  function b64url(s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  function unb64url(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); return decodeURIComponent(escape(atob(s))); }

  function setupLink() {
    var payload = { v: 1, d: settings.destination, c: settings.connectors[settings.destination] || {}, t: settings.trial, p: settings.uploadPhotos };
    return location.origin + location.pathname + "#setup-" + b64url(JSON.stringify(payload));
  }

  function renderQr() {
    var box = $("qr");
    box.innerHTML = "";
    if (window.QRCode) {
      try { new QRCode(box, { text: setupLink(), width: 116, height: 116, correctLevel: QRCode.CorrectLevel.L }); }
      catch (e) { box.innerHTML = '<span class="small">QR unavailable</span>'; }
    } else {
      box.innerHTML = '<span class="small">QR code appears when you\'re online</span>';
    }
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
      ". Only accept a link from someone you trust.</p><div style=\"display:flex;gap:8px\"><button class=\"btn btn-primary\" type=\"button\">Join team</button><button class=\"btn btn-ghost\" type=\"button\">Ignore</button></div>";
    var btns = card.querySelectorAll("button");
    btns[0].addEventListener("click", function () {
      settings.destination = conn.id;
      settings.connectors[conn.id] = cfg.c || {};
      if (cfg.t) settings.trial = cfg.t;
      if (typeof cfg.p === "boolean") settings.uploadPhotos = cfg.p;
      Settings.save(settings); updateHeader(); refreshPending(); card.remove();
      toast("Joined. Records now go to " + conn.name);
    });
    btns[1].addEventListener("click", function () { card.remove(); });
    $("view-analyze").prepend(card);
    try { history.replaceState(null, "", location.pathname); } catch (e) { /* ignore */ }
  }

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
      '<div class="row2">' + f("eTrial", "Trial", m.trial) + f("eRater", "Rater", m.rater) + "</div>" +
      '<div class="field"><label for="eNotes">Notes</label><textarea id="eNotes">' + esc(m.notes || "") + "</textarea></div></div>" +
      '<div class="sheet-actions"><button class="btn btn-primary" type="button" id="eSave">Save changes</button><button class="btn btn-ghost" type="button" id="eCancel">Cancel</button></div>';
    sheet.querySelector("#eCancel").addEventListener("click", closeSheet);
    sheet.querySelector("#eSave").addEventListener("click", function () {
      var v = function (id) { return sheet.querySelector("#" + id).value.trim(); };
      if (!v("ePlot")) { sheet.querySelector("#ePlot").focus(); toast("Plot ID is required"); return; }
      rec.meta = { plot: v("ePlot"), rep: v("eRep"), leaf: v("eLeaf"), genotype: v("eGenotype"), trial: v("eTrial"), rater: v("eRater"), notes: v("eNotes") };
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

  // ---------- start ----------
  fillPlotOptions();
  updateHeader();
  renderMethod();
  updateContext();
  checkSetupHash();
  showInstallCard();
  if (isInstalled()) protectStorage();
  refreshPending();
  syncPending();
  // Open in a working state: first-time users see the example leaf scored below the camera panel
  Records.all().then(function (all) { if (!all.length && !current) loadSample(true); });

  if ("serviceWorker" in navigator && window.isSecureContext && !inFrame) {
    try { navigator.serviceWorker.register("sw.js").catch(function () {}); } catch (e) { /* not available here */ }
  }
})();
