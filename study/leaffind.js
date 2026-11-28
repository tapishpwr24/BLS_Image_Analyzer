/*
 * Leaf finding on any uniform background (board of any colour, white paper, bench).
 * JavaScript port of python/bls_analyzer/segment.py so the app and the Python
 * analyzer separate the leaf the same way:
 *   1. Background colour = median of the photo's outer border (CIELAB).
 *   2. Colour distance of every pixel from it (lightness down-weighted, so
 *      shadows on the board are not taken for leaf).
 *   3. Otsu threshold on that distance (never closer than 12 Lab units).
 *   4. Glare removed (near-colourless and brighter than the board).
 *   5. Opening / closing, then only leaf-shaped pieces are kept: labels, tags
 *      and tape are compact and get dropped. If no piece is leaf-shaped the
 *      largest is kept, so a short leaf section still scores.
 *   6. Small holes filled (pale midrib, lesions), large enclosed background not.
 * Returns { mask: null } when the border is not one colour (field photos): the
 * app then uses the AI leaf finder, as the Python analyzer does.
 */
(function () {
  "use strict";

  var P = {
    L_WEIGHT: 0.5, MIN_THRESHOLD: 12, UNIFORM_TOL: 12, UNIFORM_MIN: 0.60,
    GLARE_MAX_CHROMA: 8, GLARE_MIN_DL: 10, MIN_ELONGATION: 3.0,
    // the result is trusted without the AI leaf finder only when the border is
    // clearly one colour and the leaf is clearly leaf-shaped (batch.py BOARD_SURE)
    SURE_UNIFORM: 0.70, SURE_ELONGATION: 2.5, HOLE_MAX_FRAC: 0.01
  };

  function lab(rgba, n) {
    var L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    var lut = new Float32Array(256);
    for (var v = 0; v < 256; v++) { var c = v / 255; lut[v] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    var f = function (t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; };
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var r = lut[rgba[p]], g = lut[rgba[p + 1]], b = lut[rgba[p + 2]];
      var x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
      var y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      var z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
      var fx = f(x), fy = f(y), fz = f(z);
      L[i] = 116 * fy - 16; A[i] = 500 * (fx - fy); B[i] = 200 * (fy - fz);
    }
    return { L: L, A: A, B: B };
  }

  function borderIndex(W, H, band) {
    var idx = [];
    for (var y = 0; y < H; y++) {
      var inBandRow = y < band || y >= H - band;
      for (var x = 0; x < W; x++) if (inBandRow || x < band || x >= W - band) idx.push(y * W + x);
    }
    return idx;
  }
  function median(arr) {
    var s = Float32Array.from(arr).sort(), n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  function otsu(vals, lo, hi, bins) {
    var hist = new Float64Array(bins), w = (hi - lo) / bins;
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i] < lo ? lo : vals[i] > hi ? hi : vals[i];
      var k = Math.min(bins - 1, Math.floor((v - lo) / w));
      hist[k]++;
    }
    var total = 0, sumAll = 0;
    for (k = 0; k < bins; k++) { total += hist[k]; sumAll += hist[k] * (lo + (k + 0.5) * w); }
    var w0 = 0, m0 = 0, best = -1, at = 0;
    for (k = 0; k < bins; k++) {
      var c = lo + (k + 0.5) * w;
      w0 += hist[k]; m0 += hist[k] * c;
      var w1 = total - w0;
      var mu0 = m0 / Math.max(w0, 1), mu1 = (sumAll - m0) / Math.max(w1, 1);
      var between = w0 * w1 * (mu0 - mu1) * (mu0 - mu1);
      if (between > best) { best = between; at = c; }
    }
    return at;
  }

  // 4-connected morphology; outside the photo counts as background (as scipy)
  function erode(m, W, H, it) {
    for (var t = 0; t < it; t++) {
      var o = new Uint8Array(m.length);
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var i = y * W + x;
        o[i] = m[i] && x > 0 && m[i - 1] && x < W - 1 && m[i + 1] && y > 0 && m[i - W] && y < H - 1 && m[i + W] ? 1 : 0;
      }
      m = o;
    }
    return m;
  }
  function dilate(m, W, H, it) {
    for (var t = 0; t < it; t++) {
      var o = new Uint8Array(m.length);
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var i = y * W + x;
        o[i] = m[i] || (x > 0 && m[i - 1]) || (x < W - 1 && m[i + 1]) || (y > 0 && m[i - W]) || (y < H - 1 && m[i + W]) ? 1 : 0;
      }
      m = o;
    }
    return m;
  }
  function label(m, W, H) {
    var n = m.length, ids = new Int32Array(n), stack = new Int32Array(n), sizes = [0], k = 0;
    for (var s0 = 0; s0 < n; s0++) {
      if (!m[s0] || ids[s0]) continue;
      k++; var size = 0, sp = 0; stack[sp++] = s0; ids[s0] = k;
      while (sp) {
        var i = stack[--sp], x = i % W; size++;
        if (x > 0 && m[i - 1] && !ids[i - 1]) { ids[i - 1] = k; stack[sp++] = i - 1; }
        if (x < W - 1 && m[i + 1] && !ids[i + 1]) { ids[i + 1] = k; stack[sp++] = i + 1; }
        if (i >= W && m[i - W] && !ids[i - W]) { ids[i - W] = k; stack[sp++] = i - W; }
        if (i < n - W && m[i + W] && !ids[i + W]) { ids[i + W] = k; stack[sp++] = i + W; }
      }
      sizes.push(size);
    }
    return { ids: ids, n: k, sizes: sizes };
  }
  // length / width of each piece from the second moments of its pixel coordinates
  function elongations(ids, n, W) {
    var c = new Float64Array(n + 1), sx = new Float64Array(n + 1), sy = new Float64Array(n + 1),
      sxx = new Float64Array(n + 1), syy = new Float64Array(n + 1), sxy = new Float64Array(n + 1);
    for (var i = 0; i < ids.length; i++) {
      var k = ids[i]; if (!k) continue;
      var x = i % W, y = (i - x) / W;
      c[k]++; sx[k] += x; sy[k] += y; sxx[k] += x * x; syy[k] += y * y; sxy[k] += x * y;
    }
    var out = new Float64Array(n + 1);
    for (k = 1; k <= n; k++) {
      if (c[k] < 10) { out[k] = 0; continue; }
      var mx = sx[k] / c[k], my = sy[k] / c[k];
      var a = syy[k] / c[k] - my * my, d = sxx[k] / c[k] - mx * mx, b = sxy[k] / c[k] - mx * my;
      var tr = (a + d) / 2, disc = Math.sqrt(Math.max(0, (a - d) * (a - d) / 4 + b * b));
      var l1 = tr + disc, l2 = tr - disc;
      out[k] = Math.sqrt(l1 / Math.max(l2, 1e-9));
    }
    return out;
  }
  // Fill holes inside the leaf (lesions, pale midrib) but not large background
  // areas enclosed by several leaves or stems
  function fillSmallHoles(m, W, H, maxFrac) {
    var n = m.length, outside = new Uint8Array(n), stack = new Int32Array(n), sp = 0;
    var push = function (i) { if (!m[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; } };
    for (var x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (var y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (sp) {
      var i = stack[--sp], xx = i % W;
      if (xx > 0) push(i - 1);
      if (xx < W - 1) push(i + 1);
      if (i >= W) push(i - W);
      if (i < n - W) push(i + W);
    }
    var holes = new Uint8Array(n);
    for (i = 0; i < n; i++) holes[i] = !m[i] && !outside[i] ? 1 : 0;
    var hl = label(holes, W, H), lim = maxFrac * n, out = new Uint8Array(m);
    for (i = 0; i < n; i++) if (hl.ids[i] && hl.sizes[hl.ids[i]] <= lim) out[i] = 1;
    return out;
  }

  function segment(rgba, W, H) {
    var n = W * H, info = {};
    var band = Math.max(2, Math.round(Math.min(H, W) * 0.03));
    var c = lab(rgba, n);
    var bidx = borderIndex(W, H, band), nb = bidx.length;
    var bL = new Float32Array(nb), bA = new Float32Array(nb), bB = new Float32Array(nb);
    for (var j = 0; j < nb; j++) { bL[j] = c.L[bidx[j]]; bA[j] = c.A[bidx[j]]; bB[j] = c.B[bidx[j]]; }
    var bg = [median(bL), median(bA), median(bB)];
    var wL = P.L_WEIGHT, dist = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var dl = (c.L[i] - bg[0]) * wL, da = c.A[i] - bg[1], db = c.B[i] - bg[2];
      dist[i] = Math.sqrt(dl * dl + da * da + db * db);
    }
    var match = 0;
    for (j = 0; j < nb; j++) if (dist[bidx[j]] < P.UNIFORM_TOL) match++;
    var uniform = match / nb;
    info.bgL = Math.round(bg[0] * 10) / 10;
    info.borderUniform = Math.round(uniform * 1000) / 1000;
    if (uniform < P.UNIFORM_MIN) { info.background = "field / mixed"; return { mask: null, info: info }; }
    info.background = bg[0] >= 75 ? "light (paper)" : bg[0] >= 25 ? "grey board" : "dark board";

    var thr = Math.max(otsu(dist, 0, 100, 256), P.MIN_THRESHOLD);
    info.threshold = Math.round(thr * 10) / 10;
    var m = new Uint8Array(n), glare = 0;
    for (i = 0; i < n; i++) {
      var chroma = Math.sqrt(c.A[i] * c.A[i] + c.B[i] * c.B[i]);
      var isGlare = chroma < P.GLARE_MAX_CHROMA && c.L[i] > bg[0] + P.GLARE_MIN_DL;
      if (isGlare) glare++;
      m[i] = dist[i] > thr && !isGlare ? 1 : 0;
    }
    info.glarePct = Math.round(glare / n * 1000) / 10;

    m = dilate(erode(m, W, H, 2), W, H, 2);   // opening: specks and dust
    m = erode(dilate(m, W, H, 3), W, H, 3);   // closing: bridge small gaps

    var lb = label(m, W, H);
    if (!lb.n) { info.components = 0; return { mask: null, info: info, empty: true }; }
    var maxSize = 0, largest = 1;
    for (var k = 1; k <= lb.n; k++) if (lb.sizes[k] > maxSize) { maxSize = lb.sizes[k]; largest = k; }
    var keepMin = Math.max(0.10 * maxSize, 0.001 * n);
    var keep = new Uint8Array(lb.n + 1);
    for (k = 1; k <= lb.n; k++) keep[k] = lb.sizes[k] >= keepMin ? 1 : 0;
    var el = elongations(lb.ids, lb.n, W), leafy = 0;
    for (k = 1; k <= lb.n; k++) if (keep[k] && el[k] >= P.MIN_ELONGATION) leafy++;
    var dropped = 0;
    for (k = 1; k <= lb.n; k++) {
      if (!keep[k]) continue;
      if ((leafy && el[k] < P.MIN_ELONGATION) || (!leafy && k !== largest)) { keep[k] = 0; dropped++; }
    }
    info.compactDropped = dropped;
    info.largestElongation = Math.round(el[largest] * 10) / 10;
    for (i = 0; i < n; i++) m[i] = keep[lb.ids[i]];
    m = fillSmallHoles(m, W, H, P.HOLE_MAX_FRAC);

    var leaves = label(m, W, H), area = 0;
    for (i = 0; i < n; i++) area += m[i];
    info.components = leaves.n;
    info.leafFrac = Math.round(area / n * 1000) / 10;
    var confident = uniform >= P.SURE_UNIFORM && info.largestElongation >= P.SURE_ELONGATION && area > 0;
    return { mask: m, labels: leaves.ids, leafCount: leaves.n, info: info, confident: confident };
  }

  window.BLSLeafFind = { segment: segment, params: P };
})();
