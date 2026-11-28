"""
Leaf finder for field photos (soil, other plants, hands around the leaf).

Port of the web app's segment.js: SlimSAM (compressed Segment Anything) via
ONNX Runtime, same model files, same 1024 px input and normalisation, same
mask post-processing (keep the part connected to the leaf point, fill holes).

Batch additions (the app relies on a person tapping instead):
  * the leaf point is moved from the image centre to the nearest leaf-coloured
    pixel (green / yellow / straw, not skin, not dark soil);
  * hands are found (large skin-coloured blobs entering from the photo edge)
    and given "not leaf" points, like tapping "- Not leaf" in the app.
"""
import os

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

from .segment import fill_small_holes

SIZE = 1024
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# SlimSAM files: next to this package, or (inside the GitHub repo) the web app's copy
_CANDIDATES = [os.path.join(_ROOT, "models", "slimsam"),
               os.path.join(os.path.dirname(_ROOT), "app", "models", "slimsam")]
MODEL_DIR = next((d for d in _CANDIDATES if os.path.exists(os.path.join(d, "vision_encoder_quantized.onnx"))), _CANDIDATES[0])

_sessions = None


def _load():
    global _sessions
    if _sessions is None:
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.intra_op_num_threads = os.cpu_count() or 2   # SAM runs alone, one photo at a time
        so.enable_cpu_mem_arena = False   # encoder needs ~0.8 GB; free it after each photo
        enc = ort.InferenceSession(os.path.join(MODEL_DIR, "vision_encoder_quantized.onnx"), so,
                                   providers=["CPUExecutionProvider"])
        dec = ort.InferenceSession(os.path.join(MODEL_DIR, "prompt_encoder_mask_decoder_quantized.onnx"), so,
                                   providers=["CPUExecutionProvider"])
        _sessions = (enc, dec)
    return _sessions


def available():
    return all(os.path.exists(os.path.join(MODEL_DIR, f)) for f in
               ("vision_encoder_quantized.onnx", "prompt_encoder_mask_decoder_quantized.onnx"))


def embed(rgb):
    enc, _ = _load()
    H, W = rgb.shape[:2]
    k = SIZE / max(W, H)
    rw, rh = round(W * k), round(H * k)
    small = np.asarray(Image.fromarray(rgb).resize((rw, rh), Image.LANCZOS), np.float32) / 255.0
    x = np.zeros((3, SIZE, SIZE), np.float32)           # zero padding right/bottom
    x[:, :rh, :rw] = ((small - MEAN) / STD).transpose(2, 0, 1)
    out = enc.run(None, {"pixel_values": x[None]})
    names = [o.name for o in enc.get_outputs()]
    d = dict(zip(names, out))
    return {"W": W, "H": H, "k": k, "emb": d["image_embeddings"], "pos": d["image_positional_embeddings"]}


def mask(h, points):
    """points: list of (x, y, label) in image pixels; label 1 = leaf, 0 = not leaf."""
    _, dec = _load()
    coords = np.array([[p[0] * h["k"], p[1] * h["k"]] for p in points], np.float32)[None, None]
    labels = np.array([p[2] for p in points], np.int64)[None, None]
    out = dec.run(None, {"input_points": coords, "input_labels": labels,
                         "image_embeddings": h["emb"], "image_positional_embeddings": h["pos"]})
    d = dict(zip([o.name for o in dec.get_outputs()], out))
    iou = d["iou_scores"].reshape(-1)
    best = int(np.argmax(iou[:3]))
    logits = d["pred_masks"].reshape(-1, 256, 256)[best]

    # 256x256 low-res logits cover the padded 1024 square: bilinear upsample (as the app)
    logits = logits.astype(np.float32)
    W, H, s = h["W"], h["H"], h["k"] / 4
    fy = np.clip((np.arange(H) + 0.5) * s - 0.5, 0, 255)
    fx = np.clip((np.arange(W) + 0.5) * s - 0.5, 0, 255)
    y0 = np.floor(fy).astype(int); y1 = np.minimum(255, y0 + 1); wy = (fy - y0)[:, None].astype(np.float32)
    x0 = np.floor(fx).astype(int); x1 = np.minimum(255, x0 + 1); wx = (fx - x0)[None, :].astype(np.float32)
    v = ((logits[y0][:, x0] * (1 - wx) + logits[y0][:, x1] * wx) * (1 - wy)
         + (logits[y1][:, x0] * (1 - wx) + logits[y1][:, x1] * wx) * wy)
    m = v > 0

    # Keep only regions touching a leaf point, then fill holes (lesions inside the leaf)
    lab, n = ndi.label(m)
    seeds = {lab[int(np.clip(round(p[1]), 0, H - 1)), int(np.clip(round(p[0]), 0, W - 1))] for p in points if p[2] == 1}
    seeds.discard(0)
    if seeds:
        m = np.isin(lab, list(seeds))
    m = fill_small_holes(m, 0.02)   # app fills all holes; capped so ground between leaves isn't scored
    return m, float(iou[best])


# ---------- batch helpers: where to put the points ----------

def skin_mask(rgb):
    """Classic RGB + YCrCb skin rule. Orange-tan lesions can pass it too, so it is
    only used for big blobs that enter from the photo edge (hands)."""
    f = rgb.astype(np.int32)
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cr = 128 + 0.5 * r - 0.4187 * g - 0.0813 * b
    cb = 128 - 0.1687 * r - 0.3313 * g + 0.5 * b
    rule = (r > 95) & (g > 40) & (b > 20) & (r > g) & (r > b) & (r - g > 15) & (np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b) > 15)
    return rule & (cr >= 138) & (cr <= 175) & (cb >= 85) & (cb <= 130) & (y > 60)


def hand_blobs(rgb, min_frac=0.02):
    """Large skin-coloured regions that reach the photo edge -> list of bool masks.
    (Morphology trims the outermost pixels, so 'reaches the edge' = within a 2 % band.)"""
    sk = ndi.binary_opening(skin_mask(rgb), iterations=3)
    sk = ndi.binary_closing(sk, iterations=3)
    lab, n = ndi.label(sk)
    if n == 0:
        return []
    H, W = sk.shape
    b = max(4, round(min(H, W) * 0.02))
    band = np.concatenate([lab[:b].ravel(), lab[-b:].ravel(), lab[:, :b].ravel(), lab[:, -b:].ravel()])
    edge_labels = set(np.unique(band).tolist()) - {0}
    sizes = ndi.sum(sk, lab, index=np.arange(1, n + 1))
    out = []
    for l in sorted(edge_labels, key=lambda l: -sizes[l - 1])[:2]:   # at most two hands
        if sizes[l - 1] >= min_frac * H * W:
            out.append(ndi.binary_fill_holes(lab == l))
    return out


def leaf_colour(rgb):
    """Green (incl. waxy blue-green), yellow or straw tissue, not too dark."""
    f = rgb.astype(np.float32) / 255
    mx, mn = f.max(-1), f.min(-1)
    d = mx - mn
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) / 6
        s = np.where(mx > 0, d / mx, 0)
    return (d > 0) & (h >= 0.06) & (h <= 0.55) & (s >= 0.10) & (mx >= 0.22)


def plant_tissue(rgb):
    """Leaf colour or lesion colour (tan / brown / orange), i.e. anything a leaf can be."""
    f = rgb.astype(np.float32) / 255
    mx, mn = f.max(-1), f.min(-1)
    d = mx - mn
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) / 6
        s = np.where(mx > 0, d / mx, 0)
    lesion = (d > 0) & (h >= 0.0) & (h < 0.06) & (s >= 0.15) & (mx >= 0.25)
    return leaf_colour(rgb) | lesion


def sky_fraction(rgb):
    """Share of the photo that is blue sky in the top third (landscape / canopy shots)."""
    H = rgb.shape[0]
    top = rgb[: H // 3].astype(np.int32)
    r, g, b = top[..., 0], top[..., 1], top[..., 2]
    sky = (b > 140) & (b > r + 25) & (b >= g)
    return float(sky.sum()) / (rgb.shape[0] * rgb.shape[1])


def interior_point(m):
    """Point deepest inside a mask (far from its edges)."""
    dt = ndi.distance_transform_edt(m)
    y, x = np.unravel_index(np.argmax(dt), m.shape)
    return float(x), float(y)


def choose_points(rgb, hands):
    """Positive point: nearest leaf-coloured, non-hand pixel to the centre, taken
    inside a solid patch (not on a thin edge). Negative: one inside each hand."""
    H, W = rgb.shape[:2]
    ok = leaf_colour(rgb)
    for hm in hands:
        ok &= ~hm
    ok = ndi.binary_erosion(ok, iterations=max(2, round(min(H, W) * 0.006)))  # solid tissue only
    cx, cy = W / 2, H / 2
    pts = []
    if ok.any():
        ys, xs = np.nonzero(ok)
        i = int(np.argmin((xs - cx) ** 2 + (ys - cy) ** 2))
        pts.append((float(xs[i]), float(ys[i]), 1))
    else:
        pts.append((cx, cy, 1))
    for hm in hands:
        x, y = interior_point(hm)
        pts.append((x, y, 0))
    return pts


def elongation(m):
    ys, xs = np.nonzero(m[::4, ::4])
    if len(ys) < 10:
        return 0.0
    ev = np.sort(np.linalg.eigvalsh(np.cov(np.stack([ys, xs]).astype(np.float64))))
    return float(np.sqrt(ev[1] / max(ev[0], 1e-9)))


def _decode_lowres(h, points):
    """Run only the small decoder; return the 256-grid mask cropped to the image and IoU."""
    _, dec = _load()
    coords = np.array([[p[0] * h["k"], p[1] * h["k"]] for p in points], np.float32)[None, None]
    labels = np.array([p[2] for p in points], np.int64)[None, None]
    out = dec.run(None, {"input_points": coords, "input_labels": labels,
                         "image_embeddings": h["emb"], "image_positional_embeddings": h["pos"]})
    d = dict(zip([o.name for o in dec.get_outputs()], out))
    iou = d["iou_scores"].reshape(-1)
    best = int(np.argmax(iou[:3]))
    lg = d["pred_masks"].reshape(-1, 256, 256)[best]
    gh, gw = max(1, round(h["H"] * h["k"] / 4)), max(1, round(h["W"] * h["k"] / 4))
    return lg[:gh, :gw] > 0, float(iou[best])


def _grid(mask_full, gh, gw):
    """Downsample a full-res bool mask to the 256 grid (share of True per cell > 0.5)."""
    H, W = mask_full.shape
    ys = (np.arange(gh) + 0.5) * H / gh
    xs = (np.arange(gw) + 0.5) * W / gw
    return mask_full[ys.astype(int).clip(0, H - 1)][:, xs.astype(int).clip(0, W - 1)]


def candidate_points(rgb, hands, max_points=30):
    """Leaf-point candidates: leaf pixels touching a hand (a held leaf), the solid
    leaf patch nearest the centre, and a coarse grid over the central area."""
    H, W = rgb.shape[:2]
    leaf = leaf_colour(rgb)
    for hm in hands:
        leaf &= ~hm
    solid = ndi.binary_erosion(leaf, iterations=max(3, round(min(H, W) * 0.012)))
    cands = []
    for hm in hands:   # leaf right next to the fingers
        ring = ndi.binary_dilation(hm, iterations=max(6, round(min(H, W) * 0.03))) & ~hm & solid
        if ring.any():
            ys, xs = np.nonzero(ring)
            # pick the ring pixels farthest from the photo edge (inside the frame, where the leaf runs)
            depth = np.minimum.reduce([xs, W - 1 - xs, ys, H - 1 - ys])
            for i in np.argsort(-depth)[:: max(1, len(xs) // 3)][:3]:
                cands.append((float(xs[i]), float(ys[i])))
    if solid.any():
        ys, xs = np.nonzero(solid)
        i = int(np.argmin((xs - W / 2) ** 2 + (ys - H / 2) ** 2))
        cands.append((float(xs[i]), float(ys[i])))
    # Grid over the photo: any pixel that is not a hand. Colour is not required
    # (dead grey-tan or waxy leaves); soil / clumps lose in the shape scoring.
    not_hand = np.ones((H, W), bool)
    for hm in hands:
        not_hand &= ~ndi.binary_dilation(hm, iterations=max(4, round(min(H, W) * 0.01)))
    for fy in (0.2, 0.35, 0.5, 0.65, 0.8):
        for fx in (0.2, 0.35, 0.5, 0.65, 0.8):
            x, y = int(W * fx), int(H * fy)
            if not_hand[y, x]:
                cands.append((float(x), float(y)))
    # de-duplicate (points closer than 5 % of the image)
    out = []
    for c in cands:
        if all((c[0] - o[0]) ** 2 + (c[1] - o[1]) ** 2 > (0.05 * min(H, W)) ** 2 for o in out):
            out.append(c)
    return out[:max_points]


def _score_candidate(m, iou, skin_g, hand_ring_g, has_hand, plant_g):
    """Higher = more like the single leaf the photo is about: long and thin, wide
    enough to be the leaf held close to the camera (not a background blade or a
    clump of canopy), passing near the centre, confident, little skin, touching
    the fingers when a hand is in the photo."""
    gh, gw = m.shape
    frac = m.mean()
    if frac < 0.01 or frac > 0.45:
        return 0.0, {}
    ys, xs = np.nonzero(m)
    if len(ys) < 10:
        return 0.0, {}
    ev = np.sort(np.linalg.eigvalsh(np.cov(np.stack([ys, xs]).astype(np.float64))))
    elong = float(np.sqrt(ev[1] / max(ev[0], 1e-9)))
    width = 4 * np.sqrt(max(ev[0], 0)) / min(gh, gw)          # leaf width / short side of photo
    d_centre = np.sqrt(((ys - gh / 2) / gh) ** 2 + ((xs - gw / 2) / gw) ** 2).min()
    skin_in = float(skin_g[m].mean())
    plant_in = float(plant_g[m].mean())
    if plant_in < 0.6:                                        # board, soil, clothes, sky
        return 0.0, {}
    s = (iou ** 2) * (min(elong, 10) / 10) * (1 - skin_in) ** 2
    s *= min(1.0, width / 0.06)                               # thin stems/blades score low
    s *= min(1.0, np.sqrt(frac / 0.04))
    s *= float(np.exp(-4 * d_centre))                         # the leaf shown is near the centre
    if has_hand and (m & hand_ring_g).any():
        s *= 1.5                                              # held leaf touches the fingers
    return float(s), {"elong": elong, "frac": frac, "skin": skin_in, "width": width}


def segment_field(rgb):
    """Returns (mask or None, info). Encoder runs once; candidates are compared on
    the decoder's 256-grid output and only the winner is upsampled."""
    H, W = rgb.shape[:2]
    sky = sky_fraction(rgb)
    if sky > 0.04:   # landscape / canopy photo, no single leaf to score
        return np.zeros((H, W), bool), {"background": "field (SAM)", "hands": 0, "sky_pct": round(sky * 100, 1),
                                        "mask_frac": 0.0, "sam_iou": None, "elongation": 0.0, "points": ""}
    hands = hand_blobs(rgb)
    negs = [interior_point(hm) + (0,) for hm in hands]
    cands = candidate_points(rgb, hands)
    h = embed(rgb)
    gh, gw = max(1, round(H * h["k"] / 4)), max(1, round(W * h["k"] / 4))
    skin_g = _grid(skin_mask(rgb), gh, gw)
    plant_g = _grid(plant_tissue(rgb), gh, gw)
    hand_any = np.zeros((H, W), bool)
    for hm in hands:
        hand_any |= hm
    hand_ring_g = _grid(ndi.binary_dilation(hand_any, iterations=max(6, round(min(H, W) * 0.03))), gh, gw) if hands else None

    best = (0.0, None, None, {})
    for (x, y) in cands:
        pts = [(x, y, 1)] + negs
        lm, iou = _decode_lowres(h, pts)
        lab, n = ndi.label(lm)
        sy, sx = min(gh - 1, int(y * gh / H)), min(gw - 1, int(x * gw / W))
        if lab[sy, sx]:
            lm = lab == lab[sy, sx]
        sc, st = _score_candidate(lm, iou, skin_g, hand_ring_g, bool(hands), plant_g)
        if sc > best[0]:
            best = (sc, pts, iou, st)

    info = {"background": "field (SAM)", "hands": len(hands), "candidates": len(cands)}
    if best[1] is None:
        info.update(mask_frac=0.0, sam_iou=None, elongation=0.0, points=";".join(f"{int(x)},{int(y)},1" for x, y in cands))
        return np.zeros((H, W), bool), info
    m, iou = mask(h, best[1])      # full-resolution mask for the winner (same as the app)
    for hm in hands:               # a hand can still touch the mask edge
        m &= ~hm
    info.update(sam_iou=round(iou, 3), score=round(best[0], 3),
                points=";".join(f"{int(x)},{int(y)},{l}" for x, y, l in best[1]),
                mask_frac=round(float(m.mean()) * 100, 1), elongation=round(elongation(m), 1))
    return m, info
