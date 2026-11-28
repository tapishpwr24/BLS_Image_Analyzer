"""
BLS scoring engine: exact Python port of the web app's engine.js v1.0.0,
which is itself a port of BLS_Image_Analyzer.R (sections 0, 4, 5, 6 + QC).

Input is an RGB uint8 array (H, W, 3). Results match the app pixel for pixel
on the same input pixels (verified on the app's example leaf BLS_02).
Do not change PARAMS unless recalibrating against the R pipeline.
"""
import numpy as np

VERSION = "1.0.0"

PARAMS = {
    "LEAF_RGB_SUM_THRESHOLD": 0.20,
    "NECROTIC_H_MIN": 0.02,
    "NECROTIC_H_MAX": 0.10,
    "NECROTIC_S_MIN": 0.15,
    "NECROTIC_V_MIN": 0.10,
    "NECROTIC_V_MAX": 0.50,
    "CHLOROTIC_H_MIN": 0.10,
    "CHLOROTIC_H_MAX": 0.24,
    "CHLOROTIC_V_MIN": 0.28,
    "MIN_LEAF_PIXELS": 100,
    # R-compatibility: R's rgb2hsv() was called on 0-1 values with the default
    # maxColorValue = 255, so V = max/255. Kept so scores match published R
    # results. Side effect: the V-based rules never fire, so chlorotic is
    # always 0 and necrotic = R>G>B with S >= 0.12.
    "V_DIVISOR": 255,
}

BG, HEALTHY, CHLOROTIC, NECROTIC = 0, 1, 2, 3

# Section 4: diseased % -> 1-9 rating (upper bound inclusive)
SCALE = [(0.5, 1), (2, 2), (6, 3), (12, 4), (25, 5), (40, 6), (60, 7), (75, 8)]


def bls_score(diseased_pct):
    for upper, score in SCALE:
        if diseased_pct <= upper:
            return score
    return 9


def category(score):
    if score is None:
        return None
    if score < 3:
        return "Resistant"
    if score < 5:
        return "Moderately Resistant"
    if score < 7:
        return "Moderately Susceptible"
    return "Highly Susceptible"


def _round2(x):
    # JS Math.round(x * 100) / 100 (rounds half up)
    return float(np.floor(x * 100 + 0.5) / 100)


def analyze(rgb, roi=None, params=None):
    """Classify every pixel. rgb: uint8 (H, W, 3). roi: optional bool (H, W);
    only pixels inside it can count as leaf. Returns a dict with a 'mask'."""
    P = params or PARAMS
    f = rgb.astype(np.float64) / 255.0
    r, g, b = f[..., 0], f[..., 1], f[..., 2]

    leaf = (r + g + b) > P["LEAF_RGB_SUM_THRESHOLD"]
    if roi is not None:
        leaf &= roi.astype(bool)

    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    delta = mx - mn
    v = mx / P["V_DIVISOR"]
    with np.errstate(divide="ignore", invalid="ignore"):
        s = np.where(mx > 0, delta / mx, 0.0)
        hr = (g - b) / delta
        hg = 2 + (b - r) / delta
        hb = 4 + (r - g) / delta
    h = np.where(mx == r, hr, np.where(mx == g, hg, hb)) / 6
    h = np.where(delta > 0, h, 0.0)
    h = np.where(h < 0, h + 1, h)

    nec = (
        (h >= P["NECROTIC_H_MIN"]) & (h <= P["NECROTIC_H_MAX"]) & (s >= P["NECROTIC_S_MIN"])
        & (v >= P["NECROTIC_V_MIN"]) & (v <= P["NECROTIC_V_MAX"])
    ) | ((r > g) & (g > b) & (s >= 0.12) & (v <= 0.55))
    nec &= leaf

    chl = (
        (h >= P["CHLOROTIC_H_MIN"]) & (h <= P["CHLOROTIC_H_MAX"]) & (v >= P["CHLOROTIC_V_MIN"])
    ) | ((r >= g * 0.90) & (g > b * 1.03) & (v >= 0.30) & (s >= 0.04))
    chl &= leaf & ~nec

    mask = np.zeros(leaf.shape, np.uint8)
    mask[leaf] = HEALTHY
    mask[chl] = CHLOROTIC
    mask[nec] = NECROTIC

    n_leaf = int(leaf.sum())
    if n_leaf < P["MIN_LEAF_PIXELS"]:
        return {"ok": False, "qc": "FAILED", "leafPixels": n_leaf, "mask": mask,
                "width": rgb.shape[1], "height": rgb.shape[0]}
    out = summarize(n_leaf, n_leaf - int(chl.sum()) - int(nec.sum()), int(chl.sum()), int(nec.sum()))
    out.update(width=rgb.shape[1], height=rgb.shape[0], mask=mask)
    return out


def summarize(n_leaf, n_healthy, n_chl, n_nec):
    pH, pC, pN = n_healthy / n_leaf, n_chl / n_leaf, n_nec / n_leaf
    diseased = (pC + pN) * 100
    score = bls_score(diseased)
    return {
        "ok": True,
        "leafPixels": n_leaf, "healthyPixels": n_healthy,
        "chloroticPixels": n_chl, "necroticPixels": n_nec,
        "healthyPct": _round2(pH * 100), "chloroticPct": _round2(pC * 100),
        "necroticPct": _round2(pN * 100), "diseasedPct": _round2(diseased),
        "score": score, "category": category(score),
        "qc": "PASS" if abs(pH + pC + pN - 1) < 1e-4 else "CHECK",
    }


def combine(results):
    """Pool pixel counts of several sections of one leaf (as the app does)."""
    t = [sum(r[k] for r in results) for k in ("leafPixels", "healthyPixels", "chloroticPixels", "necroticPixels")]
    out = summarize(*t)
    out["sections"] = len(results)
    return out


COLORS = {HEALTHY: (0, 200, 0), CHLOROTIC: (255, 215, 0), NECROTIC: (220, 0, 0)}


def overlay(rgb, mask, alpha=0.45, roi=None):
    out = rgb.astype(np.float32).copy()
    for cls, col in COLORS.items():
        sel = mask == cls
        out[sel] = out[sel] * (1 - alpha) + np.array(col, np.float32) * alpha
    if roi is not None:
        out[~roi] *= 0.25
    return out.clip(0, 255).astype(np.uint8)


def border_dark_fraction(rgb, params=None):
    """Share of the photo's outer border that is black board (app's check)."""
    P = params or PARAMS
    h, w = rgb.shape[:2]
    band = max(2, int(np.floor(min(w, h) * 0.03 + 0.5)))
    ys, xs = np.arange(0, h, 3), np.arange(0, w, 3)
    yy, xx = np.meshgrid(ys, xs, indexing="ij")
    on_border = (xx < band) | (xx >= w - band) | (yy < band) | (yy >= h - band)
    px = rgb[yy[on_border], xx[on_border]].astype(np.float64)
    if len(px) == 0:
        return 1.0
    dark = (px.sum(axis=1) / 255.0) <= P["LEAF_RGB_SUM_THRESHOLD"] * 2
    return float(dark.mean())
