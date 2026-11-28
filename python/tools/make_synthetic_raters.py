"""
Synthetic rater panel for testing the rating app and bls_analyzer.study.

Picks photos spread over the severity range, copies them (resized like the app
stores them), and writes plan.json: for each simulated rater, the photo set
(with hidden repeats) and the % / 1-9 score that rater "gives" each photo.

Reference severity = the Python analyzer's diseased % (results_photos.csv).
Rater profiles mimic common visual-rating errors (Bock et al.):
  R01 experienced:   small random error, no bias
  R02 novice:        overestimates (x1.15 + 5 points), rounds to 5 %
  R03 inconsistent:  large random error, slight underestimate, rounds to 10 %

  py tools/make_synthetic_raters.py PHOTO_DIR results_photos.csv OUT_DIR [--n 15] [--repeats 3]
"""
import argparse
import csv
import json
import os
import random

from PIL import Image, ImageOps

SCALE = [(0.5, 1), (2, 2), (6, 3), (12, 4), (25, 5), (40, 6), (60, 7), (75, 8)]
PROFILES = {
    "R01": dict(mult=1.00, add=0.0, sd=4.0, round_to=1, jitter=0.10, secs=(8, 15)),
    "R02": dict(mult=1.15, add=5.0, sd=6.0, round_to=5, jitter=0.15, secs=(5, 10)),
    "R03": dict(mult=1.00, add=-2.0, sd=10.0, round_to=10, jitter=0.25, secs=(10, 25)),
}


def score(p):
    for lim, s in SCALE:
        if p <= lim:
            return s
    return 9


def rate(truth, prof, rng):
    p = truth * prof["mult"] + prof["add"] + rng.gauss(0, prof["sd"])
    p = max(0.0, min(100.0, p))
    if prof["round_to"] > 1:
        p = round(p / prof["round_to"]) * prof["round_to"]
    s = score(p)
    if rng.random() < prof["jitter"]:          # score not exactly consistent with the % given
        s = max(1, min(9, s + rng.choice([-1, 1])))
    return {"pct": round(p, 1), "score": s, "secs": round(rng.uniform(*prof["secs"]), 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("photo_dir")
    ap.add_argument("results_csv")
    ap.add_argument("out_dir")
    ap.add_argument("--n", type=int, default=15)
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    rng = random.Random(a.seed)

    rows = [r for r in csv.DictReader(open(a.results_csv, encoding="utf-8-sig"))
            if r["status"] == "OK" and r["file"].startswith("BLS_SD") and r.get("diseased_pct")]
    rows.sort(key=lambda r: float(r["diseased_pct"]))
    # spread over the severity range: one photo from each of n equal slices
    pick = [rows[int((i + 0.5) * len(rows) / a.n)] for i in range(a.n)]

    pdir = os.path.join(a.out_dir, "photos")
    os.makedirs(pdir, exist_ok=True)
    for r in pick:
        im = ImageOps.exif_transpose(Image.open(os.path.join(a.photo_dir, r["file"]))).convert("RGB")
        im.thumbnail((1600, 1600))
        im.save(os.path.join(pdir, os.path.splitext(r["file"])[0] + ".jpg"), quality=90)

    plan = {"reference": {}, "raters": {}}
    for r in pick:
        plan["reference"][os.path.splitext(r["file"])[0]] = {"pct": float(r["diseased_pct"]), "score": int(r["score"])}
    for rid, prof in PROFILES.items():
        files = [os.path.splitext(r["file"])[0] + ".jpg" for r in pick]
        files += rng.sample(files, a.repeats)            # hidden repeats
        ratings = {}
        for f in files:
            stem = os.path.splitext(f)[0]
            ratings.setdefault(stem, []).append(rate(plan["reference"][stem]["pct"], prof, rng))
        plan["raters"][rid] = {"files": files, "ratings": ratings, "profile": prof}
    with open(os.path.join(a.out_dir, "plan.json"), "w") as f:
        json.dump(plan, f, indent=1)
    print(f"{len(pick)} photos, {len(PROFILES)} raters, {len(files)} ratings each -> {a.out_dir}")
    for stem, v in plan["reference"].items():
        print(f"  {stem:16s} {v['pct']:6.2f}%  score {v['score']}")


if __name__ == "__main__":
    main()
