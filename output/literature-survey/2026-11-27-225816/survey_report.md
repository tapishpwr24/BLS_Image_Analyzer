# Literature Survey: Deep learning for bacterial leaf streak (BLS) severity estimation in wheat, on a smartphone

**Date:** 2026-11-27 | **Papers Found:** 407 unique (45 cited and verified) | **Date Range:** 2023–2026 for method searches; no limit for seminal and BLS-specific searches | **Search Queries:** 18

Scope: wheat first, barley tested later. Goal: a model and app that estimate BLS severity (% diseased leaf area and 1–9 score) from phone photos in the greenhouse and field.

Sources: OpenAlex (main source; plant pathology is mostly in journals), arXiv. Semantic Scholar was rate-limited and Consensus had reached its monthly limit. Every cited paper was matched to an OpenAlex record (`references.bib`).

**Bottom line:** No published study estimates BLS severity on wheat (or barley) leaves with deep learning. The closest work uses drone hyperspectral imaging (sanaeifar2025) or a different host and pathogen (rice BLS, chen2021). A two-stage phone model (find the leaf, then segment lesions) is proven for wheat stripe rust (liu2024: r > 0.96 with experts). So the method is established, but its application to BLS (diffuse streaks, chlorotic halos, confusion with senescence) is new and publishable.

## Paper Summary Table

| # | Title | Authors | Year | Venue | Citations | Notes |
|---|-------|---------|------|-------|-----------|-------|
| 1 | [High-Throughput UAV Hyperspectral Remote Sensing Pinpoints Bacterial Leaf Streak Resistance in Wheat](https://doi.org/10.3390/rs17162799) | Sanaeifar et al. | 2025 | Remote Sensing | 10 | Only image-based BLS severity in wheat found: drone hyperspectral, not leaf photos |
| 2 | [The translucens group of Xanthomonas translucens: pathogens causing BLS on cereals](https://doi.org/10.1111/mpp.12909) | Sapkota et al. | 2020 | Molecular Plant Pathology | 105 | Seminal BLS review: biology, re-emergence |
| 3 | [Evaluation of Spring Wheat Germplasm for Resistance to BLS](https://doi.org/10.1094/pdis-03-12-0303-re) | Kandel et al. | 2012 | Plant Disease | 56 | Visual BLS rating in breeding |
| 4 | [Pathogenic and Genetic Diversity of X. translucens pv. undulosa in North Dakota](https://doi.org/10.1094/phyto-07-11-0201) | Adhikari et al. | 2011 | Phytopathology | 66 | BLS pathogen diversity |
| 5 | [An Approach for Rice Bacterial Leaf Streak Disease Segmentation and Severity Estimation](https://doi.org/10.3390/agriculture11050420) | Chen et al. | 2021 | Agriculture | 127 | Closest DL analogue (rice, X. oryzae): U-Net with attention, beats DeepLabV3+ |
| 6 | [StripeRust-Pocket: Mobile-Based Deep Learning for Wheat Stripe Rust Severity](https://doi.org/10.34133/plantphenomics.0201) | Liu et al. | 2024 | Plant Phenomics | 34 | **Template for this project**: 2-stage phone model, leaf mIoU 98.7%, lesion mIoU 86.1%, r > 0.964 with 3 experts; model-assisted labelling cut annotation from 20 to 3 min per image |
| 7 | [Towards high throughput in-field detection and quantification of wheat foliar diseases](https://doi.org/10.1016/j.compag.2024.109854) | Zenkl et al. | 2025 | Computers and Electronics in Agriculture | 23 | 422 field leaf images; leaf IoU 0.96, necrosis IoU 0.77 under outdoor light |
| 8 | [Separating Disease and Senescence in Wheat Canopies](https://doi.org/10.34133/plantphenomics.0053) | Anderegg et al. | 2023 | Plant Phenomics | 33 | Chlorosis and necrosis tracked separately; semi-synthetic training data |
| 9 | [Classification of wheat diseases using DL with field and glasshouse images](https://doi.org/10.1111/ppa.13684) | Long et al. | 2023 | Plant Pathology | 92 | Mixing field and glasshouse images; generalisation |
| 10 | [Plant Disease Segmentation Networks for Fast Severity Estimation in Field Scenarios](https://doi.org/10.3390/agriculture15060583) | Zhao et al. | 2025 | Agriculture | 41 | Public field datasets incl. wheat stripe rust; light LinkNet models (2.9–11.5 M parameters) |
| 11 | [Automatic pixel-level annotation for plant disease severity estimation](https://doi.org/10.1016/j.compag.2025.111316) | Rezaei et al. | 2025 | Computers and Electronics in Agriculture | 24 | Vision-transformer auto-labelling of barley lesions |
| 12 | [Deep learning identification of visually similar foliar diseases in field-grown barley](https://doi.org/10.1186/s13007-026-01532-7) | Martello et al. | 2026 | Plant Methods | 0 | Multiclass beats single-disease models on lookalike lesions |
| 13 | [Wheat Stripe Rust Grading by DL with Attention and Mobile-Device Images](https://doi.org/10.3389/fpls.2020.558126) | Mi et al. | 2020 | Frontiers in Plant Science | 158 | Severity as fine-grained classification on phone images |
| 14 | [Semantic Segmentation of Wheat Stripe Rust Images Using Deep Learning](https://doi.org/10.3390/agronomy12122933) | Li et al. | 2022 | Agronomy | 37 | Lesion segmentation baseline in wheat |
| 15 | [Ranking Quantitative Resistance to Septoria tritici Blotch Using Automated Image Analysis](https://doi.org/10.1094/phyto-04-17-0163-r) | Karisto et al. | 2017 | Phytopathology | 118 | Image-based severity used to rank cultivars: breeding validation model |
| 16 | [Improved Method for Measuring Quantitative Resistance to Z. tritici by Image Analysis](https://doi.org/10.1094/phyto-01-16-0018-r) | Stewart et al. | 2016 | Phytopathology | 112 | Leaf-scan phenotyping in wheat |
| 17 | [ImageJ vs machine-learning image analysis for cassava bacterial blight](https://doi.org/10.1186/s13007-022-00906-x) | Elliott et al. | 2022 | Plant Methods | 52 | Xanthomonas lesions; few-shot classifier from 5 images |
| 18 | [Automatic Image-Based Plant Disease Severity Estimation Using Deep Learning](https://doi.org/10.1155/2017/2917536) | Wang et al. | 2017 | Comput. Intell. Neurosci. | 930 | Seminal: severity as classification |
| 19 | [Recent advances in plant disease severity assessment using CNNs](https://doi.org/10.1038/s41598-023-29230-7) | Shi et al. | 2023 | Scientific Reports | 177 | Review of 16 CNN severity studies |
| 20 | [Plant Disease Severity Estimated Visually, by Digital Photography and Image Analysis, and by Hyperspectral Imaging](https://doi.org/10.1080/07352681003617285) | Bock et al. | 2010 | Critical Reviews in Plant Sciences | 1155 | Seminal: severity measurement and accuracy |
| 21 | [From visual estimates to fully automated sensor-based measurements of plant disease severity](https://doi.org/10.1186/s42483-020-00049-8) | Bock et al. | 2020 | Phytopathology Research | 353 | Seminal: how to validate automated severity |
| 22 | [Standard Area Diagrams for Aiding Severity Estimation](https://doi.org/10.1094/phyto-02-17-0069-fi) | Del Ponte et al. | 2017 | Phytopathology | 155 | SAD design and validation |
| 23 | [Plant Disease Detection by Imaging Sensors](https://doi.org/10.1094/pdis-03-15-0340-fe) | Mahlein | 2015 | Plant Disease | 1754 | Seminal: sensors for phenotyping |
| 24 | [Image-based phenotyping of plant disease symptoms](https://doi.org/10.3389/fpls.2014.00734) | Mutka & Bart | 2015 | Frontiers in Plant Science | 374 | Seminal review |
| 25 | [Measuring plant disease severity in R: the pliman package](https://doi.org/10.1007/s40858-021-00487-5) | Olivoto et al. | 2022 | Tropical Plant Pathology | 27 | Colour palettes; already adopted in the app |
| 26 | [Leaf Doctor: A New Portable Application for Quantifying Plant Disease Severity](https://doi.org/10.1094/pdis-03-15-0319-re) | Pethybridge & Nelson | 2015 | Plant Disease | 247 | Seminal phone severity app (rule-based) |
| 27 | [Using Deep Learning for Image-Based Plant Disease Detection](https://doi.org/10.3389/fpls.2016.01419) | Mohanty et al. | 2016 | Frontiers in Plant Science | 6969 | Seminal: DL for plant disease |
| 28 | [Deep learning models for plant disease detection and diagnosis](https://doi.org/10.1016/j.compag.2018.01.009) | Ferentinos | 2018 | Computers and Electronics in Agriculture | 4583 | Seminal |
| 29 | [Automated Identification of NLB-Infected Maize from Field Imagery](https://doi.org/10.1094/phyto-11-16-0417-r) | DeChant et al. | 2017 | Phytopathology | 485 | Seminal: field DL for a streak-like disease |
| 30 | [Quantitative Phenotyping of NLB in UAV Images Using Deep Learning](https://doi.org/10.3390/rs11192209) | Stewart et al. | 2019 | Remote Sensing | 135 | Lesion instance segmentation, IoU 0.73 |
| 31 | [Segment Anything](https://doi.org/10.1109/iccv51070.2023.00371) | Kirillov et al. | 2023 | ICCV | 19743 | Seminal foundation model (leaf finder in the app) |
| 32 | [SlimSAM: 0.1% Data Makes Segment Anything Slim](https://doi.org/10.52202/079017-1246) | Chen et al. | 2024 | NeurIPS | 45 | The compressed SAM running in the app |
| 33 | [Leaf only SAM: zero-shot automated leaf segmentation](https://doi.org/10.1016/j.atech.2024.100515) | Williams et al. | 2024 | Smart Agricultural Technology | 76 | SAM + post-processing for leaves, no training data |
| 34 | [EMSAM: enhanced multi-scale SAM for leaf disease segmentation](https://doi.org/10.3389/fpls.2025.1564079) | Li et al. | 2025 | Frontiers in Plant Science | 43 | Plain SAM is weak on lesions; adds local and global modules |
| 35 | [Attention-based unsupervised prompt learning for SAM in leaf disease segmentation](https://doi.org/10.1016/j.knosys.2025.113652) | Tian et al. | 2025 | Knowledge-Based Systems | 13 | Automatic prompts for SAM on lesions |
| 36 | [PlantCaFo: few-shot plant disease recognition with foundation models](https://doi.org/10.1016/j.plaphe.2025.100024) | Jiang et al. | 2025 | Plant Phenomics | 46 | Foundation features with few labels |
| 37 | [Transformer-based few-shot learning for barley disease detection](https://doi.org/10.1016/j.compag.2024.109751) | Rezaei et al. | 2024 | Computers and Electronics in Agriculture | 33 | Few-shot in field barley (for the barley follow-up) |
| 38 | [U-Net](https://doi.org/10.48550/arxiv.1505.04597) | Ronneberger et al. | 2015 | MICCAI / arXiv | 18685 | Seminal segmentation architecture |
| 39 | [DeepLabV3+](https://doi.org/10.1007/978-3-030-01234-2_49) | Chen et al. | 2018 | ECCV | 24502 | Seminal; used in StripeRust-Pocket |
| 40 | [SegFormer](https://doi.org/10.48550/arxiv.2105.15203) | Xie et al. | 2021 | NeurIPS | 12073 | Efficient transformer segmenter (B0 fits phones) |
| 41 | [DINOv2](https://doi.org/10.48550/arxiv.2304.07193) | Oquab et al. | 2024 | TMLR | 14509 | Self-supervised features for low-label segmentation |
| 42 | [Automatic wound detection and size estimation using deep learning](https://doi.org/10.1371/journal.pcbi.1009852) | Carrión et al. | 2022 | PLoS Computational Biology | 76 | Cross-domain: area measurement from phone photos |
| 43 | [Semi-Supervised Active Learning in Automated Wound Image Segmentation](https://doi.org/10.3390/ijms24010706) | Curti et al. | 2022 | Int. J. Mol. Sci. | 37 | Cross-domain: fewer labels via active learning |
| 44 | [SAM Enhanced Pseudo Labels for Weakly Supervised Semantic Segmentation](https://doi.org/10.48550/arxiv.2305.05803) | Chen et al. | 2023 | arXiv | 136 | Cross-domain: SAM refines cheap labels |
| 45 | [Unimodal Distributions for Ordinal Regression](https://doi.org/10.1109/tai.2025.3549740) | Cardoso et al. | 2025 | IEEE Trans. Artificial Intelligence | 20 | Cross-domain: consistent ordinal 1–9 outputs |

---

## Theme Clusters

### Theme 1: BLS biology and how BLS is rated today

**Summary**: BLS (*Xanthomonas translucens* pv. *undulosa* on wheat) has re-emerged worldwide, and breeding for resistance is the main control (sapkota2020). Resistance screening relies on visual ratings in inoculated nurseries (kandel2012), which the only image-based BLS study calls labour-intensive and subjective (sanaeifar2025). That study used drone hyperspectral imaging, not leaf photos.

**Key Papers**: sapkota2020, kandel2012, adhikari2011, sanaeifar2025

**Contribution**: Establishes the need (objective, fast BLS scoring for breeding) and that no leaf-level deep learning method exists for BLS in wheat.

### Theme 2: How severity must be measured and validated

**Summary**: Visual estimates are biased and variable. Accuracy should be judged against true severity with Lin's concordance, and standard area diagrams improve raters (bock2010, bock2020, ponte2017). Rule-based phone and desktop tools (pethybridge2015, olivoto2022) set the earlier standard.

**Key Papers**: bock2010, bock2020, ponte2017, mahlein2015, mutka2015, pethybridge2015, olivoto2022

**Contribution**: Defines the statistics and the rater-study design reviewers in plant pathology expect (already in the plan).

### Theme 3: Deep learning severity estimation in wheat and related cereals

**Summary**: The strongest design is two-stage: segment the leaf, then segment lesions, and take severity as their area ratio (liu2024; also zhao2025, li2022). This beats treating severity as image classification (wang2017, mi2020; reviewed in shi2023). In-field work shows leaves can be segmented under outdoor light (leaf IoU 0.96), and necrosis well but not perfectly (IoU 0.77) (zenkl2025). Separating chlorosis, necrosis and senescence is possible but needs care (anderegg2023). Image-based severity has long been used to rank wheat cultivars (karisto2017, stewart2016).

**Key Papers**: liu2024, zenkl2025, anderegg2023, zhao2025, li2022, long2023, mi2020, wang2017, shi2023, karisto2017, stewart2016

**Contribution**: Gives the architecture, target accuracy (lesion mIoU ~0.8–0.86; r > 0.96 with experts) and breeding validation used by the strongest prior work.

### Theme 4: Bacterial streak and blight diseases in other crops

**Summary**: Rice BLS segmentation with an attention U-Net outperformed DeepLabV3+ and U-Net (chen2021). Cassava bacterial blight lesions were measured with ImageJ and a few-shot classifier trained on 5 images (elliott2022). For maize northern leaf blight, streak-like lesions were detected and segmented in field and drone images (dechant2017, stewart2019).

**Key Papers**: chen2021, elliott2022, dechant2017, stewart2019

**Contribution**: Shows that streak-shaped and water-soaked bacterial lesions can be segmented, and which architectures work.

### Theme 5: Foundation models and label-efficient learning for plant images

**Summary**: Segment Anything separates leaves without training (williams2024; kirillov2023), and SlimSAM makes it small enough for phones (chen2024). Plain SAM is weak on lesions themselves, so lesions need a trained segmenter or adapted SAM (li2025, tian2025). Few-shot and foundation-feature methods reduce labels (jiang2025, rezaei2024), and auto-labelling or model-assisted labelling cut annotation time (rezaei2025; liu2024: 20 to 3 minutes per image).

**Key Papers**: kirillov2023, chen2024, williams2024, li2025, tian2025, jiang2025, rezaei2024, rezaei2025, oquab2024

**Contribution**: Makes a 1,000-image project feasible: SAM for leaves (already in the app), a small trained model for lesions, and labelling assisted by models.

---

## Research Gaps

1. **No deep learning severity estimation for BLS on wheat or barley leaves.** The only image-based BLS work uses drone hyperspectral cameras (sanaeifar2025); rice BLS (chen2021) is a different host and pathogen. A validated phone-photo method for wheat BLS would be a first.

2. **Chlorotic halos versus necrosis are rarely quantified separately.** BLS lesions have water-soaked, necrotic and chlorotic parts. Most severity models use one "disease" class (liu2024, zhao2025). Anderegg2023 shows chlorosis and necrosis can be separated, but not for BLS lesions on single leaves.

3. **BLS versus lookalikes (senescence, other diseases) in the field.** Field leaves show natural senescence and co-infections. Multiclass models handle lookalikes better than single-disease models (martello2026), but no study addresses BLS lookalikes.

4. **Validation stops at pixel metrics.** Many deep learning severity papers report IoU or accuracy only (reviewed by shi2023). The plant pathology standard is concordance with true severity, comparison with raters with and without SADs, and breeding outcomes such as genotype ranking (bock2020, ponte2017, karisto2017). Few deep learning papers do all three.

5. **Phone deployment for bacterial diseases of cereals, offline.** Phone severity apps exist for wheat stripe rust (liu2024, mi2020). None covers bacterial streak, and none combines an on-phone foundation model for leaf separation with a lesion model that works offline.

6. **Annotation cost for diffuse lesions.** Model-assisted labelling cut stripe rust annotation from 20 to 3 minutes per image (liu2024). BLS halos have soft boundaries, so whether assisted labelling stays accurate for them is untested.

---

## Cross-Domain Findings

- **Medical wound measurement → leaf lesion area.** Measuring wound area from phone photos has the same structure: segment a region with soft edges under uncontrolled capture, then report area (carrion2022). Semi-supervised active learning reduced the labels needed for wound segmentation (curti2022). The same loop fits this project: train on a few hundred leaves, let the model pick the most uncertain photos from your 1,000, and label those next.

- **SAM-refined pseudo-labels → cheap lesion masks.** In weakly supervised segmentation, SAM sharpens coarse labels into usable masks (chen2023). Here, the app's taught-colour masks or a first model's output can be cleaned with SAM before a human corrects them. This combines rezaei2025 and liu2024 with chen2023.

- **Ordinal grading in medicine → the 1–9 BLS score.** Medical grading models use unimodal ordinal outputs so neighbouring grades get neighbouring probabilities (cardoso2025). A 1–9 output trained this way, alongside the % from segmentation, gives a calibrated score with an uncertainty that breeders can read.

- **Self-supervised features → fewer labels.** DINOv2 features transfer to segmentation with few labels (oquab2024), and plant few-shot methods build on such features (jiang2025). They can initialise the lesion model when only 200–400 leaves are annotated.

---

## Innovation Proposals

### Proposal 1: BLS-Seg, a two-stage phone model for wheat BLS severity (main paper)

**Description**: Keep the app's on-phone leaf finder (SlimSAM plus board detection) as stage 1. Train a lightweight lesion segmenter for stage 2, with four classes (healthy, chlorotic, necrotic, other/senescence) on your ~1,000 wheat photos. Report necrotic % and necrotic + chlorotic % (gaps 1, 2, 5; follows liu2024).

**Feasibility**:
- Data: 1,000 wheat photos on hand. Annotate 300–400 with model-assisted labelling and keep 100 untouched as a test set split by genotype or site.
- Compute: one GPU (university cluster or Colab). SegFormer-B0 or MobileNetV3-DeepLabV3+ trains in hours; export to ONNX and quantize to under 20 MB like the current leaf finder.
- Novelty: first deep learning severity estimation for wheat BLS from phone images, with separate chlorosis and necrosis. Fits Plant Phenomics, Plant Methods or Computers and Electronics in Agriculture.
- Timeline: 8–12 weeks to a validated model; 4 more weeks for the app integration and paper draft.

**Potential Weaknesses**: Halo boundaries are subjective, so annotator agreement sets a ceiling; measure it on 50 leaves. Field photos with senescence may be over-scored without enough "other" examples. Results from one site may not transfer.

**Landing Plan**:
1. MVP: annotate 100 leaves (stratified by severity) with the app's taught-colour masks plus SAM as pre-labels; train a binary diseased-versus-healthy segmenter; check severity concordance on 30 held-out leaves.
2. Add four classes, 300–400 leaves, genotype-split cross-validation; compare with the app's rule-based scoring.
3. Integrate into the app (same loading path as the leaf finder); validate on 100 new field photos and with raters.
- Success Metrics: lesion mIoU ≥ 0.75; Lin's ρc ≥ 0.9 against mask-derived severity; ρc with expert raters at least equal to the expert-to-expert ρc; 1–9 within-one agreement ≥ 90%.
- Fallback Strategy: if four classes fail on halos, train necrotic-only and report chlorosis from the colour rules; if field accuracy lags, report greenhouse and field separately and require the board for publication data.

### Proposal 2: Label-efficient training, getting to 300 labelled leaves fast

**Description**: Combine three cheap label sources: the app's taught-colour masks, SAM-refined pseudo-labels, and active learning that picks the most uncertain photos. People then only correct the masks. The aim is to cut annotation from about 15 to about 3 minutes per leaf (gap 6; carrion2022, curti2022, chen2023, liu2024).

**Feasibility**:
- Data: the same 1,000 photos; no new collection.
- Compute: modest; several short training rounds.
- Novelty: an annotation pipeline for diffuse bacterial lesions. Publishable as a methods section of Paper 2, or as a short Plant Methods paper.
- Timeline: 3–4 weeks, in parallel with Proposal 1.

**Potential Weaknesses**: Pseudo-labels may copy the colour rules' biases into the model. Active learning can over-select odd photos. Time savings must be measured, not assumed.

**Landing Plan**:
1. Export pre-labels for all 1,000 photos from the app engine into CVAT.
2. Correct 50 leaves and time it; compare with 20 leaves drawn from scratch.
3. Train, rank the rest by uncertainty, correct the top 100, retrain; repeat twice.
- Success Metrics: ≥ 3× faster annotation at equal mask agreement (IoU between corrected and from-scratch masks ≥ 0.85).
- Fallback Strategy: if pre-labels are poor for halos, use them only for the leaf outline and necrosis, and draw chlorosis by hand.

### Proposal 3: Breeder-grade outputs, an ordinal 1–9 score with uncertainty and ranking validation

**Description**: Add a second output that predicts the 1–9 score with an ordinal head (cardoso2025) next to the segmentation %, plus a confidence flag. Validate the app as breeders would: genotype ranking and heritability against visual ratings (gap 4; bock2020, karisto2017).

**Feasibility**:
- Data: visual 1–9 ratings from the app's rater field and the rater study; genotype IDs for your photos.
- Compute: small; the ordinal head trains on top of the segmenter's features.
- Novelty: few deep learning severity papers report heritability or rank correlation with breeders' scores. This is the strongest selling point for Plant Disease or a breeding journal.
- Timeline: 4–6 weeks once ratings exist.

**Potential Weaknesses**: Needs enough genotypes (≥ 20) with replicates. Visual ratings are noisy, so agreement is bounded by rater reliability.

**Landing Plan**:
1. Record a visual 1–9 score on 200+ photos with genotype and rep, using the app's scale.
2. Fit mixed models: heritability and Spearman rank correlation of genotype means, app versus visual.
3. Use the confidence flag to send uncertain photos for a second look in the app.
- Success Metrics: rank correlation ≥ 0.8 with expert genotype means; heritability at least equal to visual scoring.
- Fallback Strategy: if genotypes are too few, report repeatability and rater agreement only, and plan heritability for the next season.

---

## References

See `references.bib` in this directory for complete BibTeX entries. All 45 cited papers were matched to OpenAlex records by title (similarity ≥ 0.85), and DOIs are included.

---

**Generated**: 2026-11-27 | **Tool**: literature-survey skill v1.0 (searches run against OpenAlex and arXiv; Semantic Scholar rate-limited; the skill's BibTeX script failed on a pybtex import, so the BibTeX was built from OpenAlex metadata)
