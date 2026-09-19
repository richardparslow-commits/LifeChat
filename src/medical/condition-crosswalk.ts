/**
 * Canonical medical-condition crosswalk (Phase 2, consented medical fact-finding)
 *
 * Purpose: the model records conditions the user states in their own words
 * (`MedicalProfile.medical_conditions: string[]`). Free text cannot be matched
 * or queried, so this module maps that text onto a small, versioned,
 * canonical vocabulary — one ICD-10-CM code + canonical name + body system per
 * condition — so the licensed broker can group and query a profile the same way
 * every time.
 *
 * Design rules (deliberate, and the reason this module is so literal):
 *
 *   1. CONSENT GATE FIRST — `mapConsentedMedicalConditions()` is the only
 *      entry point that touches a user's stated conditions, and it returns
 *      `null` unless health-data capture is enabled AND medical consent is
 *      affirmed AND versioned. The crosswalk never becomes a side door around
 *      the §9.1 / HEALTH_DATA_COLLECTION_DISABLED gate enforced in
 *      src/index.ts and src/security/security-controls.ts.
 *   2. NEVER GUESS — matching is exact against a curated alias index (after
 *      light text normalization). There is no fuzzy, prefix, or substring
 *      matching, and no code is ever inferred. Text that does not match is
 *      returned in `unmapped` and left in the user's own words; "complete"
 *      mapping means every condition is either matched or explicitly flagged,
 *      never silently coerced onto the nearest code.
 *   3. ADDITIVE, NOT DESTRUCTIVE — the user's stated wording
 *      (`medical_conditions`) is preserved verbatim on the record. Canonical
 *      refs are stored alongside it, tagged with the vocabulary id + version so
 *      a later mapping change is reproducible and auditable.
 *   4. CLINICAL NORMALIZATION ONLY — a canonical ref classifies what the user
 *      reported. It is never an underwriting judgment, an eligibility finding,
 *      a rating, or a carrier decision, and it is never shown to the user.
 *   5. SENSITIVE BY CLASSIFICATION — canonical refs are TDPSA sensitive health
 *      data. They belong only in the encrypted operational lead record: never
 *      in analytics, session history, logs, or the chat response.
 *
 * The vocabulary covers the domains the review literature and the approved
 * medical topics exercise (cardiovascular, metabolic,
 * autoimmune/inflammatory, neurodegenerative, respiratory, sleep, renal,
 * musculoskeletal, gastrointestinal, mental health, oncologic, hematologic,
 * infectious), including the systemic physical outcomes the PTSD phenome
 * syntheses report beyond the classic cardiovascular/metabolic rows — acute
 * cardiac events and arrhythmia, venous thromboembolism, transient ischemic
 * attack and neuropathy, traumatic brain injury, obstructive airways disease,
 * restless legs, nephrotic disease and renal calculi, low bone density, hepatic
 * disease, the major tumor sites, and the bacterial/infectious rows. It also
 * carries the common-chronic domains the literature sweep never reached but a
 * carrier medical-history questionnaire still enumerates: gynecologic/
 * reproductive, urologic, dermatologic, ophthalmologic/otologic, ENT/oral,
 * congenital/developmental, and the residual musculoskeletal,
 * gastrointestinal, hematologic, infectious, oncologic, endocrine,
 * respiratory, and mental-health rows.
 *
 * COVERAGE IS COMPLETE, NOT MERELY LARGER, and "complete" is a declared scope
 * rather than a promise. Eight scopes are declared and enforced — 1.2.0's
 * common-chronic questionnaire set, 1.3.0's residual gap, 1.4.0's
 * questionnaire sweep, 1.6.0's critical-illness covered-condition lists,
 * 1.7.0's ICD-10 Chapter IX enumeration, 1.8.0's stone-family residue, and
 * 1.9.0's ICD-10 Chapter XIV enumeration (the chapter the stone family sits in,
 * N00–N99) — each of them a measured gap rather than an assumption, and each
 * carrying a `CAPTURE_SCOPE`-shaped ledger whose code list must equal its
 * release's `added` list. The probe and corpus terms
 * themselves are kept verbatim in the test suite with a standing assertion that
 * nothing they surfaced is left ungated. Two ledgers enforce it in
 * `tests/medical-condition-gate.test.ts`: (1) every canonical alias is
 * classified as health data by the gate (or is a documented exclusion), and
 * every term the gate watches for either resolves to a canonical entry or
 * appears on the documented list of descriptive terms (body systems,
 * measurements, symptoms, pathoanatomic categories) that are not reportable
 * conditions — so a condition term cannot be added to the gate without a
 * crosswalk entry or vice versa; and (2) `CAPTURE_SCOPE` declares the common
 * chronic conditions a medical-history questionnaire enumerates, each with the
 * code it must resolve to, and asserts both that every declared phrase reaches
 * exactly that code and is gated, and that the declared code list equals the
 * current release's `added` list. Nothing in the vocabulary may sit outside the
 * scope unless it is source-derived, and out-of-scope text is returned in
 * `unmapped` in the person's own words rather than coerced.
 *
 * Expanding it is expected. Any change to codes, names, systems, or aliases is a
 * version bump with an entry in `CONDITION_VOCABULARY_CHANGELOG` — and the
 * version, the changelog, and the vocabulary are locked together by test, so a
 * condition cannot be added without recording the release. Counsel sign-off
 * under docs/medical-lead-capture-phase2.md §7 still governs any live use.
 */

/** Vocabulary identity — stored on every mapped record for reproducibility. */
export const CONDITION_VOCABULARY_ID = 'lifechat-condition-v1';

/** Bump on any change to codes, names, systems, or aliases. */
export const CONDITION_VOCABULARY_VERSION = '1.9.0';

/** One released revision of the vocabulary. */
export interface ConditionVocabularyRevision {
  /** Semantic version. Minor = additive/alias changes; major = a code, name,
   * or body-system change that would re-map an already-stored condition. */
  version: string;
  /** Release date, YYYY-MM-DD. */
  date: string;
  /** What changed, in one sentence. */
  summary: string;
  /** Total canonical conditions after this release — the count the vocabulary
   * had when this version was published. */
  condition_count: number;
  /** ICD-10-CM codes added by this release. */
  added: string[];
  /**
   * Aliases re-pointed from one code to another. Recorded because a stored
   * record mapped under the older version resolved the same stated text to the
   * older code — this is the list that makes such a record explainable.
   */
  aliases_moved: { alias: string; from: string; to: string }[];
}

/**
 * Release history, newest first. Append-only: a released entry is never edited
 * or removed, because stored records cite the version they were mapped under.
 *
 * The test suite enforces the link in both directions — every code named here
 * must exist in the vocabulary, every moved alias must actually resolve to its
 * new code and not the old one, and the newest entry's `condition_count` must
 * equal the live vocabulary's length, chained back through the history. Adding
 * or removing a condition without a matching entry fails the build.
 */
export const CONDITION_VOCABULARY_CHANGELOG: ConditionVocabularyRevision[] = [
  {
    version: '1.9.0',
    date: '2026-09-19',
    summary:
      'Closed the ICD-10 Chapter XIV sweep, the second codebook enumeration and the first chapter the stone family itself sits in: the three-character category titles of N00–N99 (diseases of the genitourinary system, 87 candidates) surfaced 41 silent rows. Thirty named diagnoses became canonical conditions in six batches of five — the nephritic syndromes and isolated proteinuria, tubulo-interstitial nephritis and kidney failure, obstructive uropathy and calculi, cystitis and neurogenic bladder, urethritis and the male genital infections, then the breast, female pelvic and reproductive rows — each title verified against ICD-10-CM before use. Three rows are deliberately gated rather than coded, each for a codebook reason this release records: urethral stricture (FY2026 split N35.9 into sex-specific billable codes, so a code would have to guess the visitor’s sex), neuromuscular dysfunction of bladder, not elsewhere classified (the N31 header; the stateable form is neurogenic bladder, N31.9, which is carried), and the remaining “other …” category constructs. One alias moved: “kidney failure” now resolves to unspecified kidney failure (N19) rather than end stage renal disease (N18.6) — ESRD keeps dialysis and its own name, so a plain “kidney failure” no longer lands on the end-stage row.',
    condition_count: 303,
    added: [
      // Chapter XIV sweep, batch 1 — nephritic syndromes and isolated proteinuria
      'N00.9',
      'N01.9',
      'N02.9',
      'N03.9',
      'N06.9',
      // Chapter XIV sweep, batch 2 — tubulo-interstitial nephritis and kidney failure
      'N10',
      'N11.9',
      'N12',
      'N17.9',
      'N19',
      // Chapter XIV sweep, batch 3 — obstructive uropathy, calculi and the bladder
      'N13.9',
      'N21.9',
      'N23',
      'N30.90',
      'N31.9',
      // Chapter XIV sweep, batch 4 — urethra and the male genital organs
      'N34.1',
      'N43.3',
      'N43.40',
      'N45.1',
      'N45.2',
      // Chapter XIV sweep, batch 5 — breast and female pelvic organs
      'N60.99',
      'N62',
      'N63.0',
      'N70.91',
      'N70.92',
      // Chapter XIV sweep, batch 6 — female genital tract, cervix, reproductive loss
      'N75.9',
      'N81.9',
      'N86',
      'N87.9',
      'N96',
    ],
    aliases_moved: [{ alias: 'kidney failure', from: 'N18.6', to: 'N19' }],
  },
  {
    version: '1.8.0',
    date: '2026-09-19',
    summary:
      'Closed the stone-family residue the syntactic-collision sweep left behind. The stones context rule (1.7.0 work, no code) made "bladder stones" and "ureteral stones" health data, but the crosswalk carried neither, so a consented mapping returned them in unmapped — gated, not mapped. Both are rows now: calculus in bladder (N21.0) and calculus of ureter (N20.1). The same sweep measured the two-word spelling "gall stone", which the 1.4.0 questionnaire corpus had carried only as the one-word "gallstones"; it joined the K80.20 aliases (with "gall stones" derived as its plural). Mapping-only release: the gate already classified every phrase, so nothing moved between buckets and no alias was re-pointed.',
    condition_count: 273,
    added: [
      // Stone-family closure — the gated-but-uncoded rows the collision sweep measured
      'N20.1',
      'N21.0',
    ],
    aliases_moved: [],
  },
  {
    version: '1.7.0',
    date: '2026-09-19',
    summary:
      'Closed the ICD-10 Chapter IX sweep, the third independent source and the first codebook enumeration: the three-character category titles of the WHO tabular list (77 candidates) surfaced 16 rows that were neither gated nor mapped. Six became canonical conditions in two batches — nontraumatic subarachnoid, intracerebral and intracranial haemorrhage, phlebitis and thrombophlebitis, nonspecific lymphadenitis, and atrioventricular block — and three aliases landed on existing rows: cerebral infarction on I63.9 and the British spelling haemorrhoids on K64.9 (the vocabulary carried only the American spellings, which is how a British visitor stating the condition reached the model ungated). The remaining category rows are codebook constructs, not diagnoses the person states ("other diseases of pericardium", "other disorders of veins"), and are gated descriptively instead.',
    condition_count: 271,
    added: [
      // ICD-10 Chapter IX sweep, batch 1 — haemorrhagic stroke and spellings
      'I60.9',
      'I61.9',
      'I62.9',
      // ICD-10 Chapter IX sweep, batch 2 — venous, lymphatic, conduction
      'I80.9',
      'I88.9',
      'I44.30',
    ],
    aliases_moved: [],
  },
  {
    version: '1.6.0',
    date: '2026-09-19',
    summary:
      'Closed the critical-illness sweep, the second independent source: the carrier covered-condition lists (10/30/36-condition enumerations) surfaced 18 silent rows. Ten became canonical conditions in two batches of five; the rest were event, procedure, injury and functional rows (coma excepted) that the gate now protects without inventing a code. Three aliases were added to existing rows: primary pulmonary hypertension and primary pulmonary arterial hypertension on I27.20, and loss of hearing on H91.90 (the row already carried hearing loss and deafness — the carrier list simply spells the same condition differently).',
    condition_count: 265,
    added: [
      // Critical-illness sweep, batch 1 — CNS infection, movement, coma
      'A86',
      'A80.9',
      'G00.9',
      'G12.29',
      'R40.20',
      // Critical-illness sweep, batch 2 — paralysis, hepatic failure, blood, tumour
      'G82.20',
      'K72.90',
      'K76.9',
      'D61.9',
      'D33.2',
    ],
    aliases_moved: [],
  },
  {
    version: '1.5.0',
    date: '2026-09-19',
    summary:
      'Alias release: "piles", the lay synonym for hemorrhoids, now resolves to K64.9 — closing the questionnaire-sweep row that 1.4.0 deferred. The gate (src/security/security-controls.ts) classifies it only in context, because its ordinary sense is a quantifier ("piles of paperwork", "the work piles up"); no codes added, so the condition count is unchanged.',
    condition_count: 255,
    added: [],
    aliases_moved: [],
  },
  {
    version: '1.4.0',
    date: '2026-09-19',
    summary:
      'Closed the third measured gap: a 237-phrase carrier-questionnaire sweep found 55 rows that were neither gated nor mapped. 30 became canonical conditions here, 2 became aliases on existing rows (irregular heartbeat → I49.9, drug addiction/drug abuse → F19.20), 22 became documented descriptive gate terms (procedure states, acute infections, symptoms), and 1 ("piles") is deferred because its ordinary sense collides with the lay synonym.',
    condition_count: 255,
    added: [
      // Probe gap, batch 1 — cardiac muscle, pericardium, rhythm, lipid
      'I42.9',
      'I40.9',
      'I30.9',
      'I47.9',
      'E78.1',
      // Probe gap, batch 2 — electrolyte, androgen, parathyroid
      'E87.1',
      'E83.52',
      'E79.0',
      'E29.1',
      'E20.9',
      // Probe gap, batch 3 — renal, airway, pleural, gastric
      'N05.9',
      'J33.9',
      'R09.1',
      'J93.9',
      'K31.84',
      // Probe gap, batch 4 — headache, movement, cerebrospinal, retinal
      'G44.209',
      'F95.2',
      'G91.9',
      'G71.0',
      'H33.20',
      // Probe gap, batch 5 — congenital and hematologic
      'Q35.9',
      'Q66.89',
      'Q96.9',
      'Q99.2',
      'D45',
      // Probe gap, batch 6 — dermatologic, lymphatic, urologic, viral
      'L70.0',
      'L91.0',
      'I89.0',
      'I86.1',
      'B00.9',
    ],
    aliases_moved: [],
  },
  {
    version: '1.3.0',
    date: '2026-09-18',
    summary:
      'Closed the residual gap the boundary probe exposed: carrier-relevant chronic rows that were neither gated nor mapped, declared in RESIDUAL_SCOPE and enforced by the same two-way ledger.',
    condition_count: 225,
    added: [
      // Residual gap, batch 1 — venous, spinal, electrolyte, hematologic
      'I83.90',
      'M54.30',
      'E87.5',
      'D51.9',
      'E83.110',
      // Residual gap, batch 2 — inherited connective-tissue and neurologic
      'D55.0',
      'Q79.60',
      'Q87.40',
      'G51.0',
      'G44.009',
      // Residual gap, batch 3 — shoulder, foot, obstetric, ophthalmic
      'M75.00',
      'M21.40',
      'M20.10',
      'O14.90',
      'H04.129',
      // Residual gap, batch 4 — skin, menopausal state, minor surgical
      'N95.1',
      'L43.9',
      'D18.00',
      'B07.0',
      'H00.1',
      // Residual gap, batch 5 — vascular spasm, thyroid, tremor, breast, anal
      'I73.00',
      'E04.9',
      'G25.0',
      'N60.29',
      'K60.2',
      // Residual gap, batch 6 — pre-malignant, hernia, bladder pain, skin, prolapse
      'K22.70',
      'K40.90',
      'N30.10',
      'L57.0',
      'N81.4',
      // Residual gap, batch 7 — menstrual, intolerance, renal, dermatologic
      'N94.6',
      'N94.3',
      'E73.9',
      'N28.1',
      'L21.9',
      // Residual gap, batch 8 — minor soft-tissue and dermatologic
      'M67.40',
      'M77.10',
      'M65.30',
      'M71.9',
      'L23.9',
      'K60.3',
    ],
    aliases_moved: [],
  },
  {
    version: '1.2.0',
    date: '2026-09-18',
    summary:
      'Closed the common-chronic domains outside the PTSD source scope: gynecologic, urologic, dermatologic, ophthalmologic, ENT/oral, congenital/developmental, and the residual musculoskeletal, gastrointestinal, hematologic, infectious, oncologic, endocrine, respiratory, and mental-health rows a carrier medical questionnaire enumerates.',
    condition_count: 184,
    added: [
      // Gynecologic / reproductive
      'N80.9',
      'D25.9',
      'E28.2',
      'N83.20',
      'N97.9',
      // Urologic
      'N40.1',
      'R32',
      'N32.81',
      'N52.9',
      'N46.9',
      // Dermatologic
      'L20.9',
      'L50.9',
      'L80',
      'L71.9',
      'L63.9',
      // Ophthalmologic / otologic
      'H25.9',
      'H40.9',
      'H35.31',
      'E11.319',
      'H91.90',
      // ENT / oral
      'H93.19',
      'J32.9',
      'H81.10',
      'K05.30',
      // Congenital / developmental
      'Q90.9',
      'G80.9',
      'Q24.9',
      'E84.9',
      'Q05.9',
      // Neurological / immune, other
      'F84.0',
      'G70.00',
      'D86.9',
      'G56.00',
      'Q61.3',
      // Musculoskeletal, other
      'M41.9',
      'M51.9',
      'M48.00',
      'M75.100',
      'M72.2',
      // Gastrointestinal, other
      'K57.32',
      'K80.20',
      'K44.9',
      'K64.9',
      'K29.50',
      // Hematologic, other
      'D57.1',
      'D56.9',
      'D66',
      'D68.0',
      'D69.6',
      // Infectious, other
      'B02.9',
      'A69.20',
      'M86.9',
      'U09.9',
      // Oncologic, other
      'C16.9',
      'C15.9',
      'C53.9',
      'C62.90',
      'C44.90',
      // Endocrine, other
      'E21.3',
      'E23.0',
      'E24.9',
      'E23.2',
      'E04.1',
      // Respiratory, other
      'J84.10',
      'J47.9',
      'I27.20',
      // Mental health, other
      'F40.10',
      'F40.00',
      'F50.9',
      'F53.0',
    ],
    aliases_moved: [],
  },
  {
    version: '1.1.0',
    date: '2026-09-18',
    summary:
      'Mapped the remaining conditions the health-data gate already watched for, and corrected two alias assignments.',
    condition_count: 114,
    added: [
      // Cardiovascular
      'I46.9',
      'I49.9',
      'I20.9',
      'I71.9',
      'I95.9',
      'I33.0',
      'I26.99',
      'I82.90',
      // Metabolic / endocrine
      'E55.9',
      // Autoimmune / inflammatory
      'M31.30',
      'M34.9',
      'K75.4',
      // Neurodegenerative
      'G31.83',
      // Neurological
      'G45.9',
      'G62.9',
      'S06.0',
      'S06.9',
      'G03.9',
      // Respiratory
      'J20.9',
      'J18.9',
      // Sleep
      'G25.81',
      // Renal
      'N04.9',
      'N20.0',
      // Musculoskeletal
      'M85.80',
      'M25.50',
      // Gastrointestinal
      'K74.60',
      'K76.0',
      'K85.90',
      // Mental health
      'F20.9',
      'F90.9',
      'F42.9',
      // Oncologic
      'C85.90',
      'C90.00',
      'C56.9',
      'C25.9',
      'C22.0',
      'C67.9',
      'C64.9',
      'C73',
      'C71.9',
      'C54.1',
      // Hematologic
      'D50.9',
      // Infectious
      'A15.0',
      'A41.9',
      'B16.9',
    ],
    aliases_moved: [
      // Was mapped to M81.0 (age-related osteoporosis). Osteopenia is a lower
      // bone-density state that is not the same diagnosis, so it now resolves
      // to its own code.
      { alias: 'osteopenia', from: 'M81.0', to: 'M85.80' },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-08-30',
    summary:
      'Initial vocabulary covering the domains the approved medical topics and the reviewed PTSD phenome literature exercise.',
    condition_count: 69,
    added: [],
    aliases_moved: [],
  },
];

/** Classification of any canonical ref that leaves this module. */
export const CONDITION_DATA_CLASSIFICATION = 'tdpsa_sensitive_health';

/**
 * Body-system / domain grouping. Used to roll a profile up the way the
 * phenome literature does (circulatory, endocrine, neurological, ...) without
 * carrying any clinical interpretation.
 */
export const CONDITION_SYSTEMS = [
  'cardiovascular',
  'metabolic',
  'autoimmune_inflammatory',
  'neurodegenerative',
  'neurological',
  'respiratory',
  'sleep',
  'renal',
  'musculoskeletal',
  'gastrointestinal',
  'mental_health',
  'oncologic',
  'hematologic',
  'infectious',
  'gynecologic',
  'urologic',
  'dermatologic',
  'ophthalmologic',
  'ent',
  'congenital',
] as const;

export type ConditionSystem = (typeof CONDITION_SYSTEMS)[number];

/** A vocabulary entry. */
export interface CanonicalCondition {
  /** ICD-10-CM code (primary/unspecified code where the user gave no detail). */
  icd10_cm: string;
  /** Canonical display name used in the internal operational record. */
  name: string;
  /** Body system / domain for rollups. */
  system: ConditionSystem;
  /** Curated alternate wordings and abbreviations (matched exactly). */
  synonyms: string[];
}

/** A canonical ref as stored on a lead record (vocabulary-tagged). */
export interface CanonicalConditionRef {
  icd10_cm: string;
  name: string;
  system: ConditionSystem;
  /** Vocabulary id the ref was resolved against. */
  vocabulary: string;
  /** Vocabulary version at resolution time. */
  vocabulary_version: string;
}

/** Result of mapping one profile's stated conditions. */
export interface ConditionMappingResult {
  vocabulary: string;
  vocabulary_version: string;
  /** Deduplicated canonical refs, in first-stated order. */
  canonical: CanonicalConditionRef[];
  /**
   * Stated conditions that matched no alias. Kept verbatim — never guessed —
   * and surfaced so the gap can be closed in the vocabulary or reviewed by the
   * broker.
   */
  unmapped: string[];
}

/** Per-system rollup entry for internal grouping/query. */
export interface ConditionSystemGroup {
  system: ConditionSystem;
  count: number;
  icd10_cm: string[];
}

/**
 * The vocabulary. Codes are ICD-10-CM; each condition uses the unspecified or
 * most general code that still identifies the condition, because the user is
 * reporting a diagnosis, not a clinical encounter.
 */
export const CANONICAL_CONDITIONS: CanonicalCondition[] = [
  // ── Cardiovascular ──
  {
    icd10_cm: 'I10',
    name: 'Essential (primary) hypertension',
    system: 'cardiovascular',
    synonyms: ['hypertension', 'high blood pressure', 'htn', 'high bp'],
  },
  {
    icd10_cm: 'I25.10',
    name: 'Atherosclerotic heart disease of native coronary artery',
    system: 'cardiovascular',
    synonyms: [
      'coronary artery disease',
      'cad',
      'coronary heart disease',
      'chd',
      'ischemic heart disease',
      'atherosclerosis',
    ],
  },
  {
    icd10_cm: 'I21.9',
    name: 'Acute myocardial infarction, unspecified',
    system: 'cardiovascular',
    synonyms: ['myocardial infarction', 'heart attack', 'mi'],
  },
  {
    icd10_cm: 'I50.9',
    name: 'Heart failure, unspecified',
    system: 'cardiovascular',
    synonyms: ['heart failure', 'congestive heart failure', 'chf'],
  },
  {
    icd10_cm: 'I48.91',
    name: 'Unspecified atrial fibrillation',
    system: 'cardiovascular',
    synonyms: ['atrial fibrillation', 'afib', 'a-fib'],
  },
  {
    icd10_cm: 'I63.9',
    name: 'Cerebral infarction, unspecified',
    system: 'cardiovascular',
    synonyms: [
      'stroke',
      'cerebrovascular accident',
      'cva',
      'ischemic stroke',
      'cerebral infarction',
    ],
  },
  {
    icd10_cm: 'I73.9',
    name: 'Peripheral vascular disease, unspecified',
    system: 'cardiovascular',
    synonyms: ['peripheral vascular disease', 'peripheral artery disease', 'pvd', 'pad'],
  },
  {
    icd10_cm: 'I46.9',
    name: 'Cardiac arrest, cause unspecified',
    system: 'cardiovascular',
    synonyms: ['cardiac arrest', 'sudden cardiac death', 'sudden cardiac arrest'],
  },
  {
    icd10_cm: 'I49.9',
    name: 'Cardiac arrhythmia, unspecified',
    system: 'cardiovascular',
    synonyms: [
      'cardiac arrhythmia',
      'arrhythmia',
      'ventricular arrhythmia',
      'irregular heartbeat',
      'irregular heart beat',
    ],
  },
  {
    icd10_cm: 'I20.9',
    name: 'Angina pectoris, unspecified',
    system: 'cardiovascular',
    synonyms: ['angina', 'angina pectoris', 'stable angina'],
  },
  {
    icd10_cm: 'I71.9',
    name: 'Aortic aneurysm of unspecified site, without rupture',
    system: 'cardiovascular',
    synonyms: ['aortic aneurysm', 'aneurysm', 'abdominal aortic aneurysm'],
  },
  {
    icd10_cm: 'I95.9',
    name: 'Hypotension, unspecified',
    system: 'cardiovascular',
    synonyms: ['hypotension', 'low blood pressure', 'orthostatic hypotension'],
  },
  {
    icd10_cm: 'I33.0',
    name: 'Acute and subacute infective endocarditis',
    system: 'cardiovascular',
    synonyms: ['infective endocarditis', 'endocarditis'],
  },
  {
    icd10_cm: 'I26.99',
    name: 'Other pulmonary embolism without acute cor pulmonale',
    system: 'cardiovascular',
    synonyms: ['pulmonary embolism', 'pulmonary embolus'],
  },
  {
    icd10_cm: 'I82.90',
    name: 'Acute embolism and thrombosis of unspecified deep veins of lower extremity',
    system: 'cardiovascular',
    synonyms: ['deep vein thrombosis', 'venous thromboembolism', 'dvt', 'vte'],
  },

  // ── Metabolic / endocrine ──
  {
    icd10_cm: 'E11.9',
    name: 'Type 2 diabetes mellitus without complications',
    system: 'metabolic',
    synonyms: [
      'type 2 diabetes',
      'type 2 diabetes mellitus',
      't2dm',
      'dm2',
      'adult onset diabetes',
      'diabetes',
      'diabetes mellitus',
    ],
  },
  {
    icd10_cm: 'E10.9',
    name: 'Type 1 diabetes mellitus without complications',
    system: 'metabolic',
    synonyms: [
      'type 1 diabetes',
      'type 1 diabetes mellitus',
      't1dm',
      'dm1',
      'juvenile diabetes',
      'insulin dependent diabetes',
    ],
  },
  {
    icd10_cm: 'R73.03',
    name: 'Prediabetes',
    system: 'metabolic',
    synonyms: ['prediabetes', 'pre-diabetes', 'borderline diabetes', 'impaired glucose tolerance'],
  },
  {
    icd10_cm: 'E88.81',
    name: 'Metabolic syndrome',
    system: 'metabolic',
    synonyms: ['metabolic syndrome', 'syndrome x', 'insulin resistance syndrome'],
  },
  {
    icd10_cm: 'E66.9',
    name: 'Obesity, unspecified',
    system: 'metabolic',
    synonyms: ['obesity', 'obese', 'morbid obesity', 'severe obesity'],
  },
  {
    icd10_cm: 'E78.5',
    name: 'Hyperlipidemia, unspecified',
    system: 'metabolic',
    synonyms: [
      'hyperlipidemia',
      'high cholesterol',
      'high lipids',
      'dyslipidemia',
      'hypercholesterolemia',
    ],
  },
  {
    icd10_cm: 'E03.9',
    name: 'Hypothyroidism, unspecified',
    system: 'metabolic',
    synonyms: ['hypothyroidism', 'underactive thyroid', 'low thyroid'],
  },
  {
    icd10_cm: 'E05.90',
    name: 'Thyrotoxicosis, unspecified, without thyrotoxic crisis',
    system: 'metabolic',
    synonyms: ['hyperthyroidism', 'overactive thyroid', 'graves disease', 'thyrotoxicosis'],
  },
  {
    icd10_cm: 'M10.9',
    name: 'Gout, unspecified',
    system: 'metabolic',
    synonyms: ['gout', 'gouty arthritis'],
  },
  {
    icd10_cm: 'E27.40',
    name: 'Unspecified adrenocortical insufficiency',
    system: 'metabolic',
    synonyms: ['adrenal insufficiency', 'addison disease', 'addisonian crisis'],
  },
  {
    icd10_cm: 'E55.9',
    name: 'Vitamin D deficiency, unspecified',
    system: 'metabolic',
    synonyms: ['vitamin d deficiency', 'low vitamin d'],
  },

  // ── Autoimmune / inflammatory ──
  {
    icd10_cm: 'M06.9',
    name: 'Rheumatoid arthritis, unspecified',
    system: 'autoimmune_inflammatory',
    synonyms: ['rheumatoid arthritis', 'ra'],
  },
  {
    icd10_cm: 'M32.9',
    name: 'Systemic lupus erythematosus, unspecified',
    system: 'autoimmune_inflammatory',
    synonyms: ['systemic lupus erythematosus', 'lupus', 'sle'],
  },
  {
    icd10_cm: 'G35',
    name: 'Multiple sclerosis',
    system: 'autoimmune_inflammatory',
    synonyms: ['multiple sclerosis', 'ms'],
  },
  {
    icd10_cm: 'K50.90',
    name: "Crohn's disease, unspecified, without complications",
    system: 'autoimmune_inflammatory',
    synonyms: ['crohn disease', 'crohns disease', 'crohns', 'regional enteritis'],
  },
  {
    icd10_cm: 'K51.90',
    name: 'Ulcerative colitis, unspecified, without complications',
    system: 'autoimmune_inflammatory',
    synonyms: ['ulcerative colitis', 'uc', 'inflammatory bowel disease', 'ibd'],
  },
  {
    icd10_cm: 'L40.9',
    name: 'Psoriasis, unspecified',
    system: 'autoimmune_inflammatory',
    synonyms: ['psoriasis'],
  },
  {
    icd10_cm: 'L40.50',
    name: 'Arthropathic psoriasis, unspecified',
    system: 'autoimmune_inflammatory',
    synonyms: ['psoriatic arthritis'],
  },
  {
    icd10_cm: 'M45.9',
    name: 'Ankylosing spondylitis of unspecified sites in spine',
    system: 'autoimmune_inflammatory',
    synonyms: ['ankylosing spondylitis', 'axial spondyloarthritis'],
  },
  {
    icd10_cm: 'M35.00',
    name: 'Sjögren syndrome, unspecified',
    system: 'autoimmune_inflammatory',
    synonyms: ['sjogren syndrome', 'sjogrens syndrome', 'sjogrens'],
  },
  {
    icd10_cm: 'K90.0',
    name: 'Celiac disease',
    system: 'autoimmune_inflammatory',
    synonyms: ['celiac disease', 'coeliac disease', 'gluten intolerance'],
  },
  {
    icd10_cm: 'E06.3',
    name: 'Autoimmune thyroiditis',
    system: 'autoimmune_inflammatory',
    synonyms: [
      'hashimoto thyroiditis',
      'hashimotos thyroiditis',
      'hashimotos',
      'autoimmune thyroiditis',
      'thyroiditis',
    ],
  },
  {
    icd10_cm: 'M31.30',
    name: 'Unspecified vasculitis',
    system: 'autoimmune_inflammatory',
    synonyms: ['vasculitis'],
  },
  {
    icd10_cm: 'M34.9',
    name: 'Systemic sclerosis, unspecified',
    system: 'autoimmune_inflammatory',
    synonyms: ['systemic sclerosis', 'scleroderma'],
  },
  {
    icd10_cm: 'K75.4',
    name: 'Autoimmune hepatitis',
    system: 'autoimmune_inflammatory',
    synonyms: ['autoimmune hepatitis'],
  },

  // ── Neurodegenerative ──
  {
    icd10_cm: 'G30.9',
    name: "Alzheimer's disease, unspecified",
    system: 'neurodegenerative',
    synonyms: ['alzheimer disease', 'alzheimers disease', 'alzheimers', 'early onset alzheimers'],
  },
  {
    icd10_cm: 'F03.90',
    name: 'Unspecified dementia without behavioral disturbance',
    system: 'neurodegenerative',
    synonyms: ['dementia', 'senile dementia', 'vascular dementia', 'cognitive decline'],
  },
  {
    icd10_cm: 'G20',
    name: "Parkinson's disease",
    system: 'neurodegenerative',
    synonyms: ['parkinson disease', 'parkinsons disease', 'parkinsons'],
  },
  {
    icd10_cm: 'G12.21',
    name: 'Amyotrophic lateral sclerosis',
    system: 'neurodegenerative',
    synonyms: ['amyotrophic lateral sclerosis', 'als', 'lou gehrig disease'],
  },
  {
    icd10_cm: 'G31.84',
    name: 'Mild cognitive impairment, so stated',
    system: 'neurodegenerative',
    synonyms: ['mild cognitive impairment', 'mci'],
  },
  {
    icd10_cm: 'G31.83',
    name: 'Dementia with Lewy bodies',
    system: 'neurodegenerative',
    synonyms: ['lewy body dementia', 'dementia with lewy bodies'],
  },

  // ── Neurological ──
  {
    icd10_cm: 'G43.909',
    name: 'Migraine, unspecified, not intractable, without status migrainosus',
    system: 'neurological',
    synonyms: ['migraine', 'migraine headaches', 'migraines'],
  },
  {
    icd10_cm: 'G40.909',
    name: 'Epilepsy, unspecified, not intractable, without status epilepticus',
    system: 'neurological',
    synonyms: ['epilepsy', 'seizure disorder', 'seizures'],
  },
  {
    icd10_cm: 'G93.32',
    name: 'Myalgic encephalomyelitis/chronic fatigue syndrome',
    system: 'neurological',
    synonyms: ['chronic fatigue syndrome', 'cfs', 'myalgic encephalomyelitis', 'me/cfs', 'mecfs'],
  },
  {
    icd10_cm: 'G89.29',
    name: 'Other chronic pain',
    system: 'neurological',
    synonyms: ['chronic pain', 'chronic pain syndrome', 'neuropathic pain'],
  },
  {
    icd10_cm: 'G45.9',
    name: 'Transient cerebral ischemic attack, unspecified',
    system: 'neurological',
    synonyms: ['transient ischemic attack', 'transient ischaemic attack', 'tia'],
  },
  {
    icd10_cm: 'G62.9',
    name: 'Polyneuropathy, unspecified',
    system: 'neurological',
    synonyms: ['neuropathy', 'peripheral neuropathy', 'polyneuropathy'],
  },
  {
    icd10_cm: 'S06.0',
    name: 'Concussion',
    system: 'neurological',
    synonyms: ['concussion', 'mild traumatic brain injury', 'mtbi'],
  },
  {
    icd10_cm: 'S06.9',
    name: 'Unspecified intracranial injury',
    system: 'neurological',
    synonyms: ['traumatic brain injury', 'tbi', 'head injury'],
  },
  {
    icd10_cm: 'G03.9',
    name: 'Meningitis, unspecified',
    system: 'neurological',
    synonyms: ['meningitis'],
  },

  // ── Respiratory ──
  {
    icd10_cm: 'J45.909',
    name: 'Unspecified asthma, uncomplicated',
    system: 'respiratory',
    synonyms: ['asthma', 'reactive airway disease'],
  },
  {
    icd10_cm: 'J44.9',
    name: 'Chronic obstructive pulmonary disease, unspecified',
    system: 'respiratory',
    synonyms: ['chronic obstructive pulmonary disease', 'copd', 'emphysema', 'chronic bronchitis'],
  },
  {
    icd10_cm: 'J30.9',
    name: 'Allergic rhinitis, unspecified',
    system: 'respiratory',
    synonyms: ['allergic rhinitis', 'hay fever', 'seasonal allergies', 'allergies'],
  },
  {
    icd10_cm: 'J20.9',
    name: 'Acute bronchitis, unspecified',
    system: 'respiratory',
    synonyms: ['acute bronchitis', 'bronchitis'],
  },
  {
    icd10_cm: 'J18.9',
    name: 'Pneumonia, unspecified organism',
    system: 'respiratory',
    synonyms: ['pneumonia'],
  },

  // ── Sleep ──
  {
    icd10_cm: 'G47.00',
    name: 'Insomnia, unspecified',
    system: 'sleep',
    synonyms: ['insomnia', 'sleep problems', 'sleep disturbance', 'chronic insomnia'],
  },
  {
    icd10_cm: 'G47.33',
    name: 'Obstructive sleep apnea (adult) (pediatric)',
    system: 'sleep',
    synonyms: [
      'obstructive sleep apnea',
      'sleep apnea',
      'sleep apnoea',
      'osa',
      'apnea',
      'apnoea',
      'cpap use',
      'cpap',
    ],
  },
  {
    icd10_cm: 'G47.419',
    name: 'Narcolepsy without cataplexy',
    system: 'sleep',
    synonyms: ['narcolepsy'],
  },
  {
    icd10_cm: 'G25.81',
    name: 'Restless legs syndrome',
    system: 'sleep',
    synonyms: ['restless legs syndrome', 'restless legs'],
  },

  // ── Renal / genitourinary ──
  {
    icd10_cm: 'N18.9',
    name: 'Chronic kidney disease, unspecified',
    system: 'renal',
    synonyms: ['chronic kidney disease', 'ckd', 'kidney disease', 'renal insufficiency'],
  },
  {
    icd10_cm: 'N18.6',
    name: 'End stage renal disease',
    system: 'renal',
    // "kidney failure" moved to N19 in 1.9.0 — an unqualified statement is the
    // unspecified row, not the end-stage one.
    synonyms: ['end stage renal disease', 'esrd', 'dialysis', 'on dialysis'],
  },
  {
    icd10_cm: 'N04.9',
    name: 'Nephrotic syndrome with unspecified morphologic changes',
    system: 'renal',
    synonyms: ['nephrotic syndrome'],
  },
  {
    icd10_cm: 'N20.0',
    name: 'Calculus of kidney',
    system: 'renal',
    synonyms: ['kidney stones', 'kidney stone', 'nephrolithiasis'],
  },
  {
    icd10_cm: 'N20.1',
    name: 'Calculus of ureter',
    system: 'renal',
    // Both adjective spellings are gated (the stones entry declares ureter,
    // ureteral and ureteric as qualifiers) and both are common in British and
    // American usage; exact matching means neither would cover the other.
    synonyms: ['ureteral stones', 'ureteric stones', 'ureter stones'],
  },
  {
    icd10_cm: 'N21.0',
    name: 'Calculus in bladder',
    system: 'urologic',
    synonyms: ['bladder stones', 'bladder stone'],
  },

  // ── Musculoskeletal ──
  {
    icd10_cm: 'M79.7',
    name: 'Fibromyalgia',
    system: 'musculoskeletal',
    synonyms: ['fibromyalgia', 'fibromyalgia syndrome', 'fms'],
  },
  {
    icd10_cm: 'M19.90',
    name: 'Unspecified osteoarthritis, unspecified site',
    system: 'musculoskeletal',
    synonyms: ['osteoarthritis', 'degenerative joint disease', 'oa'],
  },
  {
    icd10_cm: 'M81.0',
    name: 'Age-related osteoporosis without current pathological fracture',
    system: 'musculoskeletal',
    synonyms: ['osteoporosis', 'bone loss'],
  },
  {
    icd10_cm: 'M85.80',
    name: 'Other specified disorders of bone density and structure, unspecified site',
    system: 'musculoskeletal',
    synonyms: ['osteopenia', 'low bone density'],
  },
  {
    icd10_cm: 'M26.60',
    name: 'Temporomandibular joint disorder, unspecified',
    system: 'musculoskeletal',
    synonyms: ['temporomandibular joint disorder', 'tmd', 'tmj', 'tmj disorder'],
  },
  {
    icd10_cm: 'M54.5',
    name: 'Low back pain',
    system: 'musculoskeletal',
    synonyms: ['low back pain', 'chronic low back pain', 'back pain'],
  },
  {
    icd10_cm: 'M25.50',
    name: 'Pain in unspecified joint',
    system: 'musculoskeletal',
    synonyms: ['arthralgia', 'joint pain'],
  },

  // ── Gastrointestinal ──
  {
    icd10_cm: 'K58.9',
    name: 'Irritable bowel syndrome without diarrhea',
    system: 'gastrointestinal',
    synonyms: ['irritable bowel syndrome', 'ibs', 'spastic colon'],
  },
  {
    icd10_cm: 'K21.9',
    name: 'Gastro-esophageal reflux disease without esophagitis',
    system: 'gastrointestinal',
    synonyms: ['gastroesophageal reflux disease', 'gerd', 'acid reflux', 'heartburn'],
  },
  {
    icd10_cm: 'K27.9',
    name: 'Peptic ulcer, site unspecified, unspecified as acute or chronic',
    system: 'gastrointestinal',
    synonyms: ['peptic ulcer', 'stomach ulcer', 'ulcer disease'],
  },
  {
    icd10_cm: 'K74.60',
    name: 'Unspecified cirrhosis of liver',
    system: 'gastrointestinal',
    synonyms: ['cirrhosis', 'liver cirrhosis'],
  },
  {
    icd10_cm: 'K76.0',
    name: 'Fatty (change of) liver, not elsewhere classified',
    system: 'gastrointestinal',
    synonyms: ['fatty liver', 'nonalcoholic fatty liver disease', 'nafld', 'hepatic steatosis'],
  },
  {
    icd10_cm: 'K85.90',
    name: 'Acute pancreatitis, unspecified',
    system: 'gastrointestinal',
    synonyms: ['pancreatitis', 'acute pancreatitis'],
  },

  // ── Mental health ──
  {
    icd10_cm: 'F43.10',
    name: 'Post-traumatic stress disorder, unspecified',
    system: 'mental_health',
    synonyms: [
      'post traumatic stress disorder',
      'posttraumatic stress disorder',
      'ptsd',
      'complex ptsd',
      'cptsd',
    ],
  },
  {
    icd10_cm: 'F32.9',
    name: 'Major depressive disorder, single episode, unspecified',
    system: 'mental_health',
    synonyms: [
      'major depressive disorder',
      'major depression',
      'depression',
      'mdd',
      'clinical depression',
    ],
  },
  {
    icd10_cm: 'F41.1',
    name: 'Generalized anxiety disorder',
    system: 'mental_health',
    synonyms: ['generalized anxiety disorder', 'gad', 'anxiety', 'anxiety disorder'],
  },
  {
    icd10_cm: 'F41.0',
    name: 'Panic disorder without agoraphobia',
    system: 'mental_health',
    synonyms: ['panic disorder', 'panic attacks', 'panic'],
  },
  {
    icd10_cm: 'F31.9',
    name: 'Bipolar disorder, unspecified',
    system: 'mental_health',
    synonyms: ['bipolar disorder', 'bipolar', 'manic depression'],
  },
  {
    icd10_cm: 'F19.20',
    name: 'Other psychoactive substance dependence, uncomplicated',
    system: 'mental_health',
    synonyms: [
      'substance use disorder',
      'substance abuse',
      'drug addiction',
      'drug abuse',
      'alcohol use disorder',
      'alcoholism',
    ],
  },
  {
    icd10_cm: 'F20.9',
    name: 'Schizophrenia, unspecified',
    system: 'mental_health',
    synonyms: ['schizophrenia'],
  },
  {
    icd10_cm: 'F90.9',
    name: 'Attention-deficit hyperactivity disorder, unspecified type',
    system: 'mental_health',
    synonyms: ['adhd', 'attention deficit hyperactivity disorder', 'attention deficit disorder'],
  },
  {
    icd10_cm: 'F42.9',
    name: 'Obsessive-compulsive disorder, unspecified',
    system: 'mental_health',
    synonyms: ['obsessive compulsive disorder', 'ocd'],
  },

  // ── Oncologic / hematologic ──
  {
    icd10_cm: 'C80.1',
    name: 'Malignant (primary) neoplasm, unspecified',
    system: 'oncologic',
    synonyms: ['cancer', 'cancer history', 'malignancy', 'carcinoma', 'sarcoma'],
  },
  {
    icd10_cm: 'C50.9',
    name: 'Malignant neoplasm of breast, unspecified',
    system: 'oncologic',
    synonyms: ['breast cancer', 'breast carcinoma'],
  },
  {
    icd10_cm: 'C61',
    name: 'Malignant neoplasm of prostate',
    system: 'oncologic',
    synonyms: ['prostate cancer', 'prostate carcinoma'],
  },
  {
    icd10_cm: 'C34.90',
    name: 'Malignant neoplasm of unspecified part of unspecified bronchus or lung',
    system: 'oncologic',
    synonyms: ['lung cancer', 'lung carcinoma'],
  },
  {
    icd10_cm: 'C18.9',
    name: 'Malignant neoplasm of colon, unspecified',
    system: 'oncologic',
    synonyms: ['colon cancer', 'colorectal cancer', 'bowel cancer'],
  },
  {
    icd10_cm: 'C43.9',
    name: 'Malignant melanoma of skin, unspecified',
    system: 'oncologic',
    synonyms: ['melanoma', 'skin cancer'],
  },
  {
    icd10_cm: 'C85.90',
    name: 'Non-Hodgkin lymphoma, unspecified, unspecified site',
    system: 'oncologic',
    synonyms: ['lymphoma', 'non-hodgkin lymphoma'],
  },
  {
    icd10_cm: 'C90.00',
    name: 'Multiple myeloma not having achieved remission',
    system: 'oncologic',
    synonyms: ['multiple myeloma', 'myeloma'],
  },
  {
    icd10_cm: 'C56.9',
    name: 'Malignant neoplasm of unspecified ovary',
    system: 'oncologic',
    synonyms: ['ovarian cancer'],
  },
  {
    icd10_cm: 'C25.9',
    name: 'Malignant neoplasm of pancreas, unspecified',
    system: 'oncologic',
    synonyms: ['pancreatic cancer'],
  },
  {
    icd10_cm: 'C22.0',
    name: 'Malignant neoplasm of liver and intrahepatic bile duct',
    system: 'oncologic',
    synonyms: ['liver cancer', 'hepatocellular carcinoma'],
  },
  {
    icd10_cm: 'C67.9',
    name: 'Malignant neoplasm of bladder, unspecified',
    system: 'oncologic',
    synonyms: ['bladder cancer'],
  },
  {
    icd10_cm: 'C64.9',
    name: 'Malignant neoplasm of unspecified kidney, except renal pelvis',
    system: 'oncologic',
    synonyms: ['kidney cancer', 'renal cancer', 'renal cell carcinoma'],
  },
  {
    icd10_cm: 'C73',
    name: 'Malignant neoplasm of thyroid gland',
    system: 'oncologic',
    synonyms: ['thyroid cancer'],
  },
  {
    icd10_cm: 'C71.9',
    name: 'Malignant neoplasm of brain, unspecified',
    system: 'oncologic',
    synonyms: ['brain cancer', 'brain tumor', 'brain tumour'],
  },
  {
    icd10_cm: 'C54.1',
    name: 'Malignant neoplasm of endometrium',
    system: 'oncologic',
    synonyms: ['endometrial cancer', 'uterine cancer'],
  },
  {
    icd10_cm: 'C95.90',
    name: 'Leukemia, unspecified, not having achieved remission',
    system: 'hematologic',
    synonyms: ['leukemia', 'leukaemia'],
  },
  {
    icd10_cm: 'D64.9',
    name: 'Anemia, unspecified',
    system: 'hematologic',
    synonyms: ['anemia', 'anaemia', 'low blood count'],
  },
  {
    icd10_cm: 'D50.9',
    name: 'Iron deficiency anemia, unspecified',
    system: 'hematologic',
    synonyms: ['iron deficiency anemia', 'iron deficiency anaemia', 'low iron'],
  },

  // ── Infectious ──
  {
    icd10_cm: 'B20',
    name: 'Human immunodeficiency virus (HIV) disease',
    system: 'infectious',
    synonyms: ['hiv', 'hiv positive', 'human immunodeficiency virus'],
  },
  {
    icd10_cm: 'B18.2',
    name: 'Chronic viral hepatitis C',
    system: 'infectious',
    synonyms: ['hepatitis c', 'chronic hepatitis c', 'hep c'],
  },
  {
    icd10_cm: 'A15.0',
    name: 'Tuberculosis of lung',
    system: 'infectious',
    synonyms: ['tuberculosis', 'tb'],
  },
  {
    icd10_cm: 'A41.9',
    name: 'Sepsis, unspecified organism',
    system: 'infectious',
    synonyms: ['sepsis', 'septicemia', 'blood poisoning'],
  },
  {
    icd10_cm: 'B16.9',
    name: 'Chronic viral hepatitis B without delta-agent',
    system: 'infectious',
    synonyms: ['hepatitis b', 'hep b'],
  },

  // ── Gynecologic ──
  {
    icd10_cm: 'N80.9',
    name: 'Endometriosis, unspecified',
    system: 'gynecologic',
    synonyms: ['endometriosis'],
  },
  {
    icd10_cm: 'D25.9',
    name: 'Leiomyoma of uterus, unspecified',
    system: 'gynecologic',
    synonyms: ['uterine fibroids', 'fibroids', 'leiomyoma', 'uterine leiomyoma'],
  },
  {
    icd10_cm: 'E28.2',
    name: 'Polycystic ovarian syndrome',
    system: 'gynecologic',
    synonyms: ['polycystic ovary syndrome', 'polycystic ovarian syndrome', 'pcos'],
  },
  {
    icd10_cm: 'N83.20',
    name: 'Unspecified ovarian cysts',
    system: 'gynecologic',
    synonyms: ['ovarian cyst', 'ovarian cysts'],
  },
  {
    icd10_cm: 'N97.9',
    name: 'Female infertility, unspecified',
    system: 'gynecologic',
    synonyms: ['infertility', 'female infertility', 'unable to conceive'],
  },

  // ── Urologic ──
  {
    icd10_cm: 'N40.1',
    name: 'Benign prostatic hyperplasia with lower urinary tract symptoms',
    system: 'urologic',
    synonyms: ['benign prostatic hyperplasia', 'enlarged prostate', 'bph', 'prostate enlargement'],
  },
  {
    icd10_cm: 'R32',
    name: 'Unspecified urinary incontinence',
    system: 'urologic',
    synonyms: ['urinary incontinence', 'incontinence'],
  },
  {
    icd10_cm: 'N32.81',
    name: 'Overactive bladder',
    system: 'urologic',
    synonyms: ['overactive bladder', 'oab'],
  },
  {
    icd10_cm: 'N52.9',
    name: 'Male erectile dysfunction, unspecified',
    system: 'urologic',
    synonyms: ['erectile dysfunction', 'impotence', 'male erectile dysfunction'],
  },
  {
    icd10_cm: 'N46.9',
    name: 'Male infertility, unspecified',
    system: 'urologic',
    synonyms: ['male infertility', 'low sperm count', 'azoospermia'],
  },

  // ── Dermatologic ──
  {
    icd10_cm: 'L20.9',
    name: 'Atopic dermatitis, unspecified',
    system: 'dermatologic',
    synonyms: ['eczema', 'atopic dermatitis', 'atopic eczema'],
  },
  {
    icd10_cm: 'L50.9',
    name: 'Urticaria, unspecified',
    system: 'dermatologic',
    synonyms: ['chronic urticaria', 'urticaria', 'hives'],
  },
  {
    icd10_cm: 'L80',
    name: 'Vitiligo',
    system: 'dermatologic',
    synonyms: ['vitiligo'],
  },
  {
    icd10_cm: 'L71.9',
    name: 'Rosacea, unspecified',
    system: 'dermatologic',
    synonyms: ['rosacea'],
  },
  {
    icd10_cm: 'L63.9',
    name: 'Alopecia areata, unspecified',
    system: 'dermatologic',
    synonyms: ['alopecia areata', 'alopecia'],
  },

  // ── Ophthalmologic / otologic ──
  {
    icd10_cm: 'H25.9',
    name: 'Unspecified age-related cataract',
    system: 'ophthalmologic',
    synonyms: ['cataract', 'cataracts'],
  },
  {
    icd10_cm: 'H40.9',
    name: 'Unspecified glaucoma',
    system: 'ophthalmologic',
    synonyms: ['glaucoma'],
  },
  {
    icd10_cm: 'H35.31',
    name: 'Nonexudative age-related macular degeneration',
    system: 'ophthalmologic',
    synonyms: ['age-related macular degeneration', 'macular degeneration'],
  },
  {
    icd10_cm: 'E11.319',
    name: 'Type 2 diabetes mellitus with unspecified diabetic retinopathy without macular edema',
    system: 'ophthalmologic',
    synonyms: ['diabetic retinopathy'],
  },
  {
    icd10_cm: 'H91.90',
    name: 'Unspecified hearing loss, unspecified ear',
    system: 'ent',
    synonyms: ['hearing loss', 'deafness', 'loss of hearing'],
  },
  {
    icd10_cm: 'H93.19',
    name: 'Tinnitus, unspecified ear',
    system: 'ent',
    synonyms: ['tinnitus', 'ringing in the ears'],
  },
  {
    icd10_cm: 'J32.9',
    name: 'Chronic sinusitis, unspecified',
    system: 'ent',
    synonyms: ['chronic sinusitis', 'sinusitis'],
  },
  {
    icd10_cm: 'H81.10',
    name: 'Benign paroxysmal positional vertigo, unspecified ear',
    system: 'ent',
    synonyms: ['benign paroxysmal positional vertigo', 'vertigo', 'bppv'],
  },
  {
    icd10_cm: 'K05.30',
    name: 'Chronic periodontitis, unspecified',
    system: 'ent',
    synonyms: ['periodontitis', 'gum disease', 'periodontal disease'],
  },

  // ── Congenital / developmental ──
  {
    icd10_cm: 'Q90.9',
    name: 'Down syndrome, unspecified',
    system: 'congenital',
    synonyms: ['down syndrome', 'trisomy 21'],
  },
  {
    icd10_cm: 'G80.9',
    name: 'Cerebral palsy, unspecified',
    system: 'congenital',
    synonyms: ['cerebral palsy'],
  },
  {
    icd10_cm: 'Q24.9',
    name: 'Congenital malformation of heart, unspecified',
    system: 'congenital',
    synonyms: ['congenital heart disease', 'congenital heart defect', 'congenital heart condition'],
  },
  {
    icd10_cm: 'E84.9',
    name: 'Cystic fibrosis, unspecified',
    system: 'congenital',
    synonyms: ['cystic fibrosis'],
  },
  {
    icd10_cm: 'Q05.9',
    name: 'Spina bifida, unspecified',
    system: 'congenital',
    synonyms: ['spina bifida'],
  },

  // ── Neurological / immune, other ──
  {
    icd10_cm: 'F84.0',
    name: 'Autistic disorder',
    system: 'mental_health',
    synonyms: ['autism', 'autism spectrum disorder', 'autistic disorder'],
  },
  {
    icd10_cm: 'G70.00',
    name: 'Myasthenia gravis without (acute) exacerbation',
    system: 'autoimmune_inflammatory',
    synonyms: ['myasthenia gravis', 'myasthenia'],
  },
  {
    icd10_cm: 'D86.9',
    name: 'Sarcoidosis, unspecified',
    system: 'autoimmune_inflammatory',
    synonyms: ['sarcoidosis'],
  },
  {
    icd10_cm: 'G56.00',
    name: 'Carpal tunnel syndrome, unspecified upper limb',
    system: 'neurological',
    synonyms: ['carpal tunnel syndrome', 'carpal tunnel'],
  },
  {
    icd10_cm: 'Q61.3',
    name: 'Polycystic kidney, unspecified',
    system: 'renal',
    synonyms: ['polycystic kidney disease', 'polycystic kidneys', 'pkd'],
  },

  // ── Musculoskeletal, other ──
  {
    icd10_cm: 'M41.9',
    name: 'Scoliosis, unspecified',
    system: 'musculoskeletal',
    synonyms: ['scoliosis'],
  },
  {
    icd10_cm: 'M51.9',
    name: 'Unspecified thoracic, thoracolumbar and lumbosacral intervertebral disc disorder',
    system: 'musculoskeletal',
    synonyms: [
      'herniated disc',
      'herniated disk',
      'slipped disc',
      'bulging disc',
      'disc herniation',
    ],
  },
  {
    icd10_cm: 'M48.00',
    name: 'Spinal stenosis, site unspecified',
    system: 'musculoskeletal',
    synonyms: ['spinal stenosis', 'stenosis of the spine'],
  },
  {
    icd10_cm: 'M75.100',
    name: 'Unspecified rotator cuff tear or rupture of unspecified shoulder, not traumatic',
    system: 'musculoskeletal',
    synonyms: ['rotator cuff tear', 'rotator cuff injury', 'rotator cuff'],
  },
  {
    icd10_cm: 'M72.2',
    name: 'Plantar fascial fibromatosis',
    system: 'musculoskeletal',
    synonyms: ['plantar fasciitis'],
  },

  // ── Gastrointestinal, other ──
  {
    icd10_cm: 'K57.32',
    name: 'Diverticulitis of large intestine without perforation or abscess without bleeding',
    system: 'gastrointestinal',
    synonyms: ['diverticulitis', 'diverticulosis', 'diverticular disease'],
  },
  {
    icd10_cm: 'K80.20',
    name: 'Calculus of gallbladder without cholecystitis without obstruction',
    system: 'gastrointestinal',
    // "gall stone" is the spaced spelling the collision sweep measured as gated
    // but unmatchable; the alias index derives "gall stones" as its plural.
    synonyms: ['gallstones', 'gall stone', 'gallbladder disease', 'cholelithiasis'],
  },
  {
    icd10_cm: 'K44.9',
    name: 'Diaphragmatic hernia without obstruction or gangrene',
    system: 'gastrointestinal',
    synonyms: ['hiatal hernia', 'diaphragmatic hernia'],
  },
  {
    icd10_cm: 'K64.9',
    name: 'Unspecified hemorrhoids',
    system: 'gastrointestinal',
    synonyms: ['hemorrhoids', 'hemorrhoid', 'haemorrhoids', 'haemorrhoid', 'piles'],
  },
  {
    icd10_cm: 'K29.50',
    name: 'Unspecified chronic gastritis without bleeding',
    system: 'gastrointestinal',
    synonyms: ['chronic gastritis', 'gastritis'],
  },

  // ── Hematologic, other ──
  {
    icd10_cm: 'D57.1',
    name: 'Sickle-cell disease without crisis',
    system: 'hematologic',
    synonyms: ['sickle cell disease', 'sickle cell anemia', 'sickle cell'],
  },
  {
    icd10_cm: 'D56.9',
    name: 'Thalassemia, unspecified',
    system: 'hematologic',
    synonyms: ['thalassemia', 'thalassaemia'],
  },
  {
    icd10_cm: 'D66',
    name: 'Hereditary factor VIII deficiency',
    system: 'hematologic',
    synonyms: ['hemophilia', 'haemophilia'],
  },
  {
    icd10_cm: 'D68.0',
    name: "Von Willebrand's disease",
    system: 'hematologic',
    synonyms: ['von willebrand disease', 'von willebrand'],
  },
  {
    icd10_cm: 'D69.6',
    name: 'Thrombocytopenia, unspecified',
    system: 'hematologic',
    synonyms: ['thrombocytopenia', 'low platelets'],
  },

  // ── Infectious, other ──
  {
    icd10_cm: 'B02.9',
    name: 'Zoster without complications',
    system: 'infectious',
    synonyms: ['shingles', 'herpes zoster', 'zoster'],
  },
  {
    icd10_cm: 'A69.20',
    name: 'Lyme disease, unspecified',
    system: 'infectious',
    synonyms: ['lyme disease', 'lyme'],
  },
  {
    icd10_cm: 'M86.9',
    name: 'Osteomyelitis, unspecified',
    system: 'infectious',
    synonyms: ['osteomyelitis'],
  },
  {
    icd10_cm: 'U09.9',
    name: 'Post COVID-19 condition, unspecified',
    system: 'infectious',
    synonyms: ['long covid', 'post-covid condition'],
  },

  // ── Oncologic, other ──
  {
    icd10_cm: 'C16.9',
    name: 'Malignant neoplasm of stomach, unspecified',
    system: 'oncologic',
    synonyms: ['stomach cancer', 'gastric cancer'],
  },
  {
    icd10_cm: 'C15.9',
    name: 'Malignant neoplasm of esophagus, unspecified',
    system: 'oncologic',
    synonyms: ['esophageal cancer', 'oesophageal cancer', 'cancer of the esophagus'],
  },
  {
    icd10_cm: 'C53.9',
    name: 'Malignant neoplasm of cervix uteri, unspecified',
    system: 'oncologic',
    synonyms: ['cervical cancer', 'cancer of the cervix'],
  },
  {
    icd10_cm: 'C62.90',
    name: 'Malignant neoplasm of unspecified testis, unspecified side',
    system: 'oncologic',
    synonyms: ['testicular cancer', 'testicular'],
  },
  {
    icd10_cm: 'C44.90',
    name: 'Unspecified malignant neoplasm of skin, unspecified',
    system: 'oncologic',
    synonyms: ['non-melanoma skin cancer', 'basal cell carcinoma', 'squamous cell carcinoma'],
  },

  // ── Endocrine, other ──
  {
    icd10_cm: 'E21.3',
    name: 'Hyperparathyroidism, unspecified',
    system: 'metabolic',
    synonyms: ['hyperparathyroidism', 'parathyroid disease'],
  },
  {
    icd10_cm: 'E23.0',
    name: 'Hypopituitarism',
    system: 'metabolic',
    synonyms: ['hypopituitarism', 'pituitary disorder'],
  },
  {
    icd10_cm: 'E24.9',
    name: "Cushing's syndrome, unspecified",
    system: 'metabolic',
    synonyms: ["cushing's syndrome", 'cushing syndrome', 'cushing'],
  },
  {
    icd10_cm: 'E23.2',
    name: 'Diabetes insipidus',
    system: 'metabolic',
    synonyms: ['diabetes insipidus'],
  },
  {
    icd10_cm: 'E04.1',
    name: 'Nontoxic single thyroid nodule',
    system: 'metabolic',
    synonyms: ['thyroid nodule', 'thyroid nodules'],
  },

  // ── Respiratory, other ──
  {
    icd10_cm: 'J84.10',
    name: 'Pulmonary fibrosis, unspecified',
    system: 'respiratory',
    synonyms: ['pulmonary fibrosis', 'idiopathic pulmonary fibrosis', 'lung fibrosis'],
  },
  {
    icd10_cm: 'J47.9',
    name: 'Bronchiectasis, uncomplicated',
    system: 'respiratory',
    synonyms: ['bronchiectasis'],
  },
  {
    icd10_cm: 'I27.20',
    name: 'Pulmonary hypertension, unspecified',
    system: 'cardiovascular',
    synonyms: [
      'pulmonary hypertension',
      'primary pulmonary hypertension',
      'primary pulmonary arterial hypertension',
    ],
  },

  // ── Mental health, other ──
  {
    icd10_cm: 'F40.10',
    name: 'Social phobia, unspecified',
    system: 'mental_health',
    synonyms: ['social anxiety disorder', 'social anxiety', 'social phobia'],
  },
  {
    icd10_cm: 'F40.00',
    name: 'Agoraphobia, unspecified',
    system: 'mental_health',
    synonyms: ['agoraphobia'],
  },
  {
    icd10_cm: 'F50.9',
    name: 'Eating disorder, unspecified',
    system: 'mental_health',
    synonyms: ['eating disorder', 'anorexia nervosa', 'anorexia', 'bulimia nervosa', 'bulimia'],
  },
  {
    icd10_cm: 'F53.0',
    name: 'Postpartum depression, unspecified',
    system: 'mental_health',
    synonyms: ['postpartum depression', 'postnatal depression'],
  },

  // ── Residual gap (1.3.0) — carrier-relevant chronic rows outside the ──
  // ── earlier scopes, declared in RESIDUAL_SCOPE (tests) ──
  {
    icd10_cm: 'I83.90',
    name: 'Asymptomatic varicose veins of unspecified lower extremity',
    system: 'cardiovascular',
    synonyms: ['varicose veins', 'varicose vein'],
  },
  {
    icd10_cm: 'M54.30',
    name: 'Sciatica, unspecified side',
    system: 'musculoskeletal',
    synonyms: ['sciatica'],
  },
  {
    icd10_cm: 'E87.5',
    name: 'Hyperpotassemia',
    system: 'metabolic',
    synonyms: ['hyperkalemia', 'hyperkalaemia', 'high potassium'],
  },
  {
    icd10_cm: 'D51.9',
    name: 'Vitamin B12 deficiency anemia, unspecified',
    system: 'hematologic',
    synonyms: ['vitamin b12 deficiency', 'b12 deficiency', 'low b12'],
  },
  {
    icd10_cm: 'E83.110',
    name: 'Hereditary hemochromatosis',
    system: 'metabolic',
    synonyms: ['hemochromatosis', 'haemochromatosis'],
  },
  {
    icd10_cm: 'D55.0',
    name: 'Anemia due to glucose-6-phosphate dehydrogenase [G6PD] deficiency',
    system: 'hematologic',
    synonyms: [
      'g6pd deficiency',
      'glucose-6-phosphate dehydrogenase deficiency',
      'glucose 6 phosphate dehydrogenase deficiency',
    ],
  },
  {
    icd10_cm: 'Q79.60',
    name: 'Ehlers-Danlos syndrome, unspecified',
    system: 'congenital',
    synonyms: ['ehlers-danlos syndrome', 'ehlers danlos', 'eds'],
  },
  {
    icd10_cm: 'Q87.40',
    name: 'Marfan syndrome, unspecified',
    system: 'congenital',
    synonyms: ['marfan syndrome', 'marfans syndrome', 'marfan'],
  },
  {
    icd10_cm: 'G51.0',
    name: "Bell's palsy",
    system: 'neurological',
    synonyms: ["bell's palsy", 'bells palsy', 'bell palsy'],
  },
  {
    icd10_cm: 'G44.009',
    name: 'Cluster headache syndrome, unspecified, not intractable',
    system: 'neurological',
    synonyms: ['cluster headache', 'cluster headaches'],
  },
  {
    icd10_cm: 'M75.00',
    name: 'Adhesive capsulitis of unspecified shoulder',
    system: 'musculoskeletal',
    synonyms: ['frozen shoulder', 'adhesive capsulitis'],
  },
  {
    icd10_cm: 'M21.40',
    name: 'Flat foot [pes planus] (acquired), unspecified foot',
    system: 'musculoskeletal',
    synonyms: ['flat feet', 'flat foot', 'pes planus'],
  },
  {
    icd10_cm: 'M20.10',
    name: 'Hallux valgus (acquired), unspecified foot',
    system: 'musculoskeletal',
    synonyms: ['bunions', 'bunion', 'hallux valgus'],
  },
  {
    icd10_cm: 'O14.90',
    name: 'Unspecified pre-eclampsia, unspecified trimester',
    system: 'gynecologic',
    synonyms: ['preeclampsia', 'pre-eclampsia'],
  },
  {
    icd10_cm: 'H04.129',
    name: 'Dry eye syndrome, unspecified',
    system: 'ophthalmologic',
    synonyms: ['dry eye syndrome', 'dry eyes', 'dry eye'],
  },
  {
    icd10_cm: 'N95.1',
    name: 'Menopausal and female climacteric states',
    system: 'gynecologic',
    synonyms: ['menopause', 'perimenopause', 'postmenopausal'],
  },
  {
    icd10_cm: 'L43.9',
    name: 'Lichen planus, unspecified',
    system: 'dermatologic',
    synonyms: ['lichen planus'],
  },
  {
    icd10_cm: 'D18.00',
    name: 'Hemangioma unspecified site',
    system: 'dermatologic',
    synonyms: ['hemangioma', 'haemangioma'],
  },
  {
    icd10_cm: 'B07.0',
    name: 'Plantar wart',
    system: 'dermatologic',
    synonyms: ['plantar wart', 'plantar warts'],
  },
  {
    icd10_cm: 'H00.1',
    name: 'Chalazion',
    system: 'ophthalmologic',
    synonyms: ['chalazion', 'chalazions'],
  },
  {
    icd10_cm: 'I73.00',
    name: "Raynaud's syndrome without gangrene",
    system: 'cardiovascular',
    synonyms: ['raynauds phenomenon', 'raynauds syndrome', 'raynauds'],
  },
  {
    icd10_cm: 'E04.9',
    name: 'Nontoxic goiter, unspecified',
    system: 'metabolic',
    synonyms: ['goiter', 'goitre', 'enlarged thyroid'],
  },
  {
    icd10_cm: 'G25.0',
    name: 'Essential tremor',
    system: 'neurological',
    synonyms: ['essential tremor'],
  },
  {
    icd10_cm: 'N60.29',
    name: 'Fibroadenosis of unspecified breast',
    system: 'gynecologic',
    synonyms: ['fibrocystic breast changes', 'fibrocystic breasts', 'fibrocystic breast disease'],
  },
  {
    icd10_cm: 'K60.2',
    name: 'Anal fissure, unspecified',
    system: 'gastrointestinal',
    synonyms: ['anal fissure', 'anal fissures'],
  },
  {
    icd10_cm: 'K22.70',
    name: "Barrett's esophagus without dysplasia",
    system: 'gastrointestinal',
    synonyms: ['barretts esophagus', 'barrett esophagus', 'barretts oesophagus'],
  },
  {
    icd10_cm: 'K40.90',
    name: 'Unilateral inguinal hernia, without obstruction or gangrene, not specified as recurrent',
    system: 'gastrointestinal',
    synonyms: ['inguinal hernia', 'groin hernia'],
  },
  {
    icd10_cm: 'N30.10',
    name: 'Interstitial cystitis (chronic) without hematuria',
    system: 'urologic',
    synonyms: ['interstitial cystitis', 'painful bladder syndrome'],
  },
  {
    icd10_cm: 'L57.0',
    name: 'Actinic keratosis',
    system: 'dermatologic',
    synonyms: ['actinic keratosis', 'actinic keratoses', 'solar keratosis'],
  },
  {
    icd10_cm: 'N81.4',
    name: 'Uterovaginal prolapse, unspecified',
    system: 'gynecologic',
    synonyms: ['uterine prolapse', 'prolapsed uterus', 'pelvic organ prolapse'],
  },
  {
    icd10_cm: 'N94.6',
    name: 'Dysmenorrhea, unspecified',
    system: 'gynecologic',
    synonyms: ['dysmenorrhea', 'dysmenorrhoea', 'painful periods'],
  },
  {
    icd10_cm: 'N94.3',
    name: 'Premenstrual tension syndrome',
    system: 'gynecologic',
    synonyms: ['premenstrual syndrome', 'premenstrual tension', 'pms'],
  },
  {
    icd10_cm: 'E73.9',
    name: 'Lactose intolerance, unspecified',
    system: 'gastrointestinal',
    synonyms: ['lactose intolerance'],
  },
  {
    icd10_cm: 'N28.1',
    name: 'Cyst of kidney, acquired',
    system: 'urologic',
    synonyms: ['kidney cyst', 'kidney cysts', 'renal cyst', 'renal cysts'],
  },
  {
    icd10_cm: 'L21.9',
    name: 'Seborrheic dermatitis, unspecified',
    system: 'dermatologic',
    synonyms: ['seborrheic dermatitis', 'seborrhoeic dermatitis'],
  },
  {
    icd10_cm: 'M67.40',
    name: 'Ganglion, unspecified site',
    system: 'musculoskeletal',
    synonyms: ['ganglion cyst', 'ganglion cysts'],
  },
  {
    icd10_cm: 'M77.10',
    name: 'Lateral epicondylitis, unspecified elbow',
    system: 'musculoskeletal',
    synonyms: ['tennis elbow', 'lateral epicondylitis'],
  },
  {
    icd10_cm: 'M65.30',
    name: 'Trigger finger, unspecified finger',
    system: 'musculoskeletal',
    synonyms: ['trigger finger', 'trigger thumb'],
  },
  {
    icd10_cm: 'M71.9',
    name: 'Bursopathy, unspecified',
    system: 'musculoskeletal',
    synonyms: ['bursitis'],
  },
  {
    icd10_cm: 'L23.9',
    name: 'Allergic contact dermatitis, unspecified cause',
    system: 'dermatologic',
    synonyms: ['contact dermatitis', 'allergic contact dermatitis'],
  },
  {
    icd10_cm: 'K60.3',
    name: 'Anal fistula',
    system: 'gastrointestinal',
    synonyms: ['anal fistula'],
  },

  // ── Probe gap (1.4.0) — the 237-phrase carrier-questionnaire sweep found ──
  // ── these named diagnoses neither gated nor mapped. Batches of five. ──
  {
    icd10_cm: 'I42.9',
    name: 'Cardiomyopathy, unspecified',
    system: 'cardiovascular',
    synonyms: ['cardiomyopathy', 'dilated cardiomyopathy', 'hypertrophic cardiomyopathy'],
  },
  {
    icd10_cm: 'I40.9',
    name: 'Acute myocarditis, unspecified',
    system: 'cardiovascular',
    synonyms: ['myocarditis'],
  },
  {
    icd10_cm: 'I30.9',
    name: 'Acute pericarditis, unspecified',
    system: 'cardiovascular',
    synonyms: ['pericarditis'],
  },
  {
    icd10_cm: 'I47.9',
    name: 'Paroxysmal tachycardia, unspecified',
    system: 'cardiovascular',
    synonyms: ['paroxysmal tachycardia', 'supraventricular tachycardia', 'svt'],
  },
  {
    icd10_cm: 'E78.1',
    name: 'Pure hyperglyceridemia',
    system: 'metabolic',
    synonyms: [
      'high triglycerides',
      'high triglyceride',
      'hypertriglyceridemia',
      'hypertriglyceridaemia',
    ],
  },
  {
    icd10_cm: 'E87.1',
    name: 'Hypo-osmolality and hyponatremia',
    system: 'metabolic',
    synonyms: ['hyponatremia', 'hyponatraemia', 'low sodium'],
  },
  {
    icd10_cm: 'E83.52',
    name: 'Hypercalcemia',
    system: 'metabolic',
    synonyms: ['hypercalcemia', 'hypercalcaemia', 'high calcium'],
  },
  {
    icd10_cm: 'E79.0',
    name: 'Hyperuricemia without signs of inflammatory arthritis and tophaceous disease',
    system: 'metabolic',
    synonyms: ['hyperuricemia', 'hyperuricaemia', 'high uric acid'],
  },
  {
    icd10_cm: 'E29.1',
    name: 'Testicular hypofunction',
    system: 'metabolic',
    synonyms: ['low testosterone', 'testosterone deficiency', 'hypogonadism'],
  },
  {
    icd10_cm: 'E20.9',
    name: 'Hypoparathyroidism, unspecified',
    system: 'metabolic',
    synonyms: ['hypoparathyroidism'],
  },
  {
    icd10_cm: 'N05.9',
    name: 'Unspecified nephritic syndrome with unspecified morphologic changes',
    system: 'renal',
    synonyms: ['glomerulonephritis', 'nephritic syndrome'],
  },
  {
    icd10_cm: 'J33.9',
    name: 'Nasal polyp, unspecified',
    system: 'ent',
    synonyms: ['nasal polyps', 'nasal polyp'],
  },
  {
    icd10_cm: 'R09.1',
    name: 'Pleurisy',
    system: 'respiratory',
    synonyms: ['pleurisy'],
  },
  {
    icd10_cm: 'J93.9',
    name: 'Pneumothorax, unspecified',
    system: 'respiratory',
    synonyms: ['pneumothorax', 'collapsed lung'],
  },
  {
    icd10_cm: 'K31.84',
    name: 'Gastroparesis',
    system: 'gastrointestinal',
    synonyms: ['gastroparesis'],
  },
  {
    icd10_cm: 'G44.209',
    name: 'Tension-type headache, unspecified, not intractable',
    system: 'neurological',
    synonyms: ['tension headache', 'tension headaches', 'tension-type headache'],
  },
  {
    icd10_cm: 'F95.2',
    name: "Tourette's disorder",
    system: 'mental_health',
    synonyms: ['tourette syndrome', "tourette's syndrome", 'tourettes'],
  },
  {
    icd10_cm: 'G91.9',
    name: 'Hydrocephalus, unspecified',
    system: 'neurological',
    synonyms: ['hydrocephalus'],
  },
  {
    icd10_cm: 'G71.0',
    name: 'Muscular dystrophy',
    system: 'neurological',
    synonyms: ['muscular dystrophy'],
  },
  {
    icd10_cm: 'H33.20',
    name: 'Retinal detachment, unspecified',
    system: 'ophthalmologic',
    synonyms: ['retinal detachment', 'detached retina'],
  },
  {
    icd10_cm: 'Q35.9',
    name: 'Cleft palate, unspecified',
    system: 'congenital',
    synonyms: ['cleft palate'],
  },
  {
    icd10_cm: 'Q66.89',
    name: 'Other congenital deformities of feet',
    system: 'congenital',
    synonyms: ['club foot', 'clubfoot'],
  },
  {
    icd10_cm: 'Q96.9',
    name: "Turner's syndrome, unspecified",
    system: 'congenital',
    synonyms: ['turner syndrome', 'turners syndrome'],
  },
  {
    icd10_cm: 'Q99.2',
    name: 'Fragile X chromosome',
    system: 'congenital',
    synonyms: ['fragile x syndrome', 'fragile x'],
  },
  {
    icd10_cm: 'D45',
    name: 'Polycythemia vera',
    system: 'hematologic',
    synonyms: ['polycythemia vera', 'polycythemia', 'polycythaemia'],
  },
  {
    icd10_cm: 'L70.0',
    name: 'Acne vulgaris',
    system: 'dermatologic',
    synonyms: ['acne', 'acne vulgaris'],
  },
  {
    icd10_cm: 'L91.0',
    name: 'Hypertrophic scar',
    system: 'dermatologic',
    synonyms: ['keloid', 'keloids'],
  },
  {
    icd10_cm: 'I89.0',
    name: 'Lymphedema, not elsewhere classified',
    system: 'cardiovascular',
    synonyms: ['lymphedema', 'lymphoedema'],
  },
  {
    icd10_cm: 'I86.1',
    name: 'Scrotal varices',
    system: 'urologic',
    synonyms: ['varicocele'],
  },
  {
    icd10_cm: 'B00.9',
    name: 'Herpesviral infection, unspecified',
    system: 'infectious',
    synonyms: ['herpes', 'herpes simplex'],
  },

  // ── Critical-illness sweep (1.6.0) — the carrier covered-condition lists ──
  // ── named these diagnoses, and they were neither gated nor mapped. ──
  {
    icd10_cm: 'A86',
    name: 'Unspecified viral encephalitis',
    system: 'neurological',
    synonyms: ['encephalitis', 'viral encephalitis'],
  },
  {
    icd10_cm: 'A80.9',
    name: 'Acute poliomyelitis, unspecified',
    system: 'neurological',
    synonyms: ['poliomyelitis', 'polio'],
  },
  {
    icd10_cm: 'G00.9',
    name: 'Bacterial meningitis, unspecified',
    system: 'neurological',
    synonyms: ['bacterial meningitis'],
  },
  {
    icd10_cm: 'G12.29',
    name: 'Other motor neuron disease',
    system: 'neurological',
    synonyms: ['motor neurone disease', 'motor neuron disease'],
  },
  {
    icd10_cm: 'R40.20',
    name: 'Unspecified coma',
    system: 'neurological',
    synonyms: ['coma', 'in a coma', 'comatose'],
  },
  {
    icd10_cm: 'G82.20',
    name: 'Paraplegia, unspecified',
    system: 'neurological',
    synonyms: ['paraplegia', 'paraplegic'],
  },
  {
    icd10_cm: 'K72.90',
    name: 'Hepatic failure, unspecified without coma',
    system: 'gastrointestinal',
    synonyms: ['liver failure', 'hepatic failure', 'end stage liver failure'],
  },
  {
    icd10_cm: 'K76.9',
    name: 'Liver disease, unspecified',
    system: 'gastrointestinal',
    synonyms: ['liver disease', 'chronic liver disease'],
  },
  {
    icd10_cm: 'D61.9',
    name: 'Aplastic anemia, unspecified',
    system: 'hematologic',
    synonyms: ['aplastic anemia', 'aplastic anaemia'],
  },
  {
    icd10_cm: 'D33.2',
    name: 'Benign neoplasm of brain, unspecified',
    system: 'oncologic',
    synonyms: ['benign brain tumour', 'benign brain tumor'],
  },

  // ── ICD-10 Chapter IX sweep (1.7.0) — the WHO tabular list's three-character ──
  // ── category titles, the first codebook enumeration used as a source. ──
  // ── The haemorrhagic strokes are here with both spellings, because the ──
  // ── vocabulary carried only "stroke" and the American spellings. ──
  {
    icd10_cm: 'I60.9',
    name: 'Nontraumatic subarachnoid hemorrhage, unspecified',
    system: 'cardiovascular',
    synonyms: ['subarachnoid hemorrhage', 'subarachnoid haemorrhage'],
  },
  {
    icd10_cm: 'I61.9',
    name: 'Nontraumatic intracerebral hemorrhage, unspecified',
    system: 'cardiovascular',
    synonyms: ['intracerebral hemorrhage', 'intracerebral haemorrhage'],
  },
  {
    icd10_cm: 'I62.9',
    name: 'Nontraumatic intracranial hemorrhage, unspecified',
    system: 'cardiovascular',
    synonyms: [
      'nontraumatic intracranial hemorrhage',
      'nontraumatic intracranial haemorrhage',
      'intracranial hemorrhage',
      'intracranial haemorrhage',
    ],
  },
  {
    icd10_cm: 'I80.9',
    name: 'Phlebitis and thrombophlebitis of unspecified site',
    system: 'cardiovascular',
    synonyms: ['phlebitis', 'thrombophlebitis'],
  },
  {
    icd10_cm: 'I88.9',
    name: 'Nonspecific lymphadenitis, unspecified',
    system: 'hematologic',
    synonyms: ['nonspecific lymphadenitis', 'lymphadenitis'],
  },
  {
    icd10_cm: 'I44.30',
    name: 'Unspecified atrioventricular block',
    system: 'cardiovascular',
    synonyms: ['atrioventricular block', 'heart block', 'bundle branch block'],
  },

  // ── ICD-10 Chapter XIV sweep (1.9.0) — the N00–N99 three-character category ──
  // ── titles, the chapter the stone family sits in. Six batches of five named ──
  // ── diagnoses; the “other …” category constructs are gated, not coded.    ──

  // Batch 1 — the nephritic syndromes and isolated proteinuria, the N00–N06
  // family whose unspecified members already carried N04.9 and N05.9.
  {
    icd10_cm: 'N00.9',
    name: 'Acute nephritic syndrome with unspecified morphologic changes',
    system: 'renal',
    synonyms: ['acute nephritic syndrome'],
  },
  {
    icd10_cm: 'N01.9',
    name: 'Rapidly progressive nephritic syndrome with unspecified morphologic changes',
    system: 'renal',
    synonyms: ['rapidly progressive nephritic syndrome'],
  },
  {
    icd10_cm: 'N02.9',
    name: 'Recurrent and persistent hematuria with unspecified morphologic changes',
    system: 'renal',
    // The bare word "hematuria" is deliberately NOT an alias: a single episode
    // codes to hematuria, unspecified (R31.9), so the row keeps its own wording.
    synonyms: ['recurrent and persistent hematuria'],
  },
  {
    icd10_cm: 'N03.9',
    name: 'Chronic nephritic syndrome with unspecified morphologic changes',
    system: 'renal',
    synonyms: ['chronic nephritic syndrome'],
  },
  {
    icd10_cm: 'N06.9',
    name: 'Isolated proteinuria with unspecified morphologic lesion',
    system: 'renal',
    // The N06 category is titled "…with specified morphological lesion"; the
    // billable member is the unspecified-lesion row, so only the stateable
    // "isolated proteinuria" is an alias and the category title stays gated.
    synonyms: ['isolated proteinuria'],
  },

  // Batch 2 — tubulo-interstitial nephritis and kidney failure. The alias
  // move beside these rows is recorded in the 1.9.0 changelog entry.
  {
    icd10_cm: 'N10',
    name: 'Acute pyelonephritis',
    system: 'renal',
    synonyms: ['acute pyelonephritis', 'pyelonephritis'],
  },
  {
    icd10_cm: 'N11.9',
    name: 'Chronic tubulo-interstitial nephritis, unspecified',
    system: 'renal',
    synonyms: ['chronic tubulo-interstitial nephritis'],
  },
  {
    icd10_cm: 'N12',
    name: 'Tubulo-interstitial nephritis, not specified as acute or chronic',
    system: 'renal',
    // Both spellings of the compound are curated: exact matching means the
    // hyphenated form would not cover the unhyphenated one.
    synonyms: ['tubulo-interstitial nephritis', 'tubulointerstitial nephritis'],
  },
  {
    icd10_cm: 'N17.9',
    name: 'Acute kidney failure, unspecified',
    system: 'renal',
    synonyms: ['acute kidney failure', 'acute kidney injury', 'acute renal failure'],
  },
  {
    icd10_cm: 'N19',
    name: 'Unspecified kidney failure',
    system: 'renal',
    // "kidney failure" moved here from N18.6 in 1.9.0: an unqualified statement
    // is the unspecified row, and end stage renal disease keeps its own name,
    // dialysis, and ESRD.
    synonyms: ['unspecified kidney failure', 'kidney failure', 'renal failure'],
  },

  // Batch 3 — obstructive uropathy, calculi and the bladder.
  {
    icd10_cm: 'N13.9',
    name: 'Obstructive and reflux uropathy, unspecified',
    system: 'renal',
    synonyms: ['obstructive and reflux uropathy', 'obstructive uropathy', 'reflux uropathy'],
  },
  {
    icd10_cm: 'N21.9',
    name: 'Calculus of lower urinary tract, unspecified',
    system: 'urologic',
    synonyms: ['calculus of lower urinary tract'],
  },
  {
    icd10_cm: 'N23',
    name: 'Unspecified renal colic',
    system: 'renal',
    synonyms: ['renal colic', 'unspecified renal colic'],
  },
  {
    icd10_cm: 'N30.90',
    name: 'Cystitis, unspecified without hematuria',
    system: 'urologic',
    synonyms: ['cystitis'],
  },
  {
    icd10_cm: 'N31.9',
    name: 'Neuromuscular dysfunction of bladder, unspecified',
    system: 'urologic',
    synonyms: ['neurogenic bladder', 'neuromuscular dysfunction of bladder'],
  },

  // Batch 4 — the urethra and the male genital organs. N34.1 is the code
  // coders use for urethritis stated without further detail.
  {
    icd10_cm: 'N34.1',
    name: 'Nonspecific urethritis',
    system: 'urologic',
    synonyms: ['nonspecific urethritis', 'urethritis'],
  },
  {
    icd10_cm: 'N43.3',
    name: 'Hydrocele, unspecified',
    system: 'urologic',
    synonyms: ['hydrocele'],
  },
  {
    icd10_cm: 'N43.40',
    name: 'Spermatocele of epididymis, unspecified',
    system: 'urologic',
    synonyms: ['spermatocele'],
  },
  {
    icd10_cm: 'N45.1',
    name: 'Epididymitis',
    system: 'urologic',
    synonyms: ['epididymitis'],
  },
  {
    icd10_cm: 'N45.2',
    name: 'Orchitis',
    system: 'urologic',
    synonyms: ['orchitis'],
  },

  // Batch 5 — breast and female pelvic organs. The breast codes carry
  // "unspecified breast" because FY2026 requires a side for the site-specific
  // members (N60.91/N60.92, N63.10-N63.12), and the visitor's side is unknown.
  {
    icd10_cm: 'N60.99',
    name: 'Unspecified benign mammary dysplasia of unspecified breast',
    system: 'gynecologic',
    synonyms: ['benign mammary dysplasia'],
  },
  {
    icd10_cm: 'N62',
    name: 'Hypertrophy of breast',
    system: 'gynecologic',
    synonyms: ['hypertrophy of breast', 'breast hypertrophy'],
  },
  {
    icd10_cm: 'N63.0',
    name: 'Unspecified lump in unspecified breast',
    system: 'gynecologic',
    // The site-free row the lump context rule needed: "breast lump" is the
    // stateable form, and N63 itself is a header now.
    synonyms: ['unspecified lump in breast', 'breast lump', 'lump in breast'],
  },
  {
    icd10_cm: 'N70.91',
    name: 'Salpingitis, unspecified',
    system: 'gynecologic',
    synonyms: ['salpingitis'],
  },
  {
    icd10_cm: 'N70.92',
    name: 'Oophoritis, unspecified',
    system: 'gynecologic',
    synonyms: ['oophoritis'],
  },

  // Batch 6 — the female genital tract, the cervix and reproductive loss.
  {
    icd10_cm: 'N75.9',
    name: "Disease of Bartholin's gland, unspecified",
    system: 'gynecologic',
    synonyms: ['disease of bartholins gland', 'diseases of bartholins gland'],
  },
  {
    icd10_cm: 'N81.9',
    name: 'Female genital prolapse, unspecified',
    system: 'gynecologic',
    synonyms: ['female genital prolapse'],
  },
  {
    icd10_cm: 'N86',
    name: 'Erosion and ectropion of cervix uteri',
    system: 'gynecologic',
    synonyms: ['erosion and ectropion of cervix uteri', 'cervical erosion'],
  },
  {
    icd10_cm: 'N87.9',
    name: 'Dysplasia of cervix uteri, unspecified',
    system: 'gynecologic',
    synonyms: ['dysplasia of cervix uteri', 'cervical dysplasia'],
  },
  {
    icd10_cm: 'N96',
    name: 'Recurrent pregnancy loss',
    system: 'gynecologic',
    synonyms: ['recurrent pregnancy loss', 'recurrent miscarriage'],
  },
];

/**
 * Normalizes stated condition text for exact alias matching.
 *
 * Deliberately conservative: lowercase, decompose accents, drop apostrophes,
 * unify separators/punctuation, and collapse whitespace. It does not stem,
 * spell-correct, or expand — anything not literally in the alias index stays
 * unmapped rather than being guessed at. Apostrophes are removed (not
 * preserved) so "Crohn's disease" matches the curated "crohns disease" alias.
 */
export function normalizeConditionText(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      // Drop combining diacritics so "sjögren" matches the curated "sjogren"
      .replace(/[\u0300-\u036f]/g, '')
      // Apostrophes disappear rather than becoming a separator
      .replace(/['\u2018\u2019\u02bc]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(a|an|the)\s+/, '')
  );
}

/**
 * Alias index (normalized alias → vocabulary entry).
 * Built once at module load. Also registers the canonical name and a naive
 * plural of every alias (unless it already ends in "s"), since both come from
 * the curated list and can never introduce an uncurated match.
 *
 * If two entries claim the same alias, the FIRST entry in
 * CANONICAL_CONDITIONS wins deterministically and the build is flagged by
 * `findDuplicateAliases()` (locked by test) so ambiguity is caught, not
 * resolved silently at runtime.
 */
function buildAliasIndex(): Map<string, CanonicalCondition> {
  const index = new Map<string, CanonicalCondition>();
  for (const condition of CANONICAL_CONDITIONS) {
    const aliases = [condition.name, condition.icd10_cm, ...condition.synonyms];
    for (const alias of aliases) {
      const key = normalizeConditionText(alias);
      if (key && !index.has(key)) {
        index.set(key, condition);
      }
      // Naive plural of a curated alias ("migraine" → "migraines"). Never
      // applied to an alias that already ends in "s" ("diabetes", "ms"), so no
      // junk variants like "diabetesss" enter the index.
      const plural = `${key}s`;
      if (key && !key.endsWith('s') && !index.has(plural)) {
        index.set(plural, condition);
      }
    }
  }
  return index;
}

const aliasIndex = buildAliasIndex();

const codeIndex = new Map<string, CanonicalCondition>(
  CANONICAL_CONDITIONS.map((condition) => [condition.icd10_cm, condition]),
);

/**
 * Reports aliases claimed by more than one vocabulary entry (build hygiene).
 * Exposed so a test can assert the vocabulary stays unambiguous.
 */
export function findDuplicateAliases(): string[] {
  const seen = new Map<string, Set<string>>();
  for (const condition of CANONICAL_CONDITIONS) {
    for (const alias of [condition.name, condition.icd10_cm, ...condition.synonyms]) {
      const key = normalizeConditionText(alias);
      if (!key) continue;
      const codes = seen.get(key) ?? new Set<string>();
      codes.add(condition.icd10_cm);
      seen.set(key, codes);
    }
  }
  return [...seen.entries()].filter(([, codes]) => codes.size > 1).map(([alias]) => alias);
}

/**
 * Resolves one stated condition to a canonical vocabulary entry.
 * Exact (normalized) match only — returns null rather than guessing.
 */
export function findCanonicalCondition(stated: string): CanonicalCondition | null {
  return aliasIndex.get(normalizeConditionText(stated)) ?? null;
}

/**
 * Looks a vocabulary entry up by ICD-10-CM code (case-insensitive; surrounding
 * whitespace ignored). An unknown or differently-subcoded code returns null —
 * codes are never narrowed or widened to fit.
 */
export function getCanonicalConditionByCode(icd10Cm: string): CanonicalCondition | null {
  return codeIndex.get(icd10Cm.trim().toUpperCase()) ?? null;
}

/** Lists the vocabulary (copy — callers cannot mutate the index). */
export function listCanonicalConditions(): CanonicalCondition[] {
  return CANONICAL_CONDITIONS.slice();
}

/**
 * Free-text search over the vocabulary for internal/broker tooling.
 * Matches canonical names, synonyms, and codes (substring, case-insensitive) —
 * this searches the VOCABULARY only and never a user's stated conditions.
 */
export function searchCanonicalConditions(query: string): CanonicalCondition[] {
  const needle = normalizeConditionText(query);
  if (!needle) return [];
  return CANONICAL_CONDITIONS.filter((condition) => {
    if (condition.icd10_cm.toLowerCase().includes(needle)) return true;
    return [condition.name, ...condition.synonyms].some((alias) =>
      normalizeConditionText(alias).includes(needle),
    );
  });
}

/** Builds a vocabulary-tagged canonical ref from an entry. */
export function toCanonicalRef(condition: CanonicalCondition): CanonicalConditionRef {
  return {
    icd10_cm: condition.icd10_cm,
    name: condition.name,
    system: condition.system,
    vocabulary: CONDITION_VOCABULARY_ID,
    vocabulary_version: CONDITION_VOCABULARY_VERSION,
  };
}

/**
 * Maps stated conditions onto canonical refs without applying a consent gate.
 * INTERNAL to this module and its tests: production callers must use
 * `mapConsentedMedicalConditions()` so the §9.1 gate can never be skipped.
 */
function mapConditions(stated: string[]): ConditionMappingResult {
  const canonical: CanonicalConditionRef[] = [];
  const unmapped: string[] = [];
  const seenCodes = new Set<string>();

  for (const entry of stated) {
    if (typeof entry !== 'string') continue;
    const statedText = entry.trim();
    if (statedText.length === 0) continue;

    const match = findCanonicalCondition(statedText);
    if (match === null) {
      // Never guess. Keep the user's own words, deduplicated.
      if (!unmapped.includes(statedText)) unmapped.push(statedText);
      continue;
    }
    if (seenCodes.has(match.icd10_cm)) continue;
    seenCodes.add(match.icd10_cm);
    canonical.push(toCanonicalRef(match));
  }

  return {
    vocabulary: CONDITION_VOCABULARY_ID,
    vocabulary_version: CONDITION_VOCABULARY_VERSION,
    canonical,
    unmapped,
  };
}

export interface MedicalConsentState {
  medical_consent_affirmed: boolean;
  medical_consent_version: string | null;
}

export interface MapConsentedConditionsInput {
  /** Conditions as stated by the user (verbatim, from the consented flow). */
  medicalConditions: string[];
  /** Consent as recorded on the response/lead — both fields are required. */
  consent: MedicalConsentState;
  /** Live feature-flag state: true = Phase 2 medical capture is closed. */
  healthDataCollectionDisabled: boolean;
}

/**
 * The single production entry point: maps a consented profile's stated
 * conditions onto canonical refs.
 *
 * Fail-closed — returns null when ANY of these is true:
 *   - `healthDataCollectionDisabled` (Phase 2 capture not approved/enabled);
 *   - medical consent is not affirmatively given;
 *   - medical consent has no current version (ambiguous/unversioned consent is
 *     not consent).
 *
 * Callers must treat null as "no medical data may be processed": return no
 * canonical output, store nothing, and log nothing.
 */
export function mapConsentedMedicalConditions(
  input: MapConsentedConditionsInput,
): ConditionMappingResult | null {
  if (input.healthDataCollectionDisabled) return null;
  if (!input.consent.medical_consent_affirmed) return null;
  if (!input.consent.medical_consent_version) return null;
  if (!Array.isArray(input.medicalConditions)) return null;
  if (input.medicalConditions.length === 0) {
    return {
      vocabulary: CONDITION_VOCABULARY_ID,
      vocabulary_version: CONDITION_VOCABULARY_VERSION,
      canonical: [],
      unmapped: [],
    };
  }
  return mapConditions(input.medicalConditions);
}

/**
 * Groups canonical refs by body system, most-represented first, for internal
 * rollups and broker queries. Pure: no clinical interpretation is added.
 */
export function groupConditionsBySystem(refs: CanonicalConditionRef[]): ConditionSystemGroup[] {
  const groups = new Map<ConditionSystem, Set<string>>();
  for (const ref of refs) {
    const codes = groups.get(ref.system) ?? new Set<string>();
    codes.add(ref.icd10_cm);
    groups.set(ref.system, codes);
  }
  return [...groups.entries()]
    .map(([system, codes]) => ({
      system,
      count: codes.size,
      icd10_cm: [...codes].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.system.localeCompare(b.system));
}
