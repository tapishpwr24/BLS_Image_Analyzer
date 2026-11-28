"""
Combine BLS Leaf Scorer study data from all raters and evaluate the model.

Inputs (any mix, any number):
  *.zip   app backups (Records -> Settings -> Back up); photos are included
  *.csv   app CSV export, or the Google Sheet downloaded as CSV
  *.xlsx  the Google Sheet downloaded as Excel (File -> Download -> .xlsx)
Records are merged by Record_ID, so the same record arriving from a phone
backup and from the Sheet is counted once (the newest edit wins).

Output (in --out):
  study_results.xlsx  Records (with photo thumbnails when a backup has them),
                      Per_leaf (each rater's score side by side with the app),
                      Agreement (app vs raters; every rater vs the others),
                      Raters (bias, speed, repeatability), About (definitions)
  per_leaf.csv        the Per_leaf table for R / Python
  photos/             photos from the backups, named by Record_ID

Usage:
  py -m bls_analyzer.study backups\\*.zip sheet.xlsx -o study_out
  py -m bls_analyzer.study ... --rescore     # also score every photo with the
                                             # Python analyzer, so a changed model
                                             # is evaluated on the same ratings
Only ratings made blind (before the app's score was shown) are used, unless
--include-unblind is given.
"""
import argparse
import csv
import glob
import io
import json
import math
import os
import random
import sys
import zipfile
from collections import defaultdict

import numpy as np

NUM = ["Rep", "Leaf_No", "BLS_Score", "Total_Diseased_Percent", "Healthy_Percent", "Chlorotic_Percent",
       "Necrotic_Percent", "Visual_BLS_Score", "Visual_Diseased_Percent", "Rating_Seconds", "Leaf_Pixels"]


# ---------------------------------------------------------------- reading
def _num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return None if (isinstance(v, float) and math.isnan(v)) else float(v)
    s = str(v).strip().replace("%", "")
    if s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _rows_from_csv_text(text):
    text = text.lstrip("﻿")
    return [dict(r) for r in csv.DictReader(io.StringIO(text))]


def _rows_from_xlsx(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb["BLS_results"] if "BLS_results" in wb.sheetnames else wb.worksheets[0]
    it = ws.iter_rows(values_only=True)
    header = [str(h) if h is not None else "" for h in next(it)]
    rows = []
    for vals in it:
        if not any(v not in (None, "") for v in vals):
            continue
        rows.append({h: ("" if v is None else v) for h, v in zip(header, vals) if h})
    return rows


def read_inputs(paths, photo_dir):
    """Returns {Record_ID: row}. Rows from backups get '_photo' (path on disk)."""
    recs = {}
    files = []
    for p in paths:
        files.extend(sorted(glob.glob(p)) or [p])
    for path in files:
        ext = os.path.splitext(path)[1].lower()
        src = os.path.basename(path)
        if ext == ".zip":
            with zipfile.ZipFile(path) as z:
                rows = _rows_from_csv_text(z.read("BLS_results.csv").decode("utf-8"))
                photo_of = {}
                if "backup.json" in z.namelist():
                    for r in json.loads(z.read("backup.json").decode("utf-8")).get("records", []):
                        if r.get("photoFile"):
                            photo_of[r["id"]] = r["photoFile"]
                for row in rows:
                    pf = photo_of.get(row.get("Record_ID"))
                    if pf and pf in z.namelist():
                        os.makedirs(photo_dir, exist_ok=True)
                        out = os.path.join(photo_dir, row["Record_ID"] + ".jpg")
                        if not os.path.exists(out):
                            with open(out, "wb") as f:
                                f.write(z.read(pf))
                        row["_photo"] = out
        elif ext in (".xlsx", ".xlsm"):
            rows = _rows_from_xlsx(path)
        elif ext == ".csv":
            with open(path, encoding="utf-8-sig") as f:
                rows = _rows_from_csv_text(f.read())
        else:
            print(f"  skipped {src}: not a .zip, .csv or .xlsx", file=sys.stderr)
            continue
        n_new = 0
        for row in rows:
            rid = str(row.get("Record_ID") or "").strip()
            if not rid:
                continue
            row["_source"] = src
            old = recs.get(rid)
            if old is None:
                n_new += 1
            # newest edit wins; a backup's photo is kept either way
            if old is None or str(row.get("Edited_At") or "") >= str(old.get("Edited_At") or ""):
                if old is not None and old.get("_photo") and not row.get("_photo"):
                    row["_photo"] = old["_photo"]
                recs[rid] = row
            elif row.get("_photo") and not old.get("_photo"):
                old["_photo"] = row["_photo"]
        print(f"  {src}: {len(rows)} records ({n_new} new)")
    for row in recs.values():
        for k in NUM:
            row[k] = _num(row.get(k))
        for k in ("Rater", "Plot_ID", "Image_File", "Rating_Mode", "Trial"):
            row[k] = str(row.get(k) or "").strip()
    return recs


# ---------------------------------------------------------------- statistics
def ccc(x, y):
    x, y = np.asarray(x, float), np.asarray(y, float)
    if len(x) < 3:
        return None
    mx, my = x.mean(), y.mean()
    sxy = ((x - mx) * (y - my)).mean()
    d = x.var() + y.var() + (mx - my) ** 2
    return float(2 * sxy / d) if d > 0 else None


def boot_ci(x, y, fn=ccc, n=1000, seed=1):
    x, y = np.asarray(x, float), np.asarray(y, float)
    if len(x) < 8:
        return None, None
    rng = np.random.default_rng(seed)
    vals = []
    for _ in range(n):
        i = rng.integers(0, len(x), len(x))
        v = fn(x[i], y[i])
        if v is not None and np.isfinite(v):
            vals.append(v)
    if not vals:
        return None, None
    return float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))


def pearson(x, y):
    x, y = np.asarray(x, float), np.asarray(y, float)
    if len(x) < 3 or x.std() == 0 or y.std() == 0:
        return None
    return float(np.corrcoef(x, y)[0, 1])


def weighted_kappa(a, b, k=9):
    """Quadratic-weighted Cohen's kappa for 1..k scores."""
    a = np.clip(np.rint(np.asarray(a, float)).astype(int), 1, k) - 1
    b = np.clip(np.rint(np.asarray(b, float)).astype(int), 1, k) - 1
    if len(a) < 3:
        return None
    O = np.zeros((k, k))
    for i, j in zip(a, b):
        O[i, j] += 1
    E = np.outer(O.sum(1), O.sum(0)) / O.sum()
    W = np.array([[(i - j) ** 2 for j in range(k)] for i in range(k)]) / (k - 1) ** 2
    den = (W * E).sum()
    return float(1 - (W * O).sum() / den) if den > 0 else None


def icc_oneway(groups):
    """ICC(1) one-way random, unbalanced (each leaf rated by a different subset of raters)."""
    groups = [np.asarray(g, float) for g in groups if len(g) >= 2]
    if len(groups) < 3:
        return None
    N = sum(len(g) for g in groups)
    k = len(groups)
    grand = np.concatenate(groups).mean()
    ssb = sum(len(g) * (g.mean() - grand) ** 2 for g in groups)
    ssw = sum(((g - g.mean()) ** 2).sum() for g in groups)
    msb, msw = ssb / (k - 1), ssw / (N - k)
    n0 = (N - sum(len(g) ** 2 for g in groups) / N) / (k - 1)
    den = msb + (n0 - 1) * msw
    return float((msb - msw) / den) if den > 0 else None


def compare(x, y, sx, sy):
    """x, y = % diseased; sx, sy = 1-9 scores (paired lists, None allowed)."""
    p = [(a, b) for a, b in zip(x, y) if a is not None and b is not None]
    s = [(a, b) for a, b in zip(sx, sy) if a is not None and b is not None]
    out = {"n_pct": len(p), "n_score": len(s)}
    if p:
        a, b = np.array(p).T
        lo, hi = boot_ci(a, b)
        out.update(ccc_pct=ccc(a, b), ccc_pct_lo=lo, ccc_pct_hi=hi, r_pct=pearson(a, b),
                   bias_pct=float((a - b).mean()), mae_pct=float(np.abs(a - b).mean()))
    if s:
        a, b = np.array(s).T
        d = np.abs(np.rint(a) - np.rint(b))
        out.update(ccc_score=ccc(a, b), kappa_w=weighted_kappa(a, b), exact=float((d == 0).mean()),
                   within1=float((d <= 1).mean()), bias_score=float((a - b).mean()))
    return out


# ---------------------------------------------------------------- analysis
def leaf_key(row, key):
    if key == "image":
        return row["Image_File"] or row["Plot_ID"]
    if key == "plot-leaf":
        return "|".join([row["Plot_ID"], str(int(row["Rep"] or 1)), str(int(row["Leaf_No"] or 1))])
    return row["Plot_ID"] or row["Image_File"]


def rescore(recs):
    from . import batch
    todo = [r for r in recs.values() if r.get("_photo")]
    print(f"  re-scoring {len(todo)} photos with the Python analyzer…")
    for i, r in enumerate(todo, 1):
        res = batch.process((r["_photo"], "auto", None, None, True, True))
        r["Py_BLS_Score"] = res.get("score")
        r["Py_Diseased_Percent"] = res.get("diseased_pct")
        r["Py_Status"] = res.get("status")
        if i % 25 == 0:
            print(f"    {i}/{len(todo)}")


def build(recs, key, include_unblind):
    rated = [r for r in recs.values() if r["Rater"] and (r["Visual_BLS_Score"] is not None or r["Visual_Diseased_Percent"] is not None)]
    if not include_unblind:
        rated = [r for r in rated if r["Rating_Mode"].startswith("blind")]
    leaves = defaultdict(list)
    for r in rated:
        leaves[leaf_key(r, key)].append(r)
    raters = sorted({r["Rater"] for r in rated}, key=str.lower)
    has_py = any("Py_BLS_Score" in r for r in recs.values())

    per_leaf = []
    for k, rs in sorted(leaves.items(), key=lambda kv: kv[0]):
        by = defaultdict(list)
        for r in rs:
            by[r["Rater"]].append(r)
        pcts = [np.mean([x["Visual_Diseased_Percent"] for x in v if x["Visual_Diseased_Percent"] is not None])
                for v in by.values() if any(x["Visual_Diseased_Percent"] is not None for x in v)]
        scs = [np.mean([x["Visual_BLS_Score"] for x in v if x["Visual_BLS_Score"] is not None])
               for v in by.values() if any(x["Visual_BLS_Score"] is not None for x in v)]
        app_p = [r["Total_Diseased_Percent"] for r in rs if r["Total_Diseased_Percent"] is not None]
        app_s = [r["BLS_Score"] for r in rs if r["BLS_Score"] is not None]
        row = {"Leaf": k, "Trial": rs[0]["Trial"], "Image_File": rs[0]["Image_File"], "N_raters": len(by),
               "Raters_median_pct": float(np.median(pcts)) if pcts else None,
               "Raters_SD_pct": float(np.std(pcts, ddof=1)) if len(pcts) > 1 else None,
               "Raters_median_score": float(np.median(scs)) if scs else None,
               "App_pct": float(np.median(app_p)) if app_p else None,
               "App_score": float(np.median(app_s)) if app_s else None,
               "App_spread_pct": float(max(app_p) - min(app_p)) if len(app_p) > 1 else None}
        if has_py:
            pp = [r.get("Py_Diseased_Percent") for r in rs if r.get("Py_Diseased_Percent") is not None]
            ps = [r.get("Py_BLS_Score") for r in rs if r.get("Py_BLS_Score") is not None]
            row["Py_pct"] = float(np.median(pp)) if pp else None
            row["Py_score"] = float(np.median(ps)) if ps else None
        for rt in raters:
            v = by.get(rt, [])
            vp = [x["Visual_Diseased_Percent"] for x in v if x["Visual_Diseased_Percent"] is not None]
            vs = [x["Visual_BLS_Score"] for x in v if x["Visual_BLS_Score"] is not None]
            row[f"{rt}_pct"] = float(np.mean(vp)) if vp else None
            row[f"{rt}_score"] = float(np.mean(vs)) if vs else None
        per_leaf.append(row)

    # Agreement: model vs rater consensus, model vs each rater, each rater vs the others
    agree = []
    models = [("App (phone)", "App_pct", "App_score")]
    if has_py:
        models.append(("Python analyzer", "Py_pct", "Py_score"))
    for name, pk, sk in models:
        a = compare([l[pk] for l in per_leaf], [l["Raters_median_pct"] for l in per_leaf],
                    [l[sk] for l in per_leaf], [l["Raters_median_score"] for l in per_leaf])
        agree.append({"Compared": f"{name} vs rater median", **a})
        for rt in raters:
            a = compare([l[pk] for l in per_leaf], [l[f"{rt}_pct"] for l in per_leaf],
                        [l[sk] for l in per_leaf], [l[f"{rt}_score"] for l in per_leaf])
            agree.append({"Compared": f"{name} vs {rt}", **a})
    # "Model as one more rater": a rater vs the median of the OTHER raters, and the
    # app vs that same median on the same leaves. If the app's agreement is within
    # the raters' range, it rates like a member of the panel.
    for rt in raters:
        xs, ys, sx, sy, ap, asc = [], [], [], [], [], []
        for l in per_leaf:
            others_p = [l[f"{o}_pct"] for o in raters if o != rt and l[f"{o}_pct"] is not None]
            others_s = [l[f"{o}_score"] for o in raters if o != rt and l[f"{o}_score"] is not None]
            if (l[f"{rt}_pct"] is None and l[f"{rt}_score"] is None) or not (others_p or others_s):
                continue
            xs.append(l[f"{rt}_pct"]); ys.append(float(np.median(others_p)) if others_p else None)
            sx.append(l[f"{rt}_score"]); sy.append(float(np.median(others_s)) if others_s else None)
            ap.append(l["App_pct"]); asc.append(l["App_score"])
        if xs:
            agree.append({"Compared": f"{rt} vs other raters' median", **compare(xs, ys, sx, sy)})
            agree.append({"Compared": f"App vs other raters' median (leaves {rt} rated)", **compare(ap, ys, asc, sy)})

    # Inter-rater reliability
    icc_p = icc_oneway([[l[f"{rt}_pct"] for rt in raters if l[f"{rt}_pct"] is not None] for l in per_leaf])
    icc_s = icc_oneway([[l[f"{rt}_score"] for rt in raters if l[f"{rt}_score"] is not None] for l in per_leaf])

    # Per rater: bias vs consensus, speed, repeatability (same leaf rated twice)
    rater_rows = []
    for rt in raters:
        mine = [r for r in rated if r["Rater"] == rt]
        secs = [r["Rating_Seconds"] for r in mine if r["Rating_Seconds"] is not None]
        reps = defaultdict(list)
        for r in mine:
            if r["Visual_Diseased_Percent"] is not None:
                reps[leaf_key(r, key)].append(r["Visual_Diseased_Percent"])
        rep_pairs = [(v[0], v[1]) for v in reps.values() if len(v) >= 2]
        dev = [l[f"{rt}_pct"] - l["Raters_median_pct"] for l in per_leaf
               if l[f"{rt}_pct"] is not None and l["Raters_median_pct"] is not None and l["N_raters"] > 1]
        rater_rows.append({
            "Rater": rt, "Records": len(mine), "Leaves": len({leaf_key(r, key) for r in mine}),
            "Mean_seconds_per_leaf": float(np.mean(secs)) if secs else None,
            "Bias_vs_median_pct": float(np.mean(dev)) if dev else None,
            "Repeated_leaves": len(rep_pairs),
            "Repeatability_CCC_pct": ccc(*zip(*rep_pairs)) if len(rep_pairs) >= 3 else None,
        })
    return per_leaf, agree, rater_rows, raters, {"ICC_pct": icc_p, "ICC_score": icc_s,
                                                 "records_used": len(rated), "leaves": len(per_leaf)}


# ---------------------------------------------------------------- writing
ABOUT = [
    ("Rater median", "Median of the raters' estimates for a leaf (each rater's repeats averaged first): the consensus reference."),
    ("ccc_pct / ccc_score", "Lin's concordance correlation (1 = perfect agreement) on % diseased / on the 1-9 score. _lo/_hi = 95% bootstrap interval."),
    ("r_pct", "Pearson correlation (precision only; ignores bias)."),
    ("bias", "Mean of (first minus second). Positive bias_pct for 'App vs ...' = the app sees more disease."),
    ("mae_pct", "Mean absolute difference in % points."),
    ("kappa_w", "Quadratic-weighted Cohen's kappa on the 1-9 score."),
    ("exact / within1", "Share of leaves with the same score / within one score."),
    ("Model as one more rater", "Rows '<rater> vs other raters' median' show how well each human agrees with the rest of the panel. "
                                "The matching 'App vs other raters' median' row is on exactly the same leaves: if the app's ccc is within the raters' range, it rates like a panel member."),
    ("ICC", "One-way intraclass correlation between raters (unbalanced design): inter-rater reliability."),
    ("Repeatability", "CCC between a rater's first and second rating of the same leaf (hidden repeats)."),
    ("Blind", "Only ratings made before the app's score was shown (Rating_Mode = blind) are used unless --include-unblind."),
]


def _round(v, d=3):
    return round(v, d) if isinstance(v, float) and np.isfinite(v) else v


def write_outputs(out, recs, per_leaf, agree, rater_rows, summary, thumbs=True):
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter
    os.makedirs(out, exist_ok=True)

    cols = list(per_leaf[0].keys()) if per_leaf else ["Leaf"]
    with open(os.path.join(out, "per_leaf.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in per_leaf:
            w.writerow({k: _round(v) for k, v in r.items()})

    wb = openpyxl.Workbook()
    bold, head_fill = Font(bold=True), PatternFill("solid", fgColor="DDE7DA")

    def sheet(title, rows, columns, first=False):
        ws = wb.active if first else wb.create_sheet(title)
        ws.title = title
        ws.append(columns)
        for c in ws[1]:
            c.font, c.fill = bold, head_fill
        for r in rows:
            ws.append([_round(r.get(c)) for c in columns])
        ws.freeze_panes = "B2"
        for i, c in enumerate(columns, 1):
            ws.column_dimensions[get_column_letter(i)].width = max(9, min(34, len(str(c)) + 2))
        return ws

    acols = ["Compared", "n_pct", "ccc_pct", "ccc_pct_lo", "ccc_pct_hi", "r_pct", "bias_pct", "mae_pct",
             "n_score", "ccc_score", "kappa_w", "exact", "within1", "bias_score"]
    ws = sheet("Agreement", agree, acols, first=True)
    ws.append([])
    ws.append(["Inter-rater ICC (% diseased)", _round(summary["ICC_pct"])])
    ws.append(["Inter-rater ICC (1-9 score)", _round(summary["ICC_score"])])
    ws.append(["Records used", summary["records_used"]])
    ws.append(["Leaves", summary["leaves"]])
    ws.column_dimensions["A"].width = 52

    sheet("Per_leaf", per_leaf, cols)
    sheet("Raters", rater_rows, list(rater_rows[0].keys()) if rater_rows else ["Rater"])

    rcols = ["Photo", "Record_ID", "Timestamp", "Trial", "Plot_ID", "Rep", "Leaf_No", "Rater", "Image_File",
             "Rating_Mode", "Visual_BLS_Score", "Visual_Diseased_Percent", "Rating_Seconds", "Set_Position",
             "BLS_Score", "Total_Diseased_Percent", "Healthy_Percent", "Chlorotic_Percent", "Necrotic_Percent",
             "Py_BLS_Score", "Py_Diseased_Percent", "Py_Status", "Segmentation", "Rules", "Engine_Version",
             "QC_Status", "Notes", "Photo_URL", "_source"]
    rows = sorted(recs.values(), key=lambda r: (r.get("Plot_ID") or "", r.get("Rater") or "", str(r.get("Timestamp") or "")))
    ws = sheet("Records", rows, rcols)
    if thumbs:
        from openpyxl.drawing.image import Image as XLImage
        from PIL import Image
        tdir = os.path.join(out, "_thumbs")
        os.makedirs(tdir, exist_ok=True)
        ws.column_dimensions["A"].width = 16
        for i, r in enumerate(rows, start=2):
            p = r.get("_photo")
            if not p or not os.path.exists(p):
                continue
            t = os.path.join(tdir, os.path.basename(p))
            if not os.path.exists(t):
                im = Image.open(p).convert("RGB")
                im.thumbnail((110, 110))
                im.save(t, quality=80)
            img = XLImage(t)
            ws.add_image(img, f"A{i}")
            ws.row_dimensions[i].height = 86
    ws2 = wb.create_sheet("About")
    for k, v in ABOUT:
        ws2.append([k, v])
    ws2.column_dimensions["A"].width = 26
    ws2.column_dimensions["B"].width = 120
    for row in ws2.iter_rows():
        row[0].font = bold
        row[1].alignment = Alignment(wrap_text=True, vertical="top")
    path = os.path.join(out, "study_results.xlsx")
    wb.save(path)
    return path


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="backup .zip files, CSV exports, or the Google Sheet as .xlsx/.csv")
    ap.add_argument("-o", "--out", default="study_out")
    ap.add_argument("--key", choices=["plot", "plot-leaf", "image"], default="plot",
                    help="what identifies one leaf across raters: Plot_ID (default), Plot_ID+Rep+Leaf_No, or the image file name")
    ap.add_argument("--include-unblind", action="store_true", help="also use ratings made after the app's score was shown")
    ap.add_argument("--rescore", action="store_true", help="score the backed-up photos with the Python analyzer too")
    ap.add_argument("--no-thumbs", action="store_true")
    a = ap.parse_args(argv)

    print("Reading:")
    recs = read_inputs(a.inputs, os.path.join(a.out, "photos"))
    if not recs:
        sys.exit("No records found.")
    if a.rescore:
        rescore(recs)
    per_leaf, agree, rater_rows, raters, summary = build(recs, a.key, a.include_unblind)
    path = write_outputs(a.out, recs, per_leaf, agree, rater_rows, summary, thumbs=not a.no_thumbs)
    print(f"\n{len(recs)} records, {summary['records_used']} rated{' blind' if not a.include_unblind else ''}, "
          f"{summary['leaves']} leaves, {len(raters)} raters: {', '.join(raters) or '-'}")
    head = [r for r in agree if r["Compared"].endswith("vs rater median")]
    for r in head:
        c = r.get("ccc_pct")
        print(f"  {r['Compared']}: CCC % = {c:.2f} (n={r['n_pct']})" if c is not None else f"  {r['Compared']}: too few leaves")
    if summary["ICC_pct"] is not None:
        print(f"  inter-rater ICC (%): {summary['ICC_pct']:.2f}")
    print(f"Saved {path}")


if __name__ == "__main__":
    main()
