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
- **Field photos (no black board):** switch the capture screen to *Field photo*. After each photo the app **finds the leaf edges automatically** with SlimSAM, a compact Segment Anything model that runs on the phone, offline, in about 2–6 s. Only the leaf is scored; soil and other plants are ignored. If it gets part of the outline wrong, tap a missed part (*+ Leaf*) or the background (*− Not leaf*). Each tap takes well under a second. *Draw by hand* is the fallback. In *Black board* mode the app warns when a photo has no black background and offers *Find the leaf*. The `Segmentation` column records the method (`auto`, `auto + taps`, `traced`, `black board`). Black-board photos remain the most reliable and match the R pipeline.
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
Overlay_URL`

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
