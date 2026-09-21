# Rules for Completely Mapping a Condition's Systemic Physical Sequelae

**Version 1.1.0 — 2026-09-19**
**1.1.0 amendment:** §17 (cross-check against the condition vocabulary) and appendix item 8, both from the 1.4.0 vocabulary cross-check.
**Status:** Internal methodology note. **Not product copy, not user-facing, not an underwriting judgment.**
**Review required:** a clinician (case definitions, codes, mechanism tiers) and an actuary (effect-size use, absolute-risk framing) before any downstream use.

**Scope.** This is an application-agnostic protocol for building a _complete_ map of the physical conditions that follow from an index condition. PTSD is the worked example because three source syntheses were reviewed against it (§14–§15), but the rules apply to any index condition.

**Source documents this rule set was derived from.**

| Doc   | Title                                                                                                                     | Character                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **A** | _PTSD and subsequent major physical-health outcomes: synthesized epidemiology and mechanistic evidence_                   | Strongest on confounding, ascertainment, gaps. 20 numbered references (PMC/journal URLs).                               |
| **B** | _The Systemic Phenome of Post-Traumatic Stress Disorder: Epidemiological Hazard Ratios and Pathophysiological Mechanisms_ | Strongest on quantitative hazard ratios, PheWAS/genetic architecture, dose–response. No formal reference list.          |
| **C** | _The Somatic Consequences of Post-Traumatic Stress Disorder: A Comprehensive Review of Medical Comorbidities_             | Strongest on per-condition source tables (pathology → finding → URL) and outcomes A and B omit (infections, mortality). |

---

## 0. What "complete" means (the definition the rest of the rules serve)

A map is **complete** when all seven of the following hold. Note that completeness is a property of _coverage and verdicts_, not of positive findings:

1. **Every domain in the pre-declared sweep (§12) has at least one row** — including rows whose verdict is "insufficient evidence".
2. **Every row carries a tier** from §11, including `D` (insufficient) and `X` (refuted). A row is never left blank.
3. **Every number is either source-verified or explicitly flagged unverified** (§1).
4. **Every conflict between sources is recorded, not averaged away** (§13).
5. **No row rests on a single population** for any tier above `C` (§3).
6. **The map states its ascertainment boundary** — what its data source structurally cannot see (undiagnosed disease, uncoded care, deaths before diagnosis).
7. **The map is versioned, dated, and reviewer-signed** (§16).

The commonest failure mode is mistaking _"we found an association"_ for _"we looked everywhere."_ A map that lists fourteen positive conditions and never mentions suicide mortality, renal disease, or arrhythmia is not a partial map of PTSD — it is a map with unexplored territory (§15).

---

## 1. Source and verification rules

**R1 — Index the source, then verify the number.**
No row may enter the map from a synthesis alone. Each row's estimate is entered with `verification: unverified` and a link to the primary source, and is promoted to `verified` only when the primary source has been opened and the estimator, value, CI, population, and follow-up confirmed. **Quote a synthesis only as a pointer, never as the evidence.**

**R2 — Never quote a number whose estimator type you cannot name.**
`HR`, `OR`, `RR`, and `prevalence` are not interchangeable. Record the estimator exactly as published, with its CI. Record which model it came from (least-adjusted, fully-adjusted, or a named model).

**R3 — Record the source's own confidence language separately from the finding.**
The sources reviewed here overreach in places — Doc B states PTSD is "unequivocally established" as multisystemic and cites "staggering hazard ratios"; Doc C states a "definitive link" and a "profound" risk. Those are the authors' adjectives. **Enter the estimate, not the adjective.** Tables in a synthesis are a stronger signal than its summary prose, because prose drifts from the numbers it is describing (Doc C's own summary of the Sweden cohort conflicts with its table — §15).

---

## 2. Case-definition rules — the index condition

**R4 — Pin three exposure strata and never pool them.**

| Stratum  | Definition                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `dx`     | Clinically diagnosed PTSD: structured diagnostic interview (CAPS/SCID), or ≥2 clinical encounters / ≥2 ICD-coded diagnoses on separate dates |
| `prob`   | Probable PTSD: positive validated screen (PCL-5 / PCL-C / PC-PTSD) above the published cut-off                                               |
| `trauma` | Trauma exposure without PTSD (the negative-control stratum)                                                                                  |

Doc A is explicit that ascertainment method changes the result: studies using structured or clinical diagnostic approaches "often report larger, more consistent associations." Doc B's PheWAS deliberately runs **narrow and broad PTSD phenotypes** and reports that both are significant but not identically sized. One number, one stratum.

**R5 — Carry phenotype definition into every row.**
The same outcome has different magnitudes by exposure definition, and the map must preserve the pairing. From the sources: CHD at pooled `1.55` vs `≥4` PTSD symptoms at `+60%` incidence vs highest trauma exposure quartile at `+38%`. Those are three different exposure strata, not three estimates of one quantity.

**R6 — Record index-condition epochs, not just presence.**
Time since trauma, age at exposure, and age at diagnosis are effect modifiers, not covariates: Doc C reports autoimmune risk most pronounced in younger patients, and Doc C's mortality analysis both show that the hazard is highest immediately after diagnosis and decays. A lifetime-PTSD denominator differs from a currently-diagnosed one.

**R7 — The `trauma` stratum is mandatory, not optional.**
Without it the map cannot say whether the sequela follows the _stress response_ or merely the _event_. Doc C supplies the decisive comparison: trauma-exposed people are `2.7×` (95% CI 2.27–3.10) more likely to be diagnosed with a functional somatic syndrome, and the association is **larger in those who developed full PTSD than in those exposed without it.** That comparison is what converts "trauma → illness" into "PTSD → illness."

---

## 3. Case-definition rules — the outcome

**R8 — Incidence and prevalence are different outcomes.**
`Prevalence` rows describe the state of a PTSD population (OSA pooled prevalence `75.7%` at AHI ≥ 5 and `43.6%` at AHI ≥ 10; insomnia affects `70–90%`; `69.2%` of young combat veterans screen high-risk). `Incidence` rows describe new disease in an initially disease-free cohort. Never let a prevalence number license an incidence claim.

**R9 — Ascertainment quality is a graded field, not a footnote.**
For each outcome record how it was identified, in this order of strength:
`(a)` adjudicated clinical event → `(b)` registry/hospital discharge diagnosis → `(c)` outpatient ICD code → `(d)` dispensed prescription → `(e)` validated screen/questionnaire → `(f)` self-report → `(g)` biomarker alone.
Tier caps by ascertainment: `(a)–(c)` can reach `A`; `(e)–(f)` caps at `B` for incident disease and `C` for anything severe; `(g)` can never exceed `C` unless the biomarker prospectively predicted incident disease (R24).

**R10 — Intermediate phenotypes are their own rows and their own tier.**
Endothelial function (FMD `5.8%` vs `7.5%` controls), adhesion molecules (VCAM-1, ICAM-1, TNFRII rising over a 10–16-year interval), inflammatory markers (CRP, IL-6, TNF-α, IL-1β, IFN-γ), HRV, and leukocyte telomere length are _markers_, not diseases. They are mapped as intermediate rows and cannot be cited as evidence that a clinical outcome occurs. Keep the marker row and the clinical row separate — the sources show exactly why in R16.

**R11 — Outcome codes and definitions are part of the row.**
Where a code exists, record it (ICD-10-CM or phecode) alongside the free-text outcome, because "stroke" resolves to `I63.9` and "any CVD" does not resolve at all — an unspecified outcome cannot be queried, matched, or audited later.

**R12 — Latency is declared up front.**
Each outcome class gets a minimum plausible latency before its first events count:

| Outcome class                     | Minimum lag from index diagnosis                     |
| --------------------------------- | ---------------------------------------------------- |
| Metabolic (T2D, dyslipidemia)     | 12 months                                            |
| Functional somatic / pain / sleep | 12 months                                            |
| Autoimmune                        | 12 months                                            |
| Cardiovascular clinical events    | 12 months; **≥5 years for an atherosclerosis claim** |
| Neurodegenerative / dementia      | 24 months, ideally ≥5 years                          |
| Mortality, all-cause              | report year 1 and >1 year separately (see R33)       |

**R13 — Every exclusion must be pre-declared.**
Prevalent disease at baseline, outcomes inside the latency window, and deaths before outcome ascertainment are excluded — and the rule is written down _before_ the analysis, because the choice materially moves the numbers.

---

## 4. Design, replication, and independence rules

**R14 — Designs are reported as a set, never reduced to one label.**
The design field is a list: `meta-analysis of prospective cohorts`, `prospective cohort`, `population-matched retrospective cohort`, `registry/administrative cohort`, `case-control`, `cross-sectional`, `MR/genetic instrument`, `interventional`, `case series`. A row may legitimately carry three or four.

**R15 — Meta-analyses are syntheses, not new evidence.**
A pooled estimate inherits the weakness of every included cohort. Record, where reported: number of studies, total N, and heterogeneity (I²). Doc A warns that biomarker meta-analyses have high heterogeneity (explicitly for CRP), which "limits precise effect-size estimation" — a pooled number with undisclosed heterogeneity is not a precise number.

**R16 — Count independent populations, not publications.**
Three papers from one cohort are one population. This is not hypothetical here — the reviewed documents draw multiple findings from single populations:

| Population                    | Findings drawn from it                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nurses' Health Study II       | `+60%` incident CVD with ≥4 symptoms; T2D dose–response `1.4 / 1.5 / 1.8`; `2.94` SLE; telomere erosion equal to `7.62–9.71` years                           |
| Swedish national registers    | any autoimmune disease after stress-related disorder `1.36`; PTSD `1.46`, ≥3 autoimmune `2.29`; severe infection `1.92`; all-cause mortality `3.19` / `1.64` |
| World Trade Center responders | MI and stroke adjusted `HR > 2`, pooled MI/stroke `≈2.35`; plasma Aβ/tau/NfL → dementia                                                                      |
| Million Veteran Program / VHA | PheWAS phenotypes; dementia `2.31`; extensive-adjustment nulls                                                                                               |

Four "replications" that share a denominator are one population and one region. **Rule: any tier above `C` needs the same association from ≥2 populations that do not overlap in subjects, institution, or data system.**

**R17 — Replication must survive a change of ascertainment.**
A finding that holds only for structured-interview diagnoses and vanishes under coded diagnoses, or only in veteran cohorts and not in civilians, is a tier `C` finding. Doc A notes veteran-dominant cohorts "limit generalizability" while civilian and international cohorts corroborate findings "with heterogeneous effect sizes" — that is corroboration of direction, not of magnitude.

**R18 — Genetic instruments stand alone.**
Mendelian randomization rows (`SESA → PTSD` OR `2.60`, 95% CI 2.09–3.10; PTSD liability → Graves' disease OR `1.056`; PTSD → reduced CD62L− dendritic cells, increased CD28− CD8dim T cells) answer a different question than cohort rows and must not be blended into a cohort estimate. An MR OR of `1.056` with no CI reported and a fully genetic population is not comparable to a NHS II HR of `2.94` in mid-life women.

---

## 5. Effect-size and precision thresholds

**R19 — Tier the estimate by magnitude, and never on magnitude alone.**

| Band             | Effect size (HR/OR/RR)      |
| ---------------- | --------------------------- |
| Strong           | ≥ 2.00                      |
| Moderate         | 1.50 – 1.99                 |
| Modest           | 1.20 – 1.49                 |
| Marginal         | 1.05 – 1.19                 |
| Null / uncertain | < 1.05, or CI includes 1.00 |

Magnitude is a _label_, not a verdict: the `2.07` stroke estimate sits in the strong band with a CI of `1.16–2.98`, while the `1.42` any-CVD estimate sits in the modest band with a CI of `1.31–1.52`. The modest estimate with the tight interval is the more reliable claim.

**R20 — Precision gates entry to every tier.**
A row cannot exceed `C` unless the CI excludes 1.00 and the number of events is stated or derivable. The `1.40` SLE pooled estimate (Doc B) and the `2.94` SLE estimate (Doc C, NHS II) differ in both magnitude and precision; both are recorded, and the _claim_ is limited to what both support.

**R21 — Absolute risk is mandatory alongside every relative estimate.**
Relative risk without a baseline is not interpretable. A "nearly doubled" severe-infection risk (`1.92`) and a "`2.29`" risk of three-or-more autoimmune diseases describe vastly different absolute burdens. Doc B itself states the corrective: autoimmune relative risks are "highly significant" while "the absolute risk of developing an autoimmune disorder remains modest." Every row carries `baseline risk` or is marked `absolute risk not reported` — and an unanchored row cannot reach `A`.

**R22 — Dose–response strengthens, never substitutes.**
A monotone gradient is real evidence: T2D at `1.4 → 1.5 → 1.8` across PTSD symptom counts, and OSA screening risk rising with PTSD severity independent of BMI and blood pressure. But a gradient does not rescue an effect that disappears under full adjustment.

**R23 — Prevalence ratios and symptom measures use their own scales.**
A `2.7×` odds of a functional somatic syndrome diagnosis after trauma, `45.5%` vs `11.1%` PTSD onset by sleep reactivity, and a Hedge's `g = −1.27` for telomere erosion are not hazard ratios. Store them with their estimator; do not convert.

---

## 6. Confounding rules

**R24 — The mandatory adjustment set.**
A row cannot exceed `C` unless the model adjusted for all of: age, sex, calendar era, socioeconomic position (education/income), smoking, adiposity (BMI), alcohol and other substance use, depression and other psychiatric comorbidity, traumatic brain injury / head injury, and medication exposure (antidepressants, antipsychotics, corticosteroids, statins). Outcome-specific additions are declared per row (oral contraceptive use for SLE, physical activity for CVD, sleep-disordered breathing for hypertension).

Rationale from the sources: Doc A's CVD estimates attenuate but generally persist after adjustment for depression and other confounders; Doc B's DoD-ADNI and veteran dementia analyses persist after adjusting head injury, substance abuse, and depression (`2.31` → adjusted `1.77`); Doc C's SLE estimate persists after smoking, BMI, and oral contraceptives.

**R25 — Record attenuation as a three-state field, with both models.**
Enter the least-adjusted and most-adjusted estimates plus `persists` / `attenuates` / `eliminated`.

> **Worked signal.** Doc A reports that some large VHA analyses found associations attenuating **to non-significance** after extensive adjustment for comorbidity and smoking — the same document reports the same outcome class as robust. Both facts belong in the row, because together they are what the evidence actually says: an association that is real in direction and unstable in magnitude under aggressive adjustment.

**R26 — Residual confounding is stated, not implied.**
Every observational row ends with an explicit residual-confounding note. Doc A's own conclusion is the model wording: "Residual confounding and mediation by behavioral/comorbid conditions account for part, but not all, of these associations in multiple studies."

**R27 — Never adjust away the exposure's own downstream consequences and call the result confounding.**
Comorbidity adjustment can remove a genuine effect transmitted through comorbidity. If a mediator is a downstream consequence of PTSD (deconditioning, obesity, sleep apnea, substance use initiated after trauma), adjusting for it produces an estimate of the _direct_ effect only, and must be labeled as such. See R29.

---

## 7. Mediation and pathway rules

**R28 — Distinguish mediator from confounder before adjusting, and state which one you are treating it as.**
A variable qualifies as a mediator only if it (i) plausibly follows the index condition, and (ii) lies on the causal path to the outcome. Otherwise it is a confounder or a collider.

**R29 — If adjustment removes the association, the correct row is "mediated", not "absent".**
The sources supply three unambiguous examples and they must be encoded as written:

| Pathway                      | Reported effect of the mediator                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PTSD → type 2 diabetes       | Antidepressant use **and elevated BMI mediate nearly half** of the increased risk; adjustment for obesity attenuates but does **not** eliminate it (Doc B). Doc A: adjustment for BMI "often attenuates or eliminates the statistical association," indicating partial mediation through adiposity and behavioral risk factors. |
| PTSD → incident hypertension | Insomnia symptoms (difficulty falling/staying asleep) **directly mediate** the association, plausibly via loss of nocturnal blood-pressure dipping (Doc C).                                                                                                                                                                     |
| PTSD → MACE                  | Mediated by stress-associated neural activity, reduced heart-rate variability, and elevated systemic inflammation (Doc C).                                                                                                                                                                                                      |

**R30 — Report the proportion mediated, or the gap.**
A mediated row carries either a percentage (`≈half` for the T2D pathway) or an explicit `proportion mediated not reported`. Doc B's careful formulation — obesity-independent mechanism _alongside_ substantial mediation — is the standard: mediation explains part, and the row must show which part is unexplained.

**R31 — Mediation is not a demotion to "no effect."**
"Largely mediated by X" and "no association after adjustment for X" are different findings. The first is a pathway claim; the second is a null under a specific model. Record which one the source supports.

---

## 8. Directionality, reverse causation, and competing risks

**R32 — Every edge is directed, and bidirectional edges get two rows.**
`PTSD → CVD` and `CVD → PTSD` are separate rows with separate evidence. Doc C quantifies the reverse direction precisely: global PTSD prevalence after myocardial infarction is `21.2%`, and `27.5%` in Chinese populations. Collapsing the two into one undirected "association" is the single most consequential error this map can make, because it silently converts a consequence of disease into a risk factor for it.

**R33 — The acute window is a reverse-causation trap.**
Mortality is highest immediately after diagnosis (`3.19` in year 1 versus matched population, `3.21` versus unaffected siblings), decaying to `1.64` beyond year 1 and remaining significant indefinitely. Doc C attributes the acute spike to severity, and both readings (severity confounding and reverse causation from undiagnosed fatal disease) are plausible. **Rule: report year 1 separately, never pooled with long-term follow-up, and treat any outcome concentrated in the first 12 months as presumptively severity-driven until shown otherwise.**

**R34 — Latency-sensitive outcomes must show the gradient the mechanism predicts.**
The strongest single internal test in these sources is a discordance: clinically meaningful PTSD improvement (≥20-point PCL drop) was associated with a **49% reduction in incident T2D** (`HR 0.51`, 95% CI 0.26–0.98) but **no significant reduction in incident CVD** (`HR 1.08`) over 2–7 years. Doc B's interpretation — that metabolic parameters respond quickly to dampening the HPA axis while atherosclerotic plaque is structural and needs much longer horizons — predicts exactly this pattern. **A map that reports both outcomes with the same implied reversibility is internally inconsistent.** Outcome-specific latency (§3) and reversibility are recorded per row.

---

## 9. Ascertainment, population, and subgroup rules

**R35 — The ascertainment boundary is a required field.**
State what the map cannot see: people without healthcare contact, conditions not coded, deaths before ascertainment, care delivered outside the data system, and phenotypes that predate the index diagnosis. PheWAS over UKB/MVP/All of Us and an "analysis of over 145,000 patients" (Doc B) see _coded_ comorbidity; the number of conditions a body actually has is not the number a database contains.

**R36 — Populations are named, and veterans are not the default human.**
Record population composition: veteran versus civilian, country/data system, sex distribution, age structure, era. Where the evidence base is veteran-dominant, that is a generalization limitation, not a detail.

**R37 — Subgroup effects are recorded with CIs, and a null subgroup is not proof of no effect.**
The clearest example: the PTSD–diabetes association is `RR 1.9` (95% CI 1.4–2.5) in Black populations versus `RR 1.2` (95% CI 0.7–1.9) in non-Latino White populations. The White stratum's CI crosses 1 — that is imprecision, not necessarily absence, and it certainly does not license quoting `1.9` as the general effect. Doc B's proposed mechanism (compounding allostatic load from systemic inequity) is a hypothesis, filed as mechanism, not evidence.

**R38 — Sex, age, and genotype modifiers get their own fields.**
Women: HR `1.44` for incident ischemic heart disease, higher in younger women (Doc A). Men: faster working-memory decline than women, and stronger PTSD–dementia association in veterans. `APOE-e4` carriers show accelerated delayed-recall and executive-function decline when co-diagnosed with PTSD. These are effect modifiers with real magnitudes and belong in the row, not the discussion.

---

## 10. Mechanism rules

**R39 — Mechanism is corroborative and never sufficient.**
Convergent biology (FKBP5 demethylation and NR3C1 methylation → glucocorticoid receptor resistance; elevated IL-6/TNF-α/IL-1β/CRP/IFN-γ; reduced HRV; endothelial glycocalyx degradation; telomere shortening; orexin/hypocretin dysregulation) explains _why_ an association is believable. It cannot create an association. A mechanism with no epidemiology is a hypothesis row, tier `D`.

**R40 — Mechanistic claims are tiered, and the tiers do not upgrade each other.**

| Tier | Type of mechanistic evidence                                                                                                                                      | Maximum epidemiological tier it supports  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| m1   | Cross-sectional biomarker elevation                                                                                                                               | `C`                                       |
| m2   | Prospective biomarker predicting **incident** disease (e.g., Aβ40/42 ratio, p-tau181, NfL → subsequent dementia)                                                  | `B`                                       |
| m3   | Intervention/perturbation changes the outcome (PTSD improvement → T2D `0.51`; SSRIs in the first year after diagnosis associated with attenuated autoimmune risk) | `B`, and never a stand-alone causal claim |
| m4   | Genetic instrument (MR: `SESA → PTSD` `2.60`, 2.09–3.10; PTSD → Graves' `1.056`; immune-cell phenotypes)                                                          | `B`                                       |

**R41 — m4 plus prospective cohorts plus temporality is the minimum for causal language.**
And even then the causal claim is bounded by phenotype and direction. Note that m3 can also cut against causality in the crude form: conventional PE/CBT produce transient _increases_ in IL-6, CRP, and TNF-α during treatment while patients improve psychologically. Perturbing the treatment does not move the marker in the direction a simple causal story predicts, and that fact must be recorded next to the "treatment reduces risk" claims.

---

## 11. Evidence grading

Grade every row. Grading is applied to the **association between a named exposure stratum and a named outcome**, never to "PTSD" or "the condition" in general.

| Tier                                               | Criteria (all must hold)                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Established**                                | ≥2 independent prospective populations (§4, R16); CI excludes 1.00 with events reported; magnitude ≥1.20; mandatory adjustment set applied and effect `persists`; temporality satisfied with the latency of §3; ascertainment `(a)–(c)`; absolute risk anchored; direction stated.  |
| **B — Probable**                                   | One large prospective or pooled analysis with CI excluding 1.00, **or** ≥2 populations with a gap in the adjustment set, ascertainment, or absolute-risk anchoring; findings consistent in direction.                                                                               |
| **C — Possible**                                   | Cross-sectional or comorbidity/prevalence-only evidence; administrative association without full adjustment; effect that `attenuates` or is `eliminated` under the best-adjusted model; a marginal band estimate (1.05–1.19); a single small population; or a mechanism-only claim. |
| **D — Insufficient**                               | No adjusted estimate; prevalence data only where incidence is the question; a lone small study; a mechanism with no epidemiological test. **"No data" is recorded as `D — no studies identified`, and must never be read as "no association".**                                     |
| **X — Refuted / not supported**                    | Evidence exists and contradicts the hypothesized association.                                                                                                                                                                                                                       |
| **M — Mediated (modifier, applied alongside A–C)** | The association exists but a substantial share runs through a named intermediary, with the proportion or attenuation stated (R30). `M` is recorded _with_ a tier, never instead of one.                                                                                             |

**R42 — Tier and causal language are locked together.**

| Tier | Permitted wording                                                             |
| ---- | ----------------------------------------------------------------------------- |
| A    | "is an established risk factor for" — with the population and phenotype named |
| B    | "is associated with an increased risk of", "is a probable risk factor for"    |
| C    | "has been associated with", "evidence is suggestive but limited"              |
| D    | "insufficient evidence to determine"                                          |
| X    | "the evidence does not support"                                               |

"Causes", "causal agent", and "definitively" require an m4 genetic instrument or an m3 intervention result **plus** A-tier epidemiology, and are otherwise prohibited in the map (R3).

---

## 12. The domain sweep — the completeness checklist

Pre-declare this list before searching, so the map cannot quietly become the set of conditions that happened to appear in the literature that was found. Each domain gets at least one row, even if the verdict is `D`.

1. Cardiovascular — coronary disease, myocardial infarction, heart failure, hypertension, arrhythmia/sudden cardiac death
2. Cerebrovascular — ischemic and hemorrhagic stroke, TIA
3. Metabolic / endocrine — T2D, type 1 diabetes, metabolic syndrome, obesity, dyslipidemia, thyroid disease
4. Renal / urinary
5. Immune / autoimmune / rheumatologic — SLE, RA, MS, IBD, psoriasis, thyroid autoimmunity
6. Inflammatory and vascular intermediates — CRP, IL-6, TNF-α, IL-1β, IFN-γ, FMD, VCAM-1/ICAM-1, EMP, HRV
7. Neurodegenerative / cognitive — Alzheimer's, all-cause dementia, Parkinson's, DLB, vascular dementia, MCI
8. Neurological — migraine, epilepsy, chronic pain, TBI
9. Sleep — insomnia, obstructive sleep apnea, narcolepsy
10. Respiratory — asthma, COPD, respiratory infection
11. Gastrointestinal / hepatobiliary
12. Musculoskeletal / functional somatic / chronic pain — fibromyalgia, ME/CFS, IBS, TMD
13. Oncologic — all sites, plus site-specific where immune-mediated
14. Hematologic / cellular aging — anemia, leukocyte telomere length, epigenetic age
15. Infectious — severe/life-threatening infection, site-specific (meningitis, endocarditis)
16. Mortality — all-cause, cardiovascular, cancer, **external causes and suicide**
17. Psychiatric and substance-use outcomes — retained in the map as adjacent outcomes (they are simultaneously confounders and mediators), never merged into the physical rows
18. Iatrogenic / treatment-related — medication effects and adverse effects on the physical outcomes
19. Reproductive / transgenerational — pregnancy outcomes, offspring effects
20. Injury and external causes — accidents, overdose, self-harm

**R43 — A domain row that is empty is a finding.**
Record it as `no studies identified in sources reviewed` with the search date and scope. That is the difference between a map and a list.

---

## 13. Conflict, attribution, and exclusion rules

**R44 — Conflicting estimates are all recorded, with their contexts.**
The reviewed sources conflict on several rows, and those conflicts are more informative than a chosen number:

| Row                | Doc B                     | Doc C                                                          | Doc A                     |
| ------------------ | ------------------------- | -------------------------------------------------------------- | ------------------------- |
| All-cause dementia | pooled `1.75` (1.55–1.97) | pooled `1.61` (>1.6M), veterans `1.61`, civilians up to `2.11` | pooled commonly `1.6–2.1` |
| Multiple sclerosis | `2.30` (table)            | `1.302`                                                        | —                         |
| SLE                | `1.40` (table)            | `2.94` (NHS II)                                                | —                         |
| Incident CHD       | `1.55` (1.46–1.77)        | `55–61%` increase                                              | pooled `27–55%`           |
| Any CVD            | `1.42` (1.31–1.52)        | `1.417`                                                        | —                         |

The correct output for MS is **"elevated; magnitude uncertain (`1.30–2.30` across sources)"** at tier `B`/`C`, not the mean and not the largest value. Pooling estimates across incompatible phenotypes, adjustment sets, and designs manufactures false precision.

**R45 — Attribution rule: an association belongs to the exposure that produced it.**
Doc C reports that intrauterine exposure to **maternal autoimmune disease** is associated with a 19% increased risk of any CVD in offspring (`HR 1.19`, 95% CI 1.14–1.24). That is a maternal-immune → offspring-CVD finding. It is **not** a PTSD sequela and must not sit in a PTSD row; if retained, it belongs in domain 19 with the correct exposure. Transgenerational, iatrogenic, and diagnostic-artifact pathways all get explicit labels.

**R46 — Artifact and detection-bias rule.**
Before accepting a row, ask whether the association could be produced by _contact with the medical system_ rather than by disease: a person diagnosed with PTSD has more encounters, more screening, and therefore more coded diagnoses. Doc C's own discordance is the strongest available evidence that this map is partly protected from the artifact — PTSD predicted clinical CVD events (`OR 1.51`) but did **not** uniformly correlate with carotid intima-media thickness or carotid plaque. A detection bias would inflate both; a genuine acute-event pathway inflates only the clinical endpoint. Rows suspected of detection bias get a note and a tier cap of `C`.

**R47 — Discordant marker-versus-endpoint findings are preserved as two rows.**
The cIMT/plaque null is a real `X` row for the subclinical-atherosclerosis outcome, sitting alongside an `A`-level row for clinical events. Files that report only one of the two are incomplete.

---

## 14. Row schema (what every mapped condition must carry)

```
id                      unique, stable, never reused
exposure:
  condition             index condition
  stratum               dx | prob | trauma
  definition            verbatim diagnostic/screening definition
  ascertainment         structured interview | ≥2 codes | screen | self-report
  epoch                 time since trauma, age at exposure, age at diagnosis
outcome:
  name                  plain name
  code                  ICD-10-CM and/or phecode (null when unresolvable)
  definition            verbatim
  ascertainment         (a)–(g) per R9
  kind                  incidence | prevalence | intermediate marker | mortality
direction               index→outcome | outcome→index | both (two rows)
designs                 list of designs (R14)
populations             named, with N, follow-up, era, sex distribution, region
independence_group      cohort family, for R16 de-duplication
estimate:
  estimator             HR | OR | RR | prevalence | mean difference | g
  least_adjusted        value + CI
  fully_adjusted        value + CI
  attenuation           persists | attenuates | eliminated
  events                N events if reported
  absolute_risk         baseline risk, or "not reported"
adjustment_set          listed covariates (mandatory set per R24 + outcome-specific)
mediators               named, with proportion mediated or the gap (R30)
lag_months              applied, per §3
subgroups               sex, age, genotype, ancestry — with CIs (R37)
mechanism_tier          m1 | m2 | m3 | m4 | none
evidence_tier           A | B | C | D | X   (+ M modifier)
causal_language         per R42
conflicts               other estimates, with source ids
residual_confounding    explicit statement (R26)
verification            verified | unverified, verifier, date, source URL
notes                   artifact/detection-bias assessment (R46)
```

---

## 15. Worked application — PTSD, graded from the three sources

Tiers are assigned by the rules above, using only what the three documents report. Numbers are as-stated by the sources and remain `unverified` until checked at the cited primary source (R1).

| #   | Outcome (direction)                                                     | Best-supported effect                                                                                                                   | Populations                                      | Tier                          | Deciding rule                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Incident coronary heart disease (→)                                     | Pooled `1.55` (1.46–1.77); `55–61%` in one synthesis; `27–55%` in another                                                               | ≥2 non-overlapping (meta-analyses, NHS II, WTC)  | **A**                         | Multiple independent prospective populations, CI excludes 1, mandatory adjustment (depression, smoking, inactivity, obesity) and effect persists; magnitude conflict recorded per R44 |
| 2   | Any cardiovascular disease (→)                                          | `1.417` (1.31–1.52); `1.42` (1.31–1.52)                                                                                                 | ≥2                                               | **A**                         | As above; two sources agree closely                                                                                                                                                   |
| 3   | Stroke / cerebrovascular (→)                                            | `2.074`; range `1.70–2.07` with CI `1.16–2.98`                                                                                          | ≥2 (meta-analysis; WTC pooled MI/stroke `≈2.35`) | **B**                         | Wide CI despite strong point estimate → precision gate (R20)                                                                                                                          |
| 4   | Myocardial infarction (→)                                               | `HR 1.415`; `1.42–1.50` (1.33–1.50); WTC adjusted `>2`                                                                                  | ≥2                                               | **A**                         | Independent populations, consistent direction, adjusted                                                                                                                               |
| 5   | Heart failure (→)                                                       | Adjusted `≈3.7` hospitalization in a CAD cohort; severity predicted recurrent HF                                                        | 1                                                | **C**                         | Single population; exceptionally high estimate in a selected (CAD) cohort (R16)                                                                                                       |
| 6   | Hypertension (→)                                                        | Associations observed in large military cohorts, "some attenuation when PTSD was treated"; no pooled estimate                           | ≥1                                               | **C**                         | No pooled estimate, no CI, attenuation under treatment (R20, R25)                                                                                                                     |
| 7   | Subclinical atherosclerosis (cIMT/plaque) (→)                           | **Null** — PTSD predicted clinical events (`OR 1.51`) but not uniformly cIMT/plaque                                                     | 1 (3,119 adults)                                 | **X**                         | Discordant marker/endpoint finding preserved as its own row (R47, R46)                                                                                                                |
| 8   | Metabolic syndrome (→)                                                  | Up to `43%` of severe PTSD patients meet criteria; "nearly doubled" risk                                                                | ≥2                                               | **B**                         | Prevalence plus relative estimate; absolute anchoring incomplete                                                                                                                      |
| 9   | Type 2 diabetes (→)                                                     | Dose–response `1.4 / 1.5 / 1.8` by symptom count; `30–50%` pooled; Palestinian comorbidity OR `5.45` for poor control                   | ≥3 (NHS II, meta-analyses, veterans)             | **A + M**                     | Independent populations, monotone gradient, CI excludes 1 — **but** BMI and antidepressants mediate ≈half (R29, R30)                                                                  |
| 10  | Any autoimmune disease (→)                                              | Sweden: `1.36` (stress-related), `1.46` (PTSD); ≥3 autoimmune `2.29`; military `1.58`                                                   | ≥2 (Swedish registers, US military)              | **B**                         | Sibling-matched design is strong; the same registry supplies several rows (R16) and absolute risk is explicitly modest (R21)                                                          |
| 11  | Multiple sclerosis (→)                                                  | `2.30` (one source) vs `1.302` (another)                                                                                                | ≥2                                               | **C**                         | Unresolved magnitude conflict; report the range (R44)                                                                                                                                 |
| 12  | Rheumatoid arthritis (→)                                                | `1.60` (table); significant association in cohorts                                                                                      | ≥2                                               | **C**                         | Pooled table value without model or adjustment detail (R2, R24)                                                                                                                       |
| 13  | Inflammatory bowel disease (→)                                          | `1.60`; individual-study HRs `≈1.14` to `>2–6`                                                                                          | ≥2                                               | **C**                         | Range so wide that no single claim is defensible (R44)                                                                                                                                |
| 14  | Systemic lupus erythematosus (→)                                        | `2.94` (NHS II, adjusted smoking/BMI/OCP) vs `1.40` (pooled table)                                                                      | 2                                                | **C**                         | Genuine conflict; NHS II estimate is well adjusted but single-population (R16, R44)                                                                                                   |
| 15  | Graves' disease / autoimmune thyroid (→)                                | MR OR `1.056`, no CI reported                                                                                                           | MR only                                          | **C**                         | Marginal band, no CI, genetically-defined population (R18, R20)                                                                                                                       |
| 16  | All-cause dementia (→)                                                  | Pooled `1.61` (>1.6M), `1.75` (1.55–1.97); veterans `2.31` → adjusted `1.77`                                                            | ≥2                                               | **A**                         | Independent populations; persists after head injury, substance abuse, depression                                                                                                      |
| 17  | Alzheimer's disease (→)                                                 | `31%` elevation                                                                                                                         | ≥1                                               | **C**                         | Single estimate, no CI, phenotype not separated from all-cause dementia                                                                                                               |
| 18  | Vascular dementia (→)                                                   | `80%` elevation                                                                                                                         | 1                                                | **C**                         | Single estimate, no CI (R20)                                                                                                                                                          |
| 19  | Parkinson's disease / DLB (→)                                           | Pooled `1.88` (1.08–3.24)                                                                                                               | 1 pooled                                         | **C**                         | CI lower bound near 1; retrospective/case-control base                                                                                                                                |
| 20  | Cognitive decline / hippocampal atrophy (→)                             | Accelerated annual working-memory decline; mediators: multisite pain, `APOE-e4`                                                         | ≥1                                               | **C**                         | Intermediate/cognitive-marker outcomes; modifier evidence incomplete                                                                                                                  |
| 21  | Insomnia (↔)                                                            | OR `7.13` in traumatized cohorts; affects `70–90%` of PTSD patients                                                                     | ≥2                                               | **B + M**                     | Very large and replicated, but bidirectional and partly definitional (insomnia is in the PTSD criteria) — direction row split required (R32)                                          |
| 22  | Obstructive sleep apnea (↔)                                             | Pooled prevalence `75.7%` (AHI ≥5), `43.6%` (AHI ≥10); `69.2%` high-risk screening in young veterans, independent of BMI and age        | ≥3                                               | **B**                         | Incidence data not reported; prevalence rows cannot carry an incidence claim (R8)                                                                                                     |
| 23  | Narcolepsy (→)                                                          | Prevalence `≈1%` in first responders; **no incidence data**                                                                             | 1                                                | **D**                         | Mechanism (orexin/hypocretin) does not upgrade an untested association (R39)                                                                                                          |
| 24  | ME/CFS (→)                                                              | Adjusted ORs `3–6×` in veteran trauma populations (one source) vs "sparse; no direct evidence" (another)                                | 1                                                | **C**                         | Direct conflict between sources; single population (R16, R44)                                                                                                                         |
| 25  | Functional somatic syndromes (FM, CFS, IBS, TMD) (→)                    | Trauma exposure `2.7×` (2.27–3.10), larger in full PTSD than in trauma-exposed non-PTSD; `≥49.7%` of chronic TMD patients report trauma | ≥2                                               | **B**                         | The trauma-vs-PTSD contrast is the strongest design feature in the corpus (R7)                                                                                                        |
| 26  | Severe / life-threatening infection (→)                                 | `1.92` siblings-controlled; meningitis `1.63`; endocarditis `1.57`                                                                      | 1 (Swedish registers)                            | **B**                         | Sibling matching controls familial confounding; single registry, no absolute anchoring                                                                                                |
| 27  | Leukocyte telomere shortening (→)                                       | `g = −1.27`; PTSD + depression equal to `7.62–9.71` additional years                                                                    | ≥2                                               | **B + M**                     | Marker outcome; tier capped as intermediate (R10), mediated by stress/immune pathways                                                                                                 |
| 28  | Endothelial/inflammatory intermediates (→)                              | FMD `5.8%` vs `7.5%`; rising VCAM-1 and TNFRII over 10–16 years                                                                         | ≥2                                               | **C (m1)**                    | Intermediate markers cannot exceed `C` without prospective incident-disease linkage (R10, R40)                                                                                        |
| 29  | Neurodegenerative biomarkers → dementia (→)                             | Aβ40/42, p-tau181, NfL prospectively linked to dementia incidence                                                                       | 1 (WTC)                                          | **B (m2)**                    | The only prospective biomarker→incident-disease link in the corpus (R40)                                                                                                              |
| 30  | All-cause mortality, year 1 (→)                                         | `3.19` vs matched population; `3.21` vs siblings                                                                                        | 1                                                | **C**                         | Acute window is presumptively severity/reverse-causation driven (R33)                                                                                                                 |
| 31  | All-cause mortality, >1 year (→)                                        | `1.64`, persisting indefinitely                                                                                                         | 1                                                | **B**                         | Sibling-controlled, long follow-up; single registry                                                                                                                                   |
| 32  | Post-MI PTSD (←)                                                        | Prevalence `21.2%` globally; `27.5%` in Chinese populations                                                                             | ≥2                                               | **B**                         | Reverse-direction row, kept separate (R32)                                                                                                                                            |
| 33  | PTSD after acute trauma, by sleep reactivity (←)                        | `45.5%` vs `11.1%` onset in high sleep reactivity                                                                                       | 1                                                | **C**                         | Single population; predictor study, not incidence mapping                                                                                                                             |
| 34  | Renal, hepatic, oncologic, arrhythmia/sudden death, external causes (→) | —                                                                                                                                       | —                                                | **D — no studies identified** | Empty domains recorded explicitly (R43). Source mentions of rare malignancy associations and arrhythmia risk are mechanism/speculation without estimates                              |

**Reading the worked map.** `A`-tier rows: incident CHD, any CVD, MI, T2D (mediated), all-cause dementia. Everything cardiac-and-strong is cardiovascular or metabolic; the autoimmune, sleep, infection, and mortality rows sit at `B` on single registries or unanchored absolutes; and the largest single gap is the bottom row — a psychiatrically-defined condition mapped for thirty-three physical outcomes with no row at all for suicide, overdose, or external-cause mortality.

---

## 16. Governance and change control

- **Version and date every map.** Estimates, codes, and phenotype definitions all drift.
- **Two reviewers, two lenses.** A clinician verifies case definitions, codes, and mechanism tiers; an actuary verifies effect-size use, absolute-risk anchoring, and that relative risks are never presented without baseline risk.
- **Update triggers.** A new pooled analysis or guideline in any row; any change to the index-condition case definition; any change to the coding system; any contradicted row.
- **Downstream use limit.** This map classifies population-level relationships between an index condition and outcomes. It is **not** an individual prognosis, an eligibility finding, a rating, or a carrier decision, and it must not be rendered into user-facing copy. Any product-facing use requires counsel review against the applicable jurisdiction's rules on health information and unfair or deceptive practices.
- **No number leaves the map without its stratum, estimator, and source.** A bare hazard ratio is the failure mode this entire document exists to prevent.

---

## 17. Cross-check against the condition vocabulary

This map and `lifechat-condition-v1` (the application's condition crosswalk, §2.1 of the medical capture doc) answer different questions, and the difference is worth stating so neither is read as the other. The vocabulary asks _can we see a condition a person states, and resolve it to a code?_ The map asks _does the index condition raise the risk of this outcome, and how well is that measured?_ A condition entering the vocabulary is therefore **not** a claim that it is a sequela, and a condition absent from the map is **not** a claim that it is not.

**R48 — Every condition added to the vocabulary carries a cross-check mark.** One of exactly three, and a mark must name its reason:

| Mark            | Meaning                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graded_row`    | A row in this map covers the condition's outcome class. The entry names the row and repeats **that row's tier**, so the two cannot drift.                      |
| `d_no_studies`  | A plausible sequela that no reviewed source measured. Recorded as `D — no studies identified` per R43, never as evidence of no association.                    |
| `not_a_sequela` | The condition cannot follow the index condition at all — present at birth, chromosomal, or hereditary with childhood onset. This is an _exclusion_, not a gap. |

**R49 — A mark that cannot name a §12 domain names the sweep gap instead.** Cross-checking the 30 conditions vocabulary 1.4.0 added found nine with no domain at all: the §12 sweep has no home for dermatologic (acne, keloid), lymphatic (lymphedema), urologic/genital (varicocele), ophthalmologic (retinal detachment), or congenital/developmental (cleft palate, club foot, Turner syndrome, fragile X) outcomes. Those conditions carry a written `domain_gap`; forcing them into an unrelated domain would hide the gap rather than record it.

**R50 — An empty domain uncovered by a cross-check is work, not a footnote.** The same cross-check found that five domains the conditions fell into — renal, neurological, respiratory, gastrointestinal/hepatobiliary, and oncologic — had no row in the map at all, so no mark could be made against one. They were added as explicit `D` rows (R43), together with the two rows §15 already supported (severe infection at tier B, and the `trauma` stratum functional-somatic row R7 makes mandatory). A cross-check that finds a domain with nowhere to stand has found map work.

**R51 — The cross-check is derived, not duplicated.** The marks live in `src/phenome/sequelae-crosswalk.ts`, one entry per condition, and the test suite reads the map and the vocabulary's own changelog to verify them: the codes must equal the release's `added` list, every referenced row must exist, and every `graded_row` tier must equal the row's tier. A stale mark fails the build.

**First result (1.4.0, 30 conditions).** Exactly one condition — paroxysmal supraventricular tachycardia — is covered by any row at all, and that row is tier `D` (mechanism-only, reduced heart-rate variability). Twenty-three are study gaps. Six are excluded as non-sequelae. The honest summary is that the questionnaire-sweep conditions and the phenome literature barely overlap: the map measures catastrophic outcomes (cardiovascular events, dementia, mortality, autoimmune disease), and the questionnaire enumerates everyday chronic conditions that no cohort in this corpus reports.

---

## Appendix — Audit findings against the three source documents

Recorded so the next revision has something to fix:

1. **Absent domains:**
   - **Suicide and external-cause mortality** — absent from all three documents. For an index condition defined by trauma exposure, this is the single largest omission.
   - **Renal, hepatic, and most oncologic outcomes** — effectively absent; must be recorded as `D — no studies identified`, not silently dropped.
   - **Arrhythmia and sudden cardiac death** — asserted mechanistically (reduced HRV, ventricular arrhythmia risk) with no epidemiology.
   - **Atrial fibrillation, hypertension incidence** — no pooled estimates anywhere in the corpus.
2. **Internal conflicts left unresolved:** MS `2.30` vs `1.302`; SLE `1.40` vs `2.94`; all-cause dementia `1.61` vs `1.75`; CHD `27–55%` vs `55–61%`; IBD range `1.14` to `>2–6`. Doc B's autoimmune table and Doc C's cohort section describe the same diseases with different numbers.
3. **Attribution error to exclude:** maternal autoimmune disease → offspring CVD (`HR 1.19`) is presented near PTSD-autoimmune content but is not a PTSD sequela (R45).
4. **Confidence language to discount:** Doc B ("unequivocally establishes", "staggering hazard ratios"), Doc C ("definitively links", "profoundly elevated") outrun the evidence design in their own documents — most rows rest on single registries or a single cohort family (R3, R16).
5. **Single-population over-representation:** NHS II, the Swedish registers, the WTC responder cohorts, and VHA/MVP supply the majority of the quantitatively strongest rows. Independence must be tracked explicitly (R16).
6. **Shared-cohort reporting:** the same registry yields autoimmune, infection, and mortality estimates; the same cohort yields CVD, T2D, SLE, and telomere findings. Cross-row dependency is not disclosed in the sources.
7. **Publication-bias and heterogeneity reporting is thin**, except one explicit warning that CRP meta-analyses are highly heterogeneous — which by R15 caps those estimates well below precise.

### Added in 1.1.0 — findings from the vocabulary cross-check (§17)

8. **The §12 domain sweep is not exhaustive of the conditions an application asks about.** Cross-checking the 30 conditions vocabulary 1.4.0 added found nine with no domain: dermatologic, lymphatic, urologic/genital, ophthalmologic, and congenital/developmental outcomes are outside the sweep entirely. The next revision of §12 should either add those domains or state explicitly that the map is an index-condition map for catastrophic physical outcomes and not a catalogue of every condition a person can state (R49).
9. **The map's own ledgers referenced rows that did not exist.** The 1.0.0 map declared verification gaps and rule tensions for eleven §15 rows it had not yet materialized, plus domain-coverage gaps with no row to carry them. Map 1.1.0 adds the rows a cross-check can stand on (five `D` domain rows, the tier B severe-infection row, and the `trauma` stratum row), declares the rest in `open_items`, and the test suite now requires every ledger reference to resolve and every remaining rule violation to be declared with its reason.
