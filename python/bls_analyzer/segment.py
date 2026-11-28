"""
Automatic leaf segmentation for photos WITHOUT a matte black board.

The scoring engine treats every pixel brighter than near-black as leaf, so on
a grey board, white paper or soil the background is scored too. This module
finds the leaf first and returns a mask (ROI) that is passed to the engine,
the same way the app uses a traced outline in Field mode. Pixel colour rules
are untouched; only which pixels count as leaf changes.

Method (uniform backgrounds: grey board, white paper, bench):
  1. Estimate the background colour from the photo's outer border (median, CIELAB).
  2. Colour distance of every pixel from it (lightness down-weighted, so
     shadows on the board are not taken for leaf).
  3. Otsu threshold on that distance, clean up, keep the large blobs, fill holes
     (keeps the pale midrib and bleached streaks inside the leaf).
Field photos (border is soil and other plants, not one colour) cannot be
segmented reliably this way: they come back as needing an outline/mask.
"""
import numpy as np
from scipy import ndimage as ndi

L_WEIGHT = 0.5          # down-weight lightness differences (shadows, uneven light)
MIN_THRESHOLD = 12.0    # never split closer than this (Lab units) to the background
UNIFORM_TOL = 12.0      # border pixel counts as "background colour" within this distance
UNIFORM_MIN = 0.60      # share of border that must match for a uniform background


GLARE_MAX_CHROMA = 8.0  # near-neutral colour ...
GLARE_MIN_DL = 10.0     # ... and this much brighter than the board = glare
MIN_ELONGATION = 3.0   # length / width (from second moments) for extra pieces to count as leaf


def _elongation(ys, xs):
    if len(ys) < 10:
        return 0.0
    cov = np.cov(np.stack([ys, xs]).astype(np.float64))
    ev = np.sort(np.linalg.eigvalsh(cov))
    return float(np.sqrt(ev[1] / max(ev[0], 1e-9)))


def fill_small_holes(m, max_frac=0.01):
    """Fill holes inside the leaf (lesions, pale midrib) but not large background
    areas enclosed by several leaves or stems (whole-plant photos)."""
    holes = ndi.binary_fill_holes(m) & ~m
    if not holes.any():
        return m
    lab, n = ndi.label(holes)
    sizes = ndi.sum(holes, lab, index=np.arange(1, n + 1))
    small = np.zeros(n + 1, bool)
    small[1:] = sizes <= max_frac * m.size
    return m | small[lab]


def srgb_to_lab(rgb):
    c = rgb.astype(np.float32) / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]], np.float32)
    xyz = c @ m.T / np.array([0.95047, 1.0, 1.08883], np.float32)
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], axis=-1)


def _otsu(values, lo=0.0, hi=100.0, bins=256):
    hist, edges = np.histogram(np.clip(values, lo, hi), bins=bins, range=(lo, hi))
    hist = hist.astype(np.float64)
    centers = (edges[:-1] + edges[1:]) / 2
    w0 = np.cumsum(hist)
    w1 = w0[-1] - w0
    m0 = np.cumsum(hist * centers)
    mu0 = m0 / np.maximum(w0, 1)
    mu1 = (m0[-1] - m0) / np.maximum(w1, 1)
    between = w0 * w1 * (mu0 - mu1) ** 2
    return float(centers[int(np.argmax(between))])


def _border(arr, band):
    return np.concatenate([
        arr[:band].reshape(-1, arr.shape[-1]), arr[-band:].reshape(-1, arr.shape[-1]),
        arr[band:-band, :band].reshape(-1, arr.shape[-1]), arr[band:-band, -band:].reshape(-1, arr.shape[-1]),
    ])


def segment_leaf(rgb):
    """Returns (mask or None, info dict). mask is bool (H, W), True = leaf."""
    h, w = rgb.shape[:2]
    band = max(2, int(round(min(h, w) * 0.03)))
    lab = srgb_to_lab(rgb)
    border = _border(lab, band)
    bg = np.median(border, axis=0)

    wvec = np.array([L_WEIGHT, 1.0, 1.0], np.float32)
    dist = np.sqrt((((lab - bg) * wvec) ** 2).sum(axis=-1))
    border_d = np.sqrt((((border - bg) * wvec) ** 2).sum(axis=-1))
    uniform = float((border_d < UNIFORM_TOL).mean())

    info = {"bg_L": round(float(bg[0]), 1), "bg_a": round(float(bg[1]), 1), "bg_b": round(float(bg[2]), 1),
            "border_uniform": round(uniform, 3)}
    if uniform < UNIFORM_MIN:
        info["background"] = "field / mixed"
        return None, info
    info["background"] = "light (paper)" if bg[0] >= 75 else "grey board" if bg[0] >= 25 else "dark"

    thr = max(_otsu(dist), MIN_THRESHOLD)
    info["threshold"] = round(thr, 1)
    m = dist > thr

    # Glare / reflections: brighter than the board but almost colourless. Removed
    # before blobs are joined so glare touching a leaf is not glued onto it.
    # Pale tissue enclosed by the leaf comes back with the hole filling below.
    chroma = np.sqrt(lab[..., 1] ** 2 + lab[..., 2] ** 2)
    glare = (chroma < GLARE_MAX_CHROMA) & (lab[..., 0] > bg[0] + GLARE_MIN_DL)
    m &= ~glare
    info["glare_pct"] = round(float(glare.mean() * 100), 1)

    # Clean-up at full resolution: remove specks/dust, bridge small gaps
    st = ndi.generate_binary_structure(2, 1)
    m = ndi.binary_opening(m, st, iterations=2)
    m = ndi.binary_closing(m, st, iterations=3)

    lab_img, n = ndi.label(m)
    if n == 0:
        info["components"] = 0
        return np.zeros((h, w), bool), info
    sizes = ndi.sum(m, lab_img, index=np.arange(1, n + 1))
    keep_min = max(0.10 * sizes.max(), 0.001 * h * w)
    keep = np.zeros(n + 1, bool)
    keep[1:] = sizes >= keep_min
    # Drop compact blobs (sample labels, tags, glare patches): leaves are long and
    # thin. If no piece is leaf-shaped, the largest is kept so a short section still scores.
    largest = int(np.argmax(sizes)) + 1
    elong = {lbl: _elongation(*np.nonzero(lab_img == lbl)) for lbl in np.nonzero(keep)[0]}
    leafy = [l for l, e in elong.items() if e >= MIN_ELONGATION]
    dropped = 0
    for lbl in list(elong):
        if leafy and lbl not in leafy:
            keep[lbl] = False
            dropped += 1
        elif not leafy and lbl != largest:
            keep[lbl] = False
            dropped += 1
    info["compact_dropped"] = dropped
    info["largest_elongation"] = round(elong.get(largest, 0.0), 1)
    m = keep[lab_img]
    m = fill_small_holes(m)

    info["components"] = int(keep.sum())
    # Contrast check: how far leaf pixels sit from the background vs the cut-off
    inside = dist[m]
    info["leaf_median_dist"] = round(float(np.median(inside)), 1) if inside.size else 0.0
    return m, info
