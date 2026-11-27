# Idea Evolution: BLS rater study and on-phone model

## Version 0 (Phase 1: structured from the user's strategy, 2026-11-27)

### User's strategy (as given)
Share the existing BLS photo folder (greenhouse and field) with several raters, who score each leaf in the app. Later, the model in the app rates the same photos. Combine all raters' data to evaluate the model, develop the app, and write the paper.

### Research Idea Brief
- **Problem Statement**: BLS (*Xanthomonas translucens* pv. *undulosa*) severity in wheat is scored visually, which is slow and varies between raters. No validated image-based method exists for BLS on leaves: the only image-based BLS study uses drone hyperspectral imaging [Sanaeifar et al., 2025]. Deep learning severity models for other wheat diseases are usually validated against pixel metrics or one expert, not against a panel of raters [Shi et al., 2023; Bock et al., 2020].
- **Proposed Approach**: Build a multi-rater benchmark from the existing ~1,000 wheat BLS photos (greenhouse and field). Several raters score each photo blind in the app (% diseased and 1–9). Train an on-phone two-stage model (leaf finder + lesion segmenter) and compare its scores with the raters' consensus and with each individual rater on the same photos.
- **Key Innovation**: (1) the first multi-rater reference set for BLS severity in wheat, collected through the same app that runs the model; (2) a "model versus the rater panel" evaluation: is the model within the range of human raters (inter-rater agreement as the ceiling) rather than only "accurate"; (3) an offline phone tool that breeders can use immediately.
- **Target Domain**: Plant phenotyping / computer vision for plant pathology (image-based disease severity estimation).
- **Target Venue**: Plant Phenomics (confirmed by the user).
- **Input Type**: free-text
- **Reference Papers**: from the literature survey (output/literature-survey/2026-11-27-225816): liu2024 (StripeRust-Pocket), zenkl2025, sanaeifar2025, bock2020, ponte2017, chen2021, karisto2017.

### Open points noticed while structuring (to resolve in evaluation and refinement)
1. **Reference standard.** If raters are the only reference, the model can at best match them, and rater bias becomes "truth". A small pixel-annotated subset (true severity) would let the paper measure both raters and model against an objective reference.
2. **Training and test photos.** If the model is trained on the same photos the raters score, the evaluation is inflated. A held-out set (by genotype or site) is needed.
3. **Rater design.** Number of raters, experience levels, blind scoring, random order, repeated photos (consistency) and the SAD question all affect what the paper can claim.

### Decisions from the user (Phase 1 review)
- Target venue: **Plant Phenomics**.
- Reference standard: **rater panel on all photos + about 100 leaves with lesions outlined pixel by pixel** as objective ground truth.
- Brief: "mostly" confirmed; the user's requested changes are still to come.
