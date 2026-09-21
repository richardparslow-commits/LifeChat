/**
 * Vocabulary ↔ phenome crosswalk — the mark every condition added to
 * `lifechat-condition-v1` carries once it has been checked against the PTSD
 * phenome map.
 *
 * Why this exists: the vocabulary and the phenome map grew from different
 * sources and answer different questions. The vocabulary asks "can the gate see
 * a condition a person states, and can the broker resolve it to a code?" The
 * map asks "does PTSD raise the risk of this outcome, and how well is that
 * measured?" A condition entering the vocabulary is therefore *not* a claim that
 * it is a PTSD sequela, and a condition absent from the map is *not* a claim
 * that it is not — the map records what the reviewed literature measured, and
 * "no studies identified" is a finding, not a null (R43).
 *
 * This module makes that relationship explicit and testable. Every entry is one
 * of three verdicts, and there is no fourth:
 *
 *   `graded_row`      the phenome map carries a row whose outcome class covers
 *                     this condition; the entry names the row and repeats the
 *                     row's tier, which a test pins against the map so the two
 *                     cannot drift.
 *   `d_no_studies`    the condition is a plausible sequela and no study of it
 *                     appears in the reviewed sources. The rule set requires
 *                     that to be recorded, never read as "no association"
 *                     (R43, §11 tier D).
 *   `not_a_sequela`   the condition cannot be a sequela of a later exposure —
 *                     it is present at birth, chromosomal, or hereditary with
 *                     childhood onset. The mark is an exclusion with a reason,
 *                     not an evidence gap.
 *
 * The first cross-check is the 30 conditions vocabulary **1.4.0** added (the
 * questionnaire-sweep gap). Its result is deliberately unflattering: **one**
 * condition (paroxysmal supraventricular tachycardia) is covered by any map row
 * at all, and that row is tier `D` — mechanism-only. Every other condition is a
 * mark. That is the honest answer to "are the questionnaire-sweep conditions
 * PTSD sequelae?": the reviewed literature does not measure them either way,
 * and the domains several of them fall into (renal, respiratory, neurologic,
 * hematologic) had no row at all until this cross-check forced one.
 *
 * Design choices worth naming:
 *   - The crosswalk is a *derivation*, not a second map: rows, tiers, and
 *     domains are read from `docs` → `ptsd-phenome-map.json` at test time.
 *   - A `domain: null` entry must carry `domain_gap`: the §12 sweep has no
 *     domain for dermatologic, lymphatic, urologic/genital, or
 *     congenital/developmental outcomes, and forcing those conditions into an
 *     unrelated domain would hide the gap instead of recording it.
 *   - `next_step` is required. A mark that does not say what would move it is a
 *     dead end, and this artifact exists to be worked, not filed.
 */

import { CONDITION_VOCABULARY_CHANGELOG } from '../medical/condition-crosswalk';
import { PHENOME_DOMAIN_NUMBERS } from './phenome-map-schema';

/** Version/date of the crosswalk itself, independent of the map's version. */
export const SEQUELAE_CROSSWALK_VERSION = '1.0.0';
export const SEQUELAE_CROSSWALK_DATE = '2026-09-19';

/** The vocabulary release this crosswalk covers. */
export const SEQUELAE_CROSSWALK_RELEASE = '1.4.0';

export type SequelaVerdict = 'graded_row' | 'd_no_studies' | 'not_a_sequela';

export interface SequelaCrosswalkEntry {
  /** The vocabulary code the condition was added under. */
  icd10_cm: string;
  /** Canonical vocabulary name. */
  name: string;
  /** Vocabulary body system. */
  system: string;
  /** §12 domain number, or null when the sweep has no domain for the outcome. */
  domain: number | null;
  /** Required when `domain` is null: which part of the sweep is missing. */
  domain_gap: string | null;
  verdict: SequelaVerdict;
  /**
   * Phenome map rows this condition relates to: the row the verdict rests on,
   * or the domain row that carries the mark.
   */
  phenome_rows: string[];
  /** The tier of the map row the verdict rests on, or null for a pure mark. */
  phenome_tier: 'A' | 'B' | 'C' | 'D' | 'X' | null;
  /** Why this verdict — names the deciding rule or the absent evidence. */
  rationale: string;
  /** What would move this mark to evidence. */
  next_step: string;
}

export const SEQUELAE_CROSSWALK: readonly SequelaCrosswalkEntry[] = [
  {
    icd10_cm: 'I42.9',
    name: 'Cardiomyopathy, unspecified',
    system: 'cardiovascular',
    domain: 1,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'The §12 cardiovascular sweep names coronary disease, myocardial infarction, heart failure, hypertension, and arrhythmia/sudden death; cardiomyopathy is none of those outcomes and no reviewed source reports an estimate for it (R43).',
    next_step:
      'Add a row only when a cohort reports incident cardiomyopathy or heart failure with reduced ejection fraction separately from the composite HF hospitalization row (which is tier C and a different outcome).',
  },
  {
    icd10_cm: 'I40.9',
    name: 'Acute myocarditis, unspecified',
    system: 'cardiovascular',
    domain: 1,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'Myocarditis is an inflammatory cardiac disease; the map has an inflammatory domain (6) for *markers* only, and no source reports incident myocarditis (R10, R43).',
    next_step:
      'Treat as a marker-plus-endpoint problem: a myocarditis row needs an incident-disease estimate, not a CRP or IL-6 association (R10).',
  },
  {
    icd10_cm: 'I30.9',
    name: 'Acute pericarditis, unspecified',
    system: 'cardiovascular',
    domain: 1,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'Named in the §12 cardiovascular sweep only as part of “other forms of heart disease”; no estimate appears in the corpus and the autoimmune rows do not cover it (R43).',
    next_step:
      'Sweep the autoimmune registries for pericarditis as a distinct outcome; if it appears only inside a composite, record the composite, not a guess at the specific code.',
  },
  {
    icd10_cm: 'I47.9',
    name: 'Paroxysmal tachycardia, unspecified (SVT)',
    system: 'cardiovascular',
    domain: 1,
    domain_gap: null,
    verdict: 'graded_row',
    phenome_rows: ['ptsd-to-arrhythmia-sudden-cardiac-death'],
    phenome_tier: 'D',
    rationale:
      'Supraventricular tachycardia is a cardiac arrhythmia, and the map carries the arrhythmia/sudden-cardiac-death outcome class as a tier D row: asserted mechanistically through reduced heart-rate variability with no epidemiological estimate anywhere in the corpus (R39, R43). The condition therefore has a row, and the row is empty of evidence — both facts are the verdict.',
    next_step:
      'Promote only when a source prints an arrhythmia incidence estimate; a mechanism without epidemiology cannot lift the row above D (R39).',
  },
  {
    icd10_cm: 'E78.1',
    name: 'Hypertriglyceridemia',
    system: 'metabolic',
    domain: 3,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: ['ptsd-to-metabolic-syndrome'],
    phenome_tier: null,
    rationale:
      'The metabolic-syndrome row is a syndrome-level outcome (tier B) and its notes record dyslipidemia as named in the sweep but unstudied; no PTSD→lipid estimate exists in the corpus, so the syndrome row cannot carry this condition (R8, R43).',
    next_step:
      'Add a dyslipidemia row when a cohort reports lipids separately; do not inherit the metabolic-syndrome estimate, because the syndrome definition itself includes the lipid criterion.',
  },
  {
    icd10_cm: 'E87.1',
    name: 'Hyponatremia',
    system: 'metabolic',
    domain: 3,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'Electrolyte abnormalities are named in the §12 metabolic/endocrine sweep; no reviewed source reports an estimate, and a laboratory finding alone could not exceed tier C (R10, R43).',
    next_step:
      'Sweep for a sodium outcome with a printed estimate; a single lab-value association stays an intermediate marker row.',
  },
  {
    icd10_cm: 'E83.52',
    name: 'Hypercalcemia',
    system: 'metabolic',
    domain: 3,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'No estimate in the corpus; the parathyroid and vitamin-D pathways are mechanism talk in the sources with no epidemiology (R39, R43).',
    next_step: 'Same sweep as the other electrolytes; keep the marker/endpoint split (R10).',
  },
  {
    icd10_cm: 'E79.0',
    name: 'Hyperuricemia without signs of inflammatory arthritis',
    system: 'metabolic',
    domain: 3,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'Gout and urate are named in the metabolic sweep; the sources name the pathway (allostatic load, purine turnover) but print no estimate (R39, R43).',
    next_step:
      'Add a gout/urate row when a cohort reports it; the musculoskeletal domain (12) currently carries only the functional-somatic trauma row.',
  },
  {
    icd10_cm: 'E29.1',
    name: 'Testicular hypofunction (hypogonadism)',
    system: 'metabolic',
    domain: 3,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'Named in the questionnaire sweep; the corpus contains no gonadal-axis estimate, and a testosterone level alone is a marker (R10, R43).',
    next_step:
      'Sweep the veteran cohorts that report testosterone outcomes; keep the marker row separate from any diagnosis row.',
  },
  {
    icd10_cm: 'E20.9',
    name: 'Hypoparathyroidism, unspecified',
    system: 'metabolic',
    domain: 3,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'No estimate in the corpus, and the parathyroid pathway is asserted nowhere in the sources — a gap rather than a hypothesis (R43).',
    next_step:
      'A single small study would land at tier C at best; record it when it exists, not before.',
  },
  {
    icd10_cm: 'N05.9',
    name: 'Unspecified nephritic syndrome (glomerulonephritis)',
    system: 'renal',
    domain: 4,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: ['ptsd-to-renal-outcomes'],
    phenome_tier: 'D',
    rationale:
      'The §12 renal domain had no row at all; the cross-check forced one, and that row records no studies identified in the reviewed sources (R43). Appendix item 1 names renal outcomes as effectively absent from all three documents.',
    next_step:
      'The renal row is the work queue: an incident AKI/CKD/glomerulonephritis estimate from any of the four registry families already used elsewhere in the map would be the first evidence on it.',
  },
  {
    icd10_cm: 'J33.9',
    name: 'Unspecified nasal polyp',
    system: 'respiratory',
    domain: 10,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: ['ptsd-to-respiratory-outcomes'],
    phenome_tier: 'D',
    rationale:
      'The respiratory domain row records no studies identified; the corpus reports asthma and COPD only as sweep names, with no estimate (R43).',
    next_step:
      'An airway-inflammation row would need an incident diagnosis estimate; nasal polyps are a plausible chronic-inflammation endpoint but currently a hypothesis.',
  },
  {
    icd10_cm: 'R09.1',
    name: 'Pleurisy',
    system: 'respiratory',
    domain: 10,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: ['ptsd-to-respiratory-outcomes'],
    phenome_tier: 'D',
    rationale:
      'Symptom-level phrasing with no estimate in the corpus; the respiratory domain row carries the mark (R43).',
    next_step:
      'Treat as part of the pleural-disease sweep in the respiratory row; a symptom row alone cannot be graded above C.',
  },
  {
    icd10_cm: 'J93.9',
    name: 'Pneumothorax, unspecified',
    system: 'respiratory',
    domain: 10,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: ['ptsd-to-respiratory-outcomes'],
    phenome_tier: 'D',
    rationale:
      'No estimate in the corpus. A smoking-mediated pathway is plausible, and smoking is a mandatory covariate (R24), which is why this is a study gap rather than a mechanism claim.',
    next_step: 'Same respiratory row; do not add a second row until an estimate exists.',
  },
  {
    icd10_cm: 'K31.84',
    name: 'Gastroparesis',
    system: 'gastrointestinal',
    domain: 11,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: ['ptsd-to-gastrointestinal-hepatobiliary-outcomes'],
    phenome_tier: 'D',
    rationale:
      'The gastrointestinal/hepatobiliary domain row records no studies identified; the corpus carries IBD as its only GI outcome, and gastroparesis is a distinct endpoint (R43).',
    next_step:
      'An autonomic-neuropathy pathway is plausible (the same autonomic story as the arrhythmia row), but a mechanism does not upgrade an untested association (R39).',
  },
  {
    icd10_cm: 'G44.209',
    name: 'Tension-type headache, unspecified, not intractable',
    system: 'neurological',
    domain: 8,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: ['ptsd-to-neurological-outcomes'],
    phenome_tier: 'D',
    rationale:
      'Headache appears in the sources only as symptom language; the neurological domain row records no studies identified, and head injury is a confounder in R24 rather than a sequela (R43).',
    next_step:
      'A headache/migraine row is defensible if any source prints an incidence estimate; until then it stays in the neurological domain row.',
  },
  {
    icd10_cm: 'F95.2',
    name: 'Combined vocal and multiple motor tic disorder (Tourette syndrome)',
    system: 'mental_health',
    domain: 8,
    domain_gap: null,
    verdict: 'not_a_sequela',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'Tourette syndrome is a childhood-onset neurodevelopmental disorder: the onset precedes any index PTSD diagnosis by definition, so it cannot be a sequela of it. This is an exclusion with a reason, not an evidence gap (§3 latency and temporality).',
    next_step:
      'Keep it in the vocabulary (a person can state it) and out of the map; revisit only if the index condition becomes childhood trauma exposure rather than PTSD.',
  },
  {
    icd10_cm: 'G91.9',
    name: 'Hydrocephalus, unspecified',
    system: 'neurological',
    domain: 8,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: ['ptsd-to-neurological-outcomes'],
    phenome_tier: 'D',
    rationale:
      'No estimate in the corpus; the neurological domain row carries the mark. Adult hydrocephalus is a plausible post-traumatic outcome but neither TBI nor hydrocephalus is mapped as a sequela (R43).',
    next_step:
      'If added, it belongs with the TBI row when that row exists, because the pathway runs through head injury (R24).',
  },
  {
    icd10_cm: 'G71.0',
    name: 'Muscular dystrophy',
    system: 'musculoskeletal',
    domain: 12,
    domain_gap: null,
    verdict: 'not_a_sequela',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'Hereditary myopathy with childhood onset: the cause precedes exposure, so a PTSD sequela claim is not testable and the condition is excluded with a reason rather than marked as unstudied.',
    next_step:
      'Keep the exclusion; if a source reports muscle-wasting outcomes generally, map that outcome, not this diagnosis.',
  },
  {
    icd10_cm: 'H33.20',
    name: 'Retinal detachment, unspecified eye',
    system: 'ophthalmologic',
    domain: null,
    domain_gap:
      'The §12 sweep has no ophthalmologic domain; the closest is domain 8 (neurological), which would misclassify it.',
    verdict: 'd_no_studies',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'No estimate in the corpus, and no §12 domain covers eye outcomes — recorded as a gap in the sweep rather than forced into an unrelated domain (R43, and the coverage open item in the map).',
    next_step:
      'Add an ophthalmologic domain to the §12 sweep (or extend domain 8 explicitly) before adding a row; an unstubbed domain is a rule-set change, not a data change.',
  },
  {
    icd10_cm: 'Q35.9',
    name: 'Cleft palate, unspecified',
    system: 'congenital',
    domain: null,
    domain_gap:
      'The §12 sweep has no congenital/developmental domain; such conditions are present at birth rather than acquired.',
    verdict: 'not_a_sequela',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'A congenital malformation present at birth cannot be caused by a later index diagnosis; the vocabulary carries it because a person can state it, not because it is a sequela.',
    next_step:
      'Keep the exclusion. A transgenerational question would need its own exposure (parental PTSD), which domain 19 is for (R45).',
  },
  {
    icd10_cm: 'Q66.89',
    name: 'Other specified congenital deformities of feet (club foot)',
    system: 'congenital',
    domain: null,
    domain_gap: 'No congenital/developmental domain in the §12 sweep.',
    verdict: 'not_a_sequela',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'A congenital deformity present at birth: the cause precedes any index diagnosis, so the condition is excluded rather than marked unstudied (temporality).',
    next_step:
      'Keep the exclusion; club foot is vocabulary coverage for what a person can state, not a sequela hypothesis awaiting data.',
  },
  {
    icd10_cm: 'Q96.9',
    name: 'Turner syndrome, unspecified',
    system: 'congenital',
    domain: null,
    domain_gap:
      'No congenital/developmental domain in the §12 sweep; chromosomal conditions are not acquired outcomes.',
    verdict: 'not_a_sequela',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'Chromosomal condition present from conception; a PTSD sequela claim is a category error rather than an untested hypothesis.',
    next_step:
      'Keep the exclusion. The karyotype is fixed before exposure, so no study design could make this a sequela row.',
  },
  {
    icd10_cm: 'Q99.2',
    name: 'Fragile X syndrome',
    system: 'congenital',
    domain: null,
    domain_gap:
      'No congenital/developmental domain in the §12 sweep; hereditary conditions are not acquired outcomes.',
    verdict: 'not_a_sequela',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'Hereditary X-linked condition present from conception: excluded with a reason, which is a different mark from an evidence gap (R43).',
    next_step:
      'Keep the exclusion; if a source reports neurodevelopmental outcomes generally, map that outcome rather than this diagnosis.',
  },
  {
    icd10_cm: 'D45',
    name: 'Polycythemia vera',
    system: 'hematologic',
    domain: 14,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'The hematologic/cellular-aging domain (14) has no row in this map version — the map’s declared coverage gap names it — and no source reports a myeloproliferative-neoplasm estimate (R43).',
    next_step:
      'The telomere row declared in §15 is the natural occupant of domain 14; add it (a marker row, capped at C unless it prospectively predicts incident disease, R10) rather than a polycythemia row nothing supports.',
  },
  {
    icd10_cm: 'L70.0',
    name: 'Acne vulgaris',
    system: 'dermatologic',
    domain: null,
    domain_gap:
      'The §12 sweep has no dermatologic domain; acne is neither an inflammatory intermediate (domain 6) nor a functional somatic outcome (domain 12).',
    verdict: 'd_no_studies',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'A skin condition with an endocrine/inflammatory pathway hypothesized in the stress literature but no estimate in the reviewed corpus (R43).',
    next_step:
      'Add a dermatologic domain to §12, then sweep; do not smuggle skin outcomes into the inflammatory-intermediate domain, which is markers only (R10).',
  },
  {
    icd10_cm: 'L91.0',
    name: 'Hypertrophic scar (keloid)',
    system: 'dermatologic',
    domain: null,
    domain_gap: 'No dermatologic domain in the §12 sweep.',
    verdict: 'd_no_studies',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'Same domain gap as acne — no dermatologic domain in the §12 sweep — and no estimate for scar outcomes in the reviewed corpus (R43).',
    next_step:
      'Same domain addition; wound-healing is unlikely to be studied in these cohorts, so expect a long-lived D row.',
  },
  {
    icd10_cm: 'I89.0',
    name: 'Lymphedema, not elsewhere classified',
    system: 'cardiovascular',
    domain: null,
    domain_gap:
      'The §12 sweep has no lymphatic domain; domain 14 is hematologic/cellular aging and domain 1 is cardiovascular clinical events, and neither names lymphatic disease.',
    verdict: 'd_no_studies',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'No estimate in the corpus; the domain gap is the finding rather than the mark alone (R43).',
    next_step:
      'Add the lymphatic domain when the §12 sweep is next revised, then map it; the varicocele row below shares the gap.',
  },
  {
    icd10_cm: 'I86.1',
    name: 'Scrotal varices (varicocele)',
    system: 'urologic',
    domain: null,
    domain_gap:
      'The §12 sweep has a renal/urinary domain (4), which this condition does not belong to; there is no urologic/genital domain.',
    verdict: 'd_no_studies',
    phenome_rows: [],
    phenome_tier: null,
    rationale:
      'No estimate in the corpus, and linking it to the renal domain row would misstate what that row covers (R45 attribution thinking applied to outcomes).',
    next_step:
      'Add a urologic/genital domain to §12; a venous-mechanism hypothesis (shared with varicose veins) is not evidence.',
  },
  {
    icd10_cm: 'B00.9',
    name: 'Herpesviral infection, unspecified (herpes simplex)',
    system: 'infectious',
    domain: 15,
    domain_gap: null,
    verdict: 'd_no_studies',
    phenome_rows: ['ptsd-to-severe-infection'],
    phenome_tier: 'B',
    rationale:
      'Domain 15 has a graded row — severe/life-threatening infection at tier B (siblings-controlled) — but it covers hospitalized severe infection (meningitis 1.63, endocarditis 1.57), not common viral infections. A common infection is a different outcome and cannot inherit that estimate (R8, R11).',
    next_step:
      'Sweep reactivation and common-infection outcomes separately; reactivation data would be a distinct row and a distinct code.',
  },
];

/** One entry per vocabulary condition, keyed by ICD-10-CM code. */
const crosswalkIndex = new Map(SEQUELAE_CROSSWALK.map((entry) => [entry.icd10_cm, entry]));

/** Looks up a condition's crosswalk entry by code (case-insensitive). */
export function sequelaeCrosswalkFor(icd10Cm: string): SequelaCrosswalkEntry | null {
  return crosswalkIndex.get(icd10Cm.trim().toUpperCase()) ?? null;
}

/** The codes 1.4.0 added, read from the vocabulary's own changelog. */
export function vocabularyReleaseCodes(release = SEQUELAE_CROSSWALK_RELEASE): string[] {
  const revision = CONDITION_VOCABULARY_CHANGELOG.find((entry) => entry.version === release);
  return revision ? [...revision.added] : [];
}

export interface CrosswalkSummary {
  release: string;
  total: number;
  byVerdict: Record<SequelaVerdict, number>;
  /** Entries whose verdict rests on a phenome row, with that row's tier. */
  withRow: { icd10_cm: string; phenome_rows: string[]; tier: string | null }[];
  /** Entries the §12 sweep cannot place, with the gap stated. */
  domainGaps: { icd10_cm: string; domain_gap: string }[];
}

/** Totals for the release, computed rather than asserted. */
export function summarizeSequelaeCrosswalk(
  entries: readonly SequelaCrosswalkEntry[] = SEQUELAE_CROSSWALK,
  release = SEQUELAE_CROSSWALK_RELEASE,
): CrosswalkSummary {
  const byVerdict: Record<SequelaVerdict, number> = {
    graded_row: 0,
    d_no_studies: 0,
    not_a_sequela: 0,
  };
  for (const entry of entries) byVerdict[entry.verdict] += 1;
  return {
    release,
    total: entries.length,
    byVerdict,
    withRow: entries
      .filter((entry) => entry.phenome_rows.length > 0)
      .map((entry) => ({
        icd10_cm: entry.icd10_cm,
        phenome_rows: [...entry.phenome_rows],
        tier: entry.phenome_tier,
      })),
    domainGaps: entries
      .filter((entry) => entry.domain === null)
      .map((entry) => ({ icd10_cm: entry.icd10_cm, domain_gap: entry.domain_gap ?? '' })),
  };
}

/** True when the domain number is one of the §12 sweep's declared domains. */
export function isPhenomeDomain(domain: number): boolean {
  return (PHENOME_DOMAIN_NUMBERS as readonly number[]).includes(domain);
}
