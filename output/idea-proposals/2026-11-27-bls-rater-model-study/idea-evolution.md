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

## Version 0.1 (user change, 2026-11-28)
The user wants a publishable paper AND a tool people use. Added contribution (4): a usability and adoption evaluation of the app with raters and breeders (System Usability Scale [Brooke, 1996], time per leaf versus visual scoring plus data entry, offline field use), and open release of app, model and data.

## Round 1 → Version 1 (refinement; literature policy: < 30% change, Phase 2 context reused + 1 supplementary search on rater studies and usability)

Scores before → after: Novelty 7→8, Technical Soundness 6→8, Feasibility 7→7, Significance 7→8, Clarity 6→8, Experimental Validity 6→8, Scalability 6→7, Positioning 8→8. Overall 6.6 → 7.75.

Changes and reasons:
1. **Reference hierarchy (Technical Soundness).** (a) True severity from pixel masks on a held-out gold set; (b) rater consensus = median of raters' % per photo; (c) a latent-truth estimate from a mixed model with rater bias as a random effect (sensitivity analysis). The model is never tuned on Set A.
2. **Two photo sets (Clarity, Soundness).**
   - Set A, the gold test set: 150 leaves stratified by 1–9 class and greenhouse/field, held out by genotype/plot. Lesions are outlined by 2 annotators (agreement measured). Every rater scores all 150 twice: unaided, and with the SAD 2+ weeks later. 20 repeats are hidden in each round.
   - Set B, development: the remaining ~850 photos. Each is scored by 3 raters in a balanced incomplete design; 300 of them are outlined for training (model-assisted).
3. **Rater protocol (Clarity).** 10–15 raters (experienced and novice), blind to the app's score, random order, % diseased (primary) and 1–9 in the app's Study mode, rater ID and time stored.
4. **Chlorosis (Soundness).** Report necrotic % and necrotic + chlorotic % for raters and the model alike.
5. **Evaluation (Experimental Validity).**
   - Baselines: individual raters, the rater panel, app rules v2, taught colours (naive Bayes, PlantCV/pliman style), single-stage CNN regression, and a StripeRust-Pocket-style DeepLabV3+.
   - Ablations: no SAM leaf finder, no chlorosis class, no "other" class, greenhouse-only training tested on field, training size 50/100/300, phone model versus server model.
   - External datasets: public field wheat stripe-rust images [Zhao et al., 2025] and in-field wheat leaf data [Zenkl et al., 2025] for leaf and necrosis transfer.
   - Statistics: Lin's ρc with bootstrap CIs; an equivalence test of model error against inter-rater error ("model as one more rater"); ICC; weighted kappa; repeatability.
6. **Usability (Significance, Novelty).** SUS after use, seconds per leaf (app versus visual plus data entry), an offline field session, and adoption intent (TAM items [Davis, 1989]).
7. **Scalability.** A barley transfer test on 100 leaves after the wheat paper; the pipeline can be retrained for other foliar diseases with taught colours.

New dependency on the app: **Study mode** (blind, randomised, rater ID, export) must be built before raters start.
