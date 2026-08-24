# BLS Image Analyzer: Scoring and Image Classification Method

## Overview

BLS Image Analyzer uses pixel-based image analysis to quantify visible bacterial leaf streak (BLS) symptoms from leaf images.

The current workflow consists of:

1. Image import
2. Leaf/background separation
3. RGB color extraction
4. RGB-to-HSV conversion
5. Pixel classification
6. Disease severity calculation
7. Conversion of disease severity to a 1–9 BLS rating
8. Quality control and visualization

---

## 1. Image Input

The current version is designed primarily for leaf images photographed against a dark or black background.

Supported image formats include:

- JPG
- JPEG
- PNG

Images are resized to a maximum dimension of 900 pixels during analysis to improve computational efficiency while preserving the aspect ratio.

---

## 2. RGB Color Extraction

Each image is converted to RGB color information.

For every pixel, red (R), green (G), and blue (B) intensity values are scaled to the interval:

```text
0–1
```

where 0 represents minimum intensity and 1 represents maximum intensity.

---

## 3. RGB-to-HSV Conversion

RGB pixel values are converted to HSV color space.

HSV consists of:

- **Hue (H):** dominant color
- **Saturation (S):** color intensity or purity
- **Value (V):** brightness

HSV information is used together with RGB relationships to distinguish healthy, chlorotic, and necrotic leaf tissue.

---

## 4. Leaf/Background Segmentation

The current implementation separates leaf pixels from the dark background using the summed RGB intensity.

A pixel is considered part of the leaf when:

```text
R + G + B > 0.20
```

Pixels that do not satisfy this condition are treated as background and excluded from disease-severity calculations.

Images containing fewer than 100 detected leaf pixels are rejected.

---

## 5. Pixel Classification

Detected leaf pixels are assigned to one of three mutually exclusive classes:

1. Healthy
2. Chlorotic
3. Necrotic

Classification is performed in hierarchical order.

Necrotic pixels are identified first, followed by chlorotic pixels. Remaining detected leaf pixels are classified as healthy.

This prevents individual pixels from belonging to more than one symptom class.

---

## 6. Necrotic Tissue

Necrotic tissue is identified using HSV thresholds and RGB color relationships.

The primary HSV criterion is:

```text
Hue:        0.02–0.10
Saturation: >= 0.15
Value:      0.10–0.50
```

An additional RGB-based condition identifies dark brown/red tissue when:

```text
R > G
G > B
Saturation >= 0.12
Value <= 0.55
```

A leaf pixel satisfying either necrotic condition is classified as necrotic.

---

## 7. Chlorotic Tissue

Chlorotic tissue is identified only among leaf pixels that have not already been classified as necrotic.

The primary HSV criterion is:

```text
Hue:  0.10–0.24
Value: >= 0.28
```

An additional RGB-based criterion is:

```text
R >= 0.90 × G
G > 1.03 × B
Value >= 0.30
Saturation >= 0.04
```

A non-necrotic leaf pixel satisfying either chlorotic condition is classified as chlorotic.

---

## 8. Healthy Tissue

Healthy tissue is defined as detected leaf tissue that is neither necrotic nor chlorotic.

Conceptually:

```text
Healthy =
Leaf
AND NOT Necrotic
AND NOT Chlorotic
```

Therefore, the three classes are mutually exclusive.

---

## 9. Disease Severity Calculation

For each image, the proportions of healthy, chlorotic, and necrotic pixels are calculated relative to the total number of detected leaf pixels.

### Healthy proportion

```text
Healthy pixels / Total leaf pixels
```

### Chlorotic proportion

```text
Chlorotic pixels / Total leaf pixels
```

### Necrotic proportion

```text
Necrotic pixels / Total leaf pixels
```

Total diseased proportion is calculated as:

```text
Diseased proportion =
Chlorotic proportion + Necrotic proportion
```

Disease severity percentage is therefore:

```text
Diseased area (%) =
100 × (Chlorotic pixels + Necrotic pixels) / Total leaf pixels
```

---

## 10. BLS 1–9 Rating

The current implementation converts image-derived diseased leaf area into a 1–9 BLS rating.

| BLS rating | Diseased leaf area (%) |
|---:|---:|
| 1 | 0–0.5 |
| 2 | >0.5–2 |
| 3 | >2–6 |
| 4 | >6–12 |
| 5 | >12–25 |
| 6 | >25–40 |
| 7 | >40–60 |
| 8 | >60–75 |
| 9 | >75 |

The continuous disease percentage is retained in the output in addition to the 1–9 rating.

### Important note

These percentage intervals represent the rating conversion implemented in the current version of BLS Image Analyzer.

They should not be interpreted as a universal BLS disease-rating standard without independent validation.

Users applying the method under substantially different experimental or imaging conditions should evaluate the relationship between image-derived disease severity and their reference disease assessments.

---

## 11. Disease Categories

For convenient interpretation, BLS scores are additionally grouped into descriptive categories.

| BLS score | Category |
|---:|---|
| 1 | Resistant |
| 2–3 | Moderately Resistant |
| 4–5 | Moderately Susceptible |
| 6–7 | Susceptible |
| 8–9 | Highly Susceptible |

These categories are secondary interpretations of the image-derived BLS score.

---

## 12. Classification Overlay

The software produces a semi-transparent classification overlay.

| Tissue | Overlay color |
|---|---|
| Healthy | Green |
| Chlorotic | Yellow |
| Necrotic | Red |

The default overlay transparency is controlled by:

```r
OVERLAY_ALPHA <- 0.45
```

The original image remains visible beneath the classification layer to facilitate visual quality control.

---

## 13. Quality Control

Because healthy, chlorotic, and necrotic pixels are mutually exclusive and together represent the detected leaf area:

```text
Healthy proportion
+ Chlorotic proportion
+ Necrotic proportion
= 1
```

The software checks this relationship for every successfully analyzed image.

A classification is reported as:

```text
PASS
```

when the absolute deviation from 1 is less than:

```text
1 × 10^-6
```

Users should also visually inspect classification overlays and diagnostic figures.

---

## 14. Diagnostic Outputs

BLS Image Analyzer generates diagnostic figures containing:

- Original image
- Classification overlay
- BLS rating
- Hue distribution
- Brightness distribution
- Healthy/chlorotic/necrotic proportions

These outputs allow users to visually evaluate whether the automated pixel classification agrees with the observed leaf symptoms.

---

## 15. Classification Parameters

The principal configurable parameters in version 1.0.0 include:

| Parameter | Default |
|---|---:|
| Leaf RGB sum threshold | 0.20 |
| Necrotic H minimum | 0.02 |
| Necrotic H maximum | 0.10 |
| Necrotic S minimum | 0.15 |
| Necrotic V minimum | 0.10 |
| Necrotic V maximum | 0.50 |
| Chlorotic H minimum | 0.10 |
| Chlorotic H maximum | 0.24 |
| Chlorotic V minimum | 0.28 |
| Overlay alpha | 0.45 |

Additional RGB and HSV conditions are implemented directly in the classification function.

---

## 16. Recommended Use

For quantitative experiments, users should maintain consistent:

- Camera settings
- Lighting
- Image exposure
- Camera-to-leaf distance
- Background
- Image-processing procedures

Classification performance should be evaluated using representative images before large-scale analysis.

---

## 17. Limitations

The method is based primarily on pixel color characteristics.

Consequently, pixels with similar RGB/HSV characteristics may be classified similarly even when their biological causes differ.

Potential sources of classification error include:

- Leaf senescence
- Nutrient deficiency
- Other diseases
- Mechanical damage
- Shadows
- Reflections
- Uneven lighting
- Image overexposure
- Image underexposure

BLS Image Analyzer therefore quantifies visible symptom-associated image characteristics and does not independently diagnose the causal pathogen.

---

## Software Version

**BLS Image Analyzer v1.0.0**

This document describes the classification and scoring method implemented in version 1.0.0.