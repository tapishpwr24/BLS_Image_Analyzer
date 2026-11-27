/*
 * BLS Image Analyzer: JavaScript port of the scoring engine in
 * BLS_Image_Analyzer.R (sections 0, 4, 5, 6 and the QC rule).
 *
 * Works in the browser (window.BLSEngine) and in Node (require).
 * Input: RGBA pixel data (Uint8ClampedArray, as from canvas getImageData).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BLSEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var VERSION = "1.1.0";

  // Section 0 of the R script. Do not change unless recalibrating.
  var PARAMS = {
    LEAF_RGB_SUM_THRESHOLD: 0.20,
    NECROTIC_H_MIN: 0.02,
    NECROTIC_H_MAX: 0.10,
    NECROTIC_S_MIN: 0.15,
    NECROTIC_V_MIN: 0.10,
    NECROTIC_V_MAX: 0.50,
    CHLOROTIC_H_MIN: 0.10,
    CHLOROTIC_H_MAX: 0.24,
    CHLOROTIC_V_MIN: 0.28,
    MIN_LEAF_PIXELS: 100,
    // R-compatibility. The R script calls rgb2hsv() on values already scaled
    // to 0-1, but rgb2hsv() defaults to maxColorValue = 255, so R's V is
    // (max channel) / 255. As a result the V-based necrotic rule and both
    // chlorotic rules never fire in R, and necrotic = R>G>B with S >= 0.12.
    // 255 reproduces the published R results exactly; 1 is the documented
    // method (thresholds then need recalibrating).
    V_DIVISOR: 255
  };

  /*
   * Rule sets.
   *  "v2" (default): calibrated on real phone photos of BLS-affected leaves,
   *       by hue on the correct 0-1 brightness scale:
   *         necrotic  = tan / brown / straw / dark dead tissue (hue < 48 deg)
   *         chlorotic = yellow (48-68 deg, saturation >= 0.30)
   *         healthy   = green (hue >= 68 deg) and whitish flecks / glare
   *  "r1": BLS_Image_Analyzer.R v1.0 exactly (reproduces published results).
   */
  var RULES_V2 = { NEC_HUE: 48 / 360, CHL_HUE: 68 / 360, MIN_SAT: 0.15, CHL_MIN_SAT: 0.30, DARK_V: 0.22 };

  // Pixel classes written to the mask
  var BG = 0, HEALTHY = 1, CHLOROTIC = 2, NECROTIC = 3;

  // Section 4: diseased % -> 1-9 rating
  var SCALE = [
    [0.5, 1], [2, 2], [6, 3], [12, 4], [25, 5], [40, 6], [60, 7], [75, 8]
  ];

  function blsScore(diseasedPct) {
    for (var i = 0; i < SCALE.length; i++) {
      if (diseasedPct <= SCALE[i][0]) return SCALE[i][1];
    }
    return 9;
  }

  // Section 5: rating -> disease-response category
  function category(score) {
    if (score == null || isNaN(score)) return null;
    if (score < 3) return "Resistant";
    if (score < 5) return "Moderately Resistant";
    if (score < 7) return "Moderately Susceptible";
    return "Highly Susceptible";
  }

  function round2(x) {
    return Math.round(x * 100) / 100;
  }

  /*
   * Section 6: classify every pixel.
   * Mirrors R's rgb2hsv(): v = max, s = (max-min)/max, h in [0,1).
   */
  function analyze(rgba, width, height, params, roi, rules) {
    var v2 = rules !== "r1";
    // roi (optional): Uint8Array, 1 = inside the outline the user traced.
    // Only those pixels can count as leaf (field photos without a black board).
    var P = params || PARAMS;
    var n = width * height;
    var mask = new Uint8Array(n);
    var nLeaf = 0, nHealthy = 0, nChl = 0, nNec = 0;

    for (var i = 0, p = 0; i < n; i++, p += 4) {
      if (roi && !roi[i]) continue;
      var r = rgba[p] / 255, g = rgba[p + 1] / 255, b = rgba[p + 2] / 255;

      // Background: outside the leaf region, or (R rules, no region) near-black
      if (!roi && !(r + g + b > P.LEAF_RGB_SUM_THRESHOLD)) continue;
      if (roi && !v2 && !(r + g + b > P.LEAF_RGB_SUM_THRESHOLD)) continue;
      nLeaf++;

      var max = r > g ? (r > b ? r : b) : (g > b ? g : b);
      var min = r < g ? (r < b ? r : b) : (g < b ? g : b);
      var delta = max - min;
      var v = v2 ? max : max / P.V_DIVISOR;
      var s = max > 0 ? delta / max : 0;
      var h = 0;
      if (delta > 0) {
        if (max === r) h = (g - b) / delta;
        else if (max === g) h = 2 + (b - r) / delta;
        else h = 4 + (r - g) / delta;
        h /= 6;
        if (h < 0) h += 1;
      }

      if (v2) {
        var R2 = RULES_V2;
        if (v < R2.DARK_V || (s >= R2.MIN_SAT && (h < R2.NEC_HUE || h > 330 / 360))) { mask[i] = NECROTIC; nNec++; }
        else if (s >= R2.CHL_MIN_SAT && h < R2.CHL_HUE) { mask[i] = CHLOROTIC; nChl++; }
        else { mask[i] = HEALTHY; nHealthy++; }
        continue;
      }

      var necrotic =
        (h >= P.NECROTIC_H_MIN && h <= P.NECROTIC_H_MAX &&
          s >= P.NECROTIC_S_MIN && v >= P.NECROTIC_V_MIN && v <= P.NECROTIC_V_MAX) ||
        (r > g && g > b && s >= 0.12 && v <= 0.55);

      if (necrotic) { mask[i] = NECROTIC; nNec++; continue; }

      var chlorotic =
        (h >= P.CHLOROTIC_H_MIN && h <= P.CHLOROTIC_H_MAX && v >= P.CHLOROTIC_V_MIN) ||
        (r >= g * 0.90 && g > b * 1.03 && v >= 0.30 && s >= 0.04);

      if (chlorotic) { mask[i] = CHLOROTIC; nChl++; continue; }

      mask[i] = HEALTHY; nHealthy++;
    }

    if (nLeaf < P.MIN_LEAF_PIXELS) {
      return {
        ok: false,
        qc: "FAILED",
        message: roi
          ? "The outline is too small or covers only dark pixels. Trace around the whole leaf."
          : "No leaf found. Photograph the leaf flat on a black background, or switch to Field photo and outline the leaf.",
        width: width, height: height, leafPixels: nLeaf
      };
    }

    var out = summarize(nLeaf, nHealthy, nChl, nNec);
    out.width = width;
    out.height = height;
    out.mask = mask;
    out.rules = v2 ? "v2" : "r1";
    return out;
  }

  // Per-leaf results when one photo holds several leaves (labels: 0 = background, 1..n)
  function perRegion(mask, labels, n) {
    var c = [];
    for (var k = 0; k <= n; k++) c.push([0, 0, 0, 0]);
    for (var i = 0; i < mask.length; i++) if (labels[i] && mask[i]) c[labels[i]][mask[i]]++;
    var out = [];
    for (var j = 1; j <= n; j++) {
      var t = c[j], leaf = t[1] + t[2] + t[3];
      if (leaf) out.push(summarize(leaf, t[1], t[2], t[3]));
    }
    return out;
  }

  /*
   * Leaf separation for photos on a black board / dark cloth.
   * Real photos show the "black" board as dark grey with texture, dust,
   * labels and tape, so brightness alone fails. Leaves are separated by
   * colour (saturated green / yellow / brown) and cleaned up; several leaves
   * in one photo are kept and labelled separately.
   * boardLike = false means the background is not a board (field photo).
   */
  function boardMask(rgba, W, H) {
    var n = W * H;
    var plant = new Uint8Array(n), hs = new Float32Array(n), vs = new Float32Array(n);
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var r = rgba[p] / 255, g = rgba[p + 1] / 255, b = rgba[p + 2] / 255;
      var max = r > g ? (r > b ? r : b) : (g > b ? g : b);
      var min = r < g ? (r < b ? r : b) : (g < b ? g : b);
      var d = max - min, s = max > 0 ? d / max : 0, h = 0;
      if (d > 0) {
        if (max === r) h = (g - b) / d; else if (max === g) h = 2 + (b - r) / d; else h = 4 + (r - g) / d;
        h /= 6; if (h < 0) h += 1;
      }
      hs[i] = s; vs[i] = max;
      plant[i] = (max > 0.22 && s > 0.18 && (h < 0.55 || h > 0.95)) ? 1 : 0;
    }
    var m = dilate(erode(plant, W, H, 2), W, H, 2);          // opening: remove dust and specks
    var lab = label(m, W, H);
    var keep = new Uint8Array(lab.n + 1);
    for (var k = 1; k <= lab.n; k++) keep[k] = lab.sizes[k] >= 0.004 * n ? 1 : 0;
    for (i = 0; i < n; i++) m[i] = keep[lab.ids[i]];
    m = erode(dilate(m, W, H, 3), W, H, 3);                   // closing: smooth leaf edges
    m = fillHoles(m, W, H);                                    // lesions inside the leaf stay leaf
    var area = 0, bg = 0, darkGrey = 0;
    for (i = 0; i < n; i++) {
      if (m[i]) { area++; continue; }
      bg++;
      var sv = hs[i], vv = vs[i];
      if ((vv < 0.4 && sv < 0.45) || (sv < 0.15 && vv < 0.75)) darkGrey++;
    }
    var leaves = label(m, W, H);
    var frac = area / n, dark = bg ? darkGrey / bg : 0;
    return {
      roi: m, labels: leaves.ids, leafCount: leaves.n, area: frac, darkFraction: dark,
      boardLike: dark >= 0.85 && frac >= 0.01 && frac <= 0.55
    };
  }

  // 4-connected binary morphology and labelling (plain loops, fast enough for 3 MP)
  function erode(m, W, H, it) {
    for (var t = 0; t < it; t++) {
      var o = new Uint8Array(m.length);
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var i = y * W + x;
        o[i] = m[i] && (x === 0 || m[i - 1]) && (x === W - 1 || m[i + 1]) && (y === 0 || m[i - W]) && (y === H - 1 || m[i + W]) ? 1 : 0;
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
    var ids = new Int32Array(m.length), sizes = [0], n = 0, stack = new Int32Array(m.length);
    for (var s0 = 0; s0 < m.length; s0++) {
      if (!m[s0] || ids[s0]) continue;
      n++; var size = 0, sp = 0; stack[sp++] = s0; ids[s0] = n;
      while (sp) {
        var i = stack[--sp], x = i % W; size++;
        if (x > 0 && m[i - 1] && !ids[i - 1]) { ids[i - 1] = n; stack[sp++] = i - 1; }
        if (x < W - 1 && m[i + 1] && !ids[i + 1]) { ids[i + 1] = n; stack[sp++] = i + 1; }
        if (i >= W && m[i - W] && !ids[i - W]) { ids[i - W] = n; stack[sp++] = i - W; }
        if (i < m.length - W && m[i + W] && !ids[i + W]) { ids[i + W] = n; stack[sp++] = i + W; }
      }
      sizes.push(size);
    }
    return { ids: ids, n: n, sizes: sizes };
  }
  function fillHoles(m, W, H) {
    var out = new Uint8Array(m.length), stack = new Int32Array(m.length), sp = 0;
    var push = function (i) { if (!m[i] && !out[i]) { out[i] = 1; stack[sp++] = i; } };
    for (var x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (var y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (sp) {
      var i = stack[--sp], xx = i % W;
      if (xx > 0) push(i - 1);
      if (xx < W - 1) push(i + 1);
      if (i >= W) push(i - W);
      if (i < m.length - W) push(i + W);
    }
    for (var j = 0; j < m.length; j++) out[j] = out[j] ? 0 : 1;
    return out;
  }

  // Percentages, score and QC from pixel counts (shared by analyze and combine)
  function summarize(nLeaf, nHealthy, nChl, nNec) {
    var pH = nHealthy / nLeaf, pC = nChl / nLeaf, pN = nNec / nLeaf;
    var diseasedPct = (pC + pN) * 100;
    var score = blsScore(diseasedPct);
    return {
      ok: true,
      leafPixels: nLeaf,
      healthyPixels: nHealthy,
      chloroticPixels: nChl,
      necroticPixels: nNec,
      healthyPct: round2(pH * 100),
      chloroticPct: round2(pC * 100),
      necroticPct: round2(pN * 100),
      diseasedPct: round2(diseasedPct),
      score: score,
      category: category(score),
      qc: Math.abs(pH + pC + pN - 1) < 0.0001 ? "PASS" : "CHECK"
    };
  }

  /*
   * Long leaves photographed in sections: pixel counts are added up, so the
   * combined score is what one photo of the whole leaf would have given.
   */
  function combine(results) {
    var t = { l: 0, h: 0, c: 0, n: 0 };
    results.forEach(function (r) {
      t.l += r.leafPixels; t.h += r.healthyPixels; t.c += r.chloroticPixels; t.n += r.necroticPixels;
    });
    var out = summarize(t.l, t.h, t.c, t.n);
    out.sections = results.length;
    return out;
  }

  /*
   * Green / yellow / red overlay at OVERLAY_ALPHA, as in the R panels.
   * Writes into a copy of rgba and returns it.
   */
  var COLORS = {};
  COLORS[HEALTHY] = [0, 200, 0];
  COLORS[CHLOROTIC] = [255, 215, 0];
  COLORS[NECROTIC] = [220, 0, 0];

  function overlay(rgba, mask, alpha) {
    var a = alpha == null ? 0.45 : alpha;
    var out = new Uint8ClampedArray(rgba);
    for (var i = 0, p = 0; i < mask.length; i++, p += 4) {
      var c = COLORS[mask[i]];
      if (!c) continue;
      out[p] = out[p] * (1 - a) + c[0] * a;
      out[p + 1] = out[p + 1] * (1 - a) + c[1] * a;
      out[p + 2] = out[p + 2] * (1 - a) + c[2] * a;
    }
    return out;
  }

  /*
   * Share of the photo's outer border that is black board. Low values mean the
   * photo has no black background (soil, other plants…), so the black-board
   * method would count background as leaf.
   */
  function borderDarkFraction(rgba, width, height, params) {
    var P = params || PARAMS;
    var band = Math.max(2, Math.round(Math.min(width, height) * 0.03));
    var dark = 0, total = 0, step = 3;
    for (var y = 0; y < height; y += step) {
      for (var x = 0; x < width; x += step) {
        if (x >= band && x < width - band && y >= band && y < height - band) continue;
        var p = (y * width + x) * 4;
        total++;
        if ((rgba[p] + rgba[p + 1] + rgba[p + 2]) / 255 <= P.LEAF_RGB_SUM_THRESHOLD * 2) dark++;
      }
    }
    return total ? dark / total : 1;
  }

  return {
    VERSION: VERSION,
    borderDarkFraction: borderDarkFraction,
    boardMask: boardMask,
    perRegion: perRegion,
    RULES_V2: RULES_V2,
    PARAMS: PARAMS,
    SCALE: SCALE,
    blsScore: blsScore,
    category: category,
    analyze: analyze,
    combine: combine,
    overlay: overlay
  };
});
