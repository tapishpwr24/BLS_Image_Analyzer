# BLS Leaf Scorer: roadmap

Developed by Tapish Pawar, Ameen Lab, South Dakota State University (SDSU).

## Current version (v1.0, `app/`)

Share page: <https://tapishpwr24.github.io/BLS_Image_Analyzer/> · App: <https://tapishpwr24.github.io/BLS_Image_Analyzer/app/>

The study version became the main app in v1.0. The former `/study/` address forwards to `/app/`;
ratings and settings saved under `/study/` are copied into `/app/` automatically on each device.

- Name first, then a 3-step guide; rater ID asked once, switch user from the top bar
- Rating mode: rate by eye (1–9 and % diseased) before the app shows its score; rating locked
- Phone data entry: plant ID with −/+ and next ID, number pad option, label scanning (Android), % chips
- Leaf finding ported from the Python analyzer (`app/leaffind.js`): any uniform background,
  labels and glare left out; AI leaf finder (SlimSAM) for field photos
- Photo sets: random order, hidden repeats (photo sets only), resume after interruption
- Data: stays on the device; optional Google Sheet + Drive (guided setup, team QR code);
  CSV export and ZIP backup
- Anonymous device count (`app/connectors/usage/Usage.gs`) and privacy notice (`app/privacy.html`)
- Python (`python/`): batch analyzer and rater-study evaluation (`bls_analyzer.study`)

## Next version

### 1. CVAT bridge (with the HPC team)
- **App → CVAT pre-annotations**: export photos with the app's leaf outline (and lesion areas)
  so annotators correct outlines instead of drawing them.
- **CVAT → evaluation**: read finished CVAT annotations into `bls_analyzer.study` and compare the
  app, the Python analyzer and every rater against pixel-level ground truth
  (leaf IoU, % diseased, chlorotic and necrotic area).
- Needed from the HPC team: export format (CVAT XML or COCO) and label names
  (for example leaf, healthy, chlorotic, necrotic).

### 2. Recalibrate the colour rules
Once about 100 leaves are annotated in CVAT: fit the healthy / chlorotic / necrotic rules to the
annotations and update the app and the Python analyzer together. Open question from the synthetic
test: the app's calibrated rules count pale green as chlorotic, the R/Python rules never detect
chlorosis.

### 3. Release
- Make `mobile-app` the default branch (or merge it into `main`)
- Publish on Google Play (PWABuilder); privacy notice and device count are in place

## Before then (lab pilot)
2–3 lab members rate about 20 leaves each through a team Google Sheet: check rows, Drive photos,
thumbnails, the Users tab, the device count, and label scanning on Android.
