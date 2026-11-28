# Evaluation Report: BLS rater study and on-phone model

Target venue: Plant Phenomics · Threshold: 7/10 on all dimensions · Literature: survey of 407 papers (45 verified) plus 5 supplementary references on rater studies and usability.

Closest prior work used for novelty and positioning:
- StripeRust-Pocket, a two-stage phone model for wheat stripe rust, validated with 3 experts [Liu et al., 2024, Plant Phenomics]
- In-field wheat foliar disease quantification [Zenkl et al., 2025]
- BLS resistance in wheat from drone hyperspectral imaging [Sanaeifar et al., 2025]
- Rice BLS segmentation [Chen et al., 2021]
- Visual severity: rater bias and best practice [Bock et al., 2021; Chiang et al., 2016]
- Plant-disease apps are rarely validated [Siddiqua et al., 2022]

## Evaluation Round 1 (brief version 0.1: user's strategy + "publishable and usable")

| Dimension | Score | Justification |
|-----------|-------|---------------|
| Novelty | 7/10 | No deep learning severity method exists for BLS on wheat leaves; the only image-based BLS work uses drone hyperspectral imaging [Sanaeifar et al., 2025]. The two-stage design follows [Liu et al., 2024]. The new parts are the multi-rater panel collected through the same app and the usability study. |
| Technical Soundness | 6/10 | The reference standard is decided: raters plus about 100 pixel-outlined leaves. Not yet specified: how the rater consensus is formed (mean, median or latent truth), whether raters score % or 1–9, how chlorotic halos are counted, and how training photos are kept apart from test photos. Without that separation the evaluation is inflated. |
| Feasibility | 7/10 | The ~1,000 photos, the app (leaf finder, rater score field, export) and access to raters already exist. Open questions are rater time if every rater scores all 1,000 photos, annotation hours, and GPU access. |
| Significance | 7/10 | BLS has re-emerged in wheat, chemical control is ineffective, and breeders depend on slow, subjective visual ratings [Sapkota et al., 2020; Sanaeifar et al., 2025]. A free offline tool helps breeders directly. |
| Clarity | 6/10 | The workflow is clear in outline. Missing: which photos each rater scores, blind and random order, repeats, and the split between training and test sets. |
| Experimental Validity | 6/10 | The metrics are named (Lin's ρc, ICC), but the plan lacks a baseline list, ablations and external datasets. The rubric asks for 2+ benchmarks, 3+ baselines and an ablation plan. |
| Scalability | 6/10 | Wheat only for now; barley is deferred. The pipeline is generic, but no transfer test is planned yet. |
| Positioning | 8/10 | Plant Phenomics has published closely related work: StripeRust-Pocket [Liu et al., 2024], disease versus senescence [Anderegg et al., 2023], and few-shot foundation models [Jiang et al., 2025]. A multi-rater benchmark plus a usability study is distinct from these. |

**Overall: 6.6/10**
**Below threshold:** Technical Soundness, Clarity, Experimental Validity, Scalability (all 6)
**Refinement targets:**
- Technical Soundness: define the reference hierarchy, the consensus estimator, the chlorosis rule and a leakage-free split.
- Clarity: write the exact rating protocol (photo sets, raters per photo, rounds, repeats).
- Experimental Validity: list 5 baselines, 6 ablations, 2 external datasets, and equivalence testing against the rater panel.
- Scalability: add a barley transfer test and an external wheat dataset, and frame the pipeline as reusable through taught colours.

## Evaluation Round 2 (brief version 1, after refinement)

| Dimension | Score | Change | Justification |
|-----------|-------|--------|---------------|
| Novelty | 8/10 | +1 | Adds a "model as one more rater" test: does the model fall inside the spread of human raters? It also adds a usability and adoption study. Neither appears together in prior severity papers [Liu et al., 2024; Shi et al., 2023; Siddiqua et al., 2022]. |
| Technical Soundness | 8/10 | +2 | Three-level reference: true severity from masks on a held-out gold set, rater median, and a latent-truth estimate. Chlorosis is reported both ways. Splits are by genotype or plot and site. |
| Feasibility | 7/10 | 0 | The balanced incomplete design caps each rater at about 1.5 hours in total; annotation is about 40 hours with model-assisted labelling. GPU access remains a dependency. |
| Significance | 8/10 | +1 | Usable tool, open dataset and a validated protocol together serve breeders, pathologists and app builders. |
| Clarity | 8/10 | +2 | Set A / Set B protocol with numbers, roles and order. |
| Experimental Validity | 8/10 | +2 | 5 baselines, 6 ablations, 2 external datasets, bootstrap CIs, equivalence test, repeatability, usability metrics. |
| Scalability | 7/10 | +1 | Barley transfer test (100 leaves), external field wheat data, and retraining for other diseases via taught colours. Still single-pathogen at publication. |
| Positioning | 8/10 | 0 | Unchanged. |

**Overall: 7.75/10. Status: Ready (all dimensions ≥ 7).**

Structural note: Scalability is capped near 7 while the study covers one pathogen and one main host. That is acceptable for a first BLS paper.
