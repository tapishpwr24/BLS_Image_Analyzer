"""
Batch-score a folder of BLS leaf photos.

  python -m bls_analyzer.batch PHOTO_DIR -o OUT_DIR [--mode auto|board|segment]
                               [--masks MASK_DIR] [--workers N] [--no-overlays]

Modes
  auto     (default) find the leaf automatically (segment.py) on any uniform
           background, black board included (glare, tape and labels on a board
           are otherwise scored as leaf); field photos without a mask are
           reported as NEEDS_OUTLINE and not scored.
  board    exact app/R black-board method on every photo (what the app gives);
           also always reported as app_score / app_diseased_pct.
  segment  same as auto (kept for clarity in scripts).
  --masks  folder of leaf masks (PNG, white = leaf) named like the photo
           (e.g. 106.png for 106.JPG). A mask always wins over the other modes.

Outputs in OUT_DIR
  results_photos.csv   one row per photo (also the app's black-board score for comparison)
  results_samples.csv  photos grouped by sample ID taken from the file name
  overlays/*.jpg       original | classified (green healthy, yellow chlorotic,
                       red necrotic, darkened = not counted as leaf)
  report.html          all overlays and scores on one page, for checking by eye
"""
import argparse
import csv
import html
import os
import re
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from PIL import Image, ImageOps

from . import engine, sam, segment

MAX_ANALYSIS_SIDE = 2048   # same as the app
MIN_FIELD_LEAF_PCT = 1.5   # field mask smaller than this share of the photo = no single leaf
BOARD_SURE = 0.70          # border uniformity above which the board/paper method is trusted
OVERLAY_SIDE = 900
EXTS = (".jpg", ".jpeg", ".png")
SMALL_LEAF_PX = 20000      # app warns below this


def load_rgb(path, max_side=MAX_ANALYSIS_SIDE):
    im = Image.open(path)
    im = ImageOps.exif_transpose(im).convert("RGB")
    k = min(1.0, max_side / max(im.size))
    if k < 1:
        im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
    return np.asarray(im)


def sample_id(filename):
    """BLS_SD_12.3_1.jpg -> BLS_SD_12; 106-2.JPG -> 106; '129 (2).JPG' -> 129;
    '7 R_1.jpg' -> '7 R'; 9_2.jpg -> 9; IMG_4545.JPEG -> IMG_4545 (own sample)."""
    stem = os.path.splitext(filename)[0].strip()
    stem = re.sub(r"\s*\(\d+\)$", "", stem)          # "129 (2)"
    m = re.match(r"^(BLS_SD_\d+)", stem)
    if m:
        return m.group(1)
    if re.match(r"^IMG[-_]\d+$", stem):
        return stem
    stem = re.sub(r"_\d+$", "", stem)                # "7 R_1", "9_2"
    stem = re.sub(r"-\d+$", "", stem)                # "106-2"
    return stem


def find_mask(mask_dir, filename):
    if not mask_dir:
        return None
    stem = os.path.splitext(filename)[0]
    for ext in (".png", ".PNG", ".jpg", ".jpeg"):
        p = os.path.join(mask_dir, stem + ext)
        if os.path.exists(p):
            return p
    return None


def process(job):
    path, mode, mask_dir, overlay_dir, use_sam, run_sam_here = job
    name = os.path.basename(path)
    row = {"file": name, "sample": sample_id(name)}
    try:
        rgb = load_rgb(path)
    except Exception as e:  # unreadable file
        row.update(status="ERROR", note=str(e))
        return row
    h, w = rgb.shape[:2]
    row.update(width=w, height=h)

    bdf = engine.border_dark_fraction(rgb)
    row["board_fraction"] = round(bdf, 3)

    # What the phone app reports in black-board mode, for comparison
    app = engine.analyze(rgb)
    row["app_diseased_pct"] = app.get("diseasedPct")
    row["app_score"] = app.get("score")

    roi, seg_info, notes = None, {}, []
    mask_path = find_mask(mask_dir, name)
    if mask_path:
        m = Image.open(mask_path).convert("L").resize((w, h), Image.NEAREST)
        roi = np.asarray(m) > 127
        method = "mask file"
    elif mode == "board":
        method = "black board"
        if bdf < 0.5:
            notes.append("no black board: background counted as leaf")
    else:
        roi, seg_info = segment.segment_leaf(rgb)
        method = "auto segment"
        # Board/paper result is doubtful when the border is only partly uniform
        # (text on the board, grass at the edge) or the region is not leaf-shaped:
        # let the SlimSAM leaf finder decide, keeping the board result as fallback.
        doubtful = roi is not None and (seg_info.get("border_uniform", 1) < BOARD_SURE
                                        or seg_info.get("largest_elongation", 99) < 2.5)
        if (roi is None or doubtful) and use_sam and sam.available():
            if not run_sam_here:   # SAM needs ~1 GB: done one photo at a time in the main process
                return {"file": name, "_sam_later": True}
            board_roi, board_info = roi, seg_info
            roi, seg_info = sam.segment_field(rgb)
            method = "field SAM"
            not_leaf = (seg_info["mask_frac"] < MIN_FIELD_LEAF_PCT or seg_info["elongation"] < 2.0
                        or (seg_info["elongation"] < 2.5 and (seg_info["sam_iou"] or 0) < 0.85))
            if not_leaf and board_roi is not None:
                roi, seg_info, method = board_roi, board_info, "auto segment"
                notes.append("background only partly uniform and leaf finder found no single leaf: check")
                not_leaf = False
            if not_leaf:
                row.update(method=method, status="NO_SINGLE_LEAF", background=seg_info["background"],
                           note="no single leaf found (canopy/plot photo?): supply a mask (--masks) or photograph one leaf")
                if overlay_dir:
                    save_overlay(rgb, None, None, os.path.join(overlay_dir, os.path.splitext(name)[0] + ".jpg"),
                                 points=seg_info.get("points"))
                return row
            if method == "field SAM":
                if seg_info["elongation"] < 2.5:
                    notes.append(f"found region is not leaf-shaped (length/width {seg_info['elongation']}): check")
                if seg_info["sam_iou"] < 0.85:
                    notes.append(f"leaf finder unsure (IoU {seg_info['sam_iou']})")
                if seg_info["hands"]:
                    row["hands_removed"] = seg_info["hands"]
        if roi is None:
            row.update(method=method, status="NEEDS_OUTLINE", background=seg_info.get("background"),
                       note="field/mixed background: supply a leaf mask (--masks) or trace it in the app")
            if overlay_dir:
                save_overlay(rgb, None, None, os.path.join(overlay_dir, os.path.splitext(name)[0] + ".jpg"))
            return row

    res = app if (roi is None and method == "black board") else engine.analyze(rgb, roi)
    row["method"] = method
    row["background"] = seg_info.get("background", "black board" if method == "black board" else "")
    row["seg_threshold"] = seg_info.get("threshold")
    row["seg_components"] = seg_info.get("components")
    row["sam_iou"] = seg_info.get("sam_iou")
    row["sam_points"] = seg_info.get("points")
    if not res["ok"]:
        row.update(status="FAILED", note="no leaf found")
        return row

    leaf_frac = res["leafPixels"] / (w * h) * 100
    row.update(
        leaf_px=res["leafPixels"], leaf_frac_pct=round(leaf_frac, 1),
        healthy_pct=res["healthyPct"], chlorotic_pct=res["chloroticPct"], necrotic_pct=res["necroticPct"],
        diseased_pct=res["diseasedPct"], score=res["score"], category=res["category"], qc=res["qc"],
        healthy_px=res["healthyPixels"], chlorotic_px=res["chloroticPixels"], necrotic_px=res["necroticPixels"],
    )
    if res["leafPixels"] < SMALL_LEAF_PX:
        notes.append("leaf is small in the frame")
    if roi is not None and method == "auto segment":
        if leaf_frac > 70:
            notes.append("leaf covers >70% of photo: check segmentation")
        edge = np.concatenate([roi[0], roi[-1], roi[:, 0], roi[:, -1]]).mean()
        if edge > 0.25:
            notes.append("leaf touches much of the photo edge: check segmentation")
    row["status"] = "CHECK" if notes or res["qc"] != "PASS" else "OK"
    row["note"] = "; ".join(notes)

    if overlay_dir:
        save_overlay(rgb, res["mask"], roi, os.path.join(overlay_dir, os.path.splitext(name)[0] + ".jpg"),
                     points=seg_info.get("points"))
    return row


def save_overlay(rgb, mask, roi, out_path, points=None):
    left = rgb.copy()
    if points:  # leaf-finder points: green = leaf, magenta = not leaf (hand)
        r = max(6, round(max(rgb.shape[:2]) / 120))
        for p in points.split(";"):
            x, y, l = (int(v) for v in p.split(","))
            col = (0, 255, 0) if l == 1 else (255, 0, 255)
            ys, xs = np.ogrid[:rgb.shape[0], :rgb.shape[1]]
            ring = np.abs(np.hypot(xs - x, ys - y) - r) < max(2, r / 3)
            left[ring] = col
    right = engine.overlay(rgb, mask, 0.45, roi) if mask is not None else (rgb * 0.35).astype(np.uint8)
    pair = np.concatenate([left, np.full((rgb.shape[0], 8, 3), 255, np.uint8), right], axis=1)
    im = Image.fromarray(pair)
    k = OVERLAY_SIDE / max(rgb.shape[:2])
    im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.BILINEAR)
    im.save(out_path, quality=85)


PHOTO_COLS = ["file", "sample", "status", "method", "background", "score", "category", "diseased_pct",
              "healthy_pct", "chlorotic_pct", "necrotic_pct", "leaf_px", "leaf_frac_pct",
              "app_score", "app_diseased_pct", "board_fraction", "seg_threshold", "seg_components",
              "sam_iou", "hands_removed", "sam_points",
              "healthy_px", "chlorotic_px", "necrotic_px", "qc", "width", "height", "note"]


def summarize_samples(rows):
    groups = {}
    for r in rows:
        groups.setdefault(r["sample"], []).append(r)
    out = []
    for sid, rs in sorted(groups.items(), key=lambda kv: natural_key(kv[0])):
        scored = [r for r in rs if r.get("leaf_px")]
        row = {"sample": sid, "photos": len(rs), "photos_scored": len(scored),
               "files": " | ".join(r["file"] for r in rs)}
        if scored:
            pooled = engine.combine([{"leafPixels": r["leaf_px"], "healthyPixels": r["healthy_px"],
                                      "chloroticPixels": r["chlorotic_px"], "necroticPixels": r["necrotic_px"]}
                                     for r in scored])
            mean_d = float(np.mean([r["diseased_pct"] for r in scored]))
            row.update(mean_diseased_pct=round(mean_d, 2), mean_score=engine.bls_score(mean_d),
                       mean_category=engine.category(engine.bls_score(mean_d)),
                       pooled_diseased_pct=pooled["diseasedPct"], pooled_score=pooled["score"],
                       min_diseased_pct=min(r["diseased_pct"] for r in scored),
                       max_diseased_pct=max(r["diseased_pct"] for r in scored))
        row["needs_attention"] = sum(r.get("status") != "OK" for r in rs)
        out.append(row)
    return out


SAMPLE_COLS = ["sample", "photos", "photos_scored", "mean_diseased_pct", "mean_score", "mean_category",
               "pooled_diseased_pct", "pooled_score", "min_diseased_pct", "max_diseased_pct",
               "needs_attention", "files"]


def natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def write_csv(path, rows, cols):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        wr = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        wr.writeheader()
        wr.writerows(rows)


def write_report(path, rows, overlays):
    esc = html.escape
    status_col = {"OK": "#2e7d32", "CHECK": "#b26a00", "NEEDS_OUTLINE": "#6a1b9a", "FAILED": "#c62828", "ERROR": "#c62828"}
    cards = []
    for r in rows:
        img = f'<a href="overlays/{esc(os.path.splitext(r["file"])[0])}.jpg"><img loading="lazy" src="overlays/{esc(os.path.splitext(r["file"])[0])}.jpg"></a>' if overlays else ""
        score = f'{r["score"]} · {r["diseased_pct"]}%' if r.get("score") is not None else "–"
        app = f'app: {r.get("app_score", "–")} · {r.get("app_diseased_pct", "–")}%'
        st = r.get("status", "")
        cards.append(
            f'<div class="c" data-s="{esc(st)}">{img}<div class="m"><b>{esc(r["file"])}</b>'
            f'<span class="st" style="background:{status_col.get(st, "#555")}">{esc(st)}</span><br>'
            f'<span class="big">{esc(score)}</span> <small>{esc(r.get("category") or "")}</small><br>'
            f'<small>{esc(str(r.get("method", "")))} · {esc(str(r.get("background", "")))} · {esc(app)}</small><br>'
            f'<small class="n">{esc(r.get("note") or "")}</small></div></div>')
    counts = {}
    for r in rows:
        counts[r.get("status", "")] = counts.get(r.get("status", ""), 0) + 1
    buttons = "".join(f'<button onclick="f(\'{esc(k)}\')">{esc(k)} ({v})</button>' for k, v in sorted(counts.items()))
    doc = f"""<!doctype html><meta charset="utf-8"><title>BLS batch report</title>
<style>body{{font:14px system-ui,sans-serif;margin:16px;background:#fafafa;color:#222}}
.g{{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}}
.c{{background:#fff;border:1px solid #ddd;border-radius:8px;overflow:hidden}}
.c img{{width:100%;height:260px;object-fit:contain;background:#222;display:block}}
.m{{padding:8px}}.big{{font-size:18px;font-weight:600}}.st{{color:#fff;border-radius:4px;padding:1px 6px;margin-left:6px;font-size:12px}}
.n{{color:#b26a00}}button{{margin:0 6px 12px 0;padding:4px 10px}}</style>
<h1>BLS batch report</h1>
<p>{len(rows)} photos. Left: photo. Right: green = healthy, yellow = chlorotic, red = necrotic, darkened = not counted as leaf.
“app” = what the phone app gives in black-board mode.</p>
<div><button onclick="f('')">All</button>{buttons}</div><div class="g" id="g">{''.join(cards)}</div>
<script>function f(s){{document.querySelectorAll('.c').forEach(function(c){{c.style.display=(!s||c.dataset.s===s)?'':'none'}})}}</script>"""
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(doc)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Batch-score BLS leaf photos.")
    ap.add_argument("photo_dir")
    ap.add_argument("-o", "--out", default="bls_output")
    ap.add_argument("--mode", choices=["auto", "board", "segment"], default="auto")
    ap.add_argument("--masks", help="folder of leaf masks (PNG, white = leaf), named like the photos")
    ap.add_argument("--workers", type=int, default=max(1, min(6, (os.cpu_count() or 2) - 1)))
    ap.add_argument("--no-overlays", action="store_true")
    ap.add_argument("--no-sam", action="store_true", help="do not use the SlimSAM leaf finder on field photos")
    ap.add_argument("--only", nargs="*", help="score only these file names")
    a = ap.parse_args(argv)

    files = sorted((f for f in os.listdir(a.photo_dir) if f.lower().endswith(EXTS)), key=natural_key)
    if a.only:
        files = [f for f in files if f in set(a.only)]
    if not files:
        sys.exit(f"No .jpg/.jpeg/.png photos in {a.photo_dir}")
    os.makedirs(a.out, exist_ok=True)
    ov = None if a.no_overlays else os.path.join(a.out, "overlays")
    if ov:
        os.makedirs(ov, exist_ok=True)

    use_sam = not a.no_sam
    if use_sam and not sam.available():
        print(f"Note: SlimSAM model files not found in {sam.MODEL_DIR}; field photos will be NEEDS_OUTLINE.")
    jobs = [(os.path.join(a.photo_dir, f), a.mode, a.masks, ov, use_sam, False) for f in files]
    rows = []

    def report(i, row):
        print(f"[{i}/{len(jobs)}] {row['file']}: {row.get('status')} "
              f"{row.get('diseased_pct', '')}% score {row.get('score', '-')}", flush=True)

    done = 0
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        for row in ex.map(process, jobs):
            rows.append(row)
            if not row.get("_sam_later"):
                done += 1
                report(done, row)
    # Field photos: SlimSAM leaf finder, one at a time (memory)
    for k, row in enumerate(rows):
        if row.get("_sam_later"):
            j = jobs[files.index(row["file"])]
            rows[k] = process(j[:5] + (True,))
            done += 1
            report(done, rows[k])

    write_csv(os.path.join(a.out, "results_photos.csv"), rows, PHOTO_COLS)
    write_csv(os.path.join(a.out, "results_samples.csv"), summarize_samples(rows), SAMPLE_COLS)
    write_report(os.path.join(a.out, "report.html"), rows, ov is not None)
    print(f"\nWrote {len(rows)} photos to {os.path.abspath(a.out)}")


if __name__ == "__main__":
    main()
