# BLS Analyzer (Python batch version)

Batch scoring of bacterial leaf streak (BLS) leaf photos, using the same engine
as the BLS Leaf Scorer web app (https://tapishpwr24.github.io/BLS_Image_Analyzer/app/),
which in turn reproduces `BLS_Image_Analyzer.R`.

## What it adds to the app

- **Whole folders at once** → CSV per photo and per sample, overlay images, and an HTML report.
- **Automatic leaf finding on any background**. The app/R method counts every pixel
  brighter than near-black as leaf, so board, paper, tape, labels, glare, soil and
  hands get scored. Here the leaf is found first and only those pixels go to the
  (unchanged) colour rules:
  - *Uniform backgrounds* (grey/black board, white paper): background colour from the
    photo border, colour distance + Otsu, glare removal, keep leaf-shaped pieces.
  - *Field photos* (soil, other plants, hands, Tech Board): the app's own SlimSAM
    leaf finder (`models/slimsam`, same files as "Find leaf edges"). Instead of one tap,
    up to 30 candidate points are tried (next to the fingers, near the centre, a grid);
    each candidate region is scored (long and thin, wide like a leaf held close, near
    the centre, plant-coloured, no skin, touching the hand) and the best one is used.
    Hands get "not leaf" points. Canopy / landscape photos (sky, no single leaf) are
    reported as `NO_SINGLE_LEAF` instead of being scored.
- **The app's own score is kept** next to it (`app_score`, `app_diseased_pct`) for comparison.

## Install (once)

```powershell
py -m pip install -r requirements.txt
```

The SlimSAM leaf-finder model (13 MB) is the same as the web app's. In the GitHub repo it is
read from `app/models/slimsam/`; a standalone copy can keep it in `models/slimsam/` instead.

## Run

```powershell
py -m bls_analyzer.batch "C:\path\to\photos" -o "C:\path\to\output"
```

Options:

| Option | Meaning |
|---|---|
| `--mode auto` | default: find the leaf on any uniform background |
| `--mode board` | exact app/R method, no leaf finding |
| `--masks DIR` | leaf masks (PNG, white = leaf) named like the photo, e.g. `106.png` for `106.JPG`; needed for field photos |
| `--only a.jpg b.jpg` | score just these files |
| `--no-overlays` | skip overlay images (faster) |
| `--workers N` | parallel processes |

## Output

- `results_photos.csv`: score, category, diseased/healthy/chlorotic/necrotic %, leaf pixels, method, status, notes
- `results_samples.csv`: photos grouped by sample ID from the file name
  (`BLS_SD_12.1`, `BLS_SD_12.2` → `BLS_SD_12`; `106`, `106-1` → `106`; `129 (2)` → `129`).
  Gives the mean of photo scores and the pixel-pooled score (as the app's "Add section").
- `overlays/`: photo | classified (green healthy, yellow chlorotic, red necrotic, dark = not leaf)
- `report.html`: every photo with its overlay; filter by status

Status: `OK`; `CHECK` (look at the overlay); `NO_SINGLE_LEAF` (canopy, plot or landscape
photo: nothing to score, or supply a mask); `NEEDS_OUTLINE` (only with `--no-sam`);
`FAILED`/`ERROR`.

Speed: board/paper photos run in parallel (`--workers`, ~1 s each); field photos use
SlimSAM one at a time (~8 s each on a laptop CPU, ~1 GB RAM).

## Known limits (from the calibrated R rules, unchanged on purpose)

- **Chlorotic is always 0 %.** R's `rgb2hsv()` was called with `maxColorValue = 255` on 0–1
  values, so V is tiny and the V-based rules never fire. Yellow chlorotic and straw-coloured
  senescent tissue (R > G > B) are counted as **necrotic**. Total diseased % is still
  computed; the chlorotic/necrotic split is not meaningful. Fixing it needs recalibration
  against visual scores (`V_DIVISOR = 1` in `engine.py` plus new thresholds).
- Field photos cannot be segmented automatically; use masks or the app's tracing.

## Rater study: combine all raters and evaluate the model

Raters use the app's Study mode (rate blind, then the app scores). Collect their data as app
backups (`.zip`, include photos) and/or the shared Google Sheet (File → Download → .xlsx), then:

```powershell
py -m bls_analyzer.study "C:\study\backups\*.zip" "C:\study\BLS_sheet.xlsx" -o "C:\study\results"
```

| Option | Meaning |
|---|---|
| `--key plot` | one leaf = one Plot_ID (default; in a photo set the ID is the file name) |
| `--key plot-leaf` / `--key image` | Plot_ID + Rep + Leaf_No, or the image file name |
| `--rescore` | also score every backed-up photo with this Python analyzer, so a changed model is tested on the same ratings |
| `--include-unblind` | also use ratings made after the app's score was shown |

`study_results.xlsx` has: **Agreement** (app and Python model vs the rater median and each rater:
Lin's CCC with 95% bootstrap CI, r, bias, MAE, weighted kappa, exact / within-one; each rater vs
the other raters next to the app on the same leaves; inter-rater ICC), **Per_leaf** (every
rater's score side by side with the model), **Raters** (bias, seconds per leaf, repeatability),
**Records** (all rows with a photo thumbnail) and **About** (definitions). `per_leaf.csv` is the
same table for R.

## Tests

```powershell
py -m unittest tests.test_engine -v
```

Checks the engine against the app's example leaf (BLS_02: 667,602 leaf px, 74.22 / 0 / 25.78 %, score 6).
