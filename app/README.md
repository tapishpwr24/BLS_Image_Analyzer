# BLS Leaf Scorer (mobile app)

A phone app for BLS Image Analyzer. Take a photo of a leaf on a black background and get the
BLS score (1–9), diseased leaf area and disease-response category in about a second. Each record is
saved on the phone and copied to storage the user chooses.

- **Works offline.** Scoring runs on the phone, and records wait on the phone until there is signal.
- **Same results as the R script.** `app/engine.js` is a port of `BLS_Image_Analyzer.R`.
  `node tools/verify_engine.js` checks it against `example_output/BLS_results.csv`.
- **Bring your own storage.** This phone only (CSV export), Google Sheets + Drive, or any webhook
  (Zapier, Make, n8n, Power Automate, a lab server). Excel/OneDrive, Airtable and Supabase are next.
- **Install it like an app.** It's a Progressive Web App, so there's no app store. Open the link,
  then *Add to Home Screen*.

## Features

- **Score a leaf** from a camera or gallery photo: BLS score 1–9, diseased leaf area, category, and a colour overlay to check the classification.
- **Automatic leaf detection, any background.** Every photo is checked automatically:
  - *Black board or cloth*: leaves are separated by colour (dark-grey board, texture, dust, labels and tape are ignored). Several leaves in one photo are each scored, with an overall score.
  - *Field photos* (soil, other plants, a hand): the on-phone AI leaf finder (SlimSAM) tries several starting points in the middle of the photo and keeps the most leaf-like result.
  - *Photos already cropped to the leaf*: the whole photo is scored.
  - *Adjust leaf edges* lets you correct it: tap a missed part (*+ Leaf*) or background (*− Not leaf*), or draw by hand. The `Segmentation` column records the method (`board`, `auto`, `auto + taps`, `traced`, `whole photo`).
- **Teach the colours** (idea from pliman and PlantCV): under any result, tap *Teach colours*, choose *Healthy*, *Chlorotic* or *Necrotic*, and brush over examples on the leaf. *Result* previews the scoring live. The examples become a naive Bayes pixel classifier over hue, saturation and brightness histograms, as in PlantCV's multiclass naive Bayes. Examples from several photos add up, pooled palettes worked best in pliman's validation, and the taught colours are shared with the team through the setup link.
- **Lesions** (as in pliman): number of lesions, average and largest lesion size as % of the leaf (`Lesion_Count`, `Mean_Lesion_Size_Percent`). On heavily streaked leaves, streaks merge into large patches.
- **Agreement with raters** (Bock et al.): tap an optional visual 1–9 BLS score per leaf on the scale under the photo. The Summary then reports **Lin's concordance correlation (ρc)** between the app's score and the raters' scores, plus % exact and within-one agreement, precision r, accuracy Cb and average bias. This is the standard way to validate severity methods.
- **Scoring rules** (Settings):
  - *Calibrated v2* (default) is tuned on real phone photos. Hue on the correct brightness scale: green (≥ 68°) is healthy; yellow (48–68°, saturation ≥ 0.30) is chlorotic; tan, brown, straw or very dark (< 48°) is necrotic.
  - *Taught colours* uses your own examples (see above).
  - *R script v1.0* reproduces `BLS_Image_Analyzer.R` exactly. It never detects chlorosis (the `rgb2hsv` scaling bug, see below) and needs photos cropped to the leaf.
  - Each record stores the rules used (`Rules` column), plus `Leaf_Count`, `Per_Leaf_Diseased_Percent` and `Per_Leaf_BLS_Score`.
- **Long leaves:** tap *Add section* to photograph the rest of the leaf. Pixel counts from all sections are added up, so the score covers the whole leaf (`Sections` column).
- **Plot list:** load your field book (a CSV with a `plot` column, plus optional genotype/entry, rep and trial). Plot IDs then autocomplete, genotype and rep fill in, the app warns about unknown or already-scored plots, offers *Next plot in list* after saving, and shows *Plots scored 34 / 120* with the list still to do.
- **Edit a saved record** (plot, genotype, rep, leaf, trial, rater, notes). The score comes from the photo and can't be edited. Edits are re-synced, with `Edited_At` set and webhook event `update`.
- **Summary** by genotype (means of plot means ± SE across plots, most resistant first) or by plot (± SE across leaves), exportable as CSV.
- **Backup and restore:** one ZIP with `BLS_results.csv`, `backup.json`, and all photos and overlays. Restoring onto another phone skips records it already has.

## Leaf finder (bundled, about 25 MB, downloaded once)

- `models/slimsam/`: SlimSAM-77 quantized ONNX (Apache-2.0), from Xenova/slimsam-77-uniform
- `vendor/ort/`: ONNX Runtime Web 1.20.1 (MIT)
- `segment.js`: preprocessing, prompt from the photo centre, mask clean-up (keeps the region connected to the leaf, fills lesion holes)
- `sw.js` adds cross-origin isolation headers so the model can use several CPU cores (about 3× faster), and caches the model permanently after the first download.

Fonts (`vendor/fonts`, SIL OFL) and the QR library (`vendor/qrcode.js`, MIT) are also bundled, so the app needs nothing from other websites.

## Run it locally

```bash
cd app
python3 -m http.server 8000
```

Open http://localhost:8000. The camera and offline mode need HTTPS when you open the app from a
phone, so use the hosted version for field work.

## Host it for free (GitHub Pages)

1. Push this branch to `main`.
2. Repository **Settings → Pages → Source: GitHub Actions**.
3. `.github/workflows/deploy-app.yml` publishes `app/` to
   `https://<user>.github.io/BLS_Image_Analyzer/`, and redeploys on every push that changes `app/`.

## Installing on phones

Send users the link. The app shows each phone the right steps:

| Phone | How to install |
|---|---|
| Android (Chrome, Edge, Samsung Internet) | Tap **Install app** in the app, or browser menu ⋮ → **Install app** |
| iPhone / iPad (Safari) | **Share** → **Add to Home Screen** → **Add** |

After installing, the app opens full-screen from its own icon and works with no internet. Stored
records are marked as protected so the phone doesn't clear them. iPhones clear data for websites
that haven't been used in 7 days, but apps added to the Home Screen are exempt, so iPhone users
should always open the app from the Home Screen icon.

**App stores:** the same code can be packaged with Capacitor for Google Play ($25 one-time) and the
App Store ($99/year, and the iPhone build needs a Mac with Xcode). This isn't needed for field use.

## Rating mode (raters versus the model)

Always on (from v1.0, when the study version became the main app). It collects unbiased visual ratings next to the app's
score, so the model can be evaluated against a panel of raters and then improved.

1. **Take photo**, **Gallery**, or **Rate a set of photos** (pick many photos from the gallery; they
   come one at a time in random order).
2. The rater sees **only the original photo** and enters their **rater ID**, the **plant / image ID**
   (filled from the file name in a set), a **1–9 score** and an optional **% diseased** estimate.
3. **Lock rating · show app score.** Only now does the app find the leaf and score it. The screen
   shows rater and app side by side. The rating is locked; changing it later in Records marks it
   `blind, edited after`.
4. **Save record.** In a set, the next photo opens straight away.

Each record stores `Rater`, `Plot_ID`, `Image_File`, the app's results, and `Visual_BLS_Score`,
`Visual_Diseased_Percent`, `Rating_Mode` (`blind` / `after app score`), `Rating_Seconds`, `Rated_At`,
`Set_Position`. Records go to the phone first, then to the shared Google Sheet (with an in-cell
photo thumbnail) when online; **Settings → Back up** makes a ZIP with photos as a second copy.
The team setup link also carries the study settings, so every rater's phone is set up the same way.

Combine all raters and evaluate the model with the Python tool (`BLS_Analyzer_py`):
`py -m bls_analyzer.study backups\*.zip sheet.xlsx -o study_out [--rescore]`. It gives CCC,
bias, weighted kappa, inter-rater ICC, per-rater bias, speed and repeatability, and whether the
model agrees with the panel as well as the raters agree with each other.

## Storage options

| Option | Setup | Where data goes |
|---|---|---|
| This phone only | None | On the phone; **Records → Export CSV** |
| Google Sheets + Drive | Paste `connectors/google-sheets/Code.gs` into your Sheet (instructions at the top of that file) | A `BLS_results` tab, with photos in a Drive folder |
| Webhook | Paste a URL, plus an optional auth header | Your platform receives `{ event, columns, row, photo_jpeg_base64, overlay_jpeg_base64 }` |

**Team setup:** in **Settings → Set up a team**, team members scan the QR code or open the setup
link, then tap *Join team* to use the same storage and trial.

To add another platform, add one object to `connectors/connectors.js` (see the comment at the top
of the file).

## Record columns

`Record_ID, Timestamp, Trial, Plot_ID, Genotype, Rep, Leaf_No, Rater, Image_File, Leaf_Pixels,
Healthy_Pixels, Chlorotic_Pixels, Necrotic_Pixels, Healthy_Percent, Chlorotic_Percent,
Necrotic_Percent, Total_Diseased_Percent, BLS_Score, Disease_Response, QC_Status, Latitude,
Longitude, GPS_Accuracy_m, Notes, Image_Width, Image_Height, Engine_Version, Device, Photo_URL,
Overlay_URL, Sections, Edited_At, Segmentation, Rules, Leaf_Count, Per_Leaf_Diseased_Percent,
Per_Leaf_BLS_Score, Lesion_Count, Mean_Lesion_Size_Percent, Visual_BLS_Score,
Visual_Diseased_Percent, Rating_Mode, Rating_Seconds, Rated_At, Set_Position`
(the Google Sheet adds a `Photo` thumbnail column)

## Note on the scoring engine (`V_DIVISOR`)

In `BLS_Image_Analyzer.R`, `rgb2hsv()` receives values already scaled to 0–1, but its
`maxColorValue` argument defaults to 255. That makes R's brightness (V) 255 times too small.
As a result:

- the V-based necrotic rule and both chlorotic rules never fire, so chlorotic area is always 0%;
- necrotic pixels are in practice those where R > G > B and saturation ≥ 0.12.

The app reproduces this behaviour (`V_DIVISOR: 255` in `engine.js`) so its numbers match the
published R results exactly. Setting `V_DIVISOR: 1` gives the method as documented. With the
current thresholds, though, that version classifies most of the yellow-green leaf surface as
chlorotic (about 96–98% diseased on all three example leaves), so the thresholds would need
recalibrating first.

## Background: tools and studies this builds on

- **pliman** (Olivoto, Andrade & Del Ponte 2022, *Tropical Plant Pathology*): severity from user colour palettes, lesion counts and shapes. A pooled palette from several people gave ρc > 0.98 against other software for most diseases.
- **PlantCV** (Danforth Center): naive Bayes pixel classifier trained on user-sampled pixels per class (e.g. plant, chlorosis, pustule, background).
- **Leaf Doctor** (Pethybridge & Nelson 2015, *Plant Disease* 99:1310): the user taps healthy colours and adjusts a threshold. Agreement with Assess: R² ≥ 0.79, Cb ≥ 0.96.
- **Bock and colleagues**: validation of visual and image-based severity estimates with Lin's concordance correlation.
- **Segment Anything / SlimSAM**: on-phone leaf separation in field photos.
