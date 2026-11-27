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

  var VERSION = "1.0.0";

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
  function analyze(rgba, width, height, params, roi) {
    // roi (optional): Uint8Array, 1 = inside the outline the user traced.
    // Only those pixels can count as leaf (field photos without a black board).
    var P = params || PARAMS;
    var n = width * height;
    var mask = new Uint8Array(n);
    var nLeaf = 0, nHealthy = 0, nChl = 0, nNec = 0;

    for (var i = 0, p = 0; i < n; i++, p += 4) {
      if (roi && !roi[i]) continue;
      var r = rgba[p] / 255, g = rgba[p + 1] / 255, b = rgba[p + 2] / 255;

      if (!(r + g + b > P.LEAF_RGB_SUM_THRESHOLD)) continue; // background
      nLeaf++;

      var max = r > g ? (r > b ? r : b) : (g > b ? g : b);
      var min = r < g ? (r < b ? r : b) : (g < b ? g : b);
      var delta = max - min;
      var v = max / P.V_DIVISOR;
      var s = max > 0 ? delta / max : 0;
      var h = 0;
      if (delta > 0) {
        if (max === r) h = (g - b) / delta;
        else if (max === g) h = 2 + (b - r) / delta;
        else h = 4 + (r - g) / delta;
        h /= 6;
        if (h < 0) h += 1;
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
    PARAMS: PARAMS,
    SCALE: SCALE,
    blsScore: blsScore,
    category: category,
    analyze: analyze,
    combine: combine,
    overlay: overlay
  };
});
