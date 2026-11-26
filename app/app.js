/* BLS Leaf Scorer: UI, capture, saving and sync. */
(function () {
  "use strict";

  var E = window.BLSEngine;
  var Records = window.BLSStore.Records;
  var Settings = window.BLSStore.Settings;
  var C = window.BLSConnectors;

  var MAX_ANALYSIS_SIDE = 2048; // matches the example images (about 2048 px tall)
  var MAX_STORED_SIDE = 1600;   // photos kept on the phone and uploaded
  var APP_VERSION = "0.1.0";

  var $ = function (id) { return document.getElementById(id); };
  var settings = Settings.load();
  var current = null;   // { name, imageData, result, overlayData, sample }
  var gps = null;
  var syncing = false;

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

  // ---------- tabs ----------
  function showTab(name) {
    ["analyze", "records", "settings"].forEach(function (t) {
      $("view-" + t).hidden = t !== name;
    });
    document.querySelectorAll(".tab").forEach(function (b) {
      if (b.dataset.tab === name) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    if (name === "records") renderRecords();
    if (name === "settings") renderSettings();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll(".tab").forEach(function (b) {
    b.addEventListener("click", function () { showTab(b.dataset.tab); });
  });
  $("syncPill").addEventListener("click", function () { showTab("records"); });

  // ---------- image loading ----------
  function decode(blob) {
    if (window.createImageBitmap) {
      // Respect EXIF rotation so the preview looks right. Pixel counts do not
      // depend on orientation, so scores still match the R pipeline.
      return createImageBitmap(blob, { imageOrientation: "from-image" }).catch(function () {
        return createImageBitmap(blob);
      });
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

  function handleFile(blob, name, isSample) {
    $("busy").hidden = false;
    $("errorCard").hidden = true;
    $("result").hidden = true;
    if (!isSample) requestGps();
    // Let the spinner paint before the pixel loop runs
    setTimeout(function () {
      decode(blob).then(function (bmp) {
        var data = toImageData(bmp, MAX_ANALYSIS_SIDE);
        var res = E.analyze(data.data, data.width, data.height);
        $("busy").hidden = true;
        if (!res.ok) {
          $("errorText").textContent = res.message;
          $("errorCard").hidden = false;
          current = null;
          return;
        }
        current = {
          name: name, imageData: data, result: res, sample: !!isSample,
          overlayData: new ImageData(E.overlay(data.data, res.mask, 0.45), data.width, data.height)
        };
        renderResult();
      }).catch(function (e) {
        $("busy").hidden = true;
        $("errorText").textContent = e.message || "The photo could not be read. Try again.";
        $("errorCard").hidden = false;
      });
    }, 30);
  }

  ["camInput", "fileInput"].forEach(function (id) {
    $(id).addEventListener("change", function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (f) handleFile(f, f.name || ("leaf-" + Date.now() + ".jpg"), false);
      ev.target.value = "";
    });
  });

  function loadSample() {
    return fetch("samples/BLS_02.jpg")
      .then(function (r) { if (!r.ok) throw new Error(); return r.blob(); })
      .then(function (b) { handleFile(b, "BLS_02.jpg", true); })
      .catch(function () { toast("The example leaf could not be loaded."); });
  }
  $("sampleBtn").addEventListener("click", loadSample);

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
    var canvas = $("leafCanvas");
    var frame = $("leafFrame");
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
      document.querySelectorAll(".seg button").forEach(function (x) {
        x.setAttribute("aria-pressed", String(x === b));
      });
      drawLeaf();
    });
  });

  function buildScale(active) {
    var bar = $("scaleBar"), ticks = $("scaleTicks");
    var limits = ["≤0.5", "2", "6", "12", "25", "40", "60", "75", ">75"];
    bar.innerHTML = ""; ticks.innerHTML = "";
    for (var s = 1; s <= 9; s++) {
      var d = document.createElement("div");
      d.style.background = scoreColor(s);
      d.textContent = s;
      if (s === active) d.className = "on";
      bar.appendChild(d);
      var t = document.createElement("span");
      t.textContent = limits[s - 1];
      ticks.appendChild(t);
    }
  }

  function renderResult() {
    var r = current.result;
    $("result").hidden = false;
    $("scoreNum").textContent = r.score;
    $("scoreBadge").style.background = scoreColor(r.score);
    $("diseasedPct").textContent = fmtPct(r.diseasedPct);
    $("catText").textContent = r.category;
    $("catChip").querySelector(".sw").style.background = scoreColor(r.score);
    $("resultSource").textContent = current.sample ? "Example leaf · " + current.name : current.name;
    var warn = r.qc !== "PASS" ? "Quality check: " + r.qc + ". Pixel classes do not add up; retake the photo." : "";
    if (!warn && r.leafPixels < 20000) warn = "The leaf covers only a small part of the photo. Move closer so the leaf fills the frame.";
    $("qcWarn").textContent = warn;
    $("qcWarn").hidden = !warn;
    buildScale(r.score);
    $("tissue").innerHTML = [
      ["Healthy", r.healthyPct, "var(--healthy)"],
      ["Chlorotic", r.chloroticPct, "var(--chlorotic)"],
      ["Necrotic", r.necroticPct, "var(--necrotic)"]
    ].map(function (t) {
      return '<div class="tissue-row"><span class="name"><span class="chip" style="padding:0;background:none"><span class="sw" style="background:' + t[2] + '"></span></span>' + t[0] + '</span>' +
        '<span class="bar"><i style="width:' + Math.min(100, t[1]) + '%;background:' + t[2] + '"></i></span>' +
        '<span class="val num">' + fmtPct(t[1]) + '</span></div>';
    }).join("");
    drawLeaf();
    // Fill remembered defaults
    if (!$("fTrial").value) $("fTrial").value = settings.trial || "";
    if (!$("fRater").value) $("fRater").value = settings.rater || "";
    if (current.sample && !$("fPlot").value) $("fPlot").value = "EXAMPLE-BLS_02";
  }

  $("discardBtn").addEventListener("click", function () {
    current = null;
    $("result").hidden = true;
    window.scrollTo(0, 0);
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
      trial: $("fTrial").value.trim(),
      plot: $("fPlot").value.trim(),
      genotype: $("fGenotype").value.trim(),
      rep: $("fRep").value.trim(),
      leaf: $("fLeaf").value.trim(),
      rater: $("fRater").value.trim(),
      notes: $("fNotes").value.trim()
    };
    // Remember trial and rater for the next leaf
    settings.trial = meta.trial; settings.rater = meta.rater;
    Settings.save(settings); updateHeader();

    Promise.all([canvasBlob(current.imageData, MAX_STORED_SIDE), canvasBlob(current.overlayData, MAX_STORED_SIDE)])
      .then(function (blobs) {
        var dest = settings.destination;
        var rec = {
          id: uid(),
          createdAt: new Date().toISOString(),
          imageName: current.name,
          meta: meta,
          gps: $("fGps").checked ? gps : null,
          result: {
            leafPixels: r.leafPixels, healthyPixels: r.healthyPixels, chloroticPixels: r.chloroticPixels,
            necroticPixels: r.necroticPixels, healthyPct: r.healthyPct, chloroticPct: r.chloroticPct,
            necroticPct: r.necroticPct, diseasedPct: r.diseasedPct, score: r.score, category: r.category,
            qc: r.qc, width: r.width, height: r.height
          },
          engine: E.VERSION,
          photo: blobs[0],
          overlay: blobs[1],
          sync: dest === "local" ? "local" : "pending",
          syncError: null,
          remote: {}
        };
        return Records.put(rec);
      })
      .then(function () {
        toast(settings.destination === "local" ? "Saved on this phone" : "Saved. Syncing to " + C.get(settings.destination).name + "…");
        // Ready for the next leaf from the same plot: keep plot, trial, rater; bump leaf no.
        $("fNotes").value = "";
        if ($("fLeaf").value) $("fLeaf").value = String((+$("fLeaf").value || 0) + 1);
        current = null;
        $("result").hidden = true;
        window.scrollTo(0, 0);
        refreshPending();
        syncPending();
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
      Photo_URL: (rec.remote && rec.remote.photoUrl) || "", Overlay_URL: (rec.remote && rec.remote.overlayUrl) || ""
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
      var queue = all.filter(function (r) { return r.sync === "pending" || r.sync === "error" || r.sync === "local"; }).reverse();
      var chain = Promise.resolve();
      queue.forEach(function (rec) {
        chain = chain.then(function () {
          var withPhotos = settings.uploadPhotos;
          return Promise.all([withPhotos ? blobToBase64(rec.photo) : null, withPhotos ? blobToBase64(rec.overlay) : null])
            .then(function (b) { return conn.send({ row: toRow(rec), photo: b[0], overlay: b[1] }, cfg); })
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

  function setPill(state, text) {
    $("syncPill").dataset.state = state;
    $("syncText").textContent = text;
  }

  function refreshPending() {
    return Records.all().then(function (all) {
      var dest = settings.destination;
      var unsynced = dest === "local" ? 0 : all.filter(function (r) { return r.sync !== "synced"; }).length;
      var errors = all.some(function (r) { return r.sync === "error"; });
      $("pendingBadge").hidden = !unsynced;
      $("pendingBadge").textContent = unsynced;
      if (syncing) return;
      if (dest === "local") setPill("ok", "This phone");
      else if (!unsynced) setPill("ok", "All synced");
      else if (navigator.onLine === false) setPill("pending", unsynced + " waiting · offline");
      else setPill(errors ? "error" : "pending", unsynced + " to sync");
    });
  }

  function updateHeader() {
    $("trialLabel").textContent = settings.trial ? "Trial · " + settings.trial : "No trial set";
  }

  // ---------- records view ----------
  var thumbUrls = [];

  function renderRecords() {
    return Records.all().then(function (all) {
      var sel = $("trialFilter");
      var trials = Array.from(new Set(all.map(function (r) { return r.meta.trial; }).filter(Boolean))).sort();
      var keep = sel.value;
      sel.innerHTML = '<option value="">All trials</option>' + trials.map(function (t) {
        return '<option' + (t === keep ? " selected" : "") + ">" + esc(t) + "</option>";
      }).join("");
      var list = keep ? all.filter(function (r) { return r.meta.trial === keep; }) : all;

      // stats
      var n = list.length;
      $("stN").textContent = n;
      $("stMean").textContent = n ? (list.reduce(function (a, r) { return a + r.result.score; }, 0) / n).toFixed(1) : "–";
      $("stDis").textContent = n ? fmtPct(list.reduce(function (a, r) { return a + r.result.diseasedPct; }, 0) / n) : "–";
      var counts = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      list.forEach(function (r) { counts[r.result.score - 1]++; });
      var maxC = Math.max.apply(null, counts.concat([1]));
      $("hist").innerHTML = counts.map(function (c, i) {
        return '<div title="Score ' + (i + 1) + ": " + c + ' leaves"><span class="num">' + (c || "") + '</span><i style="height:' + (c / maxC * 60) + 'px;background:' + scoreColor(i + 1) + '"></i><span>' + (i + 1) + "</span></div>";
      }).join("");

      // list
      thumbUrls.forEach(URL.revokeObjectURL); thumbUrls = [];
      $("recEmpty").hidden = n > 0;
      $("recList").innerHTML = list.map(function (r) {
        var url = r.overlay ? URL.createObjectURL(r.overlay) : "";
        if (url) thumbUrls.push(url);
        var title = r.meta.plot || r.imageName;
        var sub = [r.meta.genotype, r.meta.rep && "Rep " + r.meta.rep, r.meta.leaf && "Leaf " + r.meta.leaf].filter(Boolean).join(" · ");
        var when = new Date(r.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
        var syncLabel = { synced: "Synced", pending: "Waiting", error: "Sync failed", local: "On phone" }[r.sync] || r.sync;
        return '<li class="rec" data-id="' + esc(r.id) + '">' +
          '<span class="thumb" style="background-image:url(' + url + ')"></span>' +
          '<span class="meta"><b>' + esc(title) + '</b><span class="small muted">' + esc(sub || r.meta.trial || "") + '</span>' +
          '<span class="small muted num" style="display:block">' + esc(when) + " · " + fmtPct(r.result.diseasedPct) + " diseased</span>" +
          (r.sync === "error" ? '<span class="small" style="color:var(--necrotic);display:block">' + esc(r.syncError) + "</span>" : "") +
          '</span><span class="right"><span class="mini-score num" style="background:' + scoreColor(r.result.score) + '">' + r.result.score + "</span>" +
          '<span class="sync-tag" data-s="' + esc(r.sync) + '">' + esc(syncLabel) + "</span>" +
          '<button class="sync-tag" type="button" data-del="' + esc(r.id) + '" style="background:none;border:0;padding:0;cursor:pointer;text-decoration:underline">Delete</button></span></li>';
      }).join("");
    });
  }
  $("trialFilter").addEventListener("change", renderRecords);

  // Two-tap delete (the browser confirm() dialog is not available everywhere)
  $("recList").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-del]");
    if (!b) return;
    if (b.dataset.armed) {
      Records.remove(b.dataset.del).then(function () { toast("Record deleted from this phone"); renderRecords(); refreshPending(); });
    } else {
      b.dataset.armed = "1"; b.textContent = "Tap to confirm"; b.style.color = "var(--necrotic)";
      setTimeout(function () { if (b.isConnected) { delete b.dataset.armed; b.textContent = "Delete"; b.style.color = ""; } }, 3000);
    }
  });

  $("exportCsv").addEventListener("click", function () {
    Records.all().then(function (all) {
      var trial = $("trialFilter").value;
      var list = (trial ? all.filter(function (r) { return r.meta.trial === trial; }) : all).slice().reverse();
      if (!list.length) { toast("No records to export yet"); return; }
      var lines = [C.COLUMNS.join(",")].concat(list.map(function (rec) {
        var row = toRow(rec);
        return C.COLUMNS.map(function (k) { return csvCell(row[k]); }).join(",");
      }));
      var name = "BLS_results_" + (trial ? trial.replace(/[^\w-]+/g, "_") + "_" : "") + new Date().toISOString().slice(0, 10) + ".csv";
      var blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv" });
      var file = null;
      try { file = new File([blob], name, { type: "text/csv" }); } catch (e) { file = null; }
      // On phones, the share sheet lets people send the file to Drive, email, WhatsApp…
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: name }).catch(function () {});
        return;
      }
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      toast("Exported " + list.length + " records");
    });
  });

  $("syncNow").addEventListener("click", function () {
    if (settings.destination === "local") { toast("Choose a storage destination in Settings first"); showTab("settings"); return; }
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
    var conn = C.get(pickedDest);
    status("Testing…", true);
    conn.test(readDestFields()).then(function (m) { status(m, true); }, function (e) { status(e.message, false); });
  });

  $("saveDest").addEventListener("click", function () {
    var before = settings.destination;
    settings.destination = pickedDest;
    settings.connectors[pickedDest] = readDestFields();
    settings.trial = $("dTrial").value.trim();
    settings.rater = $("dRater").value.trim();
    settings.uploadPhotos = $("dPhotos").checked;
    Settings.save(settings);
    updateHeader();
    renderQr();
    // Carry new defaults into an open, unsaved form
    if (settings.trial && !$("fTrial").value) $("fTrial").value = settings.trial;
    if (settings.rater && !$("fRater").value) $("fRater").value = settings.rater;
    status("Saved. New records go to " + C.get(pickedDest).name + ".", true);
    refreshPending().then(function () { if (before !== pickedDest || pickedDest !== "local") syncPending(); });
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
      catch (e) { box.textContent = "QR unavailable"; }
    } else {
      box.innerHTML = '<span class="small" style="color:#333">QR needs a connection</span>';
    }
  }

  $("copySetup").addEventListener("click", function () {
    var link = setupLink();
    var done = function () { $("copyNote").textContent = "Link copied. Send it to your team."; };
    try {
      navigator.clipboard.writeText(link).then(done, function () { $("copyNote").textContent = link; });
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
    card.className = "card";
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

  // ---------- method table ----------
  function renderMethod() {
    $("engVer").textContent = E.VERSION;
    var lo = 0;
    $("scaleTable").innerHTML = E.SCALE.concat([[100, 9]]).map(function (row) {
      var range = row[1] === 1 ? "0–0.5%" : row[1] === 9 ? ">75%" : ">" + lo + "–" + row[0] + "%";
      lo = row[0];
      return '<tr><td><span class="mini-score num" style="width:26px;height:26px;font-size:14px;background:' + scoreColor(row[1]) + '">' + row[1] + "</span></td><td class=\"num\">" + range + "</td><td>" + E.category(row[1]) + "</td></tr>";
    }).join("");
  }

  // ---------- start ----------
  updateHeader();
  renderMethod();
  checkSetupHash();
  refreshPending();
  syncPending();
  // Open in a working state: first-time users see the example leaf scored
  Records.all().then(function (all) { if (!all.length && !current) loadSample(); });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    try { navigator.serviceWorker.register("sw.js").catch(function () {}); } catch (e) { /* not available here */ }
  }
})();
